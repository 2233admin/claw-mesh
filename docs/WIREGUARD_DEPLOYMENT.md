# WireGuard Mesh + FSC Worker Deployment Guide

**Version:** 0.2.0  
**Last Updated:** 2026-03-03

## 概述

本指南介绍如何在 3 节点 WireGuard 全网状 VPN 中部署 FSC Worker Daemon，实现跨节点 Redis 任务调度、Docker 沙箱执行及结果回传。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    WireGuard Mesh Network                    │
│                      10.10.0.0/24                            │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Node 1     │────│   Node 2     │────│   Node 3     │  │
│  │ 10.10.0.1    │    │ 10.10.0.2    │    │ 10.10.0.3    │  │
│  │              │    │              │    │              │  │
│  │ Redis Master │    │ FSC Worker   │    │ FSC Worker   │  │
│  │ FSC Worker   │    │              │    │              │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## 核心特性

### 1. 分布式锁（Redis SETNX）
- 防止多节点重复执行同一任务
- 锁自动过期（5分钟）防止死锁
- 锁释放保证（try-finally）

### 2. 网络防断联
- systemd 自动重启 WireGuard（5秒重试）
- PersistentKeepalive 25秒保持连接
- MTU 1420 避免分片

### 3. Docker 容器跨子网访问
- iptables NAT 规则：Docker 容器 → WireGuard
- PostUp/PostDown 自动配置

### 4. 并发控制
- Semaphore 限制最大并发数
- 优雅关闭：drain 等待任务完成

## 前置条件

### 软件依赖
- WireGuard Tools
- Docker
- Redis (Node 1)
- Bun (Node.js runtime)
- iptables

### 安装依赖

```bash
# OpenCloudOS 9
yum install -y wireguard-tools docker iptables

# 安装 Bun
curl -fsSL https://bun.sh/install | bash

# 启动 Docker
systemctl enable --now docker
```

### 网络要求
- 所有节点可以通过公网 IP 互相访问
- UDP 端口 51820 开放
- 防火墙允许 WireGuard 流量

## 部署步骤

### Step 1: 生成 WireGuard 密钥

在每个节点上生成密钥对：

```bash
# 生成私钥
wg genkey > /etc/wireguard/private.key
chmod 600 /etc/wireguard/private.key

# 生成公钥
wg pubkey < /etc/wireguard/private.key > /etc/wireguard/public.key

# 查看公钥（需要分享给其他节点）
cat /etc/wireguard/public.key
```

### Step 2: 配置 WireGuard

使用 bootstrap 脚本自动配置：

```bash
# Node 1 (10.10.0.1)
cd /opt/claw-mesh
./scripts/bootstrap-mesh.sh 1 10.10.0.1 "$(cat /etc/wireguard/private.key)"

# Node 2 (10.10.0.2)
./scripts/bootstrap-mesh.sh 2 10.10.0.2 "$(cat /etc/wireguard/private.key)"

# Node 3 (10.10.0.3)
./scripts/bootstrap-mesh.sh 3 10.10.0.3 "$(cat /etc/wireguard/private.key)"
```

### Step 3: 更新 Peer 公钥

编辑 `/etc/wireguard/wg0.conf`，将 `<PEER_X_PUBLIC_KEY>` 替换为实际的公钥：

```ini
[Interface]
PrivateKey = <YOUR_PRIVATE_KEY>
Address = 10.10.0.1/24
ListenPort = 51820
MTU = 1420

PostUp = iptables -A FORWARD -i wg0 -j ACCEPT
PostUp = iptables -t nat -A POSTROUTING -o docker0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o docker0 -j MASQUERADE

# Peer 2
[Peer]
PublicKey = <NODE_2_PUBLIC_KEY>
AllowedIPs = 10.10.0.2/32
PersistentKeepalive = 25

# Peer 3
[Peer]
PublicKey = <NODE_3_PUBLIC_KEY>
AllowedIPs = 10.10.0.3/32
PersistentKeepalive = 25
```

### Step 4: 启动 WireGuard

```bash
# 重启 WireGuard
systemctl restart wg-quick@wg0

# 检查状态
systemctl status wg-quick@wg0

# 查看 WireGuard 接口
wg show
```

### Step 5: 验证网络连通性

```bash
# 从 Node 1 ping Node 2
ping -c 3 10.10.0.2

# 从 Node 1 ping Node 3
ping -c 3 10.10.0.3

# 检查 Docker 容器是否能访问 WireGuard 网络
docker run --rm alpine ping -c 3 10.10.0.1
```

### Step 6: 部署 Redis (Node 1)

```bash
# 安装 Redis
yum install -y redis

# 配置 Redis 监听 WireGuard 接口
cat >> /etc/redis/redis.conf << EOF
bind 10.10.0.1
protected-mode no
EOF

# 启动 Redis
systemctl enable --now redis

# 验证
redis-cli -h 10.10.0.1 ping
```

### Step 7: 部署 FSC Worker

```bash
# 复制代码到 /opt/claw-mesh
cp -r /root/.openclaw/workspace/claw-mesh-dev /opt/claw-mesh

# 配置环境变量
cd /opt/claw-mesh
cp .env.example .env

# 编辑 .env
vim .env

# 启动 FSC Worker
systemctl enable --now fsc-worker@node1

# 查看日志
journalctl -u fsc-worker@node1 -f
```

## 验证部署

### Q1: WireGuard 自动重启

```bash
# 手动 kill WireGuard 进程
pkill -9 wg

# 等待 5 秒，检查是否自动重启
sleep 5
systemctl status wg-quick@wg0
```

