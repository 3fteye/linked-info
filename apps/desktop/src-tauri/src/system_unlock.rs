use std::sync::Arc;

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
        cfg!(any(windows, target_os = "macos", target_os = "linux"))
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
