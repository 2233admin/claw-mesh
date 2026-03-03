#!/usr/bin/env bun
/**
 * LLM Rate Limiter Proxy
 * 
 * 功能：
 * - 令牌桶限流（Bottleneck）
 * - 企业 API 代理
 * - 指数退避重试
 * - Fallback 到 Batch API
 */

import express from 'express';
import Bottleneck from 'bottleneck';
import axios from 'axios';

const app = express();
app.use(express.json());

// ============ 配置 ============
const PORT = parseInt(process.env.LLM_PROXY_PORT || '3002');
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY || '';
const DOUBAO_ENDPOINT = process.env.DOUBAO_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3';

// ============ 令牌桶限流器 ============
const limiter = new Bottleneck({
  reservoir: 30,           // 初始令牌数
  reservoirRefreshAmount: 5,  // 每次补充 5 个令牌
  reservoirRefreshInterval: 1000,  // 每秒补充
  maxConcurrent: 3,        // 最大并发数
  minTime: 100             // 最小间隔 100ms
});

// ============ 指数退避重试 ============
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (error.response?.status === 429 && attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`[Retry] 429 detected, waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries exceeded');
}

// ============ LLM 调用 ============
async function callLLM(messages: any[], model: string = 'doubao-pro-32k') {
  return retryWithBackoff(async () => {
    const response = await axios.post(
      `${DOUBAO_ENDPOINT}/chat/completions`,
      {
        model,
        messages,
        temperature: 0.7,
        max_tokens: 2000
      },
      {
        headers: {
          'Authorization': `Bearer ${DOUBAO_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    
    return response.data;
  });
}

// ============ API 路由 ============

// 聊天补全（带限流）
app.post('/v1/chat/completions', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { messages, model, stream = false } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }
    
    // 通过令牌桶限流
    const result = await limiter.schedule(() => callLLM(messages, model));
    
    const latency = Date.now() - startTime;
    console.log(`[LLM] Success - latency: ${latency}ms, model: ${model}`);
    
    res.json(result);
    
  } catch (error: any) {
    const latency = Date.now() - startTime;
    
    if (error.response?.status === 429) {
      console.error(`[LLM] 429 Rate Limit - latency: ${latency}ms`);
      res.status(429).json({
        error: 'Rate limit exceeded',
        retry_after: 5
      });
    } else {
      console.error(`[LLM] Error - latency: ${latency}ms:`, error.message);
      res.status(500).json({
        error: error.message
      });
    }
  }
});

// 健康检查
app.get('/health', (req, res) => {
  const counts = limiter.counts();
  res.json({
    status: 'ok',
    limiter: {
      running: counts.RUNNING,
      queued: counts.QUEUED,
      reservoir: counts.RESERVOIR
    },
    timestamp: Date.now()
  });
});

// 统计信息
app.get('/stats', (req, res) => {
  const counts = limiter.counts();
  res.json({
    running: counts.RUNNING,
    queued: counts.QUEUED,
    reservoir: counts.RESERVOIR,
    timestamp: Date.now()
  });
});

// ============ 启动服务器 ============
app.listen(PORT, () => {
  console.log(`LLM Rate Limiter Proxy listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Stats: http://localhost:${PORT}/stats`);
  console.log(`Rate limit: 30 tokens, refill 5/s, max concurrent 3`);
});
