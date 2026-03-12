#!/usr/bin/env bash
# SUPER Node Inference Setup (RTX 5090, 377GB RAM)
# Run as root on 10.10.0.5

set -euo pipefail

echo "=== SUPER Inference Stack Setup ==="

# ─── 1. vLLM (main GPU inference engine) ───
echo "[1/4] Installing vLLM..."
pip install vllm --upgrade 2>/dev/null || pip3 install vllm --upgrade

# Create systemd service for vLLM
cat > /etc/systemd/system/vllm.service << 'EOF'
[Unit]
Description=vLLM Inference Server
After=network.target

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
  --trust-remote-code
Restart=on-failure
RestartSec=10
Environment=CUDA_VISIBLE_DEVICES=0
Environment=HF_HOME=/opt/models

[Install]
WantedBy=multi-user.target
EOF

# ─── 2. SGLang (structured output engine) ───
echo "[2/4] Installing SGLang..."
pip install sglang[all] --upgrade 2>/dev/null || pip3 install sglang[all] --upgrade

cat > /etc/systemd/system/sglang.service << 'EOF'
[Unit]
Description=SGLang Inference Server
After=network.target

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

# ─── 3. LiteLLM Gateway ───
echo "[3/4] Installing LiteLLM..."
pip install 'litellm[proxy]' --upgrade 2>/dev/null || pip3 install 'litellm[proxy]' --upgrade

mkdir -p /opt/litellm
# Config should be copied from deploy/litellm/config.yaml
cat > /etc/systemd/system/litellm.service << 'EOF'
[Unit]
Description=LiteLLM Proxy Gateway
After=network.target vllm.service sglang.service

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

# ─── 4. Directories & model cache ───
echo "[4/4] Setting up directories..."
mkdir -p /opt/inference /opt/models /opt/litellm

echo ""
echo "=== Setup Complete ==="
echo "Services created (not started yet):"
echo "  vllm.service    → port 8000 (GPU inference)"
echo "  sglang.service  → port 8001 (structured output)"
echo "  litellm.service → port 4000 (unified gateway)"
echo ""
echo "To start:"
echo "  systemctl daemon-reload"
echo "  systemctl enable --now vllm sglang litellm"
echo ""
echo "NOTE: vLLM and SGLang share the same GPU."
echo "  Run ONE at a time, or use different CUDA_VISIBLE_DEVICES."
echo "  For A/B testing: stop one, start the other."
