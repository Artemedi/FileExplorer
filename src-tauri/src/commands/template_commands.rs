use crate::error_handling::{Error, ErrorCode};
use crate::state::meta_data::MetaDataState;
use crate::{log_error, log_info};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

/// Maximum number of `name (n)` candidates tried before giving up.
const MAX_UNIQUE_ATTEMPTS: u32 = 9999;

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/// Logs the error and converts it to the JSON string expected by the IPC layer.
fn to_ipc(err: Error) -> String {
    log_error!(err.custom_message.as_str());
    err.to_json()
}

/// Builds an [`Error`] from an `io::Error`, keeping its code mapping and adding context.
fn io_err(context: &str, err: io::Error) -> Error {
    let mut error = Error::from(err);
    error.custom_message = format!("{context}: {}", error.custom_message);
    error
}

/// Runs a blocking filesystem job on the blocking thread pool.
async fn run_blocking<T, F>(job: F) -> Result<T, Error>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, Error> + Send + 'static,
{
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|e| Error::internal(format!("Background task failed: {e}")))?
}

// ---------------------------------------------------------------------------
// State helpers (no unwrap on locks: a poisoned mutex becomes an error)
// ---------------------------------------------------------------------------

fn templates_root(state: &Arc<Mutex<MetaDataState>>) -> Result<PathBuf, Error> {
    let outer = state
        .lock()
        .map_err(|_| Error::internal("Metadata state lock is poisoned"))?;
    let inner = outer
        .0
        .lock()
        .map_err(|_| Error::internal("Metadata lock is poisoned"))?;
    Ok(inner.abs_folder_path_buf_for_templates.clone())
}

fn refresh_template_paths(state: &Arc<Mutex<MetaDataState>>) -> Result<(), Error> {
    let outer = state
        .lock()
        .map_err(|_| Error::internal("Metadata state lock is poisoned"))?;
    let result = outer.update_template_paths();
    result.map_err(|e| io_err("Failed to update template paths", e))
}

