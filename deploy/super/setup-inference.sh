#!/usr/bin/env bash
# SUPER Node Inference Setup (RTX 5090, 377GB RAM)
# Run as root on 10.10.0.5
#
# Services:
#   vllm.service    → port 8000 (GPU, speculative decoding)
#   sglang.service  → port 8001 (GPU, structured output)
#   ollama.service  → port 11434 (CPU, small models on 377GB RAM)
#   litellm.service → port 4000 (unified OpenAI-compatible gateway)
#
# NOTE: vLLM and SGLang share the RTX 5090.
#   Use /opt/inference/switch-engine.sh to toggle between them.

set -euo pipefail

echo "=== SUPER Inference Stack Setup ==="

# ─── 1. vLLM (main GPU inference engine + speculative decoding) ───
echo "[1/5] Installing vLLM..."
pip install vllm --upgrade 2>/dev/null || pip3 install vllm --upgrade

# Create systemd service for vLLM
# Speculative decoding config:
#   draft_model  = Qwen/Qwen2.5-0.5B-Instruct (tiny draft, fast token prediction)
#   num_speculative_tokens = 5  (verify 5 tokens per step)
#   --speculative-disable-mqa-scorer  (more stable acceptance rate)
cat > /etc/systemd/system/vllm.service << 'EOF'
[Unit]
Description=vLLM Inference Server (RTX 5090, speculative decoding)
After=network.target
Conflicts=sglang.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/inference
ExecStart=/usr/local/bin/python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-72B-Instruct \
  --port 8000 \
  --tensor-parallel-size 1 \
  --gpu-memory-utilization 0.85 \
  --max-model-len 32768 \
  --enable-prefix-caching \
  --trust-remote-code \
  --speculative-model Qwen/Qwen2.5-0.5B-Instruct \
  --num-speculative-tokens 5 \
  --speculative-disable-mqa-scorer
Restart=on-failure
RestartSec=10
Environment=CUDA_VISIBLE_DEVICES=0
Environment=HF_HOME=/opt/models

[Install]
WantedBy=multi-user.target
EOF

# ─── 2. SGLang (structured output engine) ───
echo "[2/5] Installing SGLang..."
pip install sglang[all] --upgrade 2>/dev/null || pip3 install sglang[all] --upgrade

cat > /etc/systemd/system/sglang.service << 'EOF'
[Unit]
Description=SGLang Inference Server (RTX 5090, structured output)
After=network.target
Conflicts=vllm.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/inference
ExecStart=/usr/local/bin/python -m sglang.launch_server \
  --model-path Qwen/Qwen2.5-72B-Instruct \
  --port 8001 \
  --tp 1 \
  --mem-fraction-static 0.85 \
  --enable-flashinfer \
  --trust-remote-code
Restart=on-failure
RestartSec=10
Environment=CUDA_VISIBLE_DEVICES=0
Environment=HF_HOME=/opt/models

[Install]
WantedBy=multi-user.target
EOF

# ─── 3. Ollama (CPU inference for small models, 377GB RAM) ───
echo "[3/5] Installing Ollama..."
if ! command -v ollama &>/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi

# Override default service to bind on all interfaces and use /opt/models
cat > /etc/systemd/system/ollama.service << 'EOF'
[Unit]
Description=Ollama CPU Inference (small models on 377GB RAM)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/inference
ExecStart=/usr/local/bin/ollama serve
Restart=on-failure
RestartSec=5
# Bind on all interfaces so LiteLLM can reach it
Environment=OLLAMA_HOST=0.0.0.0:11434
# Store models alongside other model cache
Environment=OLLAMA_MODELS=/opt/models/ollama
# CPU-only: do not use GPU (leave RTX 5090 for vLLM/SGLang)
Environment=CUDA_VISIBLE_DEVICES=""
# 377GB RAM — allow large context windows
Environment=OLLAMA_MAX_LOADED_MODELS=3
Environment=OLLAMA_NUM_PARALLEL=4

[Install]
WantedBy=multi-user.target
EOF

# Pull useful small models after service starts (non-blocking comment for operator)
cat >> /opt/inference/README.md << 'OLLAMAEOF' 2>/dev/null || true
## Ollama CPU models (pull after starting ollama.service)
  ollama pull qwen2.5:7b          # general purpose
  ollama pull qwen2.5-coder:7b    # code tasks
  ollama pull nomic-embed-text    # embeddings
