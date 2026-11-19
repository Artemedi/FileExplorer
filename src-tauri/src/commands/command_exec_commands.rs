use crate::error_handling::{Error, ErrorCode};
use crate::log_info;
use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize, Deserialize, Debug, Clone, Eq, PartialEq)]
struct CommandResponse {
    stdout: String,
    stderr: String,
    status: i32,
    exec_time_in_ms: u128,
}

#[derive(Copy, Clone)]
enum ShellFlavor {
    Basic,
    Improved,
}

fn extract_first_token(command: &str) -> Result<&str, String> {
    command
        .split_whitespace()
        .next()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            Error::new(
                ErrorCode::InvalidInput,
                "Command is empty or invalid input".to_string(),
            )
            .to_json()
        })
}

fn resolve_working_directory(working_directory: Option<&str>) -> Option<PathBuf> {
    if let Some(wd) = working_directory {
        let path = Path::new(wd);
        if path.exists() && path.is_dir() {
            return Some(path.to_path_buf());
        }
        log_info!("Working directory '{}' not found, using home directory", wd);
    }
    home::home_dir().filter(|p| p.exists() && p.is_dir())
}

fn resolve_shell(flavor: ShellFlavor) -> (String, &'static str) {
    if cfg!(target_os = "windows") {
        match flavor {
            ShellFlavor::Basic => ("cmd".to_string(), "/C"),
            ShellFlavor::Improved => ("powershell".to_string(), "-Command"),
        }
    } else {
        let shell = env::var("SHELL").unwrap_or_else(|_| match flavor {
            ShellFlavor::Basic => "/bin/sh".to_string(),
            ShellFlavor::Improved => {
                if Path::new("/bin/bash").exists() {
                    "/bin/bash".to_string()
                } else {
                    "/bin/sh".to_string()
                }
            }
        });
        (shell, "-c")
    }
}

fn has_shell_metacharacters(command: &str) -> bool {
    command.chars().any(|c| {
        matches!(
            c,
            '|' | '&' | ';' | '>' | '<' | '\n' | '\r' | '`' | '$' | '(' | ')'
        )
    })
}

fn prepare_ping_command(command: &str, is_windows: bool) -> String {
    if has_shell_metacharacters(command) {
        return command.to_string();
    }

    let tokens: Vec<&str> = command.split_whitespace().collect();
    if tokens.len() < 2 {
        return command.to_string();
    }

    let is_ping = tokens[0].eq_ignore_ascii_case("ping")
        || (is_windows && tokens[0].eq_ignore_ascii_case("ping.exe"));
    if !is_ping {
        return command.to_string();
    }

    let has_count_or_continuous_flag = tokens[1..].iter().any(|tok| {
        let lower = tok.to_ascii_lowercase();
        lower == "-c"
            || lower == "-n"
            || lower == "-t"
            || lower == "/n"
            || lower == "/t"
            || lower.starts_with("-c")
            || lower.starts_with("-n")
    });

    if has_count_or_continuous_flag {
        return command.to_string();
    }

    if is_windows {
        format!("{} -n 4", command.trim())
    } else {
        format!("{} -c 4", command.trim())
    }
}

async fn read_stream_capped<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    max_bytes: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut truncated = false;

    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        if buf.len() < max_bytes {
            let remaining = max_bytes - buf.len();
            let to_take = n.min(remaining);
            buf.extend_from_slice(&chunk[..to_take]);
            if to_take < n {
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }

    Ok((buf, truncated))
}

fn format_capped_output(bytes: Vec<u8>, truncated: bool) -> String {
    let mut text = String::from_utf8_lossy(&bytes).trim_end().to_string();
    if truncated {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str("... [output truncated at 2 MiB]");
    }
    text
}

async fn kill_child_process(child: &mut tokio::process::Child) {
    #[cfg(target_os = "windows")]
    if let Some(pid) = child.id() {
        let mut tk = TokioCommand::new("taskkill");
        tk.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let _ = tk.status().await;
    }

    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let mut kill_pg = TokioCommand::new("kill");
        kill_pg
            .args(["-9", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = kill_pg.status().await;
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn exit_status_to_code(status: std::process::ExitStatus, fallback_signal_code: i32) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return 128 + sig;
        }
        fallback_signal_code
    }

    #[cfg(not(unix))]
    {
        let _ = fallback_signal_code;
        -1
    }
}