fn get_template_paths_from_state(state: &Arc<Mutex<MetaDataState>>) -> Result<Vec<PathBuf>, Error> {
    let outer = state
        .lock()
        .map_err(|_| Error::internal("Metadata state lock is poisoned"))?;
    let inner = outer
        .0
        .lock()
        .map_err(|_| Error::internal("Metadata lock is poisoned"))?;
    Ok(inner.template_paths.clone())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Retrieves all available templates as a JSON string of paths.
///
/// # Returns
/// * `Ok(String)` - A JSON array of template paths as strings
/// * `Err(String)` - A JSON-serialized [`Error`] if the templates can't be retrieved
#[tauri::command]
pub async fn get_template_paths_as_json(
    state: State<'_, Arc<Mutex<MetaDataState>>>,
) -> Result<String, String> {
    log_info!("get_template_paths_as_json command called");
    get_template_paths_as_json_impl(state.inner().clone()).await
}

pub async fn get_template_paths_as_json_impl(
    state: Arc<Mutex<MetaDataState>>,
) -> Result<String, String> {
    log_info!("Retrieving template paths from state");
    let paths = get_template_paths_from_state(&state).map_err(to_ipc)?;

    let path_strings: Vec<String> = paths
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    log_info!("Found {} template paths", path_strings.len());

    serde_json::to_string(&path_strings)
        .inspect(|_| {
            log_info!("Successfully serialized template paths to JSON");
        })
        .map_err(|e| {
            to_ipc(Error::internal(format!(
                "Failed to serialize paths to JSON: {e}"
            )))
        })
}

/// Adds a template to the template directory.
///
/// Copies a file or directory to the application's template directory and registers it as a
/// template. An already existing template is never overwritten; a unique name such as
/// `name (1)` is used instead.
///
/// # Returns
/// * `Ok(String)` - A success message including the name of the template and its size
/// * `Err(String)` - A JSON-serialized [`Error`] if the template cannot be added
#[tauri::command]
pub async fn add_template(
    state: State<'_, Arc<Mutex<MetaDataState>>>,
    template_path: &str,
) -> Result<String, String> {
    log_info!("add_template command called with path: {}", template_path);
    add_template_impl(state.inner().clone(), template_path).await
}

pub async fn add_template_impl(
    state: Arc<Mutex<MetaDataState>>,
    template_path: &str,
) -> Result<String, String> {
    log_info!("Adding template from path: {}", template_path);

    let root = templates_root(&state).map_err(to_ipc)?;
    log_info!("Template destination path: {}", root.display());

    let source = PathBuf::from(template_path);
    let size = run_blocking({
        let state = state.clone();
        let source = source.clone();
        move || {
            if !source.exists() {
                return Err(Error::resource_not_found(format!(
                    "Source path does not exist: {}",
                    source.display()
                )));
            }
            let size = copy_to_dest_sync(&source, &root)?;
            refresh_template_paths(&state)?;
            Ok(size)
        }
    })
    .await
    .map_err(to_ipc)?;

    let success_msg = format!(
        "Template '{}' added successfully ({} bytes)",
        source.file_name().unwrap_or_default().to_string_lossy(),
        size
    );
    log_info!(success_msg.as_str());
    Ok(success_msg)
}

/// Applies a template to the specified destination directory.
///
/// Copies the content of a template (file or directory) into `dest_path`. The template stays
/// unchanged and existing files at the destination are never overwritten (a unique name such
/// as `name (1).ext` is used instead).
///
/// # Returns
/// * `Ok(String)` - A success message with details about the template application
/// * `Err(String)` - A JSON-serialized [`Error`] if the template cannot be applied
#[tauri::command]
pub async fn use_template(template_path: &str, dest_path: &str) -> Result<String, String> {
    log_info!("use_template command called with key: {}", template_path);
    use_template_impl(template_path, dest_path).await
}

pub async fn use_template_impl(template_path: &str, dest_path: &str) -> Result<String, String> {
    log_info!("Using template from path: {}", template_path);

    let template = PathBuf::from(template_path);
    let dest = PathBuf::from(dest_path);

    let size = run_blocking(move || {
        if !template.exists() {
            return Err(Error::resource_not_found(format!(
                "Template path does not exist: {}",
                template.display()
            )));
        }
        if !dest.exists() {
            return Err(Error::resource_not_found(format!(
                "Destination path does not exist: {}",
                dest.display()
            )));
        }
        if !dest.is_dir() {
            return Err(Error::invalid_input(format!(
                "Destination path is not a directory: {}",
                dest.display()
            )));
        }
        copy_to_dest_sync(&template, &dest)
    })
    .await
    .map_err(to_ipc)?;

    let success_msg = format!(
        "Template '{template_path}' applied successfully to '{dest_path}' ({size} bytes copied)"
    );
    log_info!(success_msg.as_str());
    Ok(success_msg)
}

/// Removes a template from the template directory.
///
/// Only paths strictly inside the templates directory can be removed. Symbolic links are
/// removed as links and never followed.
///
/// # Returns
/// * `Ok(String)` - A success message confirming the removal of the template
/// * `Err(String)` - A JSON-serialized [`Error`] if the template cannot be removed
#[tauri::command]
pub async fn remove_template(
    state: State<'_, Arc<Mutex<MetaDataState>>>,
    template_path: &str,
) -> Result<String, String> {
    remove_template_impl(state.inner().clone(), template_path).await
}

pub async fn remove_template_impl(
    state: Arc<Mutex<MetaDataState>>,
    template_path: &str,
) -> Result<String, String> {
    log_info!("Removing template at path: {}", template_path);

    let root = templates_root(&state).map_err(to_ipc)?;
    let target = PathBuf::from(template_path);

    run_blocking({
        let state = state.clone();
        move || {
            remove_template_sync(&root, &target)?;
            refresh_template_paths(&state)
        }
    })
    .await
    .map_err(to_ipc)?;

    let success_msg = format!("Template '{template_path}' removed successfully");
    log_info!(success_msg.as_str());
    Ok(success_msg)
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/// Removes `target` only if it is strictly inside `root` (after canonicalization).
///
/// A symlink target is canonicalized through its parent directory only, so the link itself is
/// removed and whatever it points to is left untouched.
fn remove_template_sync(root: &Path, target: &Path) -> Result<(), Error> {
    if target.as_os_str().is_empty() {
        return Err(Error::invalid_input("Template path is empty"));
    }

    let metadata = match fs::symlink_metadata(target) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Err(Error::resource_not_found(format!(
                "Template path does not exist: {}",
                target.display()
            )));
        }
        Err(err) => return Err(io_err("Failed to read template metadata", err)),
    };

    let canon_root =
        fs::canonicalize(root).map_err(|e| io_err("Templates directory is not accessible", e))?;

    if metadata.file_type().is_symlink() {
        return Err(Error::new(
            ErrorCode::Unauthorized,
            format!(
                "Refusing to remove a symbolic link in the templates directory: {}",
                target.display()
            ),
        ));
    }

    let canon_target =
        fs::canonicalize(target).map_err(|e| io_err("Failed to resolve template path", e))?;

    if canon_target == canon_root || !canon_target.starts_with(&canon_root) {
        return Err(Error::new(
            ErrorCode::Unauthorized,
            format!(
                "Refusing to remove a path outside of the templates directory: {}",
                target.display()
            ),
        ));
    }

    let result = if metadata.is_dir() {
        fs::remove_dir_all(target)
    } else {
        fs::remove_file(target)
    };
    result.map_err(|e| io_err("Failed to remove template", e))
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/// Copies `source_path` (file or directory) into the directory `dest_path`.
///
/// Never overwrites existing entries: a unique name (`name (1).ext`, folders `name (1)`) is
/// chosen instead. Symbolic links inside copied directories are skipped.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn copy_to_dest_path(source_path: &str, dest_path: &str) -> Result<u64, String> {
    log_info!("Copying from '{}' to '{}'", source_path, dest_path);
    let source = PathBuf::from(source_path);
    let dest = PathBuf::from(dest_path);
    run_blocking(move || copy_to_dest_sync(&source, &dest))
        .await
        .map_err(to_ipc)
}

