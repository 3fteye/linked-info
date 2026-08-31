use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use linked_info_extension_contracts::{
    ActionContribution, ExtensionCapability, ExtensionMetadataMigrationRequestV1,
    MAXIMUM_EXTENSION_PACKAGE_BYTES, ProcessorContribution, SignaturePolicy,
    ValidatedExtensionPackage, extension_metadata_matches_schema, validate_extension_package,
};
use linked_info_extension_host_protocol::{
    ExtensionHostErrorCode, ExtensionHostRequestV1, ExtensionHostResponseV1,
};
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const REGISTRY_VERSION: u32 = 1;
const REGISTRY_FILE: &str = "registry-v1.json";
const PENDING_UPGRADES_FILE: &str = "pending-upgrades-v1.json";
const PACKAGE_DIRECTORY: &str = "packages";
const PENDING_PACKAGE_DIRECTORY: &str = "pending";
const MAXIMUM_PREPARED_INSTALLS: usize = 4;
const MAXIMUM_NODE_METADATA_BYTES: usize = 16 * 1024;
const MAXIMUM_WORKSPACE_METADATA_BYTES: usize = 64 * 1024;
const MAXIMUM_EXTENSION_METADATA_BYTES: usize = 4 * 1024 * 1024;
const METADATA_MIGRATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct ExtensionManagerState {
    prepared: Mutex<BTreeMap<String, PreparedExtensionInstall>>,
    lifecycle: Mutex<()>,
    authorization_generation: AtomicU64,
}

#[derive(Clone)]
struct PreparedExtensionInstall {
    bytes: Vec<u8>,
    package: ValidatedExtensionPackage,
    update: bool,
    metadata_migration_id: Option<String>,
    metadata_migration_journaled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtensionRegistry {
    version: u32,
    extensions: BTreeMap<String, InstalledExtensionRecord>,
}

impl Default for ExtensionRegistry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            extensions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstalledExtensionRecord {
    version: String,
    package_sha256: String,
    publisher_name: String,
    publisher_fingerprint: Option<String>,
    signed: bool,
    enabled: bool,
    metadata_schema_version: u32,
    granted_capabilities: Vec<ExtensionCapability>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingExtensionUpgrades {
    version: u32,
    extensions: BTreeMap<String, PendingExtensionUpgrade>,
}

impl Default for PendingExtensionUpgrades {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            extensions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingExtensionUpgrade {
    metadata_migration_id: String,
    previous: InstalledExtensionRecord,
    next: InstalledExtensionRecord,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInstallPreview {
    prepared_install_id: String,
    id: String,
    version: String,
    publisher_name: String,
    publisher_fingerprint: Option<String>,
    package_sha256: String,
    signed: bool,
    update: bool,
    metadata_migration_required: bool,
    capabilities: Vec<ExtensionCapability>,
    newly_requested_capabilities: Vec<ExtensionCapability>,
    processors: Vec<ProcessorContribution>,
    actions: Vec<ActionContribution>,
    locales: BTreeMap<String, BTreeMap<String, String>>,
    default_locale: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtensionView {
    id: String,
    version: String,
    publisher_name: String,
    publisher_fingerprint: Option<String>,
    package_sha256: String,
    signed: bool,
    enabled: bool,
    valid: bool,
    error_code: Option<String>,
    metadata_schema_version: u32,
    granted_capabilities: Vec<ExtensionCapability>,
    processors: Vec<ProcessorContribution>,
    actions: Vec<ActionContribution>,
    locales: BTreeMap<String, BTreeMap<String, String>>,
    default_locale: Option<String>,
}

#[derive(Clone)]
pub(crate) struct ManagedExtensionRuntimeRegistration {
    pub extension_id: String,
    pub package_sha256: String,
    pub package_path: PathBuf,
    pub package: ValidatedExtensionPackage,
    pub allow_unsigned_development: bool,
    pub authorization_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionMetadataMigrationInput {
    schema_version: u32,
    workspace: serde_json::Value,
    nodes: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionMetadataMigrationPreview {
    metadata_migration_id: String,
    metadata: Option<ExtensionMetadataMigrationInput>,
}

fn extension_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("extensions").join("v1"))
        .map_err(|_| "extension_manager_directory_unavailable".to_owned())
}

fn registry_path(root: &Path) -> PathBuf {
    root.join(REGISTRY_FILE)
}

fn pending_upgrades_path(root: &Path) -> PathBuf {
    root.join(PENDING_UPGRADES_FILE)
}

fn package_path(root: &Path, package_sha256: &str) -> Result<PathBuf, String> {
    if package_sha256.len() != 64
        || !package_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("extension_manager_registry_invalid".to_owned());
    }
    Ok(root
        .join(PACKAGE_DIRECTORY)
        .join(format!("{package_sha256}.liext")))
}

fn read_registry(root: &Path) -> Result<ExtensionRegistry, String> {
    let path = registry_path(root);
    if !path.exists() {
        return Ok(ExtensionRegistry::default());
    }
    let bytes = fs::read(path).map_err(|_| "extension_manager_registry_unavailable".to_owned())?;
    let registry: ExtensionRegistry = serde_json::from_slice(&bytes)
        .map_err(|_| "extension_manager_registry_invalid".to_owned())?;
    if registry.version != REGISTRY_VERSION
        || registry
            .extensions
            .iter()
            .any(|(id, record)| record.package_sha256.is_empty() || id.len() > 128)
    {
        return Err("extension_manager_registry_invalid".to_owned());
    }
    Ok(registry)
}

fn write_registry(root: &Path, registry: &ExtensionRegistry) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|_| "extension_manager_directory_unavailable".to_owned())?;
    let bytes = serde_json::to_vec(registry)
        .map_err(|_| "extension_manager_registry_invalid".to_owned())?;
    crate::workspace_file::write_atomically(&registry_path(root), &bytes)
        .map_err(|_| "extension_manager_registry_write_failed".to_owned())
}

fn read_pending_upgrades(root: &Path) -> Result<PendingExtensionUpgrades, String> {
    let path = pending_upgrades_path(root);
    if !path.exists() {
        return Ok(PendingExtensionUpgrades::default());
    }
    let bytes =
        fs::read(path).map_err(|_| "extension_upgrade_recovery_journal_unavailable".to_owned())?;
    let journal: PendingExtensionUpgrades = serde_json::from_slice(&bytes)
        .map_err(|_| "extension_upgrade_recovery_journal_invalid".to_owned())?;
    if journal.version != REGISTRY_VERSION
        || journal.extensions.len() > MAXIMUM_PREPARED_INSTALLS
        || journal.extensions.iter().any(|(id, upgrade)| {
            id.len() > 128
                || upgrade.metadata_migration_id.is_empty()
                || upgrade.previous.metadata_schema_version >= upgrade.next.metadata_schema_version
                || package_path(root, &upgrade.previous.package_sha256).is_err()
                || package_path(root, &upgrade.next.package_sha256).is_err()
        })
    {
        return Err("extension_upgrade_recovery_journal_invalid".to_owned());
    }
    Ok(journal)
}

fn write_pending_upgrades(root: &Path, journal: &PendingExtensionUpgrades) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|_| "extension_manager_directory_unavailable".to_owned())?;
    if journal.extensions.is_empty() {
        match fs::remove_file(pending_upgrades_path(root)) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("extension_upgrade_recovery_journal_write_failed".to_owned()),
        }
    }
    let bytes = serde_json::to_vec(journal)
        .map_err(|_| "extension_upgrade_recovery_journal_invalid".to_owned())?;
    crate::workspace_file::write_atomically(&pending_upgrades_path(root), &bytes)
        .map_err(|_| "extension_upgrade_recovery_journal_write_failed".to_owned())
}

