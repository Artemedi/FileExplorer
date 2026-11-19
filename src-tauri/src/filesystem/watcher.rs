use crate::error_handling::Error;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsChangeEvent {
    pub kind: String,
    pub paths: Vec<String>,
}

/// Maps a `notify` event kind to the string sent to the frontend.
///
/// Returns `None` for events that must not trigger a directory reload:
/// `Access` events (plain reads/opens/closes, which would cause reload storms
/// because reloading the directory itself reads it) and `Any`/`Other` events.
pub fn event_kind_to_str(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("create"),
        EventKind::Modify(_) => Some("modify"),
        EventKind::Remove(_) => Some("remove"),
        _ => None,
    }
}

/// Converts a raw `notify` event into the payload for the frontend, if relevant.
fn event_to_payload(event: &Event) -> Option<FsChangeEvent> {
    let kind = event_kind_to_str(&event.kind)?;
    Some(FsChangeEvent {
        kind: kind.to_string(),
        paths: event
            .paths
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
    })
}

/// Handler that forwards events to the frontend as `fs-change` Tauri events.
fn emit_handler(app: AppHandle) -> impl Fn(FsChangeEvent) + Send + 'static {
    move |payload| {
        if let Err(e) = app.emit("fs-change", payload) {
            crate::log_error!("Failed to emit fs-change event: {}", e);
        }
    }
}

pub struct DirectoryWatcher {
    pub active: Option<(RecommendedWatcher, PathBuf)>,
}

impl Default for DirectoryWatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl DirectoryWatcher {
    pub fn new() -> Self {
        Self { active: None }
    }

    /// Returns `true` if `path` is exactly the directory currently being watched.
    pub fn is_watching(&self, path: &Path) -> bool {
        matches!(&self.active, Some((_, current)) if current == path)
    }

    /// Builds and starts a watcher for `path` without touching any existing one.
    ///
    /// `handler` is called for every relevant (non-access) event. Nothing here
    /// needs an `AppHandle`, which keeps this testable.
    pub fn build_watcher<F>(
        path: PathBuf,
        handler: F,
    ) -> Result<(RecommendedWatcher, PathBuf), String>
    where
        F: Fn(FsChangeEvent) + Send + 'static,
    {
        if !path.is_dir() {
            return Err(Error::resource_not_found(format!(
                "Path does not exist or is not a directory: {}",
                path.display()
            ))
            .to_json());
        }

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| match res {
                Ok(event) => {
                    if let Some(payload) = event_to_payload(&event) {
                        handler(payload);
                    }
                }
                Err(e) => {
                    crate::log_error!("File watcher error: {}", e);
                }
            },
            Config::default(),
        )
        .map_err(|e| Error::internal(format!("Failed to create watcher: {e}")).to_json())?;

        watcher
            .watch(&path, RecursiveMode::NonRecursive)
            .map_err(|e| {
                Error::internal(format!(
                    "Failed to watch directory {}: {}",
                    path.display(),
                    e
                ))
                .to_json()
            })?;

        Ok((watcher, path))
    }

    /// Builds a watcher that emits `fs-change` events through the Tauri app.
    pub fn build_app_watcher(
        path: PathBuf,
        app: AppHandle,
    ) -> Result<(RecommendedWatcher, PathBuf), String> {
        Self::build_watcher(path, emit_handler(app))
    }

    /// Installs a freshly built watcher, returning the previous one (if any) so
    /// the caller can drop it outside of any lock.
    pub fn replace_active(
        &mut self,
        new_active: (RecommendedWatcher, PathBuf),
    ) -> Option<(RecommendedWatcher, PathBuf)> {
        self.active.replace(new_active)
    }

    /// Starts watching `path`, calling `handler` for relevant events.
    ///
    /// The previous watcher is only replaced after the new one has been
    /// started successfully; on error the previous watcher stays active.
    #[allow(dead_code)]
    pub fn watch_with_handler<F>(&mut self, path: PathBuf, handler: F) -> Result<(), String>
    where
        F: Fn(FsChangeEvent) + Send + 'static,
    {
        // If we are already watching this exact path, nothing to do
        if self.is_watching(&path) {
            return Ok(());
        }
        let new_active = Self::build_watcher(path, handler)?;
        self.replace_active(new_active);
        Ok(())
    }

    #[allow(dead_code)]
    pub fn unwatch(&mut self) {
        self.active = None;
    }
}

