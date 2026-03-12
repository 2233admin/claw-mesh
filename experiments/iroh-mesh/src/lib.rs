//! iroh-mesh-proto — production library crate.
//!
//! Exposes the file-transfer and discovery modules and a high-level
//! `MeshNode` struct that wires them together.

pub mod discovery;
pub mod transfer;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use iroh::{Endpoint, NodeId, RelayMode, SecretKey};
use tracing::info;

pub use discovery::{NodeCapability, PeerEntry, PeerTable};
pub use transfer::{ProgressFn, ReceivedFile, TRANSFER_ALPN};

// ─── MeshNode ────────────────────────────────────────────────────────────────

/// High-level handle for a claw-mesh iroh node.
///
/// Combines an iroh `Endpoint` with the discovery peer table and exposes
/// the file-transfer API.
///
/// ```no_run
/// # use iroh_mesh_proto::{MeshNode, NodeCapability};
/// # tokio_test::block_on(async {
/// let node = MeshNode::new(None, NodeCapability::new("my-device", &todo!())).await?;
/// println!("Node ID: {}", node.node_id());
/// # anyhow::Ok(())
/// # });
/// ```
pub struct MeshNode {
    pub endpoint: Endpoint,
    pub peers: PeerTable,
    discovery: Arc<discovery::DiscoveryService>,
}

impl MeshNode {
    /// Create a new `MeshNode`.
    ///
    /// `secret_key_path` — path to persist the 32-byte secret key. If `None`
    /// a default path under the OS config dir is used. The key is generated
    /// on first run and reused on subsequent runs.
    pub async fn new(
        secret_key_path: Option<PathBuf>,
        capability: NodeCapability,
    ) -> Result<Self> {
        let key_path = secret_key_path.unwrap_or_else(default_key_path);
        let secret_key = load_or_create_key(&key_path).await?;

        let endpoint = Endpoint::builder()
            .secret_key(secret_key)
            .alpns(vec![
                discovery::MESH_ALPN.to_vec(),
                TRANSFER_ALPN.to_vec(),
            ])
            .relay_mode(RelayMode::Default)
            .bind()
            .await
            .context("failed to bind iroh endpoint")?;

        info!("MeshNode started: {}", endpoint.node_id());

        let discovery = Arc::new(discovery::DiscoveryService::new(
            endpoint.clone(),
            capability,
        ));

        Ok(Self {
            endpoint,
            peers: discovery.peers.clone(),
            discovery,
        })
    }

    /// This node's iroh `NodeId`.
    pub fn node_id(&self) -> NodeId {
        self.endpoint.node_id()
    }

    // ─── Discovery ───────────────────────────────────────────────────────────

    /// Start the background heartbeat / discovery loop.
    ///
    /// `seed_peers` — initial peer NodeIds to announce to (can be empty).
    /// Returns a `JoinHandle`; drop it (or abort) to stop discovery.
    pub fn start_discovery(
        &self,
        seed_peers: Vec<NodeId>,
    ) -> tokio::task::JoinHandle<Result<()>> {
        let svc = self.discovery.clone();
        tokio::spawn(async move { svc.run(seed_peers).await })
    }

    /// Update this node's published capability (e.g. after loading a new model).
    pub async fn update_capability(&self, cap: NodeCapability) {
        self.discovery.update_capability(cap).await;
    }

    /// Snapshot of all currently known live peers.
    pub async fn discover_peers(&self) -> Vec<PeerEntry> {
        self.peers.list().await
    }

    // ─── File transfer ───────────────────────────────────────────────────────

    /// Send a file to a peer node.
    ///
    /// `resume_offset` — byte offset to start from (0 for a fresh send).
    /// `progress` — optional callback `(bytes_sent, total_bytes)`.
    pub async fn send_file(
        &self,
        target: NodeId,
        file_path: &Path,
        resume_offset: u64,
        progress: Option<ProgressFn>,
    ) -> Result<()> {
        transfer::send_file(&self.endpoint, target, file_path, resume_offset, progress).await
    }

    /// Accept incoming file transfers in a loop, saving to `save_dir`.
    ///
    /// This future runs indefinitely. Run it in a spawned task.
    pub async fn receive_files(&self, save_dir: PathBuf) -> Result<()> {
        transfer::receive_files_loop(&self.endpoint, save_dir, None).await
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn default_key_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claw-mesh")
        .join("node.key")
}

async fn load_or_create_key(path: &Path) -> Result<SecretKey> {
    if path.exists() {
        let bytes = tokio::fs::read(path)
            .await
            .with_context(|| format!("failed to read key from {}", path.display()))?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid key length in {}", path.display()))?;
        Ok(SecretKey::from_bytes(&bytes))
    } else {
        let key = SecretKey::generate(rand::rngs::OsRng);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("cannot create key dir {}", parent.display()))?;
        }
        tokio::fs::write(path, key.to_bytes())
            .await
            .with_context(|| format!("failed to write key to {}", path.display()))?;
        info!("Generated new node key at {}", path.display());
        Ok(key)
    }
}
