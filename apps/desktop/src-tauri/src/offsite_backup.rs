use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use linked_info_backup_port::{
    BackupListPage, BackupSnapshot, BackupSnapshotMetadata, BackupTarget, BackupTargetError,
    BackupVerification, MAX_BACKUP_PAGE_LIMIT,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::{
    cloudflare_backup_target::CloudflareBackupTarget,
    s3_backup_target::{S3BackupTarget, S3Credentials},
    workspace_file::{
        SensitiveOperation, WorkspaceAccessPermit, WorkspaceVaultState, begin_workspace_access,
        encrypt_offsite_workspace_snapshot, ensure_workspace_access,
        test_offsite_workspace_restore, workspace_encryption_configured, write_atomically,
    },
};

const CONFIG_FILE_NAME: &str = "offsite-backup-targets.json";
const CONFIG_FORMAT: &str = "linked-info-offsite-backup-targets";
const CONFIG_VERSION: u16 = 1;
const KEYRING_SERVICE: &str = "com.linkedinfo.desktop.backup-target";
const MAXIMUM_TARGETS: usize = 16;
const DEFAULT_AUTOMATIC_INTERVAL_HOURS: u32 = 24;
const MAXIMUM_AUTOMATIC_INTERVAL_HOURS: u32 = 24 * 31;
const AUTOMATIC_RETRY_DELAY_MS: u64 = 15 * 60 * 1_000;
const DEFAULT_RETENTION_MAX_SNAPSHOTS: u32 = 30;
const DEFAULT_RETENTION_MAX_AGE_DAYS: u32 = 90;
const MAXIMUM_RETENTION_SNAPSHOTS: u32 = 1_000;
const MAXIMUM_RETENTION_AGE_DAYS: u32 = 3_650;

pub struct OffsiteBackupState {
    config_lock: Arc<Mutex<()>>,
    automatic_uploads: Arc<Mutex<HashSet<Uuid>>>,
}

struct TargetOperationClaim {
    uploads: Arc<Mutex<HashSet<Uuid>>>,
    target_id: Uuid,
}

impl TargetOperationClaim {
    fn acquire(state: &OffsiteBackupState, target_id: Uuid) -> Result<Self, String> {
        let mut uploads = state
            .automatic_uploads
            .lock()
            .map_err(|_| "offsite_backup_state_unavailable".to_owned())?;
        if !uploads.insert(target_id) {
            return Err("offsite_backup_target_busy".to_owned());
        }
        drop(uploads);
        Ok(Self {
            uploads: Arc::clone(&state.automatic_uploads),
            target_id,
        })
    }
}

impl Drop for TargetOperationClaim {
    fn drop(&mut self) {
        if let Ok(mut uploads) = self.uploads.lock() {
            uploads.remove(&self.target_id);
        }
    }
}

impl Default for OffsiteBackupState {
    fn default() -> Self {
        Self {
            config_lock: Arc::new(Mutex::new(())),
            automatic_uploads: Arc::new(Mutex::new(HashSet::new())),
        }
    }
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
    S3Compatible,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum S3ProviderTemplate {
    BackblazeB2,
    Tigris,
    OracleOci,
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupTargetConfig {
    id: Uuid,
    name: String,
    provider: BackupProviderKind,
    endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    s3_provider: Option<S3ProviderTemplate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bucket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prefix: Option<String>,
    credential_id: String,
    created_at_ms: u64,
    last_upload_at_ms: Option<u64>,
    last_verified_at_ms: Option<u64>,
    last_restore_test_at_ms: Option<u64>,
    #[serde(default)]
    last_restore_test_snapshot_id: Option<Uuid>,
    #[serde(default)]
    automatic_enabled: bool,
    #[serde(default = "default_automatic_interval_hours")]
    automatic_interval_hours: u32,
    #[serde(default)]
    automatic_revision: u64,
    #[serde(default)]
    automatic_uploaded_revision: u64,
    #[serde(default)]
    last_automatic_attempt_at_ms: Option<u64>,
    #[serde(default)]
    last_automatic_error: Option<String>,
    #[serde(default)]
    retention_enabled: bool,
    #[serde(default = "default_retention_max_snapshots")]
    retention_max_snapshots: u32,
    #[serde(default = "default_retention_max_age_days")]
    retention_max_age_days: u32,
    #[serde(default)]
    last_retention_cleanup_at_ms: Option<u64>,
    #[serde(default)]
    last_retention_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTargetSummary {
    id: Uuid,
    name: String,
    provider: BackupProviderKind,
    endpoint: String,
    s3_provider: Option<S3ProviderTemplate>,
    region: Option<String>,
    bucket: Option<String>,
    prefix: Option<String>,
    created_at_ms: u64,
    last_upload_at_ms: Option<u64>,
    last_verified_at_ms: Option<u64>,
    last_restore_test_at_ms: Option<u64>,
    maximum_upload_bytes: Option<u64>,
    automatic_enabled: bool,
    automatic_interval_hours: u32,
    automatic_pending: bool,
    last_automatic_attempt_at_ms: Option<u64>,
    last_automatic_error: Option<String>,
    retention_enabled: bool,
    retention_max_snapshots: u32,
    retention_max_age_days: u32,
    last_retention_cleanup_at_ms: Option<u64>,
    last_retention_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticBackupOutcome {
    target_id: Uuid,
    uploaded: bool,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAllOffsiteBackupsOutcome {
    deleted_count: usize,
    target_removed: bool,
    error: Option<String>,
}

fn default_automatic_interval_hours() -> u32 {
    DEFAULT_AUTOMATIC_INTERVAL_HOURS
}

fn default_retention_max_snapshots() -> u32 {
    DEFAULT_RETENTION_MAX_SNAPSHOTS
}

fn default_retention_max_age_days() -> u32 {
    DEFAULT_RETENTION_MAX_AGE_DAYS
}

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
struct S3CredentialRecord {
    format: String,
    version: u16,
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
}

const S3_CREDENTIAL_FORMAT: &str = "linked-info-s3-credentials";
const S3_CREDENTIAL_VERSION: u16 = 1;

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
pub async fn update_offsite_backup_automatic_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    enabled: bool,
    interval_hours: u32,
) -> Result<BackupTargetSummary, String> {
    let permit = begin_workspace_access(&app, &vault_state)?;
    if !(1..=MAXIMUM_AUTOMATIC_INTERVAL_HOURS).contains(&interval_hours) {
        return Err("offsite_backup_invalid_automatic_interval".to_owned());
    }
    let app_for_write = app.clone();
    let config_lock = Arc::clone(&state.config_lock);
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let _guard = config_lock
            .lock()
            .map_err(|_| "offsite_backup_config_unavailable".to_owned())?;
        let path = config_path(&app_for_write)?;
        let mut config = read_config(&path)?;
        let target = config
            .targets
            .iter_mut()
            .find(|target| target.id == target_id)
            .ok_or_else(|| "offsite_backup_target_not_found".to_owned())?;
        if enabled
            && target.last_restore_test_at_ms.is_some()
            && target.last_restore_test_snapshot_id.is_none()
        {
            return Err("offsite_backup_retention_requires_new_restore_drill".to_owned());
        }
        if enabled && !target.automatic_enabled {
            target.automatic_revision = target
                .automatic_revision
                .checked_add(1)
                .ok_or_else(|| "offsite_backup_automatic_revision_overflow".to_owned())?;
        }
        target.automatic_enabled = enabled;
        target.automatic_interval_hours = interval_hours;
        let summary = target_summary(target)?;
        write_config(&path, &config)?;
        Ok::<_, String>(summary)
    })
    .await
    .map_err(|error| error.to_string())??;
    ensure_workspace_access(&app, &vault_state, permit)?;
    Ok(summary)
}

#[tauri::command]
pub async fn update_offsite_backup_retention_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    enabled: bool,
    max_snapshots: u32,
    max_age_days: u32,
    authorization: String,
) -> Result<BackupTargetSummary, String> {
    let permit = vault_state.consume_sensitive_authorization(
        SensitiveOperation::BackupRetentionChange,
        &authorization,
    )?;
    validate_retention_settings(max_snapshots, max_age_days)?;
    let app_for_write = app.clone();
    let config_lock = Arc::clone(&state.config_lock);
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let _guard = config_lock
            .lock()
            .map_err(|_| "offsite_backup_config_unavailable".to_owned())?;
        let path = config_path(&app_for_write)?;
        let mut config = read_config(&path)?;
        let target = config
            .targets
            .iter_mut()
            .find(|target| target.id == target_id)
            .ok_or_else(|| "offsite_backup_target_not_found".to_owned())?;
        target.retention_enabled = enabled;
        target.retention_max_snapshots = max_snapshots;
        target.retention_max_age_days = max_age_days;
        target.last_retention_error = None;
        let summary = target_summary(target)?;
        write_config(&path, &config)?;
        Ok::<_, String>(summary)
    })
    .await
    .map_err(|error| error.to_string())??;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    Ok(summary)
}