pub type WatcherState = DirectoryWatcher;

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, AccessMode, CreateKind, ModifyKind, RemoveKind};
    use tempfile::tempdir;

    #[test]
    fn test_directory_watcher_init_and_unwatch() {
        let mut watcher = DirectoryWatcher::new();
        assert!(watcher.active.is_none());
        watcher.unwatch();
        assert!(watcher.active.is_none());
    }

    #[test]
    fn test_event_kind_to_str_filters_access_and_other() {
        assert_eq!(
            event_kind_to_str(&EventKind::Create(CreateKind::File)),
            Some("create")
        );
        assert_eq!(
            event_kind_to_str(&EventKind::Modify(ModifyKind::Any)),
            Some("modify")
        );
        assert_eq!(
            event_kind_to_str(&EventKind::Remove(RemoveKind::File)),
            Some("remove")
        );
        assert_eq!(
            event_kind_to_str(&EventKind::Access(AccessKind::Close(AccessMode::Read))),
            None
        );
        assert_eq!(event_kind_to_str(&EventKind::Access(AccessKind::Any)), None);
        assert_eq!(event_kind_to_str(&EventKind::Other), None);
        assert_eq!(event_kind_to_str(&EventKind::Any), None);
    }

    #[test]
    fn test_event_to_payload_skips_access_events() {
        let access = Event::new(EventKind::Access(AccessKind::Any)).add_path(PathBuf::from("a"));
        assert!(event_to_payload(&access).is_none());

        let create = Event::new(EventKind::Create(CreateKind::File)).add_path(PathBuf::from("a"));
        let payload = event_to_payload(&create).expect("create must be forwarded");
        assert_eq!(payload.kind, "create");
        assert_eq!(payload.paths, vec!["a".to_string()]);
    }

    #[test]
    fn test_failed_watch_keeps_previous_active_watcher() {
        let dir = tempdir().unwrap();
        let mut watcher = DirectoryWatcher::new();
        watcher
            .watch_with_handler(dir.path().to_path_buf(), |_| {})
            .expect("watching an existing dir must succeed");
        assert!(watcher.is_watching(dir.path()));

        let missing = dir.path().join("does-not-exist");
        let err = watcher
            .watch_with_handler(missing.clone(), |_| {})
            .expect_err("watching a nonexistent path must fail");
        assert!(err.contains("does not exist"), "unexpected error: {err}");

        // Previous watcher must still be active
        assert!(watcher.is_watching(dir.path()));
        assert!(!watcher.is_watching(&missing));
    }

    #[test]
    fn test_failed_watch_on_file_keeps_previous_active_watcher() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("file.txt");
        std::fs::write(&file, "x").unwrap();

        let mut watcher = DirectoryWatcher::new();
        watcher
            .watch_with_handler(dir.path().to_path_buf(), |_| {})
            .unwrap();
        assert!(watcher.watch_with_handler(file, |_| {}).is_err());
        assert!(watcher.is_watching(dir.path()));
    }

    #[test]
    fn test_watch_switches_to_new_directory_and_same_path_is_noop() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let mut watcher = DirectoryWatcher::new();
        watcher
            .watch_with_handler(a.path().to_path_buf(), |_| {})
            .unwrap();
        // Same path again: still fine, still watching
        watcher
            .watch_with_handler(a.path().to_path_buf(), |_| {})
            .unwrap();
        assert!(watcher.is_watching(a.path()));

        watcher
            .watch_with_handler(b.path().to_path_buf(), |_| {})
            .unwrap();
        assert!(watcher.is_watching(b.path()));
        assert!(!watcher.is_watching(a.path()));

        watcher.unwatch();
        assert!(watcher.active.is_none());
    }
}
