# 生产级修复部署指南

**Version:** v0.3.5  
**Priority:** P0 EMERGENCY  
**Deadline:** 2026-03-03 23:59 CST

## 修复清单

### F1: Redis PEL 僵尸消息清理 ✅

**问题：** Redis PEL >100 导致任务重复执行

**修复：**
1. 部署清理脚本
```bash
# 复制脚本到所有节点
scp scripts/redis-pel-cleanup.sh root@10.10.0.1:/usr/local/bin/
scp scripts/redis-pel-cleanup.sh root@10.10.0.2:/usr/local/bin/
scp scripts/redis-pel-cleanup.sh root@10.10.0.3:/usr/local/bin/

# 添加 cron（每分钟执行）
crontab -e
*/1 * * * * /usr/local/bin/redis-pel-cleanup.sh >> /var/log/redis-pel-cleanup.log 2>&1
```

2. 验证
```bash
redis-cli -h 10.10.0.1 XINFO GROUPS fsc:tasks | grep pending
# 预期：pending: 0
```

3. 监控告警
```bash
# 添加到 Grafana
pending_count > 50 → 发送 QQ 告警
```

---

### F2: Docker wg0 网络修复 ✅

**问题：** Docker 容器无法访问 WireGuard 网络，丢包率 >50%

**修复：**
1. 部署 Docker daemon.json
```bash
# 所有节点
cp config/docker-daemon.json /etc/docker/daemon.json
systemctl restart docker
```

2. 部署 sysctl 配置
```bash
# 所有节点
cp config/99-wireguard-docker.conf /etc/sysctl.d/
sysctl -p /etc/sysctl.d/99-wireguard-docker.conf
```

3. 更新 WireGuard 配置
```bash
# 备份现有配置
cp /etc/wireguard/wg0.conf /etc/wireguard/wg0.conf.bak

# 使用新模板（双向转发）
cp config/wg0.conf.template /etc/wireguard/wg0.conf
# 手动填写 PrivateKey 和 Peer PublicKey

# 重启 WireGuard
systemctl restart wg-quick@wg0
```

4. 验证
```bash
# 测试 Docker 容器访问 WireGuard
docker run --rm alpine ping -c 10 10.10.0.1
# 预期：0% packet loss

# 测试 MTU（不分片）
docker run --rm alpine ping -c 4 -M do -s 1392 10.10.0.1
# 预期：无分片，0% loss
```

---

### F3: LLM Rate Limiter ✅

**问题：** 60 Agent 并发调用导致 429 雪崩

**修复：**
1. 安装依赖
```bash
cd api
bun install bottleneck axios
```

2. 启动 LLM 代理
```bash
# 配置环境变量
export DOUBAO_API_KEY="your_api_key"
export DOUBAO_ENDPOINT="https://ark.cn-beijing.volces.com/api/v3"

# 启动（使用 PM2）
pm2 start api/llm-proxy.ts --name llm-proxy
pm2 save
```

3. 更新 Agent 配置
```bash
# 所有 Agent 改为调用代理
LLM_API_URL=http://10.10.0.1:3002/v1/chat/completions
```

4. 验证
```bash
# 健康检查
curl http://10.10.0.1:3002/health

# 统计信息
curl http://10.10.0.1:3002/stats

# 并发测试（60 Agent）
for i in {1..60}; do
  curl -X POST http://10.10.0.1:3002/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"test"}]}' &
done
wait

# 预期：P99 <5s，无 429
```

---

### F4: 中文 Prompt 模板 ✅

**问题：** 复杂中文 Prompt 输出非 JSON 格式

**修复：**
1. 集成模板
```typescript
import { ZH_SYSTEM_PROMPT, retryUntilValidJSON } from './constants/ZH_SYSTEM_PROMPT';

// 使用示例
const result = await retryUntilValidJSON(async () => {
  const response = await callLLM([
    { role: 'system', content: ZH_SYSTEM_PROMPT },
    { role: 'user', content: '分析 Redis PEL 积压问题' }
  ]);
  return response.choices[0].message.content;
});

console.log(result.root_cause);
console.log(result.steps);
```

2. 验证
```bash
# 测试复杂中文 Prompt
node test-zh-prompt.js

# 预期：100% JSON 格式输出
```

---

### F5: SSE 流式输出 ✅

**问题：** 控制台无法实时显示 LLM 输出

**修复：**
1. 启动 SSE 服务
```bash
pm2 start api/stream-chat.ts --name stream-chat
pm2 save
```

