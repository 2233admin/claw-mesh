#!/usr/bin/env bun
/**
 * MemoV MCP Proxy Server
 * 
 * 功能：
 * - 转发前端请求到 MemoV MCP 服务器
 * - WebSocket 实时推送 MemoV 事件
 * - 提供 RESTful API 接口
 */

import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import express from 'express';
import cors from 'cors';
import { createClient } from 'redis';
import { execSync } from 'child_process';

// Memory modules
const causal = require('../memory/causal');
const { PointerSystem } = require('../memory/pointer');
const { QdrantPointerStore } = require('../memory/qdrant-pointer');

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ============ 配置 ============
const PORT = parseInt(process.env.PORT || '3001');
const REDIS_HOST = process.env.REDIS_HOST || '10.10.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const MEMOV_PATH = process.env.MEMOV_PATH || '/opt/claw-mesh/.mem';

// ============ Memory 模块 ============
const pointerSystem = new PointerSystem();
let qdrantStore: any = null;

// ============ Redis 客户端 ============
const redis = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT
  }
});

redis.on('error', (err) => console.error('Redis error:', err));
redis.on('connect', () => console.log('Redis connected'));

// ============ 中间件 ============
app.use(cors());
app.use(express.json());

// ============ API 路由 ============

// 获取 Mesh 拓扑
app.get('/api/mesh/topology', async (req, res) => {
  try {
    // 从 Redis 获取所有 Worker 心跳
    const heartbeats = await redis.xRead(
      [{ key: 'fsc:heartbeats', id: '0' }],
      { COUNT: 100 }
    );
    
    const nodes = [];
    if (heartbeats) {
      for (const { messages } of heartbeats) {
        for (const { message } of messages) {
          const metrics = JSON.parse(message.metrics);
          nodes.push({
            id: message.agent,
            ...metrics
          });
        }
      }
    }
    
    res.json({ nodes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取 MemoV 时间线
app.get('/api/memov/timeline', async (req, res) => {
  try {
    const { since = '0', limit = 50 } = req.query;
    
    const events = await redis.xRead(
      [{ key: 'fsc:mem_events', id: since as string }],
      { COUNT: parseInt(limit as string) }
    );
    
    const timeline = [];
    if (events) {
      for (const { messages } of events) {
        for (const { id, message } of messages) {
          timeline.push({
            id,
            ...message,
            timestamp: parseInt(message.timestamp)
          });
        }
      }
    }
    
    res.json({ timeline });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 全局搜索 (关键词 + Qdrant 降级策略)
app.post('/api/search', async (req, res) => {
  try {
    const { query, limit = 10 } = req.body;

    // 1. 关键词搜索 (PointerSystem, 内存)
    const keywords = query.split(/\s+/).filter(Boolean);
    const keywordResults = pointerSystem.searchByKeywords(keywords);

    // 2. Qdrant filter 搜索 (如果可用，按 active 状态过滤)
    let qdrantResults: any[] = [];
    if (qdrantStore) {
      try {
        qdrantResults = await qdrantStore.filterPointers(
          { must: [{ key: 'status', match: { value: 'active' } }] },
          limit
        );
      } catch { /* Qdrant 不可用，静默降级 */ }
    }

    // 3. 合并 + 去重
    const seen = new Set<string>();
    const results: any[] = [];

    for (const item of keywordResults) {
      const ptr = item.pointer;
      if (!seen.has(ptr)) {
        seen.add(ptr);
        results.push({
          pointer: ptr,
          score: 1.0,
          content: item.content || item.topic || '',
          timestamp: item.updated_at || item.created_at || Date.now()
        });
      }
    }

    for (const item of qdrantResults) {
      const ptr = item.pointer;
      if (ptr && !seen.has(ptr)) {
        seen.add(ptr);
        results.push({
          pointer: ptr,
          score: 0.8,
          content: item.content || item.topic || '',
          timestamp: item.updated_at || item.created_at || Date.now()
        });
      }
    }

    res.json({ results: results.slice(0, limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 因果调试 (diagnose / trace / learn)
app.post('/api/causal/debug', async (req, res) => {
  try {
    const { pointer, mode, errorLog } = req.body;

    if (mode === 'trace') {
      const chain = causal.getCausalChain(pointer);
      return res.json({ pointer, mode, chain, issues: [], suggestions: [] });
    }

    if (mode === 'learn') {
      const entity = causal.learnFromSuccess(pointer, errorLog || '');
      return res.json({ pointer, mode, entity, issues: [], suggestions: [] });
    }

    // 默认 diagnose
    const finding = causal.diagnoseFailure(pointer, errorLog || mode || '');
    res.json({
      pointer,
      mode: 'diagnose',
      finding,
      issues: finding.cause ? [{ cause: finding.cause, confidence: finding.confidence }] : [],
      suggestions: finding.fix ? [finding.fix] : []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 时光回滚 (Git snapshot checkout)
app.post('/api/memov/rollback', async (req, res) => {
  try {
    const { timestamp, target } = req.body;

    // 校验 target 防止命令注入
    if (target && target !== 'all' && !/^[a-zA-Z0-9_-]+$/.test(target)) {
      return res.status(400).json({ success: false, message: 'Invalid target format' });
    }

    const isoTime = new Date(timestamp).toISOString();

    // 1. 找到指定时间之前最近的 commit
    const commitHash = execSync(
      `git -C "${MEMOV_PATH}" log --before="${isoTime}" --format="%H" -1`,
      { encoding: 'utf-8' }
    ).trim();

    if (!commitHash) {
      return res.status(404).json({ success: false, message: 'No commit found before timestamp' });
    }

    // 2. 执行回滚
    if (!target || target === 'all') {
      execSync(`git -C "${MEMOV_PATH}" checkout ${commitHash} -- .`);
    } else {
      execSync(`git -C "${MEMOV_PATH}" checkout ${commitHash} -- agents/${target}/`);
    }

    // 3. 发布回滚事件到 Redis Streams
    await redis.xAdd('fsc:mem_events', '*', {
      type: 'rollback',
      timestamp: String(Date.now()),
      rollback_to: String(timestamp),
      target: target || 'all',
      commit_hash: commitHash,
    });

    res.json({ success: true, message: `Rolled back to ${isoTime}`, commitHash, target: target || 'all' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    redis: redis.isOpen ? 'connected' : 'disconnected'
  });
});

// ============ WebSocket 实时推送 ============
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // 订阅 Redis Streams
  const subscriber = redis.duplicate();
  
  subscriber.connect().then(async () => {
    // 监听 MemoV 事件
    while (true) {
      try {
        const events = await subscriber.xRead(
          [{ key: 'fsc:mem_events', id: '$' }],
          { BLOCK: 1000 }
        );
        
        if (events) {
          for (const { messages } of events) {
            for (const { id, message } of messages) {
              socket.emit('memov:event', {
                id,
                ...message,
                timestamp: parseInt(message.timestamp)
              });
            }
          }
        }
      } catch (error) {
        console.error('Stream read error:', error);
        break;
      }
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    subscriber.quit();
  });
});

// ============ 启动服务器 ============
async function start() {
  await redis.connect();

  // 初始化 Qdrant (失败不阻塞启动)
  try {
    qdrantStore = new QdrantPointerStore(process.env.QDRANT_URL || 'http://localhost:6333');
    await qdrantStore.initialize();
    console.log('Qdrant connected');
  } catch {
    qdrantStore = null;
    console.log('Qdrant unavailable, using keyword search only');
  }

  server.listen(PORT, () => {
    console.log(`MemoV MCP Proxy listening on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
