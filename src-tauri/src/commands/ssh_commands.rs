use crate::commands::sftp_file_system_operation_commands::{
    connect_authenticated_ssh_session, resolve_ssh_profile, SshAuthOptions, ZeroizingString,
};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

const MAX_SSH_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024; // 1 MiB cap per stream
static SSH_PTY_COUNTER: AtomicU64 = AtomicU64::new(1);
static ZSTD_PROBE_CACHE: OnceLock<RwLock<HashMap<String, bool>>> = OnceLock::new();
static PTY_SESSIONS: OnceLock<Mutex<HashMap<String, mpsc::Sender<PtyControl>>>> = OnceLock::new();

enum PtyControl {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

#[derive(Debug, Serialize)]
pub struct SshCommandResponse {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
struct SshPtyOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
struct SshPtyExitPayload {
    session_id: String,
    reason: String,
}

fn pty_sessions() -> &'static Mutex<HashMap<String, mpsc::Sender<PtyControl>>> {
    PTY_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn zstd_cache() -> &'static RwLock<HashMap<String, bool>> {
    ZSTD_PROBE_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Escapes a string for POSIX shells using single quotes (`'` -> `'\''`).
pub fn posix_shell_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Returns `true` for file extensions that are already compressed and should skip extra compression.
#[allow(dead_code)]
pub fn is_already_compressed_extension(path: &str) -> bool {
    let lower = path.trim().to_ascii_lowercase();
    const COMPRESSED_EXTS: &[&str] = &[
        ".zip", ".zst", ".gz", ".bz2", ".xz", ".7z", ".rar", ".lz4", ".jpg", ".jpeg", ".png",
        ".webp", ".gif", ".avif", ".mp4", ".mkv", ".avi", ".mov", ".webm", ".mp3", ".aac", ".flac",
        ".ogg", ".pdf", ".dmg", ".deb", ".rpm", ".apk", ".iso",
    ];
    COMPRESSED_EXTS.iter().any(|ext| lower.ends_with(ext))
}

fn validate_remote_path(path: &str) -> Result<&str, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("Invalid remote path".to_string());
    }
    Ok(trimmed)
}

/// Builds a strictly validated shell command to execute under `sudo -S -p ''`.
pub fn build_sudo_operation_command(
    operation: &str,
    path: &str,
    target_path: Option<&str>,
) -> Result<String, String> {
    let trimmed_path = validate_remote_path(path)?;
    let safe_path = posix_shell_quote(trimmed_path);
    match operation.trim() {
        "mkdir" => Ok(format!("mkdir -p -- {safe_path}")),
        "create_file" => Ok(format!("touch -- {safe_path}")),
        "delete_file" => {
            if trimmed_path == "/" || trimmed_path == "." || trimmed_path == ".." {
                return Err("Refusing to delete root or relative directory".to_string());
            }
            Ok(format!("rm -f -- {safe_path}"))
        }
        "delete_dir" => {
            if trimmed_path == "/" || trimmed_path == "." || trimmed_path == ".." {
                return Err("Refusing to delete root or relative directory".to_string());
            }
            Ok(format!("rm -rf -- {safe_path}"))
        }
        "rename" => {
            let dest =
                target_path.ok_or_else(|| "Target path is required for rename".to_string())?;
            let safe_dest = posix_shell_quote(validate_remote_path(dest)?);
            Ok(format!("mv -- {safe_path} {safe_dest}"))
        }
        "read_file" => Ok(format!("cat -- {safe_path}")),
        "write_file" => Ok(format!("tee -- {safe_path} >/dev/null")),
        other => Err(format!("Unsupported sudo operation: {other}")),
    }
}

