use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
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
const DATA_KEY_ROTATION_DIRECTORY_NAME: &str = ".workspace.data-key-rotation.v1.pending";
const DATA_KEY_ROTATION_MANIFEST_FILE_NAME: &str = "manifest.json";
const DATA_KEY_ROTATION_VAULT_FILE_NAME: &str = "workspace.vault.v1.json";
const DATA_KEY_ROTATION_BACKUP_DIRECTORY_NAME: &str = "backups";
const RECOVERY_SWAP_DIRECTORY_NAME: &str = ".workspace.recovery-swap.v1.pending";
const RECOVERY_SWAP_MANIFEST_FILE_NAME: &str = "manifest.json";
const RECOVERY_SWAP_PRIMARY_FILE_NAME: &str = "workspace.v1.json";
const RECOVERY_SWAP_RECOVERY_FILE_NAME: &str = "workspace.recovery.v1.json";
const ENCRYPTED_WORKSPACE_FORMAT: &str = "linked-info-encrypted-workspace";
const ENCRYPTED_EXPORT_FORMAT: &str = "linked-info-encrypted-workspace-export";
const WORKSPACE_EXPORT_FORMAT: &str = "linked-info-workspace";
const CURRENT_WORKSPACE_STORAGE_VERSION: u64 = 2;
const VAULT_FORMAT: &str = "linked-info-workspace-vault";
const DATA_KEY_ROTATION_FORMAT: &str = "linked-info-data-key-rotation";
const RECOVERY_SWAP_FORMAT: &str = "linked-info-recovery-swap";
const CRYPTO_VERSION: u32 = 1;
const DATA_KEY_BYTES: usize = 32;
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const MINIMUM_PASSWORD_CHARACTERS: usize = 15;
const MAXIMUM_PASSWORD_BYTES: usize = 1_024;
const MINIMUM_MANUAL_NODE_WIDTH: f64 = 220.0;
const MINIMUM_MANUAL_NODE_HEIGHT: f64 = 92.0;
const MAXIMUM_MANUAL_NODE_DIMENSION: f64 = 5_000.0;
const BACKUP_INTERVAL_MILLISECONDS: u64 = 60 * 60 * 1_000;
const BACKUP_MAXIMUM_COUNT: usize = 30;
const BACKUP_MAXIMUM_BYTES: u64 = 512 * 1024 * 1024;
const BACKUP_MAXIMUM_AGE_MILLISECONDS: u64 = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_IDLE_TIMEOUT_MINUTES: u32 = 15;
const ALLOWED_IDLE_TIMEOUT_MINUTES: [u32; 3] = [5, 15, 30];
const SENSITIVE_AUTHORIZATION_TTL_MILLISECONDS: u64 = 60_000;
const PREPARED_RESTORE_TTL_MILLISECONDS: u64 = 5 * 60_000;
const PASSWORD_BLOCKLIST: &[&str] = &[
    "123456789012345",
    "111111111111111",
    "passwordpassword",
    "password123456",
    "qwertyuiopasdfgh",
    "qwerty123456789",
    "letmeinletmein",
    "adminadminadmin",
    "administrator",
    "iloveyouiloveyou",
    "welcome123456789",
    "correcthorsebatterystaple",
];
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
pub const WORKSPACE_LOCKED_EVENT: &str = "workspace-security-locked";

fn default_idle_timeout_minutes() -> Option<u32> {
    Some(DEFAULT_IDLE_TIMEOUT_MINUTES)
}

fn minutes_to_milliseconds(minutes: u32) -> u64 {
    u64::from(minutes) * 60_000
}

