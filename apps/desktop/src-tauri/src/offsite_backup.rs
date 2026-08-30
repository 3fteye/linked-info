use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use linked_info_backup_port::{
    BackupDeleteOutcome, BackupListPage, BackupOperationGuard, BackupPurgeOutcome, BackupSnapshot,
    BackupSnapshotMetadata, BackupTarget, BackupTargetError, BackupVerification,
    MAX_BACKUP_PAGE_LIMIT,
};
use serde::{Deserialize, Serialize};
use sha2_11::Sha256;
use tauri::Manager;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::{
    s3_backup_target::{S3BackupTarget, S3Credentials},
    workspace_file::{
        SensitiveOperation, WorkspaceAccessPermit, WorkspaceVaultState, begin_workspace_access,
        encrypt_offsite_workspace_snapshot, ensure_workspace_access,
        test_current_offsite_workspace_restore, workspace_encryption_configured, write_atomically,
    },
};

const CONFIG_FILE_NAME: &str = "offsite-backup-targets.json";
const CONFIG_TRANSACTION_FILE_NAME: &str = "offsite-backup-targets.transaction.json";
const CONFIG_FORMAT: &str = "linked-info-offsite-backup-targets";
const CONFIG_VERSION: u16 = 1;
const AUTHENTICATED_CONFIG_FORMAT: &str = "linked-info-authenticated-offsite-backup-targets";
const AUTHENTICATED_CONFIG_VERSION: u16 = 1;
const CONFIG_TRANSACTION_FORMAT: &str = "linked-info-offsite-backup-transaction";
const CONFIG_TRANSACTION_VERSION: u16 = 1;
const CONFIG_AUTH_CREDENTIAL_ID: &str = "00000000-0000-4000-8000-000000000001";
const CONFIG_AUTH_KEY_BYTES: usize = 32;
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

/// Bridges the workspace access generation into the provider-neutral backup
/// port. The S3 adapter checks this guard before every page, delete request,
/// and verification pass, so a lock/session replacement stops the next
/// destructive step without exposing vault details to the adapter.
struct WorkspaceBackupOperationGuard<'a> {
    vault_state: &'a WorkspaceVaultState,
    permit: Option<WorkspaceAccessPermit>,
}

impl<'a> WorkspaceBackupOperationGuard<'a> {
    fn new(vault_state: &'a WorkspaceVaultState, permit: Option<WorkspaceAccessPermit>) -> Self {
        Self {
            vault_state,
            permit,
        }
    }
}

impl BackupOperationGuard for WorkspaceBackupOperationGuard<'_> {
    fn check(&self) -> Result<(), BackupTargetError> {
        self.permit
            .ok_or(BackupTargetError::Cancelled)
            .and_then(|permit| {
                self.vault_state
                    .ensure_access_permit(permit)
                    .map_err(|_| BackupTargetError::Cancelled)
            })
    }
}

