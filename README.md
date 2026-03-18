# Claw-Grid: Distributed AI Sovereign Governance

> Governance is the art of minimizing entropy in an autonomous system.

Claw-Grid is a **distributed governance infrastructure** for aligning and controlling AI agents across a global mesh network. It is not a generic agent framework — it is a system for ensuring deterministic behavior alignment of 14+ autonomous agents operating across untrusted edge nodes.

## Production Architecture (4-Layer)

```
┌─────────────────────────────────────────────────────────────┐
│  L1  Command Layer — Claude Code orchestration              │
│       Session-level planning, task decomposition, routing   │
├─────────────────────────────────────────────────────────────┤
│  L2  Node Layer — 3 OpenClaw instances (14 agent roles)     │
│       Central (JP) · Silicon Valley (US) · Tokyo (JP)       │
│       CPC 3-tier governance: Constitutional → Arbitration   │
│       → Execution                                           │
├─────────────────────────────────────────────────────────────┤
│  L3  Data Layer — SUPER China Gateway + PostgreSQL          │
│       Signal aggregation · Market data · NetBird mesh SDN   │
├─────────────────────────────────────────────────────────────┤
│  L4  Execution Layer — 1000 Docker Agents (<200MB each)     │
│       FSC parallel coding · Redis Streams dispatch          │
│       Trust Factor scoring · Auto-degradation               │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

| Directory | What | Status |
|-----------|------|--------|
| `governance/` | Runtime governance: roles, policies, runbooks, SLOs | **Production** |
| `sentinel/` | Python monitoring scripts (4-node distributed) | **Production** |
| `spec/ts-governance/` | TypeScript formal spec (future target) | **Not in prod** |
| `fsc/` | Full Self Coding worker daemon | **Production** |
| `packages/core/` | Core runtime (scheduler, metrics, inference) | **Production** |
| `api/` | LLM proxy, SSE, MCP server | **Production** |
| `deploy/` | Docker, systemd, deployment configs | **Production** |

## Governance Model

The CPC (Constitutional-Policy-Control) system provides 3-tier governance:

1. **Constitutional Layer** — Immutable rules (resource limits, safety boundaries)
2. **Policy Layer** — Configurable policies (model routing, cost caps, trust thresholds)
3. **Control Layer** — Runtime enforcement (sentinel monitoring, circuit breakers, auto-healing)

Each OpenClaw node runs a subset of 14 agent roles with defined handoff protocols and failure domains.

## Network

Nodes connect via **NetBird** mesh (WireGuard-based SDN). Each node has:
- Autonomous operation capability (survives central disconnection)
- Local sentinel monitoring with crontab scheduling
- Signal aggregation to PostgreSQL on SUPER

## Tech Stack

- **Runtime**: Bun (TypeScript), Python (sentinel/data)
- **Messaging**: Redis 7 Streams (XREADGROUP + XACK)
- **Database**: PostgreSQL (signals), DuckDB (analytics)
- **Containers**: Docker (<200MB per agent)
- **Network**: NetBird mesh, SSH fallback
- **Models**: MiniMax/Doubao (workers), Claude (orchestration only)

## Getting Started

```bash
bun install && bun run build    # Build core
bun test                        # Run tests
```

See [CLAUDE.md](CLAUDE.md) for development guidelines and architecture constraints.

## License

MIT — CicadaRelay
