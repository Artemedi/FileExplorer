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
    pub device_path: Option<String>,
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
    pub device_path: Option<String>,
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
            device_path = if ($dl) { "\\.\$dl" } else { $null }
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
        device_path = "\\.\PhysicalDrive$($d.Number)"
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
                let dev_node = child
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|n| format!("/dev/{n}"));
                partitions.push(PartitionInfo {
                    number: (p_idx + 1) as u32,
                    drive_letter: mount.or_else(|| dev_node.clone()),
                    device_path: dev_node,
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
        let disk_dev = dev
            .get("name")
            .and_then(|v| v.as_str())
            .map(|n| format!("/dev/{n}"));
        disks.push(PhysicalDiskInfo {
            index: idx as u32,
            model: dev
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| dev.get("name").and_then(|v| v.as_str()).unwrap_or("Disk"))
                .to_string(),
            device_path: disk_dev,
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PartitionSupportedSize {
    pub min_bytes: u64,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiskImageProgress {
    pub operation: String,
    pub bytes_processed: u64,
    pub total_bytes: u64,
    pub percent: f64,
    pub stage: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SftpImageTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub auth_type: Option<String>,
    pub private_key_path: Option<String>,
    pub certificate_path: Option<String>,
    pub remote_path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiskImageResult {
    pub bytes_processed: u64,
    pub destination: String,
    pub compressed: bool,
}

fn validate_confirm_token(expected: &str, provided: &str) -> Result<(), String> {
    if provided.trim() != expected {
        return Err(format!(
            "Confirmation mismatch: type '{expected}' to proceed."
        ));
    }
    Ok(())
}

#[cfg_attr(not(any(target_os = "windows", target_os = "linux")), allow(dead_code))]
fn validate_filesystem_name(fs: &str, is_windows: bool) -> Result<String, String> {
    let normalized = fs.trim().to_ascii_lowercase();
    if is_windows {
        match normalized.as_str() {
            "ntfs" => Ok("NTFS".to_string()),
            "fat32" => Ok("FAT32".to_string()),
            "exfat" => Ok("exFAT".to_string()),
            "refs" => Ok("ReFS".to_string()),
            _ => Err(format!(
                "Unsupported Windows filesystem '{fs}'. Allowed: NTFS, FAT32, exFAT, ReFS."
            )),
        }
    } else {
        match normalized.as_str() {
            "ext4" | "ext3" | "ext2" | "xfs" | "btrfs" | "f2fs" | "vfat" | "exfat" | "ntfs"
            | "swap" => Ok(normalized),
            "fat32" => Ok("vfat".to_string()),
            _ => Err(format!(
                "Unsupported Linux filesystem '{fs}'. Allowed: ext4, ext3, ext2, xfs, btrfs, f2fs, vfat, exfat, ntfs, swap."
            )),
        }
    }
}

fn validate_volume_label(label: &str) -> Result<String, String> {
    let trimmed = label.trim();
    if trimmed.len() > 32 {
        return Err("Volume label must be 32 characters or fewer.".to_string());
    }
    if trimmed.chars().any(|c| {
        matches!(
            c,
            '\'' | '"' | '`' | '$' | ';' | '&' | '|' | '\n' | '\r' | '\0'
        )
    }) {
        return Err("Volume label contains invalid characters.".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_partition_style(style: &str) -> Result<String, String> {
    match style.trim().to_ascii_uppercase().as_str() {
        "GPT" => Ok("GPT".to_string()),
        "MBR" => Ok("MBR".to_string()),
        _ => Err(format!(
            "Unsupported partition style '{style}'. Allowed: GPT, MBR."
        )),
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn validate_drive_letter(letter: &str) -> Result<char, String> {
    let clean = letter.trim().trim_end_matches(':');
    let mut chars = clean.chars();
    let Some(ch) = chars.next() else {
        return Err("Drive letter cannot be empty.".to_string());
    };
    if chars.next().is_some() || !ch.is_ascii_alphabetic() {
        return Err(format!("Invalid drive letter '{letter}'."));
    }
    let upper = ch.to_ascii_uppercase();
    if upper == 'C' {
        return Err("Drive letter C: is reserved for the system volume.".to_string());
    }
    Ok(upper)
}

fn ensure_non_system_disk(disk: &PhysicalDiskInfo) -> Result<(), String> {
    if disk.is_system || disk.partitions.iter().any(|p| p.is_system) {
        return Err(format!(
            "Refusing destructive operation on system disk {} ({}).",
            disk.index, disk.model
        ));
    }
    Ok(())
}

fn ensure_non_system_partition(
    disk: &PhysicalDiskInfo,
    part: &PartitionInfo,
) -> Result<(), String> {
    if disk.is_system || part.is_system {
        return Err(format!(
            "Refusing destructive operation on system partition {} (Disk {}).",
            part.number, disk.index
        ));
    }
    Ok(())
}

fn is_zstd_magic(header: &[u8]) -> bool {
    header.len() >= 4 && header[..4] == [0x28, 0xB5, 0x2F, 0xFD]
}

fn find_disk_and_partition(
    disks: &[PhysicalDiskInfo],
    disk_index: u32,
    partition_number: Option<u32>,
) -> Result<(&PhysicalDiskInfo, Option<&PartitionInfo>), String> {
    let disk = disks
        .iter()
        .find(|d| d.index == disk_index)
        .ok_or_else(|| format!("Physical disk {disk_index} not found."))?;
    let part = match partition_number {
        Some(num) => Some(
            disk.partitions
                .iter()
                .find(|p| p.number == num)
                .ok_or_else(|| format!("Partition {num} on disk {disk_index} not found."))?,
        ),
        None => None,
    };
    Ok((disk, part))
}

#[cfg(target_os = "windows")]
fn run_powershell_disk_cmd(ps_script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to invoke PowerShell: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        if detail.to_ascii_lowercase().contains("access is denied")
            || detail.to_ascii_lowercase().contains("permissiondenied")
        {
            return Err(format!(
                "Administrator privileges required for this disk operation. Run Explr as Administrator.\n{detail}"
            ));
        }
        return Err(if detail.is_empty() {
            "Disk operation failed.".to_string()
        } else {
            detail
        });
    }
    Ok(stdout)
}

#[cfg(target_os = "linux")]
fn run_linux_disk_cmd(
    program: &str,
    args: &[&str],
    sudo_password: Option<&str>,
) -> Result<String, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let output = if let Some(pw) = sudo_password.filter(|s| !s.is_empty()) {
        let mut child = Command::new("sudo")
            .arg("-S")
            .arg("-p")
            .arg("")
            .arg(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to invoke sudo {program}: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = writeln!(stdin, "{pw}");
        }
        child
            .wait_with_output()
            .map_err(|e| format!("Failed waiting for sudo {program}: {e}"))?
    } else {
        Command::new("pkexec")
            .arg(program)
            .args(args)
            .output()
            .or_else(|_| Command::new(program).args(args).output())
            .map_err(|e| format!("Failed to run {program}: {e}"))?
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(if detail.is_empty() {
            format!("{program} exited with status {}", output.status)
        } else {
            detail
        });
    }
    Ok(stdout)
}

#[cfg(target_os = "linux")]
fn linux_unmount_if_mounted(device_path: &str, sudo_password: Option<&str>) {
    let _ = run_linux_disk_cmd("umount", &[device_path], sudo_password);
}

fn query_disks_sync() -> Result<Vec<PhysicalDiskInfo>, String> {
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
}

/// Returns the list of supported filesystems for formatting on the current OS.
#[tauri::command]
pub fn get_supported_filesystems() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        vec![
            "NTFS".to_string(),
            "exFAT".to_string(),
            "FAT32".to_string(),
            "ReFS".to_string(),
        ]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![
            "ext4".to_string(),
            "ext3".to_string(),
            "ext2".to_string(),
            "xfs".to_string(),
            "btrfs".to_string(),
            "f2fs".to_string(),
            "vfat".to_string(),
            "exfat".to_string(),
            "ntfs".to_string(),
            "swap".to_string(),
        ]
    }
}

/// Returns supported minimum and maximum sizes in bytes for resizing a partition.
#[tauri::command]
pub async fn get_partition_supported_size(
    disk_index: u32,
    partition_number: u32,
) -> Result<PartitionSupportedSize, String> {
    tokio::task::spawn_blocking(move || {
        let disks = query_disks_sync()?;
        let (_disk, _part) = find_disk_and_partition(&disks, disk_index, Some(partition_number))?;
        let _part = _part.expect("partition_number was Some");
        #[cfg(target_os = "windows")]
        {
            let script = format!(
                "$s = Get-PartitionSupportedSize -DiskNumber {disk_index} -PartitionNumber {partition_number}; \
                 [PSCustomObject]@{{ min_bytes = [uint64]$s.SizeMin; max_bytes = [uint64]$s.SizeMax }} | ConvertTo-Json -Compress"
            );
            let out = run_powershell_disk_cmd(&script)?;
            serde_json::from_str::<PartitionSupportedSize>(&out)
                .map_err(|e| format!("Failed to parse supported partition size: {e}"))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(PartitionSupportedSize {
                min_bytes: 64 * 1024 * 1024,
                max_bytes: _disk.size_bytes.max(_part.size_bytes),
            })
        }
    })
    .await
    .map_err(|e| format!("Supported size query failed: {e}"))?
}

/// Formats a non-system partition with the specified filesystem and optional volume label.
#[tauri::command]
pub async fn format_partition(
    disk_index: u32,
    partition_number: u32,
    file_system: String,
    label: Option<String>,
    quick: bool,
    confirm_target: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        validate_confirm_token(&format!("PART-{disk_index}-{partition_number}"), &confirm_target)?;
        let disks = query_disks_sync()?;
        let (disk, part) = find_disk_and_partition(&disks, disk_index, Some(partition_number))?;
        let part = part.expect("partition_number was Some");
        ensure_non_system_partition(disk, part)?;

        let clean_label = match label.as_deref() {
            Some(l) if !l.trim().is_empty() => Some(validate_volume_label(l)?),
            _ => None,
        };

        #[cfg(target_os = "windows")]
        {
            let _ = sudo_password;
            let fs = validate_filesystem_name(&file_system, true)?;
            let label_arg = clean_label
                .as_ref()
                .map(|l| format!(" -NewFileSystemLabel '{l}'"))
                .unwrap_or_default();
            let full_flag = if quick { "" } else { " -Full" };
            let script = format!(
                "$p = Get-Partition -DiskNumber {disk_index} -PartitionNumber {partition_number} -ErrorAction Stop; \
                 $p | Format-Volume -FileSystem {fs}{label_arg}{full_flag} -Confirm:$false -Force | Out-Null; \
                 'Formatted'"
            );
            run_powershell_disk_cmd(&script)?;
            Ok(format!(
                "Partition {partition_number} on Disk {disk_index} formatted as {fs}."
            ))
        }

        #[cfg(target_os = "linux")]
        {
            let _ = quick;
            let fs = validate_filesystem_name(&file_system, false)?;
            let dev = part
                .device_path
                .as_deref()
                .ok_or_else(|| "Partition device path is unavailable.".to_string())?;
            linux_unmount_if_mounted(dev, sudo_password.as_deref());
            let pw = sudo_password.as_deref();
            match fs.as_str() {
                "swap" => {
                    let mut args = vec![dev];
                    if let Some(ref l) = clean_label {
                        args.extend_from_slice(&["-L", l.as_str()]);
                    }
                    run_linux_disk_cmd("mkswap", &args, pw)?;
                }
                "vfat" => {
                    let mut args = vec!["-F", "32"];
                    if let Some(ref l) = clean_label {
                        args.extend_from_slice(&["-n", l.as_str()]);
                    }
                    args.push(dev);
                    run_linux_disk_cmd("mkfs.vfat", &args, pw)?;
                }
                "ext4" | "ext3" | "ext2" => {
                    let cmd = format!("mkfs.{fs}");
                    let mut args = vec!["-F"];
                    if let Some(ref l) = clean_label {
                        args.extend_from_slice(&["-L", l.as_str()]);
                    }
                    args.push(dev);
                    run_linux_disk_cmd(&cmd, &args, pw)?;
                }
                "xfs" => {
                    let mut args = vec!["-f"];
                    if let Some(ref l) = clean_label {
                        args.extend_from_slice(&["-L", l.as_str()]);
                    }
                    args.push(dev);
                    run_linux_disk_cmd("mkfs.xfs", &args, pw)?;
                }
                "btrfs" => {
                    let mut args = vec!["-f"];
                    if let Some(ref l) = clean_label {
                        args.extend_from_slice(&["-L", l.as_str()]);
                    }
                    args.push(dev);
                    run_linux_disk_cmd("mkfs.btrfs", &args, pw)?;
                }
                "exfat" => {
                    let mut args = Vec::new();
                    if let Some(ref l) = clean_label {
                        args.extend_from_slice(&["-n", l.as_str()]);
                    }
                    args.push(dev);
                    run_linux_disk_cmd("mkfs.exfat", &args, pw)?;
                }
                "ntfs" => {
                    let mut args = vec!["-f"];
                    if let Some(ref l) = clean_label {
                        args.extend_from_slice(&["-L", l.as_str()]);
                    }
                    args.push(dev);
                    run_linux_disk_cmd("mkfs.ntfs", &args, pw)?;
                }
                "f2fs" => {
                    let mut args = vec!["-f"];
                    if let Some(ref l) = clean_label {
                        args.extend_from_slice(&["-l", l.as_str()]);
                    }
                    args.push(dev);
                    run_linux_disk_cmd("mkfs.f2fs", &args, pw)?;
                }
                _ => return Err(format!("Unsupported filesystem: {fs}")),
            }
            Ok(format!("Partition {dev} formatted as {fs}."))
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            let _ = (clean_label, quick, file_system, sudo_password);
            Err("Partition formatting is only supported on Windows and Linux.".to_string())
        }
    })
    .await
    .map_err(|e| format!("Format partition task failed: {e}"))?
}

/// Creates a new partition on a non-system disk and optionally formats it.
#[tauri::command]
pub async fn create_partition(
    disk_index: u32,
    size_mb: Option<u64>,
    file_system: Option<String>,
    label: Option<String>,
    drive_letter: Option<String>,
    confirm_target: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        validate_confirm_token(&format!("DISK-{disk_index}"), &confirm_target)?;
        let disks = query_disks_sync()?;
        let (disk, _) = find_disk_and_partition(&disks, disk_index, None)?;
        ensure_non_system_disk(disk)?;

        let clean_label = match label.as_deref() {
            Some(l) if !l.trim().is_empty() => Some(validate_volume_label(l)?),
            _ => None,
        };

        #[cfg(target_os = "windows")]
        {
            let _ = sudo_password;
            let size_arg = match size_mb {
                Some(mb) if mb > 0 => format!("-Size ({mb} * 1MB)"),
                _ => "-UseMaximumSize".to_string(),
            };
            let letter_arg = match drive_letter.as_deref() {
                Some(l) if !l.trim().is_empty() => {
                    let ch = validate_drive_letter(l)?;
                    format!("-DriveLetter '{ch}'")
                }
                _ => "-AssignDriveLetter".to_string(),
            };
            let format_stmt = match file_system.as_deref() {
                Some(fs_raw) if !fs_raw.trim().is_empty() => {
                    let fs = validate_filesystem_name(fs_raw, true)?;
                    let label_arg = clean_label
                        .as_ref()
                        .map(|l| format!(" -NewFileSystemLabel '{l}'"))
                        .unwrap_or_default();
                    format!(" | Format-Volume -FileSystem {fs}{label_arg} -Confirm:$false -Force")
                }
                _ => String::new(),
            };
            let script = format!(
                "New-Partition -DiskNumber {disk_index} {size_arg} {letter_arg}{format_stmt} | Out-Null; 'Created'"
            );
            run_powershell_disk_cmd(&script)?;
            Ok(format!("Partition created on Disk {disk_index}."))
        }

        #[cfg(target_os = "linux")]
        {
            let _ = (drive_letter, clean_label);
            let dev = disk
                .device_path
                .as_deref()
                .ok_or_else(|| "Disk device path is unavailable.".to_string())?;
            let end_spec = match size_mb {
                Some(mb) if mb > 0 => format!("{mb}MiB"),
                _ => "100%".to_string(),
            };
            let fs_hint = match file_system.as_deref() {
                Some(fs_raw) if !fs_raw.trim().is_empty() => {
                    Some(validate_filesystem_name(fs_raw, false)?)
                }
                _ => None,
            };
            let parted_fs = match fs_hint.as_deref() {
                Some("vfat") => "fat32",
                Some("swap") => "linux-swap",
                Some("ntfs") => "ntfs",
                _ => "ext4",
            };
            run_linux_disk_cmd(
                "parted",
                &["-s", dev, "mkpart", "primary", parted_fs, "1MiB", &end_spec],
                sudo_password.as_deref(),
            )?;
            Ok(format!("Partition created on {dev}."))
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            let _ = (size_mb, file_system, clean_label, drive_letter, sudo_password);
            Err("Partition creation is only supported on Windows and Linux.".to_string())
        }
    })
    .await
    .map_err(|e| format!("Create partition task failed: {e}"))?
}

/// Deletes a non-system partition from a non-system disk.
#[tauri::command]
pub async fn delete_partition(
    disk_index: u32,
    partition_number: u32,
    confirm_target: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        validate_confirm_token(&format!("PART-{disk_index}-{partition_number}"), &confirm_target)?;
        let disks = query_disks_sync()?;
        let (disk, part) = find_disk_and_partition(&disks, disk_index, Some(partition_number))?;
        let part = part.expect("partition_number was Some");
        ensure_non_system_partition(disk, part)?;

        #[cfg(target_os = "windows")]
        {
            let _ = sudo_password;
            let script = format!(
                "Remove-Partition -DiskNumber {disk_index} -PartitionNumber {partition_number} -Confirm:$false; 'Deleted'"
            );
            run_powershell_disk_cmd(&script)?;
            Ok(format!(
                "Partition {partition_number} deleted from Disk {disk_index}."
            ))
        }

        #[cfg(target_os = "linux")]
        {
            let disk_dev = disk
                .device_path
                .as_deref()
                .ok_or_else(|| "Disk device path is unavailable.".to_string())?;
            if let Some(part_dev) = part.device_path.as_deref() {
                linux_unmount_if_mounted(part_dev, sudo_password.as_deref());
            }
            let part_num_str = partition_number.to_string();
            run_linux_disk_cmd(
                "parted",
                &["-s", disk_dev, "rm", &part_num_str],
                sudo_password.as_deref(),
            )?;
            Ok(format!("Partition {partition_number} deleted from {disk_dev}."))
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            let _ = sudo_password;
            Err("Partition deletion is only supported on Windows and Linux.".to_string())
        }
    })
    .await
    .map_err(|e| format!("Delete partition task failed: {e}"))?
}