fn acquire_authorized_config_mutation<'a>(
    config_lock: &'a Mutex<()>,
    vault_state: &WorkspaceVaultState,
    permit: WorkspaceAccessPermit,
) -> Result<std::sync::MutexGuard<'a, ()>, String> {
    let guard = config_lock
        .lock()
        .map_err(|_| "offsite_backup_config_unavailable".to_owned())?;
    // Close the queueing gap before preparation. Callers revalidate again
    // immediately before their first new persistent write.
    vault_state.ensure_access_permit(permit)?;
    Ok(guard)
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticatedOffsiteBackupConfig {
    format: String,
    version: u16,
    config: OffsiteBackupConfig,
    authentication: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ConfigTransactionKind {
    Create,
    Update,
    Remove,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OffsiteBackupConfigTransaction {
    format: String,
    version: u16,
    operation_id: Uuid,
    kind: ConfigTransactionKind,
    target_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_credential_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_credential_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<BackupTargetConfig>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticatedOffsiteBackupConfigTransaction {
    format: String,
    version: u16,
    transaction: OffsiteBackupConfigTransaction,
    authentication: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum BackupProviderKind {
    S3Compatible,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum S3ProviderTemplate {
    CloudflareR2,
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
    /// Number of remote object-version and delete-marker records removed.
    deleted_version_count: usize,
    target_removed: bool,
    error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOffsiteBackupTargetOutcome {
    target_removed: bool,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateS3BackupTargetOutcome {
    target: BackupTargetSummary,
    error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TargetCredentialCleanup {
    Complete,
    Pending,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommittedCreateCredentialState {
    Present,
    Missing,
    Unavailable,
}

fn credential_cleanup_warning(cleanup: TargetCredentialCleanup) -> Option<String> {
    (cleanup == TargetCredentialCleanup::Pending)
        .then(|| "offsite_backup_credential_cleanup_pending".to_owned())
}

fn classify_target_credential_cleanup(
    credential_referenced_elsewhere: bool,
    delete_stale_credential: impl FnOnce() -> Result<(), String>,
) -> TargetCredentialCleanup {
    if credential_referenced_elsewhere || delete_stale_credential().is_ok() {
        TargetCredentialCleanup::Complete
    } else {
        TargetCredentialCleanup::Pending
    }
}

fn classify_committed_create_credential(
    credential: Result<Zeroizing<String>, String>,
) -> CommittedCreateCredentialState {
    match credential {
        Ok(_) => CommittedCreateCredentialState::Present,
        Err(error) if error == "offsite_backup_credential_missing" => {
            CommittedCreateCredentialState::Missing
        }
        Err(_) => CommittedCreateCredentialState::Unavailable,
    }
}

fn committed_create_transaction_can_clear(credential: Result<Zeroizing<String>, String>) -> bool {
    matches!(
        classify_committed_create_credential(credential),
        CommittedCreateCredentialState::Present | CommittedCreateCredentialState::Missing
    )
}

fn committed_target_removal_outcome(
    cleanup: TargetCredentialCleanup,
) -> RemoveOffsiteBackupTargetOutcome {
    RemoveOffsiteBackupTargetOutcome {
        target_removed: true,
        error: credential_cleanup_warning(cleanup),
    }
}

fn committed_target_update_outcome(
    target: BackupTargetSummary,
    cleanup: TargetCredentialCleanup,
) -> UpdateS3BackupTargetOutcome {
    UpdateS3BackupTargetOutcome {
        target,
        error: credential_cleanup_warning(cleanup),
    }
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
    vault_state: tauri::State<'_, WorkspaceVaultState>,
) -> Result<Vec<BackupTargetSummary>, String> {
    let permit = begin_workspace_access(&app, &vault_state)?;
    let config = read_config_locked(&app, &state).await?;
    ensure_workspace_access(&app, &vault_state, permit)?;
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
        let mut config = read_config_for_mutation(&path)?;
        let target = config
            .targets
            .iter_mut()
            .find(|target| target.id == target_id)
            .ok_or_else(|| "offsite_backup_target_not_found".to_owned())?;
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
        let vault_state_for_write = app_for_write.state::<WorkspaceVaultState>();
        let _guard = acquire_authorized_config_mutation(
            &config_lock,
            &vault_state_for_write,
            permit,
        )?;
        let path = config_path(&app_for_write)?;
        let mut config = read_config_for_mutation(&path)?;
        let target = config
            .targets
            .iter_mut()
            .find(|target| target.id == target_id)
            .ok_or_else(|| "offsite_backup_target_not_found".to_owned())?;
        ensure_retention_enable_allowed(target, enabled)?;
        target.retention_enabled = enabled;
        target.retention_max_snapshots = max_snapshots;
        target.retention_max_age_days = max_age_days;
        target.last_retention_error = None;
        let summary = target_summary(target)?;
        vault_state_for_write.ensure_access_permit(permit)?;
        write_config(&path, &config)?;
        Ok::<_, String>(summary)
    })
    .await
    .map_err(|error| error.to_string())??;
    // A lock after admission must not report an already committed rule as failed.
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
        let mut config = read_config_for_mutation(&path)?;
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
    let transaction = OffsiteBackupConfigTransaction {
        format: CONFIG_TRANSACTION_FORMAT.to_owned(),
        version: CONFIG_TRANSACTION_VERSION,
        operation_id: Uuid::new_v4(),
        kind: ConfigTransactionKind::Create,
        target_id: id,
        previous_credential_id: None,
        next_credential_id: Some(credential_id.clone()),
        target: Some(config_target),
    };
    let write_result = tauri::async_runtime::spawn_blocking(move || {
        let vault_state_for_write = app_for_write.state::<WorkspaceVaultState>();
        let _guard = acquire_authorized_config_mutation(
            &config_lock,
            &vault_state_for_write,
            permit,
        )?;
        let path = config_path(&app_for_write)?;
        let mut config = read_config_for_mutation(&path)?;
        if config.targets.len() >= MAXIMUM_TARGETS
            || config
                .targets
                .iter()
                .any(|item| targets_conflict(item, &target_for_write))
        {
            return Err("offsite_backup_target_conflict".to_owned());
        }
        let transaction_path = config_transaction_path(&path)?;
        vault_state_for_write.ensure_access_permit(permit)?;
        write_config_transaction(&transaction_path, &transaction)?;
        if let Err(error) = store_credential(&credential_id, stored_credentials.as_str()) {
            // Keep the journal. The next read can distinguish an uncommitted
            // create and retry cleanup without relying on an in-memory rollback.
            return Err(error);
        }
        config.targets.push(target_for_write);
        write_config_unchecked(&path, &config)?;
        // A failed journal cleanup does not undo a committed configuration.
        // Startup/read recovery will retry it after the keyring is available.
        let _ = clear_config_transaction(&transaction_path);
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?;
    write_result?;
    // Configuration is committed. A concurrent lock must not turn this into a
    // false pre-commit error; the returned summary contains no credentials.
    Ok(summary)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_s3_backup_target(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    name: String,
    endpoint: String,
    s3_provider: S3ProviderTemplate,
    region: String,
    bucket: String,
    prefix: String,
    replace_credentials: bool,
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
    authorization: String,
) -> Result<UpdateS3BackupTargetOutcome, String> {
    let _claim = TargetOperationClaim::acquire(&backup_state, target_id)?;
    let permit = vault_state
        .consume_sensitive_authorization(SensitiveOperation::BackupTargetChange, &authorization)?;
    let name = validate_target_name(&name)?;
    let endpoint = S3BackupTarget::normalize_endpoint(&endpoint).map_err(target_error)?;
    let region = S3BackupTarget::normalize_region(&region).map_err(target_error)?;
    let bucket = S3BackupTarget::normalize_bucket(&bucket).map_err(target_error)?;
    let prefix = S3BackupTarget::normalize_prefix(&prefix).map_err(target_error)?;
    let previous = find_target(&app, &backup_state, target_id).await?;

    let (credentials, replacement_credential) = if replace_credentials {
        let mut record = S3CredentialRecord {
            format: S3_CREDENTIAL_FORMAT.to_owned(),
            version: S3_CREDENTIAL_VERSION,
            access_key_id,
            secret_access_key,
            session_token: session_token.filter(|value| !value.is_empty()),
        };
        let stored = Zeroizing::new(
            serde_json::to_string(&record)
                .map_err(|_| "offsite_backup_invalid_credential".to_owned())?,
        );
        let credential_id = Uuid::new_v4().to_string();
        let credentials = S3Credentials {
            access_key_id: std::mem::take(&mut record.access_key_id),
            secret_access_key: std::mem::take(&mut record.secret_access_key),
            session_token: record.session_token.take(),
        };
        (credentials, Some((credential_id, stored)))
    } else {
        if !access_key_id.is_empty()
            || !secret_access_key.is_empty()
            || session_token
                .as_ref()
                .is_some_and(|value| !value.is_empty())
        {
            return Err("offsite_backup_unexpected_credential_input".to_owned());
        }
        let stored = load_credential_async(previous.credential_id.clone()).await?;
        (parse_s3_credentials(stored.as_str())?, None)
    };

    let target = S3BackupTarget::new(&endpoint, &region, &bucket, &prefix, credentials)
        .map_err(target_error)?;
    target.list(None, 1).await.map_err(target_error)?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;

    let app_for_write = app.clone();
    let config_lock = Arc::clone(&backup_state.config_lock);
    let endpoint_for_write = endpoint.clone();
    let region_for_write = region.clone();
    let bucket_for_write = bucket.clone();
    let prefix_for_write = prefix.clone();
    let previous_credential_id = previous.credential_id.clone();
    let write_result = tauri::async_runtime::spawn_blocking(move || {
        let vault_state_for_write = app_for_write.state::<WorkspaceVaultState>();
        let _guard = acquire_authorized_config_mutation(
            &config_lock,
            &vault_state_for_write,
            permit,
        )?;
        let path = config_path(&app_for_write)?;
        let mut config = read_config_for_mutation(&path)?;
        let index = config
            .targets
            .iter()
            .position(|target| target.id == target_id)
            .ok_or_else(|| "offsite_backup_target_not_found".to_owned())?;
        let current = config.targets[index].clone();
        if current.credential_id != previous_credential_id {
            return Err("offsite_backup_target_changed".to_owned());
        }
        let mut updated = current;
        let remote_location_changed = remote_target_location_changed(
            &updated,
            &endpoint_for_write,
            &region_for_write,
            &bucket_for_write,
            &prefix_for_write,
        );
        updated.name = name;
        updated.endpoint = endpoint_for_write;
        updated.s3_provider = Some(s3_provider);
        updated.region = Some(region_for_write);
        updated.bucket = Some(bucket_for_write);
        updated.prefix = Some(prefix_for_write);
        if remote_location_changed {
            reset_remote_target_status(&mut updated);
        }
        if config
            .targets
            .iter()
            .enumerate()
            .any(|(item_index, item)| item_index != index && targets_conflict(item, &updated))
        {
            return Err("offsite_backup_target_conflict".to_owned());
        }
        if let Some((next_credential_id, stored)) = replacement_credential {
            updated.credential_id = next_credential_id.clone();
            let transaction = OffsiteBackupConfigTransaction {
                format: CONFIG_TRANSACTION_FORMAT.to_owned(),
                version: CONFIG_TRANSACTION_VERSION,
                operation_id: Uuid::new_v4(),
                kind: ConfigTransactionKind::Update,
                target_id,
                previous_credential_id: Some(previous_credential_id.clone()),
                next_credential_id: Some(next_credential_id.clone()),
                target: Some(updated.clone()),
            };
            let transaction_path = config_transaction_path(&path)?;
            vault_state_for_write.ensure_access_permit(permit)?;
            write_config_transaction(&transaction_path, &transaction)?;
            store_credential(&next_credential_id, stored.as_str())?;
            config.targets[index] = updated.clone();
            write_config_unchecked(&path, &config)?;

            let cleanup = classify_target_credential_cleanup(
                config_references_credential(&config, target_id, &previous_credential_id),
                || delete_credential(&previous_credential_id),
            );
            if cleanup == TargetCredentialCleanup::Pending {
                // The new configuration is committed. Keep the journal so a
                // later read can retry deleting the old keyring entry.
                return Ok((target_summary(&updated)?, cleanup));
            }
            let _ = clear_config_transaction(&transaction_path);
            Ok((target_summary(&updated)?, cleanup))
        } else {
            config.targets[index] = updated.clone();
            vault_state_for_write.ensure_access_permit(permit)?;
            write_config(&path, &config)?;
            Ok((target_summary(&updated)?, TargetCredentialCleanup::Complete))
        }
    })
    .await
    .map_err(|error| error.to_string())?;
    let (summary, cleanup) = write_result?;
    // The updated configuration is authoritative even if the session locks
    // after the commit point. Never report it as an uncommitted failure.
    Ok(committed_target_update_outcome(summary, cleanup))
}

#[tauri::command]
pub async fn remove_offsite_backup_target(
    app: tauri::AppHandle,
    backup_state: tauri::State<'_, OffsiteBackupState>,
    vault_state: tauri::State<'_, WorkspaceVaultState>,
    target_id: Uuid,
    authorization: String,
) -> Result<RemoveOffsiteBackupTargetOutcome, String> {
    let _claim = TargetOperationClaim::acquire(&backup_state, target_id)?;
    let permit = vault_state
        .consume_sensitive_authorization(SensitiveOperation::BackupTargetChange, &authorization)?;
    let target = find_target(&app, &backup_state, target_id).await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    let cleanup = remove_target_config_and_credential(
        &app,
        &backup_state,
        &target,
        target_id,
        permit,
    )
    .await?;
    // The target is already absent from the authenticated configuration.
    Ok(committed_target_removal_outcome(cleanup))
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
    let operation_guard = WorkspaceBackupOperationGuard::new(&vault_state, Some(permit));
    let config = find_target(&app, &backup_state, target_id).await?;
    let target = open_target(&config).await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    match target
        .delete_with_verification_guarded(snapshot_id, &operation_guard)
        .await
        .map_err(target_error)?
    {
        BackupDeleteOutcome::Deleted { .. } => {}
        BackupDeleteOutcome::NotFound => {
            return Err("offsite_backup_snapshot_not_found".to_owned());
        }
        BackupDeleteOutcome::Unverified { .. } => {
            return Err("offsite_backup_snapshot_delete_unverified".to_owned());
        }
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
    let operation_guard = WorkspaceBackupOperationGuard::new(&vault_state, Some(permit));
    let config = find_target(&app, &backup_state, target_id).await?;
    if confirmation_name != config.name {
        return Err("offsite_backup_target_confirmation_mismatch".to_owned());
    }
    let target = open_target(&config).await?;
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    let purge = target
        .purge_with_verification_guarded(&operation_guard)
        .await
        .map_err(target_error)?;
    let deleted_version_count = match purge {
        BackupPurgeOutcome::Deleted { removed_versions } => {
            usize::try_from(removed_versions).unwrap_or(usize::MAX)
        }
        BackupPurgeOutcome::Unverified { removed_versions } => {
            return Ok(DeleteAllOffsiteBackupsOutcome {
                deleted_version_count: usize::try_from(removed_versions).unwrap_or(usize::MAX),
                target_removed: false,
                error: Some("offsite_backup_purge_unverified".to_owned()),
            });
        }
    };
    ensure_workspace_access(&app, &vault_state, Some(permit))?;
    let cleanup = remove_target_config_and_credential(
        &app,
        &backup_state,
        &config,
        target_id,
        permit,
    )
    .await?;
    Ok(DeleteAllOffsiteBackupsOutcome {
        deleted_version_count,
        target_removed: true,
        error: credential_cleanup_warning(cleanup),
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
    let encrypted = String::from_utf8(snapshot.payload)
        .map_err(|_| "offsite_backup_invalid_snapshot".to_owned())?;
    test_current_offsite_workspace_restore(&app, &vault_state, encrypted, password, permit).await?;
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
    permit: WorkspaceAccessPermit,
) -> Result<TargetCredentialCleanup, String> {
    let app_for_write = app.clone();
    let config_lock = Arc::clone(&state.config_lock);
    let expected_credential_id = target.credential_id.clone();
    let write_result = tauri::async_runtime::spawn_blocking(move || {
        let vault_state_for_write = app_for_write.state::<WorkspaceVaultState>();
        let _guard = acquire_authorized_config_mutation(
            &config_lock,
            &vault_state_for_write,
            permit,
        )?;
        let path = config_path(&app_for_write)?;
        let mut config = read_config_for_mutation(&path)?;
        let current = config
            .targets
            .iter()
            .find(|item| item.id == target_id)
            .cloned()
            .ok_or_else(|| "offsite_backup_target_not_found".to_owned())?;
        if current.credential_id != expected_credential_id {
            return Err("offsite_backup_target_changed".to_owned());
        }
        let transaction = OffsiteBackupConfigTransaction {
            format: CONFIG_TRANSACTION_FORMAT.to_owned(),
            version: CONFIG_TRANSACTION_VERSION,
            operation_id: Uuid::new_v4(),
            kind: ConfigTransactionKind::Remove,
            target_id,
            previous_credential_id: Some(current.credential_id.clone()),
            next_credential_id: None,
            target: None,
        };
        let transaction_path = config_transaction_path(&path)?;
        vault_state_for_write.ensure_access_permit(permit)?;
        write_config_transaction(&transaction_path, &transaction)?;
        config.targets.retain(|item| item.id != target_id);
        write_config_unchecked(&path, &config)?;
        let cleanup = classify_target_credential_cleanup(
            config_references_credential(&config, target_id, &current.credential_id),
            || delete_credential(&current.credential_id),
        );
        if cleanup == TargetCredentialCleanup::Pending {
            // Removal of the target is already committed. Keep the journal
            // and let a later read retry keyring cleanup.
            return Ok(cleanup);
        }
        let _ = clear_config_transaction(&transaction_path);
        Ok(cleanup)
    })
    .await
    .map_err(|error| error.to_string())?;
    write_result
}

async fn list_all_snapshots(
    target: &dyn BackupTarget,
    mut ensure_access: impl FnMut() -> Result<(), String>,
) -> Result<Vec<BackupSnapshotMetadata>, String> {
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut snapshots = Vec::new();
    loop {
        ensure_access()?;
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

fn reset_remote_target_status(target: &mut BackupTargetConfig) {
    target.last_upload_at_ms = None;
    target.last_verified_at_ms = None;
    target.last_restore_test_at_ms = None;
    target.last_restore_test_snapshot_id = None;
    target.automatic_revision = target.automatic_revision.max(1);
    target.automatic_uploaded_revision = 0;
    target.last_automatic_attempt_at_ms = None;
    target.last_automatic_error = None;
    target.retention_enabled = false;
    target.last_retention_cleanup_at_ms = None;
    target.last_retention_error = None;
}

fn remote_target_location_changed(
    target: &BackupTargetConfig,
    endpoint: &str,
    region: &str,
    bucket: &str,
    prefix: &str,
) -> bool {
    target.endpoint != endpoint
        || target.region.as_deref() != Some(region)
        || target.bucket.as_deref() != Some(bucket)
        || target.prefix.as_deref() != Some(prefix)
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
        let operation_guard = WorkspaceBackupOperationGuard::new(vault_state, permit);
        let config = find_target(app, state, target_id).await?;
        if !config.retention_enabled {
            return Ok(());
        }
        ensure_retention_enable_allowed(&config, true)?;
        ensure_workspace_access(app, vault_state, permit)?;
        let target = open_target(&config).await?;
        let snapshots = list_all_snapshots(target.as_ref(), || {
            ensure_workspace_access(app, vault_state, permit)
        })
        .await?;
        let now = current_time_milliseconds()?;
        let candidates = retention_candidates(&config, snapshots, now);
        for snapshot in candidates {
            ensure_workspace_access(app, vault_state, permit)?;
            match target
                .delete_with_verification_guarded(snapshot.id, &operation_guard)
                .await
                .map_err(target_error)?
            {
                BackupDeleteOutcome::Deleted { .. } => {}
                BackupDeleteOutcome::NotFound => {
                    return Err("offsite_backup_snapshot_not_found".to_owned());
                }
                BackupDeleteOutcome::Unverified { .. } => {
                    return Err("offsite_backup_snapshot_delete_unverified".to_owned());
                }
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
        let mut config = read_config_for_mutation(&path)?;
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
    Ok(BackupTargetSummary {
        id: config.id,
        name: config.name.clone(),
        endpoint: config.endpoint.clone(),
        s3_provider: config.s3_provider,
        region: config.region.clone(),
        bucket: config.bucket.clone(),
        prefix: config.prefix.clone(),
        created_at_ms: config.created_at_ms,
        last_upload_at_ms: config.last_upload_at_ms,
        last_verified_at_ms: config.last_verified_at_ms,
        last_restore_test_at_ms: config.last_restore_test_at_ms,
        maximum_upload_bytes: Some(100 * 1024 * 1024),
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

fn config_transaction_path(path: &Path) -> Result<PathBuf, String> {
    path.parent()
        .map(|parent| parent.join(CONFIG_TRANSACTION_FILE_NAME))
        .ok_or_else(|| "offsite_backup_invalid_config_path".to_owned())
}

fn validate_transaction_credential_id(value: &str) -> Result<(), String> {
    if Uuid::parse_str(value).is_err() || value == CONFIG_AUTH_CREDENTIAL_ID {
        Err("offsite_backup_invalid_config_transaction".to_owned())
    } else {
        Ok(())
    }
}

fn validate_config_transaction(transaction: &OffsiteBackupConfigTransaction) -> Result<(), String> {
    if transaction.format != CONFIG_TRANSACTION_FORMAT
        || transaction.version != CONFIG_TRANSACTION_VERSION
    {
        return Err("offsite_backup_invalid_config_transaction".to_owned());
    }
    match transaction.kind {
        ConfigTransactionKind::Create => {
            let target = transaction
                .target
                .as_ref()
                .ok_or_else(|| "offsite_backup_invalid_config_transaction".to_owned())?;
            if transaction.previous_credential_id.is_some()
                || transaction.next_credential_id.as_deref() != Some(&target.credential_id)
            {
                return Err("offsite_backup_invalid_config_transaction".to_owned());
            }
            validate_transaction_credential_id(&target.credential_id)?;
        }
        ConfigTransactionKind::Update => {
            let target = transaction
                .target
                .as_ref()
                .ok_or_else(|| "offsite_backup_invalid_config_transaction".to_owned())?;
            let previous = transaction
                .previous_credential_id
                .as_deref()
                .ok_or_else(|| "offsite_backup_invalid_config_transaction".to_owned())?;
            let next = transaction
                .next_credential_id
                .as_deref()
                .ok_or_else(|| "offsite_backup_invalid_config_transaction".to_owned())?;
            if next != target.credential_id || previous == next {
                return Err("offsite_backup_invalid_config_transaction".to_owned());
            }
            validate_transaction_credential_id(previous)?;
            validate_transaction_credential_id(next)?;
        }
        ConfigTransactionKind::Remove => {
            if transaction.target.is_some() || transaction.next_credential_id.is_some() {
                return Err("offsite_backup_invalid_config_transaction".to_owned());
            }
            validate_transaction_credential_id(
                transaction
                    .previous_credential_id
                    .as_deref()
                    .ok_or_else(|| "offsite_backup_invalid_config_transaction".to_owned())?,
            )?;
        }
    }
    if let Some(target) = transaction.target.as_ref() {
        if target.id != transaction.target_id {
            return Err("offsite_backup_invalid_config_transaction".to_owned());
        }
        validate_config(&OffsiteBackupConfig {
            format: CONFIG_FORMAT.to_owned(),
            version: CONFIG_VERSION,
            targets: vec![target.clone()],
        })?;
    }
    Ok(())
}

fn write_config_transaction(
    path: &Path,
    transaction: &OffsiteBackupConfigTransaction,
) -> Result<(), String> {
    validate_config_transaction(transaction)?;
    let key = load_or_create_config_auth_key()?;
    let authentication = config_transaction_authentication(transaction, &key)?;
    let envelope = AuthenticatedOffsiteBackupConfigTransaction {
        format: CONFIG_TRANSACTION_FORMAT.to_owned(),
        version: CONFIG_TRANSACTION_VERSION,
        transaction: transaction.clone(),
        authentication,
    };
    let contents = serde_json::to_vec_pretty(&envelope).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "offsite_backup_invalid_config_path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    write_atomically(path, &contents).map_err(|error| error.to_string())
}

fn read_config_transaction(path: &Path) -> Result<Option<OffsiteBackupConfigTransaction>, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let envelope: AuthenticatedOffsiteBackupConfigTransaction = serde_json::from_str(&contents)
        .map_err(|_| "offsite_backup_invalid_config_transaction".to_owned())?;
    if envelope.format != CONFIG_TRANSACTION_FORMAT
        || envelope.version != CONFIG_TRANSACTION_VERSION
    {
        return Err("offsite_backup_invalid_config_transaction".to_owned());
    }
    validate_config_transaction(&envelope.transaction)?;
    let key = load_config_auth_key()?;
    let supplied = STANDARD_NO_PAD
        .decode(envelope.authentication)
        .map_err(|_| "offsite_backup_config_authentication_failed".to_owned())?;
    let expected = config_transaction_authentication(&envelope.transaction, &key)?;
    let expected = STANDARD_NO_PAD
        .decode(expected)
        .map_err(|_| "offsite_backup_config_authentication_failed".to_owned())?;
    if supplied != expected {
        return Err("offsite_backup_config_authentication_failed".to_owned());
    }
    Ok(Some(envelope.transaction))
}

fn clear_config_transaction(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn config_references_credential(
    config: &OffsiteBackupConfig,
    excluded_target_id: Uuid,
    credential_id: &str,
) -> bool {
    config
        .targets
        .iter()
        .any(|target| target.id != excluded_target_id && target.credential_id == credential_id)
}

fn credential_cleanup_is_complete(
    config: &OffsiteBackupConfig,
    excluded_target_id: Uuid,
    credential_id: &str,
) -> bool {
    // A credential still used by another target is not stale.  Treating it as
    // already cleaned lets recovery discard the journal without deleting a
    // credential that remains in active use.
    classify_target_credential_cleanup(
        config_references_credential(config, excluded_target_id, credential_id),
        || delete_credential(credential_id),
    ) == TargetCredentialCleanup::Complete
}

fn recover_config_transaction(
    path: &Path,
    config: OffsiteBackupConfig,
) -> Result<OffsiteBackupConfig, String> {
    let transaction_path = config_transaction_path(path)?;
    let Some(transaction) = read_config_transaction(&transaction_path)? else {
        return Ok(config);
    };
    let current_target = config
        .targets
        .iter()
        .find(|target| target.id == transaction.target_id);
    let mut clear_transaction = false;
    match transaction.kind {
        ConfigTransactionKind::Create => {
            let next = transaction
                .next_credential_id
                .as_deref()
                .expect("validated create transaction credential");
            let committed = current_target.is_some_and(|target| target.credential_id == next);
            if committed {
                // A definitely missing credential cannot be recovered from
                // this journal. Keep the target repairable through credential
                // replacement, but retain the journal for transient keyring
                // read failures.
                if committed_create_transaction_can_clear(load_credential(next)) {
                    clear_transaction = true;
                }
            } else if credential_cleanup_is_complete(&config, transaction.target_id, next) {
                clear_transaction = true;
            }
        }
        ConfigTransactionKind::Update => {
            let previous = transaction
                .previous_credential_id
                .as_deref()
                .expect("validated update transaction credential");
            let next = transaction
                .next_credential_id
                .as_deref()
                .expect("validated update transaction credential");
            let committed = current_target.is_some_and(|target| target.credential_id == next);
            if committed {
                if credential_cleanup_is_complete(&config, transaction.target_id, previous) {
                    clear_transaction = true;
                }
            } else if credential_cleanup_is_complete(&config, transaction.target_id, next) {
                clear_transaction = true;
            }
        }
        ConfigTransactionKind::Remove => {
            let previous = transaction
                .previous_credential_id
                .as_deref()
                .expect("validated remove transaction credential");
            if current_target.is_none() {
                if credential_cleanup_is_complete(&config, transaction.target_id, previous) {
                    clear_transaction = true;
                }
            } else {
                // The config commit did not happen; retain the target and
                // discard only the stale intent.
                clear_transaction = true;
            }
        }
    }
    if clear_transaction {
        let _ = clear_config_transaction(&transaction_path);
    }
    Ok(config)
}

fn read_config(path: &Path) -> Result<OffsiteBackupConfig, String> {
    let config = read_config_without_transaction(path)?;
    recover_config_transaction(path, config)
}

fn read_config_for_mutation(path: &Path) -> Result<OffsiteBackupConfig, String> {
    let config = read_config(path)?;
    ensure_no_pending_config_transaction(path)?;
    Ok(config)
}

fn ensure_no_pending_config_transaction(path: &Path) -> Result<(), String> {
    let transaction_path = config_transaction_path(path)?;
    match fs::metadata(transaction_path) {
        Ok(_) => Err("offsite_backup_config_transaction_pending".to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn read_config_without_transaction(path: &Path) -> Result<OffsiteBackupConfig, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(OffsiteBackupConfig::default());
        }
        Err(error) => return Err(error.to_string()),
    };
    let value: serde_json::Value =
        serde_json::from_str(&contents).map_err(|_| "offsite_backup_invalid_config".to_owned())?;
    let format = value
        .get("format")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "offsite_backup_invalid_config".to_owned())?;
    if format == CONFIG_FORMAT {
        if load_optional_config_auth_key()?.is_some() {
            return Err("offsite_backup_config_authentication_failed".to_owned());
        }
        let config: OffsiteBackupConfig = serde_json::from_value(value)
            .map_err(|_| "offsite_backup_invalid_config".to_owned())?;
        validate_config(&config)?;
        // A legacy config may be read while a crash-recovery journal is still
        // present. Do not let the journal guard reject this one-time format
        // upgrade; recovery runs immediately after parsing and still owns the
        // transaction boundary.
        write_config_unchecked(path, &config)?;
        return Ok(config);
    }
    if format != AUTHENTICATED_CONFIG_FORMAT {
        return Err("offsite_backup_invalid_config".to_owned());
    }
    let key = load_config_auth_key()?;
    parse_authenticated_config(&contents, &key)
}

fn write_config(path: &Path, config: &OffsiteBackupConfig) -> Result<(), String> {
    ensure_no_pending_config_transaction(path)?;
    write_config_unchecked(path, config)
}

fn write_config_unchecked(path: &Path, config: &OffsiteBackupConfig) -> Result<(), String> {
    validate_config(config)?;
    let key = load_or_create_config_auth_key()?;
    let envelope = authenticated_config(config.clone(), &key)?;
    let contents = serde_json::to_vec_pretty(&envelope).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "offsite_backup_invalid_config_path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    write_atomically(path, &contents).map_err(|error| error.to_string())
}

fn config_authentication(config: &OffsiteBackupConfig, key: &[u8]) -> Result<String, String> {
    let serialized = serde_json::to_vec(config).map_err(|error| error.to_string())?;
    let mut mac = hmac::Hmac::<Sha256>::new_from_slice(key)
        .map_err(|_| "offsite_backup_config_authentication_failed".to_owned())?;
    mac.update(&serialized);
    Ok(STANDARD_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn config_transaction_authentication(
    transaction: &OffsiteBackupConfigTransaction,
    key: &[u8],
) -> Result<String, String> {
    let serialized = serde_json::to_vec(transaction)
        .map_err(|_| "offsite_backup_config_authentication_failed".to_owned())?;
    let mut mac = hmac::Hmac::<Sha256>::new_from_slice(key)
        .map_err(|_| "offsite_backup_config_authentication_failed".to_owned())?;
    mac.update(&serialized);
    Ok(STANDARD_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn authenticated_config(
    config: OffsiteBackupConfig,
    key: &[u8],
) -> Result<AuthenticatedOffsiteBackupConfig, String> {
    Ok(AuthenticatedOffsiteBackupConfig {
        format: AUTHENTICATED_CONFIG_FORMAT.to_owned(),
        version: AUTHENTICATED_CONFIG_VERSION,
        authentication: config_authentication(&config, key)?,
        config,
    })
}

fn parse_authenticated_config(contents: &str, key: &[u8]) -> Result<OffsiteBackupConfig, String> {
    let envelope: AuthenticatedOffsiteBackupConfig =
        serde_json::from_str(contents).map_err(|_| "offsite_backup_invalid_config".to_owned())?;
    if envelope.format != AUTHENTICATED_CONFIG_FORMAT
        || envelope.version != AUTHENTICATED_CONFIG_VERSION
    {
        return Err("offsite_backup_invalid_config".to_owned());
    }
    validate_config(&envelope.config)?;
    let supplied = STANDARD_NO_PAD
        .decode(envelope.authentication)
        .map_err(|_| "offsite_backup_config_authentication_failed".to_owned())?;
    let serialized = serde_json::to_vec(&envelope.config).map_err(|error| error.to_string())?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key)
        .map_err(|_| "offsite_backup_config_authentication_failed".to_owned())?;
    mac.update(&serialized);
    mac.verify_slice(&supplied)
        .map_err(|_| "offsite_backup_config_authentication_failed".to_owned())?;
    Ok(envelope.config)
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
        let Some(region) = target.region.as_deref() else {
            return Err("offsite_backup_invalid_config".to_owned());
        };
        let Some(bucket) = target.bucket.as_deref() else {
            return Err("offsite_backup_invalid_config".to_owned());
        };
        let Some(prefix) = target.prefix.as_deref() else {
            return Err("offsite_backup_invalid_config".to_owned());
        };
        let provider_config_valid = target.s3_provider.is_some()
            && S3BackupTarget::normalize_endpoint(&target.endpoint)
                .is_ok_and(|endpoint| endpoint == target.endpoint)
            && S3BackupTarget::normalize_region(region)
                .is_ok_and(|normalized| normalized == region)
            && S3BackupTarget::normalize_bucket(bucket)
                .is_ok_and(|normalized| normalized == bucket)
            && S3BackupTarget::normalize_prefix(prefix)
                .is_ok_and(|normalized| normalized == prefix);
        if !ids.insert(target.id)
            || !provider_config_valid
            || Uuid::parse_str(&target.credential_id).is_err()
            || target.credential_id == CONFIG_AUTH_CREDENTIAL_ID
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
    left.endpoint == right.endpoint
        && left.region == right.region
        && left.bucket == right.bucket
        && left.prefix == right.prefix
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

fn ensure_retention_enable_allowed(
    target: &BackupTargetConfig,
    enabled: bool,
) -> Result<(), String> {
    if enabled
        && target.last_restore_test_at_ms.is_some()
        && target.last_restore_test_snapshot_id.is_none()
    {
        Err("offsite_backup_retention_requires_new_restore_drill".to_owned())
    } else {
        Ok(())
    }
}

fn credential_entry(credential_id: &str) -> Result<keyring::Entry, String> {
    Uuid::parse_str(credential_id).map_err(|_| "offsite_backup_invalid_credential".to_owned())?;
    keyring::Entry::new(KEYRING_SERVICE, credential_id)
        .map_err(|_| "offsite_backup_credential_unavailable".to_owned())
}

fn decode_config_auth_key(encoded: String) -> Result<Zeroizing<Vec<u8>>, String> {
    let encoded = Zeroizing::new(encoded);
    let decoded = STANDARD_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|_| "offsite_backup_config_authentication_failed".to_owned())?;
    if decoded.len() != CONFIG_AUTH_KEY_BYTES {
        return Err("offsite_backup_config_authentication_failed".to_owned());
    }
    Ok(Zeroizing::new(decoded))
}

fn load_optional_config_auth_key() -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    match credential_entry(CONFIG_AUTH_CREDENTIAL_ID)?.get_password() {
        Ok(encoded) => decode_config_auth_key(encoded).map(Some),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("offsite_backup_config_authentication_failed".to_owned()),
    }
}

fn load_config_auth_key() -> Result<Zeroizing<Vec<u8>>, String> {
    load_optional_config_auth_key()?
        .ok_or_else(|| "offsite_backup_config_authentication_failed".to_owned())
}

fn load_or_create_config_auth_key() -> Result<Zeroizing<Vec<u8>>, String> {
    let entry = credential_entry(CONFIG_AUTH_CREDENTIAL_ID)?;
    match load_optional_config_auth_key()? {
        Some(key) => Ok(key),
        None => {
            let mut key = [0_u8; CONFIG_AUTH_KEY_BYTES];
            getrandom::fill(&mut key)
                .map_err(|_| "offsite_backup_config_authentication_failed".to_owned())?;
            let key = Zeroizing::new(key.to_vec());
            let encoded = Zeroizing::new(STANDARD_NO_PAD.encode(key.as_slice()));
            entry
                .set_password(&encoded)
                .map_err(|_| "offsite_backup_config_authentication_failed".to_owned())?;
            Ok(key)
        }
    }
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
        BackupTargetError::Cancelled => "workspace_vault_session_expired",
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
        let target = s3_target("linked-info/v1");
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
        let target = s3_target("linked-info/v1");
        let serialized = serde_json::to_string(&OffsiteBackupConfig {
            targets: vec![target],
            ..OffsiteBackupConfig::default()
        })
        .unwrap();

        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn config_transaction_requires_consistent_target_and_credential_ids() {
        let target = s3_target("linked-info/v1");
        let transaction = OffsiteBackupConfigTransaction {
            format: CONFIG_TRANSACTION_FORMAT.to_owned(),
            version: CONFIG_TRANSACTION_VERSION,
            operation_id: Uuid::new_v4(),
            kind: ConfigTransactionKind::Create,
            target_id: target.id,
            previous_credential_id: None,
            next_credential_id: Some(target.credential_id.clone()),
            target: Some(target.clone()),
        };
        assert_eq!(validate_config_transaction(&transaction), Ok(()));

        let mut inconsistent = transaction.clone();
        inconsistent.next_credential_id = Some(Uuid::new_v4().to_string());
        assert_eq!(
            validate_config_transaction(&inconsistent),
            Err("offsite_backup_invalid_config_transaction".to_owned())
        );

        let mut tampered = transaction;
        tampered.operation_id = Uuid::new_v4();
        assert_ne!(
            config_transaction_authentication(&tampered, &[9; CONFIG_AUTH_KEY_BYTES]).unwrap(),
            config_transaction_authentication(&inconsistent, &[9; CONFIG_AUTH_KEY_BYTES]).unwrap()
        );
    }

    #[test]
    fn shared_credential_is_already_cleaned_during_transaction_recovery() {
        let target = s3_target("linked-info/primary");
        let mut shared_target = target.clone();
        shared_target.id = Uuid::new_v4();
        shared_target.prefix = Some("linked-info/secondary".to_owned());
        let config = OffsiteBackupConfig {
            targets: vec![target.clone(), shared_target],
            ..OffsiteBackupConfig::default()
        };

        // The short-circuit must avoid touching the keyring: this credential
        // is still owned by the other target.
        assert!(credential_cleanup_is_complete(
            &config,
            target.id,
            &target.credential_id,
        ));
    }

    #[test]
    fn committed_target_outcomes_keep_cleanup_failure_as_a_warning() {
        let complete = committed_target_removal_outcome(TargetCredentialCleanup::Complete);
        let pending = committed_target_removal_outcome(TargetCredentialCleanup::Pending);

        assert!(complete.target_removed);
        assert_eq!(complete.error, None);
        assert!(pending.target_removed);
        assert_eq!(
            pending.error.as_deref(),
            Some("offsite_backup_credential_cleanup_pending")
        );

        let target = target_summary(&s3_target("linked-info/v1")).unwrap();
        let update =
            committed_target_update_outcome(target.clone(), TargetCredentialCleanup::Pending);
        assert_eq!(update.target.id, target.id);
        assert_eq!(
            update.error.as_deref(),
            Some("offsite_backup_credential_cleanup_pending")
        );
    }

    #[test]
    fn credential_cleanup_classifies_post_commit_keyring_failures() {
        assert_eq!(
            classify_target_credential_cleanup(false, || Ok(())),
            TargetCredentialCleanup::Complete
        );
        assert_eq!(
            classify_target_credential_cleanup(false, || Err("keyring unavailable".to_owned())),
            TargetCredentialCleanup::Pending
        );

        let delete_called = std::cell::Cell::new(false);
        assert_eq!(
            classify_target_credential_cleanup(true, || {
                delete_called.set(true);
                Err("shared credential must not be deleted".to_owned())
            }),
            TargetCredentialCleanup::Complete
        );
        assert!(!delete_called.get());
    }

    #[test]
    fn committed_create_recovery_only_retries_transient_credential_failures() {
        assert!(committed_create_transaction_can_clear(Ok(Zeroizing::new(
            "stored credential".to_owned()
        ))));
        assert!(committed_create_transaction_can_clear(Err(
            "offsite_backup_credential_missing".to_owned()
        )));
        assert!(!committed_create_transaction_can_clear(Err(
            "offsite_backup_credential_read_failed".to_owned()
        )));
        assert!(!committed_create_transaction_can_clear(Err(
            "offsite_backup_credential_unavailable".to_owned()
        )));
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
    fn authenticated_config_rejects_tampered_endpoints() {
        let key = [7_u8; CONFIG_AUTH_KEY_BYTES];
        let config = OffsiteBackupConfig {
            targets: vec![s3_target("linked-info/v1")],
            ..OffsiteBackupConfig::default()
        };
        let envelope = authenticated_config(config.clone(), &key).unwrap();
        let serialized = serde_json::to_string(&envelope).unwrap();

        assert_eq!(
            parse_authenticated_config(&serialized, &key)
                .unwrap()
                .targets[0]
                .endpoint,
            config.targets[0].endpoint
        );

        let mut tampered: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        tampered["config"]["targets"][0]["endpoint"] =
            serde_json::Value::String("https://attacker.example.test/".to_owned());
        assert_eq!(
            parse_authenticated_config(&tampered.to_string(), &key).unwrap_err(),
            "offsite_backup_config_authentication_failed"
        );
    }

    #[test]
    fn restore_drill_without_snapshot_id_requires_revalidation_before_retention_is_enabled() {
        let mut target = s3_target("linked-info/v1");
        target.last_restore_test_at_ms = Some(42);

        assert_eq!(ensure_retention_enable_allowed(&target, false), Ok(()));
        assert_eq!(
            ensure_retention_enable_allowed(&target, true),
            Err("offsite_backup_retention_requires_new_restore_drill".to_owned())
        );
        target.last_restore_test_snapshot_id = Some(Uuid::new_v4());
        assert_eq!(ensure_retention_enable_allowed(&target, true), Ok(()));
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
    fn cloudflare_r2_is_an_s3_template_not_a_provider_kind() {
        let mut target = s3_target("linked-info/v1");
        target.name = "Cloudflare R2".to_owned();
        target.endpoint = "https://account.r2.cloudflarestorage.com/".to_owned();
        target.s3_provider = Some(S3ProviderTemplate::CloudflareR2);
        target.region = Some("auto".to_owned());

        let summary = target_summary(&target).unwrap();
        assert_eq!(summary.s3_provider, Some(S3ProviderTemplate::CloudflareR2));
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
    fn credential_rotation_does_not_invalidate_remote_status() {
        let target = s3_target("linked-info/v1");

        assert!(!remote_target_location_changed(
            &target,
            "https://s3.us-west-004.backblazeb2.com/",
            "us-west-004",
            "linked-info-backup",
            "linked-info/v1",
        ));
    }

    #[test]
    fn changing_remote_location_requires_a_new_backup_and_restore_drill() {
        let mut target = s3_target("linked-info/v1");
        target.last_upload_at_ms = Some(10);
        target.last_verified_at_ms = Some(11);
        target.last_restore_test_at_ms = Some(12);
        target.last_restore_test_snapshot_id = Some(Uuid::new_v4());
        target.automatic_enabled = true;
        target.automatic_revision = 4;
        target.automatic_uploaded_revision = 4;
        target.last_automatic_attempt_at_ms = Some(13);
        target.last_automatic_error = Some("failure".to_owned());
        target.retention_enabled = true;
        target.last_retention_cleanup_at_ms = Some(14);
        target.last_retention_error = Some("failure".to_owned());

        assert!(remote_target_location_changed(
            &target,
            "https://s3.us-west-004.backblazeb2.com/",
            "us-west-004",
            "linked-info-backup",
            "linked-info/v2",
        ));
        reset_remote_target_status(&mut target);

        assert_eq!(target.last_upload_at_ms, None);
        assert_eq!(target.last_verified_at_ms, None);
        assert_eq!(target.last_restore_test_at_ms, None);
        assert_eq!(target.last_restore_test_snapshot_id, None);
        assert_eq!(target.automatic_revision, 4);
        assert_eq!(target.automatic_uploaded_revision, 0);
        assert_eq!(target.last_automatic_attempt_at_ms, None);
        assert_eq!(target.last_automatic_error, None);
        assert!(!target.retention_enabled);
        assert_eq!(target.last_retention_cleanup_at_ms, None);
        assert_eq!(target.last_retention_error, None);
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

    #[test]
    fn authorized_config_mutation_rechecks_after_waiting_for_the_config_lock() {
        let config_lock = Arc::new(Mutex::new(()));
        let held_config_lock = config_lock.lock().unwrap();
        let state = Arc::new(WorkspaceVaultState::default());
        let permit = state.issue_test_access_permit();
        let writes = Arc::new([
            std::sync::atomic::AtomicUsize::new(0),
            std::sync::atomic::AtomicUsize::new(0),
            std::sync::atomic::AtomicUsize::new(0),
        ]);
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let worker_lock = Arc::clone(&config_lock);
        let worker_state = Arc::clone(&state);
        let worker_writes = Arc::clone(&writes);
        let worker = std::thread::spawn(move || {
            ready_sender.send(()).unwrap();
            let _guard =
                acquire_authorized_config_mutation(&worker_lock, &worker_state, permit)?;
            for counter in worker_writes.iter() {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            Ok::<_, String>(())
        });

        ready_receiver.recv().unwrap();
        assert!(state.shutdown());
        drop(held_config_lock);
        assert_eq!(
            worker.join().unwrap(),
            Err("workspace_vault_session_expired".to_owned())
        );
        assert_eq!(
            writes
                .iter()
                .map(|counter| counter.load(std::sync::atomic::Ordering::SeqCst))
                .collect::<Vec<_>>(),
            vec![0, 0, 0]
        );

        let current_permit = state.issue_test_access_permit();
        let _guard =
            acquire_authorized_config_mutation(&config_lock, &state, current_permit).unwrap();
        for counter in writes.iter() {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        assert_eq!(
            writes
                .iter()
                .map(|counter| counter.load(std::sync::atomic::Ordering::SeqCst))
                .collect::<Vec<_>>(),
            vec![1, 1, 1]
        );
    }

    #[test]
    fn remote_delete_guard_requires_a_current_unlocked_workspace_permit() {
        let state = WorkspaceVaultState::default();
        let locked_generation = state
            .access_generation()
            .load(std::sync::atomic::Ordering::Acquire);
        let locked_guard = WorkspaceBackupOperationGuard::new(
            &state,
            Some(WorkspaceAccessPermit::for_test(locked_generation)),
        );
        let missing_permit_guard = WorkspaceBackupOperationGuard::new(&state, None);

        assert_eq!(locked_guard.check(), Err(BackupTargetError::Cancelled));
        assert_eq!(
            missing_permit_guard.check(),
            Err(BackupTargetError::Cancelled)
        );

        let permit = state.issue_test_access_permit();
        let guard = WorkspaceBackupOperationGuard::new(&state, Some(permit));
        assert_eq!(guard.check(), Ok(()));
        assert!(state.shutdown());
        assert_eq!(guard.check(), Err(BackupTargetError::Cancelled));
        assert_eq!(
            target_error(BackupTargetError::Cancelled),
            "workspace_vault_session_expired"
        );
    }
}
