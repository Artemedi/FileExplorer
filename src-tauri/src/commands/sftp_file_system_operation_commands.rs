use crate::commands::preview_commands::PreviewPayload;
use crate::constants::get_app_base_dir;
use crate::log_info;
use crate::models::SFTPDirectory;
use base64::Engine;
use sha2::{Digest, Sha256};
use ssh2::{FileStat, Session, Sftp};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{compiler_fence, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SFTP_TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SFTP_SSH_SESSION_TIMEOUT_MS: u32 = 30_000;
const MAX_OPEN_FILE_SFTP_BYTES: usize = 10 * 1024 * 1024; // 10 MiB max for text open
const MAX_PREVIEW_IMAGE_BYTES: usize = 6 * 1024 * 1024; // 6 MiB max for image preview
const MAX_PREVIEW_PDF_BYTES: usize = 12 * 1024 * 1024; // 12 MiB max for PDF preview
const MAX_PREVIEW_HEAD_BYTES: usize = 256 * 1024; // 256 KiB head for MIME & text preview
const MAX_COPY_DIR_DEPTH: usize = 64;
const SFTP_TEMP_RETENTION_TTL: Duration = Duration::from_secs(60 * 60); // 1 hour

const SFTP_TEMP_COUNTER_INIT: u64 = 1;
const KEYRING_SERVICE: &str = "explr-sftp";
static SFTP_TEMP_COUNTER: AtomicU64 = AtomicU64::new(SFTP_TEMP_COUNTER_INIT);
static SFTP_CREDENTIALS: OnceLock<RwLock<HashMap<String, ZeroizingString>>> = OnceLock::new();
static SSH_PROFILES: OnceLock<RwLock<HashMap<String, SshAuthOptions>>> = OnceLock::new();
static KNOWN_HOSTS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Wrapper around a sensitive string that overwrites its UTF-8 buffer with zeros on drop.
#[derive(Clone)]
pub struct ZeroizingString(String);

impl ZeroizingString {
    pub fn new(s: String) -> Self {
        Self(s)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Drop for ZeroizingString {
    fn drop(&mut self) {
        // SAFETY: Writing 0x00 (valid UTF-8 NUL byte) to each byte of the owned String buffer
        // via volatile writes prevents dead-store elimination before the String deallocates.
        unsafe {
            let bytes = self.0.as_bytes_mut();
            for b in bytes.iter_mut() {
                std::ptr::write_volatile(b, 0);
            }
        }
        compiler_fence(Ordering::SeqCst);
    }
}

fn credential_store() -> &'static RwLock<HashMap<String, ZeroizingString>> {
    SFTP_CREDENTIALS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn profile_store() -> &'static RwLock<HashMap<String, SshAuthOptions>> {
    SSH_PROFILES.get_or_init(|| RwLock::new(HashMap::new()))
}

pub(crate) fn resolve_ssh_profile(
    host: &str,
    port: u16,
    username: &str,
    overrides: SshAuthOptions,
) -> SshAuthOptions {
    let key = format_sftp_connection_key(username, host, port);
    let stored = profile_store()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .cloned()
        .unwrap_or_default();

    SshAuthOptions {
        auth_type: overrides.auth_type.or(stored.auth_type),
        private_key_path: overrides.private_key_path.or(stored.private_key_path),
        certificate_path: overrides.certificate_path.or(stored.certificate_path),
        compression_mode: overrides.compression_mode.or(stored.compression_mode),
    }
}

#[tauri::command]
pub fn store_ssh_profile(
    connection_key: String,
    auth_type: Option<String>,
    private_key_path: Option<String>,
    certificate_path: Option<String>,
    compression_mode: Option<String>,
) -> Result<(), String> {
    let trimmed_key = connection_key.trim();
    if trimmed_key.is_empty() {
        return Err("SSH connection key cannot be empty".to_string());
    }
    let options = SshAuthOptions {
        auth_type,
        private_key_path,
        certificate_path,
        compression_mode,
    };
    let mut store = profile_store().write().unwrap_or_else(|e| e.into_inner());
    store.insert(trimmed_key.to_string(), options);
    Ok(())
}

fn known_hosts_mutex() -> &'static Mutex<()> {
    KNOWN_HOSTS_LOCK.get_or_init(|| Mutex::new(()))
}

pub fn format_sftp_connection_key(username: &str, host: &str, port: u16) -> String {
    format!("{}@{}:{}", username.trim(), host.trim(), port)
}

fn keyring_set_password(connection_key: &str, password: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, connection_key) {
        if let Err(err) = entry.set_password(password) {
            log_info!(
                "Keyring unavailable for storing credentials ({}): {}",
                connection_key,
                err
            );
        }
    }
}

fn keyring_get_password(connection_key: &str) -> Option<ZeroizingString> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, connection_key).ok()?;
    match entry.get_password() {
        Ok(pw) if !pw.is_empty() => Some(ZeroizingString::new(pw)),
        _ => None,
    }
}

fn keyring_delete_password(connection_key: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, connection_key) {
        let _ = entry.delete_credential();
    }
}

#[tauri::command]
pub fn store_sftp_credentials(connection_key: String, password: String) -> Result<(), String> {
    let secret = ZeroizingString::new(password);
    let trimmed_key = connection_key.trim();
    if trimmed_key.is_empty() {
        return Err("SFTP connection key cannot be empty".to_string());
    }
    if secret.is_empty() {
        return Err("SFTP password cannot be empty".to_string());
    }
    keyring_set_password(trimmed_key, secret.as_str());
    let mut store = credential_store()
        .write()
        .unwrap_or_else(|e| e.into_inner());
    store.insert(trimmed_key.to_string(), secret);
    Ok(())
}

#[tauri::command]
pub fn remove_sftp_credentials(connection_key: String) -> Result<(), String> {
    let trimmed_key = connection_key.trim();
    if trimmed_key.is_empty() {
        return Err("SFTP connection key cannot be empty".to_string());
    }
    keyring_delete_password(trimmed_key);
    profile_store()
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .remove(trimmed_key);
    let mut store = credential_store()
        .write()
        .unwrap_or_else(|e| e.into_inner());
    store.remove(trimmed_key);
    Ok(())
}

#[tauri::command]
pub fn has_sftp_credentials(connection_key: String) -> Result<bool, String> {
    let trimmed_key = connection_key.trim();
    if trimmed_key.is_empty() {
        return Ok(false);
    }
    let in_ram = {
        let store = credential_store().read().unwrap_or_else(|e| e.into_inner());
        store
            .get(trimmed_key)
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    };
    if in_ram {
        return Ok(true);
    }
    Ok(keyring_get_password(trimmed_key).is_some())
}

pub(crate) fn resolve_sftp_password(
    host: &str,
    port: u16,
    username: &str,
    provided_password: String,
) -> Result<ZeroizingString, String> {
    let provided = ZeroizingString::new(provided_password);
    if !provided.is_empty() {
        return Ok(provided);
    }

    let primary_key = format_sftp_connection_key(username, host, port);
    let host_port_key = format!("{}:{}", host.trim(), port);

    {
        let store = credential_store().read().unwrap_or_else(|e| e.into_inner());
        if let Some(secret) = store.get(&primary_key) {
            if !secret.is_empty() {
                return Ok(secret.clone());
            }
        }
        if let Some(secret) = store.get(&host_port_key) {
            if !secret.is_empty() {
                return Ok(secret.clone());
            }
        }
    }

    for key in [&primary_key, &host_port_key] {
        if let Some(secret) = keyring_get_password(key) {
            let mut store = credential_store()
                .write()
                .unwrap_or_else(|e| e.into_inner());
            store.insert(key.clone(), secret.clone());
            return Ok(secret);
        }
    }

    Err(format!(
        "No SFTP password provided and no stored credentials found for {primary_key}"
    ))
}

/// Computes the canonical `SHA256:<base64_no_pad>` fingerprint for raw SSH host key bytes.
pub fn compute_host_key_fingerprint(host_key_bytes: &[u8]) -> String {
    let digest = Sha256::digest(host_key_bytes);
    let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest);
    format!("SHA256:{b64}")
}

