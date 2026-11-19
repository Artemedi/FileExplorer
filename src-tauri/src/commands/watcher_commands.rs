use crate::error_handling::Error;
use crate::filesystem::watcher::{DirectoryWatcher, WatcherState};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

fn lock_error(e: impl std::fmt::Display) -> String {
    Error::internal(format!("Failed to acquire watcher lock: {e}")).to_json()
}

#[tauri::command]
pub fn watch_directory(
    path: String,
    state: State<Arc<Mutex<WatcherState>>>,
    app: AppHandle,
) -> Result<(), String> {
    let path = PathBuf::from(path);

    // Cheap check under the lock: already watching this exact path?
    {
        let watcher = state.lock().map_err(lock_error)?;
        if watcher.is_watching(&path) {
            return Ok(());
        }
    }

    // Create and start the new watcher WITHOUT holding the lock. If this fails,
    // the previous watcher stays active.
    let new_active = DirectoryWatcher::build_app_watcher(path, app)?;

    // Swap under the lock, drop the old watcher after releasing it.
    let old = {
        let mut watcher = state.lock().map_err(lock_error)?;
        watcher.replace_active(new_active)
    };
    drop(old);
    Ok(())
}

#[tauri::command]
pub fn unwatch_directory(state: State<Arc<Mutex<WatcherState>>>) -> Result<(), String> {
    let old = {
        let mut watcher = state.lock().map_err(lock_error)?;
        watcher.active.take()
    };
    drop(old);
    Ok(())
}