fn capability_set(capabilities: &[ExtensionCapability]) -> BTreeSet<ExtensionCapability> {
    capabilities.iter().copied().collect()
}

fn package_matches_record(
    package: &ValidatedExtensionPackage,
    id: &str,
    record: &InstalledExtensionRecord,
) -> bool {
    package.manifest.id == id
        && package.manifest.version == record.version
        && package.package_sha256 == record.package_sha256
        && package.publisher_fingerprint == record.publisher_fingerprint
        && package.signed == record.signed
        && package.manifest.metadata_schema_version == record.metadata_schema_version
        && capability_set(&package.manifest.capabilities)
            == capability_set(&record.granted_capabilities)
}

fn validate_update(
    existing: &InstalledExtensionRecord,
    package: &ValidatedExtensionPackage,
) -> Result<(), String> {
    if existing.publisher_fingerprint != package.publisher_fingerprint
        || existing.signed != package.signed
    {
        return Err("extension_update_publisher_mismatch".to_owned());
    }
    let current = Version::parse(&existing.version)
        .map_err(|_| "extension_manager_registry_invalid".to_owned())?;
    let next = Version::parse(&package.manifest.version)
        .map_err(|_| "extension_package_version_invalid".to_owned())?;
    if next <= current {
        return Err("extension_update_version_not_newer".to_owned());
    }
    if package.manifest.metadata_schema_version < existing.metadata_schema_version {
        return Err("extension_update_metadata_schema_not_newer".to_owned());
    }
    Ok(())
}

fn installed_record(
    package: &ValidatedExtensionPackage,
    granted_capabilities: Vec<ExtensionCapability>,
    enabled: bool,
) -> InstalledExtensionRecord {
    InstalledExtensionRecord {
        version: package.manifest.version.clone(),
        package_sha256: package.package_sha256.clone(),
        publisher_name: package.manifest.publisher.name.clone(),
        publisher_fingerprint: package.publisher_fingerprint.clone(),
        signed: package.signed,
        enabled,
        metadata_schema_version: package.manifest.metadata_schema_version,
        granted_capabilities,
    }
}

fn validate_installed_package(
    root: &Path,
    id: &str,
    record: &InstalledExtensionRecord,
) -> Result<ValidatedExtensionPackage, String> {
    let path = package_path(root, &record.package_sha256)?;
    let bytes = fs::read(path).map_err(|_| "extension_installed_package_missing".to_owned())?;
    let policy = if record.signed {
        SignaturePolicy::RequireSigned
    } else {
        SignaturePolicy::AllowUnsignedDevelopment
    };
    let package =
        validate_extension_package(&bytes, policy).map_err(|error| error.code().to_owned())?;
    package_matches_record(&package, id, record)
        .then_some(package)
        .ok_or_else(|| "extension_installed_package_mismatch".to_owned())
}

