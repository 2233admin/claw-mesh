//! File transfer protocol over iroh QUIC.
//!
//! Frame format for a single transfer stream:
//!   [8 bytes: file_size as u64 LE]
//!   [4 bytes: filename_len as u32 LE]
//!   [filename_len bytes: UTF-8 filename]
//!   [8 bytes: start_offset as u64 LE]  -- resume support
//!   [32 bytes: blake3 hash of full file]
//!   [file_data from start_offset onwards]
//!
//! The receiver sends back a 1-byte ACK (0x01) once the hash is verified,
//! or 0x00 followed by a 4-byte error code on failure.
//!
//! ALPN: claw-mesh/transfer/0.1

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use blake3::Hasher;
use indicatif::{ProgressBar, ProgressStyle};
use iroh::{Endpoint, NodeId};
use tokio::fs::{self, File};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};
use tracing::{debug, info, warn};

pub const TRANSFER_ALPN: &[u8] = b"claw-mesh/transfer/0.1";

/// Maximum chunk size for streaming reads/writes (4 MiB).
const CHUNK_SIZE: usize = 4 * 1024 * 1024;

/// Progress callback: (bytes_transferred, total_bytes)
pub type ProgressFn = Arc<dyn Fn(u64, u64) + Send + Sync>;

// ─── Sender ──────────────────────────────────────────────────────────────────

/// Send `file_path` to `target_node_id`.
///
/// Connects with ALPN `claw-mesh/transfer/0.1`, streams the file with the
/// length-prefixed frame format, then waits for the receiver's ACK.
///
/// `resume_offset` allows resuming a partial transfer; pass `0` for a fresh send.
pub async fn send_file(
    endpoint: &Endpoint,
    target_node_id: NodeId,
    file_path: &Path,
    resume_offset: u64,
    progress: Option<ProgressFn>,
) -> Result<()> {
    let meta = fs::metadata(file_path)
        .await
        .with_context(|| format!("cannot stat {}", file_path.display()))?;
    let file_size = meta.len();

    if resume_offset > file_size {
        bail!("resume_offset {} exceeds file size {}", resume_offset, file_size);
    }

    let filename = file_path
        .file_name()
        .context("file_path has no filename component")?
        .to_str()
        .context("filename is not valid UTF-8")?
        .to_owned();

    // Compute blake3 hash of the full file (not just the resumed portion).
    info!("Computing blake3 hash of {}", file_path.display());
    let hash = hash_file(file_path).await?;

    info!("Connecting to {} for file transfer", target_node_id);
    let conn = endpoint
        .connect(target_node_id, TRANSFER_ALPN)
        .await
        .context("failed to connect for transfer")?;

    let (mut send, mut recv) = conn.open_bi().await.context("failed to open bi-stream")?;

    // Write header
    send.write_u64_le(file_size).await?;
    let name_bytes = filename.as_bytes();
    send.write_u32_le(name_bytes.len() as u32).await?;
    send.write_all(name_bytes).await?;
    send.write_u64_le(resume_offset).await?;
    send.write_all(hash.as_bytes()).await?;

    debug!(
        "Header sent: file={} size={} offset={} hash={}",
        filename, file_size, resume_offset, hash.to_hex()
    );

    // Stream file data from resume_offset
    let mut file = File::open(file_path)
        .await
        .with_context(|| format!("failed to open {}", file_path.display()))?;

    if resume_offset > 0 {
        use tokio::io::AsyncSeekExt;
        file.seek(std::io::SeekFrom::Start(resume_offset)).await?;
    }

    let bytes_to_send = file_size - resume_offset;
    let pb = build_progress_bar(bytes_to_send, &filename);
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut sent: u64 = 0;

    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        send.write_all(&buf[..n]).await?;
        sent += n as u64;
        pb.set_position(sent);

        if let Some(ref cb) = progress {
            cb(sent, bytes_to_send);
        }
    }

    send.finish()?;
    pb.finish_with_message("upload complete, awaiting ACK");

    // Read ACK
    let ack = recv.read_u8().await.context("no ACK received")?;
    if ack != 0x01 {
        let code = recv.read_u32_le().await.unwrap_or(0);
        bail!("transfer rejected by receiver: error code {}", code);
    }

    info!("File transfer complete: {} ({} bytes sent)", filename, sent);
    Ok(())
}

// ─── Receiver ────────────────────────────────────────────────────────────────

/// Result of a completed file receive.
#[derive(Debug)]
pub struct ReceivedFile {
    pub filename: String,
    pub saved_path: PathBuf,
    pub file_size: u64,
    pub sender: NodeId,
}

