# CLAUDE.md — claw-mesh

## 项目概述
FSC-Mesh 分布式 AI 编码集群的基础设施层。
三节点全互联: 中央(10.10.0.1) + 硅谷(10.10.0.2) + 东京(10.10.0.3)

## 架构
- **网络**: WireGuard 主 + SSH 容错热备 (环形互修)
- **消息**: Redis 7 Streams (XREADGROUP + XACK)
- **记忆**: MemoV (Git + Redis) + Pointer Memory (URI寻址)
- **执行**: Docker Agent 容器 (<200MB)，1000 并发目标
- **治理**: 四层架构 (宪法→仲裁→汇总→执行)

## 技术约束
- 运行时: Bun (非 Node.js)
- 中央服务器 2核/2G — 代码必须内存敏感
- Docker Agent 镜像 < 200MB
- 每任务 < 4000 tokens
- 每小时成本 < $0.50
- Worker 模型: MiniMax/Doubao (廉价优先)

## 编码规范
- TypeScript strict mode
- 错误处理: 返回 Result 对象，不用 try-catch 包装业务逻辑
- 序列化: MessagePack/FlatBuffers (非 JSON) 用于高频通信
- 测试: Vitest
- 包管理: bun

## 关键路径
- `fsc/fsc-worker-daemon.ts` — Worker 守护进程
- `fsc/memov-sync-daemon.ts` — 记忆同步
- `memory/pointer.js` — Pointer Memory OS
- `memory/causal.js` — 故障诊断
- `memory/ontology.js` — 知识图谱
- `api/` — LLM 代理 + SSE + MCP
- `deploy/Dockerfile.agent` — Agent 容器镜像
- `config/wg0.conf.template` — WireGuard 模板

## 不要做的事
- 不要删除 SSH 隧道配置 (容错需要)
- 不要用 express/koa，用 Bun.serve
- 不要在 Worker 层用昂贵模型 (Claude/GPT-4)
- 不要把原始日志传到中央节点 (只传聚合指标)
