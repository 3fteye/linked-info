use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use linked_info_backup_port::{
    BackupListPage, BackupSnapshot, BackupSnapshotMetadata, BackupTarget, BackupTargetError,
    BackupVerification,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    cloudflare_backup_target::CloudflareBackupTarget,
    workspace_file::{
        SensitiveOperation, WorkspaceVaultState, begin_workspace_access,
        encrypt_offsite_workspace_snapshot, ensure_workspace_access, write_atomically,
    },
};

const CONFIG_FILE_NAME: &str = "offsite-backup-targets.json";
const CONFIG_FORMAT: &str = "linked-info-offsite-backup-targets";
const CONFIG_VERSION: u16 = 1;
const KEYRING_SERVICE: &str = "com.linkedinfo.desktop.backup-target";
const MAXIMUM_TARGETS: usize = 16;

#[derive(Default)]
pub struct OffsiteBackupState {
    config_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct OffsiteBackupConfig {
    format: String,
    version: u16,
    targets: Vec<BackupTargetConfig>,
}

impl Default for OffsiteBackupConfig {
    fn default() -> Self {
        Self {
            format: CONFIG_FORMAT.to_owned(),
            version: CONFIG_VERSION,
            targets: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum BackupProviderKind {
    CloudflareWorkerR2,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupTargetConfig {
    id: Uuid,
    name: String,
    provider: BackupProviderKind,
    endpoint: String,
    credential_id: String,
    created_at_ms: u64,
    last_upload_at_ms: Option<u64>,
    last_verified_at_ms: Option<u64>,
    last_restore_test_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTargetSummary {
    id: Uuid,
    name: String,
    provider: BackupProviderKind,
    endpoint: String,
    created_at_ms: u64,
    last_upload_at_ms: Option<u64>,
    last_verified_at_ms: Option<u64>,
    last_restore_test_at_ms: Option<u64>,
    maximum_upload_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedOffsiteBackup {
    metadata: BackupSnapshotMetadata,
    encrypted_export: String,
}

#[tauri::command]
pub async fn inspect_offsite_backup_targets(
    app: tauri::AppHandle,
    state: tauri::State<'_, OffsiteBackupState>,
) -> Result<Vec<BackupTargetSummary>, String> {
    let config = read_config_locked(&app, &state).await?;
    config.targets.iter().map(target_summary).collect()
}

#[tauri::command]
pub async fn configure_cloudflare_backup_target(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    name: String,
    endpoint: String,
    token: String,
    authorization: String,
) -> Result<BackupTargetSummary, String> {
    let permit = vault_state
        .consume_sensitive_authorization(SensitiveOperation::BackupTargetChange, &authorization)?;
    let name = validate_target_name(&name)?;
    let endpoint = CloudflareBackupTarget::normalize_endpoint(&endpoint).map_err(target_error)?;
    let token = Zeroizing::new(token);
    let target = CloudflareBackupTarget::new(&endpoint, token.to_string()).map_err(target_error)?;
    target.list(None, 1).await.map_err(target_error)?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;

    let id = Uuid::new_v4();
    let credential_id = id.to_string();
    let credential_id_for_store = credential_id.clone();
    let token_for_store = Zeroizing::new(token.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        store_credential(&credential_id_for_store, token_for_store.as_str())
    })
    .await
    .map_err(|error| error.to_string())??;

    if let Err(error) = ensure_workspace_access(&app, &vault_state, Some(permit)) {
        let _ = delete_credential(&credential_id);
        return Err(error);
    }

    let config_target = BackupTargetConfig {
        id,
        name,
        provider: BackupProviderKind::CloudflareWorkerR2,
        endpoint,
        credential_id: credential_id.clone(),
        created_at_ms: current_time_milliseconds()?,
        last_upload_at_ms: None,
        last_verified_at_ms: None,
        last_restore_test_at_ms: None,
    };
    let summary = target_summary(&config_target)?;
    let app_for_write = app.clone();
    let config_lock = Arc::clone(&backup_state.config_lock);
    let target_for_write = config_target.clone();
    let write_result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = config_lock
            .lock()
            .map_err(|_| "offsite_backup_config_unavailable".to_owned())?;
        let mut config = read_config(&config_path(&app_for_write)?)?;
        if config.targets.len() >= MAXIMUM_TARGETS
            || config
                .targets
                .iter()
                .any(|item| item.endpoint == target_for_write.endpoint)
        {
            return Err("offsite_backup_target_conflict".to_owned());
        }
        config.targets.push(target_for_write);
        write_config(&config_path(&app_for_write)?, &config)
    })
    .await
    .map_err(|error| error.to_string())?;
    if let Err(error) = write_result {
        let _ = delete_credential(&credential_id);
        return Err(error);
    }
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    Ok(summary)
}

#[tauri::command]
pub async fn remove_offsite_backup_target(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    authorization: String,
) -> Result<(), String> {
    let permit = vault_state
        .consume_sensitive_authorization(SensitiveOperation::BackupTargetChange, &authorization)?;
    let target = find_target(&app, &backup_state, target_id).await?;
    let credential = load_credential_async(target.credential_id.clone()).await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    delete_credential_async(target.credential_id.clone()).await?;

    let app_for_write = app.clone();
    let config_lock = Arc::clone(&backup_state.config_lock);
    let write_result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = config_lock
            .lock()
            .map_err(|_| "offsite_backup_config_unavailable".to_owned())?;
        let path = config_path(&app_for_write)?;
        let mut config = read_config(&path)?;
        let previous_length = config.targets.len();
        config.targets.retain(|item| item.id != target_id);
        if config.targets.len() == previous_length {
            return Err("offsite_backup_target_not_found".to_owned());
        }
        write_config(&path, &config)
    })
    .await
    .map_err(|error| error.to_string())?;
    if let Err(error) = write_result {
        let _ = store_credential(&target.credential_id, &credential);
        return Err(error);
    }
    ensure_workspace_access(&app, &vault_state, Some(permit))
}

#[tauri::command]
pub async fn create_offsite_backup(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    contents: String,
) -> Result<BackupSnapshotMetadata, String> {
    let permit = begin_workspace_access(&app, &vault_state)?;
    let target_config = find_target(&app, &backup_state, target_id).await?;
    let target = open_target(&target_config).await?;
    let encrypted = encrypt_offsite_workspace_snapshot(&app, &vault_state, contents).await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    let snapshot = BackupSnapshot::new(
        Uuid::new_v4(),
        current_time_milliseconds()?,
        encrypted.into_bytes(),
    )
    .map_err(|_| "offsite_backup_invalid_snapshot".to_owned())?;
    let metadata = target.upload(snapshot).await.map_err(target_error)?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    update_target_status(&app, &backup_state, target_id, |config| {
        config.last_upload_at_ms = Some(current_time_milliseconds()?);
        Ok(())
    })
    .await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    Ok(metadata)
}

#[tauri::command]
pub async fn list_offsite_backups(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    cursor: Option<String>,
    limit: u16,
) -> Result<BackupListPage, String> {
    let permit = begin_workspace_access(&app, &vault_state)?;
    let config = find_target(&app, &backup_state, target_id).await?;
    let page = open_target(&config)
        .await?
        .list(cursor, limit)
        .await
        .map_err(target_error)?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    Ok(page)
}

#[tauri::command]
pub async fn download_offsite_backup(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    snapshot_id: Uuid,
) -> Result<DownloadedOffsiteBackup, String> {
    let permit = begin_workspace_access(&app, &vault_state)?;
    let config = find_target(&app, &backup_state, target_id).await?;
    let snapshot = open_target(&config)
        .await?
        .download(snapshot_id)
        .await
        .map_err(target_error)?
        .ok_or_else(|| "offsite_backup_snapshot_not_found".to_owned())?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    let metadata = snapshot.metadata;
    let encrypted_export = String::from_utf8(snapshot.payload)
        .map_err(|_| "offsite_backup_invalid_snapshot".to_owned())?;
    Ok(DownloadedOffsiteBackup {
        metadata,
        encrypted_export,
    })
}

#[tauri::command]
pub async fn verify_offsite_backup(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    snapshot_id: Uuid,
) -> Result<BackupVerification, String> {
    let permit = begin_workspace_access(&app, &vault_state)?;
    let config = find_target(&app, &backup_state, target_id).await?;
    let verification = open_target(&config)
        .await?
        .verify(snapshot_id)
        .await
        .map_err(target_error)?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    update_target_status(&app, &backup_state, target_id, |config| {
        config.last_verified_at_ms = Some(current_time_milliseconds()?);
        Ok(())
    })
    .await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    Ok(verification)
}

async fn open_target(config: &BackupTargetConfig) -> Result<Box<dyn BackupTarget>, String> {
    let token = load_credential_async(config.credential_id.clone()).await?;
    match config.provider {
        BackupProviderKind::CloudflareWorkerR2 => {
            CloudflareBackupTarget::new(&config.endpoint, token.to_string())
                .map(|target| Box::new(target) as Box<dyn BackupTarget>)
                .map_err(target_error)
        }
    }
}

async fn find_target(
    app: &tauri::AppHandle,
    state: &OffsiteBackupState,
    target_id: Uuid,
) -> Result<BackupTargetConfig, String> {
    read_config_locked(app, state)
        .await?
        .targets
        .into_iter()
        .find(|target| target.id == target_id)
        .ok_or_else(|| "offsite_backup_target_not_found".to_owned())
}

async fn read_config_locked(
    app: &tauri::AppHandle,
    state: &OffsiteBackupState,
) -> Result<OffsiteBackupConfig, String> {
    let app = app.clone();
    let config_lock = Arc::clone(&state.config_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = config_lock
            .lock()
            .map_err(|_| "offsite_backup_config_unavailable".to_owned())?;
        read_config(&config_path(&app)?)
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn update_target_status(
    app: &tauri::AppHandle,
    state: &OffsiteBackupState,
    target_id: Uuid,
    update: impl FnOnce(&mut BackupTargetConfig) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let app = app.clone();
    let config_lock = Arc::clone(&state.config_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = config_lock
            .lock()
            .map_err(|_| "offsite_backup_config_unavailable".to_owned())?;
        let path = config_path(&app)?;
        let mut config = read_config(&path)?;
        let target = config
            .targets
            .iter_mut()
            .find(|target| target.id == target_id)
            .ok_or_else(|| "offsite_backup_target_not_found".to_owned())?;
        update(target)?;
        write_config(&path, &config)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn target_summary(config: &BackupTargetConfig) -> Result<BackupTargetSummary, String> {
    let maximum_upload_bytes = match config.provider {
        BackupProviderKind::CloudflareWorkerR2 => Some(100 * 1024 * 1024),
    };
    Ok(BackupTargetSummary {
        id: config.id,
        name: config.name.clone(),
        provider: config.provider,
        endpoint: config.endpoint.clone(),
        created_at_ms: config.created_at_ms,
        last_upload_at_ms: config.last_upload_at_ms,
        last_verified_at_ms: config.last_verified_at_ms,
        last_restore_test_at_ms: config.last_restore_test_at_ms,
        maximum_upload_bytes,
    })
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(CONFIG_FILE_NAME))
        .map_err(|error| error.to_string())
}

fn read_config(path: &Path) -> Result<OffsiteBackupConfig, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(OffsiteBackupConfig::default());
        }
        Err(error) => return Err(error.to_string()),
    };
    let config: OffsiteBackupConfig =
        serde_json::from_str(&contents).map_err(|_| "offsite_backup_invalid_config".to_owned())?;
    validate_config(&config)?;
    Ok(config)
}

fn write_config(path: &Path, config: &OffsiteBackupConfig) -> Result<(), String> {
    validate_config(config)?;
    let contents = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "offsite_backup_invalid_config_path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    write_atomically(path, &contents).map_err(|error| error.to_string())
}

fn validate_config(config: &OffsiteBackupConfig) -> Result<(), String> {
    if config.format != CONFIG_FORMAT
        || config.version != CONFIG_VERSION
        || config.targets.len() > MAXIMUM_TARGETS
    {
        return Err("offsite_backup_invalid_config".to_owned());
    }
    let mut ids = HashSet::new();
    let mut endpoints = HashSet::new();
    for target in &config.targets {
        validate_target_name(&target.name)?;
        let normalized_endpoint = CloudflareBackupTarget::normalize_endpoint(&target.endpoint)
            .map_err(|_| "offsite_backup_invalid_config".to_owned())?;
        if !ids.insert(target.id)
            || normalized_endpoint != target.endpoint
            || !endpoints.insert(target.endpoint.as_str())
            || Uuid::parse_str(&target.credential_id).is_err()
            || target.created_at_ms == 0
            || [
                target.last_upload_at_ms,
                target.last_verified_at_ms,
                target.last_restore_test_at_ms,
            ]
            .into_iter()
            .flatten()
            .any(|timestamp| timestamp == 0)
        {
            return Err("offsite_backup_invalid_config".to_owned());
        }
    }
    Ok(())
}

fn validate_target_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("offsite_backup_invalid_target_name".to_owned());
    }
    Ok(name.to_owned())
}