fn record_view(root: &Path, id: &str, record: &InstalledExtensionRecord) -> InstalledExtensionView {
    match validate_installed_package(root, id, record) {
        Ok(package) => InstalledExtensionView {
            id: id.to_owned(),
            version: record.version.clone(),
            publisher_name: record.publisher_name.clone(),
            publisher_fingerprint: record.publisher_fingerprint.clone(),
            package_sha256: record.package_sha256.clone(),
            signed: record.signed,
            enabled: record.enabled,
            valid: true,
            error_code: None,
            metadata_schema_version: record.metadata_schema_version,
            granted_capabilities: record.granted_capabilities.clone(),
            processors: package.manifest.contributions.processors,
            actions: package.manifest.contributions.actions,
            locales: package.locales,
            default_locale: Some(package.manifest.default_locale),
        },
        Err(error) => InstalledExtensionView {
            id: id.to_owned(),
            version: record.version.clone(),
            publisher_name: record.publisher_name.clone(),
            publisher_fingerprint: record.publisher_fingerprint.clone(),
            package_sha256: record.package_sha256.clone(),
            signed: record.signed,
            enabled: false,
            valid: false,
            error_code: Some(error),
            metadata_schema_version: record.metadata_schema_version,
            granted_capabilities: record.granted_capabilities.clone(),
            processors: Vec::new(),
            actions: Vec::new(),
            locales: BTreeMap::new(),
            default_locale: None,
        },
    }
}

fn registry_views(root: &Path, registry: &ExtensionRegistry) -> Vec<InstalledExtensionView> {
    registry
        .extensions
        .iter()
        .map(|(id, record)| record_view(root, id, record))
        .collect()
}

pub(crate) fn managed_extension_runtime_registration(
    app: &tauri::AppHandle,
    manager: &ExtensionManagerState,
    extension_id: &str,
) -> Result<ManagedExtensionRuntimeRegistration, String> {
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
    let root = extension_root(app)?;
    if read_pending_upgrades(&root)?
        .extensions
        .contains_key(extension_id)
    {
        return Err("extension_upgrade_recovery_required".to_owned());
    }
    let registry = read_registry(&root)?;
    let record = registry
        .extensions
        .get(extension_id)
        .filter(|record| record.enabled)
        .ok_or_else(|| "extension_not_enabled".to_owned())?;
    let package = validate_installed_package(&root, extension_id, record)?;
    Ok(ManagedExtensionRuntimeRegistration {
        extension_id: extension_id.to_owned(),
        package_sha256: record.package_sha256.clone(),
        package_path: package_path(&root, &record.package_sha256)?,
        allow_unsigned_development: !record.signed,
        package,
        authorization_generation: manager.authorization_generation.load(Ordering::Acquire),
    })
}

pub(crate) fn ensure_managed_extension_runtime_registration(
    app: &tauri::AppHandle,
    manager: &ExtensionManagerState,
    registration: &ManagedExtensionRuntimeRegistration,
) -> Result<(), String> {
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
    if manager.authorization_generation.load(Ordering::Acquire)
        != registration.authorization_generation
    {
        return Err("extension_runtime_authorization_revoked".to_owned());
    }
    let root = extension_root(app)?;
    let registry = read_registry(&root)?;
    registry
        .extensions
        .get(&registration.extension_id)
        .filter(|record| record.enabled && record.package_sha256 == registration.package_sha256)
        .map(|_| ())
        .ok_or_else(|| "extension_runtime_authorization_revoked".to_owned())
}

fn recovered_record_for_schema(
    pending: &PendingExtensionUpgrade,
    observed_schema_version: Option<u32>,
) -> Result<(&InstalledExtensionRecord, &InstalledExtensionRecord), String> {
    match observed_schema_version {
        Some(version) if version == pending.next.metadata_schema_version => {
            Ok((&pending.next, &pending.previous))
        }
        Some(version) if version == pending.previous.metadata_schema_version => {
            Ok((&pending.previous, &pending.next))
        }
        None => Ok((&pending.previous, &pending.next)),
        Some(_) => Err("extension_upgrade_recovery_metadata_schema_unknown".to_owned()),
    }
}

fn validate_migration_payload(
    value: &serde_json::Value,
    package: &ValidatedExtensionPackage,
    maximum_bytes: usize,
) -> Result<(), String> {
    let encoded = serde_json::to_vec(value)
        .map_err(|_| "extension_metadata_migration_input_invalid".to_owned())?;
    if !value.is_object()
        || encoded.len() > maximum_bytes
        || !extension_metadata_matches_schema(&package.metadata_schema, value)
    {
        return Err("extension_metadata_migration_input_invalid".to_owned());
    }
    Ok(())
}

fn validate_migration_input(
    input: &ExtensionMetadataMigrationInput,
    expected_schema_version: u32,
    package: &ValidatedExtensionPackage,
) -> Result<(), String> {
    if input.schema_version != expected_schema_version
        || serde_json::to_vec(input)
            .map(|encoded| encoded.len() > MAXIMUM_EXTENSION_METADATA_BYTES)
            .unwrap_or(true)
    {
        return Err("extension_metadata_migration_input_invalid".to_owned());
    }
    validate_migration_payload(&input.workspace, package, MAXIMUM_WORKSPACE_METADATA_BYTES)?;
    for node in &input.nodes {
        validate_migration_payload(node, package, MAXIMUM_NODE_METADATA_BYTES)?;
    }
    Ok(())
}