async fn run_shell_command(
    command: &str,
    working_directory: Option<&str>,
    timeout_duration: Option<Duration>,
    flavor: ShellFlavor,
) -> Result<String, String> {
    let program = extract_first_token(command)?;
    let start_time = std::time::Instant::now();
    let (shell_path, shell_arg) = resolve_shell(flavor);

    let mut cmd = TokioCommand::new(&shell_path);
    cmd.arg(shell_arg).arg(command);
    cmd.kill_on_drop(true);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    #[cfg(unix)]
    if timeout_duration.is_some() {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }

    if let Some(dir) = resolve_working_directory(working_directory) {
        cmd.current_dir(dir);
    }

    cmd.env("TERM", "xterm-256color");
    if matches!(flavor, ShellFlavor::Improved) {
        cmd.env("COLORTERM", "truecolor");
    }

    if !cfg!(target_os = "windows") {
        let current_path = env::var("PATH").unwrap_or_default();
        if matches!(flavor, ShellFlavor::Improved) {
            let extended_path = format!("{current_path}:/usr/local/bin:/usr/bin:/bin");
            cmd.env("PATH", extended_path);
            cmd.env("LC_ALL", "en_US.UTF-8");
            cmd.env("LANG", "en_US.UTF-8");
        } else {
            cmd.env("PATH", current_path);
        }
    }

    let mut child = cmd.spawn().map_err(|e| {
        let error_msg = match e.kind() {
            std::io::ErrorKind::NotFound => format!(
                "Shell '{shell_path}' not found while executing '{program}'. Make sure it's installed and in your PATH."
            ),
            std::io::ErrorKind::PermissionDenied => format!(
                "Permission denied launching shell '{shell_path}' for command '{program}'. Check file permissions."
            ),
            std::io::ErrorKind::InvalidInput => format!("Invalid command format: '{command}'"),
            _ => format!("Failed to launch shell '{shell_path}' for '{program}': {e}"),
        };
        Error::new(ErrorCode::InvalidInput, error_msg).to_json()
    })?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_task = tokio::spawn(async move {
        match stdout_pipe {
            Some(pipe) => read_stream_capped(pipe, MAX_OUTPUT_BYTES).await,
            None => Ok((Vec::new(), false)),
        }
    });
    let stderr_task = tokio::spawn(async move {
        match stderr_pipe {
            Some(pipe) => read_stream_capped(pipe, MAX_OUTPUT_BYTES).await,
            None => Ok((Vec::new(), false)),
        }
    });

    let stdout_abort = stdout_task.abort_handle();
    let stderr_abort = stderr_task.abort_handle();

    let (status, stdout_bytes, stdout_trunc, stderr_bytes, stderr_trunc) = if let Some(dur) =
        timeout_duration
    {
        let wait_fut = async {
            let status = child.wait().await?;
            let (stdout_res, stderr_res) = tokio::join!(stdout_task, stderr_task);
            let (stdout_bytes, stdout_trunc) = stdout_res.map_err(std::io::Error::other)??;
            let (stderr_bytes, stderr_trunc) = stderr_res.map_err(std::io::Error::other)??;
            Ok::<_, std::io::Error>((
                status,
                stdout_bytes,
                stdout_trunc,
                stderr_bytes,
                stderr_trunc,
            ))
        };

        match timeout(dur, wait_fut).await {
            Ok(Ok(collected)) => collected,
            Ok(Err(e)) => {
                kill_child_process(&mut child).await;
                stdout_abort.abort();
                stderr_abort.abort();
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    format!("Failed while waiting for command '{program}': {e}"),
                )
                .to_json());
            }
            Err(_) => {
                kill_child_process(&mut child).await;
                stdout_abort.abort();
                stderr_abort.abort();
                return Err(Error::new(
                        ErrorCode::InvalidInput,
                        format!(
                            "Command '{command}' timed out after {} seconds. Use Ctrl+C to cancel long-running commands.",
                            dur.as_secs()
                        ),
                    )
                    .to_json());
            }
        }
    } else {
        let status = match child.wait().await {
            Ok(s) => s,
            Err(e) => {
                kill_child_process(&mut child).await;
                stdout_abort.abort();
                stderr_abort.abort();
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    format!("Failed waiting for command '{program}': {e}"),
                )
                .to_json());
            }
        };
        let (stdout_res, stderr_res) = tokio::join!(stdout_task, stderr_task);
        let (stdout_bytes, stdout_trunc) = stdout_res
            .map_err(std::io::Error::other)
            .and_then(|r| r)
            .map_err(|e| Error::internal(format!("Failed reading stdout: {e}")).to_json())?;
        let (stderr_bytes, stderr_trunc) = stderr_res
            .map_err(std::io::Error::other)
            .and_then(|r| r)
            .map_err(|e| Error::internal(format!("Failed reading stderr: {e}")).to_json())?;
        (
            status,
            stdout_bytes,
            stdout_trunc,
            stderr_bytes,
            stderr_trunc,
        )
    };

    let exec_time = start_time.elapsed().as_millis();
    let stdout = format_capped_output(stdout_bytes, stdout_trunc);
    let stderr = format_capped_output(stderr_bytes, stderr_trunc);
    let fallback_sig = match flavor {
        ShellFlavor::Basic => 128 + 9,
        ShellFlavor::Improved => 128 + 15,
    };
    let status_code = exit_status_to_code(status, fallback_sig);

    let res = CommandResponse {
        stdout,
        stderr,
        status: status_code,
        exec_time_in_ms: exec_time,
    };

    serde_json::to_string(&res).map_err(|e| {
        Error::new(
            ErrorCode::InternalError,
            format!("Error serializing command response: {e}"),
        )
        .to_json()
    })
}

