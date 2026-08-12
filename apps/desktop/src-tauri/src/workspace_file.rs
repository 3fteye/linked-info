use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, Zeroizing};

use crate::system_unlock::{SystemUnlockProvider, SystemUnlockState};

#[cfg(unix)]
use std::fs::File;

const PRIMARY_FILE_NAME: &str = "workspace.v1.json";
const RECOVERY_FILE_NAME: &str = "workspace.recovery.v1.json";
const VAULT_FILE_NAME: &str = "workspace.vault.v1.json";
const VAULT_PENDING_FILE_NAME: &str = ".workspace.vault.v1.pending.json";
const BACKUP_DIRECTORY_NAME: &str = "workspace.backups.v1";
const BACKUP_PENDING_DIRECTORY_NAME: &str = ".workspace.backups.v1.pending";
const ENCRYPTED_WORKSPACE_FORMAT: &str = "linked-info-encrypted-workspace";
const ENCRYPTED_EXPORT_FORMAT: &str = "linked-info-encrypted-workspace-export";
const VAULT_FORMAT: &str = "linked-info-workspace-vault";
const CRYPTO_VERSION: u32 = 1;
const DATA_KEY_BYTES: usize = 32;
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const MINIMUM_PASSWORD_CHARACTERS: usize = 10;
const MAXIMUM_PASSWORD_BYTES: usize = 1_024;
const BACKUP_INTERVAL_MILLISECONDS: u64 = 60 * 60 * 1_000;
const BACKUP_MAXIMUM_COUNT: usize = 30;
const BACKUP_MAXIMUM_BYTES: u64 = 512 * 1024 * 1024;
#[cfg(not(test))]
const ARGON2_MEMORY_KIB: u32 = 64 * 1_024;
#[cfg(test)]
const ARGON2_MEMORY_KIB: u32 = 8 * 1_024;
#[cfg(not(test))]
const ARGON2_ITERATIONS: u32 = 3;
#[cfg(test)]
const ARGON2_ITERATIONS: u32 = 1;
const ARGON2_PARALLELISM: u32 = 1;
const VAULT_KEY_AAD: &[u8] = b"linked-info-workspace-vault-key-v1";
const SYSTEM_UNLOCK_KEY_AAD_PREFIX: &[u8] = b"linked-info-system-unlock-v1\0";
const EXPORT_PAYLOAD_AAD: &[u8] = b"linked-info-workspace-export-v1";
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceFileSlot {
    Primary,
    Recovery,
}