fn credential_entry(credential_id: &str) -> Result<keyring::Entry, String> {
    Uuid::parse_str(credential_id).map_err(|_| "offsite_backup_invalid_credential".to_owned())?;
    keyring::Entry::new(KEYRING_SERVICE, credential_id)
        .map_err(|_| "offsite_backup_credential_unavailable".to_owned())
}

fn store_credential(credential_id: &str, token: &str) -> Result<(), String> {
    credential_entry(credential_id)?
        .set_password(token)
        .map_err(|_| "offsite_backup_credential_store_failed".to_owned())
}

fn load_credential(credential_id: &str) -> Result<Zeroizing<String>, String> {
    credential_entry(credential_id)?
        .get_password()
        .map(Zeroizing::new)
        .map_err(|error| {
            if matches!(error, keyring::Error::NoEntry) {
                "offsite_backup_credential_missing".to_owned()
            } else {
                "offsite_backup_credential_read_failed".to_owned()
            }
        })
}

fn delete_credential(credential_id: &str) -> Result<(), String> {
    match credential_entry(credential_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("offsite_backup_credential_delete_failed".to_owned()),
    }
}

async fn load_credential_async(credential_id: String) -> Result<Zeroizing<String>, String> {
    tauri::async_runtime::spawn_blocking(move || load_credential(&credential_id))
        .await
        .map_err(|error| error.to_string())?
}

