use crate::error_handling::Error;
use crate::models::VolumeInformation;
use sysinfo::Disks;

/// Retrieves information about all system volumes/disks and returns it as a JSON string.
/// The information includes volume names, mount points, file systems, size, available space, etc.
///
/// # Returns
/// * `String` - A JSON string containing an array of volume information objects.
///
/// # Example
/// ```javascript
/// // From frontend JavaScript/TypeScript
/// import { invoke } from '@tauri-apps/api/tauri';
///
/// // Call the command
/// invoke('get_system_volumes_information_as_json')
///   .then((response) => {
///     // Parse the JSON string
///     const volumes = JSON.parse(response);
///     
///     // Display volume information
///     volumes.forEach(volume => {
///       console.log(`Volume: ${volume.volume_name}, Space: ${volume.available_space}/${volume.size}`);
///     });
///   })
///   .catch((error) => {
///     console.error('Error retrieving volume information:', error);
///   });
/// ```
#[tauri::command]
pub fn get_system_volumes_information_as_json() -> String {
    let volume_information_vec = get_system_volumes_information();
    serde_json::to_string(&volume_information_vec).unwrap_or_else(|_| "[]".to_string())
}

/// Gets information about all system volumes/disks.
/// Collects detailed information such as volume names, mount points, file systems,
/// total and available space, and whether the volume is removable.
/// Automatically filters out duplicate entries and boot volumes.
///
/// # Returns
/// * `Vec<VolumeInformation>` - A vector of VolumeInformation structs, each containing
///   details about a single system volume or disk.
///
/// # Example
/// ```javascript
/// // From frontend JavaScript/TypeScript
/// import { invoke } from '@tauri-apps/api/tauri';
///
/// // Call the command
/// invoke('get_system_volumes_information')
///   .then((volumes) => {
///     // Process the volume information
///     volumes.forEach(volume => {
///       console.log(`Volume: ${volume.volume_name}, Mount: ${volume.mount_point}`);
///       console.log(`File System: ${volume.file_system}`);
///       console.log(`Space: ${volume.available_space}/${volume.size} bytes`);
///     });
///   })
///   .catch((error) => {
///     console.error('Error retrieving volumes:', error);
///   });
/// ```
#[tauri::command]
pub fn get_system_volumes_information() -> Vec<VolumeInformation> {
    let mut volume_information_vec: Vec<VolumeInformation> = Vec::new();
    let disks = Disks::new_with_refreshed_list();

    for disk in &disks {
        let mount_point = disk.mount_point().to_string_lossy().into_owned();
        #[cfg(target_os = "windows")]
        let mut volume_name = disk.name().to_string_lossy().into_owned();
        #[cfg(not(target_os = "windows"))]
        let volume_name = disk.name().to_string_lossy().into_owned();

        // On Windows, if volume label is empty, provide a clean friendly name like "Local Disk (C:)"
        #[cfg(target_os = "windows")]
        if volume_name.is_empty() && !mount_point.is_empty() {
            let drive_letter = mount_point.trim_end_matches('\\');
            volume_name = format!("Local Disk ({drive_letter})");
        }

        let file_system = disk.file_system().to_str().unwrap_or("Unknown").to_owned();

        volume_information_vec.push(VolumeInformation {
            volume_name,
            mount_point,
            file_system,
            size: disk.total_space(),
            available_space: disk.available_space(),
            is_removable: disk.is_removable(),
            total_written_bytes: disk.usage().total_written_bytes,
            total_read_bytes: disk.usage().total_read_bytes,
        });
    }

    // Filter out duplicate mount points and internal virtual mounts
    let mut result: Vec<VolumeInformation> = Vec::new();
    let mut seen_mount_points = std::collections::HashSet::new();

    for volume in volume_information_vec {
        // Normalize mount point for case-insensitive duplicate check on Windows
        let norm_mount = if cfg!(target_os = "windows") {
            volume.mount_point.to_uppercase()
        } else {
            volume.mount_point.clone()
        };

        if !seen_mount_points.insert(norm_mount) {
            continue;
        }

        // On macOS, skip internal APFS firmlinks / system containers (/System/Volumes/...)
        #[cfg(target_os = "macos")]
        if volume.mount_point.starts_with("/System/Volumes") {
            continue;
        }

        // On Linux, filter out efi/boot mounts
        #[cfg(target_os = "linux")]
        if volume.mount_point == "/boot"
            || volume.mount_point.starts_with("/boot/")
            || volume.mount_point == "/efi"
            || volume.mount_point.starts_with("/efi/")
        {
            continue;
        }

        result.push(volume);
    }

    // Sort volumes: on Windows by drive letter (C:\, D:\, ...), on other platforms by mount point
    result.sort_by(|a, b| a.mount_point.cmp(&b.mount_point));

    result
}

