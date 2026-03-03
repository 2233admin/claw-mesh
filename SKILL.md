
---
name: wireguard-mesh
description: WireGuard 全网状 VPN + AI 集群调度器。用于多节点 WireGuard 组网、内网穿透、渲染农场式 DAG 任务调度。触发词：WireGuard、VPN 组网、全网状、mesh networking、节点互通、内网穿透、集群调度、异步推理、并行任务
---

# WireGuard Mesh Skill

多节点 WireGuard 全网状 VPN + AI 集群调度器。

## Capabilities
- **WireGuard Mesh** — 全网状 VPN，节点直连
- **Scheduler** — 渲染农场式 DAG 调度器，webhook 下发 + 回调收割

## Network Topology
混合拓扑（Hybrid Mesh）：
- 默认：全网状（Full Mesh），所有节点直连
- 可选：混合模式（Hub-Spoke + Partial Mesh），减少无效隧道维护开销
  - 中心节点：作为 Hub，连接所有边缘节点
  - 边缘节点：只连 Hub 和同区域节点，不跨区域直连

## 适用场景
| 拓扑 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| 全网状（默认） | 节点少（<10）、低延迟要求 | 无中心瓶颈、直连快 | 隧道数 O(n²)、维护开销大 |
| 混合拓扑 | 节点多（>10）、跨区域 | 隧道数 O(n)、维护开销小 | 依赖 Hub、跨区域需中转 |

## Default Parameters
- 子网：`10.10.0.0/24`
- 端口：`UDP 51820`
- Keepalive：`25s`
- 接口：`wg0`
- MTU：`1420（默认），大文件传输自动设 `8960`

## How to Use

### 1. 安装
```bash
# RHEL/OpenCloudOS/CentOS
yum install -y wireguard-tools || dnf install -y wireguard-tools
# Debian/Ubuntu
apt install -y wireguard
# 加载内核模块
modprobe wireguard
```

### 2. 生成密钥
```bash
wg genkey | tee /etc/wireguard/private.key | wg pubkey &gt; /etc/wireguard/public.key
chmod 600 /etc/wireguard/private.key
```

### 3. 配置文件模板 `/etc/wireguard/wg0.conf`
```ini
[Interface]
PrivateKey = &lt;本机私钥&gt;
Address = 10.10.0.X/24
ListenPort = 51820

# 对每个 peer 重复以下段
[Peer]
PublicKey = &lt;对端公钥&gt;
AllowedIPs = 10.10.0.Y/32
Endpoint = &lt;对端公网IP&gt;:51820
PersistentKeepalive = 25
```

### 4. 启动 &amp; 开机自启
```bash
systemctl enable wg-quick@wg0
systemctl start wg-quick@wg0
```

### 5. 验证
```bash
wg show wg0          # 查看接口状态
ping 10.10.0.Y       # 测试连通性
```

## IP Allocation Rules
按节点角色顺序分配：
- `.1` = 主控/调度节点
- `.2` = 计算节点 A
- `.3` = 计算节点 B
- `.4+` = 扩展节点

## Firewall Requirements
云服务商安全组需放开 **UDP 51820**（所有节点互通）。

## Coexistence with SSH Tunnels
WireGuard 作为主通道，SSH 隧道保留为备用：
- 主通道：`curl http://10.10.0.X:18789` （WireGuard）
- 备用通道：`curl http://localhost:18790` （SSH 隧道）
- 调试优先用 SSH：`ss -tlnp | grep 18793` 可直接看隧道状态

## Troubleshooting
```bash
# 检查接口是否启动
ip a show wg0
# 检查握手状态（latest handshake 应 &lt; 2 分钟）
wg show wg0
# 检查 UDP 端口
netstat -ulnp | grep 51820
# 重启接口
systemctl restart wg-quick@wg0
```

## Expanding New Nodes
1. 新节点安装 WireGuard + 生成密钥
2. 分配下一个 IP（如 10.10.0.4）
3. 新节点配置所有现有节点为 Peer
4. 所有现有节点追加新 Peer 段并 `wg syncconf wg0 &lt;(wg-quick strip wg0)` 热加载
5. 安全组放开新节点 ↔ 所有节点的 UDP 51820

## Notes
- 私钥绝不外传，只存本机 `/etc/wireguard/private.key`
- `AllowedIPs` 用 `/32` 精确匹配，避免路由冲突
- 跨云商延迟通常 30-110ms，同区域 &lt; 5ms
- `PersistentKeepalive = 25` 保持 NAT 映射存活

## Reference
- `reference/architecture.md` - 架构设计（待添加）
- `reference/troubleshooting.md` - 踩坑记录（待添加）

## Limitations
- 仅支持 Linux 节点
- WireGuard 需要内核模块或用户态工具
- 无自动重连（后续优化）
- 无 mDNS 节点发现（后续优化）

