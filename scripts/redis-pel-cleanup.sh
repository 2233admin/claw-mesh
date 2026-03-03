#!/usr/bin/env bash
# Redis PEL (Pending Entry List) 僵尸消息清理脚本
# 每分钟执行一次，清理超过 30 秒未确认的消息

set -euo pipefail

REDIS_HOST="${REDIS_HOST:-10.10.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
STREAM_KEY="fsc:tasks"
CONSUMER_GROUP="fsc-workers"
IDLE_TIME=30000  # 30 秒
COUNT=100

# 执行 XAUTOCLAIM
redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" \
  XAUTOCLAIM "$STREAM_KEY" "$CONSUMER_GROUP" '*' "$IDLE_TIME" 0-0 COUNT "$COUNT" \
  > /dev/null 2>&1

# 检查 pending 数量
PENDING=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" \
  XINFO GROUPS "$STREAM_KEY" | grep -A 10 "$CONSUMER_GROUP" | grep pending | awk '{print $2}')

echo "[$(date '+%Y-%m-%d %H:%M:%S')] PEL cleanup: pending=$PENDING"

# 告警：pending >50
if [ "$PENDING" -gt 50 ]; then
  echo "WARNING: High pending count: $PENDING" >&2
  # TODO: 发送告警到 QQ/邮件
fi