/// Executes a shell command and returns its output as a string.
///
/// # Arguments
///
/// * `command` - A string representing the command to execute
/// * `working_directory` - Optional working directory to run the command in
///
/// # Returns
///
/// * `Ok(String)` - The combined stdout and stderr output from the command
/// * `Err(String)` - If there was an error executing the command
///
/// # Example
///
/// ```rust
/// let result = execute_command("ls -la".to_string(), Some("/home/user".to_string())).await;
/// match result {
///     Ok(output) => println!("Command output: {}", output),
///     Err(err) => println!("Error executing command: {}", err),
/// }
/// ```
#[tauri::command]
pub async fn execute_command(
    command: String,
    working_directory: Option<String>,
) -> Result<String, String> {
    log_info!("Command: {}", command);
    run_shell_command(
        &command,
        working_directory.as_deref(),
        None,
        ShellFlavor::Basic,
    )
    .await
}

/// Executes a shell command with better error handling and environment setup.
/// This is an improved version of execute_command with streaming capabilities.
#[tauri::command]
pub async fn execute_command_improved(
    command: String,
    working_directory: Option<String>,
) -> Result<String, String> {
    log_info!("Improved Command: {}", command);
    run_shell_command(
        &command,
        working_directory.as_deref(),
        None,
        ShellFlavor::Improved,
    )
    .await
}

/// Executes a shell command with timeout support for long-running commands.
/// This version handles commands like ping that might run indefinitely.
#[tauri::command]
pub async fn execute_command_with_timeout(
    command: String,
    working_directory: Option<String>,
    timeout_seconds: Option<u64>,
) -> Result<String, String> {
    log_info!("Command with timeout: {}", command);
    let _ = extract_first_token(&command)?;
    let prepared_command = prepare_ping_command(&command, cfg!(target_os = "windows"));
    let timeout_duration = Duration::from_secs(timeout_seconds.unwrap_or(30));

    run_shell_command(
        &prepared_command,
        working_directory.as_deref(),
        Some(timeout_duration),
        ShellFlavor::Improved,
    )
    .await
}

#[cfg(test)]
mod command_exec_tests {
    use super::*;
    use serde_json::from_str;