impl WorkspaceFileSlot {
    fn file_name(self) -> &'static str {
        match self {
            Self::Primary => PRIMARY_FILE_NAME,
            Self::Recovery => RECOVERY_FILE_NAME,
        }
    }

    fn pending_file_name(self) -> String {
        format!(".{}.vault.pending", self.file_name())
    }

    fn aad(self) -> &'static [u8] {
        match self {
            Self::Primary => b"linked-info-workspace-primary-v1",
            Self::Recovery => b"linked-info-workspace-recovery-v1",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KdfEnvelope {
    algorithm: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CipherEnvelope {
    algorithm: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultMetadata {
    format: String,
    version: u32,
    kdf: KdfEnvelope,
    wrapped_data_key: CipherEnvelope,
    migrated_slots: Vec<WorkspaceFileSlot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    system_unlock: Option<SystemUnlockEnvelope>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemUnlockEnvelope {
    provider: String,
    credential_id: String,
    wrapped_data_key: CipherEnvelope,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedWorkspaceEnvelope {
    format: String,
    version: u32,
    slot: WorkspaceFileSlot,
    payload: CipherEnvelope,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedExportEnvelope {
    format: String,
    version: u32,
    kdf: KdfEnvelope,
    wrapped_data_key: CipherEnvelope,
    payload: CipherEnvelope,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSecurityStatus {
    encrypted: bool,
    locked: bool,
    system_unlock_available: bool,
    system_unlock_enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceBackupState {
    Ready,
    Invalid,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackupEntry {
    id: String,
    created_at_ms: u64,
    size_bytes: u64,
    state: WorkspaceBackupState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackupHistoryStatus {
    entries: Vec<WorkspaceBackupEntry>,
    total_bytes: u64,
    maximum_count: usize,
    maximum_bytes: u64,
    interval_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackupCaptureResult {
    created: bool,
    status: WorkspaceBackupHistoryStatus,
}

#[derive(Default)]
pub struct WorkspaceVaultState {
    data_key: Arc<Mutex<Option<Zeroizing<[u8; DATA_KEY_BYTES]>>>>,
    operation_lock: Arc<Mutex<()>>,
}

impl WorkspaceVaultState {
    fn data_key(&self) -> Result<Zeroizing<[u8; DATA_KEY_BYTES]>, String> {
        self.data_key
            .lock()
            .map_err(|_| "workspace_vault_state_unavailable".to_owned())?
            .as_ref()
            .map(|key| Zeroizing::new(**key))
            .ok_or_else(|| "workspace_vault_locked".to_owned())
    }

    fn replace_data_key(&self, key: [u8; DATA_KEY_BYTES]) -> Result<(), String> {
        let mut slot = self
            .data_key
            .lock()
            .map_err(|_| "workspace_vault_state_unavailable".to_owned())?;
        *slot = Some(Zeroizing::new(key));
        Ok(())
    }

    fn optional_data_key(&self) -> Result<Option<Zeroizing<[u8; DATA_KEY_BYTES]>>, String> {
        self.data_key
            .lock()
            .map_err(|_| "workspace_vault_state_unavailable".to_owned())
            .map(|slot| slot.as_ref().map(|key| Zeroizing::new(**key)))
    }

    fn clear_data_key(&self) -> Result<(), String> {
        let mut slot = self
            .data_key
            .lock()
            .map_err(|_| "workspace_vault_state_unavailable".to_owned())?;
        *slot = None;
        Ok(())
    }

    fn is_unlocked(&self) -> Result<bool, String> {
        self.data_key
            .lock()
            .map(|slot| slot.is_some())
            .map_err(|_| "workspace_vault_state_unavailable".to_owned())
    }

    pub fn shutdown(&self) {
        let _ = self.clear_data_key();
    }
}

struct WorkspaceFileStore {
    base_directory: PathBuf,
}

impl WorkspaceFileStore {
    fn new(base_directory: PathBuf) -> Self {
        Self { base_directory }
    }

    fn path(&self, slot: WorkspaceFileSlot) -> PathBuf {
        self.base_directory.join(slot.file_name())
    }

    fn pending_path(&self, slot: WorkspaceFileSlot) -> PathBuf {
        self.base_directory.join(slot.pending_file_name())
    }

    fn vault_path(&self) -> PathBuf {
        self.base_directory.join(VAULT_FILE_NAME)
    }

    fn pending_vault_path(&self) -> PathBuf {
        self.base_directory.join(VAULT_PENDING_FILE_NAME)
    }

    fn backup_directory(&self) -> PathBuf {
        self.base_directory.join(BACKUP_DIRECTORY_NAME)
    }

    fn pending_backup_directory(&self) -> PathBuf {
        self.base_directory.join(BACKUP_PENDING_DIRECTORY_NAME)
    }

    fn backup_path(&self, id: &str) -> Result<PathBuf, String> {
        parse_backup_id(id)?;
        Ok(self.backup_directory().join(format!("{id}.json")))
    }

    fn read_text_path(path: &Path) -> io::Result<Option<String>> {
        match fs::read_to_string(path) {
            Ok(contents) => Ok(Some(contents)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn read_plaintext(&self, slot: WorkspaceFileSlot) -> io::Result<Option<String>> {
        Self::read_text_path(&self.path(slot))
    }

    fn read(
        &self,
        slot: WorkspaceFileSlot,
        data_key: Option<&[u8; DATA_KEY_BYTES]>,
    ) -> Result<Option<String>, String> {
        let Some(contents) = Self::read_text_path(&self.path(slot)).map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        match data_key {
            Some(key) => decrypt_workspace_file(&contents, slot, key).map(Some),
            None => Ok(Some(contents)),
        }
    }

    fn write_plaintext(&self, slot: WorkspaceFileSlot, contents: &str) -> io::Result<()> {
        validate_storage_envelope(contents)?;
        fs::create_dir_all(&self.base_directory)?;
        write_atomically(&self.path(slot), contents.as_bytes())
    }

    fn write(
        &self,
        slot: WorkspaceFileSlot,
        contents: &str,
        data_key: Option<&[u8; DATA_KEY_BYTES]>,
    ) -> Result<(), String> {
        validate_storage_envelope(contents).map_err(|error| error.to_string())?;
        fs::create_dir_all(&self.base_directory).map_err(|error| error.to_string())?;
        let serialized = match data_key {
            Some(key) => encrypt_workspace_file(contents, slot, key)?,
            None => contents.to_owned(),
        };
        write_atomically(&self.path(slot), serialized.as_bytes()).map_err(|e| e.to_string())
    }

    fn read_vault_metadata(&self) -> Result<Option<VaultMetadata>, String> {
        let Some(contents) = Self::read_text_path(&self.vault_path()).map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        parse_vault_metadata(&contents).map(Some)
    }

    fn encryption_configured(&self) -> bool {
        self.vault_path().is_file()
    }

    fn backup_files(&self) -> Result<Vec<BackupFile>, String> {
        let directory = self.backup_directory();
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        let mut backups = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if !file_type.is_file() {
                continue;
            }
            let Some(file_name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(id) = file_name.strip_suffix(".json") else {
                continue;
            };
            let Ok(created_at_ms) = parse_backup_id(id) else {
                continue;
            };
            let size_bytes = entry.metadata().map_err(|error| error.to_string())?.len();
            backups.push(BackupFile {
                id: id.to_owned(),
                created_at_ms,
                size_bytes,
                path: entry.path(),
            });
        }
        backups.sort_by(|left, right| {
            right
                .created_at_ms
                .cmp(&left.created_at_ms)
                .then_with(|| right.id.cmp(&left.id))
        });
        Ok(backups)
    }
}

#[derive(Clone, Debug)]
struct BackupFile {
    id: String,
    created_at_ms: u64,
    size_bytes: u64,
    path: PathBuf,
}

#[tauri::command]
pub async fn read_workspace_file(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    slot: WorkspaceFileSlot,
) -> Result<Option<String>, String> {
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let data_key = state.optional_data_key()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let active_key = match store.encryption_configured() {
            true => Some(
                data_key
                    .as_deref()
                    .ok_or_else(|| "workspace_vault_locked".to_owned())?,
            ),
            false => None,
        };
        store.read(slot, active_key)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn write_workspace_file(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    slot: WorkspaceFileSlot,
    contents: String,
) -> Result<(), String> {
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let data_key = state.optional_data_key()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let active_key = match store.encryption_configured() {
            true => Some(
                data_key
                    .as_deref()
                    .ok_or_else(|| "workspace_vault_locked".to_owned())?,
            ),
            false => None,
        };
        store.write(slot, &contents, active_key)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn inspect_workspace_backup_history(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
) -> Result<WorkspaceBackupHistoryStatus, String> {
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let data_key = state.optional_data_key()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let active_key = active_workspace_key(&store, data_key.as_deref())?;
        inspect_backup_history(&store, active_key)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn capture_workspace_backup(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
) -> Result<WorkspaceBackupCaptureResult, String> {
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let data_key = state.optional_data_key()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let active_key = active_workspace_key(&store, data_key.as_deref())?;
        capture_workspace_backup_at(&store, active_key, current_time_milliseconds()?)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_workspace_backup(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    id: String,
) -> Result<String, String> {
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let data_key = state.optional_data_key()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let active_key = active_workspace_key(&store, data_key.as_deref())?;
        read_backup_contents(&store, &id, active_key)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn inspect_workspace_security(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
) -> Result<WorkspaceSecurityStatus, String> {
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let provider = system_unlock_state.provider();
    let metadata = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        store.read_vault_metadata()
    })
    .await
    .map_err(|error| error.to_string())??;
    let encrypted = metadata.is_some();
    Ok(WorkspaceSecurityStatus {
        encrypted,
        locked: encrypted && !state.is_unlocked()?,
        system_unlock_available: provider.available(),
        system_unlock_enabled: system_unlock_enabled(metadata.as_ref(), provider.as_ref()),
    })
}

#[tauri::command]
pub async fn unlock_workspace(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    password: String,
) -> Result<WorkspaceSecurityStatus, String> {
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let password = Zeroizing::new(password);
    let provider = system_unlock_state.provider();
    let provider_for_unlock = Arc::clone(&provider);
    let (data_key, system_unlock_enabled) = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let metadata = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        let data_key = unwrap_data_key(&metadata, &password)?;
        verify_encrypted_store(&store, &data_key)?;
        let system_unlock_enabled =
            system_unlock_enabled(Some(&metadata), provider_for_unlock.as_ref());
        Ok::<([u8; DATA_KEY_BYTES], bool), String>((data_key, system_unlock_enabled))
    })
    .await
    .map_err(|error| error.to_string())??;
    state.replace_data_key(data_key)?;
    Ok(WorkspaceSecurityStatus {
        encrypted: true,
        locked: false,
        system_unlock_available: provider.available(),
        system_unlock_enabled,
    })
}

#[tauri::command]
pub async fn unlock_workspace_with_system(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    message: String,
) -> Result<WorkspaceSecurityStatus, String> {
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let provider = system_unlock_state.provider();
    if !provider.available() {
        return Err("system_unlock_unavailable".to_owned());
    }
    crate::system_unlock::verify_user_presence(&app, message).await?;
    let provider_for_unlock = Arc::clone(&provider);
    let data_key = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let metadata = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        let data_key = unwrap_data_key_with_system(&metadata, provider_for_unlock.as_ref())?;
        verify_encrypted_store(&store, &data_key)?;
        Ok::<[u8; DATA_KEY_BYTES], String>(data_key)
    })
    .await
    .map_err(|error| error.to_string())??;
    state.replace_data_key(data_key)?;
    Ok(WorkspaceSecurityStatus {
        encrypted: true,
        locked: false,
        system_unlock_available: true,
        system_unlock_enabled: true,
    })
}

#[tauri::command]
pub async fn enable_workspace_encryption(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    vector_cache_state: tauri::State<'_, crate::vector_cache::VectorCacheState>,
    embedding_state: tauri::State<'_, crate::embedding::EmbeddingState>,
    llm_state: tauri::State<'_, crate::llm::LlmState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    password: String,
) -> Result<WorkspaceSecurityStatus, String> {
    validate_new_password(&password)?;
    crate::vector_cache::purge_for_encryption(&app, &vector_cache_state).await?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let password = Zeroizing::new(password);
    let data_key = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        if store.encryption_configured() {
            return Err("workspace_vault_already_configured".to_owned());
        }
        migrate_plaintext_store(&store, &password)
    })
    .await
    .map_err(|error| error.to_string())??;
    state.replace_data_key(data_key)?;
    crate::vector_cache::purge_for_encryption(&app, &vector_cache_state).await?;
    let _ = embedding_state.shutdown();
    llm_state.shutdown();
    Ok(WorkspaceSecurityStatus {
        encrypted: true,
        locked: false,
        system_unlock_available: system_unlock_state.provider().available(),
        system_unlock_enabled: false,
    })
}

#[tauri::command]
pub async fn change_workspace_password(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    password: String,
) -> Result<(), String> {
    validate_new_password(&password)?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let data_key = state.data_key()?;
    let password = Zeroizing::new(password);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let previous = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        let metadata = rewrap_vault_metadata(previous, &password, &data_key)?;
        let serialized = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
        write_atomically(&store.vault_path(), &serialized).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn enable_system_unlock(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    message: String,
) -> Result<WorkspaceSecurityStatus, String> {
    let provider = system_unlock_state.provider();
    if !provider.available() {
        return Err("system_unlock_unavailable".to_owned());
    }
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let data_key = state.data_key()?;
    crate::system_unlock::verify_user_presence(&app, message).await?;
    let provider_for_enable = Arc::clone(&provider);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let mut metadata = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        let previous = metadata.system_unlock.take();
        let device_key = Zeroizing::new(random_array::<DATA_KEY_BYTES>()?);
        let credential_id = uuid::Uuid::new_v4().to_string();
        provider_for_enable.store(&credential_id, device_key.as_slice())?;
        metadata.system_unlock = Some(create_system_unlock_envelope(
            provider_for_enable.provider_id(),
            &credential_id,
            &data_key,
            &device_key,
        )?);
        let write_result = serde_json::to_vec(&metadata)
            .map_err(|error| error.to_string())
            .and_then(|serialized| {
                write_atomically(&store.vault_path(), &serialized)
                    .map_err(|error| error.to_string())
            });
        if let Err(error) = write_result {
            let _ = provider_for_enable.delete(&credential_id);
            return Err(error);
        }
        if let Some(previous) = previous {
            if previous.provider == provider_for_enable.provider_id() {
                let _ = provider_for_enable.delete(&previous.credential_id);
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(WorkspaceSecurityStatus {
        encrypted: true,
        locked: false,
        system_unlock_available: true,
        system_unlock_enabled: true,
    })
}

#[tauri::command]
pub async fn disable_system_unlock(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
) -> Result<WorkspaceSecurityStatus, String> {
    let _ = state.data_key()?;
    let provider = system_unlock_state.provider();
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let provider_for_disable = Arc::clone(&provider);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let mut metadata = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        let previous = metadata.system_unlock.take();
        let serialized = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
        write_atomically(&store.vault_path(), &serialized).map_err(|error| error.to_string())?;
        if let Some(previous) = previous {
            if previous.provider == provider_for_disable.provider_id() {
                let _ = provider_for_disable.delete(&previous.credential_id);
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(WorkspaceSecurityStatus {
        encrypted: true,
        locked: false,
        system_unlock_available: provider.available(),
        system_unlock_enabled: false,
    })
}

#[tauri::command]
pub async fn lock_workspace(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    embedding_state: tauri::State<'_, crate::embedding::EmbeddingState>,
    llm_state: tauri::State<'_, crate::llm::LlmState>,
) -> Result<WorkspaceSecurityStatus, String> {
    let _ = embedding_state.shutdown();
    llm_state.shutdown();
    state.shutdown();
    inspect_workspace_security(app, state, system_unlock_state).await
}

#[tauri::command]
pub async fn encrypt_workspace_export(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    contents: String,
) -> Result<String, String> {
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let data_key = state.data_key()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        let metadata = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        encrypt_export(&contents, &metadata, &data_key)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn decrypt_workspace_export(
    contents: String,
    password: String,
) -> Result<String, String> {
    let password = Zeroizing::new(password);
    tauri::async_runtime::spawn_blocking(move || decrypt_export(&contents, &password))
        .await
        .map_err(|error| error.to_string())?
}

fn workspace_store(app: &AppHandle) -> io::Result<WorkspaceFileStore> {
    app.path()
        .app_data_dir()
        .map(WorkspaceFileStore::new)
        .map_err(io::Error::other)
}

pub fn workspace_encryption_configured(app: &AppHandle) -> bool {
    workspace_store(app)
        .map(|store| store.encryption_configured())
        .unwrap_or(false)
}

pub fn require_workspace_unlocked(
    app: &AppHandle,
    state: &WorkspaceVaultState,
) -> Result<(), String> {
    if workspace_encryption_configured(app) && !state.is_unlocked()? {
        return Err("workspace_vault_locked".to_owned());
    }
    Ok(())
}

fn validate_new_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MINIMUM_PASSWORD_CHARACTERS {
        return Err("workspace_vault_password_too_short".to_owned());
    }
    if password.len() > MAXIMUM_PASSWORD_BYTES {
        return Err("workspace_vault_password_too_long".to_owned());
    }
    Ok(())
}

fn validate_unlock_password(password: &str) -> Result<(), String> {
    if password.is_empty() || password.len() > MAXIMUM_PASSWORD_BYTES {
        return Err("workspace_vault_invalid_password".to_owned());
    }
    Ok(())
}

fn current_time_milliseconds() -> Result<u64, String> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "workspace_backup_system_time_invalid".to_owned())?
        .as_millis();
    u64::try_from(milliseconds).map_err(|_| "workspace_backup_system_time_invalid".to_owned())
}

fn parse_backup_id(id: &str) -> Result<u64, String> {
    if id.len() > 64 || id.as_bytes().contains(&0) {
        return Err("workspace_backup_invalid_id".to_owned());
    }
    let (timestamp, uuid) = id
        .split_once('-')
        .ok_or_else(|| "workspace_backup_invalid_id".to_owned())?;
    if timestamp.is_empty()
        || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
        || uuid::Uuid::parse_str(uuid).is_err()
    {
        return Err("workspace_backup_invalid_id".to_owned());
    }
    timestamp
        .parse::<u64>()
        .map_err(|_| "workspace_backup_invalid_id".to_owned())
}

fn active_workspace_key<'a>(
    store: &WorkspaceFileStore,
    data_key: Option<&'a [u8; DATA_KEY_BYTES]>,
) -> Result<Option<&'a [u8; DATA_KEY_BYTES]>, String> {
    match store.encryption_configured() {
        true => data_key
            .map(Some)
            .ok_or_else(|| "workspace_vault_locked".to_owned()),
        false => Ok(None),
    }
}

fn backup_plaintext(
    contents: &str,
    data_key: Option<&[u8; DATA_KEY_BYTES]>,
) -> Result<String, String> {
    match data_key {
        Some(key) => decrypt_workspace_file(contents, WorkspaceFileSlot::Primary, key),
        None => Ok(contents.to_owned()),
    }
}

fn inspect_backup_history(
    store: &WorkspaceFileStore,
    data_key: Option<&[u8; DATA_KEY_BYTES]>,
) -> Result<WorkspaceBackupHistoryStatus, String> {
    let files = store.backup_files()?;
    let mut entries = Vec::with_capacity(files.len());
    let mut total_bytes = 0_u64;
    for file in files {
        total_bytes = total_bytes.saturating_add(file.size_bytes);
        let state = WorkspaceFileStore::read_text_path(&file.path)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "workspace_backup_missing".to_owned())?
            .and_then(|contents| backup_plaintext(&contents, data_key))
            .and_then(|contents| {
                validate_storage_envelope(&contents).map_err(|error| error.to_string())
            })
            .map(|_| WorkspaceBackupState::Ready)
            .unwrap_or(WorkspaceBackupState::Invalid);
        entries.push(WorkspaceBackupEntry {
            id: file.id,
            created_at_ms: file.created_at_ms,
            size_bytes: file.size_bytes,
            state,
        });
    }
    Ok(WorkspaceBackupHistoryStatus {
        entries,
        total_bytes,
        maximum_count: BACKUP_MAXIMUM_COUNT,
        maximum_bytes: BACKUP_MAXIMUM_BYTES,
        interval_ms: BACKUP_INTERVAL_MILLISECONDS,
    })
}

fn capture_workspace_backup_at(
    store: &WorkspaceFileStore,
    data_key: Option<&[u8; DATA_KEY_BYTES]>,
    now_ms: u64,
) -> Result<WorkspaceBackupCaptureResult, String> {
    let primary = fs::read(store.path(WorkspaceFileSlot::Primary)).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            "workspace_backup_primary_missing".to_owned()
        } else {
            error.to_string()
        }
    })?;
    let existing = store.backup_files()?;
    if let Some(latest) = existing.first() {
        if now_ms.saturating_sub(latest.created_at_ms) < BACKUP_INTERVAL_MILLISECONDS {
            return Ok(WorkspaceBackupCaptureResult {
                created: false,
                status: inspect_backup_history(store, data_key)?,
            });
        }
        if fs::read(&latest.path).map_err(|error| error.to_string())? == primary {
            return Ok(WorkspaceBackupCaptureResult {
                created: false,
                status: inspect_backup_history(store, data_key)?,
            });
        }
    }

    fs::create_dir_all(store.backup_directory()).map_err(|error| error.to_string())?;
    let id = format!("{now_ms}-{}", uuid::Uuid::new_v4());
    let path = store.backup_path(&id)?;
    write_atomically(&path, &primary).map_err(|error| error.to_string())?;
    prune_workspace_backups(store)?;
    Ok(WorkspaceBackupCaptureResult {
        created: true,
        status: inspect_backup_history(store, data_key)?,
    })
}

fn prune_workspace_backups(store: &WorkspaceFileStore) -> Result<(), String> {
    let mut files = store.backup_files()?;
    let mut total_bytes = files.iter().map(|file| file.size_bytes).sum::<u64>();
    while files.len() > 1
        && (files.len() > BACKUP_MAXIMUM_COUNT || total_bytes > BACKUP_MAXIMUM_BYTES)
    {
        let oldest = files.pop().expect("backup list is known to be non-empty");
        fs::remove_file(&oldest.path).map_err(|error| error.to_string())?;
        total_bytes = total_bytes.saturating_sub(oldest.size_bytes);
    }
    if store.backup_directory().is_dir() {
        sync_parent_directory(&store.backup_directory()).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn read_backup_contents(
    store: &WorkspaceFileStore,
    id: &str,
    data_key: Option<&[u8; DATA_KEY_BYTES]>,
) -> Result<String, String> {
    let path = store.backup_path(id)?;
    let contents = WorkspaceFileStore::read_text_path(&path)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workspace_backup_missing".to_owned())?;
    let plaintext = backup_plaintext(&contents, data_key)?;
    validate_storage_envelope(&plaintext).map_err(|_| "workspace_backup_invalid".to_owned())?;
    Ok(plaintext)
}

fn random_array<const N: usize>() -> Result<[u8; N], String> {
    let mut value = [0_u8; N];
    getrandom::fill(&mut value)
        .map_err(|error| format!("workspace_vault_random_failed:{error}"))?;
    Ok(value)
}

fn encode_bytes(bytes: &[u8]) -> String {
    STANDARD_NO_PAD.encode(bytes)
}

fn decode_bytes(value: &str, field: &str) -> Result<Vec<u8>, String> {
    STANDARD_NO_PAD
        .decode(value)
        .map_err(|_| format!("workspace_vault_invalid_{field}"))
}

fn decode_fixed<const N: usize>(value: &str, field: &str) -> Result<[u8; N], String> {
    let decoded = decode_bytes(value, field)?;
    decoded
        .try_into()
        .map_err(|_| format!("workspace_vault_invalid_{field}"))
}

fn derive_password_key(
    password: &str,
    kdf: &KdfEnvelope,
) -> Result<Zeroizing<[u8; DATA_KEY_BYTES]>, String> {
    validate_unlock_password(password)?;
    validate_kdf_envelope(kdf)?;
    let salt = decode_fixed::<SALT_BYTES>(&kdf.salt, "salt")?;
    let params = Params::new(
        kdf.memory_kib,
        kdf.iterations,
        kdf.parallelism,
        Some(DATA_KEY_BYTES),
    )
    .map_err(|_| "workspace_vault_invalid_kdf".to_owned())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0_u8; DATA_KEY_BYTES]);
    argon2
        .hash_password_into(password.as_bytes(), &salt, &mut *key)
        .map_err(|_| "workspace_vault_key_derivation_failed".to_owned())?;
    Ok(key)
}

fn validate_kdf_envelope(kdf: &KdfEnvelope) -> Result<(), String> {
    if kdf.algorithm != "argon2id"
        || !(8 * 1_024..=256 * 1_024).contains(&kdf.memory_kib)
        || !(1..=10).contains(&kdf.iterations)
        || !(1..=16).contains(&kdf.parallelism)
    {
        return Err("workspace_vault_invalid_kdf".to_owned());
    }
    let _ = decode_fixed::<SALT_BYTES>(&kdf.salt, "salt")?;
    Params::new(
        kdf.memory_kib,
        kdf.iterations,
        kdf.parallelism,
        Some(DATA_KEY_BYTES),
    )
    .map_err(|_| "workspace_vault_invalid_kdf".to_owned())?;
    Ok(())
}

fn encrypt_bytes(
    plaintext: &[u8],
    key: &[u8; DATA_KEY_BYTES],
    aad: &[u8],
) -> Result<CipherEnvelope, String> {
    let nonce = random_array::<NONCE_BYTES>()?;
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "workspace_vault_invalid_key".to_owned())?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "workspace_vault_encryption_failed".to_owned())?;
    Ok(CipherEnvelope {
        algorithm: "xchacha20poly1305".to_owned(),
        nonce: encode_bytes(&nonce),
        ciphertext: encode_bytes(&ciphertext),
    })
}

fn decrypt_bytes(
    envelope: &CipherEnvelope,
    key: &[u8; DATA_KEY_BYTES],
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    if envelope.algorithm != "xchacha20poly1305" {
        return Err("workspace_vault_invalid_cipher".to_owned());
    }
    let nonce = decode_fixed::<NONCE_BYTES>(&envelope.nonce, "nonce")?;
    let ciphertext = decode_bytes(&envelope.ciphertext, "ciphertext")?;
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "workspace_vault_invalid_key".to_owned())?;
    cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| "workspace_vault_authentication_failed".to_owned())
}

fn create_vault_metadata(
    password: &str,
    data_key: &[u8; DATA_KEY_BYTES],
    migrated_slots: Vec<WorkspaceFileSlot>,
) -> Result<VaultMetadata, String> {
    validate_new_password(password)?;
    let salt = random_array::<SALT_BYTES>()?;
    let kdf = KdfEnvelope {
        algorithm: "argon2id".to_owned(),
        memory_kib: ARGON2_MEMORY_KIB,
        iterations: ARGON2_ITERATIONS,
        parallelism: ARGON2_PARALLELISM,
        salt: encode_bytes(&salt),
    };
    let wrapping_key = derive_password_key(password, &kdf)?;
    let wrapped_data_key = encrypt_bytes(data_key, &wrapping_key, VAULT_KEY_AAD)?;
    Ok(VaultMetadata {
        format: VAULT_FORMAT.to_owned(),
        version: CRYPTO_VERSION,
        kdf,
        wrapped_data_key,
        migrated_slots,
        system_unlock: None,
    })
}

fn rewrap_vault_metadata(
    previous: VaultMetadata,
    password: &str,
    data_key: &[u8; DATA_KEY_BYTES],
) -> Result<VaultMetadata, String> {
    let mut metadata = create_vault_metadata(password, data_key, previous.migrated_slots)?;
    metadata.system_unlock = previous.system_unlock;
    Ok(metadata)
}

fn create_system_unlock_envelope(
    provider: &str,
    credential_id: &str,
    data_key: &[u8; DATA_KEY_BYTES],
    device_key: &[u8; DATA_KEY_BYTES],
) -> Result<SystemUnlockEnvelope, String> {
    Ok(SystemUnlockEnvelope {
        provider: provider.to_owned(),
        credential_id: credential_id.to_owned(),
        wrapped_data_key: encrypt_bytes(
            data_key,
            device_key,
            &system_unlock_aad(provider, credential_id),
        )?,
    })
}

fn system_unlock_aad(provider: &str, credential_id: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(
        SYSTEM_UNLOCK_KEY_AAD_PREFIX.len() + provider.len() + credential_id.len() + 1,
    );
    aad.extend_from_slice(SYSTEM_UNLOCK_KEY_AAD_PREFIX);
    aad.extend_from_slice(provider.as_bytes());
    aad.push(0);
    aad.extend_from_slice(credential_id.as_bytes());
    aad
}

fn system_unlock_enabled(
    metadata: Option<&VaultMetadata>,
    provider: &dyn SystemUnlockProvider,
) -> bool {
    provider.available()
        && metadata
            .and_then(|metadata| metadata.system_unlock.as_ref())
            .is_some_and(|envelope| envelope.provider == provider.provider_id())
}

fn parse_vault_metadata(contents: &str) -> Result<VaultMetadata, String> {
    let metadata: VaultMetadata = serde_json::from_str(contents)
        .map_err(|_| "workspace_vault_invalid_metadata".to_owned())?;
    if metadata.format != VAULT_FORMAT || metadata.version != CRYPTO_VERSION {
        return Err("workspace_vault_unsupported_metadata".to_owned());
    }
    validate_kdf_envelope(&metadata.kdf)?;
    let _ = decode_fixed::<NONCE_BYTES>(&metadata.wrapped_data_key.nonce, "nonce")?;
    if metadata.wrapped_data_key.algorithm != "xchacha20poly1305"
        || decode_bytes(&metadata.wrapped_data_key.ciphertext, "ciphertext")?.len()
            != DATA_KEY_BYTES + 16
    {
        return Err("workspace_vault_invalid_wrapped_key".to_owned());
    }
    if metadata.migrated_slots.len() > 2
        || metadata
            .migrated_slots
            .iter()
            .enumerate()
            .any(|(index, slot)| metadata.migrated_slots[..index].contains(slot))
    {
        return Err("workspace_vault_invalid_slots".to_owned());
    }
    if let Some(system_unlock) = metadata.system_unlock.as_ref() {
        if system_unlock.provider.is_empty()
            || system_unlock.provider.len() > 128
            || system_unlock.credential_id.is_empty()
            || system_unlock.credential_id.len() > 256
            || system_unlock.provider.as_bytes().contains(&0)
            || system_unlock.credential_id.as_bytes().contains(&0)
        {
            return Err("workspace_vault_invalid_system_unlock".to_owned());
        }
        let _ = decode_fixed::<NONCE_BYTES>(&system_unlock.wrapped_data_key.nonce, "nonce")?;
        if system_unlock.wrapped_data_key.algorithm != "xchacha20poly1305"
            || decode_bytes(&system_unlock.wrapped_data_key.ciphertext, "ciphertext")?.len()
                != DATA_KEY_BYTES + 16
        {
            return Err("workspace_vault_invalid_system_unlock".to_owned());
        }
    }
    Ok(metadata)
}

fn unwrap_data_key(
    metadata: &VaultMetadata,
    password: &str,
) -> Result<[u8; DATA_KEY_BYTES], String> {
    let wrapping_key = derive_password_key(password, &metadata.kdf)
        .map_err(|_| "workspace_vault_invalid_password".to_owned())?;
    let mut plaintext = decrypt_bytes(&metadata.wrapped_data_key, &wrapping_key, VAULT_KEY_AAD)
        .map_err(|error| {
            if error == "workspace_vault_authentication_failed" {
                "workspace_vault_invalid_password".to_owned()
            } else {
                error
            }
        })?;
    let key: [u8; DATA_KEY_BYTES] = plaintext
        .as_slice()
        .try_into()
        .map_err(|_| "workspace_vault_invalid_wrapped_key".to_owned())?;
    plaintext.zeroize();
    Ok(key)
}

fn unwrap_data_key_with_system(
    metadata: &VaultMetadata,
    provider: &dyn SystemUnlockProvider,
) -> Result<[u8; DATA_KEY_BYTES], String> {
    let envelope = metadata
        .system_unlock
        .as_ref()
        .ok_or_else(|| "system_unlock_not_enabled".to_owned())?;
    if envelope.provider != provider.provider_id() {
        return Err("system_unlock_not_enabled_on_device".to_owned());
    }
    let mut stored_key = Zeroizing::new(provider.load(&envelope.credential_id)?);
    let device_key = Zeroizing::new(
        stored_key
            .as_slice()
            .try_into()
            .map_err(|_| "system_unlock_invalid_credential".to_owned())?,
    );
    stored_key.zeroize();
    let mut plaintext = decrypt_bytes(
        &envelope.wrapped_data_key,
        &device_key,
        &system_unlock_aad(&envelope.provider, &envelope.credential_id),
    )
    .map_err(|error| {
        if error == "workspace_vault_authentication_failed" {
            "system_unlock_invalid_credential".to_owned()
        } else {
            error
        }
    })?;
    let key: [u8; DATA_KEY_BYTES] = plaintext
        .as_slice()
        .try_into()
        .map_err(|_| "workspace_vault_invalid_wrapped_key".to_owned())?;
    plaintext.zeroize();
    Ok(key)
}

fn encrypt_workspace_file(
    contents: &str,
    slot: WorkspaceFileSlot,
    data_key: &[u8; DATA_KEY_BYTES],
) -> Result<String, String> {
    let envelope = EncryptedWorkspaceEnvelope {
        format: ENCRYPTED_WORKSPACE_FORMAT.to_owned(),
        version: CRYPTO_VERSION,
        slot,
        payload: encrypt_bytes(contents.as_bytes(), data_key, slot.aad())?,
    };
    serde_json::to_string(&envelope).map_err(|error| error.to_string())
}

fn decrypt_workspace_file(
    contents: &str,
    slot: WorkspaceFileSlot,
    data_key: &[u8; DATA_KEY_BYTES],
) -> Result<String, String> {
    let envelope: EncryptedWorkspaceEnvelope = serde_json::from_str(contents)
        .map_err(|_| "workspace_vault_invalid_workspace_envelope".to_owned())?;
    if envelope.format != ENCRYPTED_WORKSPACE_FORMAT
        || envelope.version != CRYPTO_VERSION
        || envelope.slot != slot
    {
        return Err("workspace_vault_invalid_workspace_envelope".to_owned());
    }
    let plaintext = decrypt_bytes(&envelope.payload, data_key, slot.aad())?;
    String::from_utf8(plaintext).map_err(|_| "workspace_vault_invalid_plaintext".to_owned())
}

fn verify_encrypted_store(
    store: &WorkspaceFileStore,
    data_key: &[u8; DATA_KEY_BYTES],
) -> Result<(), String> {
    for slot in [WorkspaceFileSlot::Primary, WorkspaceFileSlot::Recovery] {
        if let Some(contents) = store.read(slot, Some(data_key))? {
            validate_storage_envelope(&contents)
                .map_err(|error| format!("workspace_vault_invalid_decrypted_workspace:{error}"))?;
        }
    }
    Ok(())
}

fn migrate_plaintext_store(
    store: &WorkspaceFileStore,
    password: &str,
) -> Result<[u8; DATA_KEY_BYTES], String> {
    fs::create_dir_all(&store.base_directory).map_err(|error| error.to_string())?;
    let data_key = random_array::<DATA_KEY_BYTES>()?;
    prepare_backup_migration(store, &data_key)?;
    let mut migrated_slots = Vec::new();
    for slot in [WorkspaceFileSlot::Primary, WorkspaceFileSlot::Recovery] {
        if let Some(contents) = store
            .read_plaintext(slot)
            .map_err(|error| error.to_string())?
        {
            validate_storage_envelope(&contents).map_err(|error| error.to_string())?;
            let encrypted = encrypt_workspace_file(&contents, slot, &data_key)?;
            write_atomically(&store.pending_path(slot), encrypted.as_bytes())
                .map_err(|error| error.to_string())?;
            let verified = decrypt_workspace_file(&encrypted, slot, &data_key)?;
            if verified != contents {
                return Err("workspace_vault_migration_verification_failed".to_owned());
            }
            migrated_slots.push(slot);
        }
    }
    let metadata = create_vault_metadata(password, &data_key, migrated_slots)?;
    let serialized = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
    write_atomically(&store.pending_vault_path(), &serialized)
        .map_err(|error| error.to_string())?;
    finish_pending_migration(store, &metadata)?;
    Ok(data_key)
}

fn finish_pending_migration(
    store: &WorkspaceFileStore,
    metadata: &VaultMetadata,
) -> Result<(), String> {
    for slot in metadata.migrated_slots.iter().copied() {
        let pending = store.pending_path(slot);
        if pending.is_file() {
            replace_file(&pending, &store.path(slot)).map_err(|error| error.to_string())?;
        } else {
            let current = store
                .read_plaintext(slot)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "workspace_vault_pending_workspace_missing".to_owned())?;
            let envelope: EncryptedWorkspaceEnvelope = serde_json::from_str(&current)
                .map_err(|_| "workspace_vault_pending_workspace_missing".to_owned())?;
            if envelope.format != ENCRYPTED_WORKSPACE_FORMAT
                || envelope.version != CRYPTO_VERSION
                || envelope.slot != slot
            {
                return Err("workspace_vault_pending_workspace_missing".to_owned());
            }
        }
    }
    finish_pending_backup_migration(store)?;
    if store.pending_vault_path().is_file() {
        replace_file(&store.pending_vault_path(), &store.vault_path())
            .map_err(|error| error.to_string())?;
    }
    sync_parent_directory(&store.base_directory).map_err(|error| error.to_string())
}

fn recover_pending_migration(store: &WorkspaceFileStore) -> Result<(), String> {
    if store.encryption_configured() {
        return Ok(());
    }
    let Some(contents) = WorkspaceFileStore::read_text_path(&store.pending_vault_path())
        .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    let metadata = parse_vault_metadata(&contents)?;
    finish_pending_migration(store, &metadata)
}

fn prepare_backup_migration(
    store: &WorkspaceFileStore,
    data_key: &[u8; DATA_KEY_BYTES],
) -> Result<(), String> {
    let pending_directory = store.pending_backup_directory();
    if pending_directory.exists() {
        fs::remove_dir_all(&pending_directory).map_err(|error| error.to_string())?;
    }
    let backups = store.backup_files()?;
    if backups.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(&pending_directory).map_err(|error| error.to_string())?;
    for backup in backups {
        let contents = WorkspaceFileStore::read_text_path(&backup.path)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "workspace_backup_missing".to_owned())?;
        let encrypted = encrypt_workspace_file(&contents, WorkspaceFileSlot::Primary, data_key)?;
        let pending_path = pending_directory.join(format!("{}.json", backup.id));
        write_atomically(&pending_path, encrypted.as_bytes()).map_err(|error| error.to_string())?;
        if decrypt_workspace_file(&encrypted, WorkspaceFileSlot::Primary, data_key)? != contents {
            return Err("workspace_vault_migration_verification_failed".to_owned());
        }
    }
    sync_parent_directory(&pending_directory).map_err(|error| error.to_string())
}

fn finish_pending_backup_migration(store: &WorkspaceFileStore) -> Result<(), String> {
    let pending_directory = store.pending_backup_directory();
    let entries = match fs::read_dir(&pending_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    fs::create_dir_all(store.backup_directory()).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            continue;
        }
        let file_name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| "workspace_backup_invalid_id".to_owned())?;
        let id = file_name
            .strip_suffix(".json")
            .ok_or_else(|| "workspace_backup_invalid_id".to_owned())?;
        let destination = store.backup_path(id)?;
        replace_file(&entry.path(), &destination).map_err(|error| error.to_string())?;
    }
    fs::remove_dir(&pending_directory).map_err(|error| error.to_string())?;
    sync_parent_directory(&store.backup_directory()).map_err(|error| error.to_string())
}

