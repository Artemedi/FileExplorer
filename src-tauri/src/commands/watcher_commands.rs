use crate::filesystem::watcher::WatcherState;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn watch_directory(
    path: String,
    state: State<Arc<Mutex<WatcherState>>>,
    app: AppHandle,
) -> Result<(), String> {
    let mut watcher = state
        .lock()
        .map_err(|e| format!("Failed to acquire watcher lock: {}", e))?;
    watcher.watch(PathBuf::from(path), app)
}

#[tauri::command]
pub fn unwatch_directory(
    state: State<Arc<Mutex<WatcherState>>>,
) -> Result<(), String> {
    let mut watcher = state
        .lock()
        .map_err(|e| format!("Failed to acquire watcher lock: {}", e))?;
    watcher.unwatch();
    Ok(())
}