fn copy_to_dest_sync(source: &Path, dest_dir: &Path) -> Result<u64, Error> {
    if !source.exists() {
        return Err(Error::resource_not_found(format!(
            "Source path does not exist: {}",
            source.display()
        )));
    }

    if dest_dir.exists() {
        if !dest_dir.is_dir() {
            return Err(Error::invalid_input(format!(
                "Destination path is not a directory: {}",
                dest_dir.display()
            )));
        }
    } else {
        fs::create_dir_all(dest_dir)
            .map_err(|e| io_err("Failed to create destination directory", e))?;
        log_info!("Created destination directory: {}", dest_dir.display());
    }

    let name = source
        .file_name()
        .ok_or_else(|| Error::invalid_input("Invalid source name"))?;

    if source.is_dir() {
        let canon_source = fs::canonicalize(source)
            .map_err(|e| io_err("Failed to resolve source directory", e))?;
        let canon_dest = fs::canonicalize(dest_dir)
            .map_err(|e| io_err("Failed to resolve destination directory", e))?;
        if canon_dest.starts_with(&canon_source) {
            return Err(Error::invalid_input(
                "Cannot copy a directory into itself or one of its subdirectories",
            ));
        }

        let final_dest = unique_dest_path(dest_dir, name, true)?;
        fs::create_dir(&final_dest)
            .map_err(|e| io_err("Failed to create destination directory", e))?;
        let mut visited = HashSet::new();
        let total = copy_dir_contents(source, &final_dest, &mut visited)?;
        log_info!(
            "Successfully copied directory with total size: {} bytes",
            total
        );
        Ok(total)
    } else {
        copy_file_unique(source, dest_dir, name)
    }
}

/// Returns a not-yet-existing path inside `dir` based on `name`.
///
/// Files become `stem (n).ext`, folders `name (n)` (so `a.b` becomes `a.b (1)`).
fn unique_dest_path(dir: &Path, name: &OsStr, is_dir: bool) -> Result<PathBuf, Error> {
    let first = dir.join(name);
    if fs::symlink_metadata(&first).is_err() {
        return Ok(first);
    }

    let as_path = Path::new(name);
    let (stem, extension) = if is_dir {
        (name.to_os_string(), None)
    } else {
        match (as_path.file_stem(), as_path.extension()) {
            (Some(stem), Some(ext)) => (stem.to_os_string(), Some(ext.to_os_string())),
            _ => (name.to_os_string(), None),
        }
    };

    for n in 1..=MAX_UNIQUE_ATTEMPTS {
        let mut candidate = stem.clone();
        candidate.push(format!(" ({n})"));
        if let Some(ext) = &extension {
            candidate.push(".");
            candidate.push(ext);
        }
        let candidate = dir.join(candidate);
        if fs::symlink_metadata(&candidate).is_err() {
            return Ok(candidate);
        }
    }

    Err(Error::already_exists(format!(
        "Could not find a free name for '{}' in '{}'",
        name.to_string_lossy(),
        dir.display()
    )))
}

/// Copies one file into `dest_dir` without ever overwriting an existing entry.
fn copy_file_unique(source: &Path, dest_dir: &Path, name: &OsStr) -> Result<u64, Error> {
    let mut input = fs::File::open(source)
        .map_err(|e| io_err(&format!("Failed to open '{}'", source.display()), e))?;

    for _ in 0..5 {
        let target = unique_dest_path(dest_dir, name, false)?;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut output) => {
                let size = io::copy(&mut input, &mut output).map_err(|e| {
                    io_err(&format!("Failed to copy file '{}'", source.display()), e)
                })?;
                drop(output);
                if let Ok(meta) = input.metadata() {
                    // Best effort: keep the source permissions like fs::copy does.
                    let _ = fs::set_permissions(&target, meta.permissions());
                }
                log_info!(
                    "Copied file: {} to {} ({} bytes)",
                    source.display(),
                    target.display(),
                    size
                );
                return Ok(size);
            }
            // Lost a race for the name: pick the next free one.
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(io_err(
                    &format!("Failed to create '{}'", target.display()),
                    err,
                ))
            }
        }
    }

    Err(Error::already_exists(format!(
        "Could not create a unique file for '{}'",
        name.to_string_lossy()
    )))
}

