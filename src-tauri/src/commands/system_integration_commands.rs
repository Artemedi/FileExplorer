use std::process::Command;
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub static INITIAL_CLI_PATH: OnceLock<String> = OnceLock::new();

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
fn run_reg(args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("reg");
    cmd.args(args);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output().map_err(|e| e.to_string())
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
        if let Ok(out) = run_reg(&["query", "HKCU\\Software\\Classes\\Directory\\shell\\open\\command"]) {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
                return text.contains("explr");
            }
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
            let cmd = format!("\"{}\" \"%1\"", exe_str);

            for key in [
                "HKCU\\Software\\Classes\\Directory\\shell\\open\\command",
                "HKCU\\Software\\Classes\\Folder\\shell\\open\\command",
                "HKCU\\Software\\Classes\\Drive\\shell\\open\\command",
            ] {
                let out = run_reg(&["add", key, "/ve", "/t", "REG_SZ", "/d", &cmd, "/f"])?;
                if !out.status.success() {
                    let err = String::from_utf8_lossy(&out.stderr);
                    return Err(format!("Failed to register {}: {}", key, err));
                }
            }
        } else {
            for key in [
                "HKCU\\Software\\Classes\\Directory\\shell\\open",
                "HKCU\\Software\\Classes\\Folder\\shell\\open",
                "HKCU\\Software\\Classes\\Drive\\shell\\open",
            ] {
                let _ = run_reg(&["delete", key, "/f"]);
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
        if let Ok(out) = run_reg(&["query", "HKCU\\Software\\Classes\\Directory\\shell\\Explr"]) {
            return out.status.success();
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
            let cmd = format!("\"{}\" \"%1\"", exe_str);
            let bg_cmd = format!("\"{}\" \"%V\"", exe_str);
            let icon = format!("\"{}\"", exe_str);

            // Directory right click
            run_reg(&["add", "HKCU\\Software\\Classes\\Directory\\shell\\Explr", "/ve", "/t", "REG_SZ", "/d", "Open in Explr", "/f"])?;
            run_reg(&["add", "HKCU\\Software\\Classes\\Directory\\shell\\Explr", "/v", "Icon", "/t", "REG_SZ", "/d", &icon, "/f"])?;
            run_reg(&["add", "HKCU\\Software\\Classes\\Directory\\shell\\Explr\\command", "/ve", "/t", "REG_SZ", "/d", &cmd, "/f"])?;

            // Directory background right click (clicking empty area inside folder)
            run_reg(&["add", "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Explr", "/ve", "/t", "REG_SZ", "/d", "Open in Explr", "/f"])?;
            run_reg(&["add", "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Explr", "/v", "Icon", "/t", "REG_SZ", "/d", &icon, "/f"])?;
            run_reg(&["add", "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Explr\\command", "/ve", "/t", "REG_SZ", "/d", &bg_cmd, "/f"])?;

            // Drive right click
            run_reg(&["add", "HKCU\\Software\\Classes\\Drive\\shell\\Explr", "/ve", "/t", "REG_SZ", "/d", "Open in Explr", "/f"])?;
            run_reg(&["add", "HKCU\\Software\\Classes\\Drive\\shell\\Explr", "/v", "Icon", "/t", "REG_SZ", "/d", &icon, "/f"])?;
            run_reg(&["add", "HKCU\\Software\\Classes\\Drive\\shell\\Explr\\command", "/ve", "/t", "REG_SZ", "/d", &cmd, "/f"])?;
        } else {
            for key in [
                "HKCU\\Software\\Classes\\Directory\\shell\\Explr",
                "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Explr",
                "HKCU\\Software\\Classes\\Drive\\shell\\Explr",
            ] {
                let _ = run_reg(&["delete", key, "/f"]);
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
}
