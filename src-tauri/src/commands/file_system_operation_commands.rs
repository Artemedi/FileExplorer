use crate::error_handling::{Error, ErrorCode};
use crate::models::{
    format_system_time, get_access_permission_number, get_access_permission_string, Entries,
};
use crate::{log_error, models};
use std::collections::HashSet;
use std::fs;
use std::fs::read_dir;
use std::io::Read;
#[cfg(test)]
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use zip::write::FileOptions;
use zip::ZipWriter;

/// Maximum number of `name (n)` collision retries before returning an error.
const MAX_UNIQUE_PATH_ATTEMPTS: u32 = 9999;

/// Maximum number of entries permitted when extracting a zip archive.
const MAX_UNZIP_ENTRIES: usize = 50_000;

/// Maximum total uncompressed bytes permitted when extracting a zip archive (512 MiB).
const MAX_UNZIP_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

/// Runs a blocking filesystem closure on Tokio's blocking thread pool.
async fn run_blocking<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(job).await.map_err(|err| {
        log_error!("Blocking filesystem task failed: {}", err);
        Error::new(
            ErrorCode::InternalError,
            format!("Background filesystem task failed: {err}"),
        )
        .to_json()
    })?
}

/// Validates that `name` is a single normal file or directory name with no path traversal,
/// directory separators, root/prefix components, or control characters.
fn validate_single_entry_name(name: &str) -> Result<(), Error> {
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(Error::new(
            ErrorCode::InvalidInput,
            format!("Invalid file or directory name: '{name}'"),
        ));
    }

    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err(Error::new(
            ErrorCode::InvalidInput,
            format!("Invalid file or directory name: '{name}'"),
        )),
    }
}

/// Counts immediate files and subdirectories of `dir_path` in a single `read_dir` pass.
fn count_subentries_single_pass(dir_path: &Path) -> (usize, usize) {
    let mut file_count = 0;
    let mut dir_count = 0;

    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.filter_map(Result::ok) {
            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    dir_count += 1;
                } else if ft.is_file() {
                    file_count += 1;
                } else if ft.is_symlink() {
                    match fs::metadata(entry.path()) {
                        Ok(md) if md.is_dir() => dir_count += 1,
                        _ => file_count += 1,
                    }
                }
            }
        }
    }

    (file_count, dir_count)
}

/// Opens a file at the given path and returns its contents as a string.
/// Should only be used for text files.
///
/// # Arguments
///
/// * `path` - A string slice that holds the path to the file to be opened.
///
/// # Returns
///
/// * `Ok(String)` - If the file was successfully opened and read.
/// * `Err(String)` - If there was an error during the opening or reading process.
///
/// # Example
///
/// ```rust
/// let result = open_file("/path/to/file.txt").await;
/// match result {
///     Ok(contents) => println!("File contents: {}", contents),
///     Err(err) => println!("Error opening file: {}", err),
/// }
/// ```
#[allow(dead_code)] //remove once the command is used again
#[tauri::command]
pub async fn open_file(path: &str) -> Result<String, String> {
    let path_owned = path.to_string();
    run_blocking(move || {
        let path_obj = Path::new(&path_owned);

        if !path_obj.exists() {
            log_error!("File does not exist: {}", path_owned);
            return Err(Error::new(
                ErrorCode::ResourceNotFound,
                format!("File does not exist: {path_owned}"),
            )
            .to_json());
        }

        if !path_obj.is_file() {
            log_error!("Path is not a file: {}", path_owned);
            return Err(Error::new(
                ErrorCode::InvalidInput,
                format!("Path is not a file: {path_owned}"),
            )
            .to_json());
        }

        fs::read_to_string(&path_owned).map_err(|err| {
            log_error!("Failed to open file: {}", err);
            Error::new(
                ErrorCode::InternalError,
                format!("Failed to read file: {err}"),
            )
            .to_json()
        })
    })
    .await
}

#[tauri::command]
pub async fn open_in_default_app(path: &str) -> Result<(), String> {
    let path_owned = path.to_string();
    run_blocking(move || {
        let path_obj = Path::new(&path_owned);

        if !path_obj.exists() {
            log_error!("File does not exist: {}", path_owned);
            return Err(Error::new(
                ErrorCode::ResourceNotFound,
                format!("File does not exist: {path_owned}"),
            )
            .to_json());
        }

        open::that(&path_owned).map_err(|err| {
            Error::new(
                ErrorCode::InternalError,
                format!("Failed to open file in default app: {err}"),
            )
            .to_json()
        })
    })
    .await
}

/// Opens a directory at the given path and returns its contents as a json string.
///
/// # Arguments
/// - `path` - A string slice that holds the path to the directory to be opened.
///
/// # Returns
/// - `Ok(Entries)` - If the directory was successfully opened and read.
/// - `Err(String)` - If there was an error during the opening or reading process.
///
/// # Example
/// ```rust
/// let result = open_directory("/path/to/directory").await;
/// match result {
///    Ok(entries) => {
///       for dir in entries.directories {
///          println!("Directory: {}", dir.name);
///       }
///      for file in entries.files {
///         println!("File: {}", file.name);
///      }
///   },
///   Err(err) => println!("Error opening directory: {}", err),
/// }
/// ```
#[tauri::command]
pub async fn open_directory(path: String) -> Result<String, String> {
    run_blocking(move || open_directory_sync(&path)).await
}

fn open_directory_sync(path: &str) -> Result<String, String> {
    let path_obj = Path::new(path);

    if !path_obj.exists() {
        log_error!("Directory does not exist: {}", path);
        return Err(Error::new(
            ErrorCode::ResourceNotFound,
            format!("Directory does not exist: {path}"),
        )
        .to_json());
    }

    if !path_obj.is_dir() {
        log_error!("Path is not a directory: {}", path);
        return Err(Error::new(
            ErrorCode::InvalidInput,
            format!("Path is not a directory: {path}"),
        )
        .to_json());
    }

    let mut directories = Vec::new();
    let mut files = Vec::new();

    for entry_res in read_dir(path_obj).map_err(|err| {
        log_error!("Failed to read directory: {}", err);
        Error::new(
            ErrorCode::InternalError,
            format!("Failed to read directory: {err}"),
        )
        .to_json()
    })? {
        let entry = match entry_res {
            Ok(e) => e,
            Err(err) => {
                log_error!("Skipping unreadable directory entry: {}", err);
                continue;
            }
        };

        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(err) => {
                log_error!("Skipping entry with unreadable file type: {}", err);
                continue;
            }
        };

        let path_of_entry = entry.path();
        let is_symlink = file_type.is_symlink();

        let (is_dir, is_file, metadata) = if is_symlink {
            match fs::metadata(&path_of_entry) {
                Ok(target_md) => (target_md.is_dir(), !target_md.is_dir(), target_md),
                Err(_) => match fs::symlink_metadata(&path_of_entry) {
                    // Broken symlink: surface it in the UI as a file entry with `is_symlink: true`
                    Ok(link_md) => (false, true, link_md),
                    Err(err) => {
                        log_error!(
                            "Skipping symlink entry with unreadable metadata ({}): {}",
                            path_of_entry.display(),
                            err
                        );
                        continue;
                    }
                },
            }
        } else {
            match entry.metadata() {
                Ok(md) => (file_type.is_dir(), file_type.is_file(), md),
                Err(err) => {
                    log_error!(
                        "Skipping entry with unreadable metadata ({}): {}",
                        path_of_entry.display(),
                        err
                    );
                    continue;
                }
            }
        };

        let name = entry.file_name().to_string_lossy().into_owned();
        let entry_path_str = path_of_entry.to_string_lossy().into_owned();

        if is_dir {
            let (sub_file_count, sub_dir_count) = count_subentries_single_pass(&path_of_entry);
            directories.push(models::Directory {
                name,
                path: entry_path_str,
                is_symlink,
                access_rights_as_string: get_access_permission_string(metadata.permissions(), true),
                access_rights_as_number: get_access_permission_number(metadata.permissions(), true),
                size_in_bytes: 0,
                sub_file_count,
                sub_dir_count,
                created: metadata
                    .created()
                    .map_or_else(|_| "1970-01-01 00:00:00".to_string(), format_system_time),
                last_modified: metadata
                    .modified()
                    .map_or_else(|_| "1970-01-01 00:00:00".to_string(), format_system_time),
                accessed: metadata
                    .accessed()
                    .map_or_else(|_| "1970-01-01 00:00:00".to_string(), format_system_time),
            });
        } else if is_file {
            files.push(models::File {
                name,
                path: entry_path_str,
                is_symlink,
                access_rights_as_string: get_access_permission_string(
                    metadata.permissions(),
                    false,
                ),
                access_rights_as_number: get_access_permission_number(
                    metadata.permissions(),
                    false,
                ),
                size_in_bytes: metadata.len(),
                created: metadata
                    .created()
                    .map_or_else(|_| "1970-01-01 00:00:00".to_string(), format_system_time),
                last_modified: metadata
                    .modified()
                    .map_or_else(|_| "1970-01-01 00:00:00".to_string(), format_system_time),
                accessed: metadata
                    .accessed()
                    .map_or_else(|_| "1970-01-01 00:00:00".to_string(), format_system_time),
            });
        }
    }

    let entries = Entries { directories, files };

    serde_json::to_string(&entries).map_err(|err| {
        log_error!("Failed to serialize entries: {}", err);
        Error::new(
            ErrorCode::InternalError,
            format!("Failed to serialize entries: {err}"),
        )
        .to_json()
    })
}

/// Creates a file at the given absolute path. Returns a string if there was an error.
/// This function does not create any parent directories.
///
/// # Arguments
/// - `file_path_abs` - A string slice that holds the absolute path to the file to be created.
///
/// # Returns
/// - `Ok(())` if the file was successfully created.
/// - `Err(String)` if there was an error during the creation process.
///
/// # Example
/// ```rust
/// let result = create_file("/path/to/file.txt").await;
/// match result {
///     Ok(_) => println!("File created successfully!"),
///     Err(err) => println!("Error creating file: {}", err),
/// }
/// ```
#[tauri::command]
pub async fn create_file(folder_path_abs: &str, file_name: &str) -> Result<(), String> {
    let path = Path::new(folder_path_abs);
    if !path.exists() {
        log_error!("Directory does not exist: {}", folder_path_abs);
        return Err(Error::new(
            ErrorCode::ResourceNotFound,
            format!("Directory does not exist: {folder_path_abs}"),
        )
        .to_json());
    }
    if !path.is_dir() {
        log_error!("Path is no directory: {}", folder_path_abs);
        return Err(Error::new(
            ErrorCode::InvalidInput,
            format!("Path is no directory: {folder_path_abs}"),
        )
        .to_json());
    }

    if let Err(err) = validate_single_entry_name(file_name) {
        log_error!("Invalid file name '{}': {}", file_name, err.custom_message);
        return Err(err.to_json());
    }

    let file_path = path.join(file_name);

    // Create the file without overwriting existing files
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_path)
    {
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            log_error!("File already exists: {}", file_path.display());
            Err(Error::new(
                ErrorCode::ResourceAlreadyExists,
                format!("File already exists: {}", file_path.display()),
            )
            .to_json())
        }
        Err(err) => {
            log_error!(
                "File could not be created: {} error: {}",
                file_path.display(),
                err
            );
            Err(Error::new(
                ErrorCode::InternalError,
                format!(
                    "File could not be created: {} error: {err}",
                    file_path.display()
                ),
            )
            .to_json())
        }
    }
}

