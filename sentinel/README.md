# Sentinel — Distributed Monitoring Network

Python-based sentinel scripts running on 4 nodes via crontab.

## Nodes

| Node | Script | Schedule | Coverage |
|------|--------|----------|----------|
| Central | `sentinel_central.py` | Every 2h | Meta-aggregation, cross-market signals, node health |
| Silicon Valley | `sentinel_us.py` | Every 30min (market hours) | US equities, S&P 500, VIX |
| Tokyo | `sentinel_apac.py` | Every 30min (market hours) | Hang Seng, Nikkei, crypto |
| SUPER | `sentinel_ashare.py` | Every 15min (market hours) | A-shares, HS300 |

## Signal Flow

```
Edge sentinel → PostgreSQL (SUPER) → Central meta-sentinel → Aggregated alerts
```

## Import Status

Scripts currently live on each node at `~/.openclaw/skills/sentinel/`.

To sync: `scp -o ProxyJump=root@43.167.192.145 root@10.10.0.5:~/.openclaw/skills/sentinel/*.py .`

TODO: Import scripts from Central/SV/Tokyo nodes into this directory