/// Normalizes an SSH SHA-256 fingerprint string into `SHA256:<base64_no_pad>`.
pub fn normalize_fingerprint(fp: &str) -> String {
    let trimmed = fp.trim();
    let raw = if let Some(rest) = trimmed.strip_prefix("SHA256:") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("sha256:") {
        rest
    } else {
        trimmed
    };
    let unpadded = raw.trim().trim_end_matches('=');
    format!("SHA256:{unpadded}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyVerification {
    Trusted,
    Untrusted { fingerprint: String },
    Mismatch { expected: String, actual: String },
}

fn host_token_matches(token: &str, host: &str, port: u16) -> bool {
    let host_lower = host.trim().to_lowercase();
    let bracketed = format!("[{host_lower}]:{port}");
    let unbracketed = format!("{host_lower}:{port}");

    for part in token.split(',') {
        let candidate = part.trim().to_lowercase();
        if candidate == bracketed || candidate == unbracketed {
            return true;
        }
        if port == 22 && candidate == host_lower {
            return true;
        }
    }
    false
}

fn extract_fingerprint_from_fields(fields: &[&str]) -> Option<String> {
    if fields.len() < 2 {
        return None;
    }
    // Format 1: `<host_token> SHA256:<b64> [optional_raw_b64]`
    if fields[1].starts_with("SHA256:") || fields[1].starts_with("sha256:") {
        return Some(normalize_fingerprint(fields[1]));
    }
    // Format 2: `<host_token> <key_type> SHA256:<b64>`
    if fields.len() >= 3 && (fields[2].starts_with("SHA256:") || fields[2].starts_with("sha256:")) {
        return Some(normalize_fingerprint(fields[2]));
    }
    // Format 3: Standard OpenSSH `known_hosts` line: `<host_token> <key_type> <base64_key>`
    if fields.len() >= 3 {
        let key_b64 = fields[2].trim();
        if let Ok(decoded) = base64::engine::general_purpose::STANDARD
            .decode(key_b64)
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(key_b64))
        {
            if !decoded.is_empty() {
                return Some(compute_host_key_fingerprint(&decoded));
            }
        }
    }
    None
}

pub fn verify_host_key_against_contents(
    host: &str,
    port: u16,
    live_fingerprint: &str,
    contents: &[String],
) -> HostKeyVerification {
    let normalized_live = normalize_fingerprint(live_fingerprint);
    let mut matched_fingerprints: Vec<String> = Vec::new();

    for content in contents {
        for raw_line in content.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 2 {
                continue;
            }
            if host_token_matches(fields[0], host, port) {
                if let Some(fp) = extract_fingerprint_from_fields(&fields) {
                    if fp == normalized_live {
                        return HostKeyVerification::Trusted;
                    }
                    matched_fingerprints.push(fp);
                }
            }
        }
    }

    if let Some(first_expected) = matched_fingerprints.into_iter().next() {
        HostKeyVerification::Mismatch {
            expected: first_expected,
            actual: normalized_live,
        }
    } else {
        HostKeyVerification::Untrusted {
            fingerprint: normalized_live,
        }
    }
}

pub fn get_app_known_hosts_path() -> PathBuf {
    let config_dir = get_app_base_dir().join("config");
    let _ = fs::create_dir_all(&config_dir);
    config_dir.join("sftp_known_hosts")
}

fn load_known_hosts_contents() -> Vec<String> {
    let mut contents = Vec::new();
    let app_known_hosts = get_app_known_hosts_path();
    if let Ok(text) = fs::read_to_string(&app_known_hosts) {
        contents.push(text);
    }

    // Only consult user's ~/.ssh/known_hosts when EXPLR_DATA_DIR is not isolated
    if std::env::var_os("EXPLR_DATA_DIR").is_none() {
        if let Some(home) = home::home_dir() {
            let ssh_known_hosts = home.join(".ssh").join("known_hosts");
            if let Ok(text) = fs::read_to_string(&ssh_known_hosts) {
                contents.push(text);
            }
        }
    }

    contents
}

pub fn persist_trusted_host_key_to_path(
    known_hosts_path: &Path,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> Result<(), String> {
    let host_trimmed = host.trim();
    if host_trimmed.is_empty() {
        return Err("Host cannot be empty".to_string());
    }
    let normalized_fp = normalize_fingerprint(fingerprint);
    if normalized_fp == "SHA256:" {
        return Err("Fingerprint cannot be empty".to_string());
    }

    let _guard = known_hosts_mutex()
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    if let Some(parent) = known_hosts_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create known_hosts config directory: {e}"))?;
    }

    let existing = fs::read_to_string(known_hosts_path).unwrap_or_default();
    let mut kept_lines: Vec<String> = Vec::new();
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            kept_lines.push(line.to_string());
            continue;
        }
        let fields: Vec<&str> = trimmed.split_whitespace().collect();
        if !fields.is_empty() && host_token_matches(fields[0], host_trimmed, port) {
            // Replace previous entry for this host:port
            continue;
        }
        kept_lines.push(line.to_string());
    }

    kept_lines.push(format!(
        "[{}]:{} {}",
        host_trimmed.to_lowercase(),
        port,
        normalized_fp
    ));
    let mut new_content = kept_lines.join("\n");
    new_content.push('\n');

    fs::write(known_hosts_path, new_content)
        .map_err(|e| format!("Failed to write sftp_known_hosts: {e}"))
}

fn connect_ssh_session(host: &str, port: u16) -> Result<(Session, String), String> {
    connect_ssh_session_with_compression(host, port, false)
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SshAuthOptions {
    pub auth_type: Option<String>,
    pub private_key_path: Option<String>,
    pub certificate_path: Option<String>,
    pub compression_mode: Option<String>,
}

impl SshAuthOptions {
    pub(crate) fn should_compress_transport(&self) -> bool {
        matches!(
            self.compression_mode
                .as_deref()
                .map(|s| s.trim().to_ascii_lowercase())
                .as_deref(),
            Some("always") | Some("auto")
        )
    }
}

fn connect_ssh_session_with_compression(
    host: &str,
    port: u16,
    compress: bool,
) -> Result<(Session, String), String> {
    let trimmed_host = host.trim();
    if trimmed_host.is_empty() {
        return Err("Host cannot be empty".to_string());
    }
    if port == 0 {
        return Err("Port must be between 1 and 65535".to_string());
    }

    let addrs: Vec<_> = (trimmed_host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Failed to resolve host '{trimmed_host}:{port}': {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!(
            "Failed to resolve host '{trimmed_host}:{port}': no addresses returned"
        ));
    }

    let mut last_err = None;
    let mut connected_tcp = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, SFTP_TCP_CONNECT_TIMEOUT) {
            Ok(stream) => {
                connected_tcp = Some(stream);
                break;
            }
            Err(e) => {
                last_err = Some(e);
            }
        }
    }

    let tcp = connected_tcp.ok_or_else(|| {
        last_err
            .map(|e| format!("Failed to connect to '{trimmed_host}:{port}': {e}"))
            .unwrap_or_else(|| format!("Failed to connect to '{trimmed_host}:{port}'"))
    })?;

    let io_timeout = Duration::from_millis(SFTP_SSH_SESSION_TIMEOUT_MS as u64);
    let _ = tcp.set_read_timeout(Some(io_timeout));
    let _ = tcp.set_write_timeout(Some(io_timeout));

    let mut session = Session::new().map_err(|_| "Could not initialize SSH session".to_string())?;
    session.set_tcp_stream(tcp);
    session.set_timeout(SFTP_SSH_SESSION_TIMEOUT_MS);
    if compress {
        session.set_compress(true);
    }
    session.handshake().map_err(|e| e.to_string())?;

    let (host_key_bytes, _key_type) = session
        .host_key()
        .ok_or_else(|| "HOST_KEY_UNTRUSTED:Server did not present a host key".to_string())?;
    let fingerprint = compute_host_key_fingerprint(host_key_bytes);

    Ok((session, fingerprint))
}

fn trust_sftp_host_key_impl(
    host: String,
    port: u16,
    expected_fingerprint: String,
) -> Result<(), String> {
    let trimmed_expected = expected_fingerprint.trim();
    if trimmed_expected.is_empty() {
        return Err("Expected host key fingerprint cannot be empty".to_string());
    }
    let normalized_expected = normalize_fingerprint(trimmed_expected);
    let (_session, live_fingerprint) = connect_ssh_session(&host, port)?;

    if normalize_fingerprint(&live_fingerprint) != normalized_expected {
        return Err(format!(
            "HOST_KEY_MISMATCH:expected {normalized_expected}, got {live_fingerprint}"
        ));
    }

    let known_hosts_path = get_app_known_hosts_path();
    persist_trusted_host_key_to_path(&known_hosts_path, &host, port, &live_fingerprint)
}

#[tauri::command]
pub async fn trust_sftp_host_key(
    host: String,
    port: u16,
    expected_fingerprint: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || trust_sftp_host_key_impl(host, port, expected_fingerprint))
        .await
        .map_err(|e| format!("SFTP task join error: {e}"))?
}