/// Creates a directory at the given absolute path. Returns a string if there was an error.
/// This function does not create any parent directories.
///
/// # Arguments
/// - `folder_path_abs` - A string slice that holds the absolute path to the directory to be created.
///
/// # Returns
/// - `Ok(())` if the directory was successfully created.
/// - `Err(String)` if there was an error during the creation process.
///
/// # Example
/// ```rust
/// let result = create_directory("/path/to/directory", "new_folder").await;
/// match result {
///     Ok(_) => println!("Directory created successfully!"),
///     Err(err) => println!("Error creating directory: {}", err),
/// }
/// ```
#[tauri::command]
pub async fn create_directory(folder_path_abs: &str, folder_name: &str) -> Result<(), String> {
    let parent_path = Path::new(folder_path_abs);
    if !parent_path.exists() {
        log_error!("Parent directory does not exist: {}", folder_path_abs);
        return Err(Error::new(
            ErrorCode::ResourceNotFound,
            format!("Parent directory does not exist: {folder_path_abs}"),
        )
        .to_json());
    }

    if !parent_path.is_dir() {
        log_error!("Path is no directory: {}", folder_path_abs);
        return Err(Error::new(
            ErrorCode::InvalidInput,
            format!("Path is no directory: {folder_path_abs}"),
        )
        .to_json());
    }

    if let Err(err) = validate_single_entry_name(folder_name) {
        log_error!(
            "Invalid directory name '{}': {}",
            folder_name,
            err.custom_message
        );
        return Err(err.to_json());
    }

    let dir_path = parent_path.join(folder_name);

    if fs::symlink_metadata(&dir_path).is_ok() {
        log_error!("Directory already exists: {}", dir_path.display());
        return Err(Error::new(
            ErrorCode::ResourceAlreadyExists,
            format!("Directory already exists: {}", dir_path.display()),
        )
        .to_json());
    }

    match fs::create_dir(&dir_path) {
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            log_error!("Directory already exists: {}", dir_path.display());
            Err(Error::new(
                ErrorCode::ResourceAlreadyExists,
                format!("Directory already exists: {}", dir_path.display()),
            )
            .to_json())
        }
        Err(err) => {
            log_error!(
                "Failed to create directory: {} err: {}",
                dir_path.display(),
                err
            );
            Err(Error::new(
                ErrorCode::InternalError,
                format!(
                    "Failed to create directory: {} err: {err}",
                    dir_path.display()
                ),
            )
            .to_json())
        }
    }
}

/// Checks if two path strings represent a case-only rename within the same directory
/// (supporting non-ASCII Unicode like Cyrillic and mixed `/` vs `\` separators).
fn names_differ_only_by_case(old_path: &Path, new_path: &Path) -> bool {
    let old_norm = old_path.to_string_lossy().replace('\\', "/");
    let new_norm = new_path.to_string_lossy().replace('\\', "/");
    let old_trimmed = old_norm.trim_end_matches('/');
    let new_trimmed = new_norm.trim_end_matches('/');

    if old_trimmed == new_trimmed {
        return false;
    }

    let (old_parent, old_name) = match old_trimmed.rsplit_once('/') {
        Some((p, n)) => (p, n),
        None => ("", old_trimmed),
    };
    let (new_parent, new_name) = match new_trimmed.rsplit_once('/') {
        Some((p, n)) => (p, n),
        None => ("", new_trimmed),
    };

    old_name != new_name
        && old_name.to_lowercase() == new_name.to_lowercase()
        && old_parent.to_lowercase() == new_parent.to_lowercase()
}

/// Determines whether `old_path` and `new_path` point to the exact same existing filesystem object
/// undergoing a case-only rename on a case-insensitive filesystem.
fn is_same_entry_case_only_rename(old_path: &Path, new_path: &Path) -> bool {
    if !names_differ_only_by_case(old_path, new_path) {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(old_md), Ok(new_md)) = (
            fs::symlink_metadata(old_path),
            fs::symlink_metadata(new_path),
        ) {
            return old_md.dev() == new_md.dev() && old_md.ino() == new_md.ino();
        }
        false
    }

    #[cfg(not(unix))]
    {
        match (fs::canonicalize(old_path), fs::canonicalize(new_path)) {
            (Ok(canon_old), Ok(canon_new)) => canon_old == canon_new,
            _ => false,
        }
    }
}

/// Renames a file or directory at the given path.
///
/// # Arguments
/// - `path` - The current path of the file or directory
/// - `new_path` - The new path for the file or directory
///
/// # Returns
/// - `Ok(())` if the rename operation was successful
/// - `Err(Error)` if there was an error during the operation
///
/// # Example
/// ```rust
/// let result = rename_file("/path/to/old_file.txt", "/path/to/new_file.txt").await;
/// match result {
///     Ok(_) => println!("File renamed successfully!"),
///     Err(err) => println!("Error renaming file: {}", err),
/// }
/// ```
#[tauri::command]
pub async fn rename(old_path: &str, new_path: &str) -> Result<(), String> {
    let old_path_obj = Path::new(old_path);
    let new_path_obj = Path::new(new_path);

    // Use symlink_metadata so broken symlinks can also be renamed and are detected as existing
    if fs::symlink_metadata(old_path_obj).is_err() {
        log_error!("File does not exist: {}", old_path);
        return Err(Error::new(
            ErrorCode::ResourceNotFound,
            format!("File does not exist: {old_path}"),
        )
        .to_json());
    }

    // Check if the new path already exists (including broken symlinks).
    // Only allow when `old_path` and `new_path` resolve to the exact same file on a
    // case-insensitive filesystem (never overwrite a distinct file on case-sensitive Linux).
    if fs::symlink_metadata(new_path_obj).is_ok()
        && !is_same_entry_case_only_rename(old_path_obj, new_path_obj)
    {
        log_error!("New path already exists: {}", new_path);
        return Err(Error::new(
            ErrorCode::ResourceAlreadyExists,
            format!("New path already exists: {new_path}"),
        )
        .to_json());
    }

    match fs::rename(old_path, new_path) {
        Ok(_) => Ok(()),
        Err(err) => {
            log_error!("Failed to rename: {}", err);
            Err(Error::new(ErrorCode::InternalError, format!("Failed to rename: {err}")).to_json())
        }
    }
}

/// Deletes a file at the given path. Returns a string if there was an error.
/// This function moves the file to the trash instead of deleting it permanently.
///
/// # Arguments
/// - `path` - A string slice that holds the path to the file to be deleted.
///
/// # Returns
/// - `Ok(())` if the file was successfully deleted.
/// - `Err(String)` if there was an error during the deletion process.
///
/// # Example
/// ```rust
/// let result = delete_file("/path/to/file.txt").await;
/// match result {
///   Ok(_) => println!("File deleted successfully!"),
///   Err(err) => println!("Error deleting file: {}", err),
/// }
/// ```
#[tauri::command]
pub async fn move_to_trash(path: &str) -> Result<(), String> {
    let path_owned = path.to_string();
    run_blocking(move || match trash::delete(&path_owned) {
        Ok(_) => Ok(()),
        Err(err) => {
            log_error!("Failed to move file or directory to trash: {}", err);
            Err(Error::new(
                ErrorCode::InternalError,
                format!("Failed to move file or directory to trash: {err}"),
            )
            .to_json())
        }
    })
    .await
}

/// Generates a unique destination path by appending ` (n)` if the path already exists.
/// - For files (`is_dir == false`): `"file.txt"` -> `"file (1).txt"` -> `"file (2).txt"`
/// - For directories (`is_dir == true`): `"a.b"` -> `"a.b (1)"` -> `"a.b (2)"`
///
/// Returns `Err(Error)` if no free candidate is found within `max_attempts`.
fn generate_unique_path_with_limit(
    original_path: &Path,
    is_dir: bool,
    max_attempts: u32,
) -> Result<PathBuf, Error> {
    if fs::symlink_metadata(original_path).is_err() {
        return Ok(original_path.to_path_buf());
    }

    let parent = original_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = original_path
        .file_name()
        .ok_or_else(|| Error::invalid_input("Invalid destination path"))?
        .to_string_lossy();

    if !is_dir {
        if let (Some(stem), Some(extension)) =
            (original_path.file_stem(), original_path.extension())
        {
            let stem_str = stem.to_string_lossy();
            let ext_str = extension.to_string_lossy();

            for i in 1..=max_attempts {
                let new_name = format!("{stem_str} ({i}).{ext_str}");
                let new_path = parent.join(new_name);
                if fs::symlink_metadata(&new_path).is_err() {
                    return Ok(new_path);
                }
            }
        } else {
            for i in 1..=max_attempts {
                let new_name = format!("{file_name} ({i})");
                let new_path = parent.join(new_name);
                if fs::symlink_metadata(&new_path).is_err() {
                    return Ok(new_path);
                }
            }
        }
    } else {
        for i in 1..=max_attempts {
            let new_name = format!("{file_name} ({i})");
            let new_path = parent.join(new_name);
            if fs::symlink_metadata(&new_path).is_err() {
                return Ok(new_path);
            }
        }
    }

    Err(Error::new(
        ErrorCode::ResourceAlreadyExists,
        format!(
            "Could not generate a unique destination path for '{}' after {max_attempts} attempts",
            original_path.display()
        ),
    ))
}

fn generate_unique_path_buf(original_path: &Path, is_dir: bool) -> Result<PathBuf, Error> {
    generate_unique_path_with_limit(original_path, is_dir, MAX_UNIQUE_PATH_ATTEMPTS)
}

#[allow(dead_code)]
fn generate_unique_path(original_path: &str, is_dir: bool) -> Result<String, Error> {
    generate_unique_path_buf(Path::new(original_path), is_dir)
        .map(|p| p.to_string_lossy().into_owned())
}

/// Copies a file or directory from the source path to the destination path.
/// This function does not create any parent directories.
/// If the destination already exists, it will generate a unique name by appending a number.
/// If the source is a directory, it will recursively copy all files and subdirectories.
///
/// # Arguments
/// - `source_path` - A string slice that holds the path to the source file or directory.
/// - `destination_path` - A string slice that holds the path to the destination.
///
/// # Returns
/// - `Ok(u64)` - The total size of copied files in bytes.
/// - `Err(String)` - If there was an error during the copy process.
///
/// # Example
/// ```rust
/// let result = copy_file_or_dir("/path/to/source.txt", "/path/to/destination.txt").await;
/// match result {
///     Ok(size) => println!("File copied successfully! Size: {} bytes", size),
///     Err(err) => println!("Error copying file: {}", err),
/// }
/// ```
#[tauri::command]
pub async fn copy_file_or_dir(source_path: &str, destination_path: &str) -> Result<u64, String> {
    let src_owned = PathBuf::from(source_path);
    let dst_owned = PathBuf::from(destination_path);
    run_blocking(move || copy_file_or_dir_sync(&src_owned, &dst_owned)).await
}