/// Resizes a non-system partition to `new_size_mb`.
#[tauri::command]
pub async fn resize_partition(
    disk_index: u32,
    partition_number: u32,
    new_size_mb: u64,
    confirm_target: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    if new_size_mb < 16 {
        return Err("New partition size must be at least 16 MB.".to_string());
    }
    tokio::task::spawn_blocking(move || {
        validate_confirm_token(&format!("PART-{disk_index}-{partition_number}"), &confirm_target)?;
        let disks = query_disks_sync()?;
        let (disk, part) = find_disk_and_partition(&disks, disk_index, Some(partition_number))?;
        let part = part.expect("partition_number was Some");
        ensure_non_system_partition(disk, part)?;

        #[cfg(target_os = "windows")]
        {
            let _ = sudo_password;
            let script = format!(
                "Resize-Partition -DiskNumber {disk_index} -PartitionNumber {partition_number} -Size ({new_size_mb} * 1MB); 'Resized'"
            );
            run_powershell_disk_cmd(&script)?;
            Ok(format!(
                "Partition {partition_number} on Disk {disk_index} resized to {new_size_mb} MB."
            ))
        }

        #[cfg(target_os = "linux")]
        {
            let disk_dev = disk
                .device_path
                .as_deref()
                .ok_or_else(|| "Disk device path is unavailable.".to_string())?;
            let part_num_str = partition_number.to_string();
            let end_mb = format!("{new_size_mb}MiB");
            run_linux_disk_cmd(
                "parted",
                &["-s", disk_dev, "resizepart", &part_num_str, &end_mb],
                sudo_password.as_deref(),
            )?;
            Ok(format!(
                "Partition {partition_number} on {disk_dev} resized to {new_size_mb} MB."
            ))
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            let _ = sudo_password;
            Err("Partition resizing is only supported on Windows and Linux.".to_string())
        }
    })
    .await
    .map_err(|e| format!("Resize partition task failed: {e}"))?
}