fn migration_host_error_code(code: ExtensionHostErrorCode) -> &'static str {
    match code {
        ExtensionHostErrorCode::ProtocolInvalid => "protocol_invalid",
        ExtensionHostErrorCode::GenerationRevoked => "generation_revoked",
        ExtensionHostErrorCode::RequestInvalid => "request_invalid",
        ExtensionHostErrorCode::PackageInvalid => "package_invalid",
        ExtensionHostErrorCode::ComponentInvalid => "component_invalid",
        ExtensionHostErrorCode::ComponentTrap => "component_trap",
        ExtensionHostErrorCode::ResourceLimit => "resource_limit",
        ExtensionHostErrorCode::DeadlineExceeded => "deadline_exceeded",
        ExtensionHostErrorCode::OutputInvalid => "output_invalid",
        ExtensionHostErrorCode::GuestRejected => "guest_rejected",
        ExtensionHostErrorCode::Internal => "internal",
    }
}

struct MigrationRuntimeGuard<'a> {
    runtime: &'a crate::extension_runtime::ExtensionRuntimeState,
    runtime_key: String,
    package_path: PathBuf,
}

impl Drop for MigrationRuntimeGuard<'_> {
    fn drop(&mut self) {
        self.runtime.stop(&self.runtime_key);
        let _ = fs::remove_file(&self.package_path);
    }
}

fn migrate_metadata_payload(
    runtime: &crate::extension_runtime::ExtensionRuntimeState,
    runtime_key: &str,
    generation: u64,
    access_generation: &AtomicU64,
    from_version: u32,
    to_version: u32,
    value: &serde_json::Value,
    maximum_bytes: usize,
    started: Instant,
) -> Result<serde_json::Value, String> {
    let remaining = METADATA_MIGRATION_TIMEOUT
        .checked_sub(started.elapsed())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| "extension_metadata_migration_deadline_exceeded".to_owned())?;
    let request_id = runtime.next_request_id();
    let response = runtime.request_for_access_generation(
        runtime_key,
        ExtensionHostRequestV1::MigrateMetadata {
            request_id,
            generation,
            request: ExtensionMetadataMigrationRequestV1 {
                from_version,
                to_version,
                metadata_json: serde_json::to_string(value)
                    .map_err(|_| "extension_metadata_migration_input_invalid".to_owned())?,
            },
        },
        remaining,
        access_generation,
    )?;
    let metadata_json = match response {
        ExtensionHostResponseV1::MetadataMigrated { metadata_json, .. } => metadata_json,
        ExtensionHostResponseV1::Error { code, .. } => {
            return Err(format!(
                "extension_metadata_migration_host_{}",
                migration_host_error_code(code)
            ));
        }
        _ => return Err("extension_metadata_migration_protocol_invalid".to_owned()),
    };
    let value: serde_json::Value = serde_json::from_str(&metadata_json)
        .map_err(|_| "extension_metadata_migration_output_invalid".to_owned())?;
    if !value.is_object()
        || serde_json::to_vec(&value)
            .map(|encoded| encoded.len() > maximum_bytes)
            .unwrap_or(true)
    {
        return Err("extension_metadata_migration_output_invalid".to_owned());
    }
    Ok(value)
}

fn run_metadata_migration(
    app: &tauri::AppHandle,
    runtime: &crate::extension_runtime::ExtensionRuntimeState,
    root: &Path,
    prepared_install_id: &str,
    prepared: &PreparedExtensionInstall,
    existing: &InstalledExtensionRecord,
    old_package: &ValidatedExtensionPackage,
    generation: u64,
    access_generation: &AtomicU64,
    input: Option<ExtensionMetadataMigrationInput>,
) -> Result<Option<ExtensionMetadataMigrationInput>, String> {
    let Some(input) = input else {
        return Ok(None);
    };
    validate_migration_input(&input, existing.metadata_schema_version, old_package)?;
    let pending_directory = root.join(PENDING_PACKAGE_DIRECTORY);
    fs::create_dir_all(&pending_directory)
        .map_err(|_| "extension_manager_directory_unavailable".to_owned())?;
    let pending_path = pending_directory.join(format!("{prepared_install_id}.liext"));
    crate::workspace_file::write_atomically(&pending_path, &prepared.bytes)
        .map_err(|_| "extension_install_package_write_failed".to_owned())?;
    let runtime_key = format!(
        "{}#migration#{prepared_install_id}",
        prepared.package.manifest.id
    );
    if let Err(error) = runtime.ensure_started_for_access_generation(
        app,
        &runtime_key,
        &prepared.package.manifest.id,
        &pending_path,
        generation,
        access_generation,
        !prepared.package.signed,
    ) {
        let _ = fs::remove_file(pending_path);
        return Err(error);
    }
    let _guard = MigrationRuntimeGuard {
        runtime,
        runtime_key: runtime_key.clone(),
        package_path: pending_path,
    };
    let started = Instant::now();
    let to_version = prepared.package.manifest.metadata_schema_version;
    let workspace = migrate_metadata_payload(
        runtime,
        &runtime_key,
        generation,
        access_generation,
        existing.metadata_schema_version,
        to_version,
        &input.workspace,
        MAXIMUM_WORKSPACE_METADATA_BYTES,
        started,
    )?;
    let mut nodes = Vec::with_capacity(input.nodes.len());
    for node in &input.nodes {
        nodes.push(migrate_metadata_payload(
            runtime,
            &runtime_key,
            generation,
            access_generation,
            existing.metadata_schema_version,
            to_version,
            node,
            MAXIMUM_NODE_METADATA_BYTES,
            started,
        )?);
    }
    let migrated = ExtensionMetadataMigrationInput {
        schema_version: to_version,
        workspace,
        nodes,
    };
    if serde_json::to_vec(&migrated)
        .map(|encoded| encoded.len() > MAXIMUM_EXTENSION_METADATA_BYTES)
        .unwrap_or(true)
    {
        return Err("extension_metadata_migration_output_invalid".to_owned());
    }
    Ok(Some(migrated))
}