fn copy_file_or_dir_sync(source_path: &Path, destination_path: &Path) -> Result<u64, String> {
    if !source_path.exists() {
        log_error!("Source path does not exist: {}", source_path.display());
        return Err(Error::new(
            ErrorCode::InvalidInput,
            format!("Source path does not exist: {}", source_path.display()),
        )
        .to_json());
    }

    let is_dir = source_path.is_dir();
    let final_destination_path =
        generate_unique_path_buf(destination_path, is_dir).map_err(|err| {
            log_error!("{}", err.custom_message);
            err.to_json()
        })?;

    if is_dir {
        if let Ok(canon_src) = fs::canonicalize(source_path) {
            let dest_parent = final_destination_path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."))
                .canonicalize()
                .ok();
            if let Some(canon_dest_parent) = dest_parent {
                if canon_dest_parent == canon_src || canon_dest_parent.starts_with(&canon_src) {
                    log_error!(
                        "Cannot copy directory into itself: {} -> {}",
                        source_path.display(),
                        final_destination_path.display()
                    );
                    return Err(Error::new(
                        ErrorCode::InvalidInput,
                        "Cannot copy a directory into itself or a subdirectory of itself"
                            .to_string(),
                    )
                    .to_json());
                }
            }
        }

        let mut visited = HashSet::new();
        copy_dir_recursive_sync(source_path, &final_destination_path, &mut visited).map_err(|err| {
            log_error!("{}", err.custom_message);
            err.to_json()
        })
    } else {
        fs::copy(source_path, &final_destination_path).map_err(|err| {
            log_error!("Failed to copy file: {}", err);
            Error::new(
                ErrorCode::InternalError,
                format!("Failed to copy file: {err}"),
            )
            .to_json()
        })
    }
}

