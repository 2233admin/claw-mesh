# Claw-Grid Runtime Manifest

@PROJECT_INDEX.json



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

This project is indexed by GitNexus as **claw-mesh** (1947 symbols, 4584 relationships, 156 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/claw-mesh/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/claw-mesh/context` | Codebase overview, check index freshness |
| `gitnexus://repo/claw-mesh/clusters` | All functional areas |
| `gitnexus://repo/claw-mesh/processes` | All execution flows |
| `gitnexus://repo/claw-mesh/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
