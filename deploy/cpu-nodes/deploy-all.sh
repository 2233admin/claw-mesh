#!/usr/bin/env bash
# deploy-all.sh — Deploy claw-mesh CPU node setup to all 3 nodes
# Nodes: 中央 10.10.0.1, 硅谷 10.10.0.2, 东京 10.10.0.3
# Requires: SSH access via WireGuard IPs (key auth assumed)
#
# Usage:
#   ./deploy-all.sh              # deploy to all nodes
#   ./deploy-all.sh 10.10.0.1   # deploy to single node
#   ./deploy-all.sh --verify     # health check only, no redeploy

set -euo pipefail

# ─── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'

log()     { echo -e "${CYAN}[deploy]${NC} $*"; }
ok()      { echo -e "${GREEN}[ok]${NC}     $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}   $*"; }
fail()    { echo -e "${RED}[fail]${NC}   $*"; }
section() { echo -e "\n${BOLD}${CYAN}── $* ──${NC}"; }

# ─── Node definitions ───────────────────────────────────────────────────────
declare -A NODE_NAMES=(
  ["10.10.0.1"]="中央 (central)"
  ["10.10.0.2"]="硅谷 (silicon-valley)"
  ["10.10.0.3"]="东京 (tokyo)"
)
ALL_NODES=("10.10.0.1" "10.10.0.2" "10.10.0.3")

# ─── SSH config ─────────────────────────────────────────────────────────────
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/id_ed25519}"
SSH_OPTS=(
  -o StrictHostKeyChecking=no
  -o ConnectTimeout=15
  -o BatchMode=yes
  -o ServerAliveInterval=30
  -i "${SSH_KEY}"
)
REMOTE_SCRIPT="/tmp/setup-cpu-node.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_SCRIPT="${SCRIPT_DIR}/setup-cpu-node.sh"

# ─── Helpers ────────────────────────────────────────────────────────────────
ssh_run() {
  local node="$1"; shift
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${node}" "$@"
}

scp_file() {
  local src="$1" node="$2" dst="$3"
  scp "${SSH_OPTS[@]}" "$src" "${SSH_USER}@${node}:${dst}"
}

node_label() {
  echo "${NODE_NAMES[$1]:-$1}"
}

check_reachable() {
  local node="$1"
  ssh_run "$node" "echo ok" &>/dev/null
}