fn read_channel_stream_capped<R: Read>(mut reader: R, cap: usize) -> Result<String, String> {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let remaining = cap.saturating_sub(out.len());
        if remaining > 0 {
            let take = n.min(remaining);
            out.extend_from_slice(&buf[..take]);
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_execute_command(
    host: String,
    port: u16,
    username: String,
    password: String,
    command: String,
    working_dir: Option<String>,
    auth_type: Option<String>,
    private_key_path: Option<String>,
    certificate_path: Option<String>,
    compression_mode: Option<String>,
) -> Result<String, String> {
    if command.trim().is_empty() {
        return Err("SSH command cannot be empty".to_string());
    }
    let overrides = SshAuthOptions {
        auth_type,
        private_key_path,
        certificate_path,
        compression_mode,
    };

    tokio::task::spawn_blocking(move || {
        let options = resolve_ssh_profile(&host, port, &username, overrides);
        let session =
            connect_authenticated_ssh_session(&host, port, &username, password, &options)?;
        let mut channel = session.channel_session().map_err(|e| e.to_string())?;

        let full_cmd = match working_dir
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty() && *d != ".")
        {
            Some(dir) => format!("cd {} && {}", posix_shell_quote(dir), command),
            None => command,
        };

        channel.exec(&full_cmd).map_err(|e| e.to_string())?;
        let stdout = read_channel_stream_capped(&mut channel, MAX_SSH_COMMAND_OUTPUT_BYTES)?;
        let stderr = read_channel_stream_capped(channel.stderr(), MAX_SSH_COMMAND_OUTPUT_BYTES)?;
        let _ = channel.wait_close();
        let exit_code = channel.exit_status().unwrap_or(0);

        serde_json::to_string(&SshCommandResponse {
            stdout,
            stderr,
            exit_code,
        })
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("SSH command task join error: {e}"))?
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_sudo_exec(
    host: String,
    port: u16,
    username: String,
    password: String,
    sudo_password: String,
    operation: String,
    path: String,
    target_path: Option<String>,
    content: Option<String>,
    auth_type: Option<String>,
    private_key_path: Option<String>,
    certificate_path: Option<String>,
    compression_mode: Option<String>,
) -> Result<String, String> {
    let sudo_secret = ZeroizingString::new(sudo_password);
    if sudo_secret.is_empty() {
        return Err("sudo password cannot be empty".to_string());
    }
    let inner_cmd = build_sudo_operation_command(&operation, &path, target_path.as_deref())?;
    let overrides = SshAuthOptions {
        auth_type,
        private_key_path,
        certificate_path,
        compression_mode,
    };

    tokio::task::spawn_blocking(move || {
        let options = resolve_ssh_profile(&host, port, &username, overrides);
        let session =
            connect_authenticated_ssh_session(&host, port, &username, password, &options)?;
        let mut channel = session.channel_session().map_err(|e| e.to_string())?;

        // Pass sudo password strictly on stdin; never embed it in CLI arguments.
        let sudo_cmd = format!("sudo -S -p '' {inner_cmd}");
        channel.exec(&sudo_cmd).map_err(|e| e.to_string())?;
        channel
            .write_all(sudo_secret.as_str().as_bytes())
            .and_then(|_| channel.write_all(b"\n"))
            .map_err(|e| format!("Failed to send sudo password to stdin: {e}"))?;
        if let Some(body) = content {
            channel
                .write_all(body.as_bytes())
                .map_err(|e| format!("Failed to write content to sudo stdin: {e}"))?;
        }
        let _ = channel.flush();
        let _ = channel.send_eof();

        let stdout = read_channel_stream_capped(&mut channel, MAX_SSH_COMMAND_OUTPUT_BYTES)?;
        let stderr = read_channel_stream_capped(channel.stderr(), MAX_SSH_COMMAND_OUTPUT_BYTES)?;
        let _ = channel.wait_close();
        let exit_code = channel.exit_status().unwrap_or(-1);

        if exit_code != 0 {
            let detail = if stderr.trim().is_empty() {
                format!("sudo operation failed with exit code {exit_code}")
            } else {
                stderr.trim().to_string()
            };
            return Err(detail);
        }

        Ok(stdout)
    })
    .await
    .map_err(|e| format!("SSH sudo task join error: {e}"))?
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_probe_zstd(
    host: String,
    port: u16,
    username: String,
    password: String,
    auth_type: Option<String>,
    private_key_path: Option<String>,
    certificate_path: Option<String>,
) -> Result<bool, String> {
    let cache_key = format!("{}:{port}", host.trim());
    if let Some(&cached) = zstd_cache()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(&cache_key)
    {
        return Ok(cached);
    }

    let overrides = SshAuthOptions {
        auth_type,
        private_key_path,
        certificate_path,
        compression_mode: Some("off".to_string()),
    };

    tokio::task::spawn_blocking(move || {
        let options = resolve_ssh_profile(&host, port, &username, overrides);
        let session =
            connect_authenticated_ssh_session(&host, port, &username, password, &options)?;
        let mut channel = session.channel_session().map_err(|e| e.to_string())?;
        channel
            .exec("command -v zstd >/dev/null 2>&1")
            .map_err(|e| e.to_string())?;
        let _ = channel.wait_close();
        let available = channel.exit_status().unwrap_or(1) == 0;
        zstd_cache()
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(cache_key, available);
        Ok(available)
    })
    .await
    .map_err(|e| format!("SSH probe task join error: {e}"))?
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_start_pty(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    username: String,
    password: String,
    cols: Option<u32>,
    rows: Option<u32>,
    working_dir: Option<String>,
    auth_type: Option<String>,
    private_key_path: Option<String>,
    certificate_path: Option<String>,
    compression_mode: Option<String>,
) -> Result<String, String> {
    let overrides = SshAuthOptions {
        auth_type,
        private_key_path,
        certificate_path,
        compression_mode,
    };
    let options = resolve_ssh_profile(&host, port, &username, overrides);
    let session_id = format!(
        "ssh-pty-{}",
        SSH_PTY_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let (ctrl_tx, ctrl_rx) = mpsc::channel::<PtyControl>();
    let sid_clone = session_id.clone();

    thread::spawn(move || {
        let session =
            match connect_authenticated_ssh_session(&host, port, &username, password, &options) {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };

        let mut channel = match session.channel_session() {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        };

        if let Err(e) = channel.request_pty(
            "xterm-256color",
            None,
            Some((cols.unwrap_or(100), rows.unwrap_or(30), 0, 0)),
        ) {
            let _ = ready_tx.send(Err(e.to_string()));
            return;
        }

        if let Err(e) = channel.shell() {
            let _ = ready_tx.send(Err(e.to_string()));
            return;
        }

        if let Some(dir) = working_dir
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty() && *d != ".")
        {
            let _ = channel.write_all(format!("cd {}\n", posix_shell_quote(dir)).as_bytes());
            let _ = channel.flush();
        }

        session.set_blocking(false);
        let _ = ready_tx.send(Ok(()));

        let mut buf = [0u8; 4096];
        let mut exit_reason = "closed".to_string();

        loop {
            while let Ok(msg) = ctrl_rx.try_recv() {
                match msg {
                    PtyControl::Write(bytes) => {
                        let _ = channel.write_all(&bytes);
                        let _ = channel.flush();
                    }
                    PtyControl::Resize(c, r) => {
                        let _ = channel.request_pty_size(c, r, None, None);
                    }
                    PtyControl::Close => {
                        let _ = channel.close();
                        exit_reason = "closed_by_user".to_string();
                        break;
                    }
                }
            }

            if exit_reason == "closed_by_user" {
                break;
            }

            match channel.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app.emit(
                        "ssh-pty-output",
                        SshPtyOutputPayload {
                            session_id: sid_clone.clone(),
                            data: text,
                        },
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(15));
                }
                Err(e) => {
                    exit_reason = e.to_string();
                    break;
                }
            }

            if channel.eof() {
                break;
            }
        }

        pty_sessions()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&sid_clone);
        let _ = app.emit(
            "ssh-pty-exit",
            SshPtyExitPayload {
                session_id: sid_clone,
                reason: exit_reason,
            },
        );
    });

    match tokio::task::spawn_blocking(move || ready_rx.recv())
        .await
        .map_err(|e| format!("SSH PTY join error: {e}"))?
    {
        Ok(Ok(())) => {
            pty_sessions()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_id.clone(), ctrl_tx);
            Ok(session_id)
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("SSH PTY initialization thread terminated unexpectedly".to_string()),
    }
}

#[tauri::command]
pub fn ssh_write_pty(session_id: String, data: String) -> Result<(), String> {
    let sessions = pty_sessions().lock().unwrap_or_else(|e| e.into_inner());
    let tx = sessions
        .get(session_id.trim())
        .ok_or_else(|| format!("SSH PTY session not found: {session_id}"))?;
    tx.send(PtyControl::Write(data.into_bytes()))
        .map_err(|_| "SSH PTY session is closed".to_string())
}

#[tauri::command]
pub fn ssh_resize_pty(session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    let sessions = pty_sessions().lock().unwrap_or_else(|e| e.into_inner());
    let tx = sessions
        .get(session_id.trim())
        .ok_or_else(|| format!("SSH PTY session not found: {session_id}"))?;
    tx.send(PtyControl::Resize(cols, rows))
        .map_err(|_| "SSH PTY session is closed".to_string())
}

#[tauri::command]
pub fn ssh_close_pty(session_id: String) -> Result<(), String> {
    let tx = pty_sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(session_id.trim());
    if let Some(sender) = tx {
        let _ = sender.send(PtyControl::Close);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_posix_shell_quote_escapes_single_quotes_and_spaces() {
        assert_eq!(posix_shell_quote("/var/log/my file"), "'/var/log/my file'");
        assert_eq!(posix_shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn test_build_sudo_operation_command_validates_and_quotes() {
        assert_eq!(
            build_sudo_operation_command("mkdir", "/etc/my app", None).unwrap(),
            "mkdir -p -- '/etc/my app'"
        );
        assert_eq!(
            build_sudo_operation_command("rename", "/tmp/a'b", Some("/tmp/c d")).unwrap(),
            "mv -- '/tmp/a'\\''b' '/tmp/c d'"
        );
        assert!(build_sudo_operation_command("rm_all", "/tmp", None).is_err());
        assert!(build_sudo_operation_command("mkdir", "", None).is_err());
    }

    #[test]
    fn test_is_already_compressed_extension() {
        assert!(is_already_compressed_extension("/data/archive.tar.zst"));
        assert!(is_already_compressed_extension("photo.JPG"));
        assert!(!is_already_compressed_extension("/var/log/syslog"));
        assert!(!is_already_compressed_extension("disk.img"));
    }
}