OLLAMAEOF

# ─── 4. LiteLLM Gateway ───
echo "[4/5] Installing LiteLLM..."
pip install 'litellm[proxy]' --upgrade 2>/dev/null || pip3 install 'litellm[proxy]' --upgrade

mkdir -p /opt/litellm
# Config should be copied from deploy/litellm/config.yaml
cat > /etc/systemd/system/litellm.service << 'EOF'
[Unit]
Description=LiteLLM Proxy Gateway
After=network.target vllm.service ollama.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/litellm
ExecStart=/usr/local/bin/litellm --config /opt/litellm/config.yaml --port 4000 --num_workers 4
Restart=on-failure
RestartSec=5
Environment=LITELLM_MASTER_KEY=sk-claw-mesh-litellm-2026
Environment=REDIS_HOST=10.10.0.1
Environment=REDIS_PORT=6379
Environment=REDIS_PASSWORD=fsc-mesh-2026

[Install]
WantedBy=multi-user.target
EOF

# ─── 5. Directories & helper scripts ───
echo "[5/5] Setting up directories and helper scripts..."
mkdir -p /opt/inference /opt/models /opt/models/ollama /opt/litellm

# ── switch-engine.sh: mutual exclusion between vLLM and SGLang ──
# Both use CUDA_VISIBLE_DEVICES=0 (RTX 5090). Only one can run at a time.
cat > /opt/inference/switch-engine.sh << 'EOF'
#!/usr/bin/env bash
# switch-engine.sh — toggle between vLLM (port 8000) and SGLang (port 8001)
# Usage: switch-engine.sh [vllm|sglang]
# Ollama (CPU, port 11434) is unaffected — runs independently.

set -euo pipefail

usage() {
  echo "Usage: $0 [vllm|sglang]"
  echo "  vllm    Stop SGLang, start vLLM  (port 8000, speculative decoding)"
  echo "  sglang  Stop vLLM,   start SGLang (port 8001, structured output)"
  exit 1
}

[[ $# -ne 1 ]] && usage

TARGET="$1"

case "$TARGET" in
  vllm)
    echo "→ Stopping SGLang..."
    systemctl stop sglang.service || true
    # Wait for GPU VRAM to fully release
    sleep 5
    echo "→ Starting vLLM (with speculative decoding)..."
    systemctl start vllm.service
    echo "✓ vLLM active on port 8000"
    echo "  Draft model: Qwen/Qwen2.5-0.5B-Instruct, speculative tokens: 5"
    ;;
  sglang)
    echo "→ Stopping vLLM..."
    systemctl stop vllm.service || true
    sleep 5
    echo "→ Starting SGLang (structured output)..."
    systemctl start sglang.service
    echo "✓ SGLang active on port 8001"
    ;;
  *)
    usage
    ;;
esac

echo ""
echo "Current GPU engine status:"
systemctl is-active vllm.service   && echo "  vllm.service    ACTIVE  (port 8000)" \
                                    || echo "  vllm.service    stopped"
systemctl is-active sglang.service && echo "  sglang.service  ACTIVE  (port 8001)" \
                                    || echo "  sglang.service  stopped"
systemctl is-active ollama.service && echo "  ollama.service  ACTIVE  (port 11434, CPU)" \
                                    || echo "  ollama.service  stopped"
EOF
chmod +x /opt/inference/switch-engine.sh

# ── health-check.sh: curl all inference endpoints ──
cat > /opt/inference/health-check.sh << 'EOF'
#!/usr/bin/env bash
# health-check.sh — verify all inference services are responding

set -uo pipefail

PASS=0
FAIL=0

check() {
  local name="$1"
  local url="$2"
  local expected="$3"
  local response
  response=$(curl -sf --max-time 5 "$url" 2>/dev/null || echo "")
  if echo "$response" | grep -q "$expected"; then
    echo "  [OK]   $name  →  $url"
    ((PASS++))
  else
    echo "  [FAIL] $name  →  $url  (no response or unexpected)"
    ((FAIL++))
  fi
}

echo "=== Inference Health Check ==="
echo ""