/// Initializes a non-system disk with GPT or MBR partition table.
#[tauri::command]
pub async fn initialize_disk(
    disk_index: u32,
    partition_style: String,
    confirm_target: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        validate_confirm_token(&format!("DISK-{disk_index}"), &confirm_target)?;
        let style = validate_partition_style(&partition_style)?;
        let disks = query_disks_sync()?;
        let (disk, _) = find_disk_and_partition(&disks, disk_index, None)?;
        ensure_non_system_disk(disk)?;

        #[cfg(target_os = "windows")]
        {
            let _ = sudo_password;
            let script = format!(
                "Clear-Disk -Number {disk_index} -RemoveData -RemoveOEM -Confirm:$false -ErrorAction SilentlyContinue; \
                 Initialize-Disk -Number {disk_index} -PartitionStyle {style}; 'Initialized'"
            );
            run_powershell_disk_cmd(&script)?;
            Ok(format!("Disk {disk_index} initialized as {style}."))
        }

        #[cfg(target_os = "linux")]
        {
            let disk_dev = disk
                .device_path
                .as_deref()
                .ok_or_else(|| "Disk device path is unavailable.".to_string())?;
            let label = if style == "GPT" { "gpt" } else { "msdos" };
            run_linux_disk_cmd(
                "parted",
                &["-s", disk_dev, "mklabel", label],
                sudo_password.as_deref(),
            )?;
            Ok(format!("Disk {disk_dev} initialized as {style}."))
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            let _ = (style, sudo_password);
            Err("Disk initialization is only supported on Windows and Linux.".to_string())
        }
    })
    .await
    .map_err(|e| format!("Initialize disk task failed: {e}"))?
}