async fn delete_credential_async(credential_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_credential(&credential_id))
        .await
        .map_err(|error| error.to_string())?
}

fn current_time_milliseconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())
        .and_then(|duration| u64::try_from(duration.as_millis()).map_err(|error| error.to_string()))
}

fn target_error(error: BackupTargetError) -> String {
    match error {
        BackupTargetError::Unauthorized => "offsite_backup_unauthorized",
        BackupTargetError::InvalidRequest => "offsite_backup_invalid_request",
        BackupTargetError::NotFound => "offsite_backup_snapshot_not_found",
        BackupTargetError::Conflict => "offsite_backup_snapshot_conflict",
        BackupTargetError::PayloadTooLarge => "offsite_backup_payload_too_large",
        BackupTargetError::Unavailable => "offsite_backup_unavailable",
        BackupTargetError::InvalidResponse => "offsite_backup_invalid_response",
        BackupTargetError::IntegrityFailure => "offsite_backup_integrity_failed",
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_rejects_duplicate_targets() {
        let target = BackupTargetConfig {
            id: Uuid::new_v4(),
            name: "Cloudflare".to_owned(),
            provider: BackupProviderKind::CloudflareWorkerR2,
            endpoint: "https://backup.example.test".to_owned(),
            credential_id: Uuid::new_v4().to_string(),
            created_at_ms: 42,
            last_upload_at_ms: None,
            last_verified_at_ms: None,
            last_restore_test_at_ms: None,
        };
        let mut duplicate = target.clone();
        duplicate.id = Uuid::new_v4();
        duplicate.credential_id = Uuid::new_v4().to_string();
        let config = OffsiteBackupConfig {
            targets: vec![target, duplicate],
            ..OffsiteBackupConfig::default()
        };

        assert_eq!(
            validate_config(&config),
            Err("offsite_backup_invalid_config".to_owned())
        );
    }

    #[test]
    fn config_never_serializes_the_backup_token() {
        let target = BackupTargetConfig {
            id: Uuid::new_v4(),
            name: "Cloudflare".to_owned(),
            provider: BackupProviderKind::CloudflareWorkerR2,
            endpoint: "https://backup.example.test".to_owned(),
            credential_id: Uuid::new_v4().to_string(),
            created_at_ms: 42,
            last_upload_at_ms: None,
            last_verified_at_ms: None,
            last_restore_test_at_ms: None,
        };
        let serialized = serde_json::to_string(&OffsiteBackupConfig {
            targets: vec![target],
            ..OffsiteBackupConfig::default()
        })
        .unwrap();

        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("secret"));
    }
}