#[tauri::command]
pub async fn mark_automatic_offsite_backup_pending(
    app: tauri::AppHandle,
    state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
) -> Result<Vec<BackupTargetSummary>, String> {
    let permit = begin_workspace_access(&app, &vault_state)?;
    let app_for_write = app.clone();
    let config_lock = Arc::clone(&state.config_lock);
    let summaries = tauri::async_runtime::spawn_blocking(move || {
        let _guard = config_lock
            .lock()
            .map_err(|_| "offsite_backup_config_unavailable".to_owned())?;
        let path = config_path(&app_for_write)?;
        let mut config = read_config(&path)?;
        let mut changed = false;
        for target in &mut config.targets {
            if target.automatic_enabled {
                target.automatic_revision = target
                    .automatic_revision
                    .checked_add(1)
                    .ok_or_else(|| "offsite_backup_automatic_revision_overflow".to_owned())?;
                changed = true;
            }
        }
        if changed {
            write_config(&path, &config)?;
        }
        config
            .targets
            .iter()
            .map(target_summary)
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(|error| error.to_string())??;
    ensure_workspace_access(&app, &vault_state, permit)?;
    Ok(summaries)
}

#[tauri::command]
pub async fn run_due_automatic_offsite_backups(
    app: tauri::AppHandle,
    state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    contents: String,
) -> Result<Vec<AutomaticBackupOutcome>, String> {
    let permit = begin_workspace_access(&app, &vault_state)?;
    let now = current_time_milliseconds()?;
    let candidates = read_config_locked(&app, &state)
        .await?
        .targets
        .into_iter()
        .filter(|target| automatic_backup_due(target, now))
        .filter(|target| claim_automatic_upload(&state, target.id))
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        ensure_workspace_access(&app, &vault_state, permit)?;
        return Ok(Vec::new());
    }

    let encrypted = match encrypt_offsite_workspace_snapshot(&app, &vault_state, contents).await {
        Ok(encrypted) => encrypted,
        Err(error) => {
            for candidate in &candidates {
                release_automatic_upload(&state, candidate.id);
            }
            return Err(error);
        }
    };
    ensure_workspace_access(&app, &vault_state, permit)?;
    let snapshot = BackupSnapshot::new(Uuid::new_v4(), now, encrypted.into_bytes())
        .map_err(|_| "offsite_backup_invalid_snapshot".to_owned())?;
    let mut outcomes = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let result = run_automatic_upload(
            &app,
            &state,
            &vault_state,
            permit,
            &candidate,
            snapshot.clone(),
        )
        .await;
        release_automatic_upload(&state, candidate.id);
        outcomes.push(result);
    }
    ensure_workspace_access(&app, &vault_state, permit)?;
    Ok(outcomes)
}

#[tauri::command]
pub async fn list_cloudflare_recovery_backups(
    app: tauri::AppHandle,
    endpoint: String,
    token: String,
    cursor: Option<String>,
    limit: u16,
) -> Result<BackupListPage, String> {
    ensure_unconfigured_recovery_mode(&app)?;
    let target = open_ephemeral_cloudflare_target(endpoint, token)?;
    let page = target.list(cursor, limit).await.map_err(target_error)?;
    ensure_unconfigured_recovery_mode(&app)?;
    Ok(page)
}