pub(crate) fn connect_authenticated_ssh_session(
    host: &str,
    port: u16,
    username: &str,
    password: String,
    options: &SshAuthOptions,
) -> Result<Session, String> {
    let trimmed_user = username.trim();
    let auth_mode = options
        .auth_type
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| {
            if trimmed_user.is_empty() {
                "guest".to_string()
            } else {
                "password".to_string()
            }
        });

    let is_guest_user = auth_mode == "guest"
        || trimmed_user.is_empty()
        || trimmed_user.eq_ignore_ascii_case("anonymous")
        || trimmed_user.eq_ignore_ascii_case("guest");

    let secret_password = match auth_mode.as_str() {
        "key" | "certificate" | "agent" | "guest" => {
            if password.is_empty() && !trimmed_user.is_empty() {
                resolve_sftp_password(host, port, trimmed_user, password)
                    .unwrap_or_else(|_| ZeroizingString::new(String::new()))
            } else {
                ZeroizingString::new(password)
            }
        }
        _ => {
            if trimmed_user.is_empty() {
                ZeroizingString::new(password)
            } else {
                match resolve_sftp_password(host, port, trimmed_user, password) {
                    Ok(secret) => secret,
                    Err(_) if is_guest_user => ZeroizingString::new(String::new()),
                    Err(e) => return Err(e),
                }
            }
        }
    };

    let (session, live_fingerprint) =
        connect_ssh_session_with_compression(host, port, options.should_compress_transport())?;

    // Verify SSH host key BEFORE sending credentials to prevent MITM credential interception
    let known_contents = load_known_hosts_contents();
    match verify_host_key_against_contents(host, port, &live_fingerprint, &known_contents) {
        HostKeyVerification::Trusted => {}
        HostKeyVerification::Untrusted { fingerprint } => {
            return Err(format!("HOST_KEY_UNTRUSTED:{fingerprint}"));
        }
        HostKeyVerification::Mismatch { expected, actual } => {
            return Err(format!(
                "HOST_KEY_MISMATCH:Host key for {host}:{port} changed (expected {expected}, got {actual})"
            ));
        }
    }

    match auth_mode.as_str() {
        "key" | "certificate" => {
            let effective_user = if trimmed_user.is_empty() {
                "root"
            } else {
                trimmed_user
            };
            let key_path_str = options
                .private_key_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "Private key path is required for key/certificate auth".to_string()
                })?;
            let key_path = Path::new(key_path_str);
            if !key_path.exists() {
                return Err(format!("Private key file not found: {key_path_str}"));
            }
            let cert_path = options
                .certificate_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(Path::new);
            if let Some(cp) = cert_path {
                if !cp.exists() {
                    return Err(format!("Certificate file not found: {}", cp.display()));
                }
            }
            let passphrase = if secret_password.is_empty() {
                None
            } else {
                Some(secret_password.as_str())
            };
            session
                .userauth_pubkey_file(effective_user, cert_path, key_path, passphrase)
                .map_err(|e| format!("SSH key/certificate authentication failed: {e}"))?;
        }
        "agent" => {
            let effective_user = if trimmed_user.is_empty() {
                "root"
            } else {
                trimmed_user
            };
            session
                .userauth_agent(effective_user)
                .map_err(|e| format!("SSH agent authentication failed: {e}"))?;
        }
        "guest" => {
            let candidates: Vec<&str> = if trimmed_user.is_empty() {
                vec!["anonymous", "guest"]
            } else {
                vec![trimmed_user]
            };
            for guest_user in candidates {
                let _ = session.auth_methods(guest_user);
                if session.authenticated() {
                    break;
                }
                if session
                    .userauth_password(guest_user, secret_password.as_str())
                    .is_ok()
                    && session.authenticated()
                {
                    break;
                }
                if secret_password.is_empty()
                    && session.userauth_agent(guest_user).is_ok()
                    && session.authenticated()
                {
                    break;
                }
            }
        }
        _ => {
            if trimmed_user.is_empty() {
                for guest_user in ["anonymous", "guest"] {
                    let _ = session.auth_methods(guest_user);
                    if session.authenticated() {
                        break;
                    }
                    if session
                        .userauth_password(guest_user, secret_password.as_str())
                        .is_ok()
                        && session.authenticated()
                    {
                        break;
                    }
                    if secret_password.is_empty()
                        && session.userauth_agent(guest_user).is_ok()
                        && session.authenticated()
                    {
                        break;
                    }
                }
            } else {
                if is_guest_user && secret_password.is_empty() {
                    let _ = session.auth_methods(trimmed_user);
                }
                if !session.authenticated() {
                    let auth_res =
                        session.userauth_password(trimmed_user, secret_password.as_str());
                    if !session.authenticated() && secret_password.is_empty() {
                        let _ = session.userauth_agent(trimmed_user);
                    }
                    if !session.authenticated() {
                        auth_res.map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }

    if !session.authenticated() {
        return Err("Authentication failed".to_string());
    }

    Ok(session)
}

pub(crate) fn connect_to_sftp_with_options(
    host: String,
    port: u16,
    username: String,
    password: String,
    options: &SshAuthOptions,
) -> Result<Sftp, String> {
    let session = connect_authenticated_ssh_session(&host, port, &username, password, options)?;
    session.sftp().map_err(|e| e.to_string())
}

fn connect_to_sftp_via_password(
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<Sftp, String> {
    let options = resolve_ssh_profile(&host, port, &username, SshAuthOptions::default());
    connect_to_sftp_with_options(host, port, username, password, &options)
}

#[allow(dead_code)]
fn connect_to_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<Sftp, String> {
    connect_to_sftp_via_password(host, port, username, password)
}

/// Reads at most `max_bytes` from `reader`, returning an error if the stream contains more than `max_bytes`.
pub fn read_bounded<R: Read>(reader: R, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut buf = Vec::with_capacity(max_bytes.min(64 * 1024));
    let limit = (max_bytes as u64).saturating_add(1);
    reader
        .take(limit)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() > max_bytes {
        return Err(format!(
            "File exceeds maximum allowed read limit of {max_bytes} bytes"
        ));
    }
    Ok(buf)
}

fn load_dir_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    directory: String,
    overrides: SshAuthOptions,
) -> Result<String, String> {
    let options = resolve_ssh_profile(&host, port, &username, overrides);
    let sftp = connect_to_sftp_with_options(host, port, username, password, &options)?;
    let entries = sftp
        .readdir(Path::new(&directory))
        .map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    let mut directories = Vec::new();

    for (path, stat) in entries {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name == "." || name == ".." {
                continue;
            }
        }
        let Some(raw_str) = path.to_str() else {
            continue;
        };
        let normalized = raw_str.replace('\\', "/");
        if stat.is_dir() {
            directories.push(normalized);
        } else if stat.is_file() {
            files.push(normalized);
        }
    }

    let sftp_directory = SFTPDirectory {
        sftp_directory: directory,
        files,
        directories,
    };

    serde_json::to_string(&sftp_directory).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn load_dir(
    host: String,
    port: u16,
    username: String,
    password: String,
    directory: String,
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
    tokio::task::spawn_blocking(move || {
        load_dir_impl(host, port, username, password, directory, overrides)
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn open_file_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    file_path: String,
) -> Result<String, String> {
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    let remote_path = Path::new(&file_path);

    if let Ok(stat) = sftp.stat(remote_path) {
        if let Some(size) = stat.size {
            if size > MAX_OPEN_FILE_SFTP_BYTES as u64 {
                return Err(format!(
                    "Remote file size ({size} bytes) exceeds maximum allowed limit of {MAX_OPEN_FILE_SFTP_BYTES} bytes"
                ));
            }
        }
    }

    let file = sftp.open(remote_path).map_err(|e| e.to_string())?;
    let bytes = read_bounded(file, MAX_OPEN_FILE_SFTP_BYTES)?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_file_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    file_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        open_file_sftp_impl(host, port, username, password, file_path)
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn create_file_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    file_path: String,
) -> Result<String, String> {
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    sftp.create(file_path.as_ref()).map_err(|e| e.to_string())?;
    Ok(format!("File created at: {file_path}"))
}

#[tauri::command]
pub async fn create_file_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    file_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        create_file_sftp_impl(host, port, username, password, file_path)
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn delete_file_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    file_path: String,
) -> Result<String, String> {
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    sftp.unlink(file_path.as_ref()).map_err(|e| e.to_string())?;
    Ok(format!("File deleted at: {file_path}"))
}

#[tauri::command]
pub async fn delete_file_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    file_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        delete_file_sftp_impl(host, port, username, password, file_path)
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn rename_file_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    old_path: String,
    new_path: String,
) -> Result<String, String> {
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    sftp.rename(old_path.as_ref(), new_path.as_ref(), None)
        .map_err(|e| e.to_string())?;
    Ok(format!("File renamed from {old_path} to {new_path}"))
}

#[tauri::command]
pub async fn rename_file_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    old_path: String,
    new_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        rename_file_sftp_impl(host, port, username, password, old_path, new_path)
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn copy_file_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    source_path: String,
    destination_path: String,
) -> Result<String, String> {
    if source_path.trim() == destination_path.trim() {
        return Err("Source and destination paths cannot be identical".to_string());
    }
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;

    let mut source_file = sftp
        .open(Path::new(&source_path))
        .map_err(|e| e.to_string())?;
    let mut destination_file = sftp
        .create(destination_path.as_ref())
        .map_err(|e| e.to_string())?;

    std::io::copy(&mut source_file, &mut destination_file).map_err(|e| e.to_string())?;
    destination_file.flush().map_err(|e| e.to_string())?;

    Ok(format!(
        "File copied from {source_path} to {destination_path}"
    ))
}

#[tauri::command]
pub async fn copy_file_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    source_path: String,
    destination_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        copy_file_sftp_impl(
            host,
            port,
            username,
            password,
            source_path,
            destination_path,
        )
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn move_file_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    source_path: String,
    destination_path: String,
) -> Result<String, String> {
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    sftp.rename(source_path.as_ref(), destination_path.as_ref(), None)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "File moved from {source_path} to {destination_path}"
    ))
}

