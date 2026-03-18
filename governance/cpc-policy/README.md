# CPC Policy — Constitutional-Policy-Control

Three-tier governance ensuring deterministic agent alignment.

## Tier 1: Constitutional (Immutable)
- Resource hard limits (memory, CPU, tokens per task)
- Safety boundaries (no raw credential access, no destructive ops without confirmation)
- Cost ceiling ($0.50/hr per worker)
- Model restrictions (workers: MiniMax/Doubao only)

## Tier 2: Policy (Configurable)
- Trust Factor thresholds for task assignment
- Model routing rules (complexity → model tier)
- Retry/backoff parameters
- Signal aggregation windows

## Tier 3: Control (Runtime)
- Sentinel health checks and alerting
- Circuit breaker triggers
- Auto-healing protocols
- Graceful degradation cascade

TODO: Extract actual policy parameters from running nodes
