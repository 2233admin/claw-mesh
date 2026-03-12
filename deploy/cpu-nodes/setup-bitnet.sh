#!/usr/bin/env bash
# CPU Node Setup: BitNet.cpp + Ollama
# For central (10.10.0.1), silicon-valley (10.10.0.2), tokyo (10.10.0.3)
# These are 2-core/2GB nodes — 1-bit models only

set -euo pipefail

echo "=== CPU Node Inference Setup ==="

# ─── 1. Ollama (already installed on some nodes) ───
if ! command -v ollama &>/dev/null; then
  echo "[1/2] Installing Ollama..."
  curl -fsSL https://ollama.ai/install.sh | sh
else
  echo "[1/2] Ollama already installed"
fi

# Pull lightweight models suitable for 2GB RAM
echo "Pulling lightweight models..."
ollama pull qwen2.5-coder:1.5b  # ~1.2GB, fits in 2GB

# Enable Ollama service on 0.0.0.0 for mesh access
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf << 'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
EOF

systemctl daemon-reload
systemctl enable --now ollama

# ─── 2. BitNet.cpp (1-bit inference revolution) ───
echo "[2/2] Setting up BitNet.cpp..."
if [ ! -d /opt/bitnet-cpp ]; then
  cd /opt
  git clone --depth 1 https://github.com/microsoft/BitNet.git bitnet-cpp
  cd bitnet-cpp
  pip install -r requirements.txt 2>/dev/null || pip3 install -r requirements.txt
  # Build with CMake
  mkdir -p build && cd build
  cmake .. -DCMAKE_BUILD_TYPE=Release
  make -j$(nproc)
  echo "BitNet.cpp built successfully"
else
  echo "BitNet.cpp already installed"
fi

echo ""
echo "=== CPU Node Ready ==="
echo "  Ollama: http://0.0.0.0:11434 (qwen2.5-coder:1.5b)"
echo "  BitNet: /opt/bitnet-cpp/build/"
