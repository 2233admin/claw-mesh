#!/usr/bin/env bash
# DragonflyDB drop-in Redis replacement
# Deploy on central (10.10.0.1) — 2核2G, same protocol, 25x throughput
#
# Key insight: DragonflyDB is 100% Redis-compatible.
# Zero code changes needed. Just swap the binary.

set -euo pipefail

echo "=== DragonflyDB Migration ==="

# ─── 1. Install DragonflyDB ───
echo "[1/4] Installing DragonflyDB..."
if ! command -v dragonfly &>/dev/null; then
  # Official install
  curl -fsSL https://get.dragonflydb.io/latest | sudo bash
fi

# ─── 2. Create config matching current Redis setup ───
echo "[2/4] Creating config..."
cat > /etc/dragonfly/dragonfly.conf << 'EOF'
--bind 0.0.0.0
--port 6379
--requirepass fsc-mesh-2026
--maxmemory 256mb
--dbfilename dump.rdb
--dir /var/lib/dragonfly
--hz 100
--save 300:100
--keys_output_limit 12288
EOF

# ─── 3. Create systemd service ───
echo "[3/4] Creating service..."
cat > /etc/systemd/system/dragonfly.service << 'EOF'
[Unit]
Description=DragonflyDB (Redis-compatible)
After=network.target

[Service]
Type=simple
User=dfly
Group=dfly
ExecStart=/usr/local/bin/dragonfly --flagfile /etc/dragonfly/dragonfly.conf
LimitNOFILE=65535
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ─── 4. Migration steps (manual) ───
echo "[4/4] Migration ready"
echo ""
echo "=== Migration Steps ==="
echo "1. Export Redis data:  redis-cli -a fsc-mesh-2026 BGSAVE"
echo "2. Wait for save:     redis-cli -a fsc-mesh-2026 LASTSAVE"
echo "3. Stop Redis:        systemctl stop redis"
echo "4. Copy dump:         cp /var/lib/redis/dump.rdb /var/lib/dragonfly/"
echo "5. Start Dragonfly:   systemctl daemon-reload && systemctl enable --now dragonfly"
echo "6. Verify:            redis-cli -a fsc-mesh-2026 INFO server | grep dragonfly"
echo ""
echo "Rollback: systemctl stop dragonfly && systemctl start redis"