fn now_milliseconds_lossy() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn validate_idle_timeout_minutes(minutes: Option<u32>) -> Result<(), String> {
    if minutes.is_none()
        || minutes.is_some_and(|value| ALLOWED_IDLE_TIMEOUT_MINUTES.contains(&value))
    {
        Ok(())
    } else {
        Err("workspace_vault_invalid_idle_timeout".to_owned())
    }
}

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

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct KdfEnvelope {
    algorithm: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
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
    #[serde(default = "default_idle_timeout_minutes")]
    idle_timeout_minutes: Option<u32>,
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

struct PreparedWorkspaceRestore {
    id: uuid::Uuid,
    expires_at_milliseconds: u64,
    envelope: EncryptedExportEnvelope,
    data_key: Zeroizing<[u8; DATA_KEY_BYTES]>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedWorkspaceRestorePreview {
    id: uuid::Uuid,
    plaintext: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum DataKeyRotationPhase {
    Preparing,
    Ready,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RotationSystemCredential {
    provider: String,
    credential_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataKeyRotationManifest {
    format: String,
    version: u32,
    phase: DataKeyRotationPhase,
    slots: Vec<WorkspaceFileSlot>,
    backup_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_system_credential: Option<RotationSystemCredential>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_system_credential: Option<RotationSystemCredential>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoverySwapManifest {
    format: String,
    version: u32,
    primary_sha256: String,
    recovery_sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum WorkspaceRecoverySwapStatus {
    Committed,
    CommittedLocked,
    RecoveryRequired,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecoverySwapResult {
    status: WorkspaceRecoverySwapStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    contents: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSecurityStatus {
    encrypted: bool,
    locked: bool,
    system_unlock_available: bool,
    system_unlock_enabled: bool,
    idle_timeout_minutes: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SensitiveOperation {
    BackupRetentionChange,
    BackupSnapshotDelete,
    BackupTargetChange,
    BackupTargetDestroy,
    ChangePassword,
    ClearRecoveryData,
    DestroyWorkspace,
    ExportWorkspace,
    RotateDataKey,
    SystemUnlockChange,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum SensitiveAuthentication {
    Password { password: String },
    System { message: String },
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
    maximum_age_ms: u64,
    interval_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackupCaptureResult {
    created: bool,
    status: WorkspaceBackupHistoryStatus,
}

pub struct WorkspaceVaultState {
    data_key: Arc<Mutex<Option<Zeroizing<[u8; DATA_KEY_BYTES]>>>>,
    operation_lock: Arc<Mutex<()>>,
    access_generation: Arc<AtomicU64>,
    idle_timeout_milliseconds: AtomicU64,
    last_activity_milliseconds: AtomicU64,
    sensitive_authorization: Mutex<Option<SensitiveAuthorization>>,
    failed_password_attempts: AtomicU32,
    password_retry_after_milliseconds: AtomicU64,
    prepared_restore: Arc<Mutex<Option<PreparedWorkspaceRestore>>>,
}

impl Default for WorkspaceVaultState {
    fn default() -> Self {
        Self {
            data_key: Arc::new(Mutex::new(None)),
            operation_lock: Arc::new(Mutex::new(())),
            access_generation: Arc::new(AtomicU64::new(0)),
            idle_timeout_milliseconds: AtomicU64::new(minutes_to_milliseconds(
                DEFAULT_IDLE_TIMEOUT_MINUTES,
            )),
            last_activity_milliseconds: AtomicU64::new(now_milliseconds_lossy()),
            sensitive_authorization: Mutex::new(None),
            failed_password_attempts: AtomicU32::new(0),
            password_retry_after_milliseconds: AtomicU64::new(0),
            prepared_restore: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct WorkspaceAccessPermit {
    generation: u64,
}

struct SensitiveAuthorization {
    operation: SensitiveOperation,
    permit: WorkspaceAccessPermit,
    token: Zeroizing<String>,
    expires_at_milliseconds: u64,
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
        self.access_generation.fetch_add(1, Ordering::AcqRel);
        let mut slot = self
            .data_key
            .lock()
            .map_err(|_| "workspace_vault_state_unavailable".to_owned())?;
        *slot = Some(Zeroizing::new(key));
        drop(slot);
        self.record_activity();
        Ok(())
    }

    fn optional_data_key(&self) -> Result<Option<Zeroizing<[u8; DATA_KEY_BYTES]>>, String> {
        self.data_key
            .lock()
            .map_err(|_| "workspace_vault_state_unavailable".to_owned())
            .map(|slot| slot.as_ref().map(|key| Zeroizing::new(**key)))
    }

    fn revoke_access(&self) -> Result<bool, String> {
        self.access_generation.fetch_add(1, Ordering::AcqRel);
        let mut slot = self
            .data_key
            .lock()
            .map_err(|_| "workspace_vault_state_unavailable".to_owned())?;
        let was_unlocked = slot.is_some();
        *slot = None;
        if let Ok(mut authorization) = self.sensitive_authorization.lock() {
            *authorization = None;
        }
        Ok(was_unlocked)
    }

    fn is_unlocked(&self) -> Result<bool, String> {
        self.data_key
            .lock()
            .map(|slot| slot.is_some())
            .map_err(|_| "workspace_vault_state_unavailable".to_owned())
    }

    fn access_permit(&self) -> Result<WorkspaceAccessPermit, String> {
        if !self.is_unlocked()? {
            return Err("workspace_vault_locked".to_owned());
        }
        Ok(WorkspaceAccessPermit {
            generation: self.access_generation.load(Ordering::Acquire),
        })
    }

    pub(crate) fn access_generation(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.access_generation)
    }

    pub(crate) fn encrypt_derived_cache_payload(
        &self,
        plaintext: &[u8],
        aad: &[u8],
    ) -> Result<Vec<u8>, String> {
        let permit = self.access_permit()?;
        let data_key = self.data_key()?;
        let envelope = encrypt_bytes(plaintext, &data_key, aad)?;
        self.ensure_access_permit(permit)?;
        serde_json::to_vec(&envelope).map_err(|_| "workspace_vault_encryption_failed".to_owned())
    }

    pub(crate) fn decrypt_derived_cache_payload(
        &self,
        encrypted: &[u8],
        aad: &[u8],
    ) -> Result<Vec<u8>, String> {
        let permit = self.access_permit()?;
        let data_key = self.data_key()?;
        let envelope: CipherEnvelope = serde_json::from_slice(encrypted)
            .map_err(|_| "workspace_vault_invalid_cipher".to_owned())?;
        let plaintext = decrypt_bytes(&envelope, &data_key, aad)?;
        self.ensure_access_permit(permit)?;
        Ok(plaintext)
    }

    pub fn ensure_access_permit(&self, permit: WorkspaceAccessPermit) -> Result<(), String> {
        if self.access_generation.load(Ordering::Acquire) != permit.generation
            || !self.is_unlocked()?
        {
            return Err("workspace_vault_session_expired".to_owned());
        }
        Ok(())
    }

    fn set_idle_timeout(&self, minutes: Option<u32>) {
        self.idle_timeout_milliseconds.store(
            minutes.map(minutes_to_milliseconds).unwrap_or(0),
            Ordering::Release,
        );
    }

    fn idle_timeout_minutes(&self) -> Option<u32> {
        let milliseconds = self.idle_timeout_milliseconds.load(Ordering::Acquire);
        (milliseconds > 0).then(|| u32::try_from(milliseconds / 60_000).unwrap_or(u32::MAX))
    }

    pub fn record_activity(&self) {
        if self.is_unlocked().unwrap_or(false) {
            self.last_activity_milliseconds
                .store(now_milliseconds_lossy(), Ordering::Release);
        }
    }

    pub fn should_idle_lock(&self) -> bool {
        if !self.is_unlocked().unwrap_or(false) {
            return false;
        }
        let timeout = self.idle_timeout_milliseconds.load(Ordering::Acquire);
        timeout > 0
            && now_milliseconds_lossy()
                .saturating_sub(self.last_activity_milliseconds.load(Ordering::Acquire))
                >= timeout
    }

    fn issue_sensitive_authorization(
        &self,
        operation: SensitiveOperation,
        permit: WorkspaceAccessPermit,
    ) -> Result<String, String> {
        self.ensure_access_permit(permit)?;
        let token = encode_bytes(&random_array::<DATA_KEY_BYTES>()?);
        let authorization = SensitiveAuthorization {
            operation,
            permit,
            token: Zeroizing::new(token.clone()),
            expires_at_milliseconds: now_milliseconds_lossy()
                .saturating_add(SENSITIVE_AUTHORIZATION_TTL_MILLISECONDS),
        };
        *self
            .sensitive_authorization
            .lock()
            .map_err(|_| "workspace_vault_authorization_unavailable".to_owned())? =
            Some(authorization);
        Ok(token)
    }

    pub(crate) fn consume_sensitive_authorization(
        &self,
        operation: SensitiveOperation,
        token: &str,
    ) -> Result<WorkspaceAccessPermit, String> {
        let authorization = self
            .sensitive_authorization
            .lock()
            .map_err(|_| "workspace_vault_authorization_unavailable".to_owned())?
            .take()
            .ok_or_else(|| "workspace_vault_reauthentication_required".to_owned())?;
        if authorization.operation != operation
            || authorization.token.as_str() != token
            || authorization.expires_at_milliseconds < now_milliseconds_lossy()
        {
            return Err("workspace_vault_reauthentication_required".to_owned());
        }
        self.ensure_access_permit(authorization.permit)?;
        Ok(authorization.permit)
    }

    fn check_password_attempt_allowed(&self) -> Result<(), String> {
        if now_milliseconds_lossy()
            < self
                .password_retry_after_milliseconds
                .load(Ordering::Acquire)
        {
            Err("workspace_vault_password_rate_limited".to_owned())
        } else {
            Ok(())
        }
    }

    fn record_password_failure(&self) {
        let attempts = self.failed_password_attempts.fetch_add(1, Ordering::AcqRel) + 1;
        if attempts >= 3 {
            let exponent = attempts.saturating_sub(3).min(4);
            let delay_milliseconds = 2_000_u64.saturating_mul(1_u64 << exponent);
            self.password_retry_after_milliseconds.store(
                now_milliseconds_lossy().saturating_add(delay_milliseconds),
                Ordering::Release,
            );
        }
    }

    fn reset_password_failures(&self) {
        self.failed_password_attempts.store(0, Ordering::Release);
        self.password_retry_after_milliseconds
            .store(0, Ordering::Release);
    }

    pub fn shutdown(&self) -> bool {
        if let Ok(mut prepared_restore) = self.prepared_restore.lock() {
            *prepared_restore = None;
        }
        self.revoke_access().unwrap_or(false)
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

    fn data_key_rotation_directory(&self) -> PathBuf {
        self.base_directory.join(DATA_KEY_ROTATION_DIRECTORY_NAME)
    }

    fn data_key_rotation_manifest_path(&self) -> PathBuf {
        self.data_key_rotation_directory()
            .join(DATA_KEY_ROTATION_MANIFEST_FILE_NAME)
    }

    fn data_key_rotation_vault_path(&self) -> PathBuf {
        self.data_key_rotation_directory()
            .join(DATA_KEY_ROTATION_VAULT_FILE_NAME)
    }

    fn data_key_rotation_slot_path(&self, slot: WorkspaceFileSlot) -> PathBuf {
        self.data_key_rotation_directory().join(slot.file_name())
    }

    fn data_key_rotation_backup_directory(&self) -> PathBuf {
        self.data_key_rotation_directory()
            .join(DATA_KEY_ROTATION_BACKUP_DIRECTORY_NAME)
    }

    fn data_key_rotation_backup_path(&self, id: &str) -> Result<PathBuf, String> {
        parse_backup_id(id)?;
        Ok(self
            .data_key_rotation_backup_directory()
            .join(format!("{id}.json")))
    }

    fn recovery_swap_directory(&self) -> PathBuf {
        self.base_directory.join(RECOVERY_SWAP_DIRECTORY_NAME)
    }

    fn recovery_swap_manifest_path(&self) -> PathBuf {
        self.recovery_swap_directory()
            .join(RECOVERY_SWAP_MANIFEST_FILE_NAME)
    }

    fn recovery_swap_slot_path(&self, slot: WorkspaceFileSlot) -> PathBuf {
        self.recovery_swap_directory().join(match slot {
            WorkspaceFileSlot::Primary => RECOVERY_SWAP_PRIMARY_FILE_NAME,
            WorkspaceFileSlot::Recovery => RECOVERY_SWAP_RECOVERY_FILE_NAME,
        })
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
        let normalized = normalize_storage_envelope(contents)?;
        fs::create_dir_all(&self.base_directory)?;
        write_atomically(&self.path(slot), normalized.as_bytes())
    }

    fn write(
        &self,
        slot: WorkspaceFileSlot,
        contents: &str,
        data_key: Option<&[u8; DATA_KEY_BYTES]>,
    ) -> Result<(), String> {
        let normalized = normalize_storage_envelope(contents).map_err(|error| error.to_string())?;
        fs::create_dir_all(&self.base_directory).map_err(|error| error.to_string())?;
        let serialized = serialize_workspace_for_slot(&normalized, slot, data_key)?;
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
    let permit = begin_workspace_access(&app, &state)?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let data_key = state.optional_data_key()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|error| error.to_string())??;
    ensure_workspace_access(&app, &state, permit)?;
    Ok(result)
}

#[tauri::command]
pub async fn write_workspace_file(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    slot: WorkspaceFileSlot,
    contents: String,
) -> Result<(), String> {
    let permit = begin_workspace_access(&app, &state)?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let access_generation = state.access_generation();
    let data_key = state.optional_data_key()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        ensure_access_generation(&access_generation, permit)?;
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
    .map_err(|error| error.to_string())??;
    ensure_workspace_access(&app, &state, permit)
}

enum WorkspaceRecoverySwapOperation {
    Committed(String),
    RecoveryRequired,
}

#[tauri::command]
pub async fn swap_workspace_recovery_files(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
) -> Result<WorkspaceRecoverySwapResult, String> {
    let permit = begin_workspace_access(&app, &state)?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let access_generation = state.access_generation();
    let data_key = state.optional_data_key()?;
    let operation = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        ensure_access_generation(&access_generation, permit)?;
        recover_pending_encryption_migration(&store)?;
        let recovered_existing = finish_pending_workspace_recovery_swap(&store)?;
        if store.data_key_rotation_directory().exists() {
            return Err("workspace_vault_data_key_rotation_recovery_required".to_owned());
        }
        let active_key = active_workspace_key(&store, data_key.as_deref())?;
        if recovered_existing {
            let contents = store
                .read(WorkspaceFileSlot::Primary, active_key)?
                .ok_or_else(|| "workspace_recovery_unavailable".to_owned())?;
            return Ok(WorkspaceRecoverySwapOperation::Committed(contents));
        }

        let next_primary = prepare_workspace_recovery_swap(&store, active_key)?;
        match finish_pending_workspace_recovery_swap(&store) {
            Ok(true) => Ok(WorkspaceRecoverySwapOperation::Committed(next_primary)),
            Ok(false) | Err(_) => Ok(WorkspaceRecoverySwapOperation::RecoveryRequired),
        }
    })
    .await
    .map_err(|error| error.to_string())??;

    match operation {
        WorkspaceRecoverySwapOperation::Committed(contents) => {
            if ensure_workspace_access(&app, &state, permit).is_ok() {
                Ok(WorkspaceRecoverySwapResult {
                    status: WorkspaceRecoverySwapStatus::Committed,
                    contents: Some(contents),
                })
            } else {
                Ok(WorkspaceRecoverySwapResult {
                    status: WorkspaceRecoverySwapStatus::CommittedLocked,
                    contents: None,
                })
            }
        }
        WorkspaceRecoverySwapOperation::RecoveryRequired => {
            lock_workspace_runtime(&app, "workspace_recovery_swap_pending");
            Ok(WorkspaceRecoverySwapResult {
                status: WorkspaceRecoverySwapStatus::RecoveryRequired,
                contents: None,
            })
        }
    }
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
        prune_workspace_backups(&store, current_time_milliseconds()?)?;
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
    let permit = begin_workspace_access(&app, &state)?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let data_key = state.optional_data_key()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let active_key = active_workspace_key(&store, data_key.as_deref())?;
        read_backup_contents(&store, &id, active_key)
    })
    .await
    .map_err(|error| error.to_string())??;
    ensure_workspace_access(&app, &state, permit)?;
    Ok(result)
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
    let provider_for_recovery = Arc::clone(&provider);
    let metadata = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_workspace_transactions(&store, provider_for_recovery.as_ref())?;
        store.read_vault_metadata()
    })
    .await
    .map_err(|error| error.to_string())??;
    let encrypted = metadata.is_some();
    let idle_timeout_minutes = metadata
        .as_ref()
        .map(|value| value.idle_timeout_minutes)
        .unwrap_or_else(default_idle_timeout_minutes);
    state.set_idle_timeout(idle_timeout_minutes);
    Ok(WorkspaceSecurityStatus {
        encrypted,
        locked: encrypted && !state.is_unlocked()?,
        system_unlock_available: provider.available(),
        system_unlock_enabled: system_unlock_enabled(metadata.as_ref(), provider.as_ref()),
        idle_timeout_minutes,
    })
}

#[tauri::command]
pub async fn unlock_workspace(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    password: String,
) -> Result<WorkspaceSecurityStatus, String> {
    state.check_password_attempt_allowed()?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let password = Zeroizing::new(password);
    let provider = system_unlock_state.provider();
    let provider_for_unlock = Arc::clone(&provider);
    let unlock_result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_workspace_transactions(&store, provider_for_unlock.as_ref())?;
        let metadata = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        let data_key = unwrap_data_key(&metadata, &password)?;
        verify_encrypted_store(&store, &data_key)?;
        let system_unlock_enabled =
            system_unlock_enabled(Some(&metadata), provider_for_unlock.as_ref());
        Ok::<([u8; DATA_KEY_BYTES], bool, Option<u32>), String>((
            data_key,
            system_unlock_enabled,
            metadata.idle_timeout_minutes,
        ))
    })
    .await
    .map_err(|error| error.to_string())?;
    let (data_key, system_unlock_enabled, idle_timeout_minutes) = match unlock_result {
        Ok(result) => result,
        Err(error) => {
            if error == "workspace_vault_invalid_password" {
                state.record_password_failure();
            }
            return Err(error);
        }
    };
    state.set_idle_timeout(idle_timeout_minutes);
    state.replace_data_key(data_key)?;
    state.reset_password_failures();
    Ok(WorkspaceSecurityStatus {
        encrypted: true,
        locked: false,
        system_unlock_available: provider.available(),
        system_unlock_enabled,
        idle_timeout_minutes,
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
    let (data_key, idle_timeout_minutes) = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_workspace_transactions(&store, provider_for_unlock.as_ref())?;
        let metadata = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        let data_key = unwrap_data_key_with_system(&metadata, provider_for_unlock.as_ref())?;
        verify_encrypted_store(&store, &data_key)?;
        Ok::<([u8; DATA_KEY_BYTES], Option<u32>), String>((data_key, metadata.idle_timeout_minutes))
    })
    .await
    .map_err(|error| error.to_string())??;
    state.set_idle_timeout(idle_timeout_minutes);
    state.replace_data_key(data_key)?;
    state.reset_password_failures();
    Ok(WorkspaceSecurityStatus {
        encrypted: true,
        locked: false,
        system_unlock_available: true,
        system_unlock_enabled: true,
        idle_timeout_minutes,
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
        idle_timeout_minutes: default_idle_timeout_minutes(),
    })
}

#[tauri::command]
pub async fn change_workspace_password(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    password: String,
    authorization: String,
) -> Result<(), String> {
    validate_new_password(&password)?;
    let permit = state
        .consume_sensitive_authorization(SensitiveOperation::ChangePassword, &authorization)?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let access_generation = state.access_generation();
    let data_key = state.data_key()?;
    let password = Zeroizing::new(password);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        ensure_access_generation(&access_generation, Some(permit))?;
        recover_pending_migration(&store)?;
        let previous = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        let metadata = rewrap_vault_metadata(previous, &password, &data_key)?;
        let serialized = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
        write_atomically(&store.vault_path(), &serialized).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    ensure_workspace_access(&app, &state, Some(permit))
}

#[tauri::command]
pub async fn rotate_workspace_data_key(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    smart_reference_cache_state: tauri::State<
        '_,
        crate::smart_reference_cache::SmartReferenceCacheState,
    >,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    password: String,
    authorization: String,
) -> Result<(), String> {
    validate_new_password(&password)?;
    let _permit =
        state.consume_sensitive_authorization(SensitiveOperation::RotateDataKey, &authorization)?;
    let previous_data_key = state.data_key()?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let provider = system_unlock_state.provider();
    let password = Zeroizing::new(password);

    crate::smart_reference_cache::purge(&app, &smart_reference_cache_state).await?;
    state.revoke_access()?;
    cleanup_locked_workspace(&app);
    crate::secret_clipboard::clear_active(&app);
    let rotation_result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_workspace_transactions(&store, provider.as_ref())?;
        rotate_encrypted_store(&store, &previous_data_key, &password, provider.as_ref())
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);

    let event_reason = if rotation_result.is_ok() {
        "workspace_data_key_rotated"
    } else {
        "workspace_data_key_rotation_failed"
    };
    let _ = app.emit(WORKSPACE_LOCKED_EVENT, event_reason);
    rotation_result
}

#[tauri::command]
pub async fn authorize_sensitive_operation(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    operation: SensitiveOperation,
    authentication: SensitiveAuthentication,
) -> Result<String, String> {
    let permit = begin_workspace_access(&app, &state)?
        .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
    let active_data_key = state.data_key()?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let provider = system_unlock_state.provider();

    let verified_data_key = match authentication {
        SensitiveAuthentication::Password { password } => {
            state.check_password_attempt_allowed()?;
            let password = Zeroizing::new(password);
            let result = tauri::async_runtime::spawn_blocking(move || {
                let _guard = operation_lock
                    .lock()
                    .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
                recover_pending_migration(&store)?;
                let metadata = store
                    .read_vault_metadata()?
                    .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
                unwrap_data_key(&metadata, &password)
            })
            .await
            .map_err(|error| error.to_string())?;
            match result {
                Ok(data_key) => {
                    state.reset_password_failures();
                    data_key
                }
                Err(error) => {
                    if error == "workspace_vault_invalid_password" {
                        state.record_password_failure();
                    }
                    return Err(error);
                }
            }
        }
        SensitiveAuthentication::System { message } => {
            if !provider.available() {
                return Err("system_unlock_unavailable".to_owned());
            }
            crate::system_unlock::verify_user_presence(&app, message).await?;
            ensure_workspace_access(&app, &state, Some(permit))?;
            let provider_for_authentication = Arc::clone(&provider);
            tauri::async_runtime::spawn_blocking(move || {
                let _guard = operation_lock
                    .lock()
                    .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
                recover_pending_migration(&store)?;
                let metadata = store
                    .read_vault_metadata()?
                    .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
                unwrap_data_key_with_system(&metadata, provider_for_authentication.as_ref())
            })
            .await
            .map_err(|error| error.to_string())??
        }
    };

    ensure_workspace_access(&app, &state, Some(permit))?;
    if verified_data_key != *active_data_key {
        return Err("workspace_vault_reauthentication_failed".to_owned());
    }
    state.issue_sensitive_authorization(operation, permit)
}

#[tauri::command]
pub async fn enable_system_unlock(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    message: String,
) -> Result<WorkspaceSecurityStatus, String> {
    let permit = begin_workspace_access(&app, &state)?
        .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
    let provider = system_unlock_state.provider();
    if !provider.available() {
        return Err("system_unlock_unavailable".to_owned());
    }
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let access_generation = state.access_generation();
    let data_key = state.data_key()?;
    crate::system_unlock::verify_user_presence(&app, message).await?;
    ensure_workspace_access(&app, &state, Some(permit))?;
    let provider_for_enable = Arc::clone(&provider);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        ensure_access_generation(&access_generation, Some(permit))?;
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
    ensure_workspace_access(&app, &state, Some(permit))?;
    Ok(WorkspaceSecurityStatus {
        encrypted: true,
        locked: false,
        system_unlock_available: true,
        system_unlock_enabled: true,
        idle_timeout_minutes: state.idle_timeout_minutes(),
    })
}

#[tauri::command]
pub async fn disable_system_unlock(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    authorization: String,
) -> Result<WorkspaceSecurityStatus, String> {
    let permit = state
        .consume_sensitive_authorization(SensitiveOperation::SystemUnlockChange, &authorization)?;
    let provider = system_unlock_state.provider();
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let access_generation = state.access_generation();
    let provider_for_disable = Arc::clone(&provider);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        ensure_access_generation(&access_generation, Some(permit))?;
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
    ensure_workspace_access(&app, &state, Some(permit))?;
    Ok(WorkspaceSecurityStatus {
        encrypted: true,
        locked: false,
        system_unlock_available: provider.available(),
        system_unlock_enabled: false,
        idle_timeout_minutes: state.idle_timeout_minutes(),
    })
}

#[tauri::command]
pub async fn set_workspace_idle_timeout(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    minutes: Option<u32>,
) -> Result<WorkspaceSecurityStatus, String> {
    validate_idle_timeout_minutes(minutes)?;
    let permit = begin_workspace_access(&app, &state)?
        .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let access_generation = state.access_generation();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        ensure_access_generation(&access_generation, Some(permit))?;
        recover_pending_migration(&store)?;
        let mut metadata = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        metadata.idle_timeout_minutes = minutes;
        let serialized = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
        write_atomically(&store.vault_path(), &serialized).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    state.set_idle_timeout(minutes);
    state.record_activity();
    inspect_workspace_security(app, state, system_unlock_state).await
}

#[tauri::command]
pub async fn clear_workspace_recovery_data(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    authorization: String,
) -> Result<(), String> {
    let permit = state
        .consume_sensitive_authorization(SensitiveOperation::ClearRecoveryData, &authorization)?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let access_generation = state.access_generation();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        ensure_access_generation(&access_generation, Some(permit))?;
        recover_pending_migration(&store)?;
        let recovery = store.path(WorkspaceFileSlot::Recovery);
        let pending_recovery = store.pending_path(WorkspaceFileSlot::Recovery);
        remove_file_if_exists(&recovery)?;
        remove_file_if_exists(&pending_recovery)?;
        remove_workspace_subdirectory(&store.base_directory, &store.backup_directory())?;
        remove_workspace_subdirectory(&store.base_directory, &store.pending_backup_directory())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| error.to_string())??;
    ensure_workspace_access(&app, &state, Some(permit))?;
    Ok(())
}

#[tauri::command]
pub async fn destroy_workspace(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    smart_reference_cache_state: tauri::State<
        '_,
        crate::smart_reference_cache::SmartReferenceCacheState,
    >,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    authorization: String,
) -> Result<(), String> {
    let _permit = state
        .consume_sensitive_authorization(SensitiveOperation::DestroyWorkspace, &authorization)?;
    crate::smart_reference_cache::purge(&app, &smart_reference_cache_state).await?;
    lock_workspace_runtime(&app, "workspace_destroy");

    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let provider = system_unlock_state.provider();
    let destruction_result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        let metadata = store.read_vault_metadata()?;
        if let Some(credential) = metadata.and_then(|metadata| metadata.system_unlock)
            && credential.provider == provider.provider_id()
        {
            provider.delete(&credential.credential_id)?;
        }
        remove_all_workspace_files(&store)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    if let Err(error) = destruction_result {
        let _ = app.emit(WORKSPACE_LOCKED_EVENT, "workspace_destroy_failed");
        return Err(error);
    }

    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn record_workspace_activity(state: tauri::State<'_, WorkspaceVaultState>) {
    state.record_activity();
}

#[tauri::command]
pub async fn lock_workspace(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
) -> Result<WorkspaceSecurityStatus, String> {
    lock_workspace_runtime(&app, "manual");
    inspect_workspace_security(app, state, system_unlock_state).await
}

#[tauri::command]
pub async fn encrypt_workspace_export(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    contents: String,
    authorization: String,
) -> Result<String, String> {
    let permit = state
        .consume_sensitive_authorization(SensitiveOperation::ExportWorkspace, &authorization)?;
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let access_generation = state.access_generation();
    let data_key = state.data_key()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        ensure_access_generation(&access_generation, Some(permit))?;
        workspace_storage_from_export(&contents)
            .map_err(|_| "workspace_export_invalid_data".to_owned())?;
        let metadata = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        encrypt_export(&contents, &metadata, &data_key)
    })
    .await
    .map_err(|error| error.to_string())??;
    ensure_workspace_access(&app, &state, Some(permit))?;
    Ok(result)
}

pub(crate) async fn encrypt_offsite_workspace_snapshot(
    app: &AppHandle,
    state: &WorkspaceVaultState,
    contents: String,
) -> Result<String, String> {
    let permit = begin_workspace_access(app, state)?;
    let contents = Zeroizing::new(contents);
    let store = workspace_store(app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let access_generation = state.access_generation();
    let data_key = state.data_key()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        ensure_access_generation(&access_generation, permit)?;
        workspace_storage_from_export(&contents)
            .map_err(|_| "workspace_export_invalid_data".to_owned())?;
        let metadata = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
        encrypt_export(&contents, &metadata, &data_key)
    })
    .await
    .map_err(|error| error.to_string())??;
    ensure_workspace_access(app, state, permit)?;
    Ok(result)
}

pub(crate) fn test_offsite_workspace_restore(
    contents: &str,
    password: &str,
    access_generation: Option<&AtomicU64>,
    permit: Option<WorkspaceAccessPermit>,
) -> Result<(), String> {
    test_offsite_workspace_restore_with_context(contents, password, access_generation, permit, None)
}

struct CurrentWorkspaceRestoreContext<'a> {
    metadata: &'a VaultMetadata,
    data_key: &'a [u8; DATA_KEY_BYTES],
}

pub(crate) async fn test_current_offsite_workspace_restore(
    app: &AppHandle,
    state: &WorkspaceVaultState,
    contents: String,
    password: String,
    permit: WorkspaceAccessPermit,
) -> Result<(), String> {
    let store = workspace_store(app).map_err(|error| error.to_string())?;
    let current_metadata = store
        .read_vault_metadata()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
    let current_data_key = state.data_key()?;
    let access_generation = state.access_generation();
    let contents = Zeroizing::new(contents);
    let password = Zeroizing::new(password);
    let result = tauri::async_runtime::spawn_blocking(move || {
        test_offsite_workspace_restore_with_context(
            contents.as_str(),
            password.as_str(),
            Some(&access_generation),
            Some(permit),
            Some(CurrentWorkspaceRestoreContext {
                metadata: &current_metadata,
                data_key: &*current_data_key,
            }),
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    ensure_workspace_access(app, state, Some(permit))?;
    result
}

fn test_offsite_workspace_restore_with_context(
    contents: &str,
    password: &str,
    access_generation: Option<&AtomicU64>,
    permit: Option<WorkspaceAccessPermit>,
    current: Option<CurrentWorkspaceRestoreContext<'_>>,
) -> Result<(), String> {
    ensure_restore_drill_access(access_generation, permit)?;
    let (envelope, data_key, plaintext) = match open_encrypted_export(contents, password) {
        Ok(opened) => opened,
        Err(error) if error == "workspace_vault_invalid_password" && current.is_some() => {
            let envelope = parse_encrypted_export(contents)?;
            return Err(classify_restore_password_failure(
                &envelope,
                password,
                current.expect("restore context was checked"),
            ));
        }
        Err(error) => return Err(error),
    };
    let plaintext = Zeroizing::new(plaintext);
    let expected_workspace = workspace_storage_from_export(plaintext.as_str())
        .map_err(|_| "workspace_restore_invalid_data".to_owned())?;
    ensure_restore_drill_access(access_generation, permit)?;
    let directory = std::env::temp_dir().join(format!(
        "linked-info-offsite-restore-drill-{}",
        uuid::Uuid::new_v4()
    ));
    if directory.exists() {
        return Err("workspace_restore_drill_directory_conflict".to_owned());
    }
    let store = WorkspaceFileStore::new(directory.clone());
    let result = (|| {
        ensure_restore_drill_access(access_generation, permit)?;
        let installed_key = install_prepared_workspace_restore(
            &store,
            PreparedWorkspaceRestore {
                id: uuid::Uuid::new_v4(),
                expires_at_milliseconds: u64::MAX,
                envelope,
                data_key: Zeroizing::new(data_key),
            },
        )?;
        let installed_key = Zeroizing::new(installed_key);
        ensure_restore_drill_access(access_generation, permit)?;
        let installed_metadata = store
            .read_vault_metadata()?
            .ok_or_else(|| "workspace_restore_drill_vault_missing".to_owned())?;
        if installed_metadata.system_unlock.is_some() {
            return Err("workspace_restore_drill_device_unlock_migrated".to_owned());
        }
        if unwrap_data_key(&installed_metadata, password)? != *installed_key {
            return Err("workspace_restore_drill_password_unlock_failed".to_owned());
        }
        let installed_workspace = Zeroizing::new(
            store
                .read(WorkspaceFileSlot::Primary, Some(&installed_key))?
                .ok_or_else(|| "workspace_restore_drill_workspace_missing".to_owned())?,
        );
        if installed_workspace.as_str() != expected_workspace {
            return Err("workspace_restore_drill_workspace_mismatch".to_owned());
        }
        ensure_restore_drill_access(access_generation, permit)?;
        Ok(())
    })();
    let cleanup = match fs::remove_dir_all(&directory) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    };
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(_)) => Err("workspace_restore_drill_cleanup_failed".to_owned()),
        (Err(error), Err(_)) => Err(format!("{error}:workspace_restore_drill_cleanup_failed")),
    }
}

fn classify_restore_password_failure(
    envelope: &EncryptedExportEnvelope,
    password: &str,
    current: CurrentWorkspaceRestoreContext<'_>,
) -> String {
    let current_password_key = match unwrap_data_key(current.metadata, password) {
        Ok(data_key) => data_key,
        Err(_) => return "workspace_restore_password_rejected_by_current_workspace".to_owned(),
    };
    if current_password_key != *current.data_key {
        return "workspace_restore_current_workspace_key_mismatch".to_owned();
    }
    if envelope.kdf == current.metadata.kdf
        && envelope.wrapped_data_key == current.metadata.wrapped_data_key
    {
        return "workspace_restore_snapshot_wrap_inconsistent".to_owned();
    }
    match decrypt_bytes(&envelope.payload, current.data_key, EXPORT_PAYLOAD_AAD) {
        Ok(plaintext) => {
            let _plaintext = Zeroizing::new(plaintext);
            "workspace_restore_snapshot_wrap_mismatch".to_owned()
        }
        Err(_) => "workspace_restore_snapshot_key_mismatch_or_corrupt".to_owned(),
    }
}

fn ensure_restore_drill_access(
    access_generation: Option<&AtomicU64>,
    permit: Option<WorkspaceAccessPermit>,
) -> Result<(), String> {
    match (access_generation, permit) {
        (Some(access_generation), Some(permit)) => {
            ensure_access_generation(access_generation, Some(permit))
        }
        (None, None) => Ok(()),
        _ => Err("workspace_vault_session_expired".to_owned()),
    }
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

#[tauri::command]
pub async fn prepare_workspace_restore(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    contents: String,
    password: String,
) -> Result<PreparedWorkspaceRestorePreview, String> {
    if workspace_encryption_configured(&app) {
        return Err("workspace_restore_requires_unconfigured_vault".to_owned());
    }
    state.check_password_attempt_allowed()?;
    let contents = Zeroizing::new(contents);
    let password = Zeroizing::new(password);
    let opened = tauri::async_runtime::spawn_blocking(move || {
        open_encrypted_export(contents.as_str(), password.as_str())
    })
    .await
    .map_err(|error| error.to_string())?;
    let (envelope, data_key, plaintext) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            if error == "workspace_vault_invalid_password" {
                state.record_password_failure();
            }
            return Err(error);
        }
    };
    workspace_storage_from_export(&plaintext)
        .map_err(|_| "workspace_restore_invalid_data".to_owned())?;
    let id = uuid::Uuid::new_v4();
    let expires_at_milliseconds =
        now_milliseconds_lossy().saturating_add(PREPARED_RESTORE_TTL_MILLISECONDS);
    *state
        .prepared_restore
        .lock()
        .map_err(|_| "workspace_restore_state_unavailable".to_owned())? =
        Some(PreparedWorkspaceRestore {
            id,
            expires_at_milliseconds,
            envelope,
            data_key: Zeroizing::new(data_key),
        });
    let prepared_restore = Arc::clone(&state.prepared_restore);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(
            PREPARED_RESTORE_TTL_MILLISECONDS,
        ))
        .await;
        if let Ok(mut pending) = prepared_restore.lock() {
            if pending.as_ref().is_some_and(|restore| restore.id == id) {
                *pending = None;
            }
        }
    });
    state.reset_password_failures();
    Ok(PreparedWorkspaceRestorePreview { id, plaintext })
}

