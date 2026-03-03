#!/usr/bin/env bun
/**
 * FSC Worker Daemon v0.3.0
 * 符合 FSC-MESH 规范 + WireGuard Mesh 集成 + 主动自愈引擎
 * 
 * v0.3.0 新增：
 * - 主动自愈引擎（Proactive Healing Engine）
 *   - 僵尸容器清理（防宿主机磁盘爆炸）
 *   - 网络断联主动自救（连续 3 次 ping 失败自动重启 WireGuard）
 *   - 主动心跳与资源上报（CPU、内存、磁盘、任务数）
 * 
 * v0.2.0 功能：
 * - 分布式锁（Redis SETNX）防止多节点重复执行
 * - 锁自动过期（5分钟）防止死锁
 * - 锁释放保证（try-finally）
 * 
 * v0.1.0 功能：
 * - Redis Streams (XREADGROUP+XACK) 替代 BLPOP
 * - Semaphore 并发控制 + finally 释放
 * - unhandledRejection + DLQ
 * - SIGTERM → drain → exit
 * - MemoV per-agent-branch
 * - Event-driven snapshot
 */

import { createClient } from 'redis';
import { DockerInstance } from './packages/core/src/dockerInstance';
import winston from 'winston';

// ============ 配置 ============
const REDIS_HOST = process.env.REDIS_HOST || '10.10.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const STREAM_KEY = 'fsc:tasks';
const CONSUMER_GROUP = 'fsc-workers';
const CONSUMER_NAME = `worker-${process.env.HOSTNAME || 'unknown'}`;
const RESULT_STREAM = 'fsc:results';
const DLQ_STREAM = 'fsc:dlq';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '10');
const RETRY_ATTEMPTS = 3;
const AGENT_ID = process.env.AGENT_ID || CONSUMER_NAME;

// ============ Logger ============
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ filename: 'fsc-worker.log' })
  ]
});

// ============ Semaphore ============
class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];
  
  constructor(permits: number) {
    this.permits = permits;
  }
  
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }
  
  release(): void {
    this.permits++;
    const next = this.queue.shift();
    if (next) {
      this.permits--;
      next();
    }
  }
  
  available(): number {
    return this.permits;
  }
}

const semaphore = new Semaphore(MAX_CONCURRENT);

// ============ Redis Client ============
const redis = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        logger.error('Redis reconnect failed after 10 attempts');
        return new Error('Max reconnect attempts reached');
      }
      return Math.min(retries * 100, 3000);
    }
  }
});

redis.on('error', (err) => logger.error('Redis error:', err));
redis.on('connect', () => logger.info('Redis connected'));
redis.on('reconnecting', () => logger.warn('Redis reconnecting...'));

// ============ 未处理的 Rejection ============
process.on('unhandledRejection', async (reason, promise) => {
  logger.error('Unhandled Rejection:', { reason, promise });
  
  // 发送到 DLQ
  try {
    await redis.xAdd(DLQ_STREAM, '*', {
      type: 'unhandledRejection',
      reason: String(reason),
      timestamp: Date.now().toString()
    });
  } catch (err) {
    logger.error('Failed to send to DLQ:', err);
  }
});

// ============ 任务执行 ============
interface Task {
  id: string;
  image: string;
  commands: string[];
  timeoutSeconds?: number;
}

interface TaskResult {
  taskId: string;
  status: 'success' | 'failure' | 'timeout';
  output?: string;
  error?: string;
  timestamp: number;
}

