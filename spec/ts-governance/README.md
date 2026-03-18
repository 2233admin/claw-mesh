# TypeScript Governance Spec (NOT IN PROD)

These files are the **formal specification** of the governance layer, not runtime code.

Production governance runs via:
- OpenClaw agents (14 roles, CPC 3-tier)
- Python sentinel scripts (4 nodes)
- PostgreSQL signal aggregation
- crontab scheduling

## When to reactivate TS implementation

1. Python-side interfaces stable for 2-3 iteration cycles
2. Contract tests exist between spec and runtime
3. SLO targets met, incident rate declining

Until then, these files serve as the "north star" architecture reference.
