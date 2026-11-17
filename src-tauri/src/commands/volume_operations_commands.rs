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
    serde_json::to_string(&volume_information_vec).unwrap()
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
        let mut volume_name = disk.name().to_string_lossy().into_owned();

        // On Windows, if volume label is empty, provide a clean friendly name like "Local Disk (C:)"
        #[cfg(target_os = "windows")]
        if volume_name.is_empty() && !mount_point.is_empty() {
            let drive_letter = mount_point.trim_end_matches('\\');
            volume_name = format!("Local Disk ({})", drive_letter);
        }

        let file_system = disk
            .file_system()
            .to_str()
            .unwrap_or("Unknown")
            .to_owned();

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
}
