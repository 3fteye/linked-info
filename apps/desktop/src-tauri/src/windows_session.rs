use tauri::Manager;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::RemoteDesktop::{
        NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
    },
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            PBT_APMSUSPEND, WM_NCDESTROY, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE,
            WTS_CONSOLE_DISCONNECT, WTS_REMOTE_DISCONNECT, WTS_SESSION_LOCK, WTS_SESSION_LOGOFF,
        },
    },
};

const SESSION_SUBCLASS_ID: usize = 0x4c49_5345_4355_5249;

struct SessionNotificationContext {
    app: tauri::AppHandle,
}

unsafe extern "system" fn session_notification_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    context: usize,
) -> LRESULT {
    let reason = if message == WM_POWERBROADCAST && wparam == PBT_APMSUSPEND as usize {
        Some("windows_suspend")
    } else if message == WM_WTSSESSION_CHANGE {
        match wparam as u32 {
            WTS_SESSION_LOCK => Some("windows_session_lock"),
            WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT | WTS_SESSION_LOGOFF => {
                Some("windows_session_disconnect")
            }
            _ => None,
        }
    } else {
        None
    };

    if let Some(reason) = reason {
        // The authorization generation is revoked synchronously. Model cleanup is allowed to
        // finish on the async runtime, so a slow child process cannot hold up system suspend.
        let app = unsafe { &*(context as *const SessionNotificationContext) }
            .app
            .clone();
        let was_unlocked = crate::workspace_file::revoke_workspace_access(&app, reason);
        if was_unlocked {
            tauri::async_runtime::spawn(async move {
                crate::workspace_file::cleanup_locked_workspace(&app);
            });
        }
    }

    if message == WM_NCDESTROY {
        unsafe {
            let _ = WTSUnRegisterSessionNotification(hwnd);
            let _ = RemoveWindowSubclass(hwnd, Some(session_notification_proc), subclass_id);
            drop(Box::from_raw(context as *mut SessionNotificationContext));
        }
    }

    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

pub fn register(app: &tauri::App) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable for session notifications".to_owned())?;
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("cannot resolve the main window handle: {error}"))?
        .0;
    let context = Box::into_raw(Box::new(SessionNotificationContext {
        app: app.handle().clone(),
    }));

    let subclassed = unsafe {
        SetWindowSubclass(
            hwnd,
            Some(session_notification_proc),
            SESSION_SUBCLASS_ID,
            context as usize,
        )
    };
    if subclassed == 0 {
        unsafe { drop(Box::from_raw(context)) };
        return Err(format!(
            "cannot install Windows session notification handler: {}",
            std::io::Error::last_os_error()
        ));
    }

    let registered = unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) };
    if registered == 0 {
        unsafe {
            let _ =
                RemoveWindowSubclass(hwnd, Some(session_notification_proc), SESSION_SUBCLASS_ID);
            drop(Box::from_raw(context));
        }
        return Err(format!(
            "cannot register Windows session notifications: {}",
            std::io::Error::last_os_error()
        ));
    }

    Ok(())
}