#[tauri::command]
pub async fn cancel_workspace_restore(
    state: tauri::State<'_, WorkspaceVaultState>,
    restore_id: uuid::Uuid,
) -> Result<(), String> {
    let mut pending = state
        .prepared_restore
        .lock()
        .map_err(|_| "workspace_restore_state_unavailable".to_owned())?;
    if pending.as_ref().is_some_and(|restore| {
        restore.id == restore_id && restore.expires_at_milliseconds >= now_milliseconds_lossy()
    }) {
        *pending = None;
        Ok(())
    } else {
        Err("workspace_restore_not_prepared".to_owned())
    }
}

#[tauri::command]
pub async fn commit_workspace_restore(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceVaultState>,
    vector_cache_state: tauri::State<'_, crate::vector_cache::VectorCacheState>,
    smart_reference_cache_state: tauri::State<
        '_,
        crate::smart_reference_cache::SmartReferenceCacheState,
    >,
    embedding_state: tauri::State<'_, crate::embedding::EmbeddingState>,
    llm_state: tauri::State<'_, crate::llm::LlmState>,
    system_unlock_state: tauri::State<'_, SystemUnlockState>,
    restore_id: uuid::Uuid,
) -> Result<WorkspaceSecurityStatus, String> {
    crate::vector_cache::purge_for_encryption(&app, &vector_cache_state).await?;
    crate::smart_reference_cache::purge(&app, &smart_reference_cache_state).await?;
    let prepared = {
        let mut pending = state
            .prepared_restore
            .lock()
            .map_err(|_| "workspace_restore_state_unavailable".to_owned())?;
        if pending.as_ref().is_none_or(|restore| {
            restore.id != restore_id || restore.expires_at_milliseconds < now_milliseconds_lossy()
        }) {
            return Err("workspace_restore_not_prepared".to_owned());
        }
        pending
            .take()
            .ok_or_else(|| "workspace_restore_not_prepared".to_owned())?
    };
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    let operation_lock = Arc::clone(&state.operation_lock);
    let data_key = tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        recover_pending_migration(&store)?;
        if store.encryption_configured() {
            return Err("workspace_vault_already_configured".to_owned());
        }
        install_prepared_workspace_restore(&store, prepared)
    })
    .await
    .map_err(|error| error.to_string())??;
    state.replace_data_key(data_key)?;
    state.set_idle_timeout(default_idle_timeout_minutes());
    crate::vector_cache::purge_for_encryption(&app, &vector_cache_state).await?;
    let _ = embedding_state.shutdown();
    llm_state.shutdown();
    Ok(WorkspaceSecurityStatus {
        encrypted: true,
        locked: false,
        system_unlock_available: system_unlock_state.provider().available(),
        system_unlock_enabled: false,
        idle_timeout_minutes: default_idle_timeout_minutes(),
    })
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