#[tauri::command]
pub async fn download_cloudflare_recovery_backup(
    app: tauri::AppHandle,
    endpoint: String,
    token: String,
    snapshot_id: Uuid,
) -> Result<DownloadedOffsiteBackup, String> {
    ensure_unconfigured_recovery_mode(&app)?;
    let snapshot = open_ephemeral_cloudflare_target(endpoint, token)?
        .download(snapshot_id)
        .await
        .map_err(target_error)?
        .ok_or_else(|| "offsite_backup_snapshot_not_found".to_owned())?;
    ensure_unconfigured_recovery_mode(&app)?;
    let metadata = snapshot.metadata;
    let encrypted_export = String::from_utf8(snapshot.payload)
        .map_err(|_| "offsite_backup_invalid_snapshot".to_owned())?;
    Ok(DownloadedOffsiteBackup {
        metadata,
        encrypted_export,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn list_s3_recovery_backups(
    app: tauri::AppHandle,
    endpoint: String,
    region: String,
    bucket: String,
    prefix: String,
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
    cursor: Option<String>,
    limit: u16,
) -> Result<BackupListPage, String> {
    ensure_unconfigured_recovery_mode(&app)?;
    let target = open_ephemeral_s3_target(
        endpoint,
        region,
        bucket,
        prefix,
        access_key_id,
        secret_access_key,
        session_token,
    )?;
    let page = target.list(cursor, limit).await.map_err(target_error)?;
    ensure_unconfigured_recovery_mode(&app)?;
    Ok(page)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn download_s3_recovery_backup(
    app: tauri::AppHandle,
    endpoint: String,
    region: String,
    bucket: String,
    prefix: String,
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
    snapshot_id: Uuid,
) -> Result<DownloadedOffsiteBackup, String> {
    ensure_unconfigured_recovery_mode(&app)?;
    let snapshot = open_ephemeral_s3_target(
        endpoint,
        region,
        bucket,
        prefix,
        access_key_id,
        secret_access_key,
        session_token,
    )?
    .download(snapshot_id)
    .await
    .map_err(target_error)?
    .ok_or_else(|| "offsite_backup_snapshot_not_found".to_owned())?;
    ensure_unconfigured_recovery_mode(&app)?;
    let metadata = snapshot.metadata;
    let encrypted_export = String::from_utf8(snapshot.payload)
        .map_err(|_| "offsite_backup_invalid_snapshot".to_owned())?;
    Ok(DownloadedOffsiteBackup {
        metadata,
        encrypted_export,
    })
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
        s3_provider: None,
        region: None,
        bucket: None,
        prefix: None,
        credential_id: credential_id.clone(),
        created_at_ms: current_time_milliseconds()?,
        last_upload_at_ms: None,
        last_verified_at_ms: None,
        last_restore_test_at_ms: None,
        last_restore_test_snapshot_id: None,
        automatic_enabled: false,
        automatic_interval_hours: DEFAULT_AUTOMATIC_INTERVAL_HOURS,
        automatic_revision: 0,
        automatic_uploaded_revision: 0,
        last_automatic_attempt_at_ms: None,
        last_automatic_error: None,
        retention_enabled: false,
        retention_max_snapshots: DEFAULT_RETENTION_MAX_SNAPSHOTS,
        retention_max_age_days: DEFAULT_RETENTION_MAX_AGE_DAYS,
        last_retention_cleanup_at_ms: None,
        last_retention_error: None,
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
                .any(|item| targets_conflict(item, &target_for_write))
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
#[allow(clippy::too_many_arguments)]
pub async fn configure_s3_backup_target(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    name: String,
    endpoint: String,
    s3_provider: S3ProviderTemplate,
    region: String,
    bucket: String,
    prefix: String,
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
    authorization: String,
) -> Result<BackupTargetSummary, String> {
    let permit = vault_state
        .consume_sensitive_authorization(SensitiveOperation::BackupTargetChange, &authorization)?;
    let name = validate_target_name(&name)?;
    let endpoint = S3BackupTarget::normalize_endpoint(&endpoint).map_err(target_error)?;
    let region = S3BackupTarget::normalize_region(&region).map_err(target_error)?;
    let bucket = S3BackupTarget::normalize_bucket(&bucket).map_err(target_error)?;
    let prefix = S3BackupTarget::normalize_prefix(&prefix).map_err(target_error)?;
    let mut credentials = S3CredentialRecord {
        format: S3_CREDENTIAL_FORMAT.to_owned(),
        version: S3_CREDENTIAL_VERSION,
        access_key_id,
        secret_access_key,
        session_token: session_token.filter(|value| !value.is_empty()),
    };
    let stored_credentials = Zeroizing::new(
        serde_json::to_string(&credentials)
            .map_err(|_| "offsite_backup_invalid_credential".to_owned())?,
    );
    let target = S3BackupTarget::new(
        &endpoint,
        &region,
        &bucket,
        &prefix,
        S3Credentials {
            access_key_id: std::mem::take(&mut credentials.access_key_id),
            secret_access_key: std::mem::take(&mut credentials.secret_access_key),
            session_token: credentials.session_token.take(),
        },
    )
    .map_err(target_error)?;
    target.list(None, 1).await.map_err(target_error)?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;

    let id = Uuid::new_v4();
    let credential_id = id.to_string();
    let credential_id_for_store = credential_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store_credential(&credential_id_for_store, stored_credentials.as_str())
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
        provider: BackupProviderKind::S3Compatible,
        endpoint,
        s3_provider: Some(s3_provider),
        region: Some(region),
        bucket: Some(bucket),
        prefix: Some(prefix),
        credential_id: credential_id.clone(),
        created_at_ms: current_time_milliseconds()?,
        last_upload_at_ms: None,
        last_verified_at_ms: None,
        last_restore_test_at_ms: None,
        last_restore_test_snapshot_id: None,
        automatic_enabled: false,
        automatic_interval_hours: DEFAULT_AUTOMATIC_INTERVAL_HOURS,
        automatic_revision: 0,
        automatic_uploaded_revision: 0,
        last_automatic_attempt_at_ms: None,
        last_automatic_error: None,
        retention_enabled: false,
        retention_max_snapshots: DEFAULT_RETENTION_MAX_SNAPSHOTS,
        retention_max_age_days: DEFAULT_RETENTION_MAX_AGE_DAYS,
        last_retention_cleanup_at_ms: None,
        last_retention_error: None,
    };
    let summary = target_summary(&config_target)?;
    let app_for_write = app.clone();
    let config_lock = Arc::clone(&backup_state.config_lock);
    let target_for_write = config_target.clone();
    let write_result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = config_lock
            .lock()
            .map_err(|_| "offsite_backup_config_unavailable".to_owned())?;
        let path = config_path(&app_for_write)?;
        let mut config = read_config(&path)?;
        if config.targets.len() >= MAXIMUM_TARGETS
            || config
                .targets
                .iter()
                .any(|item| targets_conflict(item, &target_for_write))
        {
            return Err("offsite_backup_target_conflict".to_owned());
        }
        config.targets.push(target_for_write);
        write_config(&path, &config)
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
    let _claim = TargetOperationClaim::acquire(&backup_state, target_id)?;
    let permit = vault_state
        .consume_sensitive_authorization(SensitiveOperation::BackupTargetChange, &authorization)?;
    let target = find_target(&app, &backup_state, target_id).await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    remove_target_config_and_credential(&app, &backup_state, &target, target_id).await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))
}

#[tauri::command]
pub async fn delete_offsite_backup(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    snapshot_id: Uuid,
    authorization: String,
) -> Result<(), String> {
    let _claim = TargetOperationClaim::acquire(&backup_state, target_id)?;
    let permit = vault_state.consume_sensitive_authorization(
        SensitiveOperation::BackupSnapshotDelete,
        &authorization,
    )?;
    let config = find_target(&app, &backup_state, target_id).await?;
    let target = open_target(&config).await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    if !target.delete(snapshot_id).await.map_err(target_error)? {
        return Err("offsite_backup_snapshot_not_found".to_owned());
    }
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    update_target_status(&app, &backup_state, target_id, move |config| {
        if config.last_restore_test_snapshot_id == Some(snapshot_id) {
            config.last_restore_test_snapshot_id = None;
            config.last_restore_test_at_ms = None;
        }
        Ok(())
    })
    .await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))
}

