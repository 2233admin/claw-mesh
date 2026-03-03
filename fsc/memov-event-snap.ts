#!/usr/bin/env bun
/**
 * MemoV Event-Driven Snap
 * 
 * 功能：
 * - 当任务成功时自动触发 MemoV snap()
 * - 使用 Redis Stream 事件
 * - 支持失败诊断和成功学习
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { createClient } from 'redis';

const execAsync = promisify(exec);

// ============ 配置 ============
const REDIS_HOST = process.env.REDIS_HOST || '10.10.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const MEMOV_STREAM = 'fsc:mem_events';
const PROJECT_PATH = process.cwd();

// ============ Redis Client ============
const redis = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT
  }
});

// ============ MemoV Snap 函数 ============
export async function memovSnap(
  taskId: string,
  status: 'success' | 'failure',
  output?: string,
  error?: string
) {
  try {
    // 执行 mem snap
    const prompt = status === 'success' 
      ? `FSC task ${taskId} succeeded`
      : `FSC task ${taskId} failed`;
    
    const response = status === 'success' 
      ? output
      : error;

    await execAsync(`mem snap --prompt "${prompt}" --response "${response}"`, {
      cwd: PROJECT_PATH
    });

    // 发送事件到 Redis Stream
    await redis.xAdd(MEMOV_STREAM, '*', {
      type: status === 'success' ? 'task_success' : 'task_failure',
      task_id: taskId,
      status,
      timestamp: Date.now().toString()
    });

    return true;
  } catch (err) {
    console.error('MemoV snap failed:', err);
    return false;
  }
}