fn stream_copy_with_progress<R: std::io::Read, W: std::io::Write>(
    mut reader: R,
    mut writer: W,
    total_bytes: u64,
    operation: &str,
    stage: &str,
    app: &tauri::AppHandle,
) -> Result<u64, String> {
    use tauri::Emitter;

    let mut buf = vec![0u8; 1024 * 1024];
    let mut processed: u64 = 0;
    let mut last_emit: u64 = 0;

    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                // Raw disk devices on Windows sometimes report EOF as ERROR_HANDLE_EOF or ERROR_SECTOR_NOT_FOUND near end.
                if processed > 0 && processed >= total_bytes {
                    break;
                }
                return Err(format!("Read error at {processed} bytes: {e}"));
            }
        };

        let to_write = if total_bytes > 0 && processed + (n as u64) > total_bytes {
            (total_bytes - processed) as usize
        } else {
            n
        };
        if to_write == 0 {
            break;
        }

        writer
            .write_all(&buf[..to_write])
            .map_err(|e| format!("Write error at {processed} bytes: {e}"))?;
        processed += to_write as u64;

        if processed - last_emit >= 4 * 1024 * 1024 || (total_bytes > 0 && processed >= total_bytes)
        {
            last_emit = processed;
            let pct = if total_bytes > 0 {
                ((processed as f64 / total_bytes as f64) * 100.0).min(100.0)
            } else {
                0.0
            };
            let _ = app.emit(
                "disk-image-progress",
                DiskImageProgress {
                    operation: operation.to_string(),
                    bytes_processed: processed,
                    total_bytes,
                    percent: pct,
                    stage: stage.to_string(),
                },
            );
        }

        if total_bytes > 0 && processed >= total_bytes {
            break;
        }
    }

    writer
        .flush()
        .map_err(|e| format!("Failed to flush output stream: {e}"))?;
    Ok(processed)
}

