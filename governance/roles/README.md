# OpenClaw Agent Roles

14 agent roles across 3 nodes, governed by CPC 3-tier system.

## Node Assignment

| Node | Roles | Primary Domain |
|------|-------|---------------|
| Central (JP) | Coordinator, Meta-Sentinel, Arbitrator | Governance, signal aggregation |
| Silicon Valley (US) | US Market Sentinel, Code Reviewer, DevOps | US markets, CI/CD |
| Tokyo (JP) | APAC Sentinel, Crypto Monitor, Data Analyst | Asia-Pacific markets, crypto |

## Role Definitions

Each role is defined by an `AGENT.md` in its OpenClaw deployment:
- Persona and capabilities
- Input/output contracts
- Handoff protocols (who passes work to whom)
- Permission boundaries
- Failure behavior (autonomous vs escalate)

TODO: Import AGENT.md definitions from each node's `~/.openclaw/agents/`
