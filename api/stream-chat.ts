#!/usr/bin/env bun
/**
 * SSE Streaming Chat API
 * 
 * 功能：
 * - Server-Sent Events 流式输出
 * - 自动 keepalive（25 秒）
 * - 断线重连支持
 */

import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.STREAM_PORT || '3003');

// ============ SSE 流式聊天 ============
app.post('/api/stream/chat', async (req, res) => {
  const { messages, model = 'doubao-pro-32k' } = req.body;
  
  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // 禁用 Nginx 缓冲
  
  // Keepalive 心跳（25 秒）
  const keepaliveInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);
  
  try {
    // 模拟流式输出（实际应该调用 LLM API）
    const response = "这是一个流式输出的示例。每个字符都会逐个发送。";
    
    for (let i = 0; i < response.length; i++) {
      const char = response[i];
      
      // 发送 SSE 事件
      res.write(`data: ${JSON.stringify({ content: char, done: false })}\n\n`);
      
      // 模拟延迟
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // 发送完成事件
    res.write(`data: ${JSON.stringify({ content: '', done: true })}\n\n`);
    res.end();
    
  } catch (error: any) {
    console.error('[SSE] Error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  } finally {
    clearInterval(keepaliveInterval);
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now()
  });
});

app.listen(PORT, () => {
  console.log(`SSE Streaming API listening on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/api/stream/chat`);
  console.log(`Keepalive: 25s`);
});