#[tauri::command]
pub async fn move_file_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    source_path: String,
    destination_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        move_file_sftp_impl(
            host,
            port,
            username,
            password,
            source_path,
            destination_path,
        )
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn create_directory_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    directory_path: String,
) -> Result<String, String> {
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    sftp.mkdir(directory_path.as_ref(), 0o755)
        .map_err(|e| e.to_string())?;
    Ok(format!("Directory created at: {directory_path}"))
}

#[tauri::command]
pub async fn create_directory_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    directory_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        create_directory_sftp_impl(host, port, username, password, directory_path)
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn delete_directory_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    directory_path: String,
) -> Result<String, String> {
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    sftp.rmdir(directory_path.as_ref())
        .map_err(|e| e.to_string())?;
    Ok(format!("Directory deleted at: {directory_path}"))
}

#[tauri::command]
pub async fn delete_directory_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    directory_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        delete_directory_sftp_impl(host, port, username, password, directory_path)
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn rename_directory_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    old_path: String,
    new_path: String,
) -> Result<String, String> {
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    sftp.rename(old_path.as_ref(), new_path.as_ref(), None)
        .map_err(|e| e.to_string())?;
    Ok(format!("Directory renamed from {old_path} to {new_path}"))
}

#[tauri::command]
pub async fn rename_directory_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    old_path: String,
    new_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        rename_directory_sftp_impl(host, port, username, password, old_path, new_path)
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

pub fn is_sftp_symlink(stat: &FileStat) -> bool {
    stat.perm
        .map(|perm| (perm & 0o170000) == 0o120000)
        .unwrap_or(false)
}

pub fn validate_copy_directory_targets(
    source_path: &str,
    destination_path: &str,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_COPY_DIR_DEPTH {
        return Err(format!(
            "Maximum directory copy recursion depth ({MAX_COPY_DIR_DEPTH}) exceeded"
        ));
    }
    let src_norm = source_path.trim().trim_end_matches(['/', '\\']);
    let dst_norm = destination_path.trim().trim_end_matches(['/', '\\']);
    if src_norm.is_empty() || dst_norm.is_empty() {
        return Err("Source and destination directory paths cannot be empty".to_string());
    }
    if src_norm == dst_norm {
        return Err("Cannot copy a directory into itself".to_string());
    }
    let src_prefix = format!("{src_norm}/");
    if dst_norm.starts_with(&src_prefix) {
        return Err("Cannot copy a directory into one of its own subdirectories".to_string());
    }
    Ok(())
}

fn copy_directory_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    source_path: String,
    destination_path: String,
) -> Result<String, String> {
    validate_copy_directory_targets(&source_path, &destination_path, 0)?;

    // Reuse a SINGLE SFTP session across the entire iterative traversal
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    let mut stack: Vec<(String, String, usize)> =
        vec![(source_path.clone(), destination_path.clone(), 0)];

    while let Some((curr_src, curr_dst, depth)) = stack.pop() {
        validate_copy_directory_targets(&curr_src, &curr_dst, depth)?;

        // Verify source exists before creating destination directory
        let entries = sftp
            .readdir(Path::new(&curr_src))
            .map_err(|e| e.to_string())?;

        sftp.mkdir(Path::new(&curr_dst), 0o755)
            .map_err(|e| e.to_string())?;

        for (entry_path, stat) in entries {
            let file_name_os = entry_path.file_name().ok_or_else(|| {
                format!("Invalid SFTP directory entry without filename: {entry_path:?}")
            })?;
            let file_name = file_name_os.to_str().ok_or_else(|| {
                format!("Non-UTF-8 filename encountered in SFTP directory: {entry_path:?}")
            })?;
            if file_name == "." || file_name == ".." {
                continue;
            }
            let entry_path_str = entry_path.to_str().ok_or_else(|| {
                format!("Non-UTF-8 path encountered in SFTP directory: {entry_path:?}")
            })?;

            // Check lstat to avoid following symlinks or symlink loops
            if is_sftp_symlink(&stat) {
                continue;
            }
            if let Ok(lstat) = sftp.lstat(&entry_path) {
                if is_sftp_symlink(&lstat) {
                    continue;
                }
            }

            let new_dst = format!("{}/{}", curr_dst.trim_end_matches('/'), file_name);

            if stat.is_dir() {
                let next_depth = depth + 1;
                if next_depth > MAX_COPY_DIR_DEPTH {
                    return Err(format!(
                        "Maximum directory copy recursion depth ({MAX_COPY_DIR_DEPTH}) exceeded at {entry_path_str}"
                    ));
                }
                stack.push((entry_path_str.to_string(), new_dst, next_depth));
            } else if stat.is_file() {
                let mut source_file = sftp.open(&entry_path).map_err(|e| e.to_string())?;
                let mut destination_file = sftp
                    .create(Path::new(&new_dst))
                    .map_err(|e| e.to_string())?;
                std::io::copy(&mut source_file, &mut destination_file)
                    .map_err(|e| e.to_string())?;
                destination_file.flush().map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(format!(
        "Directory copied from {source_path} to {destination_path}"
    ))
}

#[tauri::command]
pub async fn copy_directory_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    source_path: String,
    destination_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        copy_directory_sftp_impl(
            host,
            port,
            username,
            password,
            source_path,
            destination_path,
        )
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn move_directory_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    source_path: String,
    destination_path: String,
) -> Result<String, String> {
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    sftp.rename(source_path.as_ref(), destination_path.as_ref(), None)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "Directory moved from {source_path} to {destination_path}"
    ))
}

#[tauri::command]
pub async fn move_directory_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    source_path: String,
    destination_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        move_directory_sftp_impl(
            host,
            port,
            username,
            password,
            source_path,
            destination_path,
        )
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn has_drive_prefix(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn is_windows_reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim();
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// Strictly validates and sanitizes a remote SFTP path to extract a safe single-component local filename.
pub fn sanitize_sftp_filename(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("SFTP path cannot be empty".to_string());
    }
    if path.chars().any(|c| c == '\0' || c.is_control()) {
        return Err("SFTP path contains forbidden NUL or control characters".to_string());
    }

    let mut non_empty_segments = Vec::new();
    for seg in path.split(['/', '\\']) {
        if seg.is_empty() {
            continue;
        }
        if seg == "." || seg == ".." {
            return Err(format!(
                "Path traversal segment '{seg}' is not allowed in SFTP file path"
            ));
        }
        if has_drive_prefix(seg) {
            return Err(format!(
                "Drive prefix '{seg}' is not allowed in SFTP file path"
            ));
        }
        non_empty_segments.push(seg);
    }

    let raw_name = non_empty_segments
        .last()
        .copied()
        .ok_or_else(|| "SFTP path does not contain a valid filename".to_string())?;

    // Replace shell metacharacters and filesystem-unsafe symbols with '_'
    let sanitized: String = raw_name
        .chars()
        .map(|c| match c {
            '&' | '|' | '^' | '%' | '$' | ';' | '<' | '>' | '"' | '\'' | '`' | '*' | '?' | ':'
            | '/' | '\\' => '_',
            _ => c,
        })
        .collect();

    let trimmed = sanitized.trim().trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err("Sanitized SFTP filename is empty or invalid".to_string());
    }
    if is_windows_reserved_device_name(trimmed) {
        return Err(format!("Filename '{trimmed}' is a reserved OS device name"));
    }

    let safe = trimmed.to_string();
    let mut comps = Path::new(&safe).components();
    let is_single_normal =
        matches!(comps.next(), Some(Component::Normal(_))) && comps.next().is_none();
    if !is_single_normal {
        return Err(format!(
            "Sanitized SFTP filename '{safe}' is not a single normal path component"
        ));
    }

    Ok(safe)
}

