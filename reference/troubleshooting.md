
# WireGuard Mesh 踩坑记录

## Gateway bind=loopback 导致 WireGuard 不通（2026-02-22）

**现象**：WireGuard mesh ping 全通，但 `curl http://10.10.0.X:18789` 超时。`openclaw gateway restart` 报 "health check failed"。

**原因**：OpenClaw Gateway 默认 `bind=loopback`，只监听 `127.0.0.1:18789`。WireGuard 流量从 `wg0` 接口进来，目标是 `10.10.0.X:18789`，被 loopback 绑定拒绝。

**排查**：
```bash
ss -tlnp | grep 18789
# 如果显示 127.0.0.1:18789 → 问题确认
# 应该显示 0.0.0.0:18789
```

**修复**：
```bash
# 改 openclaw.json 中 gateway.bind 为 "lan"
python3 -c "
import json
with open('/root/.openclaw/openclaw.json') as f:
    cfg = json.load(f)
cfg['gateway']['bind'] = 'lan'
with open('/root/.openclaw/openclaw.json', 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
"
openclaw gateway restart
```

**注意**：`openclaw gateway restart` 可能报 "health check failed"，但实际服务已正常。用 `ss -tlnp | grep 18789` 和 `curl` 验证真实状态，不要只看 health check 结果。

---

## Gateway 重启后 node host device_token_mismatch（2026-02-22）

**现象**：改 bind 并重启 gateway 后，webhook `/hooks/agent` 返回 202（正常），但日志疯刷 `device_token_mismatch`，agent 执行结果无法回报。

**原因**：Gateway 重启后内部 device token 重新生成，node host 还持有旧 token，握手失败。

**影响**：webhook 下发正常，agent 能执行，但结果无法通过 node host 回传。

**排查**：
```bash
tail -50 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep device_token
```

**修复**：
```bash
# 方案1：重启 node host 重新握手
systemctl restart openclaw-node.service

# 方案2：删除 device 认证文件重新配对
rm /root/.openclaw/identity/device-auth.json
systemctl restart openclaw-node.service
# 然后在中央 Gateway 重新 approve 该节点
```

**预防**：重启 gateway 后记得同时重启 node host：
```bash
openclaw gateway restart &amp;&amp; systemctl restart openclaw-node.service
```

---

## 部署完忘记同步 skill 到远程节点（2026-02-22）

**现象**：WireGuard mesh 部署完毕，调度器也打包好了，但远程节点的 AI 被唤醒后完全不知道自己在 mesh 里，不知道怎么接收调度任务。

**原因**：skill 文件只存在中央节点的 `~/.openclaw/skills/` 下，没有同步到远程。

**影响**：远程 AI agent 缺少上下文，无法正确处理集群相关任务。

**修复**：
```bash
# 从中央同步 skills 到所有远程节点
rsync -az --delete --exclude='__pycache__' \
  ~/.openclaw/skills/wireguard-mesh/ \
  -e "ssh -i &lt;key&gt;" root@&lt;remote&gt;:/root/.openclaw/skills/wireguard-mesh/
```

**预防**：每次新增或更新 skill 后，跑一遍全集群同步。可以用 cluster-collab 的 `cluster_ops.py sync` 自动化。

---

## 跨节点SSH直连 - 密钥复用问题（2026-02-23）

**现象**：中央节点可以SSH到东京，但硅谷节点无法SSH到东京，报 `Permission denied`。

**原因**：东京节点的SSH authorized_keys 里只有中央的公钥，没有硅谷的。需要把中央的密钥复制到硅谷。

**排查**：
```bash
# 中央能连东京
ssh root@中央 "ssh root@东京 'hostname'"

# 硅谷连东京失败
ssh root@东京 'hostname'  # Permission denied
```

**修复**：
```bash
# 1. 从东京获取中央的密钥
ssh root@中央 "ssh root@东京 'cat ~/.ssh/id_ed25519_central'"

# 2. 复制到硅谷
echo '&lt;密钥内容&gt;' &gt; ~/.ssh/id_ed25519_tokyo
chmod 600 ~/.ssh/id_ed25519_tokyo

# 3. 测试直连
ssh -i ~/.ssh/id_ed25519_tokyo root@东京 "hostname"
```

**注意**：密钥安全问题 - 这是临时方案，生产环境应该为每个节点生成独立密钥对。

---

## 跨节点SSH直连 - 密钥路径问题（2026-02-23）

**现象**：复制密钥后仍然连不上，报 `Identity file not accessible`。

**原因**：SSH默认查找 `~/.ssh/id_rsa`，自定义密钥需要用 `-i` 指定。

**修复**：使用 `-i` 参数指定密钥文件：
```bash
ssh -i ~/.ssh/id_ed25519_tokyo root@东京IP
```