#[tauri::command]
pub async fn delete_all_offsite_backups_and_remove_target(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    confirmation_name: String,
    authorization: String,
) -> Result<DeleteAllOffsiteBackupsOutcome, String> {
    let _claim = TargetOperationClaim::acquire(&backup_state, target_id)?;
    let permit = vault_state
        .consume_sensitive_authorization(SensitiveOperation::BackupTargetDestroy, &authorization)?;
    let config = find_target(&app, &backup_state, target_id).await?;
    if confirmation_name != config.name {
        return Err("offsite_backup_target_confirmation_mismatch".to_owned());
    }
    let target = open_target(&config).await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    let snapshots = list_all_snapshots(target.as_ref()).await?;
    let mut deleted_count = 0;
    for snapshot in snapshots {
        ensure_workspace_access(&app, &vault_state, Some(permit))?;
        match target.delete(snapshot.id).await {
            Ok(true) => deleted_count += 1,
            Ok(false) => {
                return Ok(DeleteAllOffsiteBackupsOutcome {
                    deleted_count,
                    target_removed: false,
                    error: Some("offsite_backup_snapshot_not_found".to_owned()),
                });
            }
            Err(error) => {
                return Ok(DeleteAllOffsiteBackupsOutcome {
                    deleted_count,
                    target_removed: false,
                    error: Some(target_error(error)),
                });
            }
        }
    }
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    remove_target_config_and_credential(&app, &backup_state, &config, target_id).await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    Ok(DeleteAllOffsiteBackupsOutcome {
        deleted_count,
        target_removed: true,
        error: None,
    })
}

#[tauri::command]
pub async fn create_offsite_backup(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    contents: String,
) -> Result<BackupSnapshotMetadata, String> {
    let _claim = TargetOperationClaim::acquire(&backup_state, target_id)?;
    let permit = begin_workspace_access(&app, &vault_state)?;
    let target_config = find_target(&app, &backup_state, target_id).await?;
    let uploaded_revision = target_config.automatic_revision;
    let target = open_target(&target_config).await?;
    let encrypted = encrypt_offsite_workspace_snapshot(&app, &vault_state, contents).await?;
    ensure_workspace_access(&app, &vault_state, permit)?;
    let snapshot = BackupSnapshot::new(
        Uuid::new_v4(),
        current_time_milliseconds()?,
        encrypted.into_bytes(),
    )
    .map_err(|_| "offsite_backup_invalid_snapshot".to_owned())?;
    let metadata = target.upload(snapshot).await.map_err(target_error)?;
    ensure_workspace_access(&app, &vault_state, permit)?;
    update_target_status(&app, &backup_state, target_id, move |config| {
        record_upload_success(
            config,
            uploaded_revision,
            current_time_milliseconds()?,
            false,
        );
        Ok(())
    })
    .await?;
    ensure_workspace_access(&app, &vault_state, permit)?;
    run_retention_cleanup(&app, &backup_state, &vault_state, permit, target_id).await;
    ensure_workspace_access(&app, &vault_state, permit)?;
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
    ensure_workspace_access(&app, &vault_state, permit)?;
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
    ensure_workspace_access(&app, &vault_state, permit)?;
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
    ensure_workspace_access(&app, &vault_state, permit)?;
    update_target_status(&app, &backup_state, target_id, |config| {
        config.last_verified_at_ms = Some(current_time_milliseconds()?);
        Ok(())
    })
    .await?;
    ensure_workspace_access(&app, &vault_state, permit)?;
    Ok(verification)
}

