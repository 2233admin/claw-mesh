# Claw-Grid Runtime Manifest

## Architecture: 4-Layer Concurrent Framework

| Layer | Name | Technology | Failure Domain |
|-------|------|-----------|----------------|
| L1 | Command | Claude Code orchestration | Session loss → agents continue autonomously |
| L2 | Node | 3× OpenClaw (14 roles, CPC governance) | Node down → others self-heal, central re-assigns |
| L3 | Data | SUPER China Gateway + PostgreSQL + NetBird | DB down → local sentinel caches, retry on reconnect |
| L4 | Execution | 1000 Docker Agents via Redis Streams | Agent crash → trust score penalty, task re-queued |

## What's Real vs What's Spec

- **Python is runtime**: `sentinel/` scripts, crontab schedules, PostgreSQL aggregation — this is what runs in production
- **TypeScript is spec**: `spec/ts-governance/` contains formal policy definitions — NOT IN PROD
- **governance/ is operational**: roles, policies, runbooks, SLOs — real governance assets, not abstractions

## Dev Rules

- Bun runtime, not Node.js. HTTP via `Bun.serve`, no express/koa
- TypeScript strict mode. Errors as Result objects, not try-catch
- High-frequency: MessagePack/FlatBuffers, not JSON
- Docker Agent < 200MB. Central server 2-core/2GB — be memory-conscious
- Worker models: MiniMax/Doubao only. Never Claude/GPT-4 at worker layer
- Tests: Vitest

## Key Paths

| Path | Purpose |
|------|---------|
| `governance/roles/` | 14 OpenClaw agent role definitions |
| `governance/cpc-policy/` | CPC 3-tier governance rules |
| `governance/runbooks/` | Node failure, sentinel, recovery procedures |
| `governance/slo/` | Queue latency, failure rate, recovery time targets |
| `sentinel/` | Python sentinel monitoring (4-node distributed) |
| `spec/ts-governance/` | TS formal spec (future, not runtime) |
| `fsc/fsc-worker-daemon.ts` | FSC worker daemon |
| `packages/core/` | Core runtime (scheduler, metrics, inference) |
| `api/` | LLM proxy + SSE + MCP |
| `deploy/` | Docker, systemd configs |

## Change Protocol

1. Change runbook/role definition first
2. Change code second
3. Change docs last
4. Never reference TS spec as runtime behavior

## Don'ts

- Don't delete SSH tunnel configs (failover needs them)
- Don't use expensive models at worker layer
- Don't send raw logs to central (aggregated metrics only)
- Don't treat `spec/ts-governance/` as current implementation

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **claw-mesh** (1337 symbols, 2861 relationships, 106 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.
<!-- gitnexus:end -->