/// Creates a raw (.img) or Zstd-compressed (.img.zst) image of a disk or partition,
/// optionally uploading it to a remote SFTP server.
#[tauri::command]
pub async fn create_disk_image(
    app: tauri::AppHandle,
    disk_index: u32,
    partition_number: Option<u32>,
    output_path: String,
    compress_zstd: bool,
    sftp_target: Option<SftpImageTarget>,
) -> Result<DiskImageResult, String> {
    tokio::task::spawn_blocking(move || {
        let out_trimmed = output_path.trim().to_string();
        if out_trimmed.is_empty() {
            return Err("Output image path cannot be empty.".to_string());
        }

        let disks = query_disks_sync()?;
        let (disk, part) = find_disk_and_partition(&disks, disk_index, partition_number)?;
        let (source_path, total_bytes) = match part {
            Some(p) => (
                p.device_path
                    .clone()
                    .ok_or_else(|| format!("Partition {} has no raw device path.", p.number))?,
                p.size_bytes,
            ),
            None => (
                disk.device_path
                    .clone()
                    .ok_or_else(|| format!("Disk {} has no raw device path.", disk.index))?,
                disk.size_bytes,
            ),
        };

        let src_file = std::fs::File::open(&source_path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                format!("Administrator/root privileges required to read {source_path}: {e}")
            } else {
                format!("Failed to open source device {source_path}: {e}")
            }
        })?;

        let dst_file = std::fs::File::create(&out_trimmed)
            .map_err(|e| format!("Failed to create image file '{out_trimmed}': {e}"))?;

        let bytes_written = if compress_zstd {
            let mut encoder = zstd::stream::Encoder::new(dst_file, 3)
                .map_err(|e| format!("Failed to initialize Zstd encoder: {e}"))?;
            let written = stream_copy_with_progress(
                src_file,
                &mut encoder,
                total_bytes,
                "create_image",
                "Creating compressed disk image (.img.zst)...",
                &app,
            )?;
            encoder
                .finish()
                .map_err(|e| format!("Failed to finalize Zstd image: {e}"))?;
            written
        } else {
            stream_copy_with_progress(
                src_file,
                dst_file,
                total_bytes,
                "create_image",
                "Creating raw disk image (.img)...",
                &app,
            )?
        };

        let mut final_dest = out_trimmed.clone();
        if let Some(sftp_cfg) = sftp_target {
            let options = super::sftp_file_system_operation_commands::resolve_ssh_profile(
                &sftp_cfg.host,
                sftp_cfg.port,
                &sftp_cfg.username,
                super::sftp_file_system_operation_commands::SshAuthOptions {
                    auth_type: sftp_cfg.auth_type.clone(),
                    private_key_path: sftp_cfg.private_key_path.clone(),
                    certificate_path: sftp_cfg.certificate_path.clone(),
                    compression_mode: Some("off".to_string()),
                },
            );
            let pw = super::sftp_file_system_operation_commands::resolve_sftp_password(
                &sftp_cfg.host,
                sftp_cfg.port,
                &sftp_cfg.username,
                sftp_cfg.password.unwrap_or_default(),
            )?
            .as_str()
            .to_string();
            let sftp = super::sftp_file_system_operation_commands::connect_to_sftp_with_options(
                sftp_cfg.host.clone(),
                sftp_cfg.port,
                sftp_cfg.username.clone(),
                pw,
                &options,
            )?;
            let local_img = std::fs::File::open(&out_trimmed)
                .map_err(|e| format!("Failed to open created image for SFTP upload: {e}"))?;
            let img_size = local_img.metadata().map(|m| m.len()).unwrap_or(0);
            let remote_file = sftp
                .create(std::path::Path::new(&sftp_cfg.remote_path))
                .map_err(|e| {
                    format!(
                        "Failed to create remote SFTP file '{}': {e}",
                        sftp_cfg.remote_path
                    )
                })?;
            stream_copy_with_progress(
                local_img,
                remote_file,
                img_size,
                "upload_image",
                "Uploading disk image over SFTP...",
                &app,
            )?;
            final_dest = format!(
                "sftp://{}:{}{}",
                sftp_cfg.host, sftp_cfg.port, sftp_cfg.remote_path
            );
        }

        Ok(DiskImageResult {
            bytes_processed: bytes_written,
            destination: final_dest,
            compressed: compress_zstd,
        })
    })
    .await
    .map_err(|e| format!("Create disk image task failed: {e}"))?
}