2. 前端集成
```typescript
import { useStreamingChat } from './hooks/useStreamingChat';
import { OfflineBanner } from './components/OfflineBanner';

function ChatComponent() {
  const { isStreaming, isOffline, startStreaming, retry } = useStreamingChat();
  const [messages, setMessages] = useState('');

  const handleSend = () => {
    startStreaming(
      [{ role: 'user', content: 'Hello' }],
      {
        apiUrl: 'http://10.10.0.1:3003',
        onMessage: (content) => {
          setMessages(prev => prev + content);
        },
        onComplete: () => {
          console.log('Streaming complete');
        }
      }
    );
  };

  return (
    <>
      <OfflineBanner isOffline={isOffline} onRetry={handleSend} />
      <div>{messages}</div>
    </>
  );
}
```

3. 验证
```bash
# 测试流式输出
curl -X POST http://10.10.0.1:3003/api/stream/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test"}]}'

# 预期：逐字输出，keepalive 每 25 秒

# 测试断线重连
# 1. 启动前端
# 2. kill stream-chat 进程
# 3. 观察 Offline Banner 出现
# 4. 重启 stream-chat
# 5. 观察自动重连（3 秒内）
```

---

## 验证清单

### Q1: PEL 清理 ✅
```bash
redis-cli -h 10.10.0.1 XINFO GROUPS fsc:tasks | grep pending
# 预期：pending: 0
```

### Q2: Docker Ping ✅
```bash
docker run --rm alpine ping -c 10 10.10.0.1
# 预期：0% packet loss
```

### Q3: LLM 并发 ✅
```bash
# 60 Agent 并发测试
ab -n 60 -c 60 -p payload.json -T application/json \
  http://10.10.0.1:3002/v1/chat/completions

# 预期：P99 <5s，无 429
```

### Q4: Prompt JSON ✅
```bash
node test-zh-prompt.js
# 预期：100% JSON 格式输出
```

### Q5: SSE Offline ✅
```bash
# 1. 启动前端
# 2. kill stream-chat
# 3. 观察 Offline Banner
# 4. 重启 stream-chat
# 5. 观察自动重连（3 秒内）
```

---

## 回滚计划

### F1: Redis PEL
```bash
crontab -e
# 注释掉清理脚本
```

### F2: Docker
```bash
rm /etc/docker/daemon.json
systemctl restart docker
```

### F3: LLM
```bash
# 直连豆包 API（临时降级）
LLM_API_URL=https://ark.cn-beijing.volces.com/api/v3/chat/completions
```

### F4: Prompt
```bash
# 恢复旧 Prompt
git checkout HEAD~1 constants/ZH_SYSTEM_PROMPT.ts
```

### F5: SSE
```bash
pm2 stop stream-chat
pm2 delete stream-chat
```

---

## 监控告警

### Grafana Dashboard

**指标：**
- Redis pending count
- Docker 丢包率
- LLM 429 率
- LLM P99 延迟
- SSE 连接数

**告警规则：**
- `pending >50` → QQ 告警
- `丢包率 >5%` → QQ 告警
- `429 率 >1%` → QQ 告警
- `P99 延迟 >5s` → QQ 告警

---

## 性能测试

### 60 Agent 并发测试

```bash
# 启动 60 个 Worker
for i in {1..60}; do
  pm2 start fsc/fsc-worker-daemon.ts --name worker-$i
done

# 注入 100 个任务
for i in {1..100}; do
  redis-cli -h 10.10.0.1 XADD fsc:tasks '*' task "{\"id\":\"test-$i\",\"image\":\"alpine\",\"commands\":[\"echo hello\"]}"
done

# 监控
watch -n 1 'redis-cli -h 10.10.0.1 XINFO GROUPS fsc:tasks'
```

**预期结果：**
- 所有任务在 5 分钟内完成
- pending 保持在 10 以下
- 无 429 错误
- P99 延迟 <5s

---

## 部署时间线

| 时间 | 任务 | 负责人 |
|------|------|--------|
| 09:00-09:30 | F1 Redis PEL 清理 | 陈昭芊 |
| 09:30-10:00 | F2 Docker wg0 网络 | 陈昭芊 |
| 10:00-10:30 | F3 LLM Rate Limiter | 陈昭芊 |
| 10:30-11:00 | F4 中文 Prompt | 陈昭芊 |
| 14:00-14:30 | F5 SSE 流式输出 | 陈昭芊 |
| 14:30-15:00 | E2E 验证 | 陈昭芊 |

---

## 成功标准

✅ Redis pending 持续保持在 10 以下  
✅ Docker 容器 0% 丢包  
✅ 60 Agent 并发无 429  
✅ 中文 Prompt 100% JSON 输出  
✅ SSE 断线 3 秒内自动重连  

**目标：** 60 Agent 并行稳如老狗！
