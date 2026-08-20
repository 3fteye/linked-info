use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use linked_info_extension_contracts::{
    ActionContribution, ExtensionCapability, MAXIMUM_EXTENSION_PACKAGE_BYTES,
    ProcessorContribution, SignaturePolicy, ValidatedExtensionPackage, validate_extension_package,
};
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const REGISTRY_VERSION: u32 = 1;
const REGISTRY_FILE: &str = "registry-v1.json";
const PACKAGE_DIRECTORY: &str = "packages";
const MAXIMUM_PREPARED_INSTALLS: usize = 4;

#[derive(Default)]
pub struct ExtensionManagerState {
    prepared: Mutex<BTreeMap<String, PreparedExtensionInstall>>,
}

#[derive(Clone)]
struct PreparedExtensionInstall {
    bytes: Vec<u8>,
    package: ValidatedExtensionPackage,
    update: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

fn extension_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("extensions").join("v1"))
        .map_err(|_| "extension_manager_directory_unavailable".to_owned())
}

fn registry_path(root: &Path) -> PathBuf {
    root.join(REGISTRY_FILE)
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
    Ok(())
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
    let registry = read_registry(&root)?;
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
        },
    );
    Ok(Some(preview))
}

#[tauri::command]
pub fn commit_extension_install(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ExtensionManagerState>,
    vault: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
    prepared_install_id: String,
    granted_capabilities: Vec<ExtensionCapability>,
    enabled: bool,
) -> Result<Vec<InstalledExtensionView>, String> {
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
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
            return Err("extension_upgrade_metadata_migration_required".to_owned());
        }
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
    registry.extensions.insert(
        prepared.package.manifest.id.clone(),
        InstalledExtensionRecord {
            version: prepared.package.manifest.version.clone(),
            package_sha256: prepared.package.package_sha256.clone(),
            publisher_name: prepared.package.manifest.publisher.name.clone(),
            publisher_fingerprint: prepared.package.publisher_fingerprint.clone(),
            signed: prepared.package.signed,
            enabled,
            metadata_schema_version: prepared.package.manifest.metadata_schema_version,
            granted_capabilities,
        },
    );
    write_registry(&root, &registry)?;
    if let Some(old_hash) = old_hash.filter(|hash| hash != &prepared.package.package_sha256)
        && !registry
            .extensions
            .values()
            .any(|record| record.package_sha256 == old_hash)
        && let Ok(old_path) = package_path(&root, &old_hash)
    {
        let _ = fs::remove_file(old_path);
    }
    inspect_installed_extensions(app, vault)
}

#[tauri::command]
pub fn inspect_installed_extensions(
    app: tauri::AppHandle,
    vault: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
) -> Result<Vec<InstalledExtensionView>, String> {
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let root = extension_root(&app)?;
    let registry = read_registry(&root)?;
    let result = registry
        .extensions
        .iter()
        .map(|(id, record)| record_view(&root, id, record))
        .collect();
    crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
    Ok(result)
}

#[tauri::command]
pub fn set_extension_enabled(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, crate::extension_runtime::ExtensionRuntimeState>,
    vault: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
    extension_id: String,
    enabled: bool,
) -> Result<Vec<InstalledExtensionView>, String> {
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let root = extension_root(&app)?;
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
    if !enabled {
        runtime.stop(&extension_id);
    }
    inspect_installed_extensions(app, vault)
}

#[tauri::command]
pub fn uninstall_extension(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, crate::extension_runtime::ExtensionRuntimeState>,
    vault: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
    extension_id: String,
) -> Result<Vec<InstalledExtensionView>, String> {
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let root = extension_root(&app)?;
    let mut registry = read_registry(&root)?;
    let removed = registry
        .extensions
        .remove(&extension_id)
        .ok_or_else(|| "extension_not_installed".to_owned())?;
    crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
    write_registry(&root, &registry)?;
    runtime.stop(&extension_id);
    if !registry
        .extensions
        .values()
        .any(|record| record.package_sha256 == removed.package_sha256)
        && let Ok(path) = package_path(&root, &removed.package_sha256)
    {
        let _ = fs::remove_file(path);
    }
    inspect_installed_extensions(app, vault)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
