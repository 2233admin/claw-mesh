# iroh-mesh-proto

Minimal iroh P2P prototype for testing NAT traversal across the claw-mesh cluster.

Uses [iroh](https://github.com/n0-computer/iroh) v0.35 with relay-assisted hole-punching.
Each node gets a persistent Ed25519 identity stored at `~/.config/claw-mesh/node.key`.

## Build

```bash
cargo build --release
# binary: target/release/iroh-mesh-proto
```

## Usage

### 1. Start a listener (on node A)

```bash
cargo run -- listen
# Node ID: <hex-string>
# Home relay: Some("https://...")
# Listening for connections...
```

Copy the printed Node ID.

### 2. Connect from node B

```bash
# Interactive session
cargo run -- connect <NODE_ID_FROM_A>

# One-shot message
cargo run -- send <NODE_ID_FROM_A> "hello from B"
```

### 3. Cross-cluster test (SUPER → 中央)

```bash
# On SUPER (10.10.0.5)
./iroh-mesh-proto listen

# On 中央 (43.163.225.27) — no WireGuard needed, relay handles NAT
./iroh-mesh-proto send <SUPER_NODE_ID> "ping from central"
```

## How it works

```
Node A (behind NAT)          iroh relay             Node B (behind NAT)
     |                           |                        |
     |--- QUIC to relay -------->|<--- QUIC to relay -----|
     |                           |                        |
     |<======= hole-punch attempt via relay =============>|
     |                                                     |
     |<============= direct QUIC (if NAT allows) ========>|
     |  (falls back to relay-proxied if hole-punch fails)  |
```

ALPN: `claw-mesh/0.1` — custom protocol identifier for this mesh.

## API notes for iroh 0.35

Key types and methods used:

| Symbol | Notes |
|--------|-------|
| `Endpoint::builder()` | Entry point |
| `.relay_mode(RelayMode::Default)` | Uses iroh's public relay fleet |
| `.alpns(vec![...])` | Register accepted protocols |
| `.bind().await` | Returns `Endpoint` |
| `endpoint.accept().await` | Returns `Option<Incoming>` |
| `incoming.await` | Completes the handshake → `Connection` |
| `conn.alpn().await` | Negotiated ALPN bytes |
| `conn.remote_node_id()` | Peer's `NodeId` |
| `conn.open_bi()` / `conn.accept_bi()` | Bidirectional QUIC streams |
| `SecretKey::generate(OsRng)` / `::from_bytes()` | Key management |

## Troubleshooting

- **Connection timeout**: relay may be blocked by firewall — open UDP 443 outbound.
- **"invalid key length"**: delete `~/.config/claw-mesh/node.key` and restart.
- **API mismatch**: iroh 0.35 API may differ slightly; check `cargo doc --open` or
  [docs.rs/iroh/0.35](https://docs.rs/iroh/0.35).
