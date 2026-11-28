//! Ownership and bounded VT history for a single SSH PTY.
//! The SSH worker is unchanged; every handoff is a view-only transition.
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};

const MAX_VIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_FRAMES: usize = 16_384;
const READ_BYTES: usize = 256 * 1024;
const READ_FRAMES: usize = 128;
static JOURNAL_BYTES: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Debug, Serialize)]
pub struct ViewFrame {
    pub seq: u64,
    pub data: String,
    pub cols: Option<u32>,
    pub rows: Option<u32>,
    pub clear: bool,
}

impl ViewFrame {
    fn cost(&self) -> usize {
        self.data.len() + 64
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ViewStatus {
    pub epoch: u64,
    pub phase: &'static str,
    pub label: Option<String>,
    pub attach_requested: bool,
}

#[derive(Serialize)]
pub struct ViewRead {
    pub session_id: String,
    pub status: ViewStatus,
    pub frames: Vec<ViewFrame>,
    pub latest: u64,
}

#[derive(Debug)]
enum Owner {
    Main,
    Preparing {
        label: String,
        required_seq: u64,
    },
    Detached {
        label: String,
        attach_requested: bool,
    },
}

pub(super) struct PtyView {
    owner: Owner,
    epoch: u64,
    frames: VecDeque<ViewFrame>,
    bytes: usize,
    latest: u64,
    complete: bool,
}

impl Default for PtyView {
    fn default() -> Self {
        Self {
            owner: Owner::Main,
            epoch: 0,
            frames: VecDeque::new(),
            bytes: 0,
            latest: 0,
            complete: true,
        }
    }
}

impl Drop for PtyView {
    fn drop(&mut self) {
        JOURNAL_BYTES.fetch_sub(self.bytes, Ordering::Relaxed);
    }
}

impl PtyView {
    pub(super) fn status(&self) -> ViewStatus {
        let (phase, label, attach_requested) = match &self.owner {
            Owner::Main => ("attached", None, false),
            Owner::Preparing { label, .. } => ("detaching", Some(label.clone()), false),
            Owner::Detached {
                label,
                attach_requested,
            } => ("detached", Some(label.clone()), *attach_requested),
        };
        ViewStatus {
            epoch: self.epoch,
            phase,
            label,
            attach_requested,
        }
    }

    pub(super) fn authorize(&self, label: &str, epoch: Option<u64>) -> Result<(), String> {
        let owner = match &self.owner {
            Owner::Main => "main",
            Owner::Detached { label, .. } => label,
            Owner::Preparing { .. } => return Err("PTY view handoff in progress".into()),
        };
        if owner != label || self.epoch != epoch.unwrap_or(0) {
            return Err("PTY view access denied: stale or foreign owner".into());
        }
        Ok(())
    }

    pub(super) fn begin(
        &mut self,
        label: &str,
        epoch: Option<u64>,
        session_id: &str,
    ) -> Result<ViewStatus, String> {
        self.authorize(label, epoch)?;
        if !matches!(self.owner, Owner::Main) {
            return Err("PTY already detached".into());
        }
        if !self.complete {
            return Err("VT history budget exhausted; detach unavailable for this session".into());
        }
        self.epoch += 1;
        self.owner = Owner::Preparing {
            label: format!("terminal-{session_id}-{}", self.epoch),
            required_seq: self.latest,
        };
        Ok(self.status())
    }

    pub(super) fn ready(
        &mut self,
        label: &str,
        epoch: u64,
        cursor: u64,
    ) -> Result<ViewStatus, String> {
        match &self.owner {
            Owner::Preparing {
                label: target,
                required_seq,
            } if target == label && epoch == self.epoch && cursor >= *required_seq => {}
            _ => return Err("PTY handoff is stale or replay incomplete".into()),
        }
        self.check_cursor(cursor)?;
        self.epoch += 1;
        self.owner = Owner::Detached {
            label: label.to_string(),
            attach_requested: false,
        };
        Ok(self.status())
    }

    pub(super) fn return_to_main(
        &mut self,
        label: &str,
        epoch: Option<u64>,
    ) -> Result<ViewStatus, String> {
        if self.status().label.as_deref() != Some(label) || self.epoch != epoch.unwrap_or(0) {
            return Err("PTY handoff is stale or foreign".into());
        }
        self.epoch += 1;
        self.owner = Owner::Main;
        Ok(self.status())
    }

    pub(super) fn request_attach(&mut self, label: &str) -> Result<ViewStatus, String> {
        match &mut self.owner {
            Owner::Detached {
                label: owner,
                attach_requested,
            } if owner == label => *attach_requested = true,
            _ => return Err("PTY detached owner unavailable".into()),
        }
        Ok(self.status())
    }

    pub(super) fn matches_window(&self, label: &str) -> bool {
        matches!(&self.owner, Owner::Preparing { label: owner, .. } | Owner::Detached { label: owner, .. } if owner == label)
    }

    fn evict(&mut self) -> bool {
        if let Some(frame) = self.frames.pop_front() {
            let cost = frame.cost();
            self.bytes -= cost;
            JOURNAL_BYTES.fetch_sub(cost, Ordering::Relaxed);
            self.complete = false;
            true
        } else {
            false
        }
    }

    fn reserve(cost: usize) -> bool {
        let mut current = JOURNAL_BYTES.load(Ordering::Relaxed);
        loop {
            let Some(next) = current
                .checked_add(cost)
                .filter(|sum| *sum <= MAX_TOTAL_BYTES)
            else {
                return false;
            };
            match JOURNAL_BYTES.compare_exchange_weak(
                current,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
    }

    pub(super) fn record(
        &mut self,
        data: String,
        size: Option<(u32, u32)>,
        clear: bool,
    ) -> ViewFrame {
        self.latest += 1;
        let frame = ViewFrame {
            seq: self.latest,
            data,
            cols: size.map(|s| s.0),
            rows: size.map(|s| s.1),
            clear,
        };
        let cost = frame.cost();
        // An incomplete history cannot bootstrap another view. Retain the
        // live tail only while a detached/transitioning reader may need it.
        if !self.complete && matches!(self.owner, Owner::Main) {
            return frame;
        }
        while self.bytes.saturating_add(cost) > MAX_VIEW_BYTES || self.frames.len() >= MAX_FRAMES {
            if !self.evict() {
                self.complete = false;
                return frame;
            }
        }
        while !Self::reserve(cost) {
            if !self.evict() {
                self.complete = false;
                return frame;
            }
        }
        self.bytes += cost;
        self.frames.push_back(frame.clone());
        frame
    }

    fn check_cursor(&self, cursor: u64) -> Result<(), String> {
        if cursor > self.latest
            || (cursor < self.latest && self.frames.front().is_none_or(|f| f.seq > cursor + 1))
        {
            return Err("VT output gap: return to main terminal".into());
        }
        Ok(())
    }

    pub(super) fn read(
        &self,
        label: &str,
        session_id: &str,
        cursor: u64,
    ) -> Result<ViewRead, String> {
        if !self.matches_window(label) {
            return Err("PTY view access denied".into());
        }
        self.check_cursor(cursor)?;
        let mut bytes = 0;
        let mut frames = Vec::new();
        let start = self.frames.partition_point(|f| f.seq <= cursor);
        for (expected, frame) in
            (cursor + 1..).zip(self.frames.iter().skip(start).take(READ_FRAMES))
        {
            if frame.seq != expected {
                return Err("VT output gap: return to main terminal".into());
            }
            if !frames.is_empty() && bytes + frame.cost() > READ_BYTES {
                break;
            }
            bytes += frame.cost();
            frames.push(frame.clone());
        }
        if frames.is_empty() && cursor < self.latest {
            return Err("VT output gap: return to main terminal".into());
        }
        Ok(ViewRead {
            session_id: session_id.into(),
            status: self.status(),
            frames,
            latest: self.latest,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_is_single_owner_and_rejects_stale_epochs() {
        let mut view = PtyView::default();
        view.record("first".into(), None, false);
        assert!(view.authorize("main", None).is_ok());
        let preparing = view.begin("main", None, "ssh-pty-1").unwrap();
        let label = preparing.label.unwrap();
        assert!(view.begin("main", None, "ssh-pty-1").is_err());
        assert!(view.authorize("main", Some(preparing.epoch)).is_err());
        assert!(view.authorize(&label, Some(preparing.epoch)).is_err());
        assert!(view.ready(&label, preparing.epoch, 0).is_err());
        assert!(view.ready("terminal-other", preparing.epoch, 1).is_err());
        view.record("during".into(), None, false);
        let batch = view.read(&label, "ssh-pty-1", 0).unwrap();
        assert_eq!(
            batch.frames.iter().map(|f| f.seq).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(view.read("terminal-other", "ssh-pty-1", 0).is_err());
        let detached = view.ready(&label, preparing.epoch, 2).unwrap();
        assert!(view.authorize(&label, Some(detached.epoch)).is_ok());
        assert!(view.authorize("main", Some(detached.epoch)).is_err());
        assert!(view.authorize(&label, Some(preparing.epoch)).is_err());
        assert!(view.request_attach(&label).unwrap().attach_requested);
        let attached = view.return_to_main(&label, Some(detached.epoch)).unwrap();
        assert!(view.authorize("main", Some(attached.epoch)).is_ok());
        assert!(view.authorize("main", None).is_err());
        assert!(view.return_to_main(&label, Some(detached.epoch)).is_err());
    }

    #[test]
    fn journal_keeps_geometry_and_clear_in_sequence() {
        let mut view = PtyView::default();
        view.record(String::new(), Some((100, 30)), false);
        view.record("\x1b[?1049h".into(), None, false);
        view.record(String::new(), Some((80, 25)), false);
        view.record(String::new(), None, true);
        let s = view.begin("main", None, "ssh-pty-2").unwrap();
        let batch = view
            .read(s.label.as_deref().unwrap(), "ssh-pty-2", 0)
            .unwrap();
        assert_eq!(batch.frames[0].cols, Some(100));
        assert_eq!(batch.frames[1].data, "\x1b[?1049h");
        assert_eq!(batch.frames[2].rows, Some(25));
        assert!(batch.frames[3].clear);
        assert_eq!(batch.latest, 4);
    }

    #[test]
    fn overflow_refuses_bootstrap_and_does_not_mutate_owner() {
        let mut view = PtyView::default();
        view.record("x".repeat(MAX_VIEW_BYTES + 1), None, false);
        assert!(view.begin("main", None, "ssh-pty-3").is_err());
        assert_eq!(view.status().phase, "attached");
        assert!(view.authorize("main", None).is_ok());
    }

    #[test]
    fn overflow_during_handoff_detects_gap_and_allows_rollback() {
        let mut view = PtyView::default();
        view.record("before".into(), None, false);
        let s = view.begin("main", None, "ssh-pty-4").unwrap();
        let label = s.label.unwrap();
        view.record("x".repeat(MAX_VIEW_BYTES + 1), None, false);
        assert!(view.read(&label, "ssh-pty-4", 0).is_err());
        assert!(view.ready(&label, s.epoch, 1).is_err());
        assert_eq!(
            view.return_to_main(&label, Some(s.epoch)).unwrap().phase,
            "attached"
        );
    }
}
