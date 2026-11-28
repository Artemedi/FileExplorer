//! Bounded, per-PTY control state. Only the SSH worker consumes this queue.
use super::pty_view::PtyView;
use std::collections::{HashMap, VecDeque};
use std::io::{self, Write};
use std::sync::{Arc, Mutex, OnceLock};

const MAX_PENDING_BYTES: usize = 1024 * 1024;
const MAX_PENDING_WRITES: usize = 1024;

#[derive(Default)]
pub(super) struct PtyControls {
    writes: VecDeque<Box<[u8]>>,
    queued_bytes: usize,
    offset: usize,
    pub(super) write_blocked: bool,
    pub(super) resize: Option<(u32, u32)>,
    pub(super) closed: bool,
    pub(super) view: PtyView,
}

impl PtyControls {
    pub(super) fn enqueue(&mut self, data: String) -> Result<(), String> {
        if self.closed {
            return Err("SSH PTY session is closed".to_string());
        }
        if data.is_empty() {
            return Ok(());
        }
        if data.len() > MAX_PENDING_BYTES - self.queued_bytes
            || self.writes.len() >= MAX_PENDING_WRITES
        {
            return Err("SSH PTY input queue is full; input was not accepted".to_string());
        }
        self.queued_bytes += data.len();
        self.writes.push_back(data.into_bytes().into_boxed_slice());
        Ok(())
    }

