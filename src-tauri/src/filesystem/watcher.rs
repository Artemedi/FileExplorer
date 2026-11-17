use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsChangeEvent {
    pub kind: String,
    pub paths: Vec<String>,
}

pub struct DirectoryWatcher {
    pub active: Option<(RecommendedWatcher, PathBuf)>,
}

impl DirectoryWatcher {
    pub fn new() -> Self {
        Self { active: None }
    }

    pub fn watch(
        &mut self,
        path: PathBuf,
        app: AppHandle,
    ) -> Result<(), String> {
        // If we are already watching this exact path, nothing to do
        if let Some((_, ref current_path)) = self.active {
            if current_path == &path {
                return Ok(());
            }
        }

        // Clean up existing watcher
        self.active = None;

        if !path.exists() || !path.is_dir() {
            return Err(format!("Path does not exist or is not a directory: {}", path.display()));
        }

        let app_clone = app.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let kind = match event.kind {
                        EventKind::Create(_) => "create",
                        EventKind::Modify(_) => "modify",
                        EventKind::Remove(_) => "remove",
                        _ => "other",
                    };
                    let paths: Vec<String> = event
                        .paths
                        .iter()
                        .map(|p| p.to_string_lossy().to_string())
                        .collect();

                    let payload = FsChangeEvent {
                        kind: kind.to_string(),
                        paths,
                    };

                    let _ = app_clone.emit("fs-change", payload);
                }
            },
            Config::default(),
        )
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

        watcher
            .watch(&path, RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch directory {}: {}", path.display(), e))?;

        self.active = Some((watcher, path));
        Ok(())
    }

    pub fn unwatch(&mut self) {
        self.active = None;
    }
}

pub type WatcherState = DirectoryWatcher;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_directory_watcher_init_and_unwatch() {
        let mut watcher = DirectoryWatcher::new();
        assert!(watcher.active.is_none());
        watcher.unwatch();
        assert!(watcher.active.is_none());
    }
}

