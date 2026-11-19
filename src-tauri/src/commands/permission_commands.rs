use crate::error_handling::Error;
#[cfg(target_os = "macos")]
use std::process::Command;

#[tauri::command]
pub fn request_full_disk_access() -> Result<(), String> {
    // Check if we're on macOS
    #[cfg(target_os = "macos")]
    {
        // Open System Preferences to Full Disk Access
        let result = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .output();

        match result {
            Ok(_) => Ok(()),
            Err(e) => {
                Err(Error::internal(format!("Failed to open System Preferences: {}", e)).to_json())
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn check_directory_access(path: String) -> Result<bool, String> {
    use std::fs;
    use std::io::ErrorKind;
    use std::path::Path;

    if path.trim().is_empty() {
        return Err(Error::invalid_input("Directory path cannot be empty").to_json());
    }

    let p = Path::new(&path);
    match fs::metadata(p) {
        Ok(meta) if !meta.is_dir() => {
            return Err(Error::invalid_input(format!("Path is not a directory: {path}")).to_json());
        }
        Ok(_) => {}
        Err(e) => match e.kind() {
            ErrorKind::PermissionDenied => return Ok(false),
            ErrorKind::NotFound => {
                return Err(
                    Error::resource_not_found(format!("Directory does not exist: {path}"))
                        .to_json(),
                );
            }
            _ => return Err(Error::from(e).to_json()),
        },
    }

    match fs::read_dir(p) {
        Ok(_) => Ok(true),
        Err(e) => match e.kind() {
            ErrorKind::PermissionDenied => Ok(false),
            ErrorKind::NotFound => Err(Error::resource_not_found(format!(
                "Directory does not exist: {path}"
            ))
            .to_json()),
            _ => Err(Error::from(e).to_json()),
        },
    }
}

#[cfg(test)]
mod permission_commands_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_check_directory_access_existing() {
        // Should succeed for a directory that exists and is accessible
        let path = std::env::temp_dir().to_string_lossy().to_string();
        let result = check_directory_access(path);
        assert_eq!(result, Ok(true));
    }

    #[test]
    fn test_check_directory_access_nonexistent() {
        // Should return Err (NotFound) for a directory that does not exist
        let path = "/nonexistent/directory/for/test".to_string();
        let result = check_directory_access(path);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("ResourceNotFound") || err.contains("does not exist"));
    }

    #[test]
    fn test_check_directory_access_file_path_returns_err() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("not_a_dir.txt");
        std::fs::write(&file, "hello").unwrap();
        let res = check_directory_access(file.to_string_lossy().to_string());
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("InvalidInput"));
    }

    #[test]
    fn test_check_directory_access_empty_path_returns_err() {
        let res = check_directory_access("   ".to_string());
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("InvalidInput"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn test_request_full_disk_access_noop_non_macos() {
        // On non-macOS, should always return Ok(())
        let result = request_full_disk_access();
        assert_eq!(result, Ok(()));
    }
}
