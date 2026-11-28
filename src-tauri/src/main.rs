// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
pub mod constants;
mod error_handling;
mod filesystem;
pub mod models;
mod search_engine;
mod state;

use crate::commands::{
    clipboard_commands, command_exec_commands, file_system_operation_commands, hash_commands,
    meta_data_commands, permission_commands, preview_commands, search_engine_commands,
    settings_commands, sftp_file_system_operation_commands, ssh_commands,
    system_integration_commands, template_commands, terminal_window_commands,
    volume_operations_commands, watcher_commands,
};
use std::path::{Component, Path, PathBuf};
use tauri::ipc::Invoke;
use tauri::{Emitter, Manager};

fn all_commands() -> fn(Invoke) -> bool {
    tauri::generate_handler![
        // Filesystem commands
        file_system_operation_commands::open_file,
        file_system_operation_commands::open_directory,
        file_system_operation_commands::open_in_default_app,
        file_system_operation_commands::create_file,
        file_system_operation_commands::create_directory,
        file_system_operation_commands::rename,
        file_system_operation_commands::move_to_trash,
        file_system_operation_commands::copy_file_or_dir,
        file_system_operation_commands::zip,
        file_system_operation_commands::unzip,
        // Command execution commands
        command_exec_commands::execute_command,
        command_exec_commands::execute_command_improved,
        command_exec_commands::execute_command_with_timeout,
        // Metadata commands
        meta_data_commands::get_meta_data_as_json,
        meta_data_commands::update_meta_data,
        // Volume commands
        volume_operations_commands::get_system_volumes_information_as_json,
        volume_operations_commands::get_system_volumes_information,
        volume_operations_commands::eject_volume,
        volume_operations_commands::connect_network_share,
        volume_operations_commands::get_physical_disks_info,
        volume_operations_commands::get_supported_filesystems,
        volume_operations_commands::get_partition_supported_size,
        volume_operations_commands::format_partition,
        volume_operations_commands::create_partition,
        volume_operations_commands::delete_partition,
        volume_operations_commands::resize_partition,
        volume_operations_commands::initialize_disk,
        volume_operations_commands::create_disk_image,
        volume_operations_commands::clone_or_restore_disk,
        volume_operations_commands::check_network_endpoints,
        volume_operations_commands::get_user_directories,
        // Settings commands
        settings_commands::get_settings_as_json,
        settings_commands::update_settings_field,
        settings_commands::get_setting_field,
        settings_commands::update_multiple_settings_command,
        settings_commands::reset_settings_command,
        // Hash commands
        hash_commands::gen_hash_and_return_string,
        hash_commands::gen_hash_and_save_to_file,
        hash_commands::compare_file_or_dir_with_hash,
        // Template commands
        template_commands::get_template_paths_as_json,
        template_commands::add_template,
        template_commands::use_template,
        template_commands::remove_template,
        // Autocomplete commands
        search_engine_commands::search,
        search_engine_commands::search_with_extension,
        search_engine_commands::add_paths_recursive,
        search_engine_commands::add_path,
        search_engine_commands::remove_path,
        search_engine_commands::remove_paths_recursive,
        search_engine_commands::clear_search_engine,
        search_engine_commands::get_search_engine_info,
        search_engine_commands::add_paths_recursive_async,
        search_engine_commands::get_indexing_progress,
        search_engine_commands::get_indexing_status,
        search_engine_commands::stop_indexing,
        search_engine_commands::get_suggestions,
        search_engine_commands::set_search_current_directory,
        // Preview commands
        preview_commands::build_preview,
        //sftp commands
        sftp_file_system_operation_commands::load_dir,
        sftp_file_system_operation_commands::open_file_sftp,
        sftp_file_system_operation_commands::create_file_sftp,
        sftp_file_system_operation_commands::delete_file_sftp,
        sftp_file_system_operation_commands::rename_file_sftp,
        sftp_file_system_operation_commands::copy_file_sftp,
        sftp_file_system_operation_commands::move_file_sftp,
        sftp_file_system_operation_commands::create_directory_sftp,
        sftp_file_system_operation_commands::delete_directory_sftp,
        sftp_file_system_operation_commands::rename_directory_sftp,
        sftp_file_system_operation_commands::copy_directory_sftp,
        sftp_file_system_operation_commands::move_directory_sftp,
        sftp_file_system_operation_commands::build_preview_sftp,
        sftp_file_system_operation_commands::download_and_open_sftp_file,
        sftp_file_system_operation_commands::cleanup_sftp_temp_files,
        sftp_file_system_operation_commands::store_sftp_credentials,
        sftp_file_system_operation_commands::remove_sftp_credentials,
        sftp_file_system_operation_commands::has_sftp_credentials,
        sftp_file_system_operation_commands::trust_sftp_host_key,
        sftp_file_system_operation_commands::store_ssh_profile,
        // SSH terminal, sudo, and compression commands
        ssh_commands::ssh_execute_command,
        ssh_commands::ssh_sudo_exec,
        ssh_commands::ssh_probe_zstd,
        ssh_commands::ssh_start_pty,
        ssh_commands::ssh_write_pty,
        ssh_commands::ssh_write_pty_response,
        ssh_commands::ssh_resize_pty,
        ssh_commands::ssh_close_pty,
        ssh_commands::ssh_clear_pty_view,
        terminal_window_commands::ssh_detach_pty,
        terminal_window_commands::ssh_detached_read,
        terminal_window_commands::ssh_detached_ready,
        terminal_window_commands::ssh_attach_pty,
        terminal_window_commands::ssh_focus_detached,
        terminal_window_commands::ssh_pty_view_status,
        ssh_commands::open_external_ssh_terminal,
        // Permission commands
        permission_commands::request_full_disk_access,
        permission_commands::check_directory_access,
        // Watcher commands
        watcher_commands::watch_directory,
        watcher_commands::unwatch_directory,
        // System integration commands
        system_integration_commands::get_initial_cli_path,
        system_integration_commands::is_default_file_manager,
        system_integration_commands::set_default_file_manager,
        system_integration_commands::is_context_menu_enabled,
        system_integration_commands::set_context_menu_enabled,
        // System clipboard commands
        clipboard_commands::clipboard_set_files,
        clipboard_commands::clipboard_get_files,
        clipboard_commands::clipboard_sequence_number,
    ]
}