# ─── Health check ───────────────────────────────────────────────────────────
verify_node() {
  local node="$1"
  local label; label="$(node_label "$node")"
  local ok=0 fail_reasons=()

  log "Verifying ${label} (${node})..."

  # node_exporter
  if ssh_run "$node" "curl -sf http://localhost:9100/metrics | grep -q node_cpu" 2>/dev/null; then
    ok "  node_exporter :9100 — metrics OK"
  else
    fail "  node_exporter :9100 — NOT responding"
    fail_reasons+=("node_exporter")
    ((ok++)) || true
  fi

  # Ollama API
  if ssh_run "$node" "curl -sf http://localhost:11434/api/tags" &>/dev/null; then
    ok "  Ollama :11434 — API OK"
  else
    fail "  Ollama :11434 — NOT responding"
    fail_reasons+=("ollama")
    ((ok++)) || true
  fi

  # Ollama model
  if ssh_run "$node" "ollama list 2>/dev/null | grep -q qwen2.5-coder" 2>/dev/null; then
    ok "  Model qwen2.5-coder:1.5b — present"
  else
    warn "  Model qwen2.5-coder:1.5b — not found (may still be pulling)"
    fail_reasons+=("model")
  fi

  # fsc-worker service exists
  if ssh_run "$node" "systemctl is-enabled fsc-worker &>/dev/null" 2>/dev/null; then
    local state
    state=$(ssh_run "$node" "systemctl is-active fsc-worker 2>/dev/null || echo inactive")
    ok "  fsc-worker — ${state}"
  else
    warn "  fsc-worker — not enabled"
    fail_reasons+=("fsc-worker")
  fi

  if [ ${#fail_reasons[@]} -eq 0 ]; then
    ok "${label} — ALL CHECKS PASSED"
    return 0
  else
    fail "${label} — ${#fail_reasons[@]} check(s) failed: ${fail_reasons[*]}"
    return 1
  fi
}

# ─── Deploy single node ─────────────────────────────────────────────────────
deploy_node() {
  local node="$1"
  local label; label="$(node_label "$node")"

  section "Deploying to ${label} (${node})"

  # Connectivity check
  log "Checking SSH connectivity..."
  if ! check_reachable "$node"; then
    fail "Cannot reach ${node} — skipping"
    return 1
  fi
  ok "SSH reachable"

  # Copy setup script
  log "Copying setup-cpu-node.sh..."
  scp_file "${LOCAL_SCRIPT}" "$node" "${REMOTE_SCRIPT}"
  ssh_run "$node" "chmod +x ${REMOTE_SCRIPT}"
  ok "Script copied"

  # Execute (tee to remote log for post-mortem)
  log "Running setup (this may take several minutes for model pull)..."
  ssh_run "$node" "bash ${REMOTE_SCRIPT} 2>&1 | tee /var/log/claw-mesh-setup.log"
  ok "Setup script completed on ${label}"

  # Brief settle time then verify
  sleep 3
  verify_node "$node"
}

# ─── Parse args ─────────────────────────────────────────────────────────────
VERIFY_ONLY=false
TARGET_NODES=("${ALL_NODES[@]}")

for arg in "${@:-}"; do
  case "$arg" in
    --verify|-v)
      VERIFY_ONLY=true
      ;;
    10.10.0.*)
      TARGET_NODES=("$arg")
      ;;
    --help|-h)
      echo "Usage: $0 [--verify] [10.10.0.X]"
      echo "  --verify     health-check only, no deployment"
      echo "  10.10.0.X    target single node"
      exit 0
      ;;
  esac
done

# ─── Preflight ──────────────────────────────────────────────────────────────
section "Preflight"

[ -f "${LOCAL_SCRIPT}" ] || { fail "setup-cpu-node.sh not found at ${LOCAL_SCRIPT}"; exit 1; }
[ -f "${SSH_KEY}" ]      || { warn "SSH key ${SSH_KEY} not found — trying default agent"; }

log "Mode         : $( $VERIFY_ONLY && echo 'VERIFY ONLY' || echo 'DEPLOY + VERIFY' )"
log "Target nodes : ${TARGET_NODES[*]}"
log "SSH user     : ${SSH_USER}"
log "SSH key      : ${SSH_KEY}"

# ─── Main loop ──────────────────────────────────────────────────────────────
PASS=()
FAIL=()

for node in "${TARGET_NODES[@]}"; do
  label="$(node_label "$node")"
  if $VERIFY_ONLY; then
    if verify_node "$node"; then
      PASS+=("${node} (${label})")
    else
      FAIL+=("${node} (${label})")
    fi
  else
    if deploy_node "$node"; then
      PASS+=("${node} (${label})")
    else
      FAIL+=("${node} (${label})")
    fi
  fi
done

# ─── Summary ────────────────────────────────────────────────────────────────
section "Deployment Summary"

if [ ${#PASS[@]} -gt 0 ]; then
  ok "PASSED (${#PASS[@]}):"
  for n in "${PASS[@]}"; do echo "    [✓] $n"; done
fi

if [ ${#FAIL[@]} -gt 0 ]; then
  fail "FAILED (${#FAIL[@]}):"
  for n in "${FAIL[@]}"; do echo "    [✗] $n"; done
  echo ""
  echo "Re-run failed nodes individually:"
  for n in "${FAIL[@]}"; do
    ip="${n%% *}"
    echo "  $0 ${ip}"
  done
  exit 1
fi

echo ""
ok "All ${#PASS[@]} node(s) healthy."
echo ""
echo "Quick checks from this machine (requires WireGuard active):"
for node in "${TARGET_NODES[@]}"; do
  echo "  curl -s http://${node}:9100/metrics | grep node_cpu_seconds | head -2"
  echo "  curl -s http://${node}:11434/api/tags | python3 -m json.tool"
done