fn encrypt_export(
    contents: &str,
    metadata: &VaultMetadata,
    data_key: &[u8; DATA_KEY_BYTES],
) -> Result<String, String> {
    let envelope = EncryptedExportEnvelope {
        format: ENCRYPTED_EXPORT_FORMAT.to_owned(),
        version: CRYPTO_VERSION,
        kdf: metadata.kdf.clone(),
        wrapped_data_key: metadata.wrapped_data_key.clone(),
        payload: encrypt_bytes(contents.as_bytes(), data_key, EXPORT_PAYLOAD_AAD)?,
    };
    serde_json::to_string_pretty(&envelope).map_err(|error| error.to_string())
}

fn decrypt_export(contents: &str, password: &str) -> Result<String, String> {
    let envelope: EncryptedExportEnvelope = serde_json::from_str(contents)
        .map_err(|_| "workspace_export_invalid_encrypted_envelope".to_owned())?;
    if envelope.format != ENCRYPTED_EXPORT_FORMAT || envelope.version != CRYPTO_VERSION {
        return Err("workspace_export_invalid_encrypted_envelope".to_owned());
    }
    let metadata = VaultMetadata {
        format: VAULT_FORMAT.to_owned(),
        version: CRYPTO_VERSION,
        kdf: envelope.kdf,
        wrapped_data_key: envelope.wrapped_data_key,
        migrated_slots: Vec::new(),
        system_unlock: None,
    };
    let data_key = Zeroizing::new(unwrap_data_key(&metadata, password)?);
    let plaintext = decrypt_bytes(&envelope.payload, &data_key, EXPORT_PAYLOAD_AAD)?;
    let text = String::from_utf8(plaintext)
        .map_err(|_| "workspace_export_invalid_plaintext".to_owned())?;
    Ok(text)
}