#[tauri::command]
pub async fn choose_extension_install(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ExtensionManagerState>,
    vault: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
    allow_unsigned_development: bool,
) -> Result<Option<ExtensionInstallPreview>, String> {
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let Some(selection) = dialog_app
            .dialog()
            .file()
            .add_filter("Linked Info extension", &["liext"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = selection
            .into_path()
            .map_err(|_| "extension_install_path_invalid".to_owned())?;
        if path.extension().and_then(|value| value.to_str()) != Some("liext") {
            return Err("extension_install_type_invalid".to_owned());
        }
        let size = fs::metadata(&path)
            .map_err(|_| "extension_install_file_unavailable".to_owned())?
            .len();
        if size > MAXIMUM_EXTENSION_PACKAGE_BYTES as u64 {
            return Err("extension_package_too_large".to_owned());
        }
        let bytes = fs::read(path).map_err(|_| "extension_install_file_unavailable".to_owned())?;
        let policy = if allow_unsigned_development {
            SignaturePolicy::AllowUnsignedDevelopment
        } else {
            SignaturePolicy::RequireSigned
        };
        let package =
            validate_extension_package(&bytes, policy).map_err(|error| error.code().to_owned())?;
        Ok(Some((bytes, package)))
    })
    .await
    .map_err(|_| "extension_install_task_failed".to_owned())??;
    let Some((bytes, package)) = selected else {
        return Ok(None);
    };
    crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
    let root = extension_root(&app)?;
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
    let registry = read_registry(&root)?;
    if read_pending_upgrades(&root)?
        .extensions
        .contains_key(&package.manifest.id)
    {
        return Err("extension_upgrade_recovery_required".to_owned());
    }
    let existing = registry.extensions.get(&package.manifest.id);
    if let Some(existing) = existing {
        validate_update(existing, &package)?;
    }
    let granted = existing
        .map(|record| capability_set(&record.granted_capabilities))
        .unwrap_or_default();
    let newly_requested_capabilities = package
        .manifest
        .capabilities
        .iter()
        .copied()
        .filter(|capability| !granted.contains(capability))
        .collect();
    let prepared_install_id = uuid::Uuid::new_v4().to_string();
    let preview = ExtensionInstallPreview {
        prepared_install_id: prepared_install_id.clone(),
        id: package.manifest.id.clone(),
        version: package.manifest.version.clone(),
        publisher_name: package.manifest.publisher.name.clone(),
        publisher_fingerprint: package.publisher_fingerprint.clone(),
        package_sha256: package.package_sha256.clone(),
        signed: package.signed,
        update: existing.is_some(),
        metadata_migration_required: existing.is_some_and(|record| {
            record.metadata_schema_version != package.manifest.metadata_schema_version
        }),
        capabilities: package.manifest.capabilities.clone(),
        newly_requested_capabilities,
        processors: package.manifest.contributions.processors.clone(),
        actions: package.manifest.contributions.actions.clone(),
        locales: package.locales.clone(),
        default_locale: package.manifest.default_locale.clone(),
    };
    let mut prepared = manager
        .prepared
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
    while prepared.len() >= MAXIMUM_PREPARED_INSTALLS {
        let Some(first) = prepared.keys().next().cloned() else {
            break;
        };
        prepared.remove(&first);
    }
    prepared.insert(
        prepared_install_id,
        PreparedExtensionInstall {
            bytes,
            package,
            update: existing.is_some(),
            metadata_migration_id: None,
            metadata_migration_journaled: false,
        },
    );
    Ok(Some(preview))
}

