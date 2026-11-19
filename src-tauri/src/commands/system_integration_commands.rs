#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
#[cfg(target_os = "windows")]
use std::process::Command;
use std::sync::OnceLock;

pub static INITIAL_CLI_PATH: OnceLock<String> = OnceLock::new();

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const EXPLORER_CLSID: &str = "{52205fd8-5dfb-447d-801a-d0b52f2e83e1}";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn check_reg_output(
    context: &str,
    output: std::process::Output,
) -> Result<std::process::Output, String> {
    if output.status.success() {
        Ok(output)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "no error output".to_string()
        };
        let code_str = output
            .status
            .code()
            .map_or_else(|| "unknown".to_string(), |c| c.to_string());
        Err(format!(
            "reg {context} failed (exit code {code_str}): {detail}"
        ))
    }
}

#[cfg(target_os = "windows")]
fn run_reg(args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("reg");
    cmd.args(args);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|e| format!("Failed to execute reg: {e}"))?;
    check_reg_output(&args.join(" "), out)
}

#[cfg(target_os = "windows")]
fn query_reg_if_exists(key: &str, value_flag: Option<&str>) -> Result<Option<String>, String> {
    let mut cmd = Command::new("reg");
    cmd.arg("query").arg(key);
    if let Some(flag) = value_flag {
        cmd.arg(flag);
    }
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|e| format!("Failed to execute reg: {e}"))?;
    if out.status.success() {
        Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
    } else {
        Ok(None)
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn clsid_root_key() -> String {
    format!("HKCU\\Software\\Classes\\CLSID\\{EXPLORER_CLSID}")
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn clsid_command_keys() -> [String; 2] {
    [
        format!("HKCU\\Software\\Classes\\CLSID\\{EXPLORER_CLSID}\\shell\\opennewwindow\\command"),
        format!("HKCU\\Software\\Classes\\CLSID\\{EXPLORER_CLSID}\\shell\\open\\command"),
    ]
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn extract_reg_default_command(reg_stdout: &str) -> Option<String> {
    for line in reg_stdout.lines() {
        for reg_type in ["REG_EXPAND_SZ", "REG_SZ"] {
            if let Some(pos) = line.find(reg_type) {
                let value_name = line[..pos].trim();
                if value_name.eq_ignore_ascii_case("DelegateExecute") {
                    continue;
                }
                let val = line[pos + reg_type.len()..].trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn extract_executable_from_command(cmd_line: &str) -> Option<String> {
    let trimmed = cmd_line.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        let end = rest.find('"')?;
        let exe = rest[..end].trim();
        if exe.is_empty() {
            None
        } else {
            Some(exe.to_string())
        }
    } else {
        let exe = trimmed.split_whitespace().next()?;
        if exe.is_empty() {
            None
        } else {
            Some(exe.to_string())
        }
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn normalize_win_path_for_compare(path: &str) -> String {
    path.trim().replace('/', "\\").to_ascii_lowercase()
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn exe_file_name_lower(exe_str: &str) -> String {
    exe_str
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_explr_registered_command(
    reg_stdout: &str,
    current_exe: Option<&Path>,
    require_exact_current_exe: bool,
) -> bool {
    let Some(cmd_line) = extract_reg_default_command(reg_stdout) else {
        return false;
    };
    let Some(exe_str) = extract_executable_from_command(&cmd_line) else {
        return false;
    };

    if let Some(cur) = current_exe {
        let cur_norm = normalize_win_path_for_compare(&cur.to_string_lossy());
        let reg_norm = normalize_win_path_for_compare(&exe_str);
        if reg_norm == cur_norm {
            return true;
        }
        if require_exact_current_exe {
            return false;
        }
    }

    let file_name = exe_file_name_lower(&exe_str);
    file_name == "explr.exe" || file_name == "explr"
}

/// Returns the path provided via CLI arguments when Explr was launched (if any).
#[tauri::command]
pub fn get_initial_cli_path() -> Option<String> {
    INITIAL_CLI_PATH.get().cloned()
}

/// Checks whether Explr is set as the default file manager for folders on Windows.
#[tauri::command]
pub fn is_default_file_manager() -> bool {
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = run_reg(&[
            "query",
            "HKCU\\Software\\Classes\\Directory\\shell\\open\\command",
            "/ve",
        ]) {
            let text = String::from_utf8_lossy(&out.stdout);
            let current_exe = std::env::current_exe().ok();
            return is_explr_registered_command(&text, current_exe.as_deref(), true);
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Sets or removes Explr as the default file manager for folders on Windows (HKCU).
#[tauri::command]
pub fn set_default_file_manager(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if enable {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let exe_str = exe.to_string_lossy();
            let cmd_with_param = format!("\"{exe_str}\" \"%1\"");
            let cmd_bare = format!("\"{exe_str}\"");

            let folder_keys = [
                "HKCU\\Software\\Classes\\Directory\\shell\\open\\command",
                "HKCU\\Software\\Classes\\Folder\\shell\\open\\command",
                "HKCU\\Software\\Classes\\Folder\\shell\\opennewwindow\\command",
                "HKCU\\Software\\Classes\\Drive\\shell\\open\\command",
            ];

            for key in folder_keys {
                run_reg(&[
                    "add",
                    key,
                    "/ve",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &cmd_with_param,
                    "/f",
                ])?;
                // Blank out DelegateExecute so Windows does not delegate to native explorer COM handler
                run_reg(&[
                    "add",
                    key,
                    "/v",
                    "DelegateExecute",
                    "/t",
                    "REG_SZ",
                    "/d",
                    "",
                    "/f",
                ])?;
            }

            // Win+E and Windows Shell CLSID redirection ({52205fd8-5dfb-447d-801a-d0b52f2e83e1})
            let clsid_keys = clsid_command_keys();
            for key in &clsid_keys {
                run_reg(&["add", key, "/ve", "/t", "REG_SZ", "/d", &cmd_bare, "/f"])?;
                run_reg(&[
                    "add",
                    key,
                    "/v",
                    "DelegateExecute",
                    "/t",
                    "REG_SZ",
                    "/d",
                    "",
                    "/f",
                ])?;
            }

            // Set default verbs
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Directory\\shell",
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                "open",
                "/f",
            ])?;
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Folder\\shell",
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                "open",
                "/f",
            ])?;
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Drive\\shell",
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                "open",
                "/f",
            ])?;
        } else {
            let current_exe = std::env::current_exe().ok();
            let shell_open_pairs = [
                (
                    "HKCU\\Software\\Classes\\Directory\\shell\\open",
                    Some("HKCU\\Software\\Classes\\Directory\\shell"),
                ),
                (
                    "HKCU\\Software\\Classes\\Folder\\shell\\open",
                    Some("HKCU\\Software\\Classes\\Folder\\shell"),
                ),
                (
                    "HKCU\\Software\\Classes\\Folder\\shell\\opennewwindow",
                    None,
                ),
                (
                    "HKCU\\Software\\Classes\\Drive\\shell\\open",
                    Some("HKCU\\Software\\Classes\\Drive\\shell"),
                ),
            ];

            for (open_key, shell_key_opt) in shell_open_pairs {
                let cmd_key = format!("{open_key}\\command");
                if let Some(stdout) = query_reg_if_exists(&cmd_key, Some("/ve"))? {
                    if is_explr_registered_command(&stdout, current_exe.as_deref(), false) {
                        run_reg(&["delete", open_key, "/f"])?;
                        if let Some(shell_key) = shell_key_opt {
                            if let Some(shell_stdout) = query_reg_if_exists(shell_key, Some("/ve"))?
                            {
                                if extract_reg_default_command(&shell_stdout)
                                    .is_some_and(|v| v.eq_ignore_ascii_case("open"))
                                {
                                    run_reg(&["delete", shell_key, "/ve", "/f"])?;
                                }
                            }
                        }
                    }
                }
            }

            let clsid_subkeys = [
                format!("HKCU\\Software\\Classes\\CLSID\\{EXPLORER_CLSID}\\shell\\opennewwindow"),
                format!("HKCU\\Software\\Classes\\CLSID\\{EXPLORER_CLSID}\\shell\\open"),
            ];
            let mut deleted_any_clsid = false;
            let mut has_third_party_clsid = false;

            for subkey in &clsid_subkeys {
                let cmd_key = format!("{subkey}\\command");
                if let Some(stdout) = query_reg_if_exists(&cmd_key, Some("/ve"))? {
                    if is_explr_registered_command(&stdout, current_exe.as_deref(), false) {
                        run_reg(&["delete", subkey, "/f"])?;
                        deleted_any_clsid = true;
                    } else {
                        has_third_party_clsid = true;
                    }
                }
            }

            let clsid_root = clsid_root_key();
            if deleted_any_clsid
                && !has_third_party_clsid
                && query_reg_if_exists(&clsid_root, None)?.is_some()
            {
                run_reg(&["delete", &clsid_root, "/f"])?;
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enable;
        Err("Default file manager integration is currently supported on Windows.".to_string())
    }
}

/// Checks whether the "Open in Explr" Windows context menu option is registered.
#[tauri::command]
pub fn is_context_menu_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = run_reg(&[
            "query",
            "HKCU\\Software\\Classes\\Directory\\shell\\Explr\\command",
            "/ve",
        ]) {
            let text = String::from_utf8_lossy(&out.stdout);
            let current_exe = std::env::current_exe().ok();
            return is_explr_registered_command(&text, current_exe.as_deref(), true);
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Adds or removes "Open in Explr" in the Windows right-click context menu (HKCU).
#[tauri::command]
pub fn set_context_menu_enabled(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if enable {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let exe_str = exe.to_string_lossy();
            let cmd = format!("\"{exe_str}\" \"%1\"");
            let bg_cmd = format!("\"{exe_str}\" \"%V\"");
            let icon = format!("\"{exe_str}\"");

            // Directory right click
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Directory\\shell\\Explr",
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                "Open in Explr",
                "/f",
            ])?;
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Directory\\shell\\Explr",
                "/v",
                "Icon",
                "/t",
                "REG_SZ",
                "/d",
                &icon,
                "/f",
            ])?;
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Directory\\shell\\Explr\\command",
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &cmd,
                "/f",
            ])?;

            // Directory background right click (clicking empty area inside folder)
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Explr",
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                "Open in Explr",
                "/f",
            ])?;
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Explr",
                "/v",
                "Icon",
                "/t",
                "REG_SZ",
                "/d",
                &icon,
                "/f",
            ])?;
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Explr\\command",
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &bg_cmd,
                "/f",
            ])?;

            // Drive right click
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Drive\\shell\\Explr",
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                "Open in Explr",
                "/f",
            ])?;
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Drive\\shell\\Explr",
                "/v",
                "Icon",
                "/t",
                "REG_SZ",
                "/d",
                &icon,
                "/f",
            ])?;
            run_reg(&[
                "add",
                "HKCU\\Software\\Classes\\Drive\\shell\\Explr\\command",
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &cmd,
                "/f",
            ])?;
        } else {
            for key in [
                "HKCU\\Software\\Classes\\Directory\\shell\\Explr",
                "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Explr",
                "HKCU\\Software\\Classes\\Drive\\shell\\Explr",
            ] {
                if query_reg_if_exists(key, None)?.is_some() {
                    run_reg(&["delete", key, "/f"])?;
                }
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enable;
        Err("Context menu integration is currently supported on Windows.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_cli_path() {
        let path = get_initial_cli_path();
        // Just verify it doesn't panic
        let _ = path;
    }

    #[test]
    fn test_explorer_clsid_is_correct_tp_be_07() {
        assert_eq!(EXPLORER_CLSID, "{52205fd8-5dfb-447d-801a-d0b52f2e83e1}");
        let keys = clsid_command_keys();
        assert!(keys
            .iter()
            .all(|k| k.contains("{52205fd8-5dfb-447d-801a-d0b52f2e83e1}")));
        assert!(keys
            .iter()
            .all(|k| !k.contains("{52205a2e-433a-4467-b50a-81eb16016149}")));
    }

    #[test]
    fn test_check_reg_output_propagates_non_zero_exit_tp_be_07() {
        let fail_out = if cfg!(target_os = "windows") {
            std::process::Command::new("cmd")
                .args(["/C", "echo Access is denied 1>&2 & exit /b 1"])
                .output()
                .expect("run cmd")
        } else {
            std::process::Command::new("sh")
                .args(["-c", "echo 'Access is denied' >&2; exit 1"])
                .output()
                .expect("run sh")
        };

        let err = check_reg_output("add HKCU\\Test", fail_out)
            .expect_err("non-zero exit code must return Err");
        assert!(err.contains("exit code 1"), "unexpected error: {err}");
        assert!(err.contains("Access is denied"), "unexpected error: {err}");

        let ok_out = if cfg!(target_os = "windows") {
            std::process::Command::new("cmd")
                .args(["/C", "exit /b 0"])
                .output()
                .expect("run cmd")
        } else {
            std::process::Command::new("sh")
                .args(["-c", "exit 0"])
                .output()
                .expect("run sh")
        };
        assert!(check_reg_output("query HKCU\\Test", ok_out).is_ok());
    }

    #[test]
    fn test_registry_command_ownership_matching() {
        let current_exe = Path::new("C:\\Program Files\\Explr\\explr.exe");
        let matching_reg = r#"
HKEY_CURRENT_USER\Software\Classes\Directory\shell\open\command
    (Default)    REG_SZ    "C:\Program Files\Explr\explr.exe" "%1"
    DelegateExecute    REG_SZ    
"#;
        assert!(is_explr_registered_command(
            matching_reg,
            Some(current_exe),
            true
        ));
        assert!(is_explr_registered_command(
            matching_reg,
            Some(current_exe),
            false
        ));

        let false_positive_dir_reg = r#"
HKEY_CURRENT_USER\Software\Classes\Directory\shell\open\command
    (Default)    REG_SZ    "C:\explr_backup\other.exe" "%1"
"#;
        assert!(!is_explr_registered_command(
            false_positive_dir_reg,
            Some(current_exe),
            true
        ));
        assert!(!is_explr_registered_command(
            false_positive_dir_reg,
            Some(current_exe),
            false
        ));

        let different_explr_path = r#"
HKEY_CURRENT_USER\Software\Classes\Directory\shell\open\command
    (Default)    REG_SZ    C:\Users\dev\explr.exe "%1"
"#;
        assert!(!is_explr_registered_command(
            different_explr_path,
            Some(current_exe),
            true
        ));
        assert!(is_explr_registered_command(
            different_explr_path,
            Some(current_exe),
            false
        ));
    }
}