pub fn begin_workspace_access(
    app: &AppHandle,
    state: &WorkspaceVaultState,
) -> Result<Option<WorkspaceAccessPermit>, String> {
    if workspace_encryption_configured(app) {
        state.access_permit().map(Some)
    } else {
        Ok(None)
    }
}

pub fn ensure_workspace_access(
    app: &AppHandle,
    state: &WorkspaceVaultState,
    permit: Option<WorkspaceAccessPermit>,
) -> Result<(), String> {
    match permit {
        Some(permit) => state.ensure_access_permit(permit),
        None if workspace_encryption_configured(app) => {
            Err("workspace_vault_session_expired".to_owned())
        }
        None => Ok(()),
    }
}

pub(crate) fn ensure_access_generation(
    access_generation: &AtomicU64,
    permit: Option<WorkspaceAccessPermit>,
) -> Result<(), String> {
    match permit {
        Some(permit) if access_generation.load(Ordering::Acquire) == permit.generation => Ok(()),
        Some(_) => Err("workspace_vault_session_expired".to_owned()),
        None => Ok(()),
    }
}

pub fn revoke_workspace_access(app: &AppHandle, reason: &str) -> bool {
    let state = app.state::<WorkspaceVaultState>();
    let was_unlocked = state.shutdown();
    if was_unlocked {
        let _ = app.emit(WORKSPACE_LOCKED_EVENT, reason);
    }
    was_unlocked
}

pub fn cleanup_locked_workspace(app: &AppHandle) {
    let _ = app.state::<crate::embedding::EmbeddingState>().shutdown();
    app.state::<crate::llm::LlmState>().shutdown();
}

pub fn lock_workspace_runtime(app: &AppHandle, reason: &str) -> bool {
    let was_unlocked = revoke_workspace_access(app, reason);
    cleanup_locked_workspace(app);
    crate::secret_clipboard::clear_active(app);
    was_unlocked
}

fn validate_new_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MINIMUM_PASSWORD_CHARACTERS {
        return Err("workspace_vault_password_too_short".to_owned());
    }
    if password.len() > MAXIMUM_PASSWORD_BYTES {
        return Err("workspace_vault_password_too_long".to_owned());
    }
    let normalized = password
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if PASSWORD_BLOCKLIST.contains(&normalized.as_str()) {
        return Err("workspace_vault_password_blocked".to_owned());
    }
    Ok(())
}

fn validate_unlock_password(password: &str) -> Result<(), String> {
    if password.is_empty() || password.len() > MAXIMUM_PASSWORD_BYTES {
        return Err("workspace_vault_invalid_password".to_owned());
    }
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn remove_workspace_subdirectory(base_directory: &Path, target: &Path) -> Result<(), String> {
    if target == base_directory || !target.starts_with(base_directory) {
        return Err("workspace_vault_invalid_cleanup_path".to_owned());
    }
    match fs::remove_dir_all(target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn remove_all_workspace_files(store: &WorkspaceFileStore) -> Result<(), String> {
    for slot in [WorkspaceFileSlot::Primary, WorkspaceFileSlot::Recovery] {
        remove_file_if_exists(&store.path(slot))?;
        remove_file_if_exists(&store.pending_path(slot))?;
    }
    remove_workspace_subdirectory(&store.base_directory, &store.backup_directory())?;
    remove_workspace_subdirectory(&store.base_directory, &store.pending_backup_directory())?;
    remove_workspace_subdirectory(&store.base_directory, &store.data_key_rotation_directory())?;
    remove_workspace_subdirectory(&store.base_directory, &store.recovery_swap_directory())?;
    remove_file_if_exists(&store.pending_vault_path())?;
    remove_file_if_exists(&store.vault_path())?;
    sync_parent_directory(&store.base_directory).map_err(|error| error.to_string())
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
        let state = (|| {
            let contents = WorkspaceFileStore::read_text_path(&file.path)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "workspace_backup_missing".to_owned())?;
            let plaintext = backup_plaintext(&contents, data_key)?;
            validate_storage_envelope(&plaintext).map_err(|error| error.to_string())
        })()
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
        maximum_age_ms: BACKUP_MAXIMUM_AGE_MILLISECONDS,
        interval_ms: BACKUP_INTERVAL_MILLISECONDS,
    })
}

fn capture_workspace_backup_at(
    store: &WorkspaceFileStore,
    data_key: Option<&[u8; DATA_KEY_BYTES]>,
    now_ms: u64,
) -> Result<WorkspaceBackupCaptureResult, String> {
    prune_workspace_backups(store, now_ms)?;
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
    prune_workspace_backups(store, now_ms)?;
    Ok(WorkspaceBackupCaptureResult {
        created: true,
        status: inspect_backup_history(store, data_key)?,
    })
}

fn prune_workspace_backups(store: &WorkspaceFileStore, now_ms: u64) -> Result<(), String> {
    let mut files = store.backup_files()?;
    for expired in files
        .iter()
        .filter(|file| now_ms.saturating_sub(file.created_at_ms) > BACKUP_MAXIMUM_AGE_MILLISECONDS)
    {
        fs::remove_file(&expired.path).map_err(|error| error.to_string())?;
    }
    files.retain(|file| {
        now_ms.saturating_sub(file.created_at_ms) <= BACKUP_MAXIMUM_AGE_MILLISECONDS
    });
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
        idle_timeout_minutes: default_idle_timeout_minutes(),
    })
}

