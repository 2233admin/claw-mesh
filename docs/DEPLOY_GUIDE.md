# 三节点统一部署指南

## 快速开始

### 单节点部署

```bash
# 在任意节点上执行
cd /root/.openclaw/workspace/claw-mesh/scripts
./deploy-all.sh
```

脚本会自动检测当前节点并部署。

### 指定节点部署

```bash
# 部署到硅谷
./deploy-all.sh silicon

# 部署到东京
./deploy-all.sh tokyo

# 部署到中央
./deploy-all.sh central
```

### 一键部署所有节点

```bash
# 从任意节点执行，会自动 SSH 到其他节点
./deploy-all.sh all
```

## 部署内容

✅ 安装 Node.js 依赖  
✅ 配置 Docker（MTU 1420）  
✅ 配置 sysctl（ip_forward, rp_filter）  
✅ 启动 Redis PEL 清理（cron 每分钟）  
✅ 启动 FSC Worker（PM2）  
✅ 启动 API 服务（LLM Proxy + MCP Proxy + Stream Chat）  
✅ 验证部署

## 前置条件

- WireGuard 已配置（脚本不会配置 WireGuard）
- Redis 运行在 10.10.0.1:6379
- 节点间可以 SSH 互通（用于远程部署）

## 验证部署

```bash
# 检查服务状态
pm2 list

# 查看 FSC Worker 日志
pm2 logs fsc-worker

# 查看 API 日志
pm2 logs llm-proxy

# 查看 Redis PEL 清理日志
tail -f /var/log/redis-pel-cleanup.log

# 监控所有服务
pm2 monit
```

## 故障排查

### Docker 无法启动

```bash
# 检查配置
cat /etc/docker/daemon.json

# 查看日志
journalctl -u docker -n 50

# 重启
systemctl restart docker
```

### FSC Worker 无法启动

```bash
# 检查依赖
cd /root/.openclaw/workspace/claw-mesh
bun install

# 手动启动测试
cd fsc
bun run fsc-worker-daemon.ts
```

### API 服务无法启动

```bash
# 检查端口占用
netstat -tlnp | grep -E '3001|3002|3003'

# 手动启动测试
cd /root/.openclaw/workspace/claw-mesh/api
bun run llm-proxy.ts
```

## 回滚

```bash
# 停止所有服务
pm2 delete all

# 恢复 Docker 配置
cp /etc/docker/daemon.json.bak /etc/docker/daemon.json
systemctl restart docker

# 删除 cron
crontab -e
# 删除 redis-pel-cleanup.sh 那一行
```

## 节点信息

| 节点 | IP | 用途 |
|------|-----|------|
| 硅谷 | 170.106.73.160 | 控制台 + Worker |
| 东京 | 43.167.192.145 | Worker |
| 中央 | 43.163.225.27 | Redis Master + Worker |

## 下一步

1. 测试任务提交：`redis-cli -h 10.10.0.1 XADD fsc:tasks '*' task '{"id":"test","image":"alpine","commands":["echo hello"]}'`
2. 查看结果：`redis-cli -h 10.10.0.1 XREAD STREAMS fsc:results 0`
3. 访问控制台：http://170.106.73.160:5173（仅硅谷）
