//! Native window lifecycle for one existing PTY, never a new SSH connection.
use super::{
    pty_io,
    pty_view::{ViewRead, ViewStatus},
};
use serde::Serialize;
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};

const HANDOFF_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Serialize)]
struct WindowStatus {
    session_id: String,
    #[serde(flatten)]
    status: ViewStatus,
}

fn notify(app: &AppHandle, id: &str, status: ViewStatus) {
    let _ = app.emit_to(
        "main",
        "ssh-pty-window",
        WindowStatus {
            session_id: id.into(),
            status,
        },
    );
}

fn restore(app: &AppHandle, label: &str, epoch: u64) -> bool {
    let Ok((id, controls)) = pty_io::lookup_window(label) else {
        return false;
    };
    let mut control = controls.lock().unwrap_or_else(|e| e.into_inner());
    if control.closed {
        return false;
    }
    match control.view.return_to_main(label, Some(epoch)) {
        Ok(status) => {
            notify(app, &id, status);
            true
        }
        Err(_) => false,
    }
}

fn destroy_view(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
}

#[tauri::command]
pub async fn ssh_detach_pty(
    app: AppHandle,
    window: WebviewWindow,
    session_id: String,
    owner_epoch: Option<u64>,
) -> Result<ViewStatus, String> {
    let controls = pty_io::lookup(&session_id)?;
    let status = {
        let mut control = controls.lock().unwrap_or_else(|e| e.into_inner());
        if control.closed {
            return Err("SSH PTY session is closed".into());
        }
        let status = control
            .view
            .begin(window.label(), owner_epoch, &session_id)?;
        notify(&app, &session_id, status.clone());
        status
    };
    let label = status.label.clone().ok_or("Missing detached label")?;
    // The async command avoids creating WebView2 inside a synchronous invoke.
    let created = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Explr — SSH Terminal")
        .inner_size(900.0, 620.0)
        .build();
    if let Err(error) = created {
        restore(&app, &label, status.epoch);
        return Err(format!("Detached window creation failed: {error}"));
    }
    // Remote exit may have raced the native window creation.
    if pty_io::lookup_window(&label).is_err() {
        destroy_view(&app, &label);
        return Err("PTY exited during detach".into());
    }
    let timer_app = app.clone();
    let timer_label = label.clone();
    let epoch = status.epoch;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(HANDOFF_TIMEOUT).await;
        // A successful ready increments epoch, so this cannot revoke it.
        if restore(&timer_app, &timer_label, epoch) {
            destroy_view(&timer_app, &timer_label);
        }
    });
    Ok(status)
}

#[tauri::command]
pub fn ssh_detached_read(window: WebviewWindow, cursor: u64) -> Result<ViewRead, String> {
    let (id, controls) = pty_io::lookup_window(window.label())?;
    let control = controls.lock().unwrap_or_else(|e| e.into_inner());
    if control.closed {
        return Err("SSH PTY session is closed".into());
    }
    control.view.read(window.label(), &id, cursor)
}

#[tauri::command]
pub fn ssh_detached_ready(
    app: AppHandle,
    window: WebviewWindow,
    owner_epoch: u64,
    cursor: u64,
) -> Result<ViewStatus, String> {
    let (id, controls) = pty_io::lookup_window(window.label())?;
    let mut control = controls.lock().unwrap_or_else(|e| e.into_inner());
    if control.closed {
        return Err("SSH PTY session is closed".into());
    }
    let status = control.view.ready(window.label(), owner_epoch, cursor)?;
    notify(&app, &id, status.clone());
    Ok(status)
}

#[tauri::command]
pub fn ssh_attach_pty(
    app: AppHandle,
    window: WebviewWindow,
    owner_epoch: u64,
) -> Result<(), String> {
    if !restore(&app, window.label(), owner_epoch) {
        return Err("PTY handoff is stale or session is closed".into());
    }
    // Destroy only after the IPC response can be delivered. The main view
    // remains mounted and receives ordered frames while detached.
    let label = window.label().to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        destroy_view(&app, &label);
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
    });
    Ok(())
}

#[tauri::command]
pub fn ssh_pty_view_status(
    window: WebviewWindow,
    session_id: String,
) -> Result<ViewStatus, String> {
    if window.label() != "main" {
        return Err("PTY view access denied".into());
    }
    let controls = pty_io::lookup(&session_id)?;
    let control = controls.lock().unwrap_or_else(|e| e.into_inner());
    Ok(control.view.status())
}

#[tauri::command]
pub fn ssh_focus_detached(
    app: AppHandle,
    window: WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("PTY view access denied".into());
    }
    let controls = pty_io::lookup(&session_id)?;
    let label = {
        let control = controls.lock().unwrap_or_else(|e| e.into_inner());
        control.view.status().label.ok_or("PTY is not detached")?
    };
    let detached = app
        .get_webview_window(&label)
        .ok_or("Detached window is unavailable")?;
    detached.unminimize().map_err(|e| e.to_string())?;
    detached.show().map_err(|e| e.to_string())?;
    detached.set_focus().map_err(|e| e.to_string())
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    let label = window.label();
    let app = window.app_handle();
    if label == "main" {
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            pty_io::close_all();
        }
        if matches!(event, WindowEvent::Destroyed) {
            app.exit(0);
        }
        return;
    }
    if !label.starts_with("terminal-") {
        return;
    }
    let Ok((id, controls)) = pty_io::lookup_window(label) else {
        return;
    };
    let mut control = controls.lock().unwrap_or_else(|e| e.into_inner());
    let status = control.view.status();
    if status.label.as_deref() != Some(label) {
        return;
    }
    match event {
        WindowEvent::CloseRequested { api, .. } if status.phase == "detached" => {
            api.prevent_close();
            if status.attach_requested {
                return;
            }
            if let Ok(requested) = control.view.request_attach(label) {
                notify(app, &id, requested);
                let app = app.clone();
                let label = label.to_string();
                let epoch = status.epoch;
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(HANDOFF_TIMEOUT).await;
                    if restore(&app, &label, epoch) {
                        destroy_view(&app, &label);
                    }
                });
            }
        }
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
            if let Ok(restored) = control.view.return_to_main(label, Some(status.epoch)) {
                notify(app, &id, restored);
            }
        }
        _ => {}
    }
}

pub(super) fn close_detached_view(app: &AppHandle, label: Option<String>) {
    if let Some(label) = label {
        destroy_view(app, &label);
    }
}