fn filename_from_path(path: &str) -> Result<String, String> {
    sanitize_sftp_filename(path)
}

/// Checks whether a filename has a dangerous auto-executable extension.
pub fn is_dangerous_executable_extension(filename: &str) -> bool {
    const DANGEROUS_EXTENSIONS: &[&str] = &[
        "exe", "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "scr", "hta",
        "com", "lnk", "sh", "pif", "reg", "jar", "cpl", "msc",
    ];
    let cleaned = filename.trim().trim_end_matches(['.', ' ']);
    if let Some(ext) = cleaned.rsplit('.').next() {
        if ext.len() != cleaned.len() {
            let lower = ext.to_ascii_lowercase();
            return DANGEROUS_EXTENSIONS.contains(&lower.as_str());
        }
    }
    false
}

fn detect_mime_sftp(path: &str, head: &[u8]) -> Option<&'static str> {
    if let Some(kind) = infer::get(head) {
        return Some(kind.mime_type());
    }

    if let Some(ext) = path.rsplit('.').next().map(|s| s.to_lowercase()) {
        return Some(match ext.as_str() {
            "md" | "rs" | "ts" | "tsx" | "js" | "jsx" | "json" | "txt" | "log" | "toml"
            | "yaml" | "yml" | "xml" | "ini" | "csv" => "text/plain",
            "pdf" => "application/pdf",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "mp4" => "video/mp4",
            "mov" => "video/quicktime",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            _ => "application/octet-stream",
        });
    }
    None
}

fn read_sftp_prefix(sftp: &Sftp, path: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let file = sftp.open(Path::new(path)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(max_bytes.min(1024 * 1024));
    file.take(max_bytes as u64)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn build_preview_sftp_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    file_path: String,
) -> Result<PreviewPayload, String> {
    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    let name = filename_from_path(&file_path).unwrap_or_else(|_| "file".to_string());

    let stat = sftp
        .stat(Path::new(&file_path))
        .map_err(|e| e.to_string())?;

    if stat.is_dir() {
        let mut item_count = 0;
        let mut size: u64 = 0;
        let mut latest_modified: Option<u64> = None;

        if let Ok(entries) = sftp.readdir(Path::new(&file_path)) {
            for (entry_path, entry_stat) in entries {
                if let Some(entry_name) = entry_path.file_name().and_then(|n| n.to_str()) {
                    if entry_name == "." || entry_name == ".." {
                        continue;
                    }
                }
                item_count += 1;
                if let Some(entry_size) = entry_stat.size {
                    size = size.saturating_add(entry_size);
                }
                if let Some(mtime) = entry_stat.mtime {
                    let mtime_u64 = mtime;
                    latest_modified = match latest_modified {
                        Some(current) if current > mtime_u64 => Some(current),
                        _ => Some(mtime_u64),
                    };
                }
            }
        }

        let folder_modified = stat.mtime;
        let modified_time = latest_modified.or(folder_modified);
        let modified_str = modified_time.map(|t| {
            chrono::DateTime::from_timestamp(t as i64, 0)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| "unknown".to_string())
        });

        return Ok(PreviewPayload::Folder {
            name,
            size,
            item_count,
            modified: modified_str,
        });
    }

    let head = read_sftp_prefix(&sftp, &file_path, MAX_PREVIEW_HEAD_BYTES)?;
    let mime = detect_mime_sftp(&file_path, &head).unwrap_or("application/octet-stream");

    if mime.starts_with("image/") {
        if stat
            .size
            .map(|sz| sz > MAX_PREVIEW_IMAGE_BYTES as u64)
            .unwrap_or(false)
        {
            return Ok(PreviewPayload::Unknown { name });
        }
        let full_file = sftp
            .open(Path::new(&file_path))
            .map_err(|e| e.to_string())?;
        let Ok(data) = read_bounded(full_file, MAX_PREVIEW_IMAGE_BYTES) else {
            return Ok(PreviewPayload::Unknown { name });
        };
        let bytes = data.len();
        let data_uri = format!(
            "data:{};base64,{}",
            mime,
            base64::engine::general_purpose::STANDARD.encode(data)
        );
        return Ok(PreviewPayload::Image {
            name,
            data_uri,
            bytes,
        });
    }

    if mime == "application/pdf" {
        if stat
            .size
            .map(|sz| sz > MAX_PREVIEW_PDF_BYTES as u64)
            .unwrap_or(false)
        {
            return Ok(PreviewPayload::Unknown { name });
        }
        let full_file = sftp
            .open(Path::new(&file_path))
            .map_err(|e| e.to_string())?;
        let Ok(data) = read_bounded(full_file, MAX_PREVIEW_PDF_BYTES) else {
            return Ok(PreviewPayload::Unknown { name });
        };
        let bytes = data.len();
        let data_uri = format!(
            "data:{};base64,{}",
            mime,
            base64::engine::general_purpose::STANDARD.encode(data)
        );
        return Ok(PreviewPayload::Pdf {
            name,
            data_uri,
            bytes,
        });
    }

    if mime.starts_with("video/") || mime.starts_with("audio/") {
        return Ok(PreviewPayload::Unknown { name });
    }

    let looks_texty = mime.starts_with("text/")
        || (!head.is_empty()
            && !head.contains(&0)
            && head
                .iter()
                .all(|&b| b == 9 || b == 10 || b == 13 || (32..0xF5).contains(&b)));
    if looks_texty {
        let mut det = chardetng::EncodingDetector::new();
        det.feed(&head, true);
        let enc = det.guess(None, true);
        let (cow, _, _) = enc.decode(&head);
        let mut text = cow.to_string();
        let mut truncated = stat
            .size
            .map(|sz| sz > head.len() as u64)
            .unwrap_or(head.len() >= MAX_PREVIEW_HEAD_BYTES);
        if text.len() > 200_000 {
            let mut cut = 200_000;
            while cut > 0 && !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push_str("\n…(truncated)");
            truncated = true;
        }
        return Ok(PreviewPayload::Text {
            name,
            text,
            truncated,
        });
    }

    Ok(PreviewPayload::Unknown { name })
}

#[tauri::command]
pub async fn build_preview_sftp(
    host: String,
    port: u16,
    username: String,
    password: String,
    file_path: String,
) -> Result<PreviewPayload, String> {
    tokio::task::spawn_blocking(move || {
        build_preview_sftp_impl(host, port, username, password, file_path)
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

/// Allocates a unique isolated subdirectory and safe target path inside `base_temp_root`.
pub fn create_unique_sftp_temp_file_path(
    base_temp_root: &Path,
    remote_file_path: &str,
) -> Result<PathBuf, String> {
    let safe_filename = filename_from_path(remote_file_path)?;

    fs::create_dir_all(base_temp_root)
        .map_err(|e| format!("Failed to create SFTP temp directory: {e}"))?;
    let canon_root = fs::canonicalize(base_temp_root)
        .map_err(|e| format!("Failed to canonicalize SFTP temp directory: {e}"))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SFTP_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let unique_subdir_name = format!("sftp_{pid}_{ts}_{seq}");
    let unique_subdir = canon_root.join(unique_subdir_name);

    fs::create_dir_all(&unique_subdir)
        .map_err(|e| format!("Failed to create unique temp subdirectory: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&unique_subdir, fs::Permissions::from_mode(0o700));
    }

    let canon_subdir = fs::canonicalize(&unique_subdir)
        .map_err(|e| format!("Failed to canonicalize unique temp subdirectory: {e}"))?;
    if !canon_subdir.starts_with(&canon_root) {
        return Err("Unique SFTP temp subdirectory escaped temp root".to_string());
    }

    let temp_file_path = canon_subdir.join(&safe_filename);
    if temp_file_path.parent() != Some(canon_subdir.as_path()) {
        return Err("Target SFTP temp file path escaped unique temp subdirectory".to_string());
    }

    Ok(temp_file_path)
}

fn download_and_open_sftp_file_impl(
    host: String,
    port: u16,
    username: String,
    password: String,
    file_path: String,
    open_file: Option<bool>,
) -> Result<String, String> {
    let safe_filename = filename_from_path(&file_path)?;
    let should_open = open_file.unwrap_or(true);

    if should_open && is_dangerous_executable_extension(&safe_filename) {
        return Err(format!(
            "Refusing to auto-open potentially dangerous executable file type: '{safe_filename}'"
        ));
    }

    let sftp = connect_to_sftp_via_password(host, port, username, password)?;
    let temp_root = std::env::temp_dir().join("file_explorer_sftp");
    let temp_file_path = create_unique_sftp_temp_file_path(&temp_root, &file_path)?;
    let canon_root = fs::canonicalize(&temp_root)
        .map_err(|e| format!("Failed to canonicalize SFTP temp root: {e}"))?;

    {
        let mut remote_file = sftp
            .open(Path::new(&file_path))
            .map_err(|e| e.to_string())?;
        let mut local_file = fs::File::create(&temp_file_path).map_err(|e| e.to_string())?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = local_file.set_permissions(fs::Permissions::from_mode(0o600));
        }

        std::io::copy(&mut remote_file, &mut local_file).map_err(|e| e.to_string())?;
        local_file.flush().map_err(|e| e.to_string())?;
    }

    let canon_file = fs::canonicalize(&temp_file_path)
        .map_err(|e| format!("Failed to canonicalize downloaded SFTP temp file: {e}"))?;
    if !canon_file.starts_with(&canon_root) {
        let _ = fs::remove_file(&temp_file_path);
        return Err("Downloaded SFTP file escaped temporary directory root".to_string());
    }

    if should_open {
        open::that(&canon_file).map_err(|e| format!("Failed to open file: {e}"))?;
        Ok(format!(
            "File downloaded to {} and opened",
            canon_file.to_string_lossy()
        ))
    } else {
        Ok(canon_file.to_string_lossy().to_string())
    }
}

#[tauri::command]
pub async fn download_and_open_sftp_file(
    host: String,
    port: u16,
    username: String,
    password: String,
    file_path: String,
    open_file: Option<bool>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        download_and_open_sftp_file_impl(host, port, username, password, file_path, open_file)
    })
    .await
    .map_err(|e| format!("SFTP task join error: {e}"))?
}

fn entry_is_older_than(path: &Path, max_age: Duration) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if meta.is_dir() {
        // Check if any child inside the directory is newer than max_age
        if let Ok(children) = fs::read_dir(path) {
            let mut has_child = false;
            for child in children.flatten() {
                has_child = true;
                if !entry_is_older_than(&child.path(), max_age) {
                    return false;
                }
            }
            if has_child {
                return true;
            }
        }
    }
    meta.modified()
        .ok()
        .and_then(|m| m.elapsed().ok())
        .map(|elapsed| elapsed >= max_age)
        .unwrap_or(false)
}

