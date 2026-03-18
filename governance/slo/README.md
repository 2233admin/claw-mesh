# Service Level Objectives

| Metric | Target | Measurement |
|--------|--------|-------------|
| Sentinel heartbeat | 99.5% uptime per node | Cron execution success rate |
| Signal latency | < 5 min from event to aggregation | Timestamp delta in PostgreSQL |
| Task queue depth | < 100 pending at steady state | Redis XLEN |
| Agent failure rate | < 10% per hour | Trust Factor tracking |
| Recovery time | < 15 min after node failure | Sentinel detection to task redistribution |
| Cost per hour | < $0.50 worker spend | Budget controller metrics |

TODO: Set up Grafana dashboard for SLO tracking
