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

/// Returns the `\\server\share` root of a UNC path (`//` separators are accepted too).
/// Returns `None` when the input has no server component.
pub fn unc_share_root(unc_path: &str) -> Option<String> {
    let normalized = unc_path.trim().replace('/', "\\");
    let stripped = normalized.trim_start_matches('\\');
    let mut parts = stripped.split('\\').filter(|p| !p.is_empty());
    let server = parts.next()?;
    match parts.next() {
        Some(share) => Some(format!("\\\\{server}\\{share}")),
        None => Some(format!("\\\\{server}")),
    }
}

/// Key under which a share password is kept in the OS keyring.
pub fn network_share_keyring_key(username: &str, share_root: &str) -> String {
    format!("smb:{}@{}", username.trim(), share_root)
}

#[cfg(target_os = "windows")]
fn wnet_add_connection(
    share_root: &str,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[repr(C)]
    struct NetResourceW {
        dw_scope: u32,
        dw_type: u32,
        dw_display_type: u32,
        dw_usage: u32,
        lp_local_name: *mut u16,
        lp_remote_name: *mut u16,
        lp_comment: *mut u16,
        lp_provider: *mut u16,
    }

    #[link(name = "mpr")]
    extern "system" {
        fn WNetAddConnection2W(
            lp_net_resource: *const NetResourceW,
            lp_password: *const u16,
            lp_user_name: *const u16,
            dw_flags: u32,
        ) -> u32;
    }

    const RESOURCETYPE_DISK: u32 = 1;
    const ERROR_SESSION_CREDENTIAL_CONFLICT: u32 = 1219;

    let to_wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(Some(0))
            .collect()
    };

    let mut remote = to_wide(share_root);
    let mut user_w = username.map(to_wide);
    let mut pass_w = password.map(to_wide);

    let resource = NetResourceW {
        dw_scope: 0,
        dw_type: RESOURCETYPE_DISK,
        dw_display_type: 0,
        dw_usage: 0,
        lp_local_name: std::ptr::null_mut(),
        lp_remote_name: remote.as_mut_ptr(),
        lp_comment: std::ptr::null_mut(),
        lp_provider: std::ptr::null_mut(),
    };

    // SAFETY: all pointers reference NUL-terminated UTF-16 buffers that stay alive for the call.
    let code = unsafe {
        WNetAddConnection2W(
            &resource,
            pass_w.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
            user_w.as_ref().map_or(std::ptr::null(), |u| u.as_ptr()),
            0,
        )
    };

    // Do not leave the password lying around in memory.
    if let Some(p) = pass_w.as_mut() {
        for unit in p.iter_mut() {
            // SAFETY: `unit` is a valid, exclusive reference.
            unsafe { std::ptr::write_volatile(unit, 0) };
        }
    }
    if let Some(u) = user_w.as_mut() {
        u.iter_mut().for_each(|c| *c = 0);
    }

    match code {
        0 => Ok(()),
        ERROR_SESSION_CREDENTIAL_CONFLICT => Err(
            "Windows already has a connection to this server with different credentials. \
             Disconnect it first (e.g. `net use \\\\server /delete`) and try again."
                .to_string(),
        ),
        other => Err(format!(
            "Could not connect to '{share_root}' (Windows error {other}). \
             Check the path, user name (DOMAIN\\user) and password."
        )),
    }
}

/// Authenticates against an SMB/UNC network share (Windows). Anonymous/domain-joined access
/// that needs no credentials does not require calling this at all.
///
/// If `password` is empty the password saved earlier in the OS keyring is used. When
/// `remember` is true and the connection succeeds, the password is saved to the keyring.
#[tauri::command]
pub async fn connect_network_share(
    unc_path: String,
    username: String,
    password: String,
    remember: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let share_root = unc_share_root(&unc_path)
            .ok_or_else(|| Error::invalid_input("Enter a path like \\\\server\\share").to_json())?;

        let user = username.trim().to_string();
        if user.is_empty() {
            // Nothing to authenticate: rely on the current Windows session.
            return Ok(());
        }

        let key = network_share_keyring_key(&user, &share_root);
        let secret: crate::commands::sftp_file_system_operation_commands::ZeroizingString =
            if password.is_empty() {
                crate::commands::sftp_file_system_operation_commands::keyring_get_password(&key)
                    .unwrap_or_else(|| {
                        crate::commands::sftp_file_system_operation_commands::ZeroizingString::new(
                            String::new(),
                        )
                    })
            } else {
                crate::commands::sftp_file_system_operation_commands::ZeroizingString::new(password)
            };

        #[cfg(target_os = "windows")]
        {
            wnet_add_connection(&share_root, Some(&user), Some(secret.as_str()))
                .map_err(|e| Error::internal(e).to_json())?;
            if remember && !secret.is_empty() {
                crate::commands::sftp_file_system_operation_commands::keyring_set_password(
                    &key,
                    secret.as_str(),
                );
            }
            Ok(())
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = (remember, secret, key);
            Err(Error::internal(
                "Credentials for network shares are handled by the OS on this platform. \
                 Mount the share with your file manager first (smb://server/share).",
            )
            .to_json())
        }
    })
    .await
    .map_err(|e| Error::internal(format!("Network share task failed: {e}")).to_json())?
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PartitionInfo {
    pub number: u32,
    pub drive_letter: Option<String>,
    pub label: Option<String>,
    pub file_system: Option<String>,
    pub size_bytes: u64,
    pub free_bytes: Option<u64>,
    pub offset_bytes: u64,
    pub partition_type: String,
    pub is_system: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PhysicalDiskInfo {
    pub index: u32,
    pub model: String,
    pub bus_type: String,
    pub partition_style: String,
    pub size_bytes: u64,
    pub health_status: String,
    pub is_system: bool,
    pub partitions: Vec<PartitionInfo>,
}

#[cfg(target_os = "windows")]
fn get_physical_disks_windows() -> Result<Vec<PhysicalDiskInfo>, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let ps_script = r#"
$disks = @(Get-Disk | Sort-Object Number | ForEach-Object {
    $d = $_
    $parts = @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue | Sort-Object Offset | ForEach-Object {
        $p = $_
        $vol = $p | Get-Volume -ErrorAction SilentlyContinue
        $dl = if ($p.DriveLetter -and $p.DriveLetter -ne [char]0) { "$($p.DriveLetter):" } else { $null }
        [PSCustomObject]@{
            number = [uint32]$p.PartitionNumber
            drive_letter = $dl
            label = if ($vol -and $vol.FileSystemLabel) { [string]$vol.FileSystemLabel } else { $null }
            file_system = if ($vol -and $vol.FileSystem) { [string]$vol.FileSystem } else { $null }
            size_bytes = [uint64]$p.Size
            free_bytes = if ($vol -and $null -ne $vol.SizeRemaining) { [uint64]$vol.SizeRemaining } else { $null }
            offset_bytes = [uint64]$p.Offset
            partition_type = [string]$p.Type
            is_system = [bool]($p.IsSystem -or $p.IsBoot -or ($dl -eq 'C:'))
        }
    })
    [PSCustomObject]@{
        index = [uint32]$d.Number
        model = [string]($d.FriendlyName)
        bus_type = [string]($d.BusType)
        partition_style = [string]($d.PartitionStyle)
        size_bytes = [uint64]$d.Size
        health_status = [string]($d.HealthStatus)
        is_system = [bool]($d.IsSystem -or $d.IsBoot)
        partitions = $parts
    }
})
ConvertTo-Json -InputObject $disks -Depth 5 -Compress
"#;

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to query physical disks via PowerShell: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Failed to query physical disks".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() || stdout == "null" {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<PhysicalDiskInfo>>(&stdout)
        .map_err(|e| format!("Failed to parse physical disk info JSON: {e}"))
}

