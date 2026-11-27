use super::pty_io;
use crate::commands::sftp_file_system_operation_commands::{
    connect_authenticated_ssh_session, resolve_ssh_profile, SshAuthOptions, ZeroizingString,
};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, OnceLock, RwLock};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

const MAX_SSH_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024; // 1 MiB cap per stream
static SSH_PTY_COUNTER: AtomicU64 = AtomicU64::new(1);
static ZSTD_PROBE_CACHE: OnceLock<RwLock<HashMap<String, bool>>> = OnceLock::new();
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
        "list_dir" => Ok(format!(
            "find -- {safe_path} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0'"
        )),
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
            if let Err(e) =
                channel.write_all(format!("cd -- {}\n", posix_shell_quote(dir)).as_bytes())
            {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        }

        session.set_blocking(false);
        let (registration, controls) = pty_io::Registration::new(sid_clone.clone());
        if ready_tx.send(Ok(())).is_err() {
            return;
        }

        let mut buf = [0u8; 4096];
        let mut pending_utf8: Vec<u8> = Vec::new();
        let mut pending_resize = None;
        let mut exit_reason = "closed".to_string();

        loop {
            let mut progressed = false;
            {
                let mut control = controls.lock().unwrap_or_else(|e| e.into_inner());
                if control.closed {
                    exit_reason = "closed_by_user".to_string();
                    break;
                }
                // Retry a resize with the same arguments on EAGAIN. New
                // dimensions are coalesced in the control state meanwhile.
                if pending_resize.is_none() && !control.write_blocked {
                    pending_resize = control.resize.take();
                }
                if let Some((cols, rows)) = pending_resize {
                    match channel.request_pty_size(cols, rows, None, None) {
                        Ok(()) => {
                            pending_resize = None;
                            progressed = true;
                        }
                        Err(e) if matches!(e.code(), ssh2::ErrorCode::Session(-37)) => {}
                        Err(e) => {
                            exit_reason = format!("SSH PTY resize failed: {e}");
                            break;
                        }
                    }
                }
                if pending_resize.is_none() {
                    match control.write_next(&mut channel) {
                        Ok(wrote) => progressed |= wrote,
                        Err(e) => {
                            exit_reason = format!("SSH PTY write failed: {e}");
                            break;
                        }
                    }
                }
            }

            // Always give reads a turn, even when the remote write window
            // is exhausted. Do not discard buffered output at remote EOF.
            match channel.read(&mut buf) {
                Ok(0) if channel.eof() => break,
                Ok(0) => {}
                Ok(n) => {
                    progressed = true;
                    pending_utf8.extend_from_slice(&buf[..n]);
                    let text = drain_valid_utf8(&mut pending_utf8);
                    if !text.is_empty() {
                        let _ = app.emit(
                            "ssh-pty-output",
                            SshPtyOutputPayload {
                                session_id: sid_clone.clone(),
                                data: text,
                            },
                        );
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if channel.eof() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    exit_reason = e.to_string();
                    break;
                }
            }

            if !progressed {
                thread::sleep(Duration::from_millis(15));
            }
        }

        drop(registration);
        let _ = channel.close();
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
        Ok(Ok(())) => Ok(session_id),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("SSH PTY initialization thread terminated unexpectedly".to_string()),
    }
}

#[tauri::command]
pub fn ssh_write_pty(session_id: String, data: String) -> Result<(), String> {
    let controls = pty_io::lookup(session_id.trim())?;
    let result = controls
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(data);
    result
}

#[tauri::command]
pub fn ssh_resize_pty(session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("Invalid SSH PTY dimensions".to_string());
    }
    let controls = pty_io::lookup(session_id.trim())?;
    let mut control = controls.lock().unwrap_or_else(|e| e.into_inner());
    if control.closed {
        return Err("SSH PTY session is closed".to_string());
    }
    control.resize = Some((cols, rows));
    Ok(())
}

