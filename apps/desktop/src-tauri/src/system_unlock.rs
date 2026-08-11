use std::sync::Arc;

#[cfg(windows)]
use tauri::{Manager, WindowExtWindows};

const KEYRING_SERVICE: &str = "com.linkedinfo.desktop.workspace-unlock";

pub trait SystemUnlockProvider: Send + Sync {
    fn provider_id(&self) -> &'static str;
    fn available(&self) -> bool;
    fn store(&self, credential_id: &str, secret: &[u8]) -> Result<(), String>;
    fn load(&self, credential_id: &str) -> Result<Vec<u8>, String>;
    fn delete(&self, credential_id: &str) -> Result<(), String>;
}

#[derive(Clone)]
pub struct SystemUnlockState {
    provider: Arc<dyn SystemUnlockProvider>,
}

impl SystemUnlockState {
    pub fn provider(&self) -> Arc<dyn SystemUnlockProvider> {
        Arc::clone(&self.provider)
    }

    #[cfg(test)]
    pub fn with_provider(provider: Arc<dyn SystemUnlockProvider>) -> Self {
        Self { provider }
    }
}

impl Default for SystemUnlockState {
    fn default() -> Self {
        Self {
            provider: Arc::new(KeyringSystemUnlockProvider),
        }
    }
}

struct KeyringSystemUnlockProvider;

impl KeyringSystemUnlockProvider {
    fn entry(credential_id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, credential_id)
            .map_err(|_| "system_unlock_unavailable".to_owned())
    }
}

impl SystemUnlockProvider for KeyringSystemUnlockProvider {
    fn provider_id(&self) -> &'static str {
        #[cfg(windows)]
        {
            return "windows-credential-manager";
        }
        #[cfg(target_os = "macos")]
        {
            return "macos-keychain";
        }
        #[cfg(target_os = "linux")]
        {
            return "linux-secret-service";
        }
        #[allow(unreachable_code)]
        "unsupported"
    }

    fn available(&self) -> bool {
        cfg!(windows)
    }

    fn store(&self, credential_id: &str, secret: &[u8]) -> Result<(), String> {
        if !self.available() {
            return Err("system_unlock_unavailable".to_owned());
        }
        Self::entry(credential_id)?
            .set_secret(secret)
            .map_err(|_| "system_unlock_store_failed".to_owned())
    }

    fn load(&self, credential_id: &str) -> Result<Vec<u8>, String> {
        if !self.available() {
            return Err("system_unlock_unavailable".to_owned());
        }
        Self::entry(credential_id)?.get_secret().map_err(|error| {
            if matches!(error, keyring::Error::NoEntry) {
                "system_unlock_credential_missing".to_owned()
            } else {
                "system_unlock_read_failed".to_owned()
            }
        })
    }

    fn delete(&self, credential_id: &str) -> Result<(), String> {
        if !self.available() {
            return Err("system_unlock_unavailable".to_owned());
        }
        match Self::entry(credential_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("system_unlock_delete_failed".to_owned()),
        }
    }
}

pub async fn verify_user_presence(app: &tauri::AppHandle, message: String) -> Result<(), String> {
    if message.trim().is_empty() || message.chars().count() > 200 {
        return Err("system_unlock_invalid_verification_message".to_owned());
    }

    #[cfg(windows)]
    {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "system_unlock_window_unavailable".to_owned())?;
        let hwnd = window
            .hwnd()
            .map_err(|_| "system_unlock_window_unavailable".to_owned())?;
        let hwnd_value = hwnd.0 as isize;
        return tauri::async_runtime::spawn_blocking(move || {
            windows_user_verification::verify(hwnd_value, &message)
        })
        .await
        .map_err(|_| "system_unlock_verification_failed".to_owned())?;
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        let _ = message;
        Err("system_unlock_verification_unavailable".to_owned())
    }
}

#[cfg(windows)]
mod windows_user_verification {
    use windows::{
        Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier},
        Win32::{
            Foundation::HWND,
            System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
        },
        core::{
            HSTRING, IInspectable, IInspectable_Vtbl, Interface, Result as WindowsResult, Type,
            factory,
        },
    };
    use windows_future::IAsyncOperation;

    windows::core::imp::define_interface!(
        IUserConsentVerifierInterop,
        IUserConsentVerifierInterop_Vtbl,
        0x39e050c3_4e74_441a_8dc0_b81104df949c
    );
    windows::core::imp::interface_hierarchy!(IUserConsentVerifierInterop, IInspectable);

    impl IUserConsentVerifierInterop {
        unsafe fn request_verification_for_window_async(
            &self,
            hwnd: HWND,
            message: &HSTRING,
        ) -> WindowsResult<IAsyncOperation<UserConsentVerificationResult>> {
            unsafe {
                let mut operation = core::mem::zeroed();
                (Interface::vtable(self).RequestVerificationForWindowAsync)(
                    Interface::as_raw(self),
                    hwnd,
                    core::mem::transmute_copy(message),
                    &<IAsyncOperation<UserConsentVerificationResult> as Interface>::IID,
                    &mut operation,
                )
                .and_then(|| Type::from_abi(operation))
            }
        }
    }

    #[repr(C)]
    struct IUserConsentVerifierInterop_Vtbl {
        base__: IInspectable_Vtbl,
        RequestVerificationForWindowAsync: unsafe extern "system" fn(
            *mut core::ffi::c_void,
            HWND,
            *mut core::ffi::c_void,
            *const windows::core::GUID,
            *mut *mut core::ffi::c_void,
        )
            -> windows::core::HRESULT,
    }

    pub fn verify(hwnd_value: isize, message: &str) -> Result<(), String> {
        let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
        let result = verify_inner(HWND(hwnd_value as *mut core::ffi::c_void), message);
        if initialized {
            unsafe { RoUninitialize() };
        }
        result
    }

    fn verify_inner(hwnd: HWND, message: &str) -> Result<(), String> {
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
            .map_err(|_| "system_unlock_verification_unavailable".to_owned())?;
        let operation =
            unsafe { interop.request_verification_for_window_async(hwnd, &HSTRING::from(message)) }
                .map_err(|_| "system_unlock_verification_failed".to_owned())?;
        let result = operation
            .get()
            .map_err(|_| "system_unlock_verification_failed".to_owned())?;
        match result {
            UserConsentVerificationResult::Verified => Ok(()),
            UserConsentVerificationResult::Canceled => {
                Err("system_unlock_verification_cancelled".to_owned())
            }
            UserConsentVerificationResult::NotConfiguredForUser => {
                Err("system_unlock_verification_not_configured".to_owned())
            }
            UserConsentVerificationResult::DeviceNotPresent => {
                Err("system_unlock_verification_unavailable".to_owned())
            }
            UserConsentVerificationResult::DisabledByPolicy => {
                Err("system_unlock_verification_disabled".to_owned())
            }
            UserConsentVerificationResult::DeviceBusy => {
                Err("system_unlock_verification_busy".to_owned())
            }
            UserConsentVerificationResult::RetriesExhausted => {
                Err("system_unlock_verification_retries_exhausted".to_owned())
            }
            _ => Err("system_unlock_verification_failed".to_owned()),
        }
    }
}
