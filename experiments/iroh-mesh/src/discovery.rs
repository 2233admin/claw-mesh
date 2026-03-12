//! Mesh node discovery via iroh relay.
//!
//! Each node publishes a `NodeCapability` blob to peers it connects to,
//! and maintains a local peer table with heartbeat-based liveness tracking.
//!
//! Discovery flow:
//!   1. On start, `DiscoveryService::run()` spawns a heartbeat loop that
//!      re-announces this node's capabilities every `HEARTBEAT_INTERVAL`.
//!   2. When a peer connects (any ALPN), we exchange capability packets on
//!      a dedicated unidirectional stream on the messaging ALPN.
//!   3. Stale peers (no heartbeat within `PEER_TTL`) are evicted.
//!
//! Capability packets are JSON-encoded `NodeCapability` structs, prefixed
//! with a 4-byte length (u32 LE).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use iroh::{Endpoint, NodeId};
use tokio::io::AsyncReadExt;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio::time;
use tracing::{debug, info, warn};

/// ALPN for the mesh messaging / discovery protocol.
pub const MESH_ALPN: &[u8] = b"claw-mesh/0.1";

/// How often this node re-announces itself to known peers.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// How long before a peer with no heartbeat is considered stale.
const PEER_TTL: Duration = Duration::from_secs(90);

// ─── Capability types ────────────────────────────────────────────────────────

/// GPU info mirroring `GpuInfo` from `packages/core/src/types/device.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    pub name: String,
    pub vendor: String,
    pub vram_mb: u64,
    pub cuda_cores: Option<u32>,
    pub compute_capability: Option<String>,
    pub utilization_pct: f32,
}

/// Capabilities this node publishes to the mesh.
/// Mirrors the relevant fields of `DeviceCapability` in device.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeCapability {
    /// Stable device identifier (UUID).
    pub device_id: String,
    pub hostname: String,
    pub platform: String,    // "linux" | "darwin" | "windows" etc.
    pub arch: String,        // "x86_64" | "aarch64"
    pub cpu_cores: u32,
    pub memory_total_mb: u64,
    pub memory_available_mb: u64,
    pub disk_available_gb: u64,
    pub gpus: Vec<GpuInfo>,
    /// Loaded inference model IDs, e.g. ["qwen2.5-coder:7b"]
    pub inference_models: Vec<String>,
    pub can_serve_inference: bool,
    pub iroh_node_id: String, // base32 iroh NodeId
    pub tags: Vec<String>,
    /// Unix ms — updated on each heartbeat.
    pub last_heartbeat: u64,
}

impl NodeCapability {
    pub fn new(device_id: impl Into<String>, node_id: &NodeId) -> Self {
        Self {
            device_id: device_id.into(),
            hostname: hostname(),
            platform: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            cpu_cores: num_cpus(),
            memory_total_mb: 0,
            memory_available_mb: 0,
            disk_available_gb: 0,
            gpus: vec![],
            inference_models: vec![],
            can_serve_inference: false,
            iroh_node_id: node_id.to_string(),
            tags: vec![],
            last_heartbeat: now_ms(),
        }
    }

    /// Refresh the heartbeat timestamp.
    pub fn touch(&mut self) {
        self.last_heartbeat = now_ms();
    }
}

// ─── Peer table ──────────────────────────────────────────────────────────────

/// An entry in the peer table.
#[derive(Debug, Clone)]
pub struct PeerEntry {
    pub node_id: NodeId,
    pub capability: NodeCapability,
    pub last_seen_ms: u64,
}

/// Thread-safe peer table.
#[derive(Debug, Clone, Default)]
pub struct PeerTable {
    inner: Arc<RwLock<HashMap<NodeId, PeerEntry>>>,
}

impl PeerTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Upsert a peer capability. Returns `true` if this was a new peer.
    pub async fn upsert(&self, node_id: NodeId, cap: NodeCapability) -> bool {
        let mut map = self.inner.write().await;
        let is_new = !map.contains_key(&node_id);
        map.insert(
            node_id,
            PeerEntry {
                node_id,
                capability: cap,
                last_seen_ms: now_ms(),
            },
        );
        is_new
    }

    /// Remove peers whose `last_seen_ms` is older than `PEER_TTL`.
    pub async fn evict_stale(&self) {
        let cutoff = now_ms().saturating_sub(PEER_TTL.as_millis() as u64);
        let mut map = self.inner.write().await;
        let before = map.len();
        map.retain(|_, entry| entry.last_seen_ms >= cutoff);
        let evicted = before - map.len();
        if evicted > 0 {
            debug!("Evicted {} stale peers", evicted);
        }
    }

    /// Snapshot of all live peers.
    pub async fn list(&self) -> Vec<PeerEntry> {
        self.inner.read().await.values().cloned().collect()
    }

    /// Look up a single peer.
    pub async fn get(&self, node_id: &NodeId) -> Option<PeerEntry> {
        self.inner.read().await.get(node_id).cloned()
    }

    pub async fn len(&self) -> usize {
        self.inner.read().await.len()
    }
}