pub fn cleanup_sftp_temp_files_in(temp_dir: &Path, max_age: Duration) -> Result<usize, String> {
    if !temp_dir.exists() {
        return Ok(0);
    }

    let entries =
        fs::read_dir(temp_dir).map_err(|e| format!("Failed to read temp directory: {e}"))?;
    let mut cleaned_count = 0usize;

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_is_older_than(&entry_path, max_age) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let removed = if file_type.is_dir() && !file_type.is_symlink() {
            fs::remove_dir_all(&entry_path).is_ok()
        } else {
            fs::remove_file(&entry_path).is_ok()
        };
        if removed {
            cleaned_count += 1;
        }
    }

    Ok(cleaned_count)
}

#[tauri::command]
pub fn cleanup_sftp_temp_files() -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("file_explorer_sftp");
    if !temp_dir.exists() {
        return Ok("No temporary directory to clean".to_string());
    }
    let cleaned_count = cleanup_sftp_temp_files_in(&temp_dir, SFTP_TEMP_RETENTION_TTL)?;
    Ok(format!("Cleaned {cleaned_count} old temporary files"))
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    use std::io::Cursor;
    use tempfile::TempDir;

    // TP-SFTP-01: SSH host key fingerprint calculation, known_hosts verification, untrusted & mismatch rejection
    #[test]
    fn test_tp_sftp_01_host_key_fingerprint_and_verification() {
        let key_a = b"ssh-ed25519-public-key-bytes-server-a";
        let key_b = b"ssh-ed25519-public-key-bytes-server-b";

        let fp_a = compute_host_key_fingerprint(key_a);
        let fp_b = compute_host_key_fingerprint(key_b);
        assert!(fp_a.starts_with("SHA256:"));
        assert_ne!(fp_a, fp_b);
        assert_eq!(normalize_fingerprint(&format!("{fp_a}===")), fp_a);

        // 1. Empty known_hosts -> Untrusted
        let res_untrusted = verify_host_key_against_contents("example.com", 2222, &fp_a, &[]);
        assert_eq!(
            res_untrusted,
            HostKeyVerification::Untrusted {
                fingerprint: fp_a.clone()
            }
        );

        // 2. Persist trusted host key in isolated TempDir -> Trusted
        let tmp = TempDir::new().expect("create temp dir");
        let kh_path = tmp.path().join("sftp_known_hosts");
        persist_trusted_host_key_to_path(&kh_path, "Example.COM", 2222, &fp_a)
            .expect("persist trusted host key");

        let stored = fs::read_to_string(&kh_path).expect("read known_hosts");
        let res_trusted = verify_host_key_against_contents(
            "example.com",
            2222,
            &fp_a,
            std::slice::from_ref(&stored),
        );
        assert_eq!(res_trusted, HostKeyVerification::Trusted);

        // 3. Different key on same host:port -> Mismatch
        let res_mismatch = verify_host_key_against_contents(
            "example.com",
            2222,
            &fp_b,
            std::slice::from_ref(&stored),
        );
        assert_eq!(
            res_mismatch,
            HostKeyVerification::Mismatch {
                expected: fp_a.clone(),
                actual: fp_b.clone()
            }
        );

        // 4. OpenSSH standard base64 known_hosts format support
        let b64_key_a = base64::engine::general_purpose::STANDARD.encode(key_a);
        let openssh_line =
            format!("[sftp.internal]:2222,sftp.internal:2222 ssh-ed25519 {b64_key_a}\n");
        let res_openssh =
            verify_host_key_against_contents("sftp.internal", 2222, &fp_a, &[openssh_line]);
        assert_eq!(res_openssh, HostKeyVerification::Trusted);
    }

    // TP-SFTP-02: Local path traversal rejection, shell metacharacter neutralization, and executable auto-open blocking
    #[test]
    fn test_tp_sftp_02_filename_sanitization_and_executable_blocking() {
        // Traversal and drive-prefix payloads must be rejected
        let traversal_payloads = [
            "sub/..\\..\\outside.txt",
            "../outside.txt",
            "a/b/../../secret.ini",
            "..",
            ".",
            "folder/..",
            "folder/.",
            "C:\\temp\\x.txt",
            "D:evil.txt",
            "foo/bar\0evil.txt",
            "foo/bar\nevil.txt",
            "CON.txt",
            "   ",
            "/",
            "\\",
        ];
        for payload in traversal_payloads {
            assert!(
                sanitize_sftp_filename(payload).is_err(),
                "Expected traversal/unsafe path '{payload}' to be rejected"
            );
        }

        // Shell metacharacter payloads must have metacharacters stripped and remain a single normal component
        let meta1 = sanitize_sftp_filename("foo/report&calc.txt").expect("sanitize &");
        assert_eq!(meta1, "report_calc.txt");
        assert!(!meta1.contains('&'));

        let meta2 = sanitize_sftp_filename("foo/a\"&echo.txt").expect("sanitize quote and &");
        assert_eq!(meta2, "a__echo.txt");
        assert!(!meta2.contains('"') && !meta2.contains('&'));

        let meta3 = sanitize_sftp_filename("/remote/dir/notes|calc;whoami`id`.md")
            .expect("sanitize pipe/semicolon/backtick");
        assert!(!meta3.contains(['|', ';', '`']));
        assert_eq!(Path::new(&meta3).components().count(), 1);

        // Dangerous executable extensions must be flagged
        for dangerous in [
            "payload.exe",
            "script.BAT",
            "run.cmd",
            "hook.ps1",
            "macro.vbs",
            "shortcut.lnk",
            "setup.msi",
            "dropper.hta",
            "shell.sh",
            "trick.exe...",
        ] {
            assert!(
                is_dangerous_executable_extension(dangerous),
                "Expected '{dangerous}' to be flagged as dangerous executable"
            );
        }

        for safe in [
            "report.txt",
            "photo.png",
            "archive.zip",
            "document.pdf",
            "README",
        ] {
            assert!(
                !is_dangerous_executable_extension(safe),
                "Expected '{safe}' not to be flagged as dangerous executable"
            );
        }
    }

    // TP-SFTP-03: Bounded read helper prevents OOM when remote file or stream exceeds limit
    #[test]
    fn test_tp_sftp_03_read_bounded_enforces_cap() {
        let data = vec![b'A'; 1024];
        let ok_res = read_bounded(Cursor::new(&data), 1024).expect("within limit should succeed");
        assert_eq!(ok_res.len(), 1024);

        let over_res = read_bounded(Cursor::new(&data), 1023);
        assert!(
            over_res.is_err(),
            "Stream exceeding max_bytes by 1 byte must be rejected"
        );
    }

    // TP-SFTP-04: Directory copy recursion depth, self-copy prevention, and symlink detection
    #[test]
    fn test_tp_sftp_04_copy_directory_validation_and_symlink_detection() {
        assert!(validate_copy_directory_targets("/data/src", "/data/dst", 0).is_ok());
        assert!(validate_copy_directory_targets("/data/src", "/data/src", 0).is_err());
        assert!(validate_copy_directory_targets("/data/src/", "/data/src/sub", 0).is_err());
        assert!(
            validate_copy_directory_targets("/data/src", "/data/dst", MAX_COPY_DIR_DEPTH + 1)
                .is_err()
        );

        let symlink_stat = FileStat {
            size: Some(10),
            uid: None,
            gid: None,
            perm: Some(0o120777),
            atime: None,
            mtime: None,
        };
        let regular_stat = FileStat {
            size: Some(10),
            uid: None,
            gid: None,
            perm: Some(0o100644),
            atime: None,
            mtime: None,
        };
        assert!(is_sftp_symlink(&symlink_stat));
        assert!(!is_sftp_symlink(&regular_stat));
    }

    // TP-SFTP-05 & BUG-057: Unique temp download directories, recursive cleanup, and credential zeroization
    #[test]
    fn test_tp_sftp_05_unique_temp_dirs_recursive_cleanup_and_credentials() {
        let temp_root = TempDir::new().expect("create temp root");

        let path_a = create_unique_sftp_temp_file_path(temp_root.path(), "/a/report.txt")
            .expect("create unique path A");
        let path_b = create_unique_sftp_temp_file_path(temp_root.path(), "/b/report.txt")
            .expect("create unique path B");

        assert_ne!(
            path_a, path_b,
            "Same-named files from different paths must not collide"
        );
        assert_ne!(path_a.parent(), path_b.parent());

        fs::write(&path_a, b"content A").expect("write A");
        fs::write(&path_b, b"content B").expect("write B");
        assert_eq!(fs::read(&path_a).expect("read A"), b"content A");
        assert_eq!(fs::read(&path_b).expect("read B"), b"content B");

        // Cleanup with 1-hour threshold should keep freshly created directories
        let cleaned_fresh = cleanup_sftp_temp_files_in(temp_root.path(), Duration::from_secs(3600))
            .expect("cleanup fresh");
        assert_eq!(cleaned_fresh, 0);
        assert!(path_a.exists() && path_b.exists());

        // Cleanup with Duration::ZERO removes nested subdirectories and files
        let cleaned_all =
            cleanup_sftp_temp_files_in(temp_root.path(), Duration::ZERO).expect("cleanup expired");
        assert_eq!(cleaned_all, 2);
        assert!(!path_a.exists() && !path_b.exists());

        // Test SftpCredentialStore lifecycle
        let key = format_sftp_connection_key("alice", "sftp.example.internal", 2222);
        assert!(!has_sftp_credentials(key.clone()).expect("has_sftp_credentials before store"));

        store_sftp_credentials(key.clone(), "s3cr3t-p@ss".to_string())
            .expect("store_sftp_credentials");
        assert!(has_sftp_credentials(key.clone()).expect("has_sftp_credentials after store"));

        let resolved = resolve_sftp_password("sftp.example.internal", 2222, "alice", String::new())
            .expect("resolve stored password when empty password passed");
        assert_eq!(resolved.as_str(), "s3cr3t-p@ss");

        remove_sftp_credentials(key.clone()).expect("remove_sftp_credentials");
        assert!(!has_sftp_credentials(key).expect("has_sftp_credentials after remove"));
        assert!(
            resolve_sftp_password("sftp.example.internal", 2222, "alice", String::new()).is_err()
        );
    }
}