#[tauri::command]
pub async fn migrate_prepared_extension_metadata(
    app: tauri::AppHandle,
    prepared_install_id: String,
    metadata: Option<ExtensionMetadataMigrationInput>,
    granted_capabilities: Vec<ExtensionCapability>,
    enabled: bool,
) -> Result<ExtensionMetadataMigrationPreview, String> {
    let vault = app.state::<crate::workspace_file::WorkspaceVaultState>();
    let manager = app.state::<ExtensionManagerState>();
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let access_generation = vault.access_generation();
    let generation = permit.map_or_else(
        || access_generation.load(Ordering::Acquire),
        crate::workspace_file::WorkspaceAccessPermit::generation,
    );
    crate::workspace_file::ensure_access_generation(&access_generation, permit)?;
    let prepared = manager
        .prepared
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?
        .get(&prepared_install_id)
        .cloned()
        .ok_or_else(|| "extension_install_preparation_expired".to_owned())?;
    if capability_set(&granted_capabilities)
        != capability_set(&prepared.package.manifest.capabilities)
        || granted_capabilities.len() != prepared.package.manifest.capabilities.len()
    {
        return Err("extension_install_capabilities_not_approved".to_owned());
    }
    if !prepared.update {
        return Err("extension_metadata_migration_not_required".to_owned());
    }
    let root = extension_root(&app)?;
    let (existing, old_package) = {
        let _lifecycle = manager
            .lifecycle
            .lock()
            .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
        if read_pending_upgrades(&root)?
            .extensions
            .contains_key(&prepared.package.manifest.id)
        {
            return Err("extension_upgrade_recovery_required".to_owned());
        }
        let registry = read_registry(&root)?;
        let existing = registry
            .extensions
            .get(&prepared.package.manifest.id)
            .cloned()
            .ok_or_else(|| "extension_install_state_changed".to_owned())?;
        validate_update(&existing, &prepared.package)?;
        let old_package =
            validate_installed_package(&root, &prepared.package.manifest.id, &existing)?;
        (existing, old_package)
    };
    let target_schema_version = prepared.package.manifest.metadata_schema_version;
    if target_schema_version <= existing.metadata_schema_version {
        return Err(
            if target_schema_version == existing.metadata_schema_version {
                "extension_metadata_migration_not_required".to_owned()
            } else {
                "extension_update_metadata_schema_not_newer".to_owned()
            },
        );
    }
    let task_app = app.clone();
    let task_root = root.clone();
    let task_prepared_id = prepared_install_id.clone();
    let task_prepared = prepared.clone();
    let task_existing = existing.clone();
    let task_access_generation = Arc::clone(&access_generation);
    let migrated = tauri::async_runtime::spawn_blocking(move || {
        let runtime = task_app.state::<crate::extension_runtime::ExtensionRuntimeState>();
        run_metadata_migration(
            &task_app,
            &runtime,
            &task_root,
            &task_prepared_id,
            &task_prepared,
            &task_existing,
            &old_package,
            generation,
            &task_access_generation,
            metadata,
        )
    })
    .await
    .map_err(|_| "extension_metadata_migration_task_failed".to_owned())??;
    crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
    let metadata_migration_id = uuid::Uuid::new_v4().to_string();
    let next_record = installed_record(&prepared.package, granted_capabilities, enabled);
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
    let current_registry = read_registry(&root)?;
    let current = current_registry
        .extensions
        .get(&prepared.package.manifest.id)
        .ok_or_else(|| "extension_install_state_changed".to_owned())?;
    if current != &existing {
        return Err("extension_install_state_changed".to_owned());
    }
    let journaled = migrated.is_some();
    if journaled {
        let path = package_path(&root, &prepared.package.package_sha256)?;
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| "extension_manager_directory_unavailable".to_owned())?,
        )
        .map_err(|_| "extension_manager_directory_unavailable".to_owned())?;
        crate::workspace_file::write_atomically(&path, &prepared.bytes)
            .map_err(|_| "extension_install_package_write_failed".to_owned())?;
        let mut journal = read_pending_upgrades(&root)?;
        journal.extensions.insert(
            prepared.package.manifest.id.clone(),
            PendingExtensionUpgrade {
                metadata_migration_id: metadata_migration_id.clone(),
                previous: existing.clone(),
                next: next_record,
            },
        );
        write_pending_upgrades(&root, &journal)?;
    }
    let mut prepared_installs = manager
        .prepared
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
    let current_prepared = prepared_installs
        .get_mut(&prepared_install_id)
        .filter(|current| {
            current.package.package_sha256 == prepared.package.package_sha256
                && current.update == prepared.update
        })
        .ok_or_else(|| "extension_install_preparation_expired".to_owned())?;
    current_prepared.metadata_migration_id = Some(metadata_migration_id.clone());
    current_prepared.metadata_migration_journaled = journaled;
    Ok(ExtensionMetadataMigrationPreview {
        metadata_migration_id,
        metadata: migrated,
    })
}

#[tauri::command]
pub fn commit_extension_install(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ExtensionManagerState>,
    runtime: tauri::State<'_, crate::extension_runtime::ExtensionRuntimeState>,
    vault: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
    prepared_install_id: String,
    granted_capabilities: Vec<ExtensionCapability>,
    enabled: bool,
    metadata_migration_id: Option<String>,
) -> Result<Vec<InstalledExtensionView>, String> {
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
    let prepared = manager
        .prepared
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?
        .remove(&prepared_install_id)
        .ok_or_else(|| "extension_install_preparation_expired".to_owned())?;
    if capability_set(&granted_capabilities)
        != capability_set(&prepared.package.manifest.capabilities)
        || granted_capabilities.len() != prepared.package.manifest.capabilities.len()
    {
        return Err("extension_install_capabilities_not_approved".to_owned());
    }
    let root = extension_root(&app)?;
    let mut registry = read_registry(&root)?;
    let mut journal = read_pending_upgrades(&root)?;
    let existing = registry
        .extensions
        .get(&prepared.package.manifest.id)
        .cloned();
    if prepared.update != existing.is_some() {
        return Err("extension_install_state_changed".to_owned());
    }
    if let Some(existing) = existing.as_ref() {
        validate_update(existing, &prepared.package)?;
        if existing.metadata_schema_version != prepared.package.manifest.metadata_schema_version {
            if prepared.metadata_migration_id.as_deref() != metadata_migration_id.as_deref()
                || metadata_migration_id.is_none()
            {
                return Err("extension_upgrade_metadata_migration_required".to_owned());
            }
        } else if metadata_migration_id.is_some() {
            return Err("extension_metadata_migration_not_required".to_owned());
        }
    }
    let next_record = installed_record(&prepared.package, granted_capabilities, enabled);
    if prepared.metadata_migration_journaled {
        let pending = journal
            .extensions
            .get(&prepared.package.manifest.id)
            .ok_or_else(|| "extension_upgrade_recovery_journal_missing".to_owned())?;
        if pending.metadata_migration_id != metadata_migration_id.clone().unwrap_or_default()
            || pending.previous != existing.clone().expect("validated update record")
            || pending.next != next_record
        {
            return Err("extension_upgrade_recovery_journal_mismatch".to_owned());
        }
    } else if journal
        .extensions
        .contains_key(&prepared.package.manifest.id)
    {
        return Err("extension_upgrade_recovery_required".to_owned());
    }
    crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
    let path = package_path(&root, &prepared.package.package_sha256)?;
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| "extension_manager_directory_unavailable".to_owned())?,
    )
    .map_err(|_| "extension_manager_directory_unavailable".to_owned())?;
    crate::workspace_file::write_atomically(&path, &prepared.bytes)
        .map_err(|_| "extension_install_package_write_failed".to_owned())?;
    let old_hash = existing
        .as_ref()
        .map(|record| record.package_sha256.clone());
    registry
        .extensions
        .insert(prepared.package.manifest.id.clone(), next_record);
    write_registry(&root, &registry)?;
    manager
        .authorization_generation
        .fetch_add(1, Ordering::AcqRel);
    if existing.is_some() {
        runtime.stop(&prepared.package.manifest.id);
    }
    let journal_cleaned = if prepared.metadata_migration_journaled {
        journal.extensions.remove(&prepared.package.manifest.id);
        write_pending_upgrades(&root, &journal).is_ok()
    } else {
        true
    };
    if let Some(old_hash) = old_hash.filter(|hash| hash != &prepared.package.package_sha256)
        && journal_cleaned
        && !registry
            .extensions
            .values()
            .any(|record| record.package_sha256 == old_hash)
        && let Ok(old_path) = package_path(&root, &old_hash)
    {
        let _ = fs::remove_file(old_path);
    }
    Ok(registry_views(&root, &registry))
}

