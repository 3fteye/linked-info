use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::workspace_file::{
    WorkspaceVaultState, begin_workspace_access, ensure_access_generation, ensure_workspace_access,
};

const SECRET_CLIPBOARD_CLEAR_AFTER_MILLISECONDS: u64 = 45_000;
const MAXIMUM_SECRET_CLIPBOARD_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretClipboardStatus {
    available: bool,
    clear_after_ms: u64,
}

#[derive(Default)]
pub struct SecretClipboardState {
    active_sequence: Arc<Mutex<Option<u32>>>,
    operation_lock: Arc<Mutex<()>>,
}

impl SecretClipboardState {
    fn sequence_handle(&self) -> Arc<Mutex<Option<u32>>> {
        Arc::clone(&self.active_sequence)
    }

    fn operation_lock(&self) -> Arc<Mutex<()>> {
        Arc::clone(&self.operation_lock)
    }
}

#[tauri::command]
pub fn inspect_secret_clipboard() -> SecretClipboardStatus {
    SecretClipboardStatus {
        available: platform::available(),
        clear_after_ms: SECRET_CLIPBOARD_CLEAR_AFTER_MILLISECONDS,
    }
}

#[tauri::command]
pub async fn copy_secret_to_clipboard(
    app: AppHandle,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    clipboard_state: tauri::State<'_, SecretClipboardState>,
    text: String,
) -> Result<SecretClipboardStatus, String> {
    validate_secret_text(&text)?;
    if !platform::available() {
        return Err("secret_clipboard_unavailable".to_owned());
    }
    let permit = begin_workspace_access(&app, &vault_state)?
        .ok_or_else(|| "secret_clipboard_requires_encryption".to_owned())?;
    let access_generation = vault_state.access_generation();
    let active_sequence = clipboard_state.sequence_handle();
    let operation_lock = clipboard_state.operation_lock();
    let text = Zeroizing::new(text);
    let sequence = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "secret_clipboard_state_unavailable".to_owned())?;
        ensure_access_generation(&access_generation, Some(permit))?;
        let sequence = platform::write_text(&text)?;
        let set_result = active_sequence
            .lock()
            .map_err(|_| "secret_clipboard_state_unavailable".to_owned())
            .map(|mut active| *active = Some(sequence));
        if let Err(error) = set_result {
            let _ = platform::clear_if_unchanged(sequence);
            return Err(error);
        }
        Ok(sequence)
    })
    .await
    .map_err(|error| error.to_string())??;

    if let Err(error) = ensure_workspace_access(&app, &vault_state, Some(permit)) {
        let clear_result =
            tauri::async_runtime::spawn_blocking(move || platform::clear_if_unchanged(sequence))
                .await;
        let active_sequence = clipboard_state.sequence_handle();
        if matches!(clear_result, Ok(Ok(_))) {
            forget_sequence(&active_sequence, sequence);
        } else {
            schedule_clear_after(active_sequence, sequence, Duration::ZERO);
        }
        return Err(error);
    }

    schedule_clear(clipboard_state.sequence_handle(), sequence);
    Ok(inspect_secret_clipboard())
}

pub fn clear_active(app: &AppHandle) {
    let state = app.state::<SecretClipboardState>();
    let Ok(active) = state.active_sequence.lock() else {
        return;
    };
    let Some(sequence) = *active else {
        return;
    };
    drop(active);
    if platform::clear_if_unchanged(sequence).is_ok()
        && let Ok(mut active) = state.active_sequence.lock()
        && *active == Some(sequence)
    {
        *active = None;
    }
}

fn validate_secret_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("secret_clipboard_empty".to_owned());
    }
    if text.len() > MAXIMUM_SECRET_CLIPBOARD_BYTES {
        return Err("secret_clipboard_too_large".to_owned());
    }
    if text.contains('\0') {
        return Err("secret_clipboard_contains_null".to_owned());
    }
    Ok(())
}

fn schedule_clear(active_sequence: Arc<Mutex<Option<u32>>>, sequence: u32) {
    schedule_clear_after(
        active_sequence,
        sequence,
        Duration::from_millis(SECRET_CLIPBOARD_CLEAR_AFTER_MILLISECONDS),
    );
}