fn validate_storage_envelope(contents: &str) -> io::Result<()> {
    let value: serde_json::Value = serde_json::from_str(contents)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if !value.is_object() || value.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "workspace storage envelope must use version 1",
        ));
    }
    Ok(())
}

fn write_atomically(target: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace file has no parent directory",
        )
    })?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "invalid workspace file name")
        })?;
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));

    let write_result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, target)?;
        sync_parent_directory(parent)
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeSystemUnlockProvider {
        secrets: Mutex<HashMap<String, Vec<u8>>>,
    }

    impl SystemUnlockProvider for FakeSystemUnlockProvider {
        fn provider_id(&self) -> &'static str {
            "test-system-store"
        }

        fn available(&self) -> bool {
            true
        }

        fn store(&self, credential_id: &str, secret: &[u8]) -> Result<(), String> {
            self.secrets
                .lock()
                .unwrap()
                .insert(credential_id.to_owned(), secret.to_vec());
            Ok(())
        }

        fn load(&self, credential_id: &str) -> Result<Vec<u8>, String> {
            self.secrets
                .lock()
                .unwrap()
                .get(credential_id)
                .cloned()
                .ok_or_else(|| "system_unlock_credential_missing".to_owned())
        }

        fn delete(&self, credential_id: &str) -> Result<(), String> {
            self.secrets.lock().unwrap().remove(credential_id);
            Ok(())
        }
    }

    fn test_directory() -> PathBuf {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "linked-info-workspace-test-{}-{sequence}",
            std::process::id()
        ))
    }

    fn workspace(name: &str) -> String {
        serde_json::json!({
            "version": 1,
            "nodes": [{
                "id": "11111111-1111-4111-8111-111111111111",
                "name": name,
                "content": null
            }],
            "layout": [{
                "nodeId": "11111111-1111-4111-8111-111111111111",
                "x": 10,
                "y": 20
            }],
            "references": [],
            "viewport": null
        })
        .to_string()
    }

    #[test]
    fn writes_and_replaces_a_workspace_atomically() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let first = workspace("First");
        let second = workspace("Second");

        store
            .write_plaintext(WorkspaceFileSlot::Primary, &first)
            .unwrap();
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &second)
            .unwrap();

        assert_eq!(
            store.read_plaintext(WorkspaceFileSlot::Primary).unwrap(),
            Some(second)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_invalid_envelopes_without_overwriting_valid_data() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let original = workspace("Original");
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &original)
            .unwrap();

        let error = store
            .write_plaintext(WorkspaceFileSlot::Primary, r#"{"version":2}"#)
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            store.read_plaintext(WorkspaceFileSlot::Primary).unwrap(),
            Some(original)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn keeps_primary_and_recovery_files_separate() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let primary = workspace("Primary");
        let recovery = workspace("Recovery");

        store
            .write_plaintext(WorkspaceFileSlot::Primary, &primary)
            .unwrap();
        store
            .write_plaintext(WorkspaceFileSlot::Recovery, &recovery)
            .unwrap();

        assert_eq!(
            store.read_plaintext(WorkspaceFileSlot::Primary).unwrap(),
            Some(primary)
        );
        assert_eq!(
            store.read_plaintext(WorkspaceFileSlot::Recovery).unwrap(),
            Some(recovery)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn captures_changed_primary_files_at_a_bounded_interval() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let started_at = 1_800_000_000_000_u64;
        let first = workspace("First backup");
        let second = workspace("Second backup");
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &first)
            .unwrap();

        let first_capture = capture_workspace_backup_at(&store, None, started_at).unwrap();
        assert!(first_capture.created);
        assert_eq!(first_capture.status.entries.len(), 1);
        assert_eq!(
            read_backup_contents(&store, &first_capture.status.entries[0].id, None).unwrap(),
            first
        );

        store
            .write_plaintext(WorkspaceFileSlot::Primary, &second)
            .unwrap();
        let early = capture_workspace_backup_at(
            &store,
            None,
            started_at + BACKUP_INTERVAL_MILLISECONDS - 1,
        )
        .unwrap();
        assert!(!early.created);
        assert_eq!(early.status.entries.len(), 1);

        let second_capture =
            capture_workspace_backup_at(&store, None, started_at + BACKUP_INTERVAL_MILLISECONDS)
                .unwrap();
        assert!(second_capture.created);
        assert_eq!(second_capture.status.entries.len(), 2);
        assert_eq!(
            read_backup_contents(&store, &second_capture.status.entries[0].id, None).unwrap(),
            second
        );

        let unchanged = capture_workspace_backup_at(
            &store,
            None,
            started_at + BACKUP_INTERVAL_MILLISECONDS * 2,
        )
        .unwrap();
        assert!(!unchanged.created);
        assert_eq!(unchanged.status.entries.len(), 2);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rotates_automatic_backups_by_count() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let started_at = 1_800_000_000_000_u64;

        for index in 0..=BACKUP_MAXIMUM_COUNT {
            store
                .write_plaintext(
                    WorkspaceFileSlot::Primary,
                    &workspace(&format!("Version {index}")),
                )
                .unwrap();
            assert!(
                capture_workspace_backup_at(
                    &store,
                    None,
                    started_at + BACKUP_INTERVAL_MILLISECONDS * index as u64,
                )
                .unwrap()
                .created
            );
        }

        let status = inspect_backup_history(&store, None).unwrap();
        assert_eq!(status.entries.len(), BACKUP_MAXIMUM_COUNT);
        assert_eq!(
            read_backup_contents(&store, &status.entries[0].id, None).unwrap(),
            workspace(&format!("Version {BACKUP_MAXIMUM_COUNT}"))
        );
        assert!(
            !status
                .entries
                .iter()
                .any(|entry| entry.created_at_ms == started_at)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn migrates_existing_backup_history_without_leaving_plaintext() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let primary = workspace("secret-from-backup-history");
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &primary)
            .unwrap();
        let captured = capture_workspace_backup_at(&store, None, 1_800_000_000_000).unwrap();
        let backup_id = captured.status.entries[0].id.clone();

        let data_key = migrate_plaintext_store(&store, "correct horse battery").unwrap();

        let raw_backup =
            WorkspaceFileStore::read_text_path(&store.backup_path(&backup_id).unwrap())
                .unwrap()
                .unwrap();
        assert!(!raw_backup.contains("secret-from-backup-history"));
        assert_eq!(
            read_backup_contents(&store, &backup_id, Some(&data_key)).unwrap(),
            primary
        );
        assert_eq!(
            inspect_backup_history(&store, Some(&data_key))
                .unwrap()
                .entries[0]
                .state,
            WorkspaceBackupState::Ready
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn marks_damaged_history_without_returning_it_for_restore() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        fs::create_dir_all(store.backup_directory()).unwrap();
        let id = format!("1800000000000-{}", uuid::Uuid::new_v4());
        write_atomically(&store.backup_path(&id).unwrap(), b"not-json").unwrap();

        let status = inspect_backup_history(&store, None).unwrap();
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].state, WorkspaceBackupState::Invalid);
        assert_eq!(
            read_backup_contents(&store, &id, None).unwrap_err(),
            "workspace_backup_invalid"
        );
        assert_eq!(
            read_backup_contents(&store, "../workspace.v1", None).unwrap_err(),
            "workspace_backup_invalid_id"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn migrates_plaintext_slots_without_leaving_node_text_visible() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let primary = workspace("secret-account-token");
        let recovery = workspace("secret-recovery-code");
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &primary)
            .unwrap();
        store
            .write_plaintext(WorkspaceFileSlot::Recovery, &recovery)
            .unwrap();

        let data_key = migrate_plaintext_store(&store, "correct horse battery").unwrap();

        let raw_primary = store
            .read_plaintext(WorkspaceFileSlot::Primary)
            .unwrap()
            .unwrap();
        let raw_recovery = store
            .read_plaintext(WorkspaceFileSlot::Recovery)
            .unwrap()
            .unwrap();
        assert!(!raw_primary.contains("secret-account-token"));
        assert!(!raw_recovery.contains("secret-recovery-code"));
        assert_eq!(
            store
                .read(WorkspaceFileSlot::Primary, Some(&data_key))
                .unwrap(),
            Some(primary)
        );
        assert_eq!(
            store
                .read(WorkspaceFileSlot::Recovery, Some(&data_key))
                .unwrap(),
            Some(recovery)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_wrong_password_and_modified_ciphertext() {
        let data_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let metadata =
            create_vault_metadata("correct horse battery", &data_key, Vec::new()).unwrap();
        assert_eq!(
            unwrap_data_key(&metadata, "correct horse battery").unwrap(),
            data_key
        );
        assert_eq!(
            unwrap_data_key(&metadata, "incorrect password").unwrap_err(),
            "workspace_vault_invalid_password"
        );
        let changed_metadata =
            create_vault_metadata("replacement password", &data_key, Vec::new()).unwrap();
        assert_eq!(
            unwrap_data_key(&changed_metadata, "replacement password").unwrap(),
            data_key
        );
        assert_eq!(
            unwrap_data_key(&changed_metadata, "correct horse battery").unwrap_err(),
            "workspace_vault_invalid_password"
        );

        let mut encrypted = encrypt_workspace_file(
            &workspace("tamper-check"),
            WorkspaceFileSlot::Primary,
            &data_key,
        )
        .unwrap();
        let mut envelope: EncryptedWorkspaceEnvelope = serde_json::from_str(&encrypted).unwrap();
        let mut ciphertext = decode_bytes(&envelope.payload.ciphertext, "ciphertext").unwrap();
        ciphertext[0] ^= 1;
        envelope.payload.ciphertext = encode_bytes(&ciphertext);
        encrypted = serde_json::to_string(&envelope).unwrap();
        assert_eq!(
            decrypt_workspace_file(&encrypted, WorkspaceFileSlot::Primary, &data_key).unwrap_err(),
            "workspace_vault_authentication_failed"
        );
    }

    #[test]
    fn rejects_unsupported_crypto_versions_before_unlocking() {
        let data_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let metadata =
            create_vault_metadata("correct horse battery", &data_key, Vec::new()).unwrap();
        let mut value = serde_json::to_value(metadata).unwrap();
        value["version"] = serde_json::json!(2);

        assert_eq!(
            parse_vault_metadata(&value.to_string()).unwrap_err(),
            "workspace_vault_unsupported_metadata"
        );

        let mut encrypted: serde_json::Value = serde_json::from_str(
            &encrypt_workspace_file(
                &workspace("unsupported-version"),
                WorkspaceFileSlot::Primary,
                &data_key,
            )
            .unwrap(),
        )
        .unwrap();
        encrypted["version"] = serde_json::json!(2);
        assert_eq!(
            decrypt_workspace_file(
                &encrypted.to_string(),
                WorkspaceFileSlot::Primary,
                &data_key,
            )
            .unwrap_err(),
            "workspace_vault_invalid_workspace_envelope"
        );
    }

    #[test]
    fn completes_a_committed_pending_migration_after_restart() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let primary = workspace("pending-migration");
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &primary)
            .unwrap();
        let data_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let encrypted =
            encrypt_workspace_file(&primary, WorkspaceFileSlot::Primary, &data_key).unwrap();
        write_atomically(
            &store.pending_path(WorkspaceFileSlot::Primary),
            encrypted.as_bytes(),
        )
        .unwrap();
        let metadata = create_vault_metadata(
            "correct horse battery",
            &data_key,
            vec![WorkspaceFileSlot::Primary],
        )
        .unwrap();
        write_atomically(
            &store.pending_vault_path(),
            &serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();

        recover_pending_migration(&store).unwrap();

        assert!(store.encryption_configured());
        let unlocked = unwrap_data_key(
            &store.read_vault_metadata().unwrap().unwrap(),
            "correct horse battery",
        )
        .unwrap();
        assert_eq!(
            store
                .read(WorkspaceFileSlot::Primary, Some(&unlocked))
                .unwrap(),
            Some(primary)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn encrypts_exports_with_an_independent_authenticated_envelope() {
        let data_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let metadata =
            create_vault_metadata("correct horse battery", &data_key, Vec::new()).unwrap();
        let export = serde_json::json!({
            "format": "linked-info-workspace",
            "version": 1,
            "workspace": { "version": 1 }
        })
        .to_string();

        let encrypted = encrypt_export(&export, &metadata, &data_key).unwrap();

        assert!(!encrypted.contains("linked-info-workspace\""));
        assert_eq!(
            decrypt_export(&encrypted, "correct horse battery").unwrap(),
            export
        );
        assert_eq!(
            decrypt_export(&encrypted, "incorrect password").unwrap_err(),
            "workspace_vault_invalid_password"
        );
    }

    #[test]
    fn reads_vault_metadata_created_before_system_unlock_support() {
        let data_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let metadata =
            create_vault_metadata("correct horse battery", &data_key, Vec::new()).unwrap();
        let mut value = serde_json::to_value(metadata).unwrap();
        value.as_object_mut().unwrap().remove("systemUnlock");

        let parsed = parse_vault_metadata(&value.to_string()).unwrap();

        assert!(parsed.system_unlock.is_none());
        assert_eq!(
            unwrap_data_key(&parsed, "correct horse battery").unwrap(),
            data_key
        );
    }

    #[test]
    fn system_unlock_uses_an_independent_device_key() {
        let provider = FakeSystemUnlockProvider::default();
        let data_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let device_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let credential_id = "device-credential";
        provider.store(credential_id, &device_key).unwrap();
        let mut metadata =
            create_vault_metadata("correct horse battery", &data_key, Vec::new()).unwrap();
        metadata.system_unlock = Some(
            create_system_unlock_envelope(
                provider.provider_id(),
                credential_id,
                &data_key,
                &device_key,
            )
            .unwrap(),
        );

        assert_eq!(
            unwrap_data_key_with_system(&metadata, &provider).unwrap(),
            data_key
        );
        provider.delete(credential_id).unwrap();
        assert_eq!(
            unwrap_data_key_with_system(&metadata, &provider).unwrap_err(),
            "system_unlock_credential_missing"
        );
        assert_eq!(
            unwrap_data_key(&metadata, "correct horse battery").unwrap(),
            data_key
        );
    }

    #[test]
    fn rejects_a_wrong_system_unlock_secret_without_affecting_password_unlock() {
        let provider = FakeSystemUnlockProvider::default();
        let data_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let device_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let credential_id = "wrong-device-credential";
        let mut metadata =
            create_vault_metadata("correct horse battery", &data_key, Vec::new()).unwrap();
        metadata.system_unlock = Some(
            create_system_unlock_envelope(
                provider.provider_id(),
                credential_id,
                &data_key,
                &device_key,
            )
            .unwrap(),
        );
        provider
            .store(credential_id, &random_array::<DATA_KEY_BYTES>().unwrap())
            .unwrap();

        assert_eq!(
            unwrap_data_key_with_system(&metadata, &provider).unwrap_err(),
            "system_unlock_invalid_credential"
        );
        assert_eq!(
            unwrap_data_key(&metadata, "correct horse battery").unwrap(),
            data_key
        );
    }

    #[test]
    fn changing_the_master_password_preserves_system_unlock() {
        let provider = FakeSystemUnlockProvider::default();
        let data_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let device_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let credential_id = "preserved-device-credential";
        provider.store(credential_id, &device_key).unwrap();
        let mut original =
            create_vault_metadata("correct horse battery", &data_key, Vec::new()).unwrap();
        original.system_unlock = Some(
            create_system_unlock_envelope(
                provider.provider_id(),
                credential_id,
                &data_key,
                &device_key,
            )
            .unwrap(),
        );

        let changed =
            rewrap_vault_metadata(original, "replacement master password", &data_key).unwrap();

        assert_eq!(
            unwrap_data_key(&changed, "correct horse battery").unwrap_err(),
            "workspace_vault_invalid_password"
        );
        assert_eq!(
            unwrap_data_key(&changed, "replacement master password").unwrap(),
            data_key
        );
        assert_eq!(
            unwrap_data_key_with_system(&changed, &provider).unwrap(),
            data_key
        );
    }

    #[test]
    fn encrypted_exports_never_include_system_unlock_metadata() {
        let provider = FakeSystemUnlockProvider::default();
        let data_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let device_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let mut metadata =
            create_vault_metadata("correct horse battery", &data_key, Vec::new()).unwrap();
        metadata.system_unlock = Some(
            create_system_unlock_envelope(
                provider.provider_id(),
                "must-not-be-exported",
                &data_key,
                &device_key,
            )
            .unwrap(),
        );

        let encrypted = encrypt_export("exported contents", &metadata, &data_key).unwrap();

        assert!(!encrypted.contains("systemUnlock"));
        assert!(!encrypted.contains("test-system-store"));
        assert!(!encrypted.contains("must-not-be-exported"));
        assert_eq!(
            decrypt_export(&encrypted, "correct horse battery").unwrap(),
            "exported contents"
        );
    }
}