fn normalize_mount_for_compare(mount: &str, is_windows: bool) -> String {
    let trimmed = mount.trim();
    if is_windows {
        trimmed.trim_end_matches(['\\', '/']).to_ascii_uppercase()
    } else if trimmed == "/" {
        "/".to_string()
    } else {
        trimmed.trim_end_matches('/').to_string()
    }
}

fn is_windows_drive_root(s: &str) -> bool {
    let bytes = s.as_bytes();
    (bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || (bytes.len() == 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/'))
}

fn is_root_or_system_mount(mount: &str, system_drive: &str, is_windows: bool) -> bool {
    let trimmed = mount.trim();
    if is_windows {
        let norm = trimmed.trim_end_matches(['\\', '/']).to_ascii_uppercase();
        let sys_norm = system_drive
            .trim()
            .trim_end_matches(['\\', '/'])
            .to_ascii_uppercase();
        return norm == sys_norm || norm == "C:";
    }

    let norm = if trimmed == "/" {
        "/"
    } else {
        trimmed.trim_end_matches('/')
    };
    matches!(
        norm,
        "/" | "/boot" | "/efi" | "/proc" | "/sys" | "/dev" | "/System" | "/usr" | "/var" | "/etc"
    ) || norm.starts_with("/boot/")
        || norm.starts_with("/efi/")
        || norm.starts_with("/System/")
        || norm.starts_with("/proc/")
        || norm.starts_with("/sys/")
        || norm.starts_with("/dev/")
}

fn validate_eject_mount_point_with_env(
    mount_point: &str,
    available_mounts: &[String],
    system_drive: &str,
    is_windows: bool,
) -> Result<String, Error> {
    let trimmed = mount_point.trim();
    if trimmed.is_empty() || mount_point.chars().any(|c| c == '\0' || c.is_control()) {
        return Err(Error::invalid_input("Invalid mount point"));
    }

    if is_windows && !is_windows_drive_root(trimmed) {
        return Err(Error::invalid_input(format!(
            "Invalid Windows drive mount point '{trimmed}'"
        )));
    }

    if is_root_or_system_mount(trimmed, system_drive, is_windows) {
        return Err(Error::invalid_input(format!(
            "Refusing to eject system or root mount point '{trimmed}'"
        )));
    }

    let target_norm = normalize_mount_for_compare(trimmed, is_windows);
    let matched = available_mounts
        .iter()
        .find(|m| normalize_mount_for_compare(m, is_windows) == target_norm)
        .ok_or_else(|| Error::not_found(format!("Mounted volume '{trimmed}' not found")))?;

    if is_root_or_system_mount(matched, system_drive, is_windows) {
        return Err(Error::invalid_input(format!(
            "Refusing to eject system or root mount point '{matched}'"
        )));
    }

    if is_windows {
        let letter = matched
            .trim()
            .chars()
            .next()
            .filter(|c| c.is_ascii_alphabetic())
            .ok_or_else(|| Error::invalid_input("Invalid Windows drive letter"))?;
        Ok(format!("{}:\\", letter.to_ascii_uppercase()))
    } else {
        Ok(matched.clone())
    }
}

fn validate_live_eject_mount_point(mount_point: &str) -> Result<String, Error> {
    let disks = Disks::new_with_refreshed_list();
    let available_mounts: Vec<String> = disks
        .iter()
        .map(|d| d.mount_point().to_string_lossy().into_owned())
        .collect();
    let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    validate_eject_mount_point_with_env(
        mount_point,
        &available_mounts,
        &system_drive,
        cfg!(target_os = "windows"),
    )
}

fn eject_volume_blocking(mount_point: &str) -> Result<String, String> {
    let target = validate_live_eject_mount_point(mount_point).map_err(|e| e.to_json())?;

    let output = {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("diskutil")
                .arg("eject")
                .arg(&target)
                .output()
                .map_err(|e| {
                    Error::internal(format!("Failed to execute diskutil: {e}")).to_json()
                })?
        }

        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("umount")
                .arg("--")
                .arg(&target)
                .output()
                .map_err(|e| Error::internal(format!("Failed to execute umount: {e}")).to_json())?
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let script = "$item = (New-Object -ComObject Shell.Application).Namespace(17).ParseName($env:EXPLR_EJECT_DRIVE); if ($null -eq $item) { Write-Error 'Volume not found in Shell namespace'; exit 1 }; $item.InvokeVerb('Eject')";
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("EXPLR_EJECT_DRIVE", &target)
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| {
                    Error::internal(format!("Failed to execute PowerShell eject command: {e}"))
                        .to_json()
                })?
        }
    };

    if output.status.success() {
        Ok(format!("Volume '{target}' safely ejected."))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let reason = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!(
                "exit code {}",
                output
                    .status
                    .code()
                    .map_or_else(|| "unknown".to_string(), |c| c.to_string())
            )
        };
        Err(Error::internal(format!("Failed to eject volume '{target}': {reason}")).to_json())
    }
}