/// Accept one incoming file transfer and save it to `save_dir`.
///
/// Verifies the blake3 checksum before sending ACK. Returns an error
/// and sends a NACK if verification fails.
pub async fn receive_file(
    conn: iroh::endpoint::Connection,
    save_dir: &Path,
    progress: Option<ProgressFn>,
) -> Result<ReceivedFile> {
    let sender = conn.remote_node_id().context("cannot get remote node id")?;
    let (mut send, mut recv) = conn.accept_bi().await.context("failed to accept bi-stream")?;

    // Read header
    let file_size = recv.read_u64_le().await.context("failed to read file_size")?;
    let name_len = recv.read_u32_le().await.context("failed to read filename_len")? as usize;

    if name_len > 1024 {
        bail!("filename_len {} is suspiciously large", name_len);
    }

    let mut name_buf = vec![0u8; name_len];
    recv.read_exact(&mut name_buf)
        .await
        .context("failed to read filename")?;
    let filename = String::from_utf8(name_buf).context("filename is not valid UTF-8")?;

    let resume_offset = recv.read_u64_le().await.context("failed to read resume_offset")?;

    let mut expected_hash_bytes = [0u8; 32];
    recv.read_exact(&mut expected_hash_bytes)
        .await
        .context("failed to read blake3 hash")?;
    let expected_hash = blake3::Hash::from_bytes(expected_hash_bytes);

    debug!(
        "Incoming transfer: file={} size={} offset={} hash={}",
        filename,
        file_size,
        resume_offset,
        expected_hash.to_hex()
    );

    // Sanitise filename — strip any path components to prevent directory traversal
    let safe_name = Path::new(&filename)
        .file_name()
        .context("remote filename has no file component")?
        .to_str()
        .context("remote filename is not valid UTF-8")?
        .to_owned();

    fs::create_dir_all(save_dir)
        .await
        .with_context(|| format!("cannot create save dir {}", save_dir.display()))?;

    let save_path = save_dir.join(&safe_name);

    // Open file at resume_offset
    let file = if resume_offset > 0 && save_path.exists() {
        fs::OpenOptions::new()
            .write(true)
            .open(&save_path)
            .await
            .with_context(|| format!("failed to open {} for resume", save_path.display()))?
    } else {
        fs::File::create(&save_path)
            .await
            .with_context(|| format!("failed to create {}", save_path.display()))?
    };

    let mut writer = BufWriter::new(file);

    if resume_offset > 0 {
        use tokio::io::AsyncSeekExt;
        writer
            .seek(std::io::SeekFrom::Start(resume_offset))
            .await?;
    }

    let bytes_to_receive = file_size - resume_offset;
    let pb = build_progress_bar(bytes_to_receive, &safe_name);
    let mut hasher = Hasher::new();

    // If resuming, hash the already-received portion
    if resume_offset > 0 && save_path.exists() {
        hash_file_partial(&save_path, resume_offset, &mut hasher).await?;
    }

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut received: u64 = 0;

    loop {
        let n = recv.read(&mut buf).await?;
        let n = match n {
            Some(n) if n > 0 => n,
            _ => break,
        };

        writer.write_all(&buf[..n]).await?;
        hasher.update(&buf[..n]);
        received += n as u64;
        pb.set_position(received);

        if let Some(ref cb) = progress {
            cb(received, bytes_to_receive);
        }
    }

    writer.flush().await?;
    pb.finish_with_message("download complete, verifying");

    // Verify checksum
    let actual_hash = hasher.finalize();
    if actual_hash != expected_hash {
        warn!(
            "Checksum mismatch for {}: expected {} got {}",
            safe_name,
            expected_hash.to_hex(),
            actual_hash.to_hex()
        );
        send.write_u8(0x00).await?;
        send.write_u32_le(1u32).await?; // error code 1 = checksum mismatch
        send.finish()?;
        // Remove corrupt partial file
        let _ = fs::remove_file(&save_path).await;
        bail!(
            "checksum mismatch: expected {} got {}",
            expected_hash.to_hex(),
            actual_hash.to_hex()
        );
    }

    // Send ACK
    send.write_u8(0x01).await?;
    send.finish()?;

    info!(
        "Received {} ({} bytes) from {} -> {}",
        safe_name,
        received,
        sender,
        save_path.display()
    );

    Ok(ReceivedFile {
        filename: safe_name,
        saved_path: save_path,
        file_size,
        sender,
    })
}

/// Listen on `endpoint` and accept file transfers into `save_dir` indefinitely.
/// Spawns a task per connection.
pub async fn receive_files_loop(
    endpoint: &Endpoint,
    save_dir: PathBuf,
    progress: Option<ProgressFn>,
) -> Result<()> {
    info!("Listening for file transfers (ALPN: claw-mesh/transfer/0.1)");
    loop {
        let incoming = endpoint
            .accept()
            .await
            .ok_or_else(|| anyhow::anyhow!("endpoint closed"))?;

        let save_dir = save_dir.clone();
        let progress = progress.clone();

        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(c) => c,
                Err(e) => {
                    warn!("Failed to accept connection: {}", e);
                    return;
                }
            };

            match receive_file(conn, &save_dir, progress).await {
                Ok(rf) => {
                    println!(
                        "Saved: {} ({} bytes) from {}",
                        rf.saved_path.display(),
                        rf.file_size,
                        rf.sender,
                    );
                }
                Err(e) => {
                    warn!("Transfer error: {}", e);
                }
            }
        });
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async fn hash_file(path: &Path) -> Result<blake3::Hash> {
    let mut file = File::open(path)
        .await
        .with_context(|| format!("cannot open {} for hashing", path.display()))?;
    let mut hasher = Hasher::new();
    let mut buf = vec![0u8; CHUNK_SIZE];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize())
}

async fn hash_file_partial(path: &Path, len: u64, hasher: &mut Hasher) -> Result<()> {
    let mut file = File::open(path)
        .await
        .with_context(|| format!("cannot open {} for partial hashing", path.display()))?;
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut remaining = len;
    while remaining > 0 {
        let to_read = (remaining as usize).min(CHUNK_SIZE);
        let n = file.read(&mut buf[..to_read]).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(())
}

fn build_progress_bar(total: u64, name: &str) -> ProgressBar {
    let pb = ProgressBar::new(total);
    pb.set_style(
        ProgressStyle::with_template(
            "{msg} [{bar:40.cyan/blue}] {bytes}/{total_bytes} ({bytes_per_sec}, eta {eta})",
        )
        .unwrap_or_else(|_| ProgressStyle::default_bar())
        .progress_chars("=>-"),
    );
    pb.set_message(name.to_owned());
    pb
}