#[tauri::command]
pub fn ssh_close_pty(session_id: String) -> Result<(), String> {
    pty_io::close(session_id.trim());
    Ok(())
}

fn drain_valid_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(valid) => {
            let out = valid.to_string();
            pending.clear();
            out
        }
        Err(err) => {
            let valid_up_to = err.valid_up_to();
            if err.error_len().is_none() {
                // Incomplete multi-byte UTF-8 sequence at the end of the chunk; keep it for next read.
                let out = std::str::from_utf8(&pending[..valid_up_to])
                    .unwrap_or("")
                    .to_string();
                pending.drain(..valid_up_to);
                out
            } else {
                let out = String::from_utf8_lossy(pending).into_owned();
                pending.clear();
                out
            }
        }
    }
}

/// Opens the native OS terminal emulator (Windows Terminal / cmd / xterm) connected via `ssh`.
#[tauri::command]
pub fn open_external_ssh_terminal(
    host: String,
    port: u16,
    username: String,
    private_key_path: Option<String>,
) -> Result<(), String> {
    let trimmed_host = host.trim();
    let trimmed_user = username.trim();
    if trimmed_host.is_empty()
        || trimmed_host
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '&' | '|' | ';' | '$' | '`' | '"' | '\''))
    {
        return Err("Invalid SSH host for external terminal.".to_string());
    }
    if trimmed_user
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '&' | '|' | ';' | '$' | '`' | '"' | '\''))
    {
        return Err("Invalid SSH username for external terminal.".to_string());
    }
    let target = if trimmed_user.is_empty() {
        trimmed_host.to_string()
    } else {
        format!("{trimmed_user}@{trimmed_host}")
    };
    let port_str = port.to_string();
    let clean_key = private_key_path
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty() && !k.chars().any(|c| matches!(c, '\n' | '\r' | '\0')))
        .map(str::to_string);

    #[cfg(target_os = "windows")]
    {
        let mut wt_args = vec!["ssh".to_string()];
        if let Some(ref key) = clean_key {
            wt_args.push("-i".to_string());
            wt_args.push(key.clone());
        }
        wt_args.extend([target.clone(), "-p".to_string(), port_str.clone()]);

        if std::process::Command::new("wt.exe")
            .args(&wt_args)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        let mut cmd_args = vec!["/c".to_string(), "start".to_string(), "ssh".to_string()];
        if let Some(ref key) = clean_key {
            cmd_args.push("-i".to_string());
            cmd_args.push(key.clone());
        }
        cmd_args.extend([target, "-p".to_string(), port_str]);
        std::process::Command::new("cmd.exe")
            .args(&cmd_args)
            .spawn()
            .map_err(|e| format!("Failed to launch external SSH terminal: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let mut ssh_tail = Vec::new();
        if let Some(ref key) = clean_key {
            ssh_tail.push("-i");
            ssh_tail.push(key.as_str());
        }
        ssh_tail.extend([target.as_str(), "-p", port_str.as_str()]);

        let candidates: Vec<(&str, Vec<&str>)> = vec![
            (
                "x-terminal-emulator",
                [vec!["-e", "ssh"], ssh_tail.clone()].concat(),
            ),
            (
                "gnome-terminal",
                [vec!["--", "ssh"], ssh_tail.clone()].concat(),
            ),
            ("konsole", [vec!["-e", "ssh"], ssh_tail.clone()].concat()),
            ("xterm", [vec!["-e", "ssh"], ssh_tail].concat()),
        ];
        for (bin, args) in candidates {
            if std::process::Command::new(bin).args(&args).spawn().is_ok() {
                return Ok(());
            }
        }
        Err("No supported terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xterm).".to_string())
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (target, port_str, clean_key);
        Err("External SSH terminal launch is only supported on Windows and Linux.".to_string())
    }
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
        assert_eq!(
            build_sudo_operation_command("list_dir", "/mnt/pg/postgresql/15/main", None).unwrap(),
            "find -- '/mnt/pg/postgresql/15/main' -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0'"
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