fn copy_dir_recursive_sync(
    source_dir: &Path,
    dest_dir: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Result<u64, Error> {
    let canon_src = fs::canonicalize(source_dir).map_err(|err| {
        Error::new(
            ErrorCode::InternalError,
            format!(
                "Failed to resolve source directory '{}': {err}",
                source_dir.display()
            ),
        )
    })?;

    if !visited.insert(canon_src) {
        // Directory was already visited in this traversal (symlink / junction cycle)
        return Ok(0);
    }

    fs::create_dir_all(dest_dir).map_err(|err| {
        Error::new(
            ErrorCode::InternalError,
            format!("Failed to create destination directory: {err}"),
        )
    })?;

    let mut total_size = 0;

    let entries = read_dir(source_dir).map_err(|err| {
        Error::new(
            ErrorCode::InternalError,
            format!("Failed to read source directory: {err}"),
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|err| {
            Error::new(
                ErrorCode::InternalError,
                format!("Failed to read directory entry: {err}"),
            )
        })?;

        let file_type = entry.file_type().map_err(|err| {
            Error::new(
                ErrorCode::InternalError,
                format!("Failed to inspect directory entry type: {err}"),
            )
        })?;

        // Never follow symlinks / junctions during recursive directory copy
        if file_type.is_symlink() {
            continue;
        }

        let entry_path = entry.path();
        let dest_path = dest_dir.join(entry.file_name());

        if file_type.is_file() {
            let size = fs::copy(&entry_path, &dest_path).map_err(|err| {
                Error::new(
                    ErrorCode::InternalError,
                    format!("Failed to copy file '{}': {err}", entry_path.display()),
                )
            })?;
            total_size += size;
        } else if file_type.is_dir() {
            let sub_size = copy_dir_recursive_sync(&entry_path, &dest_path, visited)?;
            total_size += sub_size;
        }
    }

    Ok(total_size)
}

/// Zips files and directories to a destination zip file.
/// If only one source path is provided and no destination is specified, creates a zip file with the same name.
/// For multiple source paths, the destination path must be specified.
///
/// # Arguments
/// * `source_paths` - Vector of paths to files/directories to be zipped
/// * `destination_path` - Optional destination path for the zip file
///
/// # Returns
/// * `Ok(())` - If the zip file was successfully created
/// * `Err(String)` - If there was an error during the zipping process
///
/// # Example
/// ```rust
/// // Single file/directory with auto destination
/// let result = zip(vec!["/path/to/file.txt"], None).await;
///
/// // Multiple files to specific destination
/// let result = zip(
///     vec!["/path/to/file1.txt", "/path/to/dir1"],
///     Some("/path/to/archive.zip")
/// ).await;
/// ```
#[tauri::command]
pub async fn zip(
    source_paths: Vec<String>,
    destination_path: Option<String>,
) -> Result<(), String> {
    run_blocking(move || zip_sync(source_paths, destination_path)).await
}

fn zip_sync(source_paths: Vec<String>, destination_path: Option<String>) -> Result<(), String> {
    if source_paths.is_empty() {
        log_error!("No source paths provided");
        return Err(Error::new(
            ErrorCode::InvalidInput,
            "No source paths provided".to_string(),
        )
        .to_json());
    }

    if source_paths.len() > 1 && destination_path.is_none() {
        log_error!("Destination path required for multiple sources");
        return Err(Error::new(
            ErrorCode::InvalidInput,
            "Destination path required for multiple sources".to_string(),
        )
        .to_json());
    }

    // 1. Validate ALL source paths before creating any output file on disk
    let mut validated_sources: Vec<(PathBuf, PathBuf, String)> =
        Vec::with_capacity(source_paths.len());
    for source_path in &source_paths {
        let source = PathBuf::from(source_path);
        if !source.exists() {
            log_error!("Source path does not exist: {}", source_path);
            return Err(Error::new(
                ErrorCode::ResourceNotFound,
                format!("Source path does not exist: {source_path}"),
            )
            .to_json());
        }
        let base_name = source
            .file_name()
            .ok_or_else(|| {
                Error::new(ErrorCode::InvalidInput, "Invalid source name".to_string()).to_json()
            })?
            .to_string_lossy()
            .into_owned();
        let canon = fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
        validated_sources.push((source, canon, base_name));
    }

    // 2. Compute safe target zip path (never truncate an existing source .zip or strip dot from folder names)
    let requested_zip_path = if let Some(dest) = &destination_path {
        PathBuf::from(dest)
    } else {
        let single_source = &validated_sources[0].0;
        if single_source.is_dir() {
            let mut os = single_source.as_os_str().to_os_string();
            os.push(".zip");
            PathBuf::from(os)
        } else {
            single_source.with_extension("zip")
        }
    };

    let collides_with_source = fs::canonicalize(&requested_zip_path)
        .ok()
        .map(|canon_dest| {
            validated_sources
                .iter()
                .any(|(_, canon_src, _)| &canon_dest == canon_src)
        })
        .unwrap_or_else(|| {
            validated_sources
                .iter()
                .any(|(src, _, _)| src == &requested_zip_path)
        });

    let zip_path = if destination_path.is_none() || collides_with_source {
        generate_unique_path_buf(&requested_zip_path, false).map_err(|err| {
            log_error!("{}", err.custom_message);
            err.to_json()
        })?
    } else {
        requested_zip_path
    };

    let zip_parent = zip_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    // 3. Write to a temporary file in the same directory and only rename on completion
    let temp_zip = tempfile::Builder::new()
        .prefix(".explr_zip_")
        .suffix(".tmp")
        .tempfile_in(zip_parent)
        .map_err(|e| {
            log_error!("Failed to create temporary zip file: {}", e);
            Error::new(
                ErrorCode::InternalError,
                format!("Failed to create zip file: {e}"),
            )
            .to_json()
        })?;

    let temp_zip_path = temp_zip.path().to_path_buf();
    let canon_temp_zip = fs::canonicalize(&temp_zip_path).ok();
    let canon_final_zip = fs::canonicalize(&zip_path).ok();

    let zip_file = temp_zip.as_file().try_clone().map_err(|e| {
        log_error!("Failed to clone temporary zip file handle: {}", e);
        Error::new(
            ErrorCode::InternalError,
            format!("Failed to create zip file: {e}"),
        )
        .to_json()
    })?;

    let mut zip = ZipWriter::new(zip_file);
    let options: FileOptions<()> = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);

    for (source, _, base_name) in &validated_sources {
        let symlink_meta = fs::symlink_metadata(source).map_err(|e| {
            log_error!("Failed to inspect source metadata: {}", e);
            Error::new(
                ErrorCode::InternalError,
                format!("Failed to inspect source metadata: {e}"),
            )
            .to_json()
        })?;

        if symlink_meta.file_type().is_symlink() {
            continue;
        }

        if source.is_file() {
            zip.start_file(base_name.as_str(), options).map_err(|e| {
                log_error!("Error adding file to zip: {}", e);
                Error::new(
                    ErrorCode::InternalError,
                    format!("Error adding file to zip: {e}"),
                )
                .to_json()
            })?;
            let mut f = fs::File::open(source).map_err(|e| {
                log_error!("Error opening file for zip: {}", e);
                Error::new(ErrorCode::InternalError, format!("Error reading file: {e}")).to_json()
            })?;
            std::io::copy(&mut f, &mut zip).map_err(|e| {
                log_error!("Error streaming file to zip: {}", e);
                Error::new(
                    ErrorCode::InternalError,
                    format!("Error writing to zip: {e}"),
                )
                .to_json()
            })?;
        } else if source.is_dir() {
            for entry in walkdir::WalkDir::new(source).follow_links(false) {
                let entry = entry.map_err(|e| {
                    log_error!("Error reading directory: {}", e);
                    Error::new(
                        ErrorCode::InternalError,
                        format!("Error reading directory: {e}"),
                    )
                    .to_json()
                })?;
                let path = entry.path();

                if entry.path_is_symlink() || entry.file_type().is_symlink() {
                    continue;
                }

                if path == temp_zip_path || path == zip_path {
                    continue;
                }
                if let Ok(canon_entry) = fs::canonicalize(path) {
                    if canon_temp_zip.as_ref() == Some(&canon_entry)
                        || canon_final_zip.as_ref() == Some(&canon_entry)
                    {
                        continue;
                    }
                }

                let relative = path.strip_prefix(source).map_err(|e| {
                    log_error!("Failed to strip prefix: {}", e);
                    Error::new(
                        ErrorCode::InternalError,
                        format!("Error creating relative path: {e}"),
                    )
                    .to_json()
                })?;

                if relative.as_os_str().is_empty() {
                    continue;
                }

                let rel_str = relative.to_string_lossy().replace('\\', "/");
                let name = format!("{base_name}/{rel_str}");

                if entry.file_type().is_file() {
                    zip.start_file(&name, options).map_err(|e| {
                        log_error!("Error adding file to zip: {}", e);
                        Error::new(
                            ErrorCode::InternalError,
                            format!("Error adding file to zip: {e}"),
                        )
                        .to_json()
                    })?;
                    let mut f = fs::File::open(path).map_err(|e| {
                        log_error!("Error reading file: {}", e);
                        Error::new(ErrorCode::InternalError, format!("Error reading file: {e}"))
                            .to_json()
                    })?;
                    std::io::copy(&mut f, &mut zip).map_err(|e| {
                        log_error!("Error writing to zip: {}", e);
                        Error::new(
                            ErrorCode::InternalError,
                            format!("Error writing to zip: {e}"),
                        )
                        .to_json()
                    })?;
                } else if entry.file_type().is_dir() {
                    let dir_entry_name = format!("{name}/");
                    zip.add_directory(&dir_entry_name, options).map_err(|e| {
                        log_error!("Error adding directory to zip: {}", e);
                        Error::new(
                            ErrorCode::InternalError,
                            format!("Error adding directory to zip: {e}"),
                        )
                        .to_json()
                    })?;
                }
            }
        }
    }

    let finished_file = zip.finish().map_err(|e| {
        log_error!("Error finalizing zip file: {}", e);
        Error::new(
            ErrorCode::InternalError,
            format!("Error finalizing zip file: {e}"),
        )
        .to_json()
    })?;
    drop(finished_file);

    temp_zip.persist(&zip_path).map_err(|e| {
        log_error!("Failed to persist zip archive: {}", e.error);
        Error::new(
            ErrorCode::InternalError,
            format!("Failed to finalize zip file: {}", e.error),
        )
        .to_json()
    })?;

    Ok(())
}

/// Validates a zip archive entry name, returning its safe relative `PathBuf` inside the extraction root.
/// Rejects empty paths, `.`/`..`, path traversal (`..` with `/` or `\`), absolute prefixes, and null bytes.
fn validate_zip_entry_path(raw_name: &str, enclosed: Option<PathBuf>) -> Result<PathBuf, Error> {
    if raw_name.contains('\0') {
        return Err(Error::invalid_input(
            "Zip entry contains null byte in file name",
        ));
    }

    // Explicitly reject any `.` or `..` segments across both `/` and `\` separators
    let trimmed = raw_name.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(Error::invalid_input(format!(
            "Zip entry has unsafe or empty path: '{raw_name}'"
        )));
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err(Error::invalid_input(format!(
            "Zip entry has absolute path: '{raw_name}'"
        )));
    }
    for segment in trimmed.split(['/', '\\']) {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(Error::invalid_input(format!(
                "Zip entry contains path traversal segment: '{raw_name}'"
            )));
        }
    }

    let enclosed = enclosed.ok_or_else(|| {
        Error::invalid_input(format!(
            "Zip entry escapes extraction directory: '{raw_name}'"
        ))
    })?;

    let mut normalized = PathBuf::new();
    for comp in enclosed.components() {
        match comp {
            Component::Normal(part) => {
                let s = part.to_string_lossy();
                for sub in s.split('\\') {
                    if sub.is_empty() || sub == "." || sub == ".." {
                        return Err(Error::invalid_input(format!(
                            "Zip entry contains invalid component: '{raw_name}'"
                        )));
                    }
                    normalized.push(sub);
                }
            }
            _ => {
                return Err(Error::invalid_input(format!(
                    "Zip entry contains non-normal path component: '{raw_name}'"
                )));
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err(Error::invalid_input(format!(
            "Zip entry resolves to empty path: '{raw_name}'"
        )));
    }

    Ok(normalized)
}

/// Verifies that no existing component along `target` under `base_dir` is a symlink.
fn ensure_no_symlink_components(base_dir: &Path, target: &Path) -> Result<(), Error> {
    if let Ok(rel) = target.strip_prefix(base_dir) {
        let mut cur = base_dir.to_path_buf();
        for comp in rel.components() {
            cur.push(comp);
            if let Ok(md) = fs::symlink_metadata(&cur) {
                if md.file_type().is_symlink() {
                    return Err(Error::new(
                        ErrorCode::Unauthorized,
                        format!(
                            "Refusing to extract through symbolic link component: {}",
                            cur.display()
                        ),
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Extracts zip files to specified destinations.
/// If extracting a single zip file without a specified destination,
/// extracts to a directory with the same name as the zip file.
///
/// # Arguments
/// * `zip_paths` - Vector of paths to zip files
/// * `destination_path` - Optional destination directory for extraction
///
/// # Returns
/// * `Ok(())` - If all zip files were successfully extracted
/// * `Err(String)` - If there was an error during extraction
///
/// # Example
/// ```rust
/// // Single zip with auto destination
/// let result = unzip(vec!["/path/to/archive.zip"], None).await;
///
/// // Multiple zips to specific destination
/// let result = unzip(
///     vec!["/path/to/zip1.zip", "/path/to/zip2.zip"],
///     Some("/path/to/extracted")
/// ).await;
/// ```
#[tauri::command]
pub async fn unzip(zip_paths: Vec<String>, destination_path: Option<String>) -> Result<(), String> {
    run_blocking(move || {
        unzip_with_limits_sync(
            zip_paths,
            destination_path,
            MAX_UNZIP_ENTRIES,
            MAX_UNZIP_TOTAL_BYTES,
        )
    })
    .await
}

fn unzip_with_limits_sync(
    zip_paths: Vec<String>,
    destination_path: Option<String>,
    max_entries: usize,
    max_total_bytes: u64,
) -> Result<(), String> {
    if zip_paths.is_empty() {
        log_error!("No zip files provided");
        return Err(
            Error::new(ErrorCode::InvalidInput, "No zip files provided".to_string()).to_json(),
        );
    }

    if zip_paths.len() > 1 && destination_path.is_none() {
        log_error!("Destination path required for multiple zip files");
        return Err(Error::new(
            ErrorCode::InvalidInput,
            "Destination path required for multiple zip files".to_string(),
        )
        .to_json());
    }

    let dest_path_buf = match &destination_path {
        Some(dest) => PathBuf::from(dest),
        None => Path::new(&zip_paths[0])
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf(),
    };
    let dest_path = dest_path_buf.as_path();

    if !dest_path.exists() {
        log_error!("Destination path does not exist");
        return Err(Error::new(
            ErrorCode::ResourceNotFound,
            "Destination path does not exist".to_string(),
        )
        .to_json());
    }

    if !dest_path.is_dir() {
        log_error!("Destination path exists but is not a directory");
        return Err(Error::new(
            ErrorCode::InvalidInput,
            "Destination path exists but is not a directory".to_string(),
        )
        .to_json());
    }

    let mut total_extracted_bytes: u64 = 0;

    for zip_path_str in &zip_paths {
        let zip_path = Path::new(zip_path_str);
        if !zip_path.exists() {
            log_error!("Zip file does not exist: {}", zip_path.display());
            return Err(Error::new(
                ErrorCode::ResourceNotFound,
                format!("Zip file does not exist: {}", zip_path.display()),
            )
            .to_json());
        }

        let zip_name = match zip_path.file_stem() {
            Some(name) => name,
            None => {
                log_error!("Invalid zip filename");
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    "Invalid zip filename".to_string(),
                )
                .to_json());
            }
        };

        let file = fs::File::open(zip_path).map_err(|e| {
            log_error!("Failed to open zip file: {}", e);
            Error::new(
                ErrorCode::InternalError,
                format!("Failed to open zip file: {e}"),
            )
            .to_json()
        })?;

        let mut archive = zip::ZipArchive::new(file).map_err(|e| {
            log_error!("Failed to read zip archive: {}", e);
            Error::new(
                ErrorCode::InternalError,
                format!("Failed to read zip archive: {e}"),
            )
            .to_json()
        })?;

        if archive.len() > max_entries {
            log_error!(
                "Zip archive exceeds maximum entry limit ({} > {})",
                archive.len(),
                max_entries
            );
            return Err(Error::new(
                ErrorCode::InvalidInput,
                format!(
                    "Zip archive contains too many entries ({}, max allowed is {max_entries})",
                    archive.len()
                ),
            )
            .to_json());
        }

        // First pass: validate all entry names, reject symlinks, and check declared uncompressed size
        // before creating any directories or files on disk.
        let mut validated_entries: Vec<(PathBuf, bool)> = Vec::with_capacity(archive.len());
        let mut declared_bytes: u64 = total_extracted_bytes;
        let mut non_dir_count = 0usize;

        for i in 0..archive.len() {
            let entry = archive.by_index(i).map_err(|e| {
                log_error!("Failed to read zip entry: {}", e);
                Error::new(
                    ErrorCode::InternalError,
                    format!("Failed to read zip entry: {e}"),
                )
                .to_json()
            })?;

            let is_unix_symlink = entry
                .unix_mode()
                .map(|mode| (mode & 0o170000) == 0o120000)
                .unwrap_or(false);
            if entry.is_symlink() || is_unix_symlink {
                log_error!("Rejecting symlink entry in zip archive: {}", entry.name());
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    format!(
                        "Zip archive contains unsupported symbolic link entry: '{}'",
                        entry.name()
                    ),
                )
                .to_json());
            }

            let raw_name = entry.name();
            let is_dir_entry =
                entry.is_dir() || raw_name.ends_with('/') || raw_name.ends_with('\\');
            let safe_rel_path =
                validate_zip_entry_path(raw_name, entry.enclosed_name()).map_err(|err| {
                    log_error!("{}", err.custom_message);
                    err.to_json()
                })?;

            if !is_dir_entry {
                non_dir_count += 1;
                declared_bytes = declared_bytes.saturating_add(entry.size());
                if declared_bytes > max_total_bytes {
                    log_error!(
                        "Zip archive exceeds maximum uncompressed size limit ({} > {})",
                        declared_bytes,
                        max_total_bytes
                    );
                    return Err(Error::new(
                        ErrorCode::InvalidInput,
                        format!(
                            "Zip archive exceeds maximum allowed uncompressed size ({max_total_bytes} bytes)"
                        ),
                    )
                    .to_json());
                }
            }

            validated_entries.push((safe_rel_path, is_dir_entry));
        }

        let is_single_file = non_dir_count == 1 && archive.len() == 1;

        let extract_path = if is_single_file {
            dest_path.to_path_buf()
        } else {
            let extract_path_initial = dest_path.join(zip_name);
            generate_unique_path_buf(&extract_path_initial, true).map_err(|err| {
                log_error!("{}", err.custom_message);
                err.to_json()
            })?
        };

        if !is_single_file {
            if let Err(e) = fs::create_dir_all(&extract_path) {
                log_error!("Failed to create extraction directory: {}", e);
                return Err(Error::new(
                    ErrorCode::InternalError,
                    format!("Failed to create extraction directory: {e}"),
                )
                .to_json());
            }
        }

        for (i, (safe_rel_path, is_dir_entry)) in validated_entries.into_iter().enumerate() {
            let mut file = archive.by_index(i).map_err(|e| {
                log_error!("Failed to read zip entry: {}", e);
                Error::new(
                    ErrorCode::InternalError,
                    format!("Failed to read zip entry: {e}"),
                )
                .to_json()
            })?;

            let outpath = extract_path.join(&safe_rel_path);
            ensure_no_symlink_components(&extract_path, &outpath).map_err(|err| {
                log_error!("{}", err.custom_message);
                err.to_json()
            })?;

            if is_dir_entry {
                fs::create_dir_all(&outpath).map_err(|e| {
                    log_error!("Failed to create directory: {}", e);
                    Error::new(
                        ErrorCode::InternalError,
                        format!("Failed to create directory '{}': {e}", outpath.display()),
                    )
                    .to_json()
                })?;
            } else {
                let unique_outpath = generate_unique_path_buf(&outpath, false).map_err(|err| {
                    log_error!("{}", err.custom_message);
                    err.to_json()
                })?;

                ensure_no_symlink_components(&extract_path, &unique_outpath).map_err(|err| {
                    log_error!("{}", err.custom_message);
                    err.to_json()
                })?;

                if let Some(parent) = unique_outpath.parent() {
                    if !parent.exists() {
                        fs::create_dir_all(parent).map_err(|e| {
                            log_error!("Failed to create parent directory: {}", e);
                            Error::new(
                                ErrorCode::InternalError,
                                format!(
                                    "Failed to create parent directory '{}': {e}",
                                    parent.display()
                                ),
                            )
                            .to_json()
                        })?;
                    }
                }

                let mut outfile = fs::File::create(&unique_outpath).map_err(|e| {
                    log_error!("Failed to create file: {}", e);
                    Error::new(
                        ErrorCode::InternalError,
                        format!("Failed to create file '{}': {e}", unique_outpath.display()),
                    )
                    .to_json()
                })?;

                let remaining_budget = max_total_bytes.saturating_sub(total_extracted_bytes);
                let mut limited_reader = (&mut file).take(remaining_budget.saturating_add(1));
                let written = std::io::copy(&mut limited_reader, &mut outfile).map_err(|e| {
                    log_error!("Failed to write file: {}", e);
                    Error::new(
                        ErrorCode::InternalError,
                        format!("Failed to write file '{}': {e}", unique_outpath.display()),
                    )
                    .to_json()
                })?;
                drop(outfile);

                if written > remaining_budget {
                    let _ = fs::remove_file(&unique_outpath);
                    log_error!("Zip extraction exceeded maximum allowed uncompressed bytes");
                    return Err(Error::new(
                        ErrorCode::InvalidInput,
                        format!(
                            "Zip archive exceeds maximum allowed uncompressed size ({max_total_bytes} bytes)"
                        ),
                    )
                    .to_json());
                }

                total_extracted_bytes = total_extracted_bytes.saturating_add(written);
            }
        }
        // NOTE: Never delete the user's source zip archive (`zip_path`) after extraction!
    }

    Ok(())
}

#[cfg(test)]
mod tests_file_system_operation_commands {
    use super::*;
    use crate::models::{count_subdirectories, count_subfiles};
    use tempfile::tempdir;

    #[tokio::test]
    async fn open_file_test() {
        use std::io::Write;
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("open_file_test.txt");

        // Write some content to the test file
        let mut test_file = fs::File::create(&test_path).expect("Failed to create test file");
        writeln!(test_file, "Hello, world!").expect("Failed to write to test file");

        // Ensure the file exists
        assert!(test_path.exists(), "Test file should exist before reading");

        // Open the file and read its contents
        let result = open_file(test_path.to_str().unwrap()).await;

        // Verify that the operation was successful
        assert!(result.is_ok(), "Failed to open file: {result:?}");

        // Verify the file contents
        assert_eq!(
            result.unwrap(),
            "Hello, world!\n",
            "File contents do not match expected value"
        );
    }

    #[tokio::test]
    #[cfg(feature = "open-file-in-app")]
    async fn open_in_default_app_test() {
        use std::env;
        let current_dir = env::current_dir().expect("Failed to get current directory");

        let file_extensions = vec!["txt", "pdf", "mp4", "jpg", "png", "html"];

        for file_extension in file_extensions {
            let test_path = current_dir
                .join("assets")
                .join(format!("dummy.{}", file_extension));

            // Ensure the file exists
            assert!(test_path.exists(), "Test file should exist before opening");

            // Open the file in the default application
            let result = open_in_default_app(test_path.to_str().unwrap()).await;

            // Verify that the operation was successful
            assert!(
                result.is_ok(),
                "Failed to open file in default app: {:?}",
                result
            );
        }
    }

    #[tokio::test]
    async fn failed_to_open_file_because_file_not_exists_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("open_file_test.txt");

        // Open the file and read its contents
        let result = open_file(test_path.to_str().unwrap()).await;

        // Verify that the operation was successful
        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );
        assert!(
            result.clone().unwrap_err().contains("File does not exist"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("405"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("ResourceNotFound"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn failed_to_open_file_because_path_is_not_a_file_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("open_file_test.txt");

        // Create the test file
        fs::File::create(&test_path).unwrap();

        // Ensure the file exists
        assert!(test_path.exists(), "Test file should exist before reading");

        // Open the file and read its contents
        let result = open_file(temp_dir.path().to_str().unwrap()).await;

        // Verify that the operation was successful
        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result.clone().unwrap_err().contains("Path is not a file"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("408"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("InvalidInput"),
            "Error message does not match expected value"
        );
    }

    #[cfg(feature = "long-tests")]
    #[tokio::test]
    async fn move_file_to_trash_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("move_to_trash_test.txt");

        // Create the test file
        fs::File::create(&test_path).unwrap();

        // Ensure the file exists
        assert!(test_path.exists(), "Test file should exist before deletion");

        eprintln!("Test file exists: {:?}", test_path);

        // Move the file to the trash
        let result = move_to_trash(test_path.to_str().unwrap()).await;

        // Verify that the operation was successful
        assert!(result.is_ok(), "Failed to move file to trash: {:?}", result);

        // Verify that the file no longer exists at the original path
        assert!(
            !test_path.exists(),
            "File should no longer exist at the original path"
        );

        // No manual cleanup needed, as the temporary directory is automatically deleted
    }

    #[tokio::test]
    async fn failed_move_to_trash_because_empty_path_test() {
        let result = move_to_trash("").await;
        assert!(
            result.is_err(),
            "Empty path should fail when moving to trash: {result:?}"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("Failed to move file or directory to trash"),
            "Unexpected error message: {err}"
        );
        assert!(
            err.contains("InternalError"),
            "Unexpected error code: {err}"
        );
    }

    #[tokio::test]
    async fn failed_move_to_trash_because_invalid_resource_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut invalid_test_path = temp_dir.path().to_path_buf();
        invalid_test_path.push("move_to_trash_test.txt");

        // Ensure the file does not exist
        assert!(
            !invalid_test_path.exists(),
            "Test file should not exist before deletion"
        );

        eprintln!("Test file exists: {invalid_test_path:?}");

        // Move the file to the trash
        let result = move_to_trash(invalid_test_path.to_str().unwrap()).await;

        // Verify that the operation was successful
        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("Failed to move file or directory to trash"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("500"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("InternalError"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn create_file_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file path in the temporary directory
        let test_path = temp_dir.path().join("create_file_test.txt");

        // Call the function to create the file
        let result = create_file(temp_dir.path().to_str().unwrap(), "create_file_test.txt").await;

        // Verify that the operation was successful
        assert!(result.is_ok(), "Failed to create file: {result:?}");

        // Verify that the file exists at the specified pat´ßp0
        assert!(test_path.exists(), "File should exist after creation");
    }
    #[tokio::test]
    async fn failed_to_create_file_because_directory_does_not_exist_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file path in the temporary directory
        let test_path = temp_dir.path().join("missing_dir");

        // Call the function to create the file
        let result = create_file(test_path.to_str().unwrap(), "create_file_test.txt").await;

        // Verify that the operation was successful
        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("Directory does not exist"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("405"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("ResourceNotFound"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn failed_to_create_file_because_path_is_no_directory_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        let test_path = temp_dir.path().join("not_a_folder.txt");
        fs::File::create(&test_path).unwrap();

        // Call the function to create the file
        let result = create_file(test_path.to_str().unwrap(), "create_file_test.txt").await;

        // Verify that the operation was successful
        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result.clone().unwrap_err().contains("Path is no directory"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("408"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("InvalidInput"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn create_directory_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test directory path in the temporary directory
        let test_path = temp_dir.path().join("create_directory_test");

        // Call the function to create the directory
        let result =
            create_directory(temp_dir.path().to_str().unwrap(), "create_directory_test").await;

        // Verify that the operation was successful
        assert!(result.is_ok(), "Failed to create directory: {result:?}");

        // Verify that the directory exists at the specified path
        assert!(test_path.exists(), "Directory should exist after creation");
    }

    #[tokio::test]
    async fn failed_to_create_directory_because_parent_directory_does_not_exist_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test directory path in the temporary directory
        let test_path = temp_dir.path().join("missing_dir");

        // Call the function to create the directory
        let result = create_directory(
            test_path.join("not_a_parent_directory").to_str().unwrap(),
            "create_directory_test",
        )
        .await;

        // Verify that the operation was successful
        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("Parent directory does not exist"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("405"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("ResourceNotFound"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn open_directory_test() {
        use std::io::Write;
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        println!("Temporary directory created: {:?}", temp_dir.path());

        // Create a subdirectory
        let sub_dir_path = temp_dir.path().join("subdir");
        fs::create_dir(&sub_dir_path).expect("Failed to create subdirectory");
        println!("Temporary subdirectory created: {sub_dir_path:?}");

        // Create files in the root directory
        let file1_path = temp_dir.path().join("file1.txt");
        let mut file1 = fs::File::create(&file1_path).expect("Failed to create file1");
        writeln!(file1, "File 1 content").expect("Failed to write to file1");
        println!("File 1 created: {file1_path:?}");

        let file2_path = temp_dir.path().join("file2.txt");
        let mut file2 = fs::File::create(&file2_path).expect("Failed to create file2");
        writeln!(file2, "File 2 content").expect("Failed to write to file2");
        println!("File 2 created: {file2_path:?}");

        // Create files in the subdirectory
        let sub_file1_path = sub_dir_path.join("sub_file1.txt");
        let mut sub_file1 = fs::File::create(&sub_file1_path).expect("Failed to create sub_file1");
        writeln!(sub_file1, "Sub File 1 content").expect("Failed to write to sub_file1");
        println!("Sub File 1 created: {sub_file1_path:?}");

        let sub_file2_path = sub_dir_path.join("sub_file2.txt");
        let mut sub_file2 = fs::File::create(&sub_file2_path).expect("Failed to create sub_file2");
        writeln!(sub_file2, "Sub File 2 content").expect("Failed to write to sub_file2");
        println!("Sub File 2 created: {sub_file2_path:?}");

        // Call the open_directory function
        let result = open_directory(temp_dir.path().to_str().unwrap().to_string()).await;

        // Verify that the operation was successful
        assert!(result.is_ok(), "Failed to open directory: {result:?}");

        let entries = result.unwrap();
        let entries: Entries = serde_json::from_str(&entries).expect("Failed to parse JSON");

        // Verify directories
        assert_eq!(entries.directories.len(), 1, "Expected 1 subdirectory");
        assert_eq!(
            entries.directories[0].name, "subdir",
            "Subdirectory name does not match"
        );

        // Verify files in the root directory
        assert_eq!(
            entries.files.len(),
            2,
            "Expected 2 files in the root directory"
        );
        let file_names: Vec<String> = entries.files.iter().map(|f| f.name.clone()).collect();
        assert!(
            file_names.contains(&"file1.txt".to_string()),
            "file1.txt not found"
        );
        assert!(
            file_names.contains(&"file2.txt".to_string()),
            "file2.txt not found"
        );

        // Verify subdirectory contents
        let subdir_result = open_directory(sub_dir_path.to_str().unwrap().to_string()).await;
        assert!(
            subdir_result.is_ok(),
            "Failed to open subdirectory: {subdir_result:?}"
        );

        let subdir_entries = subdir_result.unwrap();
        let subdir_entries: Entries =
            serde_json::from_str(&subdir_entries).expect("Failed to parse JSON");
        assert_eq!(
            subdir_entries.files.len(),
            2,
            "Expected 2 files in the subdirectory"
        );
        let sub_file_names: Vec<String> = subdir_entries
            .files
            .iter()
            .map(|f| f.name.clone())
            .collect();
        assert!(
            sub_file_names.contains(&"sub_file1.txt".to_string()),
            "sub_file1.txt not found"
        );
        assert!(
            sub_file_names.contains(&"sub_file2.txt".to_string()),
            "sub_file2.txt not found"
        );
    }

    #[tokio::test]
    async fn failed_to_open_directory_because_directory_does_not_exist_test() {
        use super::*;
        use tempfile::tempdir;
        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("open_directory_test.txt");

        // Open the file and read its contents
        let result = open_directory(test_path.to_str().unwrap().to_string()).await;

        // Verify that the operation was successful
        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("Directory does not exist"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("405"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("ResourceNotFound"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn failed_to_open_directory_because_path_is_not_a_directory_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("open_directory_test.txt");

        // Create the test file
        fs::File::create(&test_path).unwrap();

        // Ensure the file exists
        assert!(test_path.exists(), "Test file should exist before reading");

        // Open the file and read its contents
        let result = open_directory(test_path.to_str().unwrap().to_string()).await;

        // Verify that the operation was successful
        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("Path is not a directory"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("408"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("InvalidInput"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn rename_file_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("rename_file_test.txt");

        // Create the test file
        fs::File::create(&test_path).unwrap();

        // Ensure the file exists
        assert!(test_path.exists(), "Test file should exist before renaming");

        // Rename the file
        let new_name = "renamed_file.txt";
        let new_path = temp_dir.path().join(new_name);
        let result = rename(test_path.to_str().unwrap(), new_path.to_str().unwrap()).await;

        // Verify that the operation was successful
        assert!(result.is_ok(), "Failed to rename file: {result:?}");

        // Verify that the file exists at the new path
        assert!(new_path.exists(), "File should exist at the new path");
    }

    #[tokio::test]
    async fn failed_to_rename_because_file_does_not_exist_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("rename_file_test.txt");

        // Rename the file
        let new_name = "renamed_file.txt";
        let new_path = temp_dir.path().join(new_name);
        let result = rename(test_path.to_str().unwrap(), new_path.to_str().unwrap()).await;

        // Verify that the operation was successful
        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result.clone().unwrap_err().contains("File does not exist"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("405"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("ResourceNotFound"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn failed_to_rename_because_new_path_already_exists_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("rename_file_test.txt");

        // Create the test file
        fs::File::create(&test_path).unwrap();

        // Ensure the file exists
        assert!(test_path.exists(), "Test file should exist before renaming");

        // Rename the file
        let new_name = "renamed_file.txt";
        let new_path = temp_dir.path().join(new_name);
        fs::File::create(&new_path).unwrap(); // Create the new path to simulate conflict

        let result = rename(test_path.to_str().unwrap(), new_path.to_str().unwrap()).await;

        // Verify that the operation was successful
        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("New path already exists"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("409"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("ResourceAlreadyExists"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn rename_directory_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test directory in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("rename_directory_test");

        // Create the test directory
        fs::create_dir(&test_path).unwrap();

        // Ensure the directory exists
        assert!(
            test_path.exists(),
            "Test directory should exist before renaming"
        );

        // Rename the directory
        let new_name = "renamed_directory";
        let new_path = temp_dir.path().join(new_name);
        let result = rename(test_path.to_str().unwrap(), new_path.to_str().unwrap()).await;

        // Verify that the operation was successful
        assert!(result.is_ok(), "Failed to rename directory: {result:?}");

        // Verify that the directory exists at the new path
        assert!(new_path.exists(), "Directory should exist at the new path");
    }

    #[tokio::test]
    async fn copy_file_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("copy_file_test.txt");

        // Create the test file
        fs::File::create(&test_path).unwrap();

        // Ensure the file exists
        assert!(test_path.exists(), "Test file should exist before copying");

        // Copy the file
        let new_name = "copied_file.txt";
        let new_path = temp_dir.path().join(new_name);
        let result =
            copy_file_or_dir(test_path.to_str().unwrap(), new_path.to_str().unwrap()).await;

        // Verify that the operation was successful
        assert!(result.is_ok(), "Failed to copy file: {result:?}");

        // Verify that the copied file exists at the new path
        assert!(
            new_path.exists(),
            "Copied file should exist at the new path"
        );

        // Verify the old file still exists
        assert!(test_path.exists(), "Original file should still exist");
    }

    #[tokio::test]
    async fn copy_directory_test() {
        use std::io::Write;
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test directory in the temporary directory
        let test_path = temp_dir.path().join("copy_directory_test");
        fs::create_dir(&test_path).unwrap();

        // Create a file in the test directory
        let file_in_dir_path = test_path.join("file_in_dir.txt");
        let mut file_in_dir =
            fs::File::create(&file_in_dir_path).expect("Failed to create file in directory");
        writeln!(file_in_dir, "Content of file in directory").expect("Failed to write to file");

        // Create a subdirectory
        let subdir_path = test_path.join("subdir");
        fs::create_dir(&subdir_path).unwrap();

        // Create a file in the subdirectory
        let file_in_subdir_path = subdir_path.join("file_in_subdir.txt");
        let mut file_in_subdir =
            fs::File::create(&file_in_subdir_path).expect("Failed to create file in subdirectory");
        writeln!(file_in_subdir, "Content of file in subdirectory")
            .expect("Failed to write to file");

        // Ensure the directory structure exists
        assert!(
            test_path.exists(),
            "Test directory should exist before copying"
        );
        assert!(
            file_in_dir_path.exists(),
            "File in directory should exist before copying"
        );
        assert!(
            subdir_path.exists(),
            "Subdirectory should exist before copying"
        );
        assert!(
            file_in_subdir_path.exists(),
            "File in subdirectory should exist before copying"
        );

        // Copy the directory
        let copied_dir_name = "copied_directory";
        let copied_dir_path = temp_dir.path().join(copied_dir_name);
        let result = copy_file_or_dir(
            test_path.to_str().unwrap(),
            copied_dir_path.to_str().unwrap(),
        )
        .await;

        // Verify that the operation was successful
        assert!(result.is_ok(), "Failed to copy directory: {result:?}");

        // Verify that the copied directory exists
        assert!(copied_dir_path.exists(), "Copied directory should exist");

        // Verify that the file in the copied directory exists
        let copied_file_in_dir_path = copied_dir_path.join("file_in_dir.txt");
        assert!(
            copied_file_in_dir_path.exists(),
            "Copied file in directory should exist"
        );

        // Verify that the subdirectory in the copied directory exists
        let copied_subdir_path = copied_dir_path.join("subdir");
        assert!(
            copied_subdir_path.exists(),
            "Copied subdirectory should exist"
        );

        // Verify that the file in the copied subdirectory exists
        let copied_file_in_subdir_path = copied_subdir_path.join("file_in_subdir.txt");
        assert!(
            copied_file_in_subdir_path.exists(),
            "Copied file in subdirectory should exist"
        );

        // Verify the original directory structure still exists
        assert!(test_path.exists(), "Original directory should still exist");
        assert!(
            file_in_dir_path.exists(),
            "Original file in directory should still exist"
        );
        assert!(
            subdir_path.exists(),
            "Original subdirectory should still exist"
        );
        assert!(
            file_in_subdir_path.exists(),
            "Original file in subdirectory should still exist"
        );
    }

    #[tokio::test]
    async fn failed_to_copy_file_or_dir_because_source_path_does_not_exist_test() {
        use tempfile::tempdir;

        // Create a temporary directory (automatically deleted when out of scope)
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test file in the temporary directory
        let mut test_path = temp_dir.path().to_path_buf();
        test_path.push("copy_file_test.txt");

        // Copy the file to a non-existing path
        let new_name = "copy_file_test.txt";
        let new_path = temp_dir.path().join(new_name);

        let result =
            copy_file_or_dir(test_path.to_str().unwrap(), new_path.to_str().unwrap()).await;

        // Verify that the operation was successful
        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("Source path does not exist"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("408"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("InvalidInput"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn zip_single_file_test() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        let test_file_path = temp_dir.path().join("test_file.txt");

        // Create and write to test file
        fs::write(&test_file_path, "Test content").expect("Failed to write test file");
        assert!(
            test_file_path.exists(),
            "Test file should exist before zipping"
        );

        // Zip the file
        let result = zip(vec![test_file_path.to_str().unwrap().to_string()], None).await;
        assert!(result.is_ok(), "Failed to zip file: {result:?}");

        // Check if zip file was created
        let zip_path = test_file_path.with_extension("zip");
        assert!(zip_path.exists(), "Zip file should exist after operation");

        // Verify zip contents
        let zip_file = fs::File::open(&zip_path).expect("Failed to open zip file");
        let mut archive = zip::ZipArchive::new(zip_file).expect("Failed to read zip archive");
        assert_eq!(archive.len(), 1, "Zip should contain exactly one file");

        let file = archive.by_index(0).expect("Failed to read file from zip");
        assert_eq!(file.name(), "test_file.txt", "Incorrect filename in zip");
    }

    #[tokio::test]
    async fn failed_to_zip_because_no_source_paths_provided_test() {
        let result = zip(vec![], None).await;

        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("No source paths provided"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("408"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("InvalidInput"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn failed_to_zip_because_destination_path_required_for_multiple_sources_test() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create test files
        let file1_path = temp_dir.path().join("file1.txt");
        let file2_path = temp_dir.path().join("file2.txt");
        fs::write(&file1_path, "Content 1").expect("Failed to write file1");
        fs::write(&file2_path, "Content 2").expect("Failed to write file2");

        // Zip multiple files without specifying destination
        let result = zip(
            vec![
                file1_path.to_str().unwrap().to_string(),
                file2_path.to_str().unwrap().to_string(),
            ],
            None,
        )
        .await;

        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );
        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("Destination path required for multiple sources"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("408"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("InvalidInput"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn failed_to_zip_because_source_path_does_not_exist_test() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        let result_zip = Some(
            temp_dir
                .path()
                .join("result.zip")
                .to_str()
                .unwrap()
                .to_string(),
        );

        // Create a test file
        let test_file_path = temp_dir.path().join("test_file.txt");
        fs::write(&test_file_path, "Test content").expect("Failed to write test file");

        // Attempt to zip a non-existing file
        let non_existing_file_path = temp_dir.path().join("non_existing_file.txt");
        let result = zip(
            vec![
                test_file_path.to_str().unwrap().to_string(),
                non_existing_file_path.to_str().unwrap().to_string(),
            ],
            result_zip,
        )
        .await;

        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("Source path does not exist"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("405"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("ResourceNotFound"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn unzip_single_file_test() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test zip file
        let zip_path = temp_dir.path().join("test.zip");
        let mut zip = ZipWriter::new(fs::File::create(&zip_path).unwrap());

        zip.start_file::<_, ()>("test.txt", FileOptions::default())
            .unwrap();
        zip.write_all(b"Hello, World!").unwrap();
        zip.finish().unwrap();

        // Test extraction without specifying destination
        let result = unzip(vec![zip_path.to_str().unwrap().to_string()], None).await;

        assert!(result.is_ok(), "Failed to extract zip: {result:?}");

        // Verify extracted contents
        // For single file, the file is extracted to the parent directory of the zip
        let test_file = zip_path.parent().unwrap().join("test.txt");

        assert!(test_file.exists(), "Extracted test.txt should exist");
        assert_eq!(
            fs::read_to_string(&test_file).unwrap(),
            "Hello, World!",
            "Extracted content should match"
        );
    }

    #[tokio::test]
    async fn failed_to_unzip_because_no_zip_files_provided_test() {
        let result = unzip(vec![], None).await;

        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("No zip files provided"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("408"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("InvalidInput"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn failed_to_unzip_because_zip_file_does_not_exist_test() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test zip file
        let zip_path = temp_dir.path().join("non_existing.zip");

        // Test extraction of a non-existing zip file
        let result = unzip(vec![zip_path.to_str().unwrap().to_string()], None).await;

        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("Zip file does not exist"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("405"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("ResourceNotFound"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn failed_to_unzip_because_destination_path_required_for_multiple_zip_files_test() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create test zip files
        let zip1_path = temp_dir.path().join("test1.zip");
        let zip2_path = temp_dir.path().join("test2.zip");

        // Create content for first zip
        let mut zip1 = ZipWriter::new(fs::File::create(&zip1_path).unwrap());
        zip1.start_file::<_, ()>("file1.txt", FileOptions::default())
            .unwrap();
        zip1.write_all(b"Content 1").unwrap();
        zip1.finish().unwrap();

        // Create content for second zip
        let mut zip2 = ZipWriter::new(fs::File::create(&zip2_path).unwrap());
        zip2.start_file::<_, ()>("file2.txt", FileOptions::default())
            .unwrap();
        zip2.write_all(b"Content 2").unwrap();
        zip2.finish().unwrap();

        // Test extraction of multiple zips without specifying destination
        let result = unzip(
            vec![
                zip1_path.to_str().unwrap().to_string(),
                zip2_path.to_str().unwrap().to_string(),
            ],
            None,
        )
        .await;

        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("Destination path required for multiple zip files"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("408"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("InvalidInput"),
            "Error message does not match expected value"
        );
    }

    #[tokio::test]
    async fn failed_to_unzip_because_failed_to_create_extraction_directory_test() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // Create a test zip file
        let zip_path = temp_dir.path().join("test.zip");
        let zip2_path = temp_dir.path().join("test2.zip");
        let mut zip = ZipWriter::new(fs::File::create(&zip_path).unwrap());

        zip.start_file::<_, ()>("test.txt", FileOptions::default())
            .unwrap();
        zip.write_all(b"Hello, World!").unwrap();
        zip.finish().unwrap();

        let mut zip2 = ZipWriter::new(fs::File::create(&zip2_path).unwrap());
        zip2.start_file::<_, ()>("test2.txt", FileOptions::default())
            .unwrap();
        zip2.write_all(b"Hello, World!").unwrap();
        zip2.finish().unwrap();

        // Attempt to unzip to an invalid destination path
        let invalid_dest = temp_dir.path().join("invalid");
        let result = unzip(
            vec![
                zip_path.to_str().unwrap().to_string(),
                zip2_path.to_str().unwrap().to_string(),
            ], // needs to be more than one path
            Some(invalid_dest.to_str().unwrap().to_string()),
        )
        .await;

        assert!(
            result.is_err(),
            "Failed test (should throw an error): {result:?}"
        );

        assert!(
            result
                .clone()
                .unwrap_err()
                .contains("Destination path does not exist"),
            "Error message does not match expected value"
        );

        assert!(
            result.clone().unwrap_err().contains("405"),
            "Error message does not match expected value"
        );

        assert!(
            result.unwrap_err().contains("ResourceNotFound"),
            "Error message does not match expected value"
        );
    }

    // =========================================================================
    // TP-SEC-04 (BUG-004): create_file & create_directory path traversal guard
    // =========================================================================

    #[tokio::test]
    async fn tp_sec_04_create_file_and_directory_reject_path_traversal_and_separators() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        let base_dir = temp_dir.path().join("base_dir");
        fs::create_dir(&base_dir).unwrap();
        let outside_abs = temp_dir.path().join("abs_escaped");

        let invalid_names = [
            "../escaped",
            "..\\escaped",
            "a/b",
            "a\\b",
            ".",
            "..",
            "",
            "   ",
            "/etc/pwn_explr_test",
            outside_abs.to_str().unwrap(),
        ];

        for bad_name in invalid_names {
            let file_res = create_file(base_dir.to_str().unwrap(), bad_name).await;
            assert!(
                file_res.is_err(),
                "create_file should reject invalid name '{bad_name}'"
            );
            let file_err = file_res.unwrap_err();
            assert!(
                file_err.contains("InvalidInput") && file_err.contains("408"),
                "Expected InvalidInput (408) for create_file('{bad_name}'), got: {file_err}"
            );

            let dir_res = create_directory(base_dir.to_str().unwrap(), bad_name).await;
            assert!(
                dir_res.is_err(),
                "create_directory should reject invalid name '{bad_name}'"
            );
            let dir_err = dir_res.unwrap_err();
            assert!(
                dir_err.contains("InvalidInput") && dir_err.contains("408"),
                "Expected InvalidInput (408) for create_directory('{bad_name}'), got: {dir_err}"
            );
        }

        // Verify nothing was created outside base_dir or inside base_dir
        assert!(!temp_dir.path().join("escaped").exists());
        assert!(!outside_abs.exists());
        assert_eq!(fs::read_dir(&base_dir).unwrap().count(), 0);
    }

    // =========================================================================
    // TP-SEC-03 (BUG-003): unzip preserves archive, rejects Zip-Slip / symlinks / zip-bomb
    // =========================================================================

    #[tokio::test]
    async fn tp_sec_03_unzip_preserves_source_archive_and_rejects_dot_traversal_and_symlinks() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        let dest_dir = temp_dir.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();

        // 1) Valid multi-file archive: source .zip MUST NOT be deleted after extraction
        let valid_zip_path = temp_dir.path().join("keep_me.zip");
        {
            let mut zw = ZipWriter::new(fs::File::create(&valid_zip_path).unwrap());
            zw.start_file::<_, ()>("folder/a.txt", FileOptions::default())
                .unwrap();
            zw.write_all(b"alpha").unwrap();
            zw.start_file::<_, ()>("folder/b.txt", FileOptions::default())
                .unwrap();
            zw.write_all(b"beta").unwrap();
            zw.finish().unwrap();
        }
        let res = unzip(
            vec![valid_zip_path.to_str().unwrap().to_string()],
            Some(dest_dir.to_str().unwrap().to_string()),
        )
        .await;
        assert!(res.is_ok(), "Valid unzip should succeed: {res:?}");
        assert!(
            valid_zip_path.exists(),
            "Source .zip archive MUST NOT be deleted after extraction"
        );
        assert_eq!(
            fs::read_to_string(dest_dir.join("keep_me").join("folder").join("a.txt")).unwrap(),
            "alpha"
        );

        // 2a) Archive with `.` / `..` / `/..` without trailing `/` (empty mangled_name escape)
        for bad_entry in [".", "..", "/.."] {
            let dot_zip = temp_dir.path().join("dot_escape.zip");
            {
                let mut zw = ZipWriter::new(fs::File::create(&dot_zip).unwrap());
                zw.start_file::<_, ()>("legit.txt", FileOptions::default())
                    .unwrap();
                zw.write_all(b"ok").unwrap();
                zw.start_file::<_, ()>(bad_entry, FileOptions::default())
                    .unwrap();
                zw.write_all(b"escaped").unwrap();
                zw.finish().unwrap();
            }
            let extract_dest = temp_dir.path().join("dot_dest");
            fs::create_dir_all(&extract_dest).unwrap();
            let err_res = unzip(
                vec![dot_zip.to_str().unwrap().to_string()],
                Some(extract_dest.to_str().unwrap().to_string()),
            )
            .await;
            assert!(
                err_res.is_err(),
                "Archive with entry '{bad_entry}' must be rejected"
            );
            assert!(
                !extract_dest.join("dot_escape (1)").exists(),
                "Must not write escaped file into dest_path outside extract_path"
            );
            assert!(
                dot_zip.exists(),
                "Source zip must not be deleted on failure"
            );
        }

        // 2b) Archive with `../../escape.txt`
        let slip_zip = temp_dir.path().join("slip.zip");
        {
            let mut zw = ZipWriter::new(fs::File::create(&slip_zip).unwrap());
            zw.start_file::<_, ()>("../../escape.txt", FileOptions::default())
                .unwrap();
            zw.write_all(b"pwned").unwrap();
            zw.finish().unwrap();
        }
        let slip_res = unzip(
            vec![slip_zip.to_str().unwrap().to_string()],
            Some(dest_dir.to_str().unwrap().to_string()),
        )
        .await;
        assert!(
            slip_res.is_err(),
            "Zip-Slip entry '../../escape.txt' must fail"
        );
        assert!(!temp_dir.path().join("escape.txt").exists());

        // 2c) Archive with symlink entry (Unix mode 0o120777)
        let symlink_zip = temp_dir.path().join("symlink_entry.zip");
        {
            let mut zw = ZipWriter::new(fs::File::create(&symlink_zip).unwrap());
            zw.add_symlink("evil_link", "/etc/passwd", FileOptions::<()>::default())
                .unwrap();
            zw.finish().unwrap();
        }
        let sym_res = unzip(
            vec![symlink_zip.to_str().unwrap().to_string()],
            Some(dest_dir.to_str().unwrap().to_string()),
        )
        .await;
        assert!(
            sym_res.is_err(),
            "Symlink entry in zip archive must be rejected"
        );

        // 2d) Zip-bomb protection (exceeding total bytes cap)
        let bomb_zip = temp_dir.path().join("bomb.zip");
        {
            let mut zw = ZipWriter::new(fs::File::create(&bomb_zip).unwrap());
            zw.start_file::<_, ()>("big.bin", FileOptions::default())
                .unwrap();
            let chunk = vec![0u8; 64 * 1024];
            for _ in 0..8 {
                zw.write_all(&chunk).unwrap();
            }
            zw.finish().unwrap();
        }
        let bomb_dest = temp_dir.path().join("bomb_dest");
        fs::create_dir(&bomb_dest).unwrap();
        let bomb_res = unzip_with_limits_sync(
            vec![bomb_zip.to_str().unwrap().to_string()],
            Some(bomb_dest.to_str().unwrap().to_string()),
            100,
            128 * 1024, // 128 KiB cap vs 512 KiB archive payload
        );
        assert!(
            bomb_res.is_err(),
            "Zip archive exceeding max_total_bytes cap must be rejected"
        );
        assert!(
            bomb_res
                .unwrap_err()
                .contains("exceeds maximum allowed uncompressed size"),
            "Expected size limit error message"
        );
    }

    // =========================================================================
    // TP-BE-01 (BUG-008): copy_file_or_dir & generate_unique_path for dot folders and symlink loops
    // =========================================================================

    #[tokio::test]
    async fn tp_be_01_copy_dot_directory_preserves_folder_name_and_breaks_symlink_cycles() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // 1) Folder `a.b` copied into directory where `a.b` already exists -> `a.b (1)` (not `a (1).b`)
        let src_dir = temp_dir.path().join("src").join("a.b");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(src_dir.join("hello.txt"), "world").unwrap();

        let target_parent = temp_dir.path().join("target");
        fs::create_dir_all(&target_parent).unwrap();
        let dest_ab = target_parent.join("a.b");

        // First copy creates `target/a.b`
        let res1 = copy_file_or_dir(src_dir.to_str().unwrap(), dest_ab.to_str().unwrap()).await;
        assert!(res1.is_ok(), "First copy of a.b should succeed: {res1:?}");
        assert!(dest_ab.is_dir());

        // Second copy to `target/a.b` must create `target/a.b (1)`, NOT `target/a (1).b`
        let res2 = copy_file_or_dir(src_dir.to_str().unwrap(), dest_ab.to_str().unwrap()).await;
        assert!(res2.is_ok(), "Second copy of a.b should succeed: {res2:?}");
        assert!(
            target_parent.join("a.b (1)").is_dir(),
            "Expected 'a.b (1)' directory to be created"
        );
        assert!(
            !target_parent.join("a (1).b").exists(),
            "Must not corrupt dot-folder name into 'a (1).b'"
        );

        // Exhaustion of unique path attempts returns Err instead of overwriting original_path
        let exhausted = generate_unique_path_with_limit(&dest_ab, true, 1);
        assert!(
            exhausted.is_err(),
            "generate_unique_path_with_limit must return Err when limit is reached"
        );
        assert_eq!(
            exhausted.unwrap_err().message_from_code,
            ErrorCode::ResourceAlreadyExists
        );

        // 2) Symlink cycle inside source directory must not cause infinite recursion
        #[cfg(unix)]
        {
            let cycle_src = temp_dir.path().join("cycle_src");
            fs::create_dir_all(&cycle_src).unwrap();
            fs::write(cycle_src.join("file.txt"), "data").unwrap();
            std::os::unix::fs::symlink(&cycle_src, cycle_src.join("loop_back")).unwrap();

            let cycle_dst = temp_dir.path().join("cycle_dst");
            let cycle_res =
                copy_file_or_dir(cycle_src.to_str().unwrap(), cycle_dst.to_str().unwrap()).await;
            assert!(
                cycle_res.is_ok(),
                "Copying directory with symlink loop must finish without infinite recursion: {cycle_res:?}"
            );
            assert!(cycle_dst.join("file.txt").is_file());
            assert!(!cycle_dst.join("loop_back").exists());
        }
    }

    // =========================================================================
    // TP-BE-02 (BUG-009): zip does not self-truncate .zip and cleans up on missing source
    // =========================================================================

    #[tokio::test]
    async fn tp_be_02_zip_preserves_existing_zip_source_and_leaves_no_partial_archive_on_error() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // 1) Create a valid archive.zip and call zip(vec!["archive.zip"], None)
        let archive_path = temp_dir.path().join("archive.zip");
        {
            let mut zw = ZipWriter::new(fs::File::create(&archive_path).unwrap());
            zw.start_file::<_, ()>("inside.txt", FileOptions::default())
                .unwrap();
            zw.write_all(b"important archive payload").unwrap();
            zw.finish().unwrap();
        }
        let original_bytes = fs::read(&archive_path).unwrap();
        assert!(!original_bytes.is_empty());

        let self_zip_res = zip(vec![archive_path.to_str().unwrap().to_string()], None).await;
        assert!(
            self_zip_res.is_ok(),
            "zip(['archive.zip'], None) should succeed via unique output path: {self_zip_res:?}"
        );
        assert_eq!(
            fs::read(&archive_path).unwrap(),
            original_bytes,
            "Original archive.zip MUST NOT be truncated or modified"
        );
        assert!(
            temp_dir.path().join("archive (1).zip").is_file(),
            "New archive 'archive (1).zip' should be created"
        );

        // 2) zip(vec!["valid.txt", "missing.txt"], Some("out.zip")) must not leave broken out.zip
        let valid_txt = temp_dir.path().join("valid.txt");
        fs::write(&valid_txt, "valid content").unwrap();
        let missing_txt = temp_dir.path().join("missing.txt");
        let out_zip = temp_dir.path().join("out.zip");

        let fail_res = zip(
            vec![
                valid_txt.to_str().unwrap().to_string(),
                missing_txt.to_str().unwrap().to_string(),
            ],
            Some(out_zip.to_str().unwrap().to_string()),
        )
        .await;
        assert!(fail_res.is_err(), "Zip with missing source must fail");
        assert!(
            !out_zip.exists(),
            "Failed zip operation must not leave a partial or empty out.zip on disk"
        );
    }

    // =========================================================================
    // TP-BE-03 (BUG-010): open_directory returns valid & broken symlinks with is_symlink: true
    // =========================================================================

    #[tokio::test]
    async fn tp_be_03_open_directory_includes_valid_and_broken_symlinks_and_counts_single_pass() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");
        let root = temp_dir.path();

        let real_file = root.join("real.txt");
        fs::write(&real_file, "hello").unwrap();

        let real_sub = root.join("real_sub");
        fs::create_dir(&real_sub).unwrap();
        fs::write(real_sub.join("nested.txt"), "1").unwrap();
        fs::create_dir(real_sub.join("nested_dir")).unwrap();

        // Verify count_subentries_single_pass matches legacy helpers
        let (f_cnt, d_cnt) = count_subentries_single_pass(&real_sub);
        assert_eq!(f_cnt, count_subfiles(real_sub.to_str().unwrap()));
        assert_eq!(d_cnt, count_subdirectories(real_sub.to_str().unwrap()));

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real_file, root.join("link_file.txt")).unwrap();
            std::os::unix::fs::symlink(&real_sub, root.join("link_dir")).unwrap();
            std::os::unix::fs::symlink(root.join("nonexistent_target"), root.join("broken_link"))
                .unwrap();

            let json = open_directory(root.to_str().unwrap().to_string())
                .await
                .expect("open_directory should succeed");
            let entries: Entries = serde_json::from_str(&json).unwrap();

            let link_dir = entries
                .directories
                .iter()
                .find(|d| d.name == "link_dir")
                .expect("Valid directory symlink must appear in directories");
            assert!(link_dir.is_symlink, "link_dir must have is_symlink == true");
            assert_eq!(link_dir.sub_file_count, 1);
            assert_eq!(link_dir.sub_dir_count, 1);

            let link_file = entries
                .files
                .iter()
                .find(|f| f.name == "link_file.txt")
                .expect("Valid file symlink must appear in files");
            assert!(
                link_file.is_symlink,
                "link_file.txt must have is_symlink == true"
            );

            let broken = entries
                .files
                .iter()
                .find(|f| f.name == "broken_link")
                .expect("Broken symlink must appear in files instead of vanishing");
            assert!(
                broken.is_symlink,
                "broken_link must have is_symlink == true"
            );
        }
    }

    // =========================================================================
    // TP-BE-09 (BUG-044): rename case-collision protection on Linux & Unicode case rename
    // =========================================================================

    #[tokio::test]
    async fn tp_be_09_rename_prevents_case_collision_overwrite_and_supports_unicode_case_rename() {
        let temp_dir = tempdir().expect("Failed to create temporary directory");

        // 1) Pure helper supports Cyrillic case-only rename and mixed path separators
        assert!(names_differ_only_by_case(
            Path::new("C:/Users/Тест.txt"),
            Path::new("C:\\Users\\тест.txt")
        ));
        assert!(!names_differ_only_by_case(
            Path::new("/tmp/Тест.txt"),
            Path::new("/tmp/Тест.txt")
        ));

        // 2) Renaming Cyrillic casing when only one file exists succeeds
        let cyr_upper = temp_dir.path().join("Тест.txt");
        let cyr_lower = temp_dir.path().join("тест.txt");
        fs::write(&cyr_upper, "cyrillic content").unwrap();

        let cyr_res = rename(cyr_upper.to_str().unwrap(), cyr_lower.to_str().unwrap()).await;
        assert!(
            cyr_res.is_ok(),
            "Cyrillic case rename 'Тест.txt' -> 'тест.txt' should succeed: {cyr_res:?}"
        );
        assert_eq!(fs::read_to_string(&cyr_lower).unwrap(), "cyrillic content");

        // 3) On case-sensitive filesystems (Linux), when both `file.txt` and `FILE.txt` exist,
        //    renaming `file.txt` -> `FILE.txt` must fail with ResourceAlreadyExists (409).
        #[cfg(target_os = "linux")]
        {
            let lower = temp_dir.path().join("file.txt");
            let upper = temp_dir.path().join("FILE.txt");
            fs::write(&lower, "lower").unwrap();
            fs::write(&upper, "upper").unwrap();

            let collision_res = rename(lower.to_str().unwrap(), upper.to_str().unwrap()).await;
            assert!(
                collision_res.is_err(),
                "Renaming file.txt -> FILE.txt when FILE.txt exists as a distinct file on Linux must fail"
            );
            let err = collision_res.unwrap_err();
            assert!(
                err.contains("ResourceAlreadyExists") && err.contains("409"),
                "Expected ResourceAlreadyExists (409), got: {err}"
            );
            assert_eq!(
                fs::read_to_string(&upper).unwrap(),
                "upper",
                "Existing FILE.txt must not be overwritten"
            );
        }
    }
}