#[tauri::command]
pub async fn test_offsite_backup_restore(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    snapshot_id: Uuid,
    password: String,
) -> Result<BackupTargetSummary, String> {
    let permit = begin_workspace_access(&app, &vault_state)?
        .ok_or_else(|| "workspace_vault_not_configured".to_owned())?;
    let config = find_target(&app, &backup_state, target_id).await?;
    let snapshot = open_target(&config)
        .await?
        .download(snapshot_id)
        .await
        .map_err(target_error)?
        .ok_or_else(|| "offsite_backup_snapshot_not_found".to_owned())?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    let encrypted = Zeroizing::new(
        String::from_utf8(snapshot.payload)
            .map_err(|_| "offsite_backup_invalid_snapshot".to_owned())?,
    );
    let password = Zeroizing::new(password);
    let access_generation = vault_state.access_generation();
    let restore_result = tauri::async_runtime::spawn_blocking(move || {
        test_offsite_workspace_restore(
            encrypted.as_str(),
            password.as_str(),
            Some(&access_generation),
            Some(permit),
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    restore_result?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    let completed_at_ms = current_time_milliseconds()?;
    update_target_status(&app, &backup_state, target_id, move |config| {
        config.last_verified_at_ms = Some(completed_at_ms);
        config.last_restore_test_at_ms = Some(completed_at_ms);
        config.last_restore_test_snapshot_id = Some(snapshot_id);
        Ok(())
    })
    .await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    let updated = find_target(&app, &backup_state, target_id).await?;
    target_summary(&updated)
}

async fn open_target(config: &BackupTargetConfig) -> Result<Box<dyn BackupTarget>, String> {
    let credential = load_credential_async(config.credential_id.clone()).await?;
    match config.provider {
        BackupProviderKind::CloudflareWorkerR2 => {
            CloudflareBackupTarget::new(&config.endpoint, credential.to_string())
                .map(|target| Box::new(target) as Box<dyn BackupTarget>)
                .map_err(target_error)
        }
        BackupProviderKind::S3Compatible => {
            let credentials = parse_s3_credentials(credential.as_str())?;
            S3BackupTarget::new(
                &config.endpoint,
                config
                    .region
                    .as_deref()
                    .ok_or_else(|| "offsite_backup_invalid_config".to_owned())?,
                config
                    .bucket
                    .as_deref()
                    .ok_or_else(|| "offsite_backup_invalid_config".to_owned())?,
                config
                    .prefix
                    .as_deref()
                    .ok_or_else(|| "offsite_backup_invalid_config".to_owned())?,
                credentials,
            )
            .map(|target| Box::new(target) as Box<dyn BackupTarget>)
            .map_err(target_error)
        }
    }
}

fn open_ephemeral_cloudflare_target(
    endpoint: String,
    token: String,
) -> Result<CloudflareBackupTarget, String> {
    let token = Zeroizing::new(token);
    CloudflareBackupTarget::new(&endpoint, token.to_string()).map_err(target_error)
}

#[allow(clippy::too_many_arguments)]
fn open_ephemeral_s3_target(
    endpoint: String,
    region: String,
    bucket: String,
    prefix: String,
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
) -> Result<S3BackupTarget, String> {
    S3BackupTarget::new(
        &endpoint,
        &region,
        &bucket,
        &prefix,
        S3Credentials {
            access_key_id,
            secret_access_key,
            session_token: session_token.filter(|value| !value.is_empty()),
        },
    )
    .map_err(target_error)
}

fn parse_s3_credentials(contents: &str) -> Result<S3Credentials, String> {
    let mut record: S3CredentialRecord = serde_json::from_str(contents)
        .map_err(|_| "offsite_backup_invalid_credential".to_owned())?;
    if record.format != S3_CREDENTIAL_FORMAT || record.version != S3_CREDENTIAL_VERSION {
        return Err("offsite_backup_invalid_credential".to_owned());
    }
    Ok(S3Credentials {
        access_key_id: std::mem::take(&mut record.access_key_id),
        secret_access_key: std::mem::take(&mut record.secret_access_key),
        session_token: record.session_token.take(),
    })
}

fn ensure_unconfigured_recovery_mode(app: &tauri::AppHandle) -> Result<(), String> {
    if workspace_encryption_configured(app) {
        Err("offsite_recovery_requires_unconfigured_workspace".to_owned())
    } else {
        Ok(())
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

async fn remove_target_config_and_credential(
    app: &tauri::AppHandle,
    state: &OffsiteBackupState,
    target: &BackupTargetConfig,
    target_id: Uuid,
) -> Result<(), String> {
    let credential = load_credential_async(target.credential_id.clone()).await?;
    delete_credential_async(target.credential_id.clone()).await?;
    let app_for_write = app.clone();
    let config_lock = Arc::clone(&state.config_lock);
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
    Ok(())
}

async fn list_all_snapshots(
    target: &dyn BackupTarget,
) -> Result<Vec<BackupSnapshotMetadata>, String> {
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut snapshots = Vec::new();
    loop {
        let page = target
            .list(cursor, MAX_BACKUP_PAGE_LIMIT)
            .await
            .map_err(target_error)?;
        snapshots.extend(page.items);
        cursor = page.next_cursor;
        if cursor
            .as_ref()
            .is_some_and(|value| !seen_cursors.insert(value.clone()))
        {
            return Err("offsite_backup_invalid_response".to_owned());
        }
        if cursor.is_none() {
            break;
        }
    }
    Ok(snapshots)
}

fn automatic_backup_due(target: &BackupTargetConfig, now: u64) -> bool {
    if !target.automatic_enabled || target.automatic_revision <= target.automatic_uploaded_revision
    {
        return false;
    }
    let interval_ms = u64::from(target.automatic_interval_hours).saturating_mul(60 * 60 * 1_000);
    let upload_due = target
        .last_upload_at_ms
        .is_none_or(|last| now.saturating_sub(last) >= interval_ms);
    let retry_due = target
        .last_automatic_attempt_at_ms
        .is_none_or(|last| now.saturating_sub(last) >= AUTOMATIC_RETRY_DELAY_MS);
    upload_due && retry_due
}

fn claim_automatic_upload(state: &OffsiteBackupState, target_id: Uuid) -> bool {
    state
        .automatic_uploads
        .lock()
        .map(|mut uploads| uploads.insert(target_id))
        .unwrap_or(false)
}

fn release_automatic_upload(state: &OffsiteBackupState, target_id: Uuid) {
    if let Ok(mut uploads) = state.automatic_uploads.lock() {
        uploads.remove(&target_id);
    }
}

async fn run_automatic_upload(
    app: &tauri::AppHandle,
    state: &OffsiteBackupState,
    vault_state: &WorkspaceVaultState,
    permit: Option<WorkspaceAccessPermit>,
    target_config: &BackupTargetConfig,
    snapshot: BackupSnapshot,
) -> AutomaticBackupOutcome {
    let target_id = target_config.id;
    let result = async {
        ensure_workspace_access(app, vault_state, permit)?;
        let target = open_target(target_config).await?;
        ensure_workspace_access(app, vault_state, permit)?;
        target.upload(snapshot).await.map_err(target_error)?;
        ensure_workspace_access(app, vault_state, permit)?;
        let uploaded_revision = target_config.automatic_revision;
        update_target_status(app, state, target_id, move |config| {
            record_upload_success(
                config,
                uploaded_revision,
                current_time_milliseconds()?,
                true,
            );
            Ok(())
        })
        .await?;
        ensure_workspace_access(app, vault_state, permit)
    }
    .await;

    match result {
        Ok(()) => {
            run_retention_cleanup(app, state, vault_state, permit, target_id).await;
            AutomaticBackupOutcome {
                target_id,
                uploaded: true,
                error: None,
            }
        }
        Err(error) => {
            let stored_error = bounded_automatic_error(&error);
            if error != "workspace_vault_session_expired" && error != "workspace_vault_locked" {
                let error_for_config = stored_error.clone();
                let _ = update_target_status(app, state, target_id, move |config| {
                    config.last_automatic_attempt_at_ms = Some(current_time_milliseconds()?);
                    config.last_automatic_error = Some(error_for_config);
                    Ok(())
                })
                .await;
            }
            AutomaticBackupOutcome {
                target_id,
                uploaded: false,
                error: Some(stored_error),
            }
        }
    }
}

fn bounded_automatic_error(error: &str) -> String {
    error.chars().take(160).collect()
}

fn record_upload_success(
    config: &mut BackupTargetConfig,
    uploaded_revision: u64,
    uploaded_at_ms: u64,
    automatic: bool,
) {
    config.last_upload_at_ms = Some(uploaded_at_ms);
    if automatic {
        config.last_automatic_attempt_at_ms = Some(uploaded_at_ms);
    }
    config.automatic_uploaded_revision = config.automatic_uploaded_revision.max(uploaded_revision);
    config.last_automatic_error = None;
}

async fn run_retention_cleanup(
    app: &tauri::AppHandle,
    state: &OffsiteBackupState,
    vault_state: &WorkspaceVaultState,
    permit: Option<WorkspaceAccessPermit>,
    target_id: Uuid,
) {
    let result = async {
        let config = find_target(app, state, target_id).await?;
        if !config.retention_enabled {
            return Ok(());
        }
        if config.last_restore_test_at_ms.is_some()
            && config.last_restore_test_snapshot_id.is_none()
        {
            return Err("offsite_backup_retention_requires_new_restore_drill".to_owned());
        }
        ensure_workspace_access(app, vault_state, permit)?;
        let target = open_target(&config).await?;
        let snapshots = list_all_snapshots(target.as_ref()).await?;
        let now = current_time_milliseconds()?;
        let candidates = retention_candidates(&config, snapshots, now);
        for snapshot in candidates {
            ensure_workspace_access(app, vault_state, permit)?;
            if !target.delete(snapshot.id).await.map_err(target_error)? {
                return Err("offsite_backup_snapshot_not_found".to_owned());
            }
        }
        ensure_workspace_access(app, vault_state, permit)?;
        update_target_status(app, state, target_id, move |target| {
            target.last_retention_cleanup_at_ms = Some(now);
            target.last_retention_error = None;
            Ok(())
        })
        .await
    }
    .await;

    if let Err(error) = result {
        if error != "workspace_vault_session_expired" && error != "workspace_vault_locked" {
            let bounded = bounded_automatic_error(&error);
            let _ = update_target_status(app, state, target_id, move |target| {
                target.last_retention_error = Some(bounded);
                Ok(())
            })
            .await;
        }
    }
}

fn retention_candidates(
    config: &BackupTargetConfig,
    mut snapshots: Vec<BackupSnapshotMetadata>,
    now: u64,
) -> Vec<BackupSnapshotMetadata> {
    snapshots.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| right.id.cmp(&left.id))
    });
    let newest_id = snapshots.first().map(|snapshot| snapshot.id);
    let maximum_age_ms =
        u64::from(config.retention_max_age_days).saturating_mul(24 * 60 * 60 * 1_000);
    snapshots
        .into_iter()
        .enumerate()
        .filter(|(index, snapshot)| {
            let protected = Some(snapshot.id) == newest_id
                || Some(snapshot.id) == config.last_restore_test_snapshot_id;
            let exceeds_count = *index >= config.retention_max_snapshots as usize;
            let exceeds_age = now.saturating_sub(snapshot.created_at_ms) > maximum_age_ms;
            !protected && (exceeds_count || exceeds_age)
        })
        .map(|(_, snapshot)| snapshot)
        .collect()
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
        BackupProviderKind::CloudflareWorkerR2 | BackupProviderKind::S3Compatible => {
            Some(100 * 1024 * 1024)
        }
    };
    Ok(BackupTargetSummary {
        id: config.id,
        name: config.name.clone(),
        provider: config.provider,
        endpoint: config.endpoint.clone(),
        s3_provider: config.s3_provider,
        region: config.region.clone(),
        bucket: config.bucket.clone(),
        prefix: config.prefix.clone(),
        created_at_ms: config.created_at_ms,
        last_upload_at_ms: config.last_upload_at_ms,
        last_verified_at_ms: config.last_verified_at_ms,
        last_restore_test_at_ms: config.last_restore_test_at_ms,
        maximum_upload_bytes,
        automatic_enabled: config.automatic_enabled,
        automatic_interval_hours: config.automatic_interval_hours,
        automatic_pending: config.automatic_revision > config.automatic_uploaded_revision,
        last_automatic_attempt_at_ms: config.last_automatic_attempt_at_ms,
        last_automatic_error: config.last_automatic_error.clone(),
        retention_enabled: config.retention_enabled,
        retention_max_snapshots: config.retention_max_snapshots,
        retention_max_age_days: config.retention_max_age_days,
        last_retention_cleanup_at_ms: config.last_retention_cleanup_at_ms,
        last_retention_error: config.last_retention_error.clone(),
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
    for target in &config.targets {
        validate_target_name(&target.name)?;
        let provider_config_valid = match target.provider {
            BackupProviderKind::CloudflareWorkerR2 => {
                CloudflareBackupTarget::normalize_endpoint(&target.endpoint)
                    .map(|endpoint| {
                        endpoint == target.endpoint
                            && target.s3_provider.is_none()
                            && target.region.is_none()
                            && target.bucket.is_none()
                            && target.prefix.is_none()
                    })
                    .unwrap_or(false)
            }
            BackupProviderKind::S3Compatible => {
                let Some(region) = target.region.as_deref() else {
                    return Err("offsite_backup_invalid_config".to_owned());
                };
                let Some(bucket) = target.bucket.as_deref() else {
                    return Err("offsite_backup_invalid_config".to_owned());
                };
                let Some(prefix) = target.prefix.as_deref() else {
                    return Err("offsite_backup_invalid_config".to_owned());
                };
                target.s3_provider.is_some()
                    && S3BackupTarget::normalize_endpoint(&target.endpoint)
                        .is_ok_and(|endpoint| endpoint == target.endpoint)
                    && S3BackupTarget::normalize_region(region)
                        .is_ok_and(|normalized| normalized == region)
                    && S3BackupTarget::normalize_bucket(bucket)
                        .is_ok_and(|normalized| normalized == bucket)
                    && S3BackupTarget::normalize_prefix(prefix)
                        .is_ok_and(|normalized| normalized == prefix)
            }
        };
        if !ids.insert(target.id)
            || !provider_config_valid
            || Uuid::parse_str(&target.credential_id).is_err()
            || target.created_at_ms == 0
            || !(1..=MAXIMUM_AUTOMATIC_INTERVAL_HOURS).contains(&target.automatic_interval_hours)
            || validate_retention_settings(
                target.retention_max_snapshots,
                target.retention_max_age_days,
            )
            .is_err()
            || target.automatic_uploaded_revision > target.automatic_revision
            || (target.last_restore_test_snapshot_id.is_some()
                && target.last_restore_test_at_ms.is_none())
            || target
                .last_automatic_error
                .as_ref()
                .is_some_and(|error| error.is_empty() || error.chars().count() > 160)
            || target
                .last_retention_error
                .as_ref()
                .is_some_and(|error| error.is_empty() || error.chars().count() > 160)
            || [
                target.last_upload_at_ms,
                target.last_verified_at_ms,
                target.last_restore_test_at_ms,
                target.last_automatic_attempt_at_ms,
                target.last_retention_cleanup_at_ms,
            ]
            .into_iter()
            .flatten()
            .any(|timestamp| timestamp == 0)
        {
            return Err("offsite_backup_invalid_config".to_owned());
        }
    }
    for (index, target) in config.targets.iter().enumerate() {
        if config.targets[index + 1..]
            .iter()
            .any(|other| targets_conflict(target, other))
        {
            return Err("offsite_backup_invalid_config".to_owned());
        }
    }
    Ok(())
}

fn targets_conflict(left: &BackupTargetConfig, right: &BackupTargetConfig) -> bool {
    match (left.provider, right.provider) {
        (BackupProviderKind::CloudflareWorkerR2, BackupProviderKind::CloudflareWorkerR2) => {
            left.endpoint == right.endpoint
        }
        (BackupProviderKind::S3Compatible, BackupProviderKind::S3Compatible) => {
            left.endpoint == right.endpoint
                && left.region == right.region
                && left.bucket == right.bucket
                && left.prefix == right.prefix
        }
        _ => false,
    }
}

fn validate_target_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("offsite_backup_invalid_target_name".to_owned());
    }
    Ok(name.to_owned())
}

fn validate_retention_settings(max_snapshots: u32, max_age_days: u32) -> Result<(), String> {
    if !(1..=MAXIMUM_RETENTION_SNAPSHOTS).contains(&max_snapshots)
        || !(1..=MAXIMUM_RETENTION_AGE_DAYS).contains(&max_age_days)
    {
        return Err("offsite_backup_invalid_retention_settings".to_owned());
    }
    Ok(())
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
            s3_provider: None,
            region: None,
            bucket: None,
            prefix: None,
            credential_id: Uuid::new_v4().to_string(),
            created_at_ms: 42,
            last_upload_at_ms: None,
            last_verified_at_ms: None,
            last_restore_test_at_ms: None,
            last_restore_test_snapshot_id: None,
            automatic_enabled: false,
            automatic_interval_hours: DEFAULT_AUTOMATIC_INTERVAL_HOURS,
            automatic_revision: 0,
            automatic_uploaded_revision: 0,
            last_automatic_attempt_at_ms: None,
            last_automatic_error: None,
            retention_enabled: false,
            retention_max_snapshots: DEFAULT_RETENTION_MAX_SNAPSHOTS,
            retention_max_age_days: DEFAULT_RETENTION_MAX_AGE_DAYS,
            last_retention_cleanup_at_ms: None,
            last_retention_error: None,
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
            s3_provider: None,
            region: None,
            bucket: None,
            prefix: None,
            credential_id: Uuid::new_v4().to_string(),
            created_at_ms: 42,
            last_upload_at_ms: None,
            last_verified_at_ms: None,
            last_restore_test_at_ms: None,
            last_restore_test_snapshot_id: None,
            automatic_enabled: false,
            automatic_interval_hours: DEFAULT_AUTOMATIC_INTERVAL_HOURS,
            automatic_revision: 0,
            automatic_uploaded_revision: 0,
            last_automatic_attempt_at_ms: None,
            last_automatic_error: None,
            retention_enabled: false,
            retention_max_snapshots: DEFAULT_RETENTION_MAX_SNAPSHOTS,
            retention_max_age_days: DEFAULT_RETENTION_MAX_AGE_DAYS,
            last_retention_cleanup_at_ms: None,
            last_retention_error: None,
        };
        let serialized = serde_json::to_string(&OffsiteBackupConfig {
            targets: vec![target],
            ..OffsiteBackupConfig::default()
        })
        .unwrap();

        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("secret"));
    }

    fn s3_target(prefix: &str) -> BackupTargetConfig {
        BackupTargetConfig {
            id: Uuid::new_v4(),
            name: "Backblaze".to_owned(),
            provider: BackupProviderKind::S3Compatible,
            endpoint: "https://s3.us-west-004.backblazeb2.com/".to_owned(),
            s3_provider: Some(S3ProviderTemplate::BackblazeB2),
            region: Some("us-west-004".to_owned()),
            bucket: Some("linked-info-backup".to_owned()),
            prefix: Some(prefix.to_owned()),
            credential_id: Uuid::new_v4().to_string(),
            created_at_ms: 42,
            last_upload_at_ms: None,
            last_verified_at_ms: None,
            last_restore_test_at_ms: None,
            last_restore_test_snapshot_id: None,
            automatic_enabled: false,
            automatic_interval_hours: DEFAULT_AUTOMATIC_INTERVAL_HOURS,
            automatic_revision: 0,
            automatic_uploaded_revision: 0,
            last_automatic_attempt_at_ms: None,
            last_automatic_error: None,
            retention_enabled: false,
            retention_max_snapshots: DEFAULT_RETENTION_MAX_SNAPSHOTS,
            retention_max_age_days: DEFAULT_RETENTION_MAX_AGE_DAYS,
            last_retention_cleanup_at_ms: None,
            last_retention_error: None,
        }
    }

    #[test]
    fn s3_config_contains_location_but_never_credentials() {
        let serialized = serde_json::to_string(&OffsiteBackupConfig {
            targets: vec![s3_target("linked-info/v1")],
            ..OffsiteBackupConfig::default()
        })
        .unwrap();

        assert!(serialized.contains("s3.us-west-004.backblazeb2.com"));
        assert!(serialized.contains("linked-info-backup"));
        assert!(!serialized.contains("accessKeyId"));
        assert!(!serialized.contains("secretAccessKey"));
        assert!(!serialized.contains("sessionToken"));
    }

    #[test]
    fn s3_targets_can_share_a_bucket_when_prefixes_differ() {
        let left = s3_target("linked-info/primary");
        let right = s3_target("linked-info/secondary");

        assert!(!targets_conflict(&left, &right));
        assert!(
            validate_config(&OffsiteBackupConfig {
                targets: vec![left, right],
                ..OffsiteBackupConfig::default()
            })
            .is_ok()
        );
    }

    #[test]
    fn existing_cloudflare_config_without_s3_fields_stays_valid() {
        let json = format!(
            r#"{{
              "format": "{CONFIG_FORMAT}",
              "version": {CONFIG_VERSION},
              "targets": [{{
                "id": "{}",
                "name": "Cloudflare",
                "provider": "cloudflareWorkerR2",
                "endpoint": "https://backup.example.test/",
                "credentialId": "{}",
                "createdAtMs": 42,
                "lastUploadAtMs": null,
                "lastVerifiedAtMs": null,
                "lastRestoreTestAtMs": null
              }}]
            }}"#,
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let config: OffsiteBackupConfig = serde_json::from_str(&json).unwrap();

        assert!(validate_config(&config).is_ok());
        assert!(config.targets[0].region.is_none());
        assert!(!config.targets[0].automatic_enabled);
        assert_eq!(
            config.targets[0].automatic_interval_hours,
            DEFAULT_AUTOMATIC_INTERVAL_HOURS
        );
    }

    #[test]
    fn automatic_backup_waits_for_changes_and_the_interval() {
        let mut target = s3_target("linked-info/v1");
        target.automatic_enabled = true;
        target.automatic_revision = 2;
        target.automatic_uploaded_revision = 1;
        target.last_upload_at_ms = Some(1_000);

        assert!(!automatic_backup_due(&target, 1_000 + 23 * 60 * 60 * 1_000));
        assert!(automatic_backup_due(&target, 1_000 + 24 * 60 * 60 * 1_000));
        target.automatic_uploaded_revision = 2;
        assert!(!automatic_backup_due(&target, 1_000 + 48 * 60 * 60 * 1_000));
    }

    #[test]
    fn completed_upload_does_not_clear_changes_made_while_it_was_running() {
        let mut target = s3_target("linked-info/v1");
        target.automatic_enabled = true;
        target.automatic_revision = 5;
        target.automatic_uploaded_revision = 2;

        record_upload_success(&mut target, 3, 10_000, true);

        assert_eq!(target.automatic_uploaded_revision, 3);
        assert_eq!(target.automatic_revision, 5);
        assert!(target_summary(&target).unwrap().automatic_pending);
    }

    fn snapshot(id: Uuid, created_at_ms: u64) -> BackupSnapshotMetadata {
        BackupSnapshotMetadata {
            id,
            created_at_ms,
            size_bytes: 1,
            sha256: "a".repeat(64),
        }
    }

    #[test]
    fn retention_keeps_newest_and_last_restore_tested_snapshot() {
        let now = 200 * 24 * 60 * 60 * 1_000;
        let newest = Uuid::new_v4();
        let tested = Uuid::new_v4();
        let old = Uuid::new_v4();
        let mut target = s3_target("linked-info/v1");
        target.retention_enabled = true;
        target.retention_max_snapshots = 1;
        target.retention_max_age_days = 1;
        target.last_restore_test_snapshot_id = Some(tested);

        let candidates = retention_candidates(
            &target,
            vec![
                snapshot(old, now - 100),
                snapshot(tested, now - 50),
                snapshot(newest, now),
            ],
            now,
        );

        assert_eq!(
            candidates
                .into_iter()
                .map(|snapshot| snapshot.id)
                .collect::<Vec<_>>(),
            vec![old]
        );
    }

    #[test]
    fn retention_uses_count_or_age_limit() {
        let day = 24 * 60 * 60 * 1_000;
        let now = 200 * day;
        let newest = Uuid::new_v4();
        let second = Uuid::new_v4();
        let expired = Uuid::new_v4();
        let mut target = s3_target("linked-info/v1");
        target.retention_enabled = true;
        target.retention_max_snapshots = 2;
        target.retention_max_age_days = 30;

        let candidates = retention_candidates(
            &target,
            vec![
                snapshot(expired, now - 31 * day),
                snapshot(second, now - day),
                snapshot(newest, now),
            ],
            now,
        );

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].id, expired);
    }
}
