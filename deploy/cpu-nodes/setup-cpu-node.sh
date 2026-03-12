#!/usr/bin/env bash
# setup-cpu-node.sh — Unified CPU node setup for claw-mesh
# Targets: 中央 10.10.0.1, 硅谷 10.10.0.2, 东京 10.10.0.3
# OS: Debian 12, 2-core/2GB RAM
# Idempotent — safe to re-run.
#
# Installs:
#   1. node_exporter  (Prometheus metrics, port 9100)
#   2. Ollama         (LLM runner, port 11434, 0.0.0.0)
#      └─ model: qwen2.5-coder:1.5b (~1.2 GB, fits in 2 GB)
#   3. claw-mesh heartbeat daemon (bun + fsc-worker-daemon placeholder)

set -euo pipefail

# ─── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[setup]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}    $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $*"; }
die()  { echo -e "${RED}[fail]${NC}  $*" >&2; exit 1; }

require_root() {
  [[ $EUID -eq 0 ]] || die "Must run as root"
}

# ─── Config ─────────────────────────────────────────────────────────────────
NODE_EXPORTER_VERSION="1.8.2"
NODE_EXPORTER_URL="https://github.com/prometheus/node_exporter/releases/download/v${NODE_EXPORTER_VERSION}/node_exporter-${NODE_EXPORTER_VERSION}.linux-amd64.tar.gz"
OLLAMA_MODEL="qwen2.5-coder:1.5b"
FSC_WORKER_DIR="/opt/fsc-worker"
FSC_WORKER_USER="fsc"

require_root

log "=== claw-mesh CPU Node Setup ==="
log "Hostname: $(hostname) | Kernel: $(uname -r)"

# ─── 1. node_exporter ───────────────────────────────────────────────────────
log "[1/3] node_exporter"

if systemctl is-active --quiet node_exporter 2>/dev/null; then
  ok "node_exporter already running — skipping install"
else
  if ! command -v node_exporter &>/dev/null && [ ! -f /usr/local/bin/node_exporter ]; then
    log "Downloading node_exporter v${NODE_EXPORTER_VERSION}..."
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT

    # Try apt first (Debian bookworm has it), fall back to binary download
    if apt-cache show prometheus-node-exporter &>/dev/null 2>&1; then
      apt-get install -y -q prometheus-node-exporter
    else
      curl -fsSL "${NODE_EXPORTER_URL}" | tar -xz -C "$TMP"
      install -o root -g root -m 0755 \
        "$TMP/node_exporter-${NODE_EXPORTER_VERSION}.linux-amd64/node_exporter" \
        /usr/local/bin/node_exporter
    fi
  else
    ok "node_exporter binary present"
  fi

  # Create dedicated user
  id node_exporter &>/dev/null || useradd -r -s /bin/false -M node_exporter

  # Systemd unit (idempotent write)
  cat > /etc/systemd/system/node_exporter.service << 'UNIT'
[Unit]
Description=Prometheus node_exporter — claw-mesh metrics
After=network.target

[Service]
User=node_exporter
Group=node_exporter
Type=simple
ExecStart=/usr/local/bin/node_exporter \
  --web.listen-address=:9100 \
  --collector.systemd \
  --collector.processes
Restart=on-failure
RestartSec=5s
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now node_exporter
  ok "node_exporter enabled on :9100"
fi

# ─── 2. Ollama ──────────────────────────────────────────────────────────────
log "[2/3] Ollama"

if ! command -v ollama &>/dev/null; then
  log "Installing Ollama..."
  curl -fsSL https://ollama.ai/install.sh | sh
else
  ok "Ollama binary present: $(ollama --version 2>&1 | head -1)"
fi

# Override: listen on 0.0.0.0, cap parallelism for 2 GB nodes
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf << 'OVERRIDE'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_FLASH_ATTENTION=1"
OVERRIDE

systemctl daemon-reload
systemctl enable --now ollama

# Wait for Ollama to become ready (up to 30 s)
log "Waiting for Ollama to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:11434/api/tags &>/dev/null; then
    ok "Ollama is up"
    break
  fi
  sleep 1
done

# Pull model if not already cached
if ollama list 2>/dev/null | grep -q "${OLLAMA_MODEL}"; then
  ok "Model ${OLLAMA_MODEL} already pulled"