fn rewrap_vault_metadata(
    previous: VaultMetadata,
    password: &str,
    data_key: &[u8; DATA_KEY_BYTES],
) -> Result<VaultMetadata, String> {
    let mut metadata = create_vault_metadata(password, data_key, previous.migrated_slots)?;
    metadata.system_unlock = previous.system_unlock;
    metadata.idle_timeout_minutes = previous.idle_timeout_minutes;
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
    validate_idle_timeout_minutes(metadata.idle_timeout_minutes)?;
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

fn serialize_workspace_for_slot(
    normalized: &str,
    slot: WorkspaceFileSlot,
    data_key: Option<&[u8; DATA_KEY_BYTES]>,
) -> Result<String, String> {
    match data_key {
        Some(key) => encrypt_workspace_file(normalized, slot, key),
        None => Ok(normalized.to_owned()),
    }
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
            let normalized =
                normalize_storage_envelope(&contents).map_err(|error| error.to_string())?;
            let encrypted = encrypt_workspace_file(&normalized, slot, &data_key)?;
            write_atomically(&store.pending_path(slot), encrypted.as_bytes())
                .map_err(|error| error.to_string())?;
            let verified = decrypt_workspace_file(&encrypted, slot, &data_key)?;
            if verified != normalized {
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

fn install_prepared_workspace_restore(
    store: &WorkspaceFileStore,
    prepared: PreparedWorkspaceRestore,
) -> Result<[u8; DATA_KEY_BYTES], String> {
    fs::create_dir_all(&store.base_directory).map_err(|error| error.to_string())?;
    let export_plaintext = decrypt_export_payload(&prepared.envelope, &prepared.data_key)?;
    let plaintext = workspace_storage_from_export(&export_plaintext)
        .map_err(|_| "workspace_restore_invalid_data".to_owned())?;
    let existing_primary = store
        .read_plaintext(WorkspaceFileSlot::Primary)
        .map_err(|error| error.to_string())?;
    let existing_recovery = store
        .read_plaintext(WorkspaceFileSlot::Recovery)
        .map_err(|error| error.to_string())?;
    let recovery = existing_primary.or(existing_recovery);
    if let Some(recovery) = recovery.as_deref() {
        validate_storage_envelope(recovery)
            .map_err(|_| "workspace_restore_invalid_existing_data".to_owned())?;
    }

    prepare_backup_migration(store, &prepared.data_key)?;
    let encrypted_primary =
        encrypt_workspace_file(&plaintext, WorkspaceFileSlot::Primary, &prepared.data_key)?;
    write_atomically(
        &store.pending_path(WorkspaceFileSlot::Primary),
        encrypted_primary.as_bytes(),
    )
    .map_err(|error| error.to_string())?;

    let mut migrated_slots = vec![WorkspaceFileSlot::Primary];
    if let Some(recovery) = recovery {
        let recovery = normalize_storage_envelope(&recovery).map_err(|error| error.to_string())?;
        let encrypted_recovery =
            encrypt_workspace_file(&recovery, WorkspaceFileSlot::Recovery, &prepared.data_key)?;
        write_atomically(
            &store.pending_path(WorkspaceFileSlot::Recovery),
            encrypted_recovery.as_bytes(),
        )
        .map_err(|error| error.to_string())?;
        migrated_slots.push(WorkspaceFileSlot::Recovery);
    }

    let metadata = VaultMetadata {
        format: VAULT_FORMAT.to_owned(),
        version: CRYPTO_VERSION,
        kdf: prepared.envelope.kdf,
        wrapped_data_key: prepared.envelope.wrapped_data_key,
        migrated_slots,
        system_unlock: None,
        idle_timeout_minutes: default_idle_timeout_minutes(),
    };
    let serialized = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
    write_atomically(&store.pending_vault_path(), &serialized)
        .map_err(|error| error.to_string())?;
    finish_pending_migration(store, &metadata)?;
    verify_encrypted_store(store, &prepared.data_key)?;
    Ok(*prepared.data_key)
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

fn recovery_swap_sha256(contents: &[u8]) -> String {
    format!("{:x}", Sha256::digest(contents))
}

fn validate_recovery_swap_manifest(manifest: &RecoverySwapManifest) -> Result<(), String> {
    let valid_hash =
        |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    if manifest.format != RECOVERY_SWAP_FORMAT
        || manifest.version != CRYPTO_VERSION
        || !valid_hash(&manifest.primary_sha256)
        || !valid_hash(&manifest.recovery_sha256)
    {
        Err("workspace_recovery_swap_invalid_manifest".to_owned())
    } else {
        Ok(())
    }
}

fn read_recovery_swap_manifest(
    store: &WorkspaceFileStore,
) -> Result<Option<RecoverySwapManifest>, String> {
    let directory = store.recovery_swap_directory();
    if !directory.exists() {
        return Ok(None);
    }
    let Some(contents) = WorkspaceFileStore::read_text_path(&store.recovery_swap_manifest_path())
        .map_err(|error| error.to_string())?
    else {
        remove_workspace_subdirectory(&store.base_directory, &directory)?;
        sync_parent_directory(&store.base_directory).map_err(|error| error.to_string())?;
        return Ok(None);
    };
    let manifest: RecoverySwapManifest = serde_json::from_str(&contents)
        .map_err(|_| "workspace_recovery_swap_invalid_manifest".to_owned())?;
    validate_recovery_swap_manifest(&manifest)?;
    Ok(Some(manifest))
}

fn read_recovery_swap_payload(
    store: &WorkspaceFileStore,
    slot: WorkspaceFileSlot,
    expected_sha256: &str,
) -> Result<Vec<u8>, String> {
    let contents = fs::read(store.recovery_swap_slot_path(slot))
        .map_err(|_| "workspace_recovery_swap_pending_file_missing".to_owned())?;
    if recovery_swap_sha256(&contents) != expected_sha256 {
        return Err("workspace_recovery_swap_pending_file_invalid".to_owned());
    }
    Ok(contents)
}

fn finish_pending_workspace_recovery_swap(store: &WorkspaceFileStore) -> Result<bool, String> {
    let Some(manifest) = read_recovery_swap_manifest(store)? else {
        return Ok(false);
    };
    let primary =
        read_recovery_swap_payload(store, WorkspaceFileSlot::Primary, &manifest.primary_sha256)?;
    let recovery = read_recovery_swap_payload(
        store,
        WorkspaceFileSlot::Recovery,
        &manifest.recovery_sha256,
    )?;

    write_atomically(&store.path(WorkspaceFileSlot::Primary), &primary)
        .map_err(|error| error.to_string())?;
    write_atomically(&store.path(WorkspaceFileSlot::Recovery), &recovery)
        .map_err(|error| error.to_string())?;
    sync_parent_directory(&store.base_directory).map_err(|error| error.to_string())?;
    remove_workspace_subdirectory(&store.base_directory, &store.recovery_swap_directory())?;
    sync_parent_directory(&store.base_directory).map_err(|error| error.to_string())?;
    Ok(true)
}

fn prepare_workspace_recovery_swap(
    store: &WorkspaceFileStore,
    data_key: Option<&[u8; DATA_KEY_BYTES]>,
) -> Result<String, String> {
    let primary = store
        .read(WorkspaceFileSlot::Primary, data_key)?
        .ok_or_else(|| "workspace_recovery_unavailable".to_owned())?;
    let recovery = store
        .read(WorkspaceFileSlot::Recovery, data_key)?
        .ok_or_else(|| "workspace_recovery_unavailable".to_owned())?;
    let primary = normalize_storage_envelope(&primary).map_err(|error| error.to_string())?;
    let recovery = normalize_storage_envelope(&recovery).map_err(|error| error.to_string())?;
    let next_primary =
        serialize_workspace_for_slot(&recovery, WorkspaceFileSlot::Primary, data_key)?;
    let next_recovery =
        serialize_workspace_for_slot(&primary, WorkspaceFileSlot::Recovery, data_key)?;
    let manifest = RecoverySwapManifest {
        format: RECOVERY_SWAP_FORMAT.to_owned(),
        version: CRYPTO_VERSION,
        primary_sha256: recovery_swap_sha256(next_primary.as_bytes()),
        recovery_sha256: recovery_swap_sha256(next_recovery.as_bytes()),
    };

    fs::create_dir_all(&store.base_directory).map_err(|error| error.to_string())?;
    let directory = store.recovery_swap_directory();
    fs::create_dir(&directory).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            "workspace_recovery_swap_pending".to_owned()
        } else {
            error.to_string()
        }
    })?;
    let prepare_result = (|| {
        write_atomically(
            &store.recovery_swap_slot_path(WorkspaceFileSlot::Primary),
            next_primary.as_bytes(),
        )
        .map_err(|error| error.to_string())?;
        write_atomically(
            &store.recovery_swap_slot_path(WorkspaceFileSlot::Recovery),
            next_recovery.as_bytes(),
        )
        .map_err(|error| error.to_string())?;
        let serialized = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
        write_atomically(&store.recovery_swap_manifest_path(), &serialized)
            .map_err(|error| error.to_string())?;
        sync_parent_directory(&directory).map_err(|error| error.to_string())?;
        sync_parent_directory(&store.base_directory).map_err(|error| error.to_string())
    })();
    if let Err(error) = prepare_result {
        let _ = remove_workspace_subdirectory(&store.base_directory, &directory);
        return Err(error);
    }
    Ok(recovery)
}

fn recover_pending_encryption_migration(store: &WorkspaceFileStore) -> Result<(), String> {
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

fn recover_pending_migration(store: &WorkspaceFileStore) -> Result<(), String> {
    recover_pending_encryption_migration(store)?;
    finish_pending_workspace_recovery_swap(store)?;
    if store.data_key_rotation_directory().exists() {
        return Err("workspace_vault_data_key_rotation_recovery_required".to_owned());
    }
    Ok(())
}

fn recover_pending_workspace_transactions(
    store: &WorkspaceFileStore,
    provider: &dyn SystemUnlockProvider,
) -> Result<(), String> {
    recover_pending_encryption_migration(store)?;
    finish_pending_workspace_recovery_swap(store)?;
    recover_pending_data_key_rotation(store, provider)
}

fn rotation_credential(envelope: &SystemUnlockEnvelope) -> RotationSystemCredential {
    RotationSystemCredential {
        provider: envelope.provider.clone(),
        credential_id: envelope.credential_id.clone(),
    }
}

fn validate_rotation_credential(credential: &RotationSystemCredential) -> Result<(), String> {
    if credential.provider.is_empty()
        || credential.provider.len() > 128
        || credential.credential_id.is_empty()
        || credential.credential_id.len() > 256
        || credential.provider.as_bytes().contains(&0)
        || credential.credential_id.as_bytes().contains(&0)
    {
        Err("workspace_vault_invalid_data_key_rotation_manifest".to_owned())
    } else {
        Ok(())
    }
}

fn validate_data_key_rotation_manifest(manifest: &DataKeyRotationManifest) -> Result<(), String> {
    if manifest.format != DATA_KEY_ROTATION_FORMAT || manifest.version != CRYPTO_VERSION {
        return Err("workspace_vault_invalid_data_key_rotation_manifest".to_owned());
    }
    if manifest.slots.len() > 2
        || manifest
            .slots
            .iter()
            .enumerate()
            .any(|(index, slot)| manifest.slots[..index].contains(slot))
    {
        return Err("workspace_vault_invalid_data_key_rotation_manifest".to_owned());
    }
    for (index, id) in manifest.backup_ids.iter().enumerate() {
        parse_backup_id(id)
            .map_err(|_| "workspace_vault_invalid_data_key_rotation_manifest".to_owned())?;
        if manifest.backup_ids[..index].contains(id) {
            return Err("workspace_vault_invalid_data_key_rotation_manifest".to_owned());
        }
    }
    if let Some(credential) = manifest.previous_system_credential.as_ref() {
        validate_rotation_credential(credential)?;
    }
    if let Some(credential) = manifest.next_system_credential.as_ref() {
        validate_rotation_credential(credential)?;
    }
    if manifest.previous_system_credential.is_some() != manifest.next_system_credential.is_some()
        || manifest
            .previous_system_credential
            .as_ref()
            .zip(manifest.next_system_credential.as_ref())
            .is_some_and(|(previous, next)| previous == next)
    {
        return Err("workspace_vault_invalid_data_key_rotation_manifest".to_owned());
    }
    Ok(())
}

fn read_data_key_rotation_manifest(
    store: &WorkspaceFileStore,
) -> Result<Option<DataKeyRotationManifest>, String> {
    let Some(contents) =
        WorkspaceFileStore::read_text_path(&store.data_key_rotation_manifest_path())
            .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let manifest: DataKeyRotationManifest = serde_json::from_str(&contents)
        .map_err(|_| "workspace_vault_invalid_data_key_rotation_manifest".to_owned())?;
    validate_data_key_rotation_manifest(&manifest)?;
    Ok(Some(manifest))
}

fn write_data_key_rotation_manifest(
    store: &WorkspaceFileStore,
    manifest: &DataKeyRotationManifest,
) -> Result<(), String> {
    validate_data_key_rotation_manifest(manifest)?;
    let serialized = serde_json::to_vec(manifest).map_err(|error| error.to_string())?;
    write_atomically(&store.data_key_rotation_manifest_path(), &serialized)
        .map_err(|error| error.to_string())
}

fn remove_data_key_rotation_directory(store: &WorkspaceFileStore) -> Result<(), String> {
    remove_workspace_subdirectory(&store.base_directory, &store.data_key_rotation_directory())
}

fn abort_pending_data_key_rotation(
    store: &WorkspaceFileStore,
    provider: &dyn SystemUnlockProvider,
) -> Result<(), String> {
    let Some(manifest) = read_data_key_rotation_manifest(store)? else {
        return remove_data_key_rotation_directory(store);
    };
    if let Some(credential) = manifest.next_system_credential.as_ref()
        && credential.provider == provider.provider_id()
    {
        provider.delete(&credential.credential_id)?;
    }
    remove_data_key_rotation_directory(store)
}

fn pending_rotation_file(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            "workspace_vault_pending_data_key_rotation_missing".to_owned()
        } else {
            error.to_string()
        }
    })
}

fn finish_pending_data_key_rotation(
    store: &WorkspaceFileStore,
    provider: &dyn SystemUnlockProvider,
    manifest: &DataKeyRotationManifest,
) -> Result<(), String> {
    if manifest.phase != DataKeyRotationPhase::Ready {
        return Err("workspace_vault_data_key_rotation_not_ready".to_owned());
    }
    let pending_vault = pending_rotation_file(&store.data_key_rotation_vault_path())?;
    let pending_metadata = parse_vault_metadata(
        std::str::from_utf8(&pending_vault)
            .map_err(|_| "workspace_vault_invalid_metadata".to_owned())?,
    )?;
    let pending_credential = pending_metadata
        .system_unlock
        .as_ref()
        .map(rotation_credential);
    if pending_credential != manifest.next_system_credential {
        return Err("workspace_vault_invalid_data_key_rotation_manifest".to_owned());
    }

    for slot in manifest.slots.iter().copied() {
        let contents = pending_rotation_file(&store.data_key_rotation_slot_path(slot))?;
        write_atomically(&store.path(slot), &contents).map_err(|error| error.to_string())?;
    }
    if !manifest.backup_ids.is_empty() {
        fs::create_dir_all(store.backup_directory()).map_err(|error| error.to_string())?;
    }
    for id in &manifest.backup_ids {
        let contents = pending_rotation_file(&store.data_key_rotation_backup_path(id)?)?;
        write_atomically(&store.backup_path(id)?, &contents).map_err(|error| error.to_string())?;
    }

    // The vault is the commit point. Before this write, startup recovery still
    // has everything needed to finish replacing files encrypted with the old key.
    write_atomically(&store.vault_path(), &pending_vault).map_err(|error| error.to_string())?;
    sync_parent_directory(&store.base_directory).map_err(|error| error.to_string())?;

    if let Some(credential) = manifest.previous_system_credential.as_ref()
        && credential.provider == provider.provider_id()
    {
        provider.delete(&credential.credential_id)?;
    }
    remove_data_key_rotation_directory(store)?;
    sync_parent_directory(&store.base_directory).map_err(|error| error.to_string())
}

fn recover_pending_data_key_rotation(
    store: &WorkspaceFileStore,
    provider: &dyn SystemUnlockProvider,
) -> Result<(), String> {
    if !store.data_key_rotation_directory().exists() {
        return Ok(());
    }
    let Some(manifest) = read_data_key_rotation_manifest(store)? else {
        return remove_data_key_rotation_directory(store);
    };
    match manifest.phase {
        DataKeyRotationPhase::Preparing => abort_pending_data_key_rotation(store, provider),
        DataKeyRotationPhase::Ready => finish_pending_data_key_rotation(store, provider, &manifest),
    }
}

fn prepare_data_key_rotation(
    store: &WorkspaceFileStore,
    previous_data_key: &[u8; DATA_KEY_BYTES],
    next_data_key: &[u8; DATA_KEY_BYTES],
    password: &str,
    provider: &dyn SystemUnlockProvider,
) -> Result<(), String> {
    let previous_metadata = store
        .read_vault_metadata()?
        .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
    verify_encrypted_store(store, previous_data_key)?;

    let mut slots = Vec::new();
    for slot in [WorkspaceFileSlot::Primary, WorkspaceFileSlot::Recovery] {
        if store.path(slot).is_file() {
            slots.push(slot);
        }
    }
    let backups = store.backup_files()?;
    let backup_ids = backups
        .iter()
        .map(|backup| backup.id.clone())
        .collect::<Vec<_>>();

    let previous_system_credential = previous_metadata
        .system_unlock
        .as_ref()
        .filter(|envelope| provider.available() && envelope.provider == provider.provider_id())
        .map(rotation_credential);
    let next_system_credential =
        previous_system_credential
            .as_ref()
            .map(|_| RotationSystemCredential {
                provider: provider.provider_id().to_owned(),
                credential_id: uuid::Uuid::new_v4().to_string(),
            });
    let mut manifest = DataKeyRotationManifest {
        format: DATA_KEY_ROTATION_FORMAT.to_owned(),
        version: CRYPTO_VERSION,
        phase: DataKeyRotationPhase::Preparing,
        slots,
        backup_ids,
        previous_system_credential,
        next_system_credential,
    };

    fs::create_dir_all(store.data_key_rotation_directory()).map_err(|error| error.to_string())?;
    write_data_key_rotation_manifest(store, &manifest)?;

    let preparation_result = (|| {
        let mut next_metadata = create_vault_metadata(
            password,
            next_data_key,
            previous_metadata.migrated_slots.clone(),
        )?;
        next_metadata.idle_timeout_minutes = previous_metadata.idle_timeout_minutes;

        if let Some(credential) = manifest.next_system_credential.as_ref() {
            let device_key = Zeroizing::new(random_array::<DATA_KEY_BYTES>()?);
            provider.store(&credential.credential_id, device_key.as_slice())?;
            next_metadata.system_unlock = Some(create_system_unlock_envelope(
                &credential.provider,
                &credential.credential_id,
                next_data_key,
                &device_key,
            )?);
        }

        for slot in manifest.slots.iter().copied() {
            let plaintext = store
                .read(slot, Some(previous_data_key))?
                .ok_or_else(|| "workspace_vault_rotation_workspace_missing".to_owned())?;
            let plaintext =
                normalize_storage_envelope(&plaintext).map_err(|error| error.to_string())?;
            let encrypted = encrypt_workspace_file(&plaintext, slot, next_data_key)?;
            write_atomically(
                &store.data_key_rotation_slot_path(slot),
                encrypted.as_bytes(),
            )
            .map_err(|error| error.to_string())?;
            if decrypt_workspace_file(&encrypted, slot, next_data_key)? != plaintext {
                return Err("workspace_vault_data_key_rotation_verification_failed".to_owned());
            }
        }

        if !backups.is_empty() {
            fs::create_dir_all(store.data_key_rotation_backup_directory())
                .map_err(|error| error.to_string())?;
        }
        for backup in &backups {
            let contents = WorkspaceFileStore::read_text_path(&backup.path)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "workspace_backup_missing".to_owned())?;
            let plaintext =
                decrypt_workspace_file(&contents, WorkspaceFileSlot::Primary, previous_data_key)
                    .map_err(|_| {
                        format!(
                            "workspace_vault_data_key_rotation_invalid_backup:{}",
                            backup.id
                        )
                    })?;
            let plaintext = normalize_storage_envelope(&plaintext).map_err(|_| {
                format!(
                    "workspace_vault_data_key_rotation_invalid_backup:{}",
                    backup.id
                )
            })?;
            let encrypted =
                encrypt_workspace_file(&plaintext, WorkspaceFileSlot::Primary, next_data_key)?;
            write_atomically(
                &store.data_key_rotation_backup_path(&backup.id)?,
                encrypted.as_bytes(),
            )
            .map_err(|error| error.to_string())?;
            if decrypt_workspace_file(&encrypted, WorkspaceFileSlot::Primary, next_data_key)?
                != plaintext
            {
                return Err("workspace_vault_data_key_rotation_verification_failed".to_owned());
            }
        }

        if unwrap_data_key(&next_metadata, password)? != *next_data_key {
            return Err("workspace_vault_data_key_rotation_verification_failed".to_owned());
        }
        let serialized = serde_json::to_vec(&next_metadata).map_err(|error| error.to_string())?;
        write_atomically(&store.data_key_rotation_vault_path(), &serialized)
            .map_err(|error| error.to_string())?;
        manifest.phase = DataKeyRotationPhase::Ready;
        write_data_key_rotation_manifest(store, &manifest)
    })();

    if let Err(error) = preparation_result {
        return match abort_pending_data_key_rotation(store, provider) {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "workspace_vault_data_key_rotation_abort_failed:{error}:{cleanup_error}"
            )),
        };
    }
    Ok(())
}

