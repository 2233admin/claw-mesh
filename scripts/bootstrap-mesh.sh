#!/usr/bin/env bash
set -euo pipefail

# ============================================
# FSC Worker + WireGuard Mesh Bootstrap Script
# Version: 0.2.0
# ============================================
# 
# 功能：
# - 配置 WireGuard 全网状 VPN
# - 设置 iptables NAT 规则（Docker 容器访问 WireGuard）
# - 配置 systemd 服务（wg-quick 自动重启）
# - 部署 FSC Worker Daemon
# - 幂等性：多次执行不报错
#
# 使用：
#   ./bootstrap-mesh.sh <node_id> <node_ip> <private_key>
#
# 示例：
#   ./bootstrap-mesh.sh 1 10.10.0.1 "$(wg genkey)"
#
# ============================================

# ============ 参数检查 ============
if [ $# -lt 3 ]; then
  echo "Usage: $0 <node_id> <node_ip> <private_key>"
  echo "Example: $0 1 10.10.0.1 \"\$(wg genkey)\""
  exit 1
fi

NODE_ID=$1
NODE_IP=$2
PRIVATE_KEY=$3

# ============ 配置变量 ============
WG_INTERFACE="wg0"
WG_PORT=51820
WG_MTU=1420
WG_KEEPALIVE=25
SUBNET="10.10.0.0/24"

# 节点配置（根据实际情况修改）
declare -A NODES
NODES[1]="10.10.0.1"
NODES[2]="10.10.0.2"
NODES[3]="10.10.0.3"

# ============ 颜色输出 ============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# ============ 检查依赖 ============
check_dependencies() {
  log_info "Checking dependencies..."
  
  local missing=()
  
  for cmd in wg wg-quick iptables systemctl docker bun; do
    if ! command -v $cmd &> /dev/null; then
      missing+=($cmd)
    fi
  done
  
  if [ ${#missing[@]} -gt 0 ]; then
    log_error "Missing dependencies: ${missing[*]}"
    log_info "Install with: yum install -y wireguard-tools iptables docker bun"
    exit 1
  fi
  
  log_info "All dependencies satisfied"
}

# ============ 生成 WireGuard 配置 ============
generate_wg_config() {
  log_info "Generating WireGuard config for node ${NODE_ID}..."
  
  local config_file="/etc/wireguard/${WG_INTERFACE}.conf"
  
  # 备份现有配置
  if [ -f "$config_file" ]; then
    log_warn "Config already exists, backing up to ${config_file}.bak"
    cp "$config_file" "${config_file}.bak"
  fi
  
  # 生成配置
  cat > "$config_file" << EOF
[Interface]
PrivateKey = ${PRIVATE_KEY}
Address = ${NODE_IP}/24
ListenPort = ${WG_PORT}
MTU = ${WG_MTU}

# iptables 规则：允许 Docker 容器通过 WireGuard 访问其他节点
PostUp = iptables -A FORWARD -i ${WG_INTERFACE} -j ACCEPT
PostUp = iptables -t nat -A POSTROUTING -o docker0 -j MASQUERADE
PostDown = iptables -D FORWARD -i ${WG_INTERFACE} -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o docker0 -j MASQUERADE

EOF

  # 添加 Peer 配置（全网状）
  for peer_id in "${!NODES[@]}"; do
    if [ "$peer_id" != "$NODE_ID" ]; then
      local peer_ip="${NODES[$peer_id]}"
      local peer_pubkey="<PEER_${peer_id}_PUBLIC_KEY>"  # 需要手动替换
      
      cat >> "$config_file" << EOF
# Peer ${peer_id}
[Peer]
PublicKey = ${peer_pubkey}
AllowedIPs = ${peer_ip}/32
PersistentKeepalive = ${WG_KEEPALIVE}

EOF
    fi
  done
  
  chmod 600 "$config_file"
  log_info "WireGuard config generated: $config_file"
  log_warn "Remember to replace <PEER_X_PUBLIC_KEY> with actual public keys!"
}

# ============ 配置 systemd override ============
configure_systemd() {
  log_info "Configuring systemd overrides..."
  
  local override_dir="/etc/systemd/system/wg-quick@${WG_INTERFACE}.service.d"
  local override_file="${override_dir}/override.conf"
  
  mkdir -p "$override_dir"
  
  cat > "$override_file" << 'EOF'
[Service]
Restart=always
RestartSec=5
EOF

  log_info "systemd override configured: $override_file"
}

# ============ 创建 FSC Worker 服务 ============
create_fsc_service() {
  log_info "Creating FSC Worker systemd service..."
  
  local service_file="/etc/systemd/system/fsc-worker@.service"
  
  cat > "$service_file" << 'EOF'
[Unit]
Description=FSC Worker on WireGuard Mesh (Instance %i)
After=network-online.target wg-quick@wg0.service docker.service redis.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/claw-mesh/fsc
ExecStart=/usr/bin/bun run fsc-worker-daemon.ts
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s

# 环境变量
Environment=AGENT_ID=%i
Environment=REDIS_HOST=10.10.0.1
Environment=REDIS_PORT=6379
Environment=MAX_CONCURRENT=10

# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fsc-worker-%i

[Install]
WantedBy=multi-user.target
EOF

  log_info "FSC Worker service created: $service_file"
}

# ============ 部署 FSC Worker 代码 ============
deploy_fsc_code() {
  log_info "Deploying FSC Worker code..."
  
  local deploy_dir="/opt/claw-mesh"
  
  # 创建目录
  mkdir -p "$deploy_dir"
  
  # 复制代码（假设当前目录是 claw-mesh-dev）
  if [ -d "./fsc" ]; then
    cp -r ./fsc "$deploy_dir/"
    log_info "FSC code deployed to $deploy_dir"
  else
    log_warn "FSC code not found in current directory, skipping deployment"
  fi
}

# ============ 启动服务 ============
start_services() {
  log_info "Starting services..."
  
  # Reload systemd
  systemctl daemon-reload
  
  # 启动 WireGuard
  if systemctl is-active --quiet "wg-quick@${WG_INTERFACE}"; then
    log_info "WireGuard already running, restarting..."
    systemctl restart "wg-quick@${WG_INTERFACE}"
  else
    systemctl enable "wg-quick@${WG_INTERFACE}"
    systemctl start "wg-quick@${WG_INTERFACE}"
  fi
  
  # 检查 WireGuard 状态
  if systemctl is-active --quiet "wg-quick@${WG_INTERFACE}"; then
    log_info "WireGuard started successfully"
    wg show
  else
    log_error "WireGuard failed to start"
    systemctl status "wg-quick@${WG_INTERFACE}"
    exit 1
  fi
  
  # 启动 FSC Worker
  local worker_instance="fsc-worker@node${NODE_ID}"
  
  if systemctl is-active --quiet "$worker_instance"; then
    log_info "FSC Worker already running, restarting..."
    systemctl restart "$worker_instance"
  else
    systemctl enable "$worker_instance"
    systemctl start "$worker_instance"
  fi
  
  # 检查 FSC Worker 状态
  if systemctl is-active --quiet "$worker_instance"; then
    log_info "FSC Worker started successfully"
  else
    log_error "FSC Worker failed to start"
    systemctl status "$worker_instance"
    exit 1
  fi
}

# ============ 验证部署 ============
verify_deployment() {
  log_info "Verifying deployment..."
  
  # 检查 WireGuard 接口
  if ip link show "$WG_INTERFACE" &> /dev/null; then
    log_info "✓ WireGuard interface exists"
  else
    log_error "✗ WireGuard interface not found"
    return 1
  fi
  
  # 检查 IP 地址
  if ip addr show "$WG_INTERFACE" | grep -q "$NODE_IP"; then
    log_info "✓ IP address configured: $NODE_IP"
  else
    log_error "✗ IP address not configured"
    return 1
  fi
  
  # 检查 iptables 规则
  if iptables -t nat -L POSTROUTING -n | grep -q "docker0"; then
    log_info "✓ iptables NAT rule exists"
  else
    log_warn "✗ iptables NAT rule not found (may need manual setup)"
  fi
  
  # 检查 FSC Worker 进程
  if pgrep -f "fsc-worker-daemon" &> /dev/null; then
    log_info "✓ FSC Worker process running"
  else
    log_error "✗ FSC Worker process not found"
    return 1
  fi
  
  log_info "Deployment verification complete"
}

# ============ 主流程 ============
main() {
  log_info "Starting FSC Worker + WireGuard Mesh bootstrap..."
  log_info "Node ID: $NODE_ID"
  log_info "Node IP: $NODE_IP"
  
  check_dependencies
  generate_wg_config
  configure_systemd
  create_fsc_service
  deploy_fsc_code
  start_services
  verify_deployment
  
  log_info "Bootstrap complete!"
  log_info "Next steps:"
  log_info "  1. Replace <PEER_X_PUBLIC_KEY> in /etc/wireguard/${WG_INTERFACE}.conf"
  log_info "  2. Restart WireGuard: systemctl restart wg-quick@${WG_INTERFACE}"
  log_info "  3. Test connectivity: ping <peer_ip>"
  log_info "  4. Check FSC Worker logs: journalctl -u fsc-worker@node${NODE_ID} -f"
}

main "$@"