fn schedule_clear_after(active_sequence: Arc<Mutex<Option<u32>>>, sequence: u32, delay: Duration) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        for attempt in 0..5 {
            let is_active = active_sequence
                .lock()
                .map(|active| *active == Some(sequence))
                .unwrap_or(false);
            if !is_active {
                return;
            }
            let result = tauri::async_runtime::spawn_blocking(move || {
                platform::clear_if_unchanged(sequence)
            })
            .await;
            match result {
                Ok(Ok(_)) => break,
                _ if attempt < 4 => tokio::time::sleep(Duration::from_secs(1)).await,
                _ => return,
            }
        }
        forget_sequence(&active_sequence, sequence);
    });
}

fn forget_sequence(active_sequence: &Mutex<Option<u32>>, sequence: u32) {
    if let Ok(mut active) = active_sequence.lock()
        && *active == Some(sequence)
    {
        *active = None;
    }
}

#[cfg(windows)]
mod platform {
    use std::ptr::null_mut;
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{GlobalFree, HGLOBAL};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock,
    };
    use zeroize::Zeroizing;

    const CF_UNICODETEXT: u32 = 13;

    struct ClipboardGuard;

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    struct OwnedGlobalMemory(HGLOBAL);

    impl OwnedGlobalMemory {
        fn release(&mut self) {
            self.0 = null_mut();
        }
    }

    impl Drop for OwnedGlobalMemory {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    GlobalFree(self.0);
                }
            }
        }
    }

    pub fn available() -> bool {
        true
    }

    pub fn write_text(text: &str) -> Result<u32, String> {
        let utf16 = Zeroizing::new(
            text.encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>(),
        );
        let byte_count = utf16
            .len()
            .checked_mul(std::mem::size_of::<u16>())
            .ok_or_else(|| "secret_clipboard_too_large".to_owned())?;
        let mut memory = OwnedGlobalMemory(unsafe { GlobalAlloc(GMEM_MOVEABLE, byte_count) });
        if memory.0.is_null() {
            return Err("secret_clipboard_allocation_failed".to_owned());
        }
        let destination = unsafe { GlobalLock(memory.0) }.cast::<u16>();
        if destination.is_null() {
            return Err("secret_clipboard_allocation_failed".to_owned());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(utf16.as_ptr(), destination, utf16.len());
            GlobalUnlock(memory.0);
        }

        let _clipboard = open_clipboard()?;
        if unsafe { EmptyClipboard() } == 0 {
            return Err("secret_clipboard_write_failed".to_owned());
        }
        if unsafe { SetClipboardData(CF_UNICODETEXT, memory.0) }.is_null() {
            return Err("secret_clipboard_write_failed".to_owned());
        }
        memory.release();
        let sequence = unsafe { GetClipboardSequenceNumber() };
        if sequence == 0 {
            return Err("secret_clipboard_sequence_unavailable".to_owned());
        }
        Ok(sequence)
    }

    pub fn clear_if_unchanged(expected_sequence: u32) -> Result<bool, String> {
        if unsafe { GetClipboardSequenceNumber() } != expected_sequence {
            return Ok(false);
        }
        let _clipboard = open_clipboard()?;
        if unsafe { GetClipboardSequenceNumber() } != expected_sequence {
            return Ok(false);
        }
        if unsafe { EmptyClipboard() } == 0 {
            return Err("secret_clipboard_clear_failed".to_owned());
        }
        Ok(true)
    }

    fn open_clipboard() -> Result<ClipboardGuard, String> {
        for _ in 0..10 {
            if unsafe { OpenClipboard(null_mut()) } != 0 {
                return Ok(ClipboardGuard);
            }
            thread::sleep(Duration::from_millis(25));
        }
        Err("secret_clipboard_busy".to_owned())
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn available() -> bool {
        false
    }

    pub fn write_text(_text: &str) -> Result<u32, String> {
        Err("secret_clipboard_unavailable".to_owned())
    }

    pub fn clear_if_unchanged(_expected_sequence: u32) -> Result<bool, String> {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_clipboard_rejects_empty_oversized_and_null_text() {
        assert_eq!(
            validate_secret_text("").unwrap_err(),
            "secret_clipboard_empty"
        );
        assert_eq!(
            validate_secret_text(&"x".repeat(MAXIMUM_SECRET_CLIPBOARD_BYTES + 1)).unwrap_err(),
            "secret_clipboard_too_large"
        );
        assert_eq!(
            validate_secret_text("prefix\0suffix").unwrap_err(),
            "secret_clipboard_contains_null"
        );
        assert!(validate_secret_text("JBSWY3DPEHPK3PXP").is_ok());
    }
}