fn rotate_encrypted_store(
    store: &WorkspaceFileStore,
    previous_data_key: &[u8; DATA_KEY_BYTES],
    password: &str,
    provider: &dyn SystemUnlockProvider,
) -> Result<(), String> {
    if !store.encryption_configured() {
        return Err("workspace_vault_not_configured".to_owned());
    }
    let next_data_key = Zeroizing::new(random_array::<DATA_KEY_BYTES>()?);
    prepare_data_key_rotation(store, previous_data_key, &next_data_key, password, provider)?;
    let manifest = read_data_key_rotation_manifest(store)?
        .ok_or_else(|| "workspace_vault_pending_data_key_rotation_missing".to_owned())?;
    finish_pending_data_key_rotation(store, provider, &manifest)
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
        let contents = normalize_storage_envelope(&contents).map_err(|error| error.to_string())?;
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
    open_encrypted_export(contents, password).map(|(_, _, plaintext)| plaintext)
}

fn open_encrypted_export(
    contents: &str,
    password: &str,
) -> Result<(EncryptedExportEnvelope, [u8; DATA_KEY_BYTES], String), String> {
    let envelope = parse_encrypted_export(contents)?;
    let metadata = VaultMetadata {
        format: VAULT_FORMAT.to_owned(),
        version: CRYPTO_VERSION,
        kdf: envelope.kdf.clone(),
        wrapped_data_key: envelope.wrapped_data_key.clone(),
        migrated_slots: Vec::new(),
        system_unlock: None,
        idle_timeout_minutes: None,
    };
    let data_key = unwrap_data_key(&metadata, password)?;
    let plaintext = decrypt_export_payload(&envelope, &data_key)?;
    Ok((envelope, data_key, plaintext))
}

fn parse_encrypted_export(contents: &str) -> Result<EncryptedExportEnvelope, String> {
    let envelope: EncryptedExportEnvelope = serde_json::from_str(contents)
        .map_err(|_| "workspace_export_invalid_encrypted_envelope".to_owned())?;
    if envelope.format != ENCRYPTED_EXPORT_FORMAT || envelope.version != CRYPTO_VERSION {
        return Err("workspace_export_invalid_encrypted_envelope".to_owned());
    }
    Ok(envelope)
}

fn decrypt_export_payload(
    envelope: &EncryptedExportEnvelope,
    data_key: &[u8; DATA_KEY_BYTES],
) -> Result<String, String> {
    let plaintext = decrypt_bytes(&envelope.payload, data_key, EXPORT_PAYLOAD_AAD)?;
    String::from_utf8(plaintext).map_err(|_| "workspace_export_invalid_plaintext".to_owned())
}

fn invalid_workspace_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn canonical_workspace_node_id(value: &serde_json::Value) -> Option<String> {
    let value = value.as_str()?;
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || bytes[8] != b'-'
        || bytes[13] != b'-'
        || bytes[18] != b'-'
        || bytes[23] != b'-'
        || !(b'1'..=b'8').contains(&bytes[14])
        || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| !matches!(index, 8 | 13 | 18 | 23) && !byte.is_ascii_hexdigit())
    {
        return None;
    }
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|id| id.hyphenated().to_string())
}

fn finite_json_number(value: Option<&serde_json::Value>) -> Option<f64> {
    value
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite())
}

fn validate_workspace_snapshot(
    value: &serde_json::Value,
    allow_missing_view: bool,
) -> io::Result<()> {
    let workspace = value
        .as_object()
        .ok_or_else(|| invalid_workspace_data("workspace snapshot must be an object"))?;
    let nodes = workspace
        .get("nodes")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| invalid_workspace_data("workspace nodes must be an array"))?;
    let layout = workspace
        .get("layout")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| invalid_workspace_data("workspace layout must be an array"))?;
    let references = workspace
        .get("references")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| invalid_workspace_data("workspace references must be an array"))?;

    if let Some(viewport) = workspace.get("viewport").filter(|value| !value.is_null()) {
        let viewport = viewport
            .as_object()
            .ok_or_else(|| invalid_workspace_data("workspace viewport must be an object"))?;
        let _x = finite_json_number(viewport.get("x"))
            .ok_or_else(|| invalid_workspace_data("workspace viewport x must be finite"))?;
        let _y = finite_json_number(viewport.get("y"))
            .ok_or_else(|| invalid_workspace_data("workspace viewport y must be finite"))?;
        let zoom = finite_json_number(viewport.get("zoom"))
            .ok_or_else(|| invalid_workspace_data("workspace viewport zoom must be finite"))?;
        if zoom <= 0.0 {
            return Err(invalid_workspace_data(
                "workspace viewport zoom must be positive",
            ));
        }
    }

    let mut node_ids = HashSet::with_capacity(nodes.len());
    let mut normalized_names = HashSet::new();
    for node in nodes {
        let node = node
            .as_object()
            .ok_or_else(|| invalid_workspace_data("workspace node must be an object"))?;
        let id = canonical_workspace_node_id(
            node.get("id")
                .ok_or_else(|| invalid_workspace_data("workspace node id is missing"))?,
        )
        .ok_or_else(|| invalid_workspace_data("workspace node id is invalid"))?;
        if !node_ids.insert(id) {
            return Err(invalid_workspace_data("workspace node ids must be unique"));
        }

        match node.get("name") {
            Some(value) if value.is_null() => {}
            Some(value) if value.is_string() => {
                let name = value.as_str().unwrap_or_default().trim();
                let normalized = name.to_lowercase();
                if normalized.is_empty() || !normalized_names.insert(normalized) {
                    return Err(invalid_workspace_data(
                        "workspace non-empty node names must be unique",
                    ));
                }
            }
            _ => return Err(invalid_workspace_data("workspace node name is invalid")),
        }
        if !matches!(node.get("content"), Some(value) if value.is_null() || value.is_string()) {
            return Err(invalid_workspace_data("workspace node content is invalid"));
        }
    }

    if layout.len() != nodes.len() {
        return Err(invalid_workspace_data(
            "workspace layout must contain every node exactly once",
        ));
    }
    let mut layout_node_ids = HashSet::with_capacity(layout.len());
    for item in layout {
        let item = item
            .as_object()
            .ok_or_else(|| invalid_workspace_data("workspace layout item must be an object"))?;
        let node_id = canonical_workspace_node_id(
            item.get("nodeId")
                .ok_or_else(|| invalid_workspace_data("workspace layout node id is missing"))?,
        )
        .ok_or_else(|| invalid_workspace_data("workspace layout node id is invalid"))?;
        if !node_ids.contains(&node_id) || !layout_node_ids.insert(node_id) {
            return Err(invalid_workspace_data(
                "workspace layout node id is invalid",
            ));
        }
        finite_json_number(item.get("x"))
            .ok_or_else(|| invalid_workspace_data("workspace layout x must be finite"))?;
        finite_json_number(item.get("y"))
            .ok_or_else(|| invalid_workspace_data("workspace layout y must be finite"))?;
        if let Some(width) = item.get("width") {
            let width = finite_json_number(Some(width))
                .ok_or_else(|| invalid_workspace_data("workspace layout width must be finite"))?;
            if !(MINIMUM_MANUAL_NODE_WIDTH..=MAXIMUM_MANUAL_NODE_DIMENSION).contains(&width) {
                return Err(invalid_workspace_data(
                    "workspace layout width is out of range",
                ));
            }
        }
        if let Some(height) = item.get("height") {
            let height = finite_json_number(Some(height))
                .ok_or_else(|| invalid_workspace_data("workspace layout height must be finite"))?;
            if !(MINIMUM_MANUAL_NODE_HEIGHT..=MAXIMUM_MANUAL_NODE_DIMENSION).contains(&height) {
                return Err(invalid_workspace_data(
                    "workspace layout height is out of range",
                ));
            }
        }
    }

    let mut reference_keys = HashSet::with_capacity(references.len());
    for reference in references {
        let reference = reference
            .as_object()
            .ok_or_else(|| invalid_workspace_data("workspace reference must be an object"))?;
        let source =
            canonical_workspace_node_id(reference.get("sourceNodeId").ok_or_else(|| {
                invalid_workspace_data("workspace reference source node id is missing")
            })?)
            .ok_or_else(|| {
                invalid_workspace_data("workspace reference source node id is invalid")
            })?;
        let target =
            canonical_workspace_node_id(reference.get("targetNodeId").ok_or_else(|| {
                invalid_workspace_data("workspace reference target node id is missing")
            })?)
            .ok_or_else(|| {
                invalid_workspace_data("workspace reference target node id is invalid")
            })?;
        if !node_ids.contains(&source)
            || !node_ids.contains(&target)
            || !reference_keys.insert((source, target))
        {
            return Err(invalid_workspace_data("workspace reference is invalid"));
        }
    }

    match workspace.get("view").filter(|_| !allow_missing_view) {
        Some(view) => {
            let processors = view
                .as_object()
                .and_then(|view| view.get("contentProcessorByNodeId"))
                .and_then(serde_json::Value::as_object)
                .ok_or_else(|| invalid_workspace_data("workspace view metadata is invalid"))?;
            let mut processor_node_ids = HashSet::with_capacity(processors.len());
            for (node_id, processor_id) in processors {
                let canonical_node_id =
                    canonical_workspace_node_id(&serde_json::Value::String(node_id.to_owned()))
                        .ok_or_else(|| {
                            invalid_workspace_data("workspace processor node id is invalid")
                        })?;
                let processor_id = processor_id.as_str().ok_or_else(|| {
                    invalid_workspace_data("workspace content processor id is invalid")
                })?;
                if !node_ids.contains(&canonical_node_id)
                    || !processor_node_ids.insert(canonical_node_id)
                    || processor_id == "text"
                    || processor_id.is_empty()
                    || processor_id.len() > 128
                    || !processor_id.bytes().enumerate().all(|(index, byte)| {
                        byte.is_ascii_lowercase()
                            || byte.is_ascii_digit()
                            || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
                    })
                {
                    return Err(invalid_workspace_data(
                        "workspace content processor selection is invalid",
                    ));
                }
            }
        }
        None if allow_missing_view => {}
        None => return Err(invalid_workspace_data("workspace view metadata is missing")),
    }
    Ok(())
}

fn validate_storage_envelope(contents: &str) -> io::Result<()> {
    normalize_storage_envelope(contents).map(|_| ())
}