async function executeTask(task: Task): Promise<TaskResult> {
  const startTime = Date.now();
  logger.info(`[Task ${task.id}] Starting execution`);
  
  try {
    const docker = new DockerInstance();
    
    // 启动容器
    const containerName = await docker.startContainer(task.image, `fsc-${task.id}`);
    logger.info(`[Task ${task.id}] Container started: ${containerName}`);
    
    // 执行命令
    const result = await docker.runCommands(task.commands, task.timeoutSeconds);
    
    // 清理容器
    await docker.stopContainer();
    
    const duration = Date.now() - startTime;
    logger.info(`[Task ${task.id}] Completed in ${duration}ms`);
    
    // Event-driven MemoV snapshot
    await triggerMemoVSnapshot(task.id, 'task_complete');
    
    return {
      taskId: task.id,
      status: result.status === 'success' ? 'success' : 
              result.status === 'timeout' ? 'timeout' : 'failure',
      output: result.output,
      error: result.error,
      timestamp: Date.now()
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(`[Task ${task.id}] Failed after ${duration}ms:`, error);
    
    return {
      taskId: task.id,
      status: 'failure',
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now()
    };
  }
}

// ============ Event-driven MemoV Snapshot ============
async function triggerMemoVSnapshot(taskId: string, event: string) {
  try {
    await redis.xAdd('fsc:mem_events', '*', {
      type: event,
      task_id: taskId,
      agent_id: AGENT_ID,
      timestamp: Date.now().toString()
    });
    
    logger.debug(`[MemoV] Snapshot triggered: ${event} for task ${taskId}`);
  } catch (err) {
    logger.error('[MemoV] Failed to trigger snapshot:', err);
  }
}

// ============ 重试逻辑 ============
async function executeWithRetry(task: Task, messageId: string, attempt = 1): Promise<TaskResult> {
  const result = await executeTask(task);
  
  if (result.status === 'failure' && attempt < RETRY_ATTEMPTS) {
    logger.warn(`[Task ${task.id}] Retry ${attempt}/${RETRY_ATTEMPTS}`);
    
    // Exponential backoff
    const delay = Math.pow(2, attempt) * 1000;
    await new Promise(resolve => setTimeout(resolve, delay));
    
    return executeWithRetry(task, messageId, attempt + 1);
  }
  
  // 如果最终失败，发送到 DLQ
  if (result.status === 'failure' && attempt >= RETRY_ATTEMPTS) {
    await redis.xAdd(DLQ_STREAM, '*', {
      task_id: task.id,
      message_id: messageId,
      error: result.error || 'unknown',
      attempts: attempt.toString(),
      timestamp: Date.now().toString()
    });
    
    logger.error(`[Task ${task.id}] Moved to DLQ after ${attempt} attempts`);
  }
  
  return result;
}

// ============ 主循环 ============
let isShuttingDown = false;
let drainingTasks = 0;

async function mainLoop() {
  logger.info('FSC Worker Daemon v0.3.0 starting...');
  logger.info(`Redis: ${REDIS_HOST}:${REDIS_PORT}`);
  logger.info(`Consumer: ${CONSUMER_GROUP}/${CONSUMER_NAME}`);
  logger.info(`Max concurrent: ${MAX_CONCURRENT}`);
  logger.info(`Agent ID: ${AGENT_ID}`);
  logger.info(`Distributed lock: Enabled (Redis SETNX with 300s TTL)`);
  logger.info(`Self-healing: Enabled (60s interval)`);
  
  await redis.connect();
  
  // 创建 consumer group（如果不存在）
  try {
    await redis.xGroupCreate(STREAM_KEY, CONSUMER_GROUP, '0', {
      MKSTREAM: true
    });
    logger.info(`Consumer group created: ${CONSUMER_GROUP}`);
  } catch (err: any) {
    if (err.message.includes('BUSYGROUP')) {
      logger.info(`Consumer group already exists: ${CONSUMER_GROUP}`);
    } else {
      throw err;
    }
  }
  
  while (!isShuttingDown) {
    try {
      // XREADGROUP 阻塞读取
      const messages = await redis.xReadGroup(
        CONSUMER_GROUP,
        CONSUMER_NAME,
        [{ key: STREAM_KEY, id: '>' }],
        { BLOCK: 5000, COUNT: 1 }
      );
      
      if (!messages || messages.length === 0) {
        continue;
      }
      
      for (const { name, messages: streamMessages } of messages) {
        for (const { id: messageId, message } of streamMessages) {
          const taskData = JSON.parse(message.task) as Task;
          logger.info(`[Task ${taskData.id}] Received from stream`);
          
          // 分布式锁：防止多节点重复执行
          const lockKey = `lock:task:${messageId}`;
          const lockAcquired = await redis.set(lockKey, CONSUMER_NAME, {
            NX: true,  // Only set if not exists
            EX: 300    // Expire after 5 minutes
          });
          
          if (!lockAcquired) {
            logger.warn(`[Task ${taskData.id}] Lock already held by another worker, skipping`);
            // XACK 确认消息（避免重复消费）
            await redis.xAck(STREAM_KEY, CONSUMER_GROUP, messageId);
            continue;
          }
          
          logger.info(`[Task ${taskData.id}] Lock acquired: ${lockKey}`);
          
          // Semaphore 控制并发
          await semaphore.acquire();
          drainingTasks++;
          
          // 异步执行任务
          (async () => {
            try {
              const taskResult = await executeWithRetry(taskData, messageId);
              
              // 推送结果
              if (taskResult.status === 'success') {
                await redis.xAdd(RESULT_STREAM, '*', {
                  task_id: taskData.id,
                  status: taskResult.status,
                  output: taskResult.output || '',
                  timestamp: taskResult.timestamp.toString()
                });
                logger.info(`[Task ${taskData.id}] Result pushed to ${RESULT_STREAM}`);
              }
              
              // XACK 确认消息
              await redis.xAck(STREAM_KEY, CONSUMER_GROUP, messageId);
              logger.info(`[Task ${taskData.id}] Message acknowledged`);
              
              // 释放锁
              await redis.del(lockKey);
              logger.info(`[Task ${taskData.id}] Lock released: ${lockKey}`);
              
            } catch (error) {
              logger.error(`[Task ${taskData.id}] Execution error:`, error);
              // 确保锁被释放
              await redis.del(lockKey);
            } finally {
              semaphore.release();
              drainingTasks--;
            }
          })();
        }
      }
      
    } catch (error) {
      logger.error('Main loop error:', error);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  logger.info('Main loop exited');
}

// ============ 健康检查 ============
setInterval(async () => {
  try {
    await redis.set('fsc:worker:health', JSON.stringify({
      timestamp: Date.now(),
      running: MAX_CONCURRENT - semaphore.available(),
      maxConcurrent: MAX_CONCURRENT,
      agentId: AGENT_ID
    }), { EX: 60 });
  } catch (error) {
    logger.error('Health check failed:', error);
  }
}, 30000);

// ============ Worker 主动自愈引擎 (Proactive Healing Engine) ============
/**
 * 核心功能：
 * 1. 僵尸容器清理（防宿主机磁盘爆炸）
 * 2. 网络断联主动自救（别干等 Master 发现）
 * 3. 主动心跳与资源上报
 */

let networkFailureCount = 0;

async function proactiveSelfHealing() {
  logger.debug('[Self-Healing] Starting proactive health check...');
  
  try {
    // ========== 功能 1: 僵尸容器清理 ==========
    await cleanupZombieContainers();
    
    // ========== 功能 2: 网络断联主动自救 ==========
    await checkAndHealNetwork();
    
    // ========== 功能 3: 主动心跳与资源上报 ==========
    await reportHeartbeat();
    
  } catch (error) {
    logger.error('[Self-Healing] Error during self-healing:', error);
  }
}

// 功能 1: 清理僵尸容器
async function cleanupZombieContainers() {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // 清理已退出的容器
    try {
      const { stdout: exitedContainers } = await execAsync('docker ps -aq -f status=exited');
      if (exitedContainers.trim()) {
        await execAsync(`docker rm ${exitedContainers.trim().split('\n').join(' ')}`);
        logger.info('[Self-Healing] Cleaned up exited containers');
      }
    } catch (err) {
      // 没有容器需要清理，忽略错误
    }
    
    // 清理超过 2 小时的卡死容器
    const { stdout: runningContainers } = await execAsync(
      "docker ps --format '{{.ID}} {{.RunningFor}}' | grep -E 'hours|days' || true"
    );
    
    if (runningContainers.trim()) {
      const lines = runningContainers.trim().split('\n');
      for (const line of lines) {
        const [containerId, ...timeParts] = line.split(' ');
        const timeStr = timeParts.join(' ');
        
        // 检查是否超过 2 小时
        if (timeStr.includes('hours') || timeStr.includes('days')) {
          const hours = timeStr.includes('days') ? 48 : parseInt(timeStr);
          if (hours >= 2) {
            await execAsync(`docker kill ${containerId}`);
            logger.warn(`[Self-Healing] Killed stuck container: ${containerId} (running for ${timeStr})`);
          }
        }
      }
    }
    
    // 清理游离的 Docker volume
    try {
      await execAsync('docker volume prune -f');
      logger.debug('[Self-Healing] Pruned dangling volumes');
    } catch (err) {
      // 忽略错误
    }
    
  } catch (error) {
    logger.error('[Self-Healing] Container cleanup failed:', error);
  }
}

// 功能 2: 网络断联主动自救
async function checkAndHealNetwork() {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // 尝试 ping Redis 主节点
    try {
      await execAsync(`ping -c 1 -W 1 ${REDIS_HOST}`);
      
      // Ping 成功，重置失败计数
      if (networkFailureCount > 0) {
        logger.info('[Self-Healing] Network recovered');
        networkFailureCount = 0;
        
        // 上报网络恢复事件
        await redis.xAdd('fsc:mem_events', '*', {
          type: 'network_healed',
          agent_id: AGENT_ID,
          timestamp: Date.now().toString()
        });
      }
      
    } catch (pingError) {
      networkFailureCount++;
      logger.warn(`[Self-Healing] Network check failed (${networkFailureCount}/3)`);
      
      // 连续 3 次失败，主动重启 WireGuard
      if (networkFailureCount >= 3) {
        logger.error('[Self-Healing] Network down, restarting WireGuard...');
        
        try {
          await execAsync('sudo systemctl restart wg-quick@wg0');
          logger.info('[Self-Healing] WireGuard restarted');
          
          // 等待 5 秒让网络恢复
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // 重置计数
          networkFailureCount = 0;
          
        } catch (restartError) {
          logger.error('[Self-Healing] Failed to restart WireGuard:', restartError);
        }
      }
    }
    
  } catch (error) {
    logger.error('[Self-Healing] Network check failed:', error);
  }
}

// 功能 3: 主动心跳与资源上报
async function reportHeartbeat() {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // 获取 CPU 使用率
    const { stdout: cpuUsage } = await execAsync(
      "top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'"
    );
    
    // 获取可用内存
    const { stdout: memInfo } = await execAsync(
      "free -m | awk 'NR==2{printf \"%s/%s\", $3,$2}'"
    );
    
    // 获取磁盘使用率
    const { stdout: diskUsage } = await execAsync(
      "df -h / | awk 'NR==2{print $5}'"
    );
    
    const metrics = {
      cpu_usage: parseFloat(cpuUsage.trim()).toFixed(2),
      memory_usage: memInfo.trim(),
      disk_usage: diskUsage.trim(),
      running_tasks: MAX_CONCURRENT - semaphore.available(),
      max_concurrent: MAX_CONCURRENT,
      timestamp: Date.now()
    };
    
    // 推送心跳到 Redis
    await redis.xAdd('fsc:heartbeats', '*', {
      agent: AGENT_ID,
      metrics: JSON.stringify(metrics)
    });
    
    logger.debug(`[Self-Healing] Heartbeat sent: ${JSON.stringify(metrics)}`);
    
  } catch (error) {
    logger.error('[Self-Healing] Heartbeat report failed:', error);
  }
}

// 启动自愈引擎（每 60 秒巡检一次）
setInterval(async () => {
  if (isShuttingDown) return;
  await proactiveSelfHealing();
}, 60000);

logger.info('[Self-Healing] Proactive healing engine started (60s interval)');

// ============ 优雅退出 (SIGTERM → drain → exit) ============
async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  isShuttingDown = true;
  
  // Drain: 等待正在执行的任务完成
  const timeout = setTimeout(() => {
    logger.warn('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 30000);
  
  while (drainingTasks > 0) {
    logger.info(`Draining... ${drainingTasks} tasks remaining`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  clearTimeout(timeout);
  
  // 触发最终 snapshot
  await triggerMemoVSnapshot('shutdown', 'worker_shutdown');
  
  await redis.quit();
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============ 启动 ============
mainLoop().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