/// Clones a disk/partition or restores an `.img` / `.img.zst` file onto a non-system target disk/partition.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn clone_or_restore_disk(
    app: tauri::AppHandle,
    source_kind: String,
    source_disk_index: Option<u32>,
    source_partition_number: Option<u32>,
    source_image_path: Option<String>,
    target_disk_index: u32,
    target_partition_number: Option<u32>,
    confirm_target: String,
) -> Result<DiskImageResult, String> {
    tokio::task::spawn_blocking(move || {
        let expected_token = match target_partition_number {
            Some(p) => format!("PART-{target_disk_index}-{p}"),
            None => format!("DISK-{target_disk_index}"),
        };
        validate_confirm_token(&expected_token, &confirm_target)?;

        let disks = query_disks_sync()?;
        let (target_disk, target_part) =
            find_disk_and_partition(&disks, target_disk_index, target_partition_number)?;
        if let Some(tp) = target_part {
            ensure_non_system_partition(target_disk, tp)?;
        } else {
            ensure_non_system_disk(target_disk)?;
        }

        let target_capacity = target_part.map(|p| p.size_bytes).unwrap_or(target_disk.size_bytes);
        let target_dev = match target_part {
            Some(p) => p
                .device_path
                .clone()
                .ok_or_else(|| format!("Target partition {} has no raw device path.", p.number))?,
            None => target_disk
                .device_path
                .clone()
                .ok_or_else(|| format!("Target disk {} has no raw device path.", target_disk.index))?,
        };

        let dst_file = std::fs::OpenOptions::new()
            .write(true)
            .open(&target_dev)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    format!("Administrator/root privileges required to write to {target_dev}: {e}")
                } else {
                    format!("Failed to open target device {target_dev}: {e}")
                }
            })?;

        let (bytes_written, compressed) = match source_kind.trim().to_ascii_lowercase().as_str() {
            "disk" | "partition" => {
                let s_disk_idx = source_disk_index
                    .ok_or_else(|| "Source disk index is required.".to_string())?;
                if s_disk_idx == target_disk_index && source_partition_number == target_partition_number {
                    return Err("Source and target cannot be the same device.".to_string());
                }
                let (src_disk, src_part) =
                    find_disk_and_partition(&disks, s_disk_idx, source_partition_number)?;
                let (src_dev, src_size) = match src_part {
                    Some(p) => (
                        p.device_path
                            .clone()
                            .ok_or_else(|| "Source partition has no raw device path.".to_string())?,
                        p.size_bytes,
                    ),
                    None => (
                        src_disk
                            .device_path
                            .clone()
                            .ok_or_else(|| "Source disk has no raw device path.".to_string())?,
                        src_disk.size_bytes,
                    ),
                };
                if src_size > target_capacity {
                    return Err(format!(
                        "Target capacity ({target_capacity} bytes) is smaller than source ({src_size} bytes)."
                    ));
                }
                let src_file = std::fs::File::open(&src_dev)
                    .map_err(|e| format!("Failed to open source device {src_dev}: {e}"))?;
                let written = stream_copy_with_progress(
                    src_file,
                    dst_file,
                    src_size,
                    "clone",
                    "Cloning raw blocks...",
                    &app,
                )?;
                (written, false)
            }
            "image" => {
                use std::io::{Read, Seek, SeekFrom};
                let img_path = source_image_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "Source image path is required.".to_string())?;
                let mut img_file = std::fs::File::open(img_path)
                    .map_err(|e| format!("Failed to open image '{img_path}': {e}"))?;
                let img_file_len = img_file.metadata().map(|m| m.len()).unwrap_or(0);
                let mut magic = [0u8; 4];
                let read_magic = img_file.read(&mut magic).unwrap_or(0);
                img_file
                    .seek(SeekFrom::Start(0))
                    .map_err(|e| format!("Failed to rewind image file: {e}"))?;

                let is_zst = is_zstd_magic(&magic[..read_magic])
                    || img_path.to_ascii_lowercase().ends_with(".zst");
                if is_zst {
                    let decoder = zstd::stream::Decoder::new(img_file)
                        .map_err(|e| format!("Failed to initialize Zstd decoder: {e}"))?;
                    let written = stream_copy_with_progress(
                        decoder,
                        dst_file,
                        target_capacity,
                        "restore_image",
                        "Restoring compressed image (.img.zst)...",
                        &app,
                    )?;
                    (written, true)
                } else {
                    if img_file_len > target_capacity {
                        return Err(format!(
                            "Image size ({img_file_len} bytes) exceeds target capacity ({target_capacity} bytes)."
                        ));
                    }
                    let written = stream_copy_with_progress(
                        img_file,
                        dst_file,
                        img_file_len,
                        "restore_image",
                        "Restoring raw image (.img)...",
                        &app,
                    )?;
                    (written, false)
                }
            }
            other => return Err(format!("Unsupported source_kind '{other}'.")),
        };

        Ok(DiskImageResult {
            bytes_processed: bytes_written,
            destination: target_dev,
            compressed,
        })
    })
    .await
    .map_err(|e| format!("Clone/restore disk task failed: {e}"))?
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct NetworkEndpointTarget {
    pub id: String,
    pub host: String,
    pub port: Option<u16>,
    pub unc_path: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NetworkEndpointStatus {
    pub id: String,
    pub reachable: bool,
    pub latency_ms: Option<u64>,
    pub status: String,
}

fn extract_unc_host(unc_path: &str) -> Option<String> {
    let trimmed = unc_path.trim().replace('/', "\\");
    let rest = trimmed.strip_prefix("\\\\")?;
    let host = rest.split('\\').next()?.trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

async fn probe_tcp_latency(host: &str, port: u16) -> Option<u64> {
    let start = std::time::Instant::now();
    let connect_fut = tokio::net::TcpStream::connect((host, port));
    match tokio::time::timeout(std::time::Duration::from_millis(1500), connect_fut).await {
        Ok(Ok(_stream)) => Some(start.elapsed().as_millis() as u64),
        _ => None,
    }
}

async fn check_single_endpoint(target: NetworkEndpointTarget) -> NetworkEndpointStatus {
    if let Some(ref unc) = target.unc_path {
        if let Some(host) = extract_unc_host(unc) {
            if let Some(ms) = probe_tcp_latency(&host, 445).await {
                return NetworkEndpointStatus {
                    id: target.id,
                    reachable: true,
                    latency_ms: Some(ms),
                    status: "online".to_string(),
                };
            }
            if let Some(ms) = probe_tcp_latency(&host, 139).await {
                return NetworkEndpointStatus {
                    id: target.id,
                    reachable: true,
                    latency_ms: Some(ms),
                    status: "online".to_string(),
                };
            }
        }
        return NetworkEndpointStatus {
            id: target.id,
            reachable: false,
            latency_ms: None,
            status: "offline".to_string(),
        };
    }

    let host = target.host.trim();
    if host.is_empty() {
        return NetworkEndpointStatus {
            id: target.id,
            reachable: false,
            latency_ms: None,
            status: "offline".to_string(),
        };
    }
    let port = target.port.unwrap_or(22);
    match probe_tcp_latency(host, port).await {
        Some(ms) => NetworkEndpointStatus {
            id: target.id,
            reachable: true,
            latency_ms: Some(ms),
            status: "online".to_string(),
        },
        None => NetworkEndpointStatus {
            id: target.id,
            reachable: false,
            latency_ms: None,
            status: "offline".to_string(),
        },
    }
}

/// Checks reachability and TCP latency (ms) for SFTP and SMB/UNC network endpoints in parallel.
#[tauri::command]
pub async fn check_network_endpoints(
    targets: Vec<NetworkEndpointTarget>,
) -> Result<Vec<NetworkEndpointStatus>, String> {
    let mut set = tokio::task::JoinSet::new();
    for target in targets {
        set.spawn(check_single_endpoint(target));
    }
    let mut results = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(status) = res {
            results.push(status);
        }
    }
    Ok(results)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct UserDirectoryInfo {
    pub name: String,
    pub path: String,
    pub icon: String,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_xdg_user_dirs_content(content: &str, home_dir: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let trimmed_home = home_dir.trim_end_matches('/');
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, raw_val)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let val = raw_val.trim().trim_matches('"');
        if val.is_empty() {
            continue;
        }
        let resolved = val.replace("$HOME", trimmed_home);
        out.push((key.to_string(), resolved));
    }
    out
}

/// Returns existing standard/XDG user directories without logging errors for missing optional folders.
#[tauri::command]
pub fn get_user_directories() -> Vec<UserDirectoryInfo> {
    let Some(home) = dirs_home() else {
        return Vec::new();
    };
    let mut results = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();

    #[cfg(target_os = "linux")]
    {
        let user_dirs_file = home.join(".config/user-dirs.dirs");
        if let Ok(content) = std::fs::read_to_string(user_dirs_file) {
            let parsed = parse_xdg_user_dirs_content(&content, &home.to_string_lossy());
            let map: std::collections::HashMap<String, String> = parsed.into_iter().collect();
            let specs = [
                ("XDG_DESKTOP_DIR", "Desktop", "desktop"),
                ("XDG_DOCUMENTS_DIR", "Documents", "documents"),
                ("XDG_DOWNLOAD_DIR", "Downloads", "downloads"),
                ("XDG_PICTURES_DIR", "Pictures", "pictures"),
                ("XDG_MUSIC_DIR", "Music", "music"),
                ("XDG_VIDEOS_DIR", "Videos", "videos"),
            ];
            for (xdg_key, label, icon) in specs {
                if let Some(p) = map.get(xdg_key) {
                    let path_buf = std::path::PathBuf::from(p);
                    if path_buf != home && path_buf.is_dir() && seen_paths.insert(p.clone()) {
                        results.push(UserDirectoryInfo {
                            name: label.to_string(),
                            path: p.clone(),
                            icon: icon.to_string(),
                        });
                    }
                }
            }
            if !results.is_empty() {
                return results;
            }
        }
    }

    let fallback_specs: [(&str, &[&str], &str); 6] = [
        ("Desktop", &["Desktop"], "desktop"),
        ("Documents", &["Documents"], "documents"),
        ("Downloads", &["Downloads"], "downloads"),
        ("Pictures", &["Pictures"], "pictures"),
        ("Music", &["Music"], "music"),
        ("Videos", &["Videos", "Movies"], "videos"),
    ];

    for (label, candidates, icon) in fallback_specs {
        for sub in candidates {
            let p = home.join(sub);
            if p.is_dir() {
                let path_str = p.to_string_lossy().into_owned();
                if seen_paths.insert(path_str.clone()) {
                    results.push(UserDirectoryInfo {
                        name: label.to_string(),
                        path: path_str,
                        icon: icon.to_string(),
                    });
                }
                break;
            }
        }
    }

    results
}

fn dirs_home() -> Option<std::path::PathBuf> {
    home::home_dir()
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

    #[test]
    fn test_disk_manager_validation_and_safety() {
        assert!(validate_confirm_token("DISK-1", "DISK-1").is_ok());
        assert!(validate_confirm_token("DISK-1", "DISK-0").is_err());

        assert_eq!(validate_filesystem_name("ntfs", true).unwrap(), "NTFS");
        assert_eq!(validate_filesystem_name("FAT32", true).unwrap(), "FAT32");
        assert!(validate_filesystem_name("ext4", true).is_err());
        assert_eq!(validate_filesystem_name("ext4", false).unwrap(), "ext4");
        assert_eq!(validate_filesystem_name("FAT32", false).unwrap(), "vfat");
        assert!(validate_filesystem_name("apfs", false).is_err());

        assert_eq!(validate_volume_label("  BACKUP_01 ").unwrap(), "BACKUP_01");
        assert!(validate_volume_label("bad'label").is_err());
        assert!(validate_volume_label("bad;rm -rf").is_err());
        assert!(validate_volume_label(&"A".repeat(33)).is_err());

        assert_eq!(validate_partition_style("gpt").unwrap(), "GPT");
        assert_eq!(validate_partition_style("MBR").unwrap(), "MBR");
        assert!(validate_partition_style("APFS").is_err());

        assert_eq!(validate_drive_letter("e:").unwrap(), 'E');
        assert!(validate_drive_letter("C:").is_err());
        assert!(validate_drive_letter("1:").is_err());

        assert!(is_zstd_magic(&[0x28, 0xB5, 0x2F, 0xFD, 0x00]));
        assert!(!is_zstd_magic(&[0x00, 0x00, 0x00, 0x00]));

        let sys_part = PartitionInfo {
            number: 1,
            drive_letter: Some("C:".to_string()),
            device_path: Some(r"\\.\C:".to_string()),
            label: Some("OS".to_string()),
            file_system: Some("NTFS".to_string()),
            size_bytes: 100_000,
            free_bytes: Some(50_000),
            offset_bytes: 0,
            partition_type: "Basic".to_string(),
            is_system: true,
        };
        let sys_disk = PhysicalDiskInfo {
            index: 0,
            model: "NVMe".to_string(),
            device_path: Some(r"\\.\PhysicalDrive0".to_string()),
            bus_type: "NVMe".to_string(),
            partition_style: "GPT".to_string(),
            size_bytes: 100_000,
            health_status: "Healthy".to_string(),
            is_system: true,
            partitions: vec![sys_part.clone()],
        };
        assert!(ensure_non_system_disk(&sys_disk).is_err());
        assert!(ensure_non_system_partition(&sys_disk, &sys_part).is_err());

        let data_part = PartitionInfo {
            number: 1,
            drive_letter: Some("E:".to_string()),
            device_path: Some(r"\\.\E:".to_string()),
            label: Some("USB".to_string()),
            file_system: Some("exFAT".to_string()),
            size_bytes: 64_000_000,
            free_bytes: Some(60_000_000),
            offset_bytes: 1024,
            partition_type: "Basic".to_string(),
            is_system: false,
        };
        let data_disk = PhysicalDiskInfo {
            index: 2,
            model: "USB Flash".to_string(),
            device_path: Some(r"\\.\PhysicalDrive2".to_string()),
            bus_type: "USB".to_string(),
            partition_style: "GPT".to_string(),
            size_bytes: 64_000_000,
            health_status: "Healthy".to_string(),
            is_system: false,
            partitions: vec![data_part.clone()],
        };
        assert!(ensure_non_system_disk(&data_disk).is_ok());
        assert!(ensure_non_system_partition(&data_disk, &data_part).is_ok());
    }

    #[test]
    fn test_extract_unc_host_and_endpoint_check() {
        assert_eq!(
            extract_unc_host(r"\\devops_storage\Storage\AKUZ\updates\").as_deref(),
            Some("devops_storage")
        );
        assert_eq!(
            extract_unc_host("//filesrv.corp.local/Public").as_deref(),
            Some("filesrv.corp.local")
        );
        assert_eq!(extract_unc_host("C:\\local\\path"), None);
    }

    #[test]
    fn test_parse_xdg_user_dirs() {
        let sample = r#"
# Comment
XDG_DESKTOP_DIR="$HOME/Рабочий стол"
XDG_DOWNLOAD_DIR="$HOME/Загрузки"
XDG_VIDEOS_DIR=""
"#;
        let parsed = parse_xdg_user_dirs_content(sample, "/home/Trintos");
        assert_eq!(
            parsed,
            vec![
                (
                    "XDG_DESKTOP_DIR".to_string(),
                    "/home/Trintos/Рабочий стол".to_string()
                ),
                (
                    "XDG_DOWNLOAD_DIR".to_string(),
                    "/home/Trintos/Загрузки".to_string()
                ),
            ]
        );
    }
}
