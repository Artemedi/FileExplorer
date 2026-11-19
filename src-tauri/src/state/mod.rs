//! # Application State Management
//!
//! This module handles the application state through Tauri's state management system.
//! States defined here are automatically autowired and managed by Tauri's dependency
//! injection system, making them available throughout the application.
//!
//! ## How it works
//!
//! 1. State structs are defined in submodules (e.g., `meta_data`, `settings_data`)
//! 2. The `setup_app_state` function registers these states with Tauri
//! 3. States are wrapped in `Arc<Mutex<T>>` to allow safe concurrent access
//! 4. Tauri's `.manage()` function is used to register states with the application
//!
//! ## Adding a new state
//!
//! To add a new state:
//! 1. Create a new module with your state struct
//! 2. Add it to the imports in this file
//! 3. Add it to the `setup_app_state` function using `.manage(Arc::new(Mutex::new(YourState::new())))`
//!
//! States can then be accessed in command handlers using the `#[tauri::command]` macro
//! and appropriate state parameters.

pub mod logging;
pub mod meta_data;
pub mod searchengine_data;
pub mod settings_data;

pub use settings_data::*;

use crate::filesystem::watcher::WatcherState;
use crate::state::searchengine_data::SearchEngineState;
use logging::Logger;
use meta_data::MetaDataState;
use std::io::{self, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{Builder, Wry};

/// Atomically writes `contents` to `target_path` by writing to a temporary file
/// in the same directory, syncing it to disk, and persisting it over the target.
pub(crate) fn atomic_write_file(target_path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = target_path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("Path has no parent directory: {}", target_path.display()),
        )
    })?;
    let parent_dir = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    std::fs::create_dir_all(parent_dir)?;

    let mut temp_file = tempfile::NamedTempFile::new_in(parent_dir)?;
    temp_file.write_all(contents)?;
    temp_file.as_file().sync_all()?;
    temp_file.persist(target_path).map_err(|e| e.error)?;
    Ok(())
}

pub fn setup_app_state(app: Builder<Wry>) -> Builder<Wry> {
    // Initialize SettingsState and the global logger FIRST so early log_error! calls
    // during MetaDataState/SearchEngineState initialization never bind OnceLock to a detached state.
    let settings_state = Arc::new(Mutex::new(SettingsState::new()));
    Logger::init(settings_state.clone());

    let meta_data_state = Arc::new(Mutex::new(MetaDataState::new()));
    let search_engine_state = Arc::new(Mutex::new(SearchEngineState::new(settings_state.clone())));
    let watcher_state = Arc::new(Mutex::new(WatcherState::new()));

    //To add more just .manage
    app.manage(meta_data_state)
        .manage(settings_state)
        .manage(search_engine_state)
        .manage(watcher_state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_atomic_write_file_creates_and_replaces_without_temp_leftovers() {
        let dir = tempdir().expect("Failed to create temp dir");
        let target = dir.path().join("nested").join("config.json");

        atomic_write_file(&target, b"{\"v\":1}").expect("First atomic write should succeed");
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"v\":1}");

        atomic_write_file(&target, b"{\"v\":2}").expect("Second atomic write should succeed");
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"v\":2}");

        let entries: Vec<_> = fs::read_dir(dir.path().join("nested"))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(
            entries.len(),
            1,
            "No leftover temp files should remain after atomic persist"
        );
    }
}
