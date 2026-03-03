# CLAW Mesh 深度整合设计

**目标**: 不是套娃，而是把外部技能的核心能力嵌入到 CLAW Mesh 原生架构中

---

## 🎯 整合原则

1. **原生嵌入**: 能力直接构建在 CLAW Mesh 组件中（Gateway / Worker / MemoV）
2. **能力复用**: 拆解外部技能核心，不引入完整技能包
3. **接口统一**: 通过 Redis Stream / MemoV 事件总线交互
4. **渐进式**: 从高价值能力开始，逐步覆盖

---

## 📦 外部技能拆解与整合点

| 技能 | 核心能力 | 整合位置 | 实现方式 |
|------|---------|---------|---------|
| `capability-evolver` | 运行时分析+自演进 | FSC Worker + MemoV | 任务完成后触发能力分析，存入 MemoV 知识图谱 |
| `self-improving-agent` | 错误捕获+经验固化 | Ralph 验证 + MemoV | 验证失败/成功时，存入因果链 + 知识图谱 |
| `secure-remote-access` | 安全隧道 | WireGuard 层 | 复用现有 WireGuard 全网状，无需额外层 |
| `github` | PR 流程 | FSC Gateway | 任务完成后自动创建 PR / 评论 |
| `clawsignal` | 信号通知 | 健康检查 + Redis | 健康状态变化时发信号 |
| `linear` | 任务管理 | 任务调度层 | FSC 任务映射 Linear issue |
| `automation-workflows` | 工作流编排 | FSC Gateway | 多步骤任务流支持 |
| `proactive-agent` | 主动触发 | 调度器 + Redis | 基于阈值自动触发任务 |
| `auto-updater-skill` | 自动更新 | deploy/ 脚本 | 节点版本管理 + 滚动更新 |
| `lark-integration` | Lark 通知 | 信号层 | 关键事件通知 Lark |
| `arc-free-worker-dispatch` | 无服务器调度 | Worker 池 | 动态 Worker 扩缩容 |
| `agent-swarm` | 多 Agent 协作 | MemoV + 任务流 | 基于知识图谱的 Agent 协作 |
| `simplify-and-harden` | 简化+加固 | deploy/ + 安全检查 | 配置加固 + 最小权限 |
| `find-skills` | 能力发现 | 知识图谱 | 基于能力标签的发现 |

---

## 🏗️ 整合后的架构

```
┌─────────────────────────────────────────────────────────────┐
│                    CLAW Mesh Control Plane                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ FSC Gateway  │  │  MemoV KG   │  │  Health Monitor  │  │
│  │ - 任务调度    │  │ - 实体-关系  │  │ - 信号通知       │  │
│  │ - PR 自动创建 │  │ - 因果链     │  │ - Lark 通知      │  │
│  │ - 能力发现    │  │ - 向量索引   │  │ - 阈值触发       │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             ▼
       ┌──────────┐  ┌──────────┐  ┌──────────┐
       │ 硅谷节点 │  │ 东京节点 │  │CURRYCLAW │
       │- Worker  │  │- Worker  │  │- Worker  │
       │- 自演进  │  │- 自演进  │  │- 自演进  │
       │- 经验固化│  │- 经验固化│  │- 经验固化│
       └──────────┘  └──────────┘  └──────────┘
              │             │             │
              └─────────────┼─────────────┘
                            ▼
              ┌──────────────────────────┐
              │   WireGuard Full-Mesh    │
              │   (10.10.0.0/24)        │
              └──────────────────────────┘
```

---

## 🚀 第一阶段整合（高价值）

### 1. `capability-evolver` + `self-improving-agent` → 能力自演进
- **位置**: `fsc/worker-capability-evolver.ts`
- **触发**: 任务完成后（成功/失败）
- **存储**: MemoV 知识图谱 + 因果链
- **接口**: 与现有 `memov-event-snap.ts` 集成

### 2. `github` → 自动 PR 创建
- **位置**: `fsc/gateway-github-integration.ts`
- **触发**: 任务标记为 "ready-for-pr"
- **功能**: 自动创建 PR、添加评论、关联 issue

### 3. `auto-updater-skill` → 节点自动更新
- **位置**: `deploy/node-auto-updater.sh`
- **触发**: 版本检查 + 滚动更新
- **安全**: 签名验证 + 金丝雀发布

---

## 📝 待办

- [ ] 设计能力自演进接口
- [ ] 实现 GitHub PR 自动创建
- [ ] 实现节点自动更新脚本
- [ ] 更新 `package.json` scripts
- [ ] 更新架构图
