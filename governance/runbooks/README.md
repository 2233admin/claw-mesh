# Operational Runbooks

## Node Failure Recovery

1. **Detection**: Sentinel cron fails → no heartbeat for 2 cycles
2. **Isolation**: Central marks node as degraded
3. **Redistribution**: Tasks re-queued to surviving nodes
4. **Recovery**: Node auto-rejoins via NetBird, sentinel resumes

## Sentinel Restart

```bash
# Check sentinel status on any node
crontab -l | grep sentinel
# Manual run
python3 ~/.openclaw/skills/sentinel/sentinel_<region>.py
```

## Signal Deduplication

Cross-market signals may fire from multiple nodes. PostgreSQL aggregation deduplicates by:
- Signal type + symbol + 15-min window
- Highest-confidence signal wins

TODO: Document Yahoo 429 handling, sshd watchdog, QQ push notification procedures