    // Keep the allocation and offset unchanged on WouldBlock. A successful
    // partial write advances only by the number of bytes accepted by SSH.
    pub(super) fn write_next(&mut self, writer: &mut impl Write) -> io::Result<bool> {
        let Some(bytes) = self.writes.front() else {
            return Ok(false);
        };
        match writer.write(&bytes[self.offset..]) {
            Ok(0) => Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(n) => {
                self.write_blocked = false;
                self.offset += n;
                if self.offset == bytes.len() {
                    self.queued_bytes -= bytes.len();
                    self.writes.pop_front();
                    self.offset = 0;
                }
                Ok(true)
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                self.write_blocked = true;
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }

    pub(super) fn close(&mut self) {
        self.closed = true;
        self.writes.clear();
        self.queued_bytes = 0;
        self.offset = 0;
        self.write_blocked = false;
        self.resize = None;
    }
}

pub(super) type Controls = Arc<Mutex<PtyControls>>;
static SESSIONS: OnceLock<Mutex<HashMap<String, Controls>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Controls>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn lookup(id: &str) -> Result<Controls, String> {
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
        .ok_or_else(|| format!("SSH PTY session not found: {id}"))
}

pub(super) fn close(id: &str) {
    // Release the global lock before taking the session lock.
    let controls = sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id);
    if let Some(controls) = controls {
        controls.lock().unwrap_or_else(|e| e.into_inner()).close();
    }
}

/// The worker owns registration, so every exit path removes the entry.
/// Locate the view only by its actual backend-assigned window label.
pub(super) fn lookup_window(label: &str) -> Result<(String, Controls), String> {
    let id = label
        .strip_prefix("terminal-")
        .and_then(|s| s.rsplit_once('-'))
        .map(|(id, _)| id)
        .ok_or("Invalid PTY window label")?;
    let controls = lookup(id)?;
    let authorized = {
        let control = controls.lock().unwrap_or_else(|e| e.into_inner());
        !control.closed && control.view.matches_window(label)
    };
    if !authorized {
        return Err("PTY view access denied".into());
    }
    Ok((id.to_string(), controls))
}

pub(super) fn close_owned(id: &str, label: &str, epoch: Option<u64>) -> Result<(), String> {
    let Ok(controls) = lookup(id) else {
        return Ok(());
    };
    {
        let mut control = controls.lock().unwrap_or_else(|e| e.into_inner());
        control.view.authorize(label, epoch)?;
        control.close();
    }
    close(id);
    Ok(())
}

pub(super) fn close_all() {
    let ids: Vec<_> = sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys()
        .cloned()
        .collect();
    for id in ids {
        close(&id);
    }
}

/// IDs are allocated once by SSH_PTY_COUNTER, never reused.
pub(super) struct Registration(String);

impl Registration {
    pub(super) fn new(id: String) -> (Self, Controls) {
        let controls = Arc::new(Mutex::new(PtyControls::default()));
        sessions()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), Arc::clone(&controls));
        (Self(id), controls)
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        close(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;

    struct PartialWriter {
        received: Vec<u8>,
        calls: usize,
    }

    impl Write for PartialWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.calls += 1;
            if self.calls.is_multiple_of(2) {
                return Err(io::Error::from(io::ErrorKind::WouldBlock));
            }
            let n = buf.len().min(2);
            self.received.extend_from_slice(&buf[..n]);
            Ok(n)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn partial_writes_and_would_block_preserve_order_and_bytes() {
        let mut controls = PtyControls::default();
        controls.enqueue("abcde".to_string()).unwrap();
        controls.enqueue("фgh".to_string()).unwrap();
        let mut writer = PartialWriter {
            received: Vec::new(),
            calls: 0,
        };
        for _ in 0..20 {
            controls.write_next(&mut writer).unwrap();
        }
        assert_eq!(writer.received, "abcdeфgh".as_bytes());
        assert_eq!(controls.queued_bytes, 0);
        assert!(controls.writes.is_empty());
    }

    #[test]
    fn byte_limit_rejects_whole_write_without_mutation() {
        let mut controls = PtyControls::default();
        controls.enqueue("x".repeat(MAX_PENDING_BYTES)).unwrap();
        assert!(controls.enqueue("y".to_string()).is_err());
        assert_eq!(controls.queued_bytes, MAX_PENDING_BYTES);
        assert_eq!(controls.writes.len(), 1);
        let mut sink = Vec::new();
        controls.write_next(&mut sink).unwrap();
        assert_eq!(sink.len(), MAX_PENDING_BYTES);
        assert!(controls.enqueue("y".to_string()).is_ok());
    }

    #[test]
    fn count_limit_bounds_small_allocations() {
        let mut controls = PtyControls::default();
        for _ in 0..MAX_PENDING_WRITES {
            controls.enqueue("x".to_string()).unwrap();
        }
        assert!(controls.enqueue("y".to_string()).is_err());
        assert_eq!(controls.queued_bytes, MAX_PENDING_WRITES);
    }

    #[test]
    fn zero_write_is_fatal() {
        struct Zero;
        impl Write for Zero {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Ok(0)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut controls = PtyControls::default();
        controls.enqueue("x".to_string()).unwrap();
        assert_eq!(
            controls.write_next(&mut Zero).unwrap_err().kind(),
            io::ErrorKind::WriteZero
        );
    }

    #[test]
    fn registration_precedes_ready_and_fast_exit_never_reinserts() {
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let (_registration, _) = Registration::new("fast-exit".to_string());
            assert!(lookup("fast-exit").is_ok());
            ready_tx.send(()).unwrap();
        });
        ready_rx.recv().unwrap();
        worker.join().unwrap();
        assert!(lookup("fast-exit").is_err());
    }

    #[test]
    fn close_is_immediate_even_with_full_queue_and_stale_handle() {
        let (_registration, controls) = Registration::new("close-full".to_string());
        let stale = lookup("close-full").unwrap();
        controls
            .lock()
            .unwrap()
            .enqueue("x".repeat(MAX_PENDING_BYTES))
            .unwrap();
        close("close-full");
        close("close-full");
        assert!(lookup("close-full").is_err());
        let mut stale = stale.lock().unwrap();
        assert!(stale.closed);
        assert_eq!(stale.queued_bytes, 0);
        assert!(stale.enqueue("y".to_string()).is_err());
    }

    #[test]
    fn repeated_registration_and_drop_releases_every_session() {
        for i in 0..10 {
            let id = format!("cycle-{i}");
            let (registration, _) = Registration::new(id.clone());
            assert!(lookup(&id).is_ok());
            drop(registration);
            assert!(lookup(&id).is_err());
        }
    }
}