#[cfg(target_os = "linux")]
fn get_physical_disks_linux() -> Result<Vec<PhysicalDiskInfo>, String> {
    let output = std::process::Command::new("lsblk")
        .args([
            "-J",
            "-b",
            "-o",
            "NAME,MODEL,SIZE,PTTYPE,TYPE,FSTYPE,MOUNTPOINT,LABEL,FSAVAIL,TRAN",
        ])
        .output()
        .map_err(|e| format!("Failed to run lsblk: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let root: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse lsblk JSON: {e}"))?;
    let mut disks = Vec::new();
    let Some(blockdevices) = root.get("blockdevices").and_then(|v| v.as_array()) else {
        return Ok(disks);
    };

    for (idx, dev) in blockdevices.iter().enumerate() {
        if dev.get("type").and_then(|v| v.as_str()) != Some("disk") {
            continue;
        }
        let mut partitions = Vec::new();
        let mut disk_is_system = false;
        if let Some(children) = dev.get("children").and_then(|v| v.as_array()) {
            for (p_idx, child) in children.iter().enumerate() {
                let mount = child
                    .get("mountpoint")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let is_sys = matches!(
                    mount.as_deref(),
                    Some("/") | Some("/boot") | Some("/boot/efi")
                );
                if is_sys {
                    disk_is_system = true;
                }
                partitions.push(PartitionInfo {
                    number: (p_idx + 1) as u32,
                    drive_letter: mount.or_else(|| {
                        child
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(|n| format!("/dev/{n}"))
                    }),
                    label: child
                        .get("label")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    file_system: child
                        .get("fstype")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    size_bytes: child.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                    free_bytes: child.get("fsavail").and_then(|v| v.as_u64()),
                    offset_bytes: 0,
                    partition_type: child
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("part")
                        .to_string(),
                    is_system: is_sys,
                });
            }
        }
        disks.push(PhysicalDiskInfo {
            index: idx as u32,
            model: dev
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| dev.get("name").and_then(|v| v.as_str()).unwrap_or("Disk"))
                .to_string(),
            bus_type: dev
                .get("tran")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_uppercase(),
            partition_style: dev
                .get("pttype")
                .and_then(|v| v.as_str())
                .unwrap_or("RAW")
                .to_uppercase(),
            size_bytes: dev.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
            health_status: "Healthy".to_string(),
            is_system: disk_is_system,
            partitions,
        });
    }
    Ok(disks)
}

/// Returns physical disks and their partition layouts for the Disk & Partition Manager.
#[tauri::command]
pub async fn get_physical_disks_info() -> Result<Vec<PhysicalDiskInfo>, String> {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "windows")]
        {
            get_physical_disks_windows()
        }
        #[cfg(target_os = "linux")]
        {
            get_physical_disks_linux()
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            Ok(Vec::new())
        }
    })
    .await
    .map_err(|e| Error::internal(format!("Physical disk query failed: {e}")).to_json())?
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

    #[test]
    fn test_unc_share_root_and_keyring_key() {
        assert_eq!(
            unc_share_root(r"\\devops_storage\Storage\AKUZ\updates\").as_deref(),
            Some(r"\\devops_storage\Storage")
        );
        assert_eq!(
            unc_share_root("//filesrv/Public/docs").as_deref(),
            Some(r"\\filesrv\Public")
        );
        assert_eq!(unc_share_root(""), None);
        assert_eq!(
            network_share_keyring_key(r"CORP\alice", r"\\filesrv\Public"),
            r"smb:CORP\alice@\\filesrv\Public"
        );
    }
}