    #[cfg(unix)]
    #[tokio::test]
    async fn echo_command_test_unix() {
        let result = execute_command("echo hello world".to_string(), None).await;
        assert!(result.is_ok());

        let json_result = result.unwrap();
        let command_response: CommandResponse = from_str(&json_result).unwrap();
        assert_eq!(command_response.stdout.trim(), "hello world");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ls_command_test_unix() {
        let result = execute_command("ls -la".to_string(), None).await;
        assert!(result.is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn working_directory_test_unix() {
        let result = execute_command("pwd".to_string(), Some("/tmp".to_string())).await;
        assert!(result.is_ok());

        let json_result = result.unwrap();
        let command_response: CommandResponse = from_str(&json_result).unwrap();
        assert!(command_response.stdout.contains("/tmp"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn echo_command_test_windows() {
        let result = execute_command("echo hello world".to_string(), None).await;
        assert!(result.is_ok());

        let json_result = result.unwrap();
        let command_response: CommandResponse = from_str(&json_result).unwrap();

        assert_eq!(command_response.stdout.trim(), "hello world");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn dir_command_test_windows() {
        let result = execute_command("dir".to_string(), None).await;
        assert!(result.is_ok());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn working_directory_test_windows() {
        let result = execute_command("cd".to_string(), Some("C:\\".to_string())).await;
        assert!(result.is_ok());
    }

    #[test]
    fn ping_sanitization_tp_sec_01() {
        assert_eq!(
            prepare_ping_command("ping 127.0.0.1", true),
            "ping 127.0.0.1 -n 4"
        );
        assert_eq!(
            prepare_ping_command("ping 127.0.0.1", false),
            "ping 127.0.0.1 -c 4"
        );
        assert_eq!(
            prepare_ping_command("ping 127.0.0.1 && echo marker", true),
            "ping 127.0.0.1 && echo marker"
        );
        assert_eq!(
            prepare_ping_command("ping 127.0.0.1 && echo marker", false),
            "ping 127.0.0.1 && echo marker"
        );
        assert_eq!(
            prepare_ping_command("ping -t 127.0.0.1", true),
            "ping -t 127.0.0.1"
        );
        assert_eq!(
            prepare_ping_command("ping -n 2 127.0.0.1", true),
            "ping -n 2 127.0.0.1"
        );
        assert_eq!(
            prepare_ping_command("ping -c 2 127.0.0.1", false),
            "ping -c 2 127.0.0.1"
        );
        assert_eq!(
            prepare_ping_command("ping 127.0.0.1; echo x", false),
            "ping 127.0.0.1; echo x"
        );
        assert_eq!(
            prepare_ping_command("ping 127.0.0.1 | cat", false),
            "ping 127.0.0.1 | cat"
        );
        assert_eq!(
            prepare_ping_command("ping 127.0.0.1 > out.txt", false),
            "ping 127.0.0.1 > out.txt"
        );
        assert_eq!(
            prepare_ping_command("ping 127.0.0.1\necho x", false),
            "ping 127.0.0.1\necho x"
        );
        assert_eq!(prepare_ping_command("ping", true), "ping");
    }

    #[tokio::test]
    async fn compound_ping_does_not_append_count_to_trailing_command_tp_sec_01() {
        let cmd = if cfg!(target_os = "windows") {
            "ping -n 1 127.0.0.1 | Out-Null; Write-Output 'marker'".to_string()
        } else {
            "ping 127.0.0.1 >/dev/null 2>&1; echo marker".to_string()
        };
        let res = execute_command_with_timeout(cmd, None, Some(10))
            .await
            .expect("compound command should succeed");
        let parsed: CommandResponse = from_str(&res).expect("valid CommandResponse JSON");
        assert_eq!(parsed.stdout.trim(), "marker");
    }

    #[test]
    fn working_directory_falls_back_to_home_tp_be_04() {
        let expected_home = home::home_dir().filter(|p| p.exists() && p.is_dir());
        assert_eq!(resolve_working_directory(None), expected_home);
        assert_eq!(
            resolve_working_directory(Some("/nonexistent_explr_dir_987654")),
            expected_home
        );
    }

    #[tokio::test]
    async fn read_stream_capped_truncates_and_drains() {
        let data = vec![b'a'; 1024];
        let (buf, truncated) = read_stream_capped(std::io::Cursor::new(data), 128)
            .await
            .expect("capped read succeeds");
        assert_eq!(buf.len(), 128);
        assert!(truncated);
        let formatted = format_capped_output(buf, truncated);
        assert!(formatted.contains("[output truncated at 2 MiB]"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_child_process_tp_be_04() {
        let tmp = tempfile::TempDir::new().expect("create temp dir");
        let pid_file = tmp.path().join("child.pid");
        let cmd = format!("echo $$ > \"{}\"; sleep 30", pid_file.display());

        let result = execute_command_with_timeout(cmd, None, Some(1)).await;
        assert!(result.is_err(), "sleep 30 should time out");
        let err = result.unwrap_err();
        assert!(err.contains("timed out"), "unexpected error: {err}");

        if let Ok(pid_str) = std::fs::read_to_string(&pid_file) {
            if let Ok(pid) = pid_str.trim().parse::<u32>() {
                let alive = std::process::Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                assert!(!alive, "timed-out child PID {pid} should be terminated");
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn timeout_kills_child_process_tp_be_04() {
        let tmp = tempfile::TempDir::new().expect("create temp dir");
        let pid_file = tmp.path().join("child.pid");
        let cmd = format!(
            "$PID | Set-Content -Path '{}'; Start-Sleep -Seconds 30",
            pid_file.display()
        );

        let result = execute_command_with_timeout(cmd, None, Some(2)).await;
        assert!(result.is_err(), "Start-Sleep 30 should time out");
        let err = result.unwrap_err();
        assert!(err.contains("timed out"), "unexpected error: {err}");

        if let Ok(pid_str) = std::fs::read_to_string(&pid_file) {
            if let Ok(pid) = pid_str.trim().parse::<u32>() {
                use std::os::windows::process::CommandExt;
                let out = std::process::Command::new("tasklist")
                    .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .expect("run tasklist");
                let text = String::from_utf8_lossy(&out.stdout);
                assert!(
                    !text.contains(&pid.to_string()),
                    "timed-out child PID {pid} should be terminated, tasklist: {text}"
                );
            }
        }
    }
}
