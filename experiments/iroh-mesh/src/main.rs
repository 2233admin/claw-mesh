//! iroh-mesh CLI
//!
//! Usage:
//!   cargo run -- listen
//!   cargo run -- connect <NODE_ID>
//!   cargo run -- send <NODE_ID> "hello"
//!   cargo run -- send-file <NODE_ID> <FILE_PATH> [--offset <BYTES>]
//!   cargo run -- receive-files [--dir <SAVE_DIR>]

mod discovery;
mod transfer;

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use tokio::io::AsyncReadExt;
use iroh::{Endpoint, NodeId, RelayMode, SecretKey};
use tracing::warn;
use tracing_subscriber::EnvFilter;

use discovery::{DiscoveryService, NodeCapability, MESH_ALPN};
use transfer::TRANSFER_ALPN;

#[derive(Parser)]
#[command(name = "iroh-mesh", about = "claw-mesh iroh P2P node")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Start listening for mesh connections (messaging ALPN)
    Listen,

    /// Connect to a remote node and exchange messages interactively
    Connect {
        /// Remote node ID (hex/base32 string)
        node_id: String,
    },

    /// Send a one-shot message to a node
    Send {
        node_id: String,
        message: String,
    },

    /// Send a file to a peer node over QUIC
    SendFile {
        /// Target node ID
        node_id: String,
        /// Path to the file to send
        file_path: PathBuf,
        /// Resume from this byte offset (default: 0)
        #[arg(long, default_value_t = 0)]
        offset: u64,
    },

    /// Listen for incoming file transfers
    ReceiveFiles {
        /// Directory to save received files (default: ./received)
        #[arg(long, default_value = "received")]
        dir: PathBuf,
    },

    /// Show this node's ID and relay info
    Info,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse();

    let key_path = dirs::config_dir()
        .unwrap_or_default()
        .join("claw-mesh")
        .join("node.key");

    let secret_key = load_or_create_key(&key_path)?;

    // Both ALPNs registered on the same endpoint so one process can handle both.
    let endpoint = Endpoint::builder()
        .secret_key(secret_key)
        .alpns(vec![MESH_ALPN.to_vec(), TRANSFER_ALPN.to_vec()])
        .relay_mode(RelayMode::Default)
        .bind()
        .await?;

    let my_node_id = endpoint.node_id();
    println!("Node ID  : {}", my_node_id);
    println!("Home relay: {:?}", endpoint.home_relay());

    match cli.command {
        // ── Info ─────────────────────────────────────────────────────────────
        Command::Info => {
            // Already printed above.
        }

        // ── Listen (messaging) ───────────────────────────────────────────────
        Command::Listen => {
            println!("Listening for mesh connections...");
            loop {
                let incoming = endpoint
                    .accept()
                    .await
                    .ok_or_else(|| anyhow!("endpoint closed"))?;

                tokio::spawn(async move {
                    let conn = match incoming.await {
                        Ok(c) => c,
                        Err(e) => {
                            warn!("Accept error: {}", e);
                            return;
                        }
                    };
                    let alpn = conn.alpn();
                    let alpn_str = alpn
                        .as_deref()
                        .map(String::from_utf8_lossy)
                        .map(|s| s.into_owned())
                        .unwrap_or_default();

                    match alpn_str.as_str() {
                        "claw-mesh/0.1" => {
                            if let Err(e) = handle_mesh_connection(conn).await {
                                warn!("Mesh connection error: {}", e);
                            }
                        }
                        other => {
                            warn!("Unexpected ALPN on listen: {}", other);
                        }
                    }
                });
            }
        }

        // ── Connect (interactive) ────────────────────────────────────────────
        Command::Connect { node_id } => {
            let node_id = NodeId::from_str(&node_id)?;
            println!("Connecting to {}...", node_id);

            let conn = endpoint.connect(node_id, MESH_ALPN).await?;
            println!("Connected! Type messages and press Enter (Ctrl+C to quit):");

            let (mut send, mut recv) = conn.open_bi().await?;

            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                loop {
                    match recv.read(&mut buf).await {
                        Ok(Some(n)) => {
                            let msg = String::from_utf8_lossy(&buf[..n]);
                            println!("< {}", msg);
                        }
                        Ok(None) => {
                            println!("Remote closed stream.");
                            break;
                        }
                        Err(e) => {
                            warn!("Read error: {}", e);
                            break;
                        }
                    }
                }
            });

            let mut line = String::new();
            loop {
                line.clear();
                std::io::stdin().read_line(&mut line)?;
                let msg = line.trim();
                if msg.is_empty() {
                    continue;
                }
                send.write_all(msg.as_bytes()).await?;
            }
        }

        // ── Send (one-shot message) ───────────────────────────────────────────
        Command::Send { node_id, message } => {
            let node_id = NodeId::from_str(&node_id)?;
            println!("Sending to {}...", node_id);

            let conn = endpoint.connect(node_id, MESH_ALPN).await?;
            let (mut send, mut recv) = conn.open_bi().await?;

            send.write_all(message.as_bytes()).await?;
            send.finish()?;

            let data = recv.read_to_end(1024 * 1024).await?;
            if !data.is_empty() {
                println!("Response: {}", String::from_utf8_lossy(&data));
            }
            println!("Sent successfully.");
        }

        // ── Send file ────────────────────────────────────────────────────────
        Command::SendFile {
            node_id,
            file_path,
            offset,
        } => {
            let node_id = NodeId::from_str(&node_id)?;
            println!(
                "Sending {} to {} (offset={})...",
                file_path.display(),
                node_id,
                offset
            );

            let progress: transfer::ProgressFn = Arc::new(|sent, total| {
                // indicatif handles display; this callback is available for
                // additional integrations (e.g. Redis progress key).
                let _ = (sent, total);
            });

            transfer::send_file(&endpoint, node_id, &file_path, offset, Some(progress)).await?;
            println!("Transfer complete.");
        }

        // ── Receive files ─────────────────────────────────────────────────────
        Command::ReceiveFiles { dir } => {
            println!(
                "Receiving files, saving to {}",
                dir.display()
            );
            println!("Share this Node ID with senders: {}", my_node_id);

            // Build a minimal capability for discovery side-channel
            let my_cap = NodeCapability::new(my_node_id.to_string(), &my_node_id);
            let discovery = DiscoveryService::new(endpoint.clone(), my_cap);

            // Accept loop: route by ALPN
            loop {
                let incoming = endpoint
                    .accept()
                    .await
                    .ok_or_else(|| anyhow!("endpoint closed"))?;

                let save_dir = dir.clone();
                let disc_peers = discovery.peers.clone();

                tokio::spawn(async move {
                    let conn = match incoming.await {
                        Ok(c) => c,
                        Err(e) => {
                            warn!("Accept error: {}", e);
                            return;
                        }
                    };

                    let alpn = conn.alpn();
                    let alpn_str = alpn
                        .as_deref()
                        .map(String::from_utf8_lossy)
                        .map(|s| s.into_owned())
                        .unwrap_or_default();

                    match alpn_str.as_str() {
                        "claw-mesh/transfer/0.1" => {
                            match transfer::receive_file(conn, &save_dir, None).await {
                                Ok(rf) => println!(
                                    "Saved: {} ({} bytes) from {}",
                                    rf.saved_path.display(),
                                    rf.file_size,
                                    rf.sender,
                                ),
                                Err(e) => warn!("Transfer error: {}", e),
                            }
                        }
                        "claw-mesh/0.1" => {
                            // Could be a capability heartbeat uni-stream
                            if let Ok(remote_id) = conn.remote_node_id() {
                                // Accept uni streams for capability exchange
                                while let Ok(recv) = conn.accept_uni().await {
                                    let node_id = remote_id;
                                    let peers = disc_peers.clone();
                                    tokio::spawn(async move {
                                        let len = {
                                            let mut r = recv;
                                            match r.read_u32_le().await {
                                                Ok(l) => l as usize,
                                                Err(_) => return,
                                            }
                                        };
                                        let _ = (len, node_id, peers);
                                    });
                                }
                            }
                        }
                        other => warn!("Unknown ALPN: {}", other),
                    }
                });
            }
        }
    }

    Ok(())
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn load_or_create_key(path: &std::path::Path) -> Result<SecretKey> {
    if path.exists() {
        let bytes = std::fs::read(path)?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow!("invalid key length"))?;
        Ok(SecretKey::from_bytes(&bytes))
    } else {
        let key = SecretKey::generate(rand::rngs::OsRng);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, key.to_bytes())?;
        Ok(key)
    }
}

async fn handle_mesh_connection(conn: iroh::endpoint::Connection) -> Result<()> {
    loop {
        let (mut send, mut recv) = match conn.accept_bi().await {
            Ok(s) => s,
            Err(_) => break,
        };

        let mut buf = vec![0u8; 4096];
        match recv.read(&mut buf).await? {
            Some(n) => {
                let msg = String::from_utf8_lossy(&buf[..n]);
                println!("Received: {}", msg);

                let response = format!("ACK from {}: {}", conn.remote_node_id()?, msg);
                send.write_all(response.as_bytes()).await?;
                send.finish()?;
            }
            None => break,
        }
    }
    Ok(())
}