/// Recursively copies the content of `source` into the (already created) `dest`.
///
/// Symlinks are skipped and every canonical source directory is visited at most once, which
/// protects against symlink / junction loops.
fn copy_dir_contents(
    source: &Path,
    dest: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Result<u64, Error> {
    let canonical = fs::canonicalize(source)
        .map_err(|e| io_err(&format!("Failed to resolve '{}'", source.display()), e))?;
    if !visited.insert(canonical) {
        log_info!("Skipping already visited directory: {}", source.display());
        return Ok(0);
    }

    let entries = fs::read_dir(source).map_err(|e| io_err("Failed to read source directory", e))?;

    let mut total = 0;
    for entry_result in entries {
        let entry = entry_result.map_err(|e| io_err("Failed to read directory entry", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| io_err("Failed to read entry type", e))?;
        let entry_path = entry.path();
        let name = entry.file_name();

        if file_type.is_symlink() {
            log_info!("Skipping symlink: {}", entry_path.display());
        } else if file_type.is_dir() {
            let sub_dest = unique_dest_path(dest, &name, true)?;
            fs::create_dir(&sub_dest)
                .map_err(|e| io_err(&format!("Failed to create '{}'", sub_dest.display()), e))?;
            total += copy_dir_contents(&entry_path, &sub_dest, visited)?;
        } else if file_type.is_file() {
            total += copy_file_unique(&entry_path, dest, &name)?;
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests_template_commands {
    use super::*;
    use crate::state::meta_data::MetaDataState;
    use std::fs;
    use std::io::Write;
    use std::path::Path;
    use std::sync::Arc;
    use tempfile::tempdir;

    // Helper function to create a test MetaDataState
    fn create_test_metadata_state(
        meta_data_path: PathBuf,
        temp_dir_path: PathBuf,
    ) -> Arc<Mutex<MetaDataState>> {
        // Create a custom metadata state with our test directories
        let meta_data = MetaDataState::new_with_path(meta_data_path.to_path_buf());

        {
            let mut meta_data_inner = meta_data.0.lock().unwrap().clone();
            meta_data_inner.abs_folder_path_buf_for_templates = temp_dir_path;
            // Initialize with empty template paths
            meta_data_inner.template_paths = vec![];

            // Save the updated metadata
            meta_data
                .write_meta_data_to_file(&meta_data_inner)
                .expect("Failed to update metadata");

            // Update the state
            *meta_data.0.lock().unwrap() = meta_data_inner;
        }

        // Ensure we properly initialize template paths in the state
        meta_data
            .update_template_paths()
            .expect("Failed to update template paths");

        Arc::new(Mutex::new(meta_data))
    }

    // Helper to create a test file with content
    fn create_test_file(path: &Path, content: &[u8]) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::File::create(path)?;
        file.write_all(content)
    }

    #[tokio::test]
    async fn test_get_template_paths_with_templates() {
        // Create temp directories for template storage and metadata
        let templates_dir = tempdir().expect("Failed to create temporary templates directory");
        let metadata_dir = tempdir().expect("Failed to create temporary metadata directory");

        let metadata_file = metadata_dir.path().join("meta_data.json");
        let state = create_test_metadata_state(metadata_file, templates_dir.path().to_path_buf());

        // Create test templates directly in the template directory
        let template1 = templates_dir.path().join("template1");
        let template2 = templates_dir.path().join("template2");

        fs::create_dir(&template1).expect("Failed to create test template1");
        fs::create_dir(&template2).expect("Failed to create test template2");

        // Add content to templates to ensure they're meaningful
        create_test_file(&template1.join("test.txt"), b"Test content 1")
            .expect("Failed to create test file in template1");
        create_test_file(&template2.join("test.txt"), b"Test content 2")
            .expect("Failed to create test file in template2");

        // Update template paths in state - this should find our newly created templates
        {
            let meta_state = state.lock().unwrap();
            log_info!("Templates dir: {:?}", templates_dir.path());

            let inner_meta_data = &mut meta_state.0.lock().unwrap();
            inner_meta_data.template_paths = vec![template1.clone(), template2.clone()];

            assert!(
                inner_meta_data.template_paths.len() >= 2,
                "Should have found at least 2 templates: {:?}",
                inner_meta_data.template_paths
            );
            assert!(
                inner_meta_data
                    .template_paths
                    .iter()
                    .any(|p| p.ends_with("template1")),
                "template1 should be in template_paths: {:?}",
                inner_meta_data.template_paths
            );
            assert!(
                inner_meta_data
                    .template_paths
                    .iter()
                    .any(|p| p.ends_with("template2")),
                "template2 should be in template_paths: {:?}",
                inner_meta_data.template_paths
            );
        }

        let result = get_template_paths_as_json_impl(state).await;
        assert!(result.is_ok(), "Should return Ok with template paths");
        let json = result.unwrap();

        assert!(
            json.contains("template1"),
            "JSON should contain template1: {}",
            json
        );
        assert!(
            json.contains("template2"),
            "JSON should contain template2: {}",
            json
        );
    }

    #[tokio::test]
    async fn test_add_template() {
        // Create temp directories for template storage and metadata
        let templates_dir = tempdir().expect("Failed to create temporary templates directory");
        let metadata_dir = tempdir().expect("Failed to create temporary metadata directory");

        let metadata_file = metadata_dir.path().join("meta_data.json");
        let state = create_test_metadata_state(metadata_file, templates_dir.path().to_path_buf());

        // Create a source template directory
        let source_dir = tempdir().expect("Failed to create source template directory");
        let source_path = source_dir.path();
        let source_name = source_path.file_name().unwrap().to_str().unwrap();

        // Create some content in the source
        let test_file = source_path.join("test.txt");
        create_test_file(&test_file, b"Test content").expect("Failed to create test file");

        // Add the template
        let result = add_template_impl(state.clone(), source_path.to_str().unwrap()).await;
        assert!(
            result.is_ok(),
            "Adding template should succeed: {:?}",
            result.err()
        );

        // Verify the template was copied - should be in templates_dir/source_name
        let expected_template_path = templates_dir.path().join(source_name);
        log_info!("Expected template path: {:?}", expected_template_path);
        assert!(
            expected_template_path.exists(),
            "Template should exist at destination: {:?}",
            expected_template_path
        );

        // Verify the template file was copied correctly
        let copied_file = expected_template_path.join("test.txt");
        assert!(copied_file.exists(), "Template file should be copied");

        let content = fs::read_to_string(copied_file).expect("Failed to read copied file");
        assert_eq!(content, "Test content", "File content should match");
    }

    #[tokio::test]
    async fn test_add_template_nonexistent_source() {
        // Create temp directories for template storage and metadata
        let templates_dir = tempdir().expect("Failed to create temporary templates directory");
        let metadata_dir = tempdir().expect("Failed to create temporary metadata directory");

        let metadata_file = metadata_dir.path().join("meta_data.json");
        let state = create_test_metadata_state(metadata_file, templates_dir.path().to_path_buf());

        // Try to add a template that doesn't exist
        let result = add_template_impl(state, "/path/that/does/not/exist").await;

        assert!(result.is_err(), "Should fail when source doesn't exist");
        assert!(result.unwrap_err().contains("Source path does not exist"));
    }

    #[tokio::test]
    async fn test_use_template() {
        // Create a template directory
        let template_dir = tempdir().expect("Failed to create template directory");
        let template_file = template_dir.path().join("template_file.txt");
        create_test_file(&template_file, b"Template content")
            .expect("Failed to create template file");

        // Create a destination directory
        let dest_dir = tempdir().expect("Failed to create destination directory");

        // Template directory name
        let template_name = template_dir.path().file_name().unwrap().to_str().unwrap();

        // Use the template
        let result = use_template_impl(
            template_dir.path().to_str().unwrap(),
            dest_dir.path().to_str().unwrap(),
        )
        .await;

        assert!(
            result.is_ok(),
            "Using template should succeed: {:?}",
            result.err()
        );

        // Verify the template was copied to the destination - should be in dest_dir/template_name
        let dest_template_dir = dest_dir.path().join(template_name);
        log_info!("Looking for template in: {:?}", dest_template_dir);
        assert!(
            dest_template_dir.exists(),
            "Template directory should exist at destination"
        );

        // Verify the template file was copied correctly
        let copied_file = dest_template_dir.join("template_file.txt");
        assert!(
            copied_file.exists(),
            "Template file should be copied to destination"
        );

        let content = fs::read_to_string(copied_file).expect("Failed to read copied file");
        assert_eq!(content, "Template content", "File content should match");
    }

    #[tokio::test]
    async fn test_use_template_nonexistent() {
        // Create a destination directory
        let dest_dir = tempdir().expect("Failed to create destination directory");

        // Try to use a template that doesn't exist
        let result = use_template_impl(
            "/path/to/nonexistent/template",
            dest_dir.path().to_str().unwrap(),
        )
        .await;

        assert!(result.is_err(), "Should fail when template doesn't exist");
        assert!(result.unwrap_err().contains("Template path does not exist"));
    }

    #[tokio::test]
    async fn test_use_template_invalid_destination() {
        // Create a template directory
        let template_dir = tempdir().expect("Failed to create template directory");

        // Try to use a template with an invalid destination
        let result = use_template_impl(
            template_dir.path().to_str().unwrap(),
            "/path/to/nonexistent/destination",
        )
        .await;

        assert!(
            result.is_err(),
            "Should fail when destination doesn't exist"
        );
        assert!(result
            .unwrap_err()
            .contains("Destination path does not exist"));
    }

    #[tokio::test]
    async fn test_remove_template() {
        // Create temp directories for template storage and metadata
        let templates_dir = tempdir().expect("Failed to create temporary templates directory");
        let metadata_dir = tempdir().expect("Failed to create temporary metadata directory");

        let metadata_file = metadata_dir.path().join("meta_data.json");
        let state = create_test_metadata_state(metadata_file, templates_dir.path().to_path_buf());

        // Create a test template
        let template_path = templates_dir.path().join("template_to_remove");
        fs::create_dir(&template_path).expect("Failed to create test template");
        create_test_file(&template_path.join("test.txt"), b"Test content")
            .expect("Failed to create test file in template");

        // Update template paths in state
        {
            let meta_state = state.lock().unwrap();
            meta_state
                .update_template_paths()
                .expect("Failed to update template paths");
        }

        // Verify the template exists
        assert!(
            template_path.exists(),
            "Template should exist before removal"
        );

        // Remove the template
        let result = remove_template_impl(state.clone(), template_path.to_str().unwrap()).await;

        assert!(
            result.is_ok(),
            "Removing template should succeed: {:?}",
            result.err()
        );

        // Verify the template was removed
        assert!(
            !template_path.exists(),
            "Template should be removed after removal"
        );
    }

    #[tokio::test]
    async fn test_remove_nonexistent_template() {
        // Create temp directories for template storage and metadata
        let templates_dir = tempdir().expect("Failed to create temporary templates directory");
        let metadata_dir = tempdir().expect("Failed to create temporary metadata directory");

        let metadata_file = metadata_dir.path().join("meta_data.json");
        let state = create_test_metadata_state(metadata_file, templates_dir.path().to_path_buf());

        // Try to remove a template that doesn't exist
        let nonexistent_path = templates_dir.path().join("nonexistent_template");

        // Ensure it doesn't exist
        assert!(
            !nonexistent_path.exists(),
            "Template should not exist before test"
        );

        // Try to remove it
        let result = remove_template_impl(state, nonexistent_path.to_str().unwrap()).await;

        assert!(result.is_err(), "Should fail when template doesn't exist");
        assert!(result.unwrap_err().contains("Template path does not exist"));
    }

    #[tokio::test]
    async fn test_copy_to_dest_path_file() {
        // Create source and destination directories
        let source_dir = tempdir().expect("Failed to create source directory");
        let dest_dir = tempdir().expect("Failed to create destination directory");

        // Create a test file
        let source_file = source_dir.path().join("test.txt");
        create_test_file(&source_file, b"Test file content").expect("Failed to create test file");

        // Copy the file to the destination directory (not to a specific file path)
        let result = copy_to_dest_path(
            source_file.to_str().unwrap(),
            dest_dir.path().to_str().unwrap(),
        )
        .await;

        assert!(
            result.is_ok(),
            "Copying file should succeed: {:?}",
            result.err()
        );

        // The file should be copied as dest_dir/test.txt
        let file_name = source_file.file_name().unwrap();
        let dest_file = dest_dir.path().join(file_name);

        // Verify the file was copied
        assert!(dest_file.exists(), "Destination file should exist");

        let content = fs::read_to_string(dest_file).expect("Failed to read destination file");
        assert_eq!(content, "Test file content", "File content should match");
    }

    #[tokio::test]
    async fn test_copy_to_dest_path_directory() {
        // Create source and destination directories
        let source_dir = tempdir().expect("Failed to create source directory");
        let dest_dir = tempdir().expect("Failed to create destination directory");

        // Create content in the source directory
        let subdir = source_dir.path().join("subdir");
        fs::create_dir(&subdir).expect("Failed to create subdirectory");

        let file1 = source_dir.path().join("file1.txt");
        let file2 = subdir.join("file2.txt");

        create_test_file(&file1, b"File 1 content").expect("Failed to create file1");
        create_test_file(&file2, b"File 2 content").expect("Failed to create file2");

        // Get source directory name for verification
        let source_name = source_dir.path().file_name().unwrap().to_str().unwrap();
        log_info!("Source directory name: {}", source_name);

        // Copy the directory
        let result = copy_to_dest_path(
            source_dir.path().to_str().unwrap(),
            dest_dir.path().to_str().unwrap(),
        )
        .await;

        assert!(
            result.is_ok(),
            "Copying directory should succeed: {:?}",
            result.err()
        );

        // The copied directory should be in dest_dir/source_name
        let copied_dir_path = dest_dir.path().join(source_name);
        log_info!("Expected copied directory path: {:?}", copied_dir_path);

        // Verify the directory structure was copied
        assert!(
            copied_dir_path.exists(),
            "Destination directory should exist"
        );

        println!("Contents of copied directory:");
        for entry in fs::read_dir(&copied_dir_path).expect("Failed to read directory") {
            log_info!("  {:?}", entry.unwrap().path());
        }

        let copied_file1 = copied_dir_path.join("file1.txt");
        let copied_subdir = copied_dir_path.join("subdir");
        let copied_file2 = copied_subdir.join("file2.txt");

        assert!(
            copied_file1.exists(),
            "file1.txt should be copied: {:?}",
            copied_file1
        );
        assert!(copied_subdir.exists(), "subdir should be copied");
        assert!(copied_file2.exists(), "file2.txt should be copied");

        let content1 = fs::read_to_string(copied_file1).expect("Failed to read file1.txt");
        let content2 = fs::read_to_string(copied_file2).expect("Failed to read file2.txt");

        assert_eq!(content1, "File 1 content", "File1 content should match");
        assert_eq!(content2, "File 2 content", "File2 content should match");
    }

    #[tokio::test]
    async fn test_add_template_single_file() {
        // Create temp directories for template storage and metadata
        let templates_dir = tempdir().expect("Failed to create temporary templates directory");
        let metadata_dir = tempdir().expect("Failed to create temporary metadata directory");

        let metadata_file = metadata_dir.path().join("meta_data.json");
        let state = create_test_metadata_state(metadata_file, templates_dir.path().to_path_buf());

        // Create a single test file to be used as template
        let source_dir = tempdir().expect("Failed to create source directory");
        let source_file = source_dir.path().join("template_file.txt");
        create_test_file(&source_file, b"Single file template content")
            .expect("Failed to create test file");

        // Add the file as a template
        let result = add_template_impl(state.clone(), source_file.to_str().unwrap()).await;

        assert!(
            result.is_ok(),
            "Adding file template should succeed: {:?}",
            result.err()
        );

        // Get the file name for verification
        let file_name = source_file.file_name().unwrap().to_str().unwrap();

        // For a single file, it should be copied directly to the templates directory
        let expected_template_path = templates_dir.path().join(file_name);
        log_info!("Expected template file path: {:?}", expected_template_path);

        assert!(
            expected_template_path.exists(),
            "Template file should exist at destination: {:?}",
            expected_template_path
        );

        // Verify the file content was preserved
        let content =
            fs::read_to_string(expected_template_path).expect("Failed to read template file");
        assert_eq!(
            content, "Single file template content",
            "File content should match"
        );
    }

    // ---------------------------------------------------------------------
    // TP-SEC-02: remove_template must never delete outside the templates dir
    // ---------------------------------------------------------------------

    /// Layout: base/{templates, outside/keep.txt}; the state points at `base/templates`.
    fn sec_layout() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        PathBuf,
        PathBuf,
        Arc<Mutex<MetaDataState>>,
    ) {
        let base = tempdir().expect("base dir");
        let metadata_dir = tempdir().expect("metadata dir");
        let templates = base.path().join("templates");
        let outside = base.path().join("outside");
        fs::create_dir_all(&templates).unwrap();
        create_test_file(&outside.join("keep.txt"), b"keep").unwrap();
        let state = create_test_metadata_state(
            metadata_dir.path().join("meta_data.json"),
            templates.clone(),
        );
        (base, metadata_dir, templates, outside, state)
    }

    fn assert_outside_untouched(outside: &Path) {
        assert!(outside.is_dir(), "outside dir must still exist");
        assert_eq!(
            fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "keep",
            "keep.txt must be untouched"
        );
    }

    #[tokio::test]
    async fn test_remove_template_rejects_outside_absolute_dir() {
        let (_base, _meta, _templates, outside, state) = sec_layout();

        let result = remove_template_impl(state, outside.to_str().unwrap()).await;

        assert!(result.is_err(), "outside dir must not be removable");
        assert_outside_untouched(&outside);
    }

    #[tokio::test]
    async fn test_remove_template_rejects_dotdot_traversal() {
        let (_base, _meta, templates, outside, state) = sec_layout();
        let sneaky = templates.join("..").join("outside");

        let result = remove_template_impl(state, sneaky.to_str().unwrap()).await;

        assert!(result.is_err(), "`templates/../outside` must be rejected");
        assert_outside_untouched(&outside);
    }

    #[tokio::test]
    async fn test_remove_template_rejects_templates_root_itself() {
        let (_base, _meta, templates, _outside, state) = sec_layout();

        let result = remove_template_impl(state, templates.to_str().unwrap()).await;

        assert!(result.is_err(), "templates root must not be removable");
        assert!(templates.is_dir());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_remove_template_symlink_to_outside_keeps_target() {
        let (_base, _meta, templates, outside, state) = sec_layout();
        let link = templates.join("link_to_outside");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let result = remove_template_impl(state.clone(), link.to_str().unwrap()).await;
        assert!(result.is_err(), "symlink pointing outside must be rejected");
        assert_outside_untouched(&outside);

        let via_link = link.join("keep.txt");
        let result_inner = remove_template_impl(state, via_link.to_str().unwrap()).await;
        assert!(
            result_inner.is_err(),
            "path through symlink pointing outside must be rejected"
        );
        assert_outside_untouched(&outside);
    }

    // ---------------------------------------------------------------------
    // TP-BE-05: use_template must not overwrite, validate dest, survive poison
    // ---------------------------------------------------------------------

    #[tokio::test]
    async fn test_use_template_does_not_overwrite_existing_file() {
        let template_dir = tempdir().unwrap();
        let dest_dir = tempdir().unwrap();
        let template_file = template_dir.path().join("item.txt");
        create_test_file(&template_file, b"new").unwrap();
        let existing = dest_dir.path().join("item.txt");
        create_test_file(&existing, b"original").unwrap();

        let result = use_template_impl(
            template_file.to_str().unwrap(),
            dest_dir.path().to_str().unwrap(),
        )
        .await;

        assert!(
            result.is_ok(),
            "should succeed with unique name: {result:?}"
        );
        assert_eq!(fs::read_to_string(&existing).unwrap(), "original");
        assert_eq!(
            fs::read_to_string(dest_dir.path().join("item (1).txt")).unwrap(),
            "new"
        );
    }

    #[tokio::test]
    async fn test_use_template_directory_with_dot_gets_unique_folder_name() {
        let template_parent = tempdir().unwrap();
        let dest_dir = tempdir().unwrap();
        let template = template_parent.path().join("a.b");
        create_test_file(&template.join("f.txt"), b"x").unwrap();
        fs::create_dir(dest_dir.path().join("a.b")).unwrap();

        let result = use_template_impl(
            template.to_str().unwrap(),
            dest_dir.path().to_str().unwrap(),
        )
        .await;

        assert!(result.is_ok(), "{result:?}");
        assert!(dest_dir.path().join("a.b (1)").join("f.txt").is_file());
        assert!(!dest_dir.path().join("a.b").join("f.txt").exists());
    }

    #[tokio::test]
    async fn test_use_template_rejects_file_as_destination() {
        let template_dir = tempdir().unwrap();
        let dest_dir = tempdir().unwrap();
        let template_file = template_dir.path().join("item.txt");
        create_test_file(&template_file, b"new").unwrap();
        let dest_file = dest_dir.path().join("dest.txt");
        create_test_file(&dest_file, b"original").unwrap();

        let result =
            use_template_impl(template_file.to_str().unwrap(), dest_file.to_str().unwrap()).await;

        let err = result.expect_err("a file destination must be rejected");
        assert!(err.contains("not a directory"), "{err}");
        assert_eq!(fs::read_to_string(&dest_file).unwrap(), "original");
    }

    #[tokio::test]
    async fn test_use_template_rejects_copy_into_itself() {
        let template_dir = tempdir().unwrap();
        create_test_file(&template_dir.path().join("f.txt"), b"x").unwrap();
        let inner = template_dir.path().join("inner");
        fs::create_dir(&inner).unwrap();

        let result = use_template_impl(
            template_dir.path().to_str().unwrap(),
            inner.to_str().unwrap(),
        )
        .await;

        assert!(result.is_err(), "copying a folder into itself must fail");
        assert_eq!(fs::read_dir(&inner).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_use_template_skips_symlink_loops() {
        let template_dir = tempdir().unwrap();
        let dest_dir = tempdir().unwrap();
        let template = template_dir.path().join("tpl");
        create_test_file(&template.join("f.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(&template, template.join("loop")).unwrap();

        let result = use_template_impl(
            template.to_str().unwrap(),
            dest_dir.path().to_str().unwrap(),
        )
        .await;

        assert!(result.is_ok(), "{result:?}");
        assert!(dest_dir.path().join("tpl").join("f.txt").is_file());
        assert!(!dest_dir.path().join("tpl").join("loop").exists());
    }

    #[tokio::test]
    async fn test_poisoned_state_returns_error_instead_of_panicking() {
        let templates_dir = tempdir().unwrap();
        let metadata_dir = tempdir().unwrap();
        let state = create_test_metadata_state(
            metadata_dir.path().join("meta_data.json"),
            templates_dir.path().to_path_buf(),
        );
        let template = templates_dir.path().join("tpl");
        fs::create_dir(&template).unwrap();
        let source = tempdir().unwrap();
        create_test_file(&source.path().join("a.txt"), b"a").unwrap();

        // Poison the outer Mutex<MetaDataState>.
        let poisoner = state.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock().unwrap();
            panic!("intentional poison");
        })
        .join();
        assert!(state.lock().is_err(), "mutex should be poisoned");

        let listed = get_template_paths_as_json_impl(state.clone()).await;
        assert!(listed.is_err());

        let added = add_template_impl(state.clone(), source.path().to_str().unwrap()).await;
        assert!(added.is_err());

        let removed = remove_template_impl(state, template.to_str().unwrap()).await;
        assert!(removed.is_err());
        assert!(template.exists(), "nothing may be removed on lock failure");
    }

    #[tokio::test]
    async fn test_errors_are_json_serialized() {
        let dest_dir = tempdir().unwrap();
        let err = use_template_impl(
            "/path/to/nonexistent/template",
            dest_dir.path().to_str().unwrap(),
        )
        .await
        .unwrap_err();
        let parsed: Error = serde_json::from_str(&err).expect("error must be JSON");
        assert_eq!(parsed.message_from_code, ErrorCode::ResourceNotFound);
    }
}