#[tauri::command]
pub fn recover_pending_extension_upgrades(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ExtensionManagerState>,
    runtime: tauri::State<'_, crate::extension_runtime::ExtensionRuntimeState>,
    vault: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
    metadata_schema_versions: BTreeMap<String, u32>,
) -> Result<Vec<InstalledExtensionView>, String> {
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
    let root = extension_root(&app)?;
    let journal = read_pending_upgrades(&root)?;
    let mut registry = read_registry(&root)?;
    if journal.extensions.is_empty() {
        crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
        return Ok(registry_views(&root, &registry));
    }

    let mut unselected_hashes = Vec::new();
    for (extension_id, pending) in &journal.extensions {
        let _previous_package = validate_installed_package(&root, extension_id, &pending.previous)?;
        let next_package = validate_installed_package(&root, extension_id, &pending.next)?;
        validate_update(&pending.previous, &next_package)?;
        let observed = metadata_schema_versions.get(extension_id).copied();
        let (selected, unselected) = recovered_record_for_schema(pending, observed)?;
        registry
            .extensions
            .insert(extension_id.clone(), selected.clone());
        if unselected.package_sha256 != selected.package_sha256 {
            unselected_hashes.push(unselected.package_sha256.clone());
        }
    }
    crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
    write_registry(&root, &registry)?;
    manager
        .authorization_generation
        .fetch_add(1, Ordering::AcqRel);

    let journal_cleaned =
        write_pending_upgrades(&root, &PendingExtensionUpgrades::default()).is_ok();
    for extension_id in journal.extensions.keys() {
        runtime.stop(extension_id);
    }
    if journal_cleaned {
        for hash in unselected_hashes {
            if !registry
                .extensions
                .values()
                .any(|record| record.package_sha256 == hash)
                && let Ok(path) = package_path(&root, &hash)
            {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(registry_views(&root, &registry))
}

#[tauri::command]
pub fn inspect_installed_extensions(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ExtensionManagerState>,
    vault: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
) -> Result<Vec<InstalledExtensionView>, String> {
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
    let root = extension_root(&app)?;
    let registry = read_registry(&root)?;
    let result = registry_views(&root, &registry);
    crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
    Ok(result)
}

#[tauri::command]
pub fn set_extension_enabled(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ExtensionManagerState>,
    runtime: tauri::State<'_, crate::extension_runtime::ExtensionRuntimeState>,
    vault: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
    extension_id: String,
    enabled: bool,
) -> Result<Vec<InstalledExtensionView>, String> {
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
    let root = extension_root(&app)?;
    if read_pending_upgrades(&root)?
        .extensions
        .contains_key(&extension_id)
    {
        return Err("extension_upgrade_recovery_required".to_owned());
    }
    let mut registry = read_registry(&root)?;
    let record = registry
        .extensions
        .get_mut(&extension_id)
        .ok_or_else(|| "extension_not_installed".to_owned())?;
    if enabled {
        validate_installed_package(&root, &extension_id, record)?;
    }
    record.enabled = enabled;
    crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
    write_registry(&root, &registry)?;
    manager
        .authorization_generation
        .fetch_add(1, Ordering::AcqRel);
    if !enabled {
        runtime.stop(&extension_id);
    }
    Ok(registry_views(&root, &registry))
}

#[tauri::command]
pub fn uninstall_extension(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ExtensionManagerState>,
    runtime: tauri::State<'_, crate::extension_runtime::ExtensionRuntimeState>,
    vault: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
    extension_id: String,
) -> Result<Vec<InstalledExtensionView>, String> {
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let _lifecycle = manager
        .lifecycle
        .lock()
        .map_err(|_| "extension_manager_state_unavailable".to_owned())?;
    let root = extension_root(&app)?;
    if read_pending_upgrades(&root)?
        .extensions
        .contains_key(&extension_id)
    {
        return Err("extension_upgrade_recovery_required".to_owned());
    }
    let mut registry = read_registry(&root)?;
    let removed = registry
        .extensions
        .remove(&extension_id)
        .ok_or_else(|| "extension_not_installed".to_owned())?;
    crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
    write_registry(&root, &registry)?;
    manager
        .authorization_generation
        .fetch_add(1, Ordering::AcqRel);
    runtime.stop(&extension_id);
    if !registry
        .extensions
        .values()
        .any(|record| record.package_sha256 == removed.package_sha256)
        && let Ok(path) = package_path(&root, &removed.package_sha256)
    {
        let _ = fs::remove_file(path);
    }
    Ok(registry_views(&root, &registry))
}

#[cfg(test)]
mod tests {
    use linked_info_extension_contracts::{
        ExtensionContributions, ExtensionManifestV1, ExtensionPublisher,
    };
    use serde_json::json;

    use super::*;

    fn metadata_package() -> ValidatedExtensionPackage {
        ValidatedExtensionPackage {
            manifest: ExtensionManifestV1 {
                schema_version: 1,
                id: "dev.example.metadata".to_owned(),
                version: "1.0.0".to_owned(),
                api_version: "1.0".to_owned(),
                publisher: ExtensionPublisher {
                    name: "Metadata test".to_owned(),
                    public_key: None,
                },
                default_locale: "en".to_owned(),
                locales: vec!["en".to_owned()],
                entrypoint: "extension.wasm".to_owned(),
                metadata_schema: "metadata.schema.json".to_owned(),
                metadata_schema_version: 1,
                capabilities: Vec::new(),
                contributions: ExtensionContributions {
                    processors: Vec::new(),
                    actions: Vec::new(),
                },
            },
            component: Vec::new(),
            metadata_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "collapsed": { "type": "boolean" }
                }
            }),
            locales: BTreeMap::new(),
            package_sha256: "00".repeat(32),
            publisher_fingerprint: None,
            signed: false,
            file_count: 0,
            uncompressed_bytes: 0,
        }
    }

    fn installed_test_record(version: &str, schema_version: u32) -> InstalledExtensionRecord {
        InstalledExtensionRecord {
            version: version.to_owned(),
            package_sha256: format!("{schema_version:064x}"),
            publisher_name: "Metadata test".to_owned(),
            publisher_fingerprint: None,
            signed: false,
            enabled: true,
            metadata_schema_version: schema_version,
            granted_capabilities: Vec::new(),
        }
    }

    #[test]
    fn registry_rejects_unknown_fields_instead_of_resetting_authorization() {
        let invalid = br#"{"version":1,"extensions":{},"unexpected":true}"#;
        assert!(serde_json::from_slice::<ExtensionRegistry>(invalid).is_err());
    }

    #[test]
    fn capability_approval_is_set_and_length_exact() {
        let requested = vec![
            ExtensionCapability::NodeReadContent,
            ExtensionCapability::WorkspacePropose,
        ];
        let duplicate = vec![
            ExtensionCapability::NodeReadContent,
            ExtensionCapability::NodeReadContent,
        ];
        assert_ne!(capability_set(&requested), capability_set(&duplicate));
        assert_ne!(requested.len(), capability_set(&duplicate).len());
    }

    #[test]
    fn package_paths_are_content_addressed_and_cannot_escape() {
        let root = Path::new("extensions");
        assert_eq!(
            package_path(root, &"a".repeat(64)).unwrap(),
            root.join(PACKAGE_DIRECTORY)
                .join(format!("{}.liext", "a".repeat(64)))
        );
        assert!(package_path(root, "../escape").is_err());
    }

    #[test]
    fn migration_input_requires_the_installed_schema_and_bounded_objects() {
        let package = metadata_package();
        let valid = ExtensionMetadataMigrationInput {
            schema_version: 1,
            workspace: json!({}),
            nodes: vec![json!({ "collapsed": true })],
        };
        assert!(validate_migration_input(&valid, 1, &package).is_ok());

        let mut stale = valid.clone();
        stale.schema_version = 2;
        assert!(validate_migration_input(&stale, 1, &package).is_err());

        let mut invalid = valid;
        invalid.nodes = vec![json!({ "hiddenReference": "node-id" })];
        assert!(validate_migration_input(&invalid, 1, &package).is_err());
    }

    #[test]
    fn pending_upgrade_recovery_follows_only_the_observed_schema() {
        let previous = installed_test_record("1.0.0", 1);
        let next = installed_test_record("2.0.0", 2);
        let pending = PendingExtensionUpgrade {
            metadata_migration_id: "migration-1".to_owned(),
            previous: previous.clone(),
            next: next.clone(),
        };

        assert_eq!(
            recovered_record_for_schema(&pending, Some(1)).unwrap().0,
            &previous
        );
        assert_eq!(
            recovered_record_for_schema(&pending, Some(2)).unwrap().0,
            &next
        );
        assert_eq!(
            recovered_record_for_schema(&pending, None).unwrap().0,
            &previous
        );
        assert!(recovered_record_for_schema(&pending, Some(3)).is_err());
    }

    #[test]
    fn pending_upgrade_journal_rejects_unknown_fields() {
        let invalid = br#"{"version":1,"extensions":{},"unexpected":true}"#;
        assert!(serde_json::from_slice::<PendingExtensionUpgrades>(invalid).is_err());
    }
}
