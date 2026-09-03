use std::sync::{Arc, Mutex};

use linked_info_capture_inbox::{CaptureRecord, CaptureSummary, Inbox, InboxError};
use tauri::{AppHandle, Emitter, Manager, State};

const CAPTURE_LABEL: &str = "capture";

struct CaptureInbox(Arc<Mutex<Inbox>>);

async fn with_inbox<T: Send + 'static>(
    state: State<'_, CaptureInbox>,
    operation: impl FnOnce(&mut Inbox) -> Result<T, InboxError> + Send + 'static,
) -> Result<T, String> {
    let inbox = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let mut inbox = inbox.lock().map_err(|_| "capture_io".to_owned())?;
        operation(&mut inbox).map_err(|error| error.code().to_owned())
    })
    .await
    .map_err(|_| "capture_io".to_owned())?
}

#[tauri::command]
async fn capture_list(state: State<'_, CaptureInbox>) -> Result<Vec<CaptureSummary>, String> {
    with_inbox(state, |inbox| inbox.list()).await
}

#[tauri::command]
async fn capture_get(
    state: State<'_, CaptureInbox>,
    id: String,
) -> Result<Option<CaptureRecord>, String> {
    with_inbox(state, move |inbox| inbox.get(&id)).await
}

#[tauri::command]
async fn capture_create(state: State<'_, CaptureInbox>) -> Result<CaptureRecord, String> {
    // Allocate an empty durable identity before the editor accepts text. A lost
    // creation response cannot duplicate or lose an already-confirmed body.
    with_inbox(state, |inbox| {
        inbox.create_draft(String::new(), String::new())
    })
    .await
}

#[tauri::command]
async fn capture_save(
    state: State<'_, CaptureInbox>,
    id: String,
    expected_revision: u64,
    name: String,
    content: String,
) -> Result<CaptureRecord, String> {
    with_inbox(state, move |inbox| {
        inbox.save_draft(&id, expected_revision, name, content)
    })
    .await
}

#[tauri::command]
async fn capture_submit(
    state: State<'_, CaptureInbox>,
    id: String,
    expected_revision: u64,
    captured_at_ms: u64,
    utc_offset_minutes: i32,
) -> Result<CaptureRecord, String> {
    with_inbox(state, move |inbox| {
        inbox.submit(&id, expected_revision, captured_at_ms, utc_offset_minutes)
    })
    .await
}

#[tauri::command]
fn capture_set_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    let (width, height) = if expanded {
        (420.0, 360.0)
    } else {
        (220.0, 56.0)
    };
    app.get_webview_window(CAPTURE_LABEL)
        .ok_or_else(|| "capture_window_unavailable".to_owned())?
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|_| "capture_window_unavailable".to_owned())
}

#[tauri::command]
fn capture_drag(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(CAPTURE_LABEL)
        .ok_or_else(|| "capture_window_unavailable".to_owned())?
        .start_dragging()
        .map_err(|_| "capture_window_unavailable".to_owned())
}

#[tauri::command]
fn capture_exit(app: AppHandle) {
    // The frontend flushes its own draft before requesting this exit. Nothing
    // here owns, starts, locks, or stops the main workspace process.
    app.exit(0);
}

fn command_allowed(window: &str, webview: &str, command: &str) -> bool {
    window == CAPTURE_LABEL
        && webview == CAPTURE_LABEL
        && matches!(
            command,
            "capture_list"
                | "capture_get"
                | "capture_create"
                | "capture_save"
                | "capture_submit"
                | "capture_set_expanded"
                | "capture_drag"
                | "capture_exit"
                | "plugin:event|listen"
                | "plugin:event|unlisten"
        )
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window(CAPTURE_LABEL) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    builder
        .setup(|app| {
            // This identifier's directory is separate from com.linkedinfo.desktop.
            let directory = app.path().app_data_dir()?;
            let inbox = Inbox::open(directory)?;
            app.manage(CaptureInbox(Arc::new(Mutex::new(inbox))));
            if let Some(window) = app.get_webview_window(CAPTURE_LABEL) {
                let handle = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = handle.emit("capture-close-requested", ());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(|invoke| {
            let webview = invoke.message.webview_ref();
            if !command_allowed(
                webview.window().label(),
                webview.label(),
                invoke.message.command(),
            ) {
                invoke.resolver.reject("capture_command_denied");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
                capture_list,
                capture_get,
                capture_create,
                capture_save,
                capture_submit,
                capture_set_expanded,
                capture_drag,
                capture_exit
            ];
            handler(invoke)
        })
        .run(tauri::generate_context!())
        .expect("capture_application_failed");
}

#[cfg(test)]
mod tests {
    use super::command_allowed;

    #[test]
    fn capture_only_accepts_its_bounded_commands_and_own_labels() {
        for command in ["capture_save", "capture_list", "capture_exit"] {
            assert!(command_allowed("capture", "capture", command));
            assert!(!command_allowed("main", "capture", command));
            assert!(!command_allowed("capture", "main", command));
        }
        for command in [
            "read_workspace_file",
            "unlock_workspace",
            "exit_application",
            "plugin:fs|read_text_file",
            "plugin:event|emit",
        ] {
            assert!(!command_allowed("capture", "capture", command));
        }
    }
}