#[cfg(test)]
#[cfg(feature = "sftp-tests")]
mod sftp_file_system_operation_commands_tests {
    use super::*;
    use std::sync::OnceLock;
    use tempfile::TempDir;

    const TEST_HOST: &str = "localhost";
    const TEST_PORT: u16 = 2222;
    const TEST_USERNAME: &str = "explorer";
    const TEST_PASSWORD: &str = "explorer";
    const TEST_WRONG_PASSWORD: &str = "wrong_password";
    const TEST_WRONG_HOST: &str = "nonexistent.host";

    static SFTP_TEST_ENV_LOCK: OnceLock<Mutex<Option<TempDir>>> = OnceLock::new();

    fn setup_trusted_test_host() {
        let mutex = SFTP_TEST_ENV_LOCK.get_or_init(|| Mutex::new(None));
        let mut guard = mutex.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() && std::env::var_os("EXPLR_DATA_DIR").is_none() {
            if let Ok(tmp) = TempDir::new() {
                std::env::set_var("EXPLR_DATA_DIR", tmp.path());
                *guard = Some(tmp);
            }
        }
        if let Ok((_session, live_fp)) = connect_ssh_session(TEST_HOST, TEST_PORT) {
            let kh_path = get_app_known_hosts_path();
            let _ = persist_trusted_host_key_to_path(&kh_path, TEST_HOST, TEST_PORT, &live_fp);
        }
    }

    #[test]
    fn test_connect_to_sftp_via_password_untrusted_and_mismatch_rejected() {
        let mutex = SFTP_TEST_ENV_LOCK.get_or_init(|| Mutex::new(None));
        let _guard = mutex.lock().unwrap_or_else(|e| e.into_inner());
        let kh_path = get_app_known_hosts_path();
        let _ = fs::remove_file(&kh_path);

        // 1. Untrusted host key must be rejected before password auth
        let untrusted_err = connect_to_sftp_via_password(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
        )
        .err()
        .expect("Untrusted host key must be rejected");
        assert!(
            untrusted_err.starts_with("HOST_KEY_UNTRUSTED:SHA256:"),
            "Expected HOST_KEY_UNTRUSTED error, got: {untrusted_err}"
        );
        let live_fp = untrusted_err
            .strip_prefix("HOST_KEY_UNTRUSTED:")
            .unwrap()
            .to_string();

        // 2. Mismatched host key in known_hosts must be rejected
        persist_trusted_host_key_to_path(
            &kh_path,
            TEST_HOST,
            TEST_PORT,
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        )
        .expect("write dummy host key");
        let mismatch_err = connect_to_sftp_via_password(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
        )
        .err()
        .expect("Mismatched host key must be rejected");
        assert!(
            mismatch_err.starts_with("HOST_KEY_MISMATCH:"),
            "Expected HOST_KEY_MISMATCH error, got: {mismatch_err}"
        );

        // 3. Trusting actual live fingerprint allows connection
        trust_sftp_host_key_impl(TEST_HOST.to_string(), TEST_PORT, live_fp)
            .expect("trust live host key");
        let ok_res = connect_to_sftp_via_password(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
        );
        assert!(
            ok_res.is_ok(),
            "Connection should succeed after trusting host key"
        );
    }

    #[test]
    fn test_connect_to_sftp_via_password_success() {
        setup_trusted_test_host();
        let result = connect_to_sftp_via_password(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
        );

        assert!(result.is_ok(), "Should successfully connect to SFTP server");
    }

    #[test]
    fn test_connect_to_sftp_via_password_failure_wrong_password() {
        setup_trusted_test_host();
        let result = connect_to_sftp_via_password(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_WRONG_PASSWORD.to_string(),
        );

        assert!(result.is_err(), "Should fail with wrong password");
    }

    #[test]
    fn test_connect_to_sftp_via_password_failure_wrong_host() {
        setup_trusted_test_host();
        let result = connect_to_sftp_via_password(
            TEST_WRONG_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
        );

        assert!(result.is_err(), "Should fail with wrong host");
    }

    #[test]
    fn test_connect_to_sftp_success() {
        setup_trusted_test_host();
        let result = connect_to_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
        );