/// Safely ejects a mounted volume without shell string interpolation.
#[tauri::command]
pub async fn eject_volume(mount_point: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || eject_volume_blocking(&mount_point))
        .await
        .map_err(|e| Error::internal(format!("Eject task failed: {e}")).to_json())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_info;

    #[test]
    fn test_get_volumes() {
        let volumes = get_system_volumes_information();
        assert!(!volumes.is_empty(), "Should return at least one volume");

        let volumes_as_json = get_system_volumes_information_as_json();

        //printing the JSON string for debugging
        log_info!("Volumes as JSON: {}", volumes_as_json);

        for volume in &volumes {
            log_info!("{:?}", volume);
        }
    }

    #[tokio::test]
    async fn test_eject_volume_rejects_invalid_and_root_mounts() {
        assert!(eject_volume(String::new()).await.is_err());
        assert!(eject_volume("   ".to_string()).await.is_err());
        assert!(eject_volume("C:\\ && calc.exe".to_string()).await.is_err());
        assert!(eject_volume("/Volumes/USB\"; rm -rf /; \"".to_string())
            .await
            .is_err());
        assert!(eject_volume("/".to_string()).await.is_err());
        assert!(eject_volume("C:\\".to_string()).await.is_err());
        assert!(eject_volume("/nonexistent/explr_mount_12345".to_string())
            .await
            .is_err());
    }

    #[test]
    fn test_validate_eject_mount_point_tp_sec_01() {
        let unix_mounts = vec![
            "/".to_string(),
            "/boot".to_string(),
            "/media/user/USB \"&\" $(test)".to_string(),
        ];
        assert!(validate_eject_mount_point_with_env("/", &unix_mounts, "C:", false).is_err());
        assert!(validate_eject_mount_point_with_env("/boot", &unix_mounts, "C:", false).is_err());
        assert!(validate_eject_mount_point_with_env(
            "/media/user/USB && rm -rf /",
            &unix_mounts,
            "C:",
            false,
        )
        .is_err());
        assert!(validate_eject_mount_point_with_env(
            "/media/user/USB\0bad",
            &unix_mounts,
            "C:",
            false
        )
        .is_err());

        let valid_unix = validate_eject_mount_point_with_env(
            "/media/user/USB \"&\" $(test)",
            &unix_mounts,
            "C:",
            false,
        )
        .expect("Mounted Unix volume with spaces/special chars should validate");
        assert_eq!(valid_unix, "/media/user/USB \"&\" $(test)");

        let win_mounts = vec!["C:\\".to_string(), "E:\\".to_string()];
        assert!(validate_eject_mount_point_with_env("C:\\", &win_mounts, "C:", true).is_err());
        assert!(validate_eject_mount_point_with_env("C:", &win_mounts, "C:", true).is_err());
        assert!(validate_eject_mount_point_with_env(
            "E:\\ && powershell -c calc",
            &win_mounts,
            "C:",
            true,
        )
        .is_err());
        assert!(validate_eject_mount_point_with_env("Z:\\", &win_mounts, "C:", true).is_err());
        assert_eq!(
            validate_eject_mount_point_with_env("e:", &win_mounts, "C:", true)
                .expect("Mounted Windows removable drive should validate"),
            "E:\\"
        );
    }
}
