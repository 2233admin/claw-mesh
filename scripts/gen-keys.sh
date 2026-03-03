#!/bin/bash
# WireGuard 密钥对批量生成脚本
# 输入: node数量
# 输出: 每节点wg0.conf

set -e

NODE_COUNT=${1:-3}
WG_PORT=51820
WG_SUBNET="10.0.0.0/24"
OUTPUT_DIR="./configs/wireguard"

mkdir -p "$OUTPUT_DIR"

echo "=== 生成 $NODE_COUNT 个 WireGuard 密钥对 ==="

# 节点 IP 分配
declare -A NODES
NODES=(
  ["central"]="10.0.0.1"
  ["tokyo"]="10.0.0.2"
  ["sv"]="10.0.0.3"
)

# 生成每个节点的密钥和配置
for node in "${!NODES[@]}"; do
  ip=${NODES[$node]}
  echo "处理节点: $node ($ip)"

  # 生成密钥对
  private_key=$(wg genkey)
  public_key=$(echo "$private_key" | wg pubkey)

  # 保存密钥
  echo "$private_key" > "$OUTPUT_DIR/${node}_private.key"
  echo "$public_key" > "$OUTPUT_DIR/${node}_public.key"
  chmod 600 "$OUTPUT_DIR/${node}_private.key"

  # 生成 wg0.conf
  cat > "$OUTPUT_DIR/${node}_wg0.conf" <<EOF
[Interface]
PrivateKey = $private_key
Address = $ip/24
ListenPort = $WG_PORT
DNS = 8.8.8.8, 8.8.4.4

EOF

  # 添加所有 peer
  for peer_node in "${!NODES[@]}"; do
    if [ "$peer_node" != "$node" ]; then
      peer_ip=${NODES[$peer_node]}
      peer_public_key=$(cat "$OUTPUT_DIR/${peer_node}_public.key")
      cat >> "$OUTPUT_DIR/${node}_wg0.conf" <<EOF
[Peer]
PublicKey = $peer_public_key
AllowedIPs = $peer_ip/32
Endpoint = <PUBLIC_IP_OF_${peer_node}>:$WG_PORT
PersistentKeepalive = 25

EOF
    fi
  done

  echo "✓ $node 配置生成完成"
done

echo ""
echo "=== 配置生成完成 ==="
echo "输出目录: $OUTPUT_DIR"
echo ""
echo "下一步："
echo "1. 在每个节点的 Endpoint 填入公网 IP"
echo "2. 复制 wg0.conf 到 /etc/wireguard/wg0.conf"
echo "3. 启动: wg-quick up wg0"
