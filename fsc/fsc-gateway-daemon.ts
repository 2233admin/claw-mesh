#!/usr/bin/env bun
/**
 * FSC Gateway Daemon（中央调度器）
 *
 * 功能：
 * - 接收任务（来自 API/CLI）
 * - 分发任务到 Redis 队列
 * - 收集结果
 * - Session 管理
 */

import { createClient } from 'redis';
import winston from 'winston';

// ============ 配置 ============
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const TASK_QUEUE = 'fsc:task_queue';
const RESULT_QUEUE = 'fsc:result_queue';
const FAILED_QUEUE = 'fsc:failed_tasks';

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
    new winston.transports.File({ filename: 'fsc-gateway.log' })
  ]
});

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

// ============ 任务类型 ============
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

// ============ 提交任务 ============
async function submitTask(task: Task): Promise<string> {
  logger.info(`[Gateway] Submitting task ${task.id}`);
  await redis.rPush(TASK_QUEUE, JSON.stringify(task));
  return task.id;
}

// ============ 结果收集循环 ============
let isShuttingDown = false;

async function resultCollectorLoop() {
  logger.info('Result collector starting...');

  while (!isShuttingDown) {
    try {
      const result = await redis.blPop(RESULT_QUEUE, 5);

      if (!result) {
        continue;
      }

      const taskResult = JSON.parse(result.element) as TaskResult;
      logger.info(`[Gateway] Received result for task ${taskResult.taskId}: ${taskResult.status}`);

      // TODO: 持久化结果、通知订阅者、更新 Session
      // 暂时先打日志
    } catch (error) {
      logger.error('Result collector error:', error);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  logger.info('Result collector exited');
}

// ============ 健康检查 ============
setInterval(async () => {
  try {
    const queueLen = await redis.lLen(TASK_QUEUE);
    const resultLen = await redis.lLen(RESULT_QUEUE);
    const failedLen = await redis.lLen(FAILED_QUEUE);

    await redis.set('fsc:gateway:health', JSON.stringify({
      timestamp: Date.now(),
      queues: {
        task: queueLen,
        result: resultLen,
        failed: failedLen
      }
    }), { EX: 60 });
  } catch (error) {
    logger.error('Health check failed:', error);
  }
}, 30000);

// ============ 优雅退出 ============
async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  isShuttingDown = true;
  await redis.quit();
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============ 启动 ============
async function main() {
  logger.info('FSC Gateway Daemon starting...');
  await redis.connect();
  resultCollectorLoop().catch((error) => {
    logger.error('Fatal error in result collector:', error);
    process.exit(1);
  });
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