fn normalize_storage_envelope(contents: &str) -> io::Result<String> {
    let mut value: serde_json::Value = serde_json::from_str(contents)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let version = value.get("version").and_then(serde_json::Value::as_u64);
    if !matches!(version, Some(1) | Some(CURRENT_WORKSPACE_STORAGE_VERSION)) {
        return Err(invalid_workspace_data(
            "workspace storage envelope version is unsupported",
        ));
    }
    validate_workspace_snapshot(&value, version == Some(1))?;
    if version == Some(1) {
        let workspace = value
            .as_object_mut()
            .ok_or_else(|| invalid_workspace_data("workspace snapshot must be an object"))?;
        workspace.insert(
            "view".to_owned(),
            serde_json::json!({ "contentProcessorByNodeId": {} }),
        );
    }
    value["version"] = serde_json::Value::from(CURRENT_WORKSPACE_STORAGE_VERSION);
    serde_json::to_string(&value).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn workspace_storage_from_export(contents: &str) -> io::Result<String> {
    let value: serde_json::Value = serde_json::from_str(contents)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let document = value
        .as_object()
        .ok_or_else(|| invalid_workspace_data("workspace export must be an object"))?;
    if document.get("format").and_then(serde_json::Value::as_str) != Some(WORKSPACE_EXPORT_FORMAT)
        || !matches!(
            document.get("version").and_then(serde_json::Value::as_u64),
            Some(1) | Some(2)
        )
        || document
            .get("exportedAt")
            .and_then(serde_json::Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err(invalid_workspace_data(
            "workspace export envelope is invalid",
        ));
    }
    let workspace = document
        .get("workspace")
        .ok_or_else(|| invalid_workspace_data("workspace export payload is missing"))?;
    let export_version = document
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .expect("validated export version");
    validate_workspace_snapshot(workspace, export_version == 1)?;
    let mut storage = workspace
        .as_object()
        .cloned()
        .ok_or_else(|| invalid_workspace_data("workspace export payload must be an object"))?;
    if export_version == 1 {
        storage.insert(
            "view".to_owned(),
            serde_json::json!({ "contentProcessorByNodeId": {} }),
        );
    }
    storage.insert(
        "version".to_owned(),
        serde_json::Value::from(CURRENT_WORKSPACE_STORAGE_VERSION),
    );
    serde_json::to_string(&storage)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub(crate) fn write_atomically(target: &Path, contents: &[u8]) -> io::Result<()> {
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
            "version": CURRENT_WORKSPACE_STORAGE_VERSION,
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
            "viewport": null,
            "view": { "contentProcessorByNodeId": {} }
        })
        .to_string()
    }

    fn workspace_export(name: &str) -> String {
        let mut workspace: serde_json::Value =
            serde_json::from_str(&workspace(name)).expect("test workspace must be JSON");
        workspace
            .as_object_mut()
            .expect("test workspace must be an object")
            .remove("version");
        serde_json::json!({
            "format": WORKSPACE_EXPORT_FORMAT,
            "version": 2,
            "exportedAt": "2026-08-13T00:00:00.000Z",
            "workspace": workspace
        })
        .to_string()
    }

    #[test]
    fn storage_validation_rejects_semantically_invalid_graphs() {
        let mut duplicate_name: serde_json::Value =
            serde_json::from_str(&workspace("OpenAI")).unwrap();
        duplicate_name["nodes"] = serde_json::json!([
            {
                "id": "11111111-1111-4111-8111-111111111111",
                "name": "OpenAI",
                "content": null
            },
            {
                "id": "22222222-2222-4222-8222-222222222222",
                "name": " openai ",
                "content": null
            }
        ]);
        duplicate_name["layout"] = serde_json::json!([
            {
                "nodeId": "11111111-1111-4111-8111-111111111111",
                "x": 0,
                "y": 0
            },
            {
                "nodeId": "22222222-2222-4222-8222-222222222222",
                "x": 1,
                "y": 1
            }
        ]);
        assert!(validate_storage_envelope(&duplicate_name.to_string()).is_err());

        let mut dangling_reference: serde_json::Value =
            serde_json::from_str(&workspace("OpenAI")).unwrap();
        dangling_reference["references"] = serde_json::json!([{
            "sourceNodeId": "11111111-1111-4111-8111-111111111111",
            "targetNodeId": "22222222-2222-4222-8222-222222222222"
        }]);
        assert!(validate_storage_envelope(&dangling_reference.to_string()).is_err());

        let mut incomplete_layout: serde_json::Value =
            serde_json::from_str(&workspace("OpenAI")).unwrap();
        incomplete_layout["layout"] = serde_json::json!([]);
        assert!(validate_storage_envelope(&incomplete_layout.to_string()).is_err());

        let mut partial_dimensions: serde_json::Value =
            serde_json::from_str(&workspace("OpenAI")).unwrap();
        partial_dimensions["layout"][0]["width"] = serde_json::json!(480);
        assert!(validate_storage_envelope(&partial_dimensions.to_string()).is_ok());

        let mut unsafe_dimensions: serde_json::Value =
            serde_json::from_str(&workspace("OpenAI")).unwrap();
        unsafe_dimensions["layout"][0]["height"] = serde_json::json!(91);
        assert!(validate_storage_envelope(&unsafe_dimensions.to_string()).is_err());

        let mut manual_dimensions: serde_json::Value =
            serde_json::from_str(&workspace("OpenAI")).unwrap();
        manual_dimensions["layout"][0]["width"] = serde_json::json!(480);
        manual_dimensions["layout"][0]["height"] = serde_json::json!(360);
        assert!(validate_storage_envelope(&manual_dimensions.to_string()).is_ok());
    }

    #[test]
    fn shared_workspace_contract_matches_rust_validation() {
        let contract: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../fixtures/workspace-contract.json"
        )))
        .expect("shared workspace contract must be JSON");
        let cases = contract["cases"]
            .as_array()
            .expect("shared contract cases must be an array");

        for fixture in cases {
            let name = fixture["name"].as_str().expect("fixture name");
            let valid = fixture["valid"].as_bool().expect("fixture validity");
            let storage = serde_json::to_string(&fixture["storage"]).unwrap();
            let normalized = normalize_storage_envelope(&storage);
            assert_eq!(normalized.is_ok(), valid, "fixture {name}");
            if let Ok(normalized) = normalized {
                let normalized: serde_json::Value = serde_json::from_str(&normalized).unwrap();
                assert_eq!(
                    normalized["version"], CURRENT_WORKSPACE_STORAGE_VERSION,
                    "fixture {name} must migrate to the current version"
                );
            }
        }
    }

    #[test]
    fn export_conversion_extracts_a_valid_storage_envelope() {
        let export = workspace_export("restored-from-offsite");
        let storage = workspace_storage_from_export(&export).unwrap();
        let storage_value: serde_json::Value = serde_json::from_str(&storage).unwrap();

        validate_storage_envelope(&storage).unwrap();
        assert_eq!(storage_value["version"], CURRENT_WORKSPACE_STORAGE_VERSION);
        assert_eq!(storage_value["nodes"][0]["name"], "restored-from-offsite");
        assert!(validate_storage_envelope(&export).is_err());
    }

    #[test]
    fn locking_invalidates_existing_workspace_access_permits() {
        let state = WorkspaceVaultState::default();
        state.replace_data_key([7; DATA_KEY_BYTES]).unwrap();
        let permit = state.access_permit().unwrap();

        assert!(state.ensure_access_permit(permit).is_ok());
        assert!(state.shutdown());
        assert_eq!(
            state.ensure_access_permit(permit).unwrap_err(),
            "workspace_vault_session_expired"
        );
        assert!(!state.shutdown());
    }

    #[test]
    fn derived_cache_payloads_are_bound_to_the_unlocked_workspace_and_cache_key() {
        let state = WorkspaceVaultState::default();
        state.replace_data_key([8; DATA_KEY_BYTES]).unwrap();
        let plaintext = b"candidate ids only";
        let encrypted = state
            .encrypt_derived_cache_payload(plaintext, b"cache-key-a")
            .unwrap();

        assert_ne!(encrypted, plaintext);
        assert_eq!(
            state
                .decrypt_derived_cache_payload(&encrypted, b"cache-key-a")
                .unwrap(),
            plaintext
        );
        assert!(
            state
                .decrypt_derived_cache_payload(&encrypted, b"cache-key-b")
                .is_err()
        );
        assert!(state.shutdown());
        assert_eq!(
            state
                .decrypt_derived_cache_payload(&encrypted, b"cache-key-a")
                .unwrap_err(),
            "workspace_vault_locked"
        );
    }

    #[test]
    fn idle_timeout_is_decided_by_rust_state_and_can_be_disabled() {
        let state = WorkspaceVaultState::default();
        state.replace_data_key([9; DATA_KEY_BYTES]).unwrap();
        state.set_idle_timeout(Some(5));
        state.last_activity_milliseconds.store(0, Ordering::Release);

        assert!(state.should_idle_lock());
        state.set_idle_timeout(None);
        assert!(!state.should_idle_lock());
    }

    #[test]
    fn sensitive_authorizations_are_single_use_and_purpose_bound() {
        let state = WorkspaceVaultState::default();
        state.replace_data_key([11; DATA_KEY_BYTES]).unwrap();
        let permit = state.access_permit().unwrap();
        let wrong_purpose = state
            .issue_sensitive_authorization(SensitiveOperation::ChangePassword, permit)
            .unwrap();

        assert_eq!(
            state
                .consume_sensitive_authorization(
                    SensitiveOperation::ExportWorkspace,
                    &wrong_purpose,
                )
                .unwrap_err(),
            "workspace_vault_reauthentication_required"
        );

        let token = state
            .issue_sensitive_authorization(SensitiveOperation::ExportWorkspace, permit)
            .unwrap();
        assert_eq!(
            state
                .consume_sensitive_authorization(SensitiveOperation::ExportWorkspace, &token)
                .unwrap()
                .generation,
            permit.generation
        );
        assert_eq!(
            state
                .consume_sensitive_authorization(SensitiveOperation::ExportWorkspace, &token)
                .unwrap_err(),
            "workspace_vault_reauthentication_required"
        );
    }

    #[test]
    fn new_passwords_require_length_and_reject_common_values() {
        assert_eq!(
            validate_new_password("short password").unwrap_err(),
            "workspace_vault_password_too_short"
        );
        assert_eq!(
            validate_new_password("Password Password").unwrap_err(),
            "workspace_vault_password_blocked"
        );
        assert!(validate_new_password("three uncommon words 2026").is_ok());
    }

    #[test]
    fn recovery_cleanup_is_restricted_to_workspace_subdirectories() {
        let directory = test_directory();
        let nested = directory.join("workspace.backups.v1");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("snapshot.json"), b"snapshot").unwrap();

        remove_workspace_subdirectory(&directory, &nested).unwrap();
        assert!(!nested.exists());
        assert_eq!(
            remove_workspace_subdirectory(&directory, &directory).unwrap_err(),
            "workspace_vault_invalid_cleanup_path"
        );
        assert_eq!(
            remove_workspace_subdirectory(&directory, &directory.with_extension("outside"))
                .unwrap_err(),
            "workspace_vault_invalid_cleanup_path"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn workspace_destruction_removes_every_managed_workspace_file() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        fs::create_dir_all(store.backup_directory()).unwrap();
        fs::create_dir_all(store.pending_backup_directory()).unwrap();
        fs::create_dir_all(store.data_key_rotation_directory()).unwrap();
        fs::create_dir_all(store.recovery_swap_directory()).unwrap();
        for path in [
            store.path(WorkspaceFileSlot::Primary),
            store.pending_path(WorkspaceFileSlot::Primary),
            store.path(WorkspaceFileSlot::Recovery),
            store.pending_path(WorkspaceFileSlot::Recovery),
            store.vault_path(),
            store.pending_vault_path(),
            store.backup_directory().join("snapshot.json"),
            store.pending_backup_directory().join("snapshot.json"),
            store.data_key_rotation_manifest_path(),
            store.recovery_swap_manifest_path(),
        ] {
            fs::write(path, b"managed workspace data").unwrap();
        }

        remove_all_workspace_files(&store).unwrap();

        assert!(!store.path(WorkspaceFileSlot::Primary).exists());
        assert!(!store.pending_path(WorkspaceFileSlot::Primary).exists());
        assert!(!store.path(WorkspaceFileSlot::Recovery).exists());
        assert!(!store.pending_path(WorkspaceFileSlot::Recovery).exists());
        assert!(!store.vault_path().exists());
        assert!(!store.pending_vault_path().exists());
        assert!(!store.backup_directory().exists());
        assert!(!store.pending_backup_directory().exists());
        assert!(!store.data_key_rotation_directory().exists());
        assert!(!store.recovery_swap_directory().exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn repeated_password_failures_trigger_and_reset_backoff() {
        let state = WorkspaceVaultState::default();
        assert!(state.check_password_attempt_allowed().is_ok());
        state.record_password_failure();
        state.record_password_failure();
        assert!(state.check_password_attempt_allowed().is_ok());
        state.record_password_failure();
        assert_eq!(
            state.check_password_attempt_allowed().unwrap_err(),
            "workspace_vault_password_rate_limited"
        );
        state.reset_password_failures();
        assert!(state.check_password_attempt_allowed().is_ok());
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
    fn recovery_swap_transaction_recovers_after_only_primary_was_replaced() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let primary = workspace("Current primary");
        let recovery = workspace("Unique recovery");
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &primary)
            .unwrap();
        store
            .write_plaintext(WorkspaceFileSlot::Recovery, &recovery)
            .unwrap();

        let next_primary = prepare_workspace_recovery_swap(&store, None).unwrap();
        let prepared_primary =
            fs::read(store.recovery_swap_slot_path(WorkspaceFileSlot::Primary)).unwrap();
        write_atomically(&store.path(WorkspaceFileSlot::Primary), &prepared_primary).unwrap();

        assert_eq!(
            store.read_plaintext(WorkspaceFileSlot::Primary).unwrap(),
            Some(next_primary.clone())
        );
        assert_eq!(
            store.read_plaintext(WorkspaceFileSlot::Recovery).unwrap(),
            Some(next_primary)
        );

        assert!(finish_pending_workspace_recovery_swap(&store).unwrap());
        assert_eq!(
            store.read_plaintext(WorkspaceFileSlot::Primary).unwrap(),
            Some(normalize_storage_envelope(&recovery).unwrap())
        );
        assert_eq!(
            store.read_plaintext(WorkspaceFileSlot::Recovery).unwrap(),
            Some(normalize_storage_envelope(&primary).unwrap())
        );
        assert!(!store.recovery_swap_directory().exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn recovery_swap_transaction_rebinds_encrypted_slots() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let data_key = [31; DATA_KEY_BYTES];
        let primary = workspace("Encrypted primary");
        let recovery = workspace("Encrypted recovery");
        store
            .write(WorkspaceFileSlot::Primary, &primary, Some(&data_key))
            .unwrap();
        store
            .write(WorkspaceFileSlot::Recovery, &recovery, Some(&data_key))
            .unwrap();

        prepare_workspace_recovery_swap(&store, Some(&data_key)).unwrap();
        assert!(finish_pending_workspace_recovery_swap(&store).unwrap());

        assert_eq!(
            store
                .read(WorkspaceFileSlot::Primary, Some(&data_key))
                .unwrap(),
            Some(normalize_storage_envelope(&recovery).unwrap())
        );
        assert_eq!(
            store
                .read(WorkspaceFileSlot::Recovery, Some(&data_key))
                .unwrap(),
            Some(normalize_storage_envelope(&primary).unwrap())
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn recovery_swap_discards_an_uncommitted_preparation() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let primary = workspace("Primary stays");
        let recovery = workspace("Recovery stays");
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &primary)
            .unwrap();
        store
            .write_plaintext(WorkspaceFileSlot::Recovery, &recovery)
            .unwrap();
        fs::create_dir_all(store.recovery_swap_directory()).unwrap();
        fs::write(
            store.recovery_swap_slot_path(WorkspaceFileSlot::Primary),
            b"incomplete",
        )
        .unwrap();

        assert!(!finish_pending_workspace_recovery_swap(&store).unwrap());
        assert!(!store.recovery_swap_directory().exists());
        assert_eq!(
            store.read_plaintext(WorkspaceFileSlot::Primary).unwrap(),
            Some(normalize_storage_envelope(&primary).unwrap())
        );
        assert_eq!(
            store.read_plaintext(WorkspaceFileSlot::Recovery).unwrap(),
            Some(normalize_storage_envelope(&recovery).unwrap())
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
    fn expires_old_history_and_refreshes_an_unchanged_snapshot() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let started_at = 1_800_000_000_000_u64;
        let primary = workspace("age-limited-backup");
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &primary)
            .unwrap();
        let first = capture_workspace_backup_at(&store, None, started_at).unwrap();
        let first_id = first.status.entries[0].id.clone();

        let refreshed = capture_workspace_backup_at(
            &store,
            None,
            started_at + BACKUP_MAXIMUM_AGE_MILLISECONDS + 1,
        )
        .unwrap();

        assert!(refreshed.created);
        assert_eq!(refreshed.status.entries.len(), 1);
        assert_eq!(
            refreshed.status.maximum_age_ms,
            BACKUP_MAXIMUM_AGE_MILLISECONDS
        );
        assert_ne!(refreshed.status.entries[0].id, first_id);
        assert!(!store.backup_path(&first_id).unwrap().exists());
        assert_eq!(
            read_backup_contents(&store, &refreshed.status.entries[0].id, None,).unwrap(),
            primary
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
    fn data_key_rotation_reencrypts_primary_recovery_and_history() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let provider = FakeSystemUnlockProvider::default();
        let primary = workspace("secret-primary");
        let recovery = workspace("secret-recovery");
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &primary)
            .unwrap();
        store
            .write_plaintext(WorkspaceFileSlot::Recovery, &recovery)
            .unwrap();
        let captured = capture_workspace_backup_at(&store, None, 1_800_000_000_000).unwrap();
        let backup_id = captured.status.entries[0].id.clone();
        let previous_key = migrate_plaintext_store(&store, "correct horse battery").unwrap();

        rotate_encrypted_store(
            &store,
            &previous_key,
            "replacement master password",
            &provider,
        )
        .unwrap();

        let metadata = store.read_vault_metadata().unwrap().unwrap();
        let next_key = unwrap_data_key(&metadata, "replacement master password").unwrap();
        assert_ne!(next_key, previous_key);
        assert_eq!(
            unwrap_data_key(&metadata, "correct horse battery").unwrap_err(),
            "workspace_vault_invalid_password"
        );
        assert_eq!(
            store
                .read(WorkspaceFileSlot::Primary, Some(&next_key))
                .unwrap(),
            Some(primary)
        );
        assert_eq!(
            store
                .read(WorkspaceFileSlot::Recovery, Some(&next_key))
                .unwrap(),
            Some(recovery)
        );
        assert_eq!(
            read_backup_contents(&store, &backup_id, Some(&next_key)).unwrap(),
            workspace("secret-primary")
        );
        assert!(
            store
                .read(WorkspaceFileSlot::Primary, Some(&previous_key))
                .is_err()
        );
        assert!(!store.data_key_rotation_directory().exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn data_key_rotation_replaces_the_system_unlock_credential() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let provider = FakeSystemUnlockProvider::default();
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &workspace("system-unlock"))
            .unwrap();
        let previous_key = migrate_plaintext_store(&store, "correct horse battery").unwrap();
        let previous_credential_id = "previous-device-credential";
        let previous_device_key = random_array::<DATA_KEY_BYTES>().unwrap();
        provider
            .store(previous_credential_id, &previous_device_key)
            .unwrap();
        let mut metadata = store.read_vault_metadata().unwrap().unwrap();
        metadata.system_unlock = Some(
            create_system_unlock_envelope(
                provider.provider_id(),
                previous_credential_id,
                &previous_key,
                &previous_device_key,
            )
            .unwrap(),
        );
        write_atomically(&store.vault_path(), &serde_json::to_vec(&metadata).unwrap()).unwrap();

        rotate_encrypted_store(
            &store,
            &previous_key,
            "replacement master password",
            &provider,
        )
        .unwrap();

        let next_metadata = store.read_vault_metadata().unwrap().unwrap();
        let next_credential_id = next_metadata
            .system_unlock
            .as_ref()
            .unwrap()
            .credential_id
            .clone();
        let next_key = unwrap_data_key(&next_metadata, "replacement master password").unwrap();
        assert_ne!(next_credential_id, previous_credential_id);
        assert_eq!(
            unwrap_data_key_with_system(&next_metadata, &provider).unwrap(),
            next_key
        );
        assert_eq!(
            provider.load(previous_credential_id).unwrap_err(),
            "system_unlock_credential_missing"
        );
        assert!(provider.load(&next_credential_id).is_ok());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn restart_finishes_a_ready_data_key_rotation() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let provider = FakeSystemUnlockProvider::default();
        let primary = workspace("rotation-restart-primary");
        let recovery = workspace("rotation-restart-recovery");
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &primary)
            .unwrap();
        store
            .write_plaintext(WorkspaceFileSlot::Recovery, &recovery)
            .unwrap();
        let previous_key = migrate_plaintext_store(&store, "correct horse battery").unwrap();
        let next_key = random_array::<DATA_KEY_BYTES>().unwrap();
        prepare_data_key_rotation(
            &store,
            &previous_key,
            &next_key,
            "replacement master password",
            &provider,
        )
        .unwrap();
        let partly_replaced =
            pending_rotation_file(&store.data_key_rotation_slot_path(WorkspaceFileSlot::Primary))
                .unwrap();
        write_atomically(&store.path(WorkspaceFileSlot::Primary), &partly_replaced).unwrap();

        recover_pending_workspace_transactions(&store, &provider).unwrap();

        let metadata = store.read_vault_metadata().unwrap().unwrap();
        assert_eq!(
            unwrap_data_key(&metadata, "replacement master password").unwrap(),
            next_key
        );
        assert_eq!(
            unwrap_data_key(&metadata, "correct horse battery").unwrap_err(),
            "workspace_vault_invalid_password"
        );
        assert_eq!(
            store
                .read(WorkspaceFileSlot::Primary, Some(&next_key))
                .unwrap(),
            Some(primary)
        );
        assert_eq!(
            store
                .read(WorkspaceFileSlot::Recovery, Some(&next_key))
                .unwrap(),
            Some(recovery)
        );
        assert!(!store.data_key_rotation_directory().exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn restart_discards_an_uncommitted_data_key_rotation() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let provider = FakeSystemUnlockProvider::default();
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &workspace("unchanged"))
            .unwrap();
        let previous_key = migrate_plaintext_store(&store, "correct horse battery").unwrap();
        let next_credential_id = "uncommitted-next-credential";
        provider
            .store(next_credential_id, &[8; DATA_KEY_BYTES])
            .unwrap();
        fs::create_dir_all(store.data_key_rotation_directory()).unwrap();
        write_data_key_rotation_manifest(
            &store,
            &DataKeyRotationManifest {
                format: DATA_KEY_ROTATION_FORMAT.to_owned(),
                version: CRYPTO_VERSION,
                phase: DataKeyRotationPhase::Preparing,
                slots: vec![WorkspaceFileSlot::Primary],
                backup_ids: Vec::new(),
                previous_system_credential: Some(RotationSystemCredential {
                    provider: provider.provider_id().to_owned(),
                    credential_id: "previous-credential".to_owned(),
                }),
                next_system_credential: Some(RotationSystemCredential {
                    provider: provider.provider_id().to_owned(),
                    credential_id: next_credential_id.to_owned(),
                }),
            },
        )
        .unwrap();

        recover_pending_workspace_transactions(&store, &provider).unwrap();

        assert_eq!(
            provider.load(next_credential_id).unwrap_err(),
            "system_unlock_credential_missing"
        );
        assert_eq!(
            unwrap_data_key(
                &store.read_vault_metadata().unwrap().unwrap(),
                "correct horse battery",
            )
            .unwrap(),
            previous_key
        );
        assert!(!store.data_key_rotation_directory().exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_history_aborts_rotation_without_replacing_the_old_key() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let provider = FakeSystemUnlockProvider::default();
        let primary = workspace("keep-old-key");
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &primary)
            .unwrap();
        let previous_key = migrate_plaintext_store(&store, "correct horse battery").unwrap();
        fs::create_dir_all(store.backup_directory()).unwrap();
        let invalid_backup_id = format!("1800000000000-{}", uuid::Uuid::new_v4());
        write_atomically(
            &store.backup_path(&invalid_backup_id).unwrap(),
            b"damaged history",
        )
        .unwrap();

        let error = rotate_encrypted_store(
            &store,
            &previous_key,
            "replacement master password",
            &provider,
        )
        .unwrap_err();

        assert_eq!(
            error,
            format!("workspace_vault_data_key_rotation_invalid_backup:{invalid_backup_id}")
        );
        assert_eq!(
            unwrap_data_key(
                &store.read_vault_metadata().unwrap().unwrap(),
                "correct horse battery",
            )
            .unwrap(),
            previous_key
        );
        assert_eq!(
            store
                .read(WorkspaceFileSlot::Primary, Some(&previous_key))
                .unwrap(),
            Some(primary)
        );
        assert!(!store.data_key_rotation_directory().exists());
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
    fn restores_an_encrypted_export_without_the_original_device_vault() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let current = workspace("current-local-workspace");
        let restored_export = workspace_export("restored-from-offsite");
        let restored_storage = workspace_storage_from_export(&restored_export).unwrap();
        store
            .write_plaintext(WorkspaceFileSlot::Primary, &current)
            .unwrap();

        let source_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let source_metadata =
            create_vault_metadata("correct horse battery", &source_key, Vec::new()).unwrap();
        let encrypted = encrypt_export(&restored_export, &source_metadata, &source_key).unwrap();
        let (envelope, opened_key, preview) =
            open_encrypted_export(&encrypted, "correct horse battery").unwrap();
        assert_eq!(preview, restored_export);

        let installed_key = install_prepared_workspace_restore(
            &store,
            PreparedWorkspaceRestore {
                id: uuid::Uuid::new_v4(),
                expires_at_milliseconds: u64::MAX,
                envelope,
                data_key: Zeroizing::new(opened_key),
            },
        )
        .unwrap();
        let installed_metadata = store.read_vault_metadata().unwrap().unwrap();

        assert_eq!(
            unwrap_data_key(&installed_metadata, "correct horse battery").unwrap(),
            installed_key
        );
        assert!(installed_metadata.system_unlock.is_none());
        assert_eq!(
            store
                .read(WorkspaceFileSlot::Primary, Some(&installed_key))
                .unwrap(),
            Some(restored_storage)
        );
        assert_eq!(
            store
                .read(WorkspaceFileSlot::Recovery, Some(&installed_key))
                .unwrap(),
            Some(current)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn recovery_drill_installs_and_unlocks_an_isolated_fresh_vault() {
        let restored = workspace_export("recovery-drill");
        let source_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let source_metadata =
            create_vault_metadata("correct horse battery", &source_key, Vec::new()).unwrap();
        let encrypted = encrypt_export(&restored, &source_metadata, &source_key).unwrap();

        assert_eq!(
            test_offsite_workspace_restore(&encrypted, "correct horse battery", None, None,),
            Ok(())
        );
        assert_eq!(
            test_offsite_workspace_restore(&encrypted, "incorrect password", None, None),
            Err("workspace_vault_invalid_password".to_owned())
        );
    }

    #[test]
    fn recovery_drill_distinguishes_current_password_from_snapshot_lineage() {
        let current_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let current_metadata =
            create_vault_metadata("current master password", &current_key, Vec::new()).unwrap();
        let previous_metadata =
            create_vault_metadata("previous master password", &current_key, Vec::new()).unwrap();
        let previous_envelope = parse_encrypted_export(
            &encrypt_export(
                &workspace_export("previous-wrapper"),
                &previous_metadata,
                &current_key,
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            classify_restore_password_failure(
                &previous_envelope,
                "not the current password",
                CurrentWorkspaceRestoreContext {
                    metadata: &current_metadata,
                    data_key: &current_key,
                },
            ),
            "workspace_restore_password_rejected_by_current_workspace"
        );
        assert_eq!(
            classify_restore_password_failure(
                &previous_envelope,
                "current master password",
                CurrentWorkspaceRestoreContext {
                    metadata: &current_metadata,
                    data_key: &current_key,
                },
            ),
            "workspace_restore_snapshot_wrap_mismatch"
        );

        let other_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let other_metadata =
            create_vault_metadata("other workspace password", &other_key, Vec::new()).unwrap();
        let other_envelope = parse_encrypted_export(
            &encrypt_export(
                &workspace_export("other-lineage"),
                &other_metadata,
                &other_key,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            classify_restore_password_failure(
                &other_envelope,
                "current master password",
                CurrentWorkspaceRestoreContext {
                    metadata: &current_metadata,
                    data_key: &current_key,
                },
            ),
            "workspace_restore_snapshot_key_mismatch_or_corrupt"
        );
    }

    #[test]
    fn recovery_drill_reports_an_impossible_current_wrapper_failure_separately() {
        let current_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let current_metadata =
            create_vault_metadata("current master password", &current_key, Vec::new()).unwrap();
        let envelope = parse_encrypted_export(
            &encrypt_export(
                &workspace_export("current-lineage"),
                &current_metadata,
                &current_key,
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            classify_restore_password_failure(
                &envelope,
                "current master password",
                CurrentWorkspaceRestoreContext {
                    metadata: &current_metadata,
                    data_key: &current_key,
                },
            ),
            "workspace_restore_snapshot_wrap_inconsistent"
        );
    }

    #[test]
    fn recovery_drill_rejects_a_revoked_workspace_permit() {
        let generation = AtomicU64::new(2);
        let permit = WorkspaceAccessPermit { generation: 1 };

        assert_eq!(
            test_offsite_workspace_restore(
                "not-opened",
                "not-opened",
                Some(&generation),
                Some(permit)
            ),
            Err("workspace_vault_session_expired".to_owned())
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
    fn vault_metadata_created_before_idle_lock_support_uses_the_default() {
        let data_key = random_array::<DATA_KEY_BYTES>().unwrap();
        let metadata =
            create_vault_metadata("correct horse battery", &data_key, Vec::new()).unwrap();
        let mut value = serde_json::to_value(metadata).unwrap();
        value.as_object_mut().unwrap().remove("idleTimeoutMinutes");

        let parsed = parse_vault_metadata(&value.to_string()).unwrap();

        assert_eq!(parsed.idle_timeout_minutes, Some(15));
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