**预期结果：** systemd 自动重启 WireGuard

### Q2: Docker 容器访问 WireGuard

```bash
# 在 Node 2 或 Node 3 上运行
docker run --rm alpine ping -c 3 10.10.0.1
```

**预期结果：** ping 成功（验证 iptables NAT 规则）

### Q3: 分布式锁防重复执行

```bash
# 在 Node 1 上注入测试任务
redis-cli -h 10.10.0.1 XADD fsc:tasks * task '{"id":"test-lock","image":"alpine","commands":["sleep 10"]}'

# 立即在 Node 2 上注入相同任务（相同 MESSAGE_ID）
# 注意：需要使用相同的 MESSAGE_ID
redis-cli -h 10.10.0.1 XADD fsc:tasks * task '{"id":"test-lock","image":"alpine","commands":["sleep 10"]}'

# 检查日志
journalctl -u fsc-worker@node1 -f
journalctl -u fsc-worker@node2 -f
```

**预期结果：** 只有一个 Worker 获得锁并执行，另一个 Worker 跳过

### Q4: 端到端任务执行

```bash
# 注入任务
redis-cli -h 10.10.0.1 XADD fsc:tasks * task '{"id":"e2e-test","image":"alpine","commands":["echo hello","date"]}'

# 等待执行完成，检查结果
redis-cli -h 10.10.0.1 XREAD BLOCK 10000 STREAMS fsc:results 0

# 检查 Worker 日志
journalctl -u fsc-worker@node1 -n 50
```

**预期结果：** 
- 任务成功执行
- 结果推送到 `fsc:results`
- 无网络掉线或丢包

## 故障排查

### WireGuard 无法启动

```bash
# 检查配置文件语法
wg-quick up wg0

# 检查防火墙
firewall-cmd --list-all

# 检查 UDP 端口
ss -ulnp | grep 51820
```

### Docker 容器无法访问 WireGuard

```bash
# 检查 iptables 规则
iptables -t nat -L POSTROUTING -n

# 手动添加规则
iptables -A FORWARD -i wg0 -j ACCEPT
iptables -t nat -A POSTROUTING -o docker0 -j MASQUERADE
```

### FSC Worker 无法连接 Redis

```bash
# 检查 Redis 监听地址
redis-cli -h 10.10.0.1 ping

# 检查防火墙
firewall-cmd --add-port=6379/tcp --permanent
firewall-cmd --reload

# 检查 Redis 配置
grep bind /etc/redis/redis.conf
```

### 任务重复执行

```bash
# 检查分布式锁
redis-cli -h 10.10.0.1 KEYS "lock:task:*"

# 检查锁的 TTL
redis-cli -h 10.10.0.1 TTL "lock:task:<MESSAGE_ID>"

# 手动释放锁
redis-cli -h 10.10.0.1 DEL "lock:task:<MESSAGE_ID>"
```

## 性能调优

### 并发数调整

编辑 `/etc/systemd/system/fsc-worker@.service`：

```ini
Environment=MAX_CONCURRENT=20
```

重启服务：

```bash
systemctl daemon-reload
systemctl restart fsc-worker@node1
```

### MTU 优化

如果遇到丢包，尝试降低 MTU：

```ini
# /etc/wireguard/wg0.conf
MTU = 1380
```

### Redis 连接池

编辑 `fsc-worker-daemon.ts`，增加连接超时：

```typescript
const redis = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    connectTimeout: 10000,  // 10 seconds
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
  }
});
```

## 监控

### 健康检查

```bash
# 检查 Worker 健康状态
redis-cli -h 10.10.0.1 GET fsc:worker:health

# 输出示例
{"timestamp":1709481600000,"running":3,"maxConcurrent":10,"agentId":"worker-node1"}
```

### 任务队列监控

```bash
# 查看待处理任务数
redis-cli -h 10.10.0.1 XLEN fsc:tasks

# 查看 Consumer Group 信息
redis-cli -h 10.10.0.1 XINFO GROUPS fsc:tasks

# 查看 DLQ（死信队列）
redis-cli -h 10.10.0.1 XLEN fsc:dlq
```

### 日志监控

```bash
# 实时查看 Worker 日志
journalctl -u fsc-worker@node1 -f

# 查看最近 100 条日志
journalctl -u fsc-worker@node1 -n 100

# 查看错误日志
journalctl -u fsc-worker@node1 -p err
```

## 安全建议

1. **WireGuard 密钥管理**
   - 私钥权限设置为 600
   - 定期轮换密钥
   - 不要将私钥提交到 Git

2. **Redis 安全**
   - 使用 `requirepass` 设置密码
   - 限制 Redis 监听地址
   - 启用 TLS（可选）

3. **Docker 安全**
   - 不使用 `--privileged` 模式
   - 限制容器资源（CPU、内存）
   - 使用只读根文件系统

4. **防火墙配置**
   - 只开放必要的端口
   - 使用 WireGuard 加密所有流量
   - 定期审计防火墙规则

## 参考资料

- [WireGuard Quick Start](https://www.wireguard.com/quickstart/)
- [Redis Streams](https://redis.io/docs/data-types/streams/)
- [Docker Security](https://docs.docker.com/engine/security/)
- [systemd Service Management](https://www.freedesktop.org/software/systemd/man/systemd.service.html)

## 更新日志

### v0.2.0 (2026-03-03)
- 新增分布式锁（Redis SETNX）
- 新增 iptables NAT 规则
- 新增 systemd 自动重启
- 新增完整的验证清单

### v0.1.0 (2026-03-02)
- 初始版本
- 基础 FSC Worker 实现
- WireGuard 全网状配置