else
  log "Pulling ${OLLAMA_MODEL} (~1.2 GB)..."
  ollama pull "${OLLAMA_MODEL}"
  ok "Model ready"
fi

# ─── 3. claw-mesh heartbeat / fsc-worker daemon ─────────────────────────────
log "[3/3] fsc-worker-daemon (heartbeat placeholder)"

# Create service user
id "${FSC_WORKER_USER}" &>/dev/null || \
  useradd -r -s /bin/false -m -d "${FSC_WORKER_DIR}" "${FSC_WORKER_USER}"

mkdir -p "${FSC_WORKER_DIR}"

# Install Bun for the fsc worker (if not present)
if ! command -v bun &>/dev/null && [ ! -f /usr/local/bin/bun ]; then
  log "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  # Make bun available system-wide
  BUN_BIN="${HOME}/.bun/bin/bun"
  if [ -f "${BUN_BIN}" ]; then
    install -o root -g root -m 0755 "${BUN_BIN}" /usr/local/bin/bun
  fi
else
  ok "Bun present"
fi

# Write minimal heartbeat worker (placeholder — replaced by real fsc-worker deploy)
if [ ! -f "${FSC_WORKER_DIR}/worker.ts" ]; then
  cat > "${FSC_WORKER_DIR}/worker.ts" << 'WORKER'
/**
 * fsc-worker-daemon — claw-mesh CPU node heartbeat
 * Placeholder: registers node with mesh, reports metrics.
 * Real implementation deployed separately via claw-mesh deploy pipeline.
 */
import os from "os";

const NODE_ID = process.env.NODE_ID ?? os.hostname();
const MESH_CENTRAL = process.env.MESH_CENTRAL ?? "http://10.10.0.1:18800";
const HEARTBEAT_INTERVAL_MS = 30_000;

async function heartbeat() {
  const payload = {
    nodeId: NODE_ID,
    ts: Date.now(),
    load: os.loadavg()[0],
    freeMem: os.freemem(),
    totalMem: os.totalmem(),
    uptime: os.uptime(),
  };
  try {
    const res = await fetch(`${MESH_CENTRAL}/nodes/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.error("[heartbeat] non-200:", res.status);
    else console.log("[heartbeat] ok", JSON.stringify(payload));
  } catch (e) {
    console.error("[heartbeat] error:", (e as Error).message);
  }
}

console.log(`[fsc-worker] starting — node=${NODE_ID} central=${MESH_CENTRAL}`);
heartbeat(); // immediate first beat
setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
WORKER
  chown -R "${FSC_WORKER_USER}:${FSC_WORKER_USER}" "${FSC_WORKER_DIR}"
  ok "worker.ts written"
fi

# Systemd unit for fsc-worker
cat > /etc/systemd/system/fsc-worker.service << UNIT
[Unit]
Description=claw-mesh FSC Worker Daemon
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
User=${FSC_WORKER_USER}
WorkingDirectory=${FSC_WORKER_DIR}
Environment="NODE_ID=$(hostname)"
Environment="MESH_CENTRAL=http://10.10.0.1:18800"
ExecStart=/usr/local/bin/bun run ${FSC_WORKER_DIR}/worker.ts
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable fsc-worker

# Only start if bun is available (might need re-login to pick up PATH)
if command -v bun &>/dev/null; then
  systemctl restart fsc-worker
  ok "fsc-worker started"
else
  warn "bun not in PATH yet — fsc-worker enabled but not started; re-run after re-login or run: systemctl start fsc-worker"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}=== CPU Node Setup Complete ===${NC}"
echo "  node_exporter : http://$(hostname -I | awk '{print $1}'):9100/metrics"
echo "  Ollama        : http://$(hostname -I | awk '{print $1}'):11434  (model: ${OLLAMA_MODEL})"
echo "  fsc-worker    : systemctl status fsc-worker"
echo ""
echo "Services:"
systemctl is-active node_exporter && echo "  [✓] node_exporter" || echo "  [✗] node_exporter"
systemctl is-active ollama        && echo "  [✓] ollama"        || echo "  [✗] ollama"
systemctl is-active fsc-worker  2>/dev/null \
  && echo "  [✓] fsc-worker" || echo "  [~] fsc-worker (pending bun)"