echo "── GPU Engines (only one should be active) ──"
check "vLLM        " "http://localhost:8000/health"       "OK\|{}"
check "SGLang      " "http://localhost:8001/health"       "OK\|{}"

echo ""
echo "── CPU Engine ──"
check "Ollama      " "http://localhost:11434/api/tags"    "models"

echo ""
echo "── Gateway ──"
check "LiteLLM     " "http://localhost:4000/health"       "healthy\|OK"

echo ""
echo "── Caddy (reverse proxy) ──"
check "Caddy admin " "http://localhost:2019/config/"      "apps\|{}"

echo ""
echo "Result: ${PASS} OK, ${FAIL} FAILED"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
EOF
chmod +x /opt/inference/health-check.sh

# ── Caddy reverse proxy snippet ──
# Internal domain: inference.super.claw-mesh (WireGuard mesh, 10.10.0.x)
# Install Caddy: apt install caddy  or  use xcaddy for custom builds
mkdir -p /etc/caddy
cat > /etc/caddy/inference.caddyfile << 'EOF'
# inference.super.claw-mesh — internal Caddy reverse proxy
# Include this in /etc/caddy/Caddyfile:
#   import /etc/caddy/inference.caddyfile
#
# DNS resolution: add to /etc/hosts on all WireGuard nodes:
#   10.10.0.5  inference.super.claw-mesh
#
# Or configure your internal DNS (e.g. CoreDNS on 10.10.0.1).

inference.super.claw-mesh {
  # Unified LiteLLM gateway (OpenAI-compatible)
  # Handles routing to vLLM / SGLang / Ollama based on model name
  reverse_proxy /v1/* localhost:4000

  # Direct vLLM access (GPU, speculative decoding)
  reverse_proxy /vllm/* localhost:8000 {
    header_up X-Engine "vllm"
    rewrite * /v1{path}
  }

  # Direct SGLang access (GPU, structured output)
  reverse_proxy /sglang/* localhost:8001 {
    header_up X-Engine "sglang"
    rewrite * /v1{path}
  }

  # Direct Ollama access (CPU models)
  reverse_proxy /ollama/* localhost:11434 {
    header_up X-Engine "ollama"
    rewrite * /api{path}
  }

  # Health dashboard — returns health of all engines
  handle /health {
    respond `{"vllm":"http://localhost:8000/health","sglang":"http://localhost:8001/health","ollama":"http://localhost:11434/api/tags","litellm":"http://localhost:4000/health"}` 200 {
      header Content-Type application/json
    }
  }

  # TLS: internal only, using self-signed or internal CA
  # tls internal
  log {
    output file /var/log/caddy/inference.log
    format json
  }
}
EOF

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Services registered (not started yet):"
echo "  vllm.service    → port 8000  (GPU, Qwen2.5-72B + speculative decoding)"
echo "  sglang.service  → port 8001  (GPU, Qwen2.5-72B + structured output)"
echo "  ollama.service  → port 11434 (CPU, small models on 377GB RAM)"
echo "  litellm.service → port 4000  (unified OpenAI-compatible gateway)"
echo ""
echo "GPU mutual exclusion: vLLM and SGLang share RTX 5090."
echo "  Default: start vLLM only. Use switch-engine.sh to toggle."
echo ""
echo "To start (recommended order):"
echo "  systemctl daemon-reload"
echo "  systemctl enable --now ollama litellm"
echo "  /opt/inference/switch-engine.sh vllm   # or sglang"
echo ""
echo "After Ollama starts, pull CPU models:"
echo "  ollama pull qwen2.5:7b"
echo "  ollama pull qwen2.5-coder:7b"
echo "  ollama pull nomic-embed-text"
echo ""
echo "Caddy config: /etc/caddy/inference.caddyfile"
echo "  Add 'import /etc/caddy/inference.caddyfile' to /etc/caddy/Caddyfile"
echo "  Add '10.10.0.5  inference.super.claw-mesh' to /etc/hosts on mesh nodes"
echo ""
echo "Health check:"
echo "  /opt/inference/health-check.sh"
echo ""
echo "Switch GPU engine:"
echo "  /opt/inference/switch-engine.sh vllm"
echo "  /opt/inference/switch-engine.sh sglang"