// ─── Discovery service ───────────────────────────────────────────────────────

/// Runs background heartbeat and handles capability exchange.
pub struct DiscoveryService {
    endpoint: Endpoint,
    /// This node's own capability (updated before each heartbeat).
    my_cap: Arc<RwLock<NodeCapability>>,
    pub peers: PeerTable,
}

impl DiscoveryService {
    pub fn new(endpoint: Endpoint, my_cap: NodeCapability) -> Self {
        Self {
            endpoint,
            my_cap: Arc::new(RwLock::new(my_cap)),
            peers: PeerTable::new(),
        }
    }

    /// Update this node's capability (e.g. after GPU state changes).
    pub async fn update_capability(&self, cap: NodeCapability) {
        *self.my_cap.write().await = cap;
    }

    /// Announce this node's capability to `target`. Fire-and-forget.
    pub async fn announce_to(&self, target: NodeId) -> Result<()> {
        let cap = {
            let mut c = self.my_cap.write().await;
            c.touch();
            c.clone()
        };

        let payload = encode_capability(&cap)?;
        let conn = self
            .endpoint
            .connect(target, MESH_ALPN)
            .await
            .with_context(|| format!("announce_to: connect to {} failed", target))?;

        let mut send = conn.open_uni().await.context("open_uni failed")?;
        send.write_all(&payload).await?;
        send.finish()?;

        debug!("Announced capabilities to {}", target);
        Ok(())
    }

    /// Handle an inbound unidirectional capability stream from a connected peer.
    pub async fn handle_incoming_cap(
        &self,
        node_id: NodeId,
        mut recv: iroh::endpoint::RecvStream,
    ) -> Result<()> {
        let len = recv.read_u32_le().await.context("read cap len")? as usize;
        if len > 64 * 1024 {
            anyhow::bail!("capability packet too large: {} bytes", len);
        }
        let mut buf = vec![0u8; len];
        recv.read_exact(&mut buf).await.context("read cap body")?;

        let cap: NodeCapability =
            serde_json::from_slice(&buf).context("deserialize NodeCapability")?;

        let is_new = self.peers.upsert(node_id, cap.clone()).await;
        if is_new {
            info!(
                "New peer: {} ({} @ {})",
                node_id, cap.device_id, cap.hostname
            );
        } else {
            debug!("Heartbeat from {} ({})", node_id, cap.device_id);
        }
        Ok(())
    }

    /// Start the heartbeat loop. This future runs until the endpoint closes.
    ///
    /// Pass a list of seed peer NodeIds to announce to on startup; new peers
    /// are added to the peer table via `handle_incoming_cap`.
    pub async fn run(&self, seed_peers: Vec<NodeId>) -> Result<()> {
        // Announce to seed peers immediately
        for peer in &seed_peers {
            if let Err(e) = self.announce_to(*peer).await {
                warn!("Initial announce to {} failed: {}", peer, e);
            }
        }

        let mut interval = time::interval(HEARTBEAT_INTERVAL);
        loop {
            interval.tick().await;

            // Evict stale peers
            self.peers.evict_stale().await;

            // Re-announce to all live peers
            let live_peers: Vec<NodeId> =
                self.peers.list().await.into_iter().map(|e| e.node_id).collect();

            debug!(
                "Heartbeat tick: {} live peers",
                live_peers.len()
            );

            for peer in live_peers {
                let svc = DiscoveryServiceHandle {
                    endpoint: self.endpoint.clone(),
                    my_cap: self.my_cap.clone(),
                };
                tokio::spawn(async move {
                    if let Err(e) = svc.announce_to(peer).await {
                        warn!("Heartbeat to {} failed: {}", peer, e);
                    }
                });
            }
        }
    }
}

/// Cheaply clonable handle used inside spawned tasks.
struct DiscoveryServiceHandle {
    endpoint: Endpoint,
    my_cap: Arc<RwLock<NodeCapability>>,
}

impl DiscoveryServiceHandle {
    async fn announce_to(&self, target: NodeId) -> Result<()> {
        let cap = {
            let mut c = self.my_cap.write().await;
            c.touch();
            c.clone()
        };

        let payload = encode_capability(&cap)?;
        let conn = self
            .endpoint
            .connect(target, MESH_ALPN)
            .await
            .with_context(|| format!("announce_to handle: connect to {} failed", target))?;

        let mut send = conn.open_uni().await.context("open_uni failed")?;
        send.write_all(&payload).await?;
        send.finish()?;
        Ok(())
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Encode a `NodeCapability` as a length-prefixed JSON blob.
pub fn encode_capability(cap: &NodeCapability) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(cap).context("serialize NodeCapability")?;
    let len = json.len() as u32;
    let mut out = Vec::with_capacity(4 + json.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&json);
    Ok(out)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_owned())
}

fn num_cpus() -> u32 {
    // std doesn't expose this directly; fall back to 1 if unavailable.
    // In production, replace with the `num_cpus` crate.
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1)
}