fn normalize_cli_path_arg(raw: &str) -> String {
    if let Some(stripped) = raw.strip_suffix('"') {
        if stripped.ends_with(':') {
            return format!("{stripped}\\");
        }
        return stripped.to_string();
    }
    raw.to_string()
}

fn clean_absolute_path(path: &Path, cwd: Option<&Path>) -> Option<PathBuf> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else if let Some(base) = cwd {
        base.join(path)
    } else {
        std::env::current_dir().ok()?.join(path)
    };

    let mut cleaned = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(cleaned.components().next_back(), Some(Component::Normal(_))) {
                    cleaned.pop();
                }
            }
            other => cleaned.push(other),
        }
    }
    Some(cleaned)
}

fn resolve_existing_cli_candidate(raw: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let direct = clean_absolute_path(Path::new(raw), cwd)?;
    if direct.exists() {
        return Some(direct);
    }

    if raw.ends_with('"') {
        let normalized = normalize_cli_path_arg(raw);
        let candidate = clean_absolute_path(Path::new(&normalized), cwd)?;
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn extract_startup_target_path_with_cwd(args: &[String], cwd: Option<&Path>) -> Option<String> {
    for arg in args.iter().skip(1) {
        if arg.is_empty() || arg.starts_with('-') {
            continue;
        }
        if let Some(resolved) = resolve_existing_cli_candidate(arg, cwd) {
            let target = if resolved.is_file() {
                resolved
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .map(|p| p.to_string_lossy().into_owned())
            } else {
                Some(resolved.to_string_lossy().into_owned())
            };
            if let Some(t) = target.filter(|s| !s.is_empty()) {
                return Some(t);
            }
        }
    }
    None
}

pub fn extract_startup_target_path(args: &[String]) -> Option<String> {
    let cwd = std::env::current_dir().ok();
    extract_startup_target_path_with_cwd(args, cwd.as_deref())
}

#[cfg(any(target_os = "linux", test))]
fn compute_linux_graphics_env_overrides(
    is_wayland: bool,
    has_nvidia: bool,
    has_gdk_backend: bool,
    has_dmabuf_disable: bool,
) -> Vec<(&'static str, &'static str)> {
    let mut overrides = Vec::new();
    if has_nvidia {
        if !has_dmabuf_disable {
            overrides.push(("WEBKIT_DISABLE_DMABUF_RENDERER", "1"));
        }
        if is_wayland && !has_gdk_backend {
            overrides.push(("GDK_BACKEND", "x11"));
        }
    }
    overrides
}

#[cfg(target_os = "linux")]
fn detect_nvidia_gpu_linux() -> bool {
    if Path::new("/proc/driver/nvidia/version").exists() || Path::new("/dev/nvidia0").exists() {
        return true;
    }
    if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
        for entry in entries.flatten() {
            let vendor_path = entry.path().join("device/vendor");
            if let Ok(vendor) = std::fs::read_to_string(vendor_path) {
                if vendor.trim().eq_ignore_ascii_case("0x10de") {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn configure_linux_graphics_environment() {
    let is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);
    let has_nvidia = detect_nvidia_gpu_linux();
    let has_gdk_backend = std::env::var_os("GDK_BACKEND").is_some();
    let has_dmabuf_disable = std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some();

    let overrides = compute_linux_graphics_env_overrides(
        is_wayland,
        has_nvidia,
        has_gdk_backend,
        has_dmabuf_disable,
    );
    for (key, val) in overrides {
        // SAFETY: Called in main() before spawning threads or initializing GTK/WebKit.
        unsafe {
            std::env::set_var(key, val);
        }
        eprintln!("[explr] NVIDIA/Wayland WebKitGTK workaround: {key}={val}");
    }
}

#[tokio::main]
async fn main() {
    #[cfg(target_os = "linux")]
    configure_linux_graphics_environment();

    // Parse startup CLI arguments (e.g. explr.exe "C:\Path")
    let raw_args: Vec<String> = std::env::args().collect();
    if let Some(target) = extract_startup_target_path(&raw_args) {
        let _ = commands::system_integration_commands::INITIAL_CLI_PATH.set(target);
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Focus the running window when a second instance is launched
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // Check if second instance was called with a path to open
            if let Some(target) = extract_startup_target_path(&args) {
                let _ = app.emit("open-path-requested", target);
            }
        }))
        .invoke_handler(all_commands())
        .on_window_event(terminal_window_commands::handle_window_event)
        .setup(|app| {
            // Safely show/focus the main window if it exists
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            // Clean up old SFTP temporary files on startup
            tokio::spawn(async {
                if let Err(e) =
                    commands::sftp_file_system_operation_commands::cleanup_sftp_temp_files()
                {
                    eprintln!("Failed to cleanup SFTP temp files: {e}");
                }
            });

            Ok(())
        });

    let app = state::setup_app_state(app);

    log_info!("Starting Tauri application...");

    if let Err(err) = app.run(tauri::generate_context!()) {
        log_critical!("error while running tauri application: {}", err);
        panic!("error while running tauri application: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_cli_path_arg_windows_root_quote_tp_be_07() {
        assert_eq!(normalize_cli_path_arg("C:\""), "C:\\");
        assert_eq!(normalize_cli_path_arg("D:\""), "D:\\");
        assert_eq!(
            normalize_cli_path_arg("C:\\Users\\Test\""),
            "C:\\Users\\Test"
        );
        assert_eq!(normalize_cli_path_arg("C:\\Users\\Test"), "C:\\Users\\Test");
    }

    #[test]
    fn test_extract_startup_target_path_directory_and_relative_file_tp_be_07() {
        let tmp = tempfile::TempDir::new().expect("create temp dir");
        let dir_path = tmp.path();
        let file_path = dir_path.join("rel.txt");
        std::fs::write(&file_path, b"hello").expect("write test file");

        // 1. Directory argument with trailing escaped quote (simulating Windows `"%1"` on `"dir\"`)
        let quoted_dir_arg = format!("{}\"", dir_path.display());
        let args_dir = vec!["explr".to_string(), "--flag".to_string(), quoted_dir_arg];
        let extracted_dir = extract_startup_target_path_with_cwd(&args_dir, Some(dir_path))
            .expect("should extract directory");
        assert_eq!(Path::new(&extracted_dir), dir_path);

        // 2. Relative file argument `"rel.txt"` must resolve to non-empty parent directory, never `""`
        let args_rel_file = vec!["explr".to_string(), "rel.txt".to_string()];
        let extracted_parent = extract_startup_target_path_with_cwd(&args_rel_file, Some(dir_path))
            .expect("should extract parent dir for relative file");
        assert!(!extracted_parent.is_empty());
        assert_eq!(Path::new(&extracted_parent), dir_path);

        // 3. Nonexistent path returns None
        let args_missing = vec![
            "explr".to_string(),
            "nonexistent_file_12345.txt".to_string(),
        ];
        assert!(extract_startup_target_path_with_cwd(&args_missing, Some(dir_path)).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn test_extract_startup_target_path_windows_drive_root_quote_tp_be_07() {
        let args = vec!["explr.exe".to_string(), "C:\"".to_string()];
        let extracted = extract_startup_target_path(&args)
            .expect("C:\" should normalize and resolve to C:\\ on Windows");
        assert_eq!(extracted, "C:\\");
    }

    #[test]
    fn test_linux_graphics_env_overrides() {
        assert_eq!(
            compute_linux_graphics_env_overrides(true, true, false, false),
            vec![
                ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
                ("GDK_BACKEND", "x11")
            ]
        );
        // Respect explicit user overrides
        assert_eq!(
            compute_linux_graphics_env_overrides(true, true, true, false),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
        // Non-NVIDIA Wayland keeps native Wayland
        assert!(compute_linux_graphics_env_overrides(true, false, false, false).is_empty());
    }
}