        assert!(result.is_ok(), "Should successfully connect to SFTP server");
    }

    #[test]
    fn test_connect_to_sftp_failure() {
        setup_trusted_test_host();
        let result = connect_to_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_WRONG_PASSWORD.to_string(),
        );

        assert!(result.is_err(), "Should fail with wrong credentials");
    }

    #[tokio::test]
    async fn test_load_dir_success() {
        setup_trusted_test_host();
        let result = load_dir(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            ".".to_string(),
        )
        .await;

        match result {
            Ok(json) => {
                assert!(!json.is_empty(), "JSON should not be empty");
                let parsed: Result<SFTPDirectory, _> = serde_json::from_str(&json);
                assert!(parsed.is_ok(), "Should be valid JSON");
            }
            Err(e) => {
                panic!("Should successfully load directory: {e}");
            }
        }
    }

    #[tokio::test]
    async fn test_load_dir_failure_wrong_credentials() {
        setup_trusted_test_host();
        let result = load_dir(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_WRONG_PASSWORD.to_string(),
            ".".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with wrong credentials");
    }

    #[tokio::test]
    async fn test_load_dir_failure_nonexistent_directory() {
        setup_trusted_test_host();
        let result = load_dir(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            "/nonexistent/directory".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with nonexistent directory");
    }

    #[tokio::test]
    async fn test_create_file_sftp_success() {
        setup_trusted_test_host();
        let test_file = "test_create_file.txt";

        let result = create_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            test_file.to_string(),
        )
        .await;

        assert!(result.is_ok(), "Should successfully create file");

        let _ = delete_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            test_file.to_string(),
        )
        .await;
    }

    #[tokio::test]
    async fn test_create_file_sftp_failure() {
        setup_trusted_test_host();
        let result = create_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_WRONG_PASSWORD.to_string(),
            "test_file.txt".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with wrong credentials");
    }

    #[tokio::test]
    async fn test_delete_file_sftp_success() {
        setup_trusted_test_host();
        let test_file = "test_delete_file.txt";

        let create_result = create_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            test_file.to_string(),
        )
        .await;
        assert!(create_result.is_ok(), "Should create test file first");

        let result = delete_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            test_file.to_string(),
        )
        .await;

        assert!(result.is_ok(), "Should successfully delete file");
    }

    #[tokio::test]
    async fn test_delete_file_sftp_failure_nonexistent_file() {
        setup_trusted_test_host();
        let result = delete_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            "nonexistent_file.txt".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with nonexistent file");
    }

    #[tokio::test]
    async fn test_rename_file_sftp_success() {
        setup_trusted_test_host();
        let original_file = "test_rename_original.txt";
        let renamed_file = "test_rename_new.txt";

        let create_result = create_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            original_file.to_string(),
        )
        .await;
        assert!(create_result.is_ok(), "Should create test file first");

        let result = rename_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            original_file.to_string(),
            renamed_file.to_string(),
        )
        .await;

        assert!(result.is_ok(), "Should successfully rename file");

        let _ = delete_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            renamed_file.to_string(),
        )
        .await;
    }

    #[tokio::test]
    async fn test_rename_file_sftp_failure() {
        setup_trusted_test_host();
        let result = rename_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            "nonexistent_file.txt".to_string(),
            "new_name.txt".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with nonexistent file");
    }

    #[tokio::test]
    async fn test_copy_file_sftp_success() {
        setup_trusted_test_host();
        let source_file = "test_copy_source.txt";
        let dest_file = "test_copy_dest.txt";

        let create_result = create_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            source_file.to_string(),
        )
        .await;
        assert!(create_result.is_ok(), "Should create source file first");

        let result = copy_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            source_file.to_string(),
            dest_file.to_string(),
        )
        .await;

        assert!(result.is_ok(), "Should successfully copy file");

        let _ = delete_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            source_file.to_string(),
        )
        .await;
        let _ = delete_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            dest_file.to_string(),
        )
        .await;
    }

    #[tokio::test]
    async fn test_copy_file_sftp_failure() {
        setup_trusted_test_host();
        let result = copy_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            "nonexistent_source.txt".to_string(),
            "dest.txt".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with nonexistent source file");
    }

    #[tokio::test]
    async fn test_move_file_sftp_success() {
        setup_trusted_test_host();
        let source_file = "test_move_source.txt";
        let dest_file = "test_move_dest.txt";

        let create_result = create_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            source_file.to_string(),
        )
        .await;
        assert!(create_result.is_ok(), "Should create source file first");

        let result = move_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            source_file.to_string(),
            dest_file.to_string(),
        )
        .await;

        assert!(result.is_ok(), "Should successfully move file");

        let _ = delete_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            dest_file.to_string(),
        )
        .await;
    }

    #[tokio::test]
    async fn test_move_file_sftp_failure() {
        setup_trusted_test_host();
        let result = move_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            "nonexistent_file.txt".to_string(),
            "dest.txt".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with nonexistent file");
    }

    #[tokio::test]
    async fn test_create_directory_sftp_success() {
        setup_trusted_test_host();
        let test_dir = "test_create_directory";

        let result = create_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            test_dir.to_string(),
        )
        .await;

        assert!(result.is_ok(), "Should successfully create directory");

        let _ = delete_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            test_dir.to_string(),
        )
        .await;
    }

    #[tokio::test]
    async fn test_create_directory_sftp_failure() {
        setup_trusted_test_host();
        let result = create_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_WRONG_PASSWORD.to_string(),
            "test_dir".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with wrong credentials");
    }

    #[tokio::test]
    async fn test_delete_directory_sftp_success() {
        setup_trusted_test_host();
        let test_dir = "test_delete_directory";

        let create_result = create_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            test_dir.to_string(),
        )
        .await;
        assert!(create_result.is_ok(), "Should create test directory first");

        let result = delete_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            test_dir.to_string(),
        )
        .await;

        assert!(result.is_ok(), "Should successfully delete directory");
    }

    #[tokio::test]
    async fn test_delete_directory_sftp_failure() {
        setup_trusted_test_host();
        let result = delete_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            "nonexistent_directory".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with nonexistent directory");
    }

    #[tokio::test]
    async fn test_rename_directory_sftp_success() {
        setup_trusted_test_host();
        let original_dir = "test_rename_dir_original";
        let renamed_dir = "test_rename_dir_new";

        let create_result = create_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            original_dir.to_string(),
        )
        .await;
        assert!(create_result.is_ok(), "Should create test directory first");

        let result = rename_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            original_dir.to_string(),
            renamed_dir.to_string(),
        )
        .await;

        assert!(result.is_ok(), "Should successfully rename directory");

        let _ = delete_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            renamed_dir.to_string(),
        )
        .await;
    }

    #[tokio::test]
    async fn test_rename_directory_sftp_failure() {
        setup_trusted_test_host();
        let result = rename_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            "nonexistent_directory".to_string(),
            "new_name".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with nonexistent directory");
    }

    #[tokio::test]
    async fn test_move_directory_sftp_success() {
        setup_trusted_test_host();
        let source_dir = "test_move_dir_source";
        let dest_dir = "test_move_dir_dest";

        let create_result = create_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            source_dir.to_string(),
        )
        .await;
        assert!(
            create_result.is_ok(),
            "Should create source directory first"
        );

        let result = move_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            source_dir.to_string(),
            dest_dir.to_string(),
        )
        .await;

        assert!(result.is_ok(), "Should successfully move directory");

        let _ = delete_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            dest_dir.to_string(),
        )
        .await;
    }

    #[tokio::test]
    async fn test_move_directory_sftp_failure() {
        setup_trusted_test_host();
        let result = move_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            "nonexistent_directory".to_string(),
            "dest_dir".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with nonexistent directory");
    }

    #[tokio::test]
    async fn test_copy_directory_sftp_success() {
        setup_trusted_test_host();
        let source_dir = "test_copy_dir_source";
        let dest_dir = "test_copy_dir_dest";

        let create_result = create_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            source_dir.to_string(),
        )
        .await;
        assert!(
            create_result.is_ok(),
            "Should create source directory first"
        );

        let result = copy_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            source_dir.to_string(),
            dest_dir.to_string(),
        )
        .await;

        assert!(result.is_ok(), "Should successfully copy directory");

        let _ = delete_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            source_dir.to_string(),
        )
        .await;
        let _ = delete_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            dest_dir.to_string(),
        )
        .await;
    }

    #[tokio::test]
    async fn test_copy_directory_sftp_failure() {
        setup_trusted_test_host();
        let result = copy_directory_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            "nonexistent_directory".to_string(),
            "dest_dir".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with nonexistent directory");
    }

    #[tokio::test]
    async fn test_open_file_sftp_success() {
        setup_trusted_test_host();
        let test_file = "test_read_file.txt";

        let create_result = create_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            test_file.to_string(),
        )
        .await;
        assert!(create_result.is_ok(), "Should create test file first");

        let result = open_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            test_file.to_string(),
        )
        .await;

        assert!(result.is_ok(), "Should successfully read file");

        let _ = delete_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            test_file.to_string(),
        )
        .await;
    }

    #[tokio::test]
    async fn test_open_file_sftp_failure() {
        setup_trusted_test_host();
        let result = open_file_sftp(
            TEST_HOST.to_string(),
            TEST_PORT,
            TEST_USERNAME.to_string(),
            TEST_PASSWORD.to_string(),
            "nonexistent_file.txt".to_string(),
        )
        .await;

        assert!(result.is_err(), "Should fail with nonexistent file");
    }
}
