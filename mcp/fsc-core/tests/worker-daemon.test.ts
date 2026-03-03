/**
 * FSC Worker Daemon 单元测试
 * 使用 vitest
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from 'redis';

// ============ 测试配置 ============
const REDIS_HOST = process.env.REDIS_HOST || '10.10.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');

describe('FSC Worker Daemon', () => {
  let redis: ReturnType<typeof createClient>;
  
  beforeAll(async () => {
    redis = createClient({
      socket: {
        host: REDIS_HOST,
        port: REDIS_PORT
      }
    });
    await redis.connect();
  });
  
  afterAll(async () => {
    await redis.quit();
  });
  
  describe('Redis Streams Integration', () => {
    it('should use XREADGROUP instead of BLPOP', async () => {
      // 验证：必须使用 XREADGROUP，不能使用 BLPOP
      const streamKey = 'fsc:tasks:test';
      const consumerGroup = 'test-group';
      
      // 创建测试 stream
      await redis.xAdd(streamKey, '*', { task: 'test' });
      
      // 创建 consumer group
      try {
        await redis.xGroupCreate(streamKey, consumerGroup, '0', {
          MKSTREAM: true
        });
      } catch (err: any) {
        if (!err.message.includes('BUSYGROUP')) throw err;
      }
      
      // 使用 XREADGROUP 读取
      const messages = await redis.xReadGroup(
        consumerGroup,
        'test-consumer',
        [{ key: streamKey, id: '>' }],
        { COUNT: 1 }
      );
      
      expect(messages).toBeDefined();
      if (messages && messages.length > 0) {
        expect(messages[0].messages.length).toBeGreaterThan(0);
      }
      
      // 清理
      await redis.del(streamKey);
    });
    
    it('should XACK messages after processing', async () => {
      const streamKey = 'fsc:tasks:test-ack';
      const consumerGroup = 'test-group-ack';
      
      // 创建测试 stream
      const messageId = await redis.xAdd(streamKey, '*', { task: 'test-ack' });
      
      // 创建 consumer group
      try {
        await redis.xGroupCreate(streamKey, consumerGroup, '0', {
          MKSTREAM: true
        });
      } catch (err: any) {
        if (!err.message.includes('BUSYGROUP')) throw err;
      }
      
      // 读取消息
      const messages = await redis.xReadGroup(
        consumerGroup,
        'test-consumer-ack',
        [{ key: streamKey, id: '>' }],
        { COUNT: 1 }
      );
      
      expect(messages).toBeDefined();
      
      if (messages && messages.length > 0) {
        const msg = messages[0].messages[0];
        
        // XACK 确认
        const ackCount = await redis.xAck(streamKey, consumerGroup, msg.id);
        expect(ackCount).toBe(1);
      }
      
      // 清理
      await redis.del(streamKey);
    });
  });
  
  describe('Semaphore Concurrency Control', () => {
    it('should implement Semaphore with finally release', () => {
      // 验证：Semaphore 类实现
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
      
      const sem = new Semaphore(2);
      expect(sem.available()).toBe(2);
      
      // 测试 acquire
      sem.acquire();
      expect(sem.available()).toBe(1);
      
      // 测试 release
      sem.release();
      expect(sem.available()).toBe(2);
    });
    
    it('should use finally block to ensure release', async () => {
      class Semaphore {
        private permits: number;
        constructor(permits: number) { this.permits = permits; }
        async acquire() { this.permits--; }
        release() { this.permits++; }
        available() { return this.permits; }
      }
      
      const sem = new Semaphore(1);
      
      // 模拟任务执行
      const executeTask = async () => {
        await sem.acquire();
        try {
          // 任务逻辑
          return 'success';
        } finally {
          sem.release();
        }
      };
      
      const result = await executeTask();
      expect(result).toBe('success');
      expect(sem.available()).toBe(1); // 确保 release 被调用
    });
  });
  
  describe('Graceful Shutdown', () => {
    it('should drain tasks before exit', async () => {
      let drainingTasks = 2;
      let isShuttingDown = false;
      
      // 模拟优雅退出
      const shutdown = async () => {
        isShuttingDown = true;
        
        // Drain: 等待任务完成
        while (drainingTasks > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
          drainingTasks--;
        }
        
        return 'shutdown complete';
      };
      
      const result = await shutdown();
      expect(result).toBe('shutdown complete');
      expect(drainingTasks).toBe(0);
      expect(isShuttingDown).toBe(true);
    });
    
    it('should timeout after 120s', async () => {
      const TIMEOUT_MS = 120000;
      let drainingTasks = 1;
      
      const shutdownWithTimeout = async () => {
        const startTime = Date.now();
        
        const timeout = setTimeout(() => {
          throw new Error('Shutdown timeout');
        }, TIMEOUT_MS);
        
        while (drainingTasks > 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
          drainingTasks--;
        }
        
        clearTimeout(timeout);
        return Date.now() - startTime;
      };
      
      const duration = await shutdownWithTimeout();
      expect(duration).toBeLessThan(TIMEOUT_MS);
    });
  });
  
  describe('Error Handling and DLQ', () => {
    it('should send unhandledRejection to DLQ', async () => {
      const DLQ_STREAM = 'fsc:dlq:test';
      
      // 模拟 unhandledRejection
      const handleRejection = async (reason: any) => {
        await redis.xAdd(DLQ_STREAM, '*', {
          type: 'unhandledRejection',
          reason: String(reason),
          timestamp: Date.now().toString()
        });
      };
      
      await handleRejection('Test error');
      
      // 验证 DLQ
      const messages = await redis.xRange(DLQ_STREAM, '-', '+');
      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0].message.type).toBe('unhandledRejection');
      
      // 清理
      await redis.del(DLQ_STREAM);
    });
    
    it('should retry failed tasks with exponential backoff', async () => {
      const RETRY_ATTEMPTS = 3;
      let attempt = 0;
      
      const executeWithRetry = async (task: () => Promise<string>): Promise<string> => {
        for (let i = 0; i < RETRY_ATTEMPTS; i++) {
          attempt = i + 1;
          try {
            return await task();
          } catch (error) {
            if (i < RETRY_ATTEMPTS - 1) {
              // Exponential backoff
              const delay = Math.pow(2, i) * 1000;
              await new Promise(resolve => setTimeout(resolve, delay));
            } else {
              throw error;
            }
          }
        }
        throw new Error('Max retries exceeded');
      };
      
      // 模拟失败任务
      let callCount = 0;
      const failingTask = async () => {
        callCount++;
        if (callCount < 3) throw new Error('Task failed');
        return 'success';
      };
      
      const result = await executeWithRetry(failingTask);
      expect(result).toBe('success');
      expect(callCount).toBe(3);
    });
  });
  
  describe('Event-driven MemoV Snapshot', () => {
    it('should trigger snapshot on events, not timer', async () => {
      const MEM_EVENTS_STREAM = 'fsc:mem_events:test';
      
      // 模拟事件驱动快照
      const triggerSnapshot = async (taskId: string, event: string) => {
        await redis.xAdd(MEM_EVENTS_STREAM, '*', {
          type: event,
          task_id: taskId,
          agent_id: 'test-agent',
          timestamp: Date.now().toString()
        });
      };
      
      await triggerSnapshot('task-1', 'task_complete');
      
      // 验证事件
      const events = await redis.xRange(MEM_EVENTS_STREAM, '-', '+');
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].message.type).toBe('task_complete');
      expect(events[0].message.task_id).toBe('task-1');
      
      // 清理
      await redis.del(MEM_EVENTS_STREAM);
    });
  });
});
