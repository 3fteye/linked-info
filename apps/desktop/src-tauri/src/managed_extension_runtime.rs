use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
    time::{Duration, Instant},
};

use linked_info_extension_contracts::{
    ExtensionActionRequestV1, ExtensionActionResultV1, ExtensionCapability,
    ExtensionPresentationV1, ExtensionRenderRequestV1, NodeHandle, NodeSnapshotV1,
};
use linked_info_extension_host_protocol::{
    ExtensionHostErrorCode, ExtensionHostRequestV1, ExtensionHostResponseV1,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;

const PASSIVE_TIMEOUT: Duration = Duration::from_millis(500);
const ACTIVE_TIMEOUT: Duration = Duration::from_secs(30);
const MAXIMUM_PASSIVE_CONTENT_BYTES: usize = 20_000;
const MAXIMUM_PASSIVE_LINES: usize = 500;
const MAXIMUM_ACTIVE_CONTENT_BYTES: usize = 1024 * 1024;
const MAXIMUM_NODE_NAME_BYTES: usize = 64 * 1024;
const MAXIMUM_ACTION_NODES: usize = 64;
const MAXIMUM_DIRECT_HANDLES: usize = 10_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedExtensionNodeInput {
    id: String,
    name: Option<String>,
    content: Option<String>,
    direct_outgoing_node_ids: Vec<String>,
    direct_incoming_node_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedExtensionMetadataInput {
    schema_version: u32,
    node: serde_json::Value,
    workspace: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedExtensionRenderResult {
    extension_id: String,
    metadata_schema_version: u32,
    input_truncated: bool,
    presentation: ExtensionPresentationV1,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedExtensionActionResult {
    extension_id: String,
    metadata_schema_version: u32,
    handle_node_ids: BTreeMap<String, String>,
    result: ExtensionActionResultV1,
}

struct PreparedSnapshots {
    snapshots: Vec<NodeSnapshotV1>,
    handle_node_ids: BTreeMap<u64, String>,
    input_truncated: bool,
}

fn has_capability(capabilities: &[ExtensionCapability], capability: ExtensionCapability) -> bool {
    capabilities.contains(&capability)
}

fn canonical_node_id(value: &str) -> Result<String, String> {
    uuid::Uuid::parse_str(value)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| "extension_runtime_snapshot_invalid".to_owned())
}

fn bounded_passive_content(content: &str) -> (String, bool) {
    let mut end = content.len().min(MAXIMUM_PASSIVE_CONTENT_BYTES);
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    let mut newline_count = 0;
    for (index, byte) in content.as_bytes()[..end].iter().enumerate() {
        if *byte == b'\n' {
            newline_count += 1;
            if newline_count >= MAXIMUM_PASSIVE_LINES {
                end = index;
                break;
            }
        }
    }
    (content[..end].to_owned(), end < content.len())
}

fn runtime_content(content: Option<&str>, passive: bool) -> Result<(Option<String>, bool), String> {
    let Some(content) = content else {
        return Ok((None, false));
    };
    let sanitized = crate::extension_runtime_content::content_for_extension_runtime(content);
    if passive {
        let (content, truncated) = bounded_passive_content(&sanitized);
        return Ok((Some(content), truncated));
    }
    if sanitized.len() > MAXIMUM_ACTIVE_CONTENT_BYTES {
        return Err("extension_runtime_active_content_too_large".to_owned());
    }
    Ok((Some(sanitized), false))
}

fn prepare_snapshots(
    nodes: &[ManagedExtensionNodeInput],
    capabilities: &[ExtensionCapability],
    passive: bool,
) -> Result<PreparedSnapshots, String> {
    if nodes.is_empty() || nodes.len() > MAXIMUM_ACTION_NODES {
        return Err("extension_runtime_snapshot_invalid".to_owned());
    }
    let graph_read = has_capability(capabilities, ExtensionCapability::GraphReadDirect);
    let mut handle_by_node_id = BTreeMap::<String, NodeHandle>::new();
    let mut handle_node_ids = BTreeMap::<u64, String>::new();
    for (index, node) in nodes.iter().enumerate() {
        let node_id = canonical_node_id(&node.id)?;
        let handle = NodeHandle((index + 1) as u64);
        if handle_by_node_id.insert(node_id.clone(), handle).is_some() {
            return Err("extension_runtime_snapshot_invalid".to_owned());
        }
        handle_node_ids.insert(handle.0, node_id);
        if node.direct_outgoing_node_ids.len() > MAXIMUM_DIRECT_HANDLES
            || node.direct_incoming_node_ids.len() > MAXIMUM_DIRECT_HANDLES
        {
            return Err("extension_runtime_snapshot_invalid".to_owned());
        }
    }
    let mut next_handle = nodes.len() as u64 + 1;
    let mut resolve_handle = |raw_node_id: &str| -> Result<NodeHandle, String> {
        let node_id = canonical_node_id(raw_node_id)?;
        if let Some(handle) = handle_by_node_id.get(&node_id) {
            return Ok(*handle);
        }
        let handle = NodeHandle(next_handle);
        next_handle = next_handle
            .checked_add(1)
            .ok_or_else(|| "extension_runtime_snapshot_invalid".to_owned())?;
        handle_by_node_id.insert(node_id.clone(), handle);
        handle_node_ids.insert(handle.0, node_id);
        Ok(handle)
    };

    let mut snapshots = Vec::with_capacity(nodes.len());
    let mut input_truncated = false;
    for (index, node) in nodes.iter().enumerate() {
        let handle = NodeHandle((index + 1) as u64);
        let name = if has_capability(capabilities, ExtensionCapability::NodeReadName) {
            if node
                .name
                .as_ref()
                .is_some_and(|name| name.len() > MAXIMUM_NODE_NAME_BYTES)
            {
                return Err("extension_runtime_snapshot_invalid".to_owned());
            }
            node.name.clone()
        } else {
            None
        };
        let (content, truncated) =
            if has_capability(capabilities, ExtensionCapability::NodeReadContent) {
                runtime_content(node.content.as_deref(), passive)?
            } else {
                (None, false)
            };
        input_truncated |= truncated;
        let mut outgoing = BTreeSet::new();
        let mut incoming = BTreeSet::new();
        if graph_read {
            for node_id in &node.direct_outgoing_node_ids {
                let related = resolve_handle(node_id)?;
                if related == handle || !outgoing.insert(related) {
                    return Err("extension_runtime_snapshot_invalid".to_owned());
                }
            }
            for node_id in &node.direct_incoming_node_ids {
                let related = resolve_handle(node_id)?;
                if related == handle || !incoming.insert(related) {
                    return Err("extension_runtime_snapshot_invalid".to_owned());
                }
            }
        }
        snapshots.push(NodeSnapshotV1 {
            handle,
            name,
            content,
            direct_outgoing: outgoing.into_iter().collect(),
            direct_incoming: incoming.into_iter().collect(),
        });
    }
    drop(resolve_handle);
    Ok(PreparedSnapshots {
        snapshots,
        handle_node_ids,
        input_truncated,
    })
}

fn metadata_json(
    metadata: Option<&ManagedExtensionMetadataInput>,
    schema_version: u32,
    capabilities: &[ExtensionCapability],
) -> Result<(Option<String>, Option<String>), String> {
    let Some(metadata) = metadata.filter(|metadata| metadata.schema_version == schema_version)
    else {
        return Ok((None, None));
    };
    let node = has_capability(capabilities, ExtensionCapability::MetadataNodeRead)
        .then(|| serde_json::to_string(&metadata.node))
        .transpose()
        .map_err(|_| "extension_runtime_metadata_invalid".to_owned())?;
    let workspace = has_capability(capabilities, ExtensionCapability::MetadataWorkspaceRead)
        .then(|| serde_json::to_string(&metadata.workspace))
        .transpose()
        .map_err(|_| "extension_runtime_metadata_invalid".to_owned())?;
    Ok((node, workspace))
}

fn monotonic_time_ms(capabilities: &[ExtensionCapability]) -> Option<u64> {
    static START: OnceLock<Instant> = OnceLock::new();
    has_capability(capabilities, ExtensionCapability::ClockMonotonic).then(|| {
        START
            .get_or_init(Instant::now)
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    })
}

fn host_error(code: ExtensionHostErrorCode) -> String {
    let code = match code {
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
    };
    format!("extension_runtime_host_{code}")
}

fn prepare_runtime(
    app: &tauri::AppHandle,
    manager: &crate::extension_manager::ExtensionManagerState,
    runtime: &crate::extension_runtime::ExtensionRuntimeState,
    extension_id: &str,
    generation: u64,
) -> Result<crate::extension_manager::ManagedExtensionRuntimeRegistration, String> {
    let registration = crate::extension_manager::managed_extension_runtime_registration(
        app,
        manager,
        extension_id,
    )?;
    runtime.ensure_started(
        app,
        extension_id,
        &registration.extension_id,
        &registration.package_path,
        generation,
        registration.allow_unsigned_development,
    )?;
    Ok(registration)
}

fn render_managed_extension_processor_blocking(
    app: tauri::AppHandle,
    extension_id: String,
    processor_id: String,
    node: ManagedExtensionNodeInput,
    metadata: Option<ManagedExtensionMetadataInput>,
) -> Result<ManagedExtensionRenderResult, String> {
    let manager = app.state::<crate::extension_manager::ExtensionManagerState>();
    let runtime = app.state::<crate::extension_runtime::ExtensionRuntimeState>();
    let vault = app.state::<crate::workspace_file::WorkspaceVaultState>();
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let generation = vault
        .access_generation()
        .load(std::sync::atomic::Ordering::Acquire);
    let registration = prepare_runtime(&app, &manager, &runtime, &extension_id, generation)?;
    if !registration
        .package
        .manifest
        .contributions
        .processors
        .iter()
        .any(|processor| processor.id == processor_id)
    {
        return Err("extension_runtime_processor_unknown".to_owned());
    }
    let prepared = prepare_snapshots(
        std::slice::from_ref(&node),
        &registration.package.manifest.capabilities,
        true,
    )?;
    let (node_metadata_json, workspace_metadata_json) = metadata_json(
        metadata.as_ref(),
        registration.package.manifest.metadata_schema_version,
        &registration.package.manifest.capabilities,
    )?;
    let response = runtime.request(
        &extension_id,
        ExtensionHostRequestV1::Render {
            request_id: runtime.next_request_id(),
            generation,
            request: ExtensionRenderRequestV1 {
                processor_id,
                node: prepared
                    .snapshots
                    .into_iter()
                    .next()
                    .expect("one render snapshot"),
                node_metadata_json,
                workspace_metadata_json,
                monotonic_time_ms: monotonic_time_ms(&registration.package.manifest.capabilities),
            },
        },
        PASSIVE_TIMEOUT,
    )?;
    crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
    match response {
        ExtensionHostResponseV1::Rendered { presentation, .. } => {
            Ok(ManagedExtensionRenderResult {
                extension_id,
                metadata_schema_version: registration.package.manifest.metadata_schema_version,
                input_truncated: prepared.input_truncated,
                presentation,
            })
        }
        ExtensionHostResponseV1::Error { code, .. } => Err(host_error(code)),
        _ => Err("extension_runtime_protocol_unavailable".to_owned()),
    }
}

#[tauri::command]
pub async fn render_managed_extension_processor(
    app: tauri::AppHandle,
    extension_id: String,
    processor_id: String,
    node: ManagedExtensionNodeInput,
    metadata: Option<ManagedExtensionMetadataInput>,
) -> Result<ManagedExtensionRenderResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        render_managed_extension_processor_blocking(app, extension_id, processor_id, node, metadata)
    })
    .await
    .map_err(|_| "extension_runtime_task_failed".to_owned())?
}

fn invoke_managed_extension_action_blocking(
    app: tauri::AppHandle,
    extension_id: String,
    action_id: String,
    nodes: Vec<ManagedExtensionNodeInput>,
    metadata: Option<ManagedExtensionMetadataInput>,
    input_value: Option<String>,
    base_revision: u64,
) -> Result<ManagedExtensionActionResult, String> {
    let manager = app.state::<crate::extension_manager::ExtensionManagerState>();
    let runtime = app.state::<crate::extension_runtime::ExtensionRuntimeState>();
    let vault = app.state::<crate::workspace_file::WorkspaceVaultState>();
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault)?;
    let generation = vault
        .access_generation()
        .load(std::sync::atomic::Ordering::Acquire);
    let registration = prepare_runtime(&app, &manager, &runtime, &extension_id, generation)?;
    if !registration
        .package
        .manifest
        .contributions
        .actions
        .iter()
        .any(|action| action.id == action_id)
    {
        return Err("extension_runtime_action_unknown".to_owned());
    }
    let prepared = prepare_snapshots(&nodes, &registration.package.manifest.capabilities, false)?;
    let metadata = (nodes.len() == 1).then_some(metadata).flatten();
    let (node_metadata_json, workspace_metadata_json) = metadata_json(
        metadata.as_ref(),
        registration.package.manifest.metadata_schema_version,
        &registration.package.manifest.capabilities,
    )?;
    let response = runtime.request(
        &extension_id,
        ExtensionHostRequestV1::Invoke {
            request_id: runtime.next_request_id(),
            generation,
            request: ExtensionActionRequestV1 {
                action_id,
                nodes: prepared.snapshots,
                node_metadata_json,
                workspace_metadata_json,
                input_value,
                monotonic_time_ms: monotonic_time_ms(&registration.package.manifest.capabilities),
                base_revision,
            },
        },
        ACTIVE_TIMEOUT,
    )?;
    crate::workspace_file::ensure_workspace_access(&app, &vault, permit)?;
    match response {
        ExtensionHostResponseV1::Invoked { result, .. } => Ok(ManagedExtensionActionResult {
            extension_id,
            metadata_schema_version: registration.package.manifest.metadata_schema_version,
            handle_node_ids: prepared
                .handle_node_ids
                .into_iter()
                .map(|(handle, node_id)| (handle.to_string(), node_id))
                .collect(),
            result,
        }),
        ExtensionHostResponseV1::Error { code, .. } => Err(host_error(code)),
        _ => Err("extension_runtime_protocol_unavailable".to_owned()),
    }
}

#[tauri::command]
pub async fn invoke_managed_extension_action(
    app: tauri::AppHandle,
    extension_id: String,
    action_id: String,
    nodes: Vec<ManagedExtensionNodeInput>,
    metadata: Option<ManagedExtensionMetadataInput>,
    input_value: Option<String>,
    base_revision: u64,
) -> Result<ManagedExtensionActionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        invoke_managed_extension_action_blocking(
            app,
            extension_id,
            action_id,
            nodes,
            metadata,
            input_value,
            base_revision,
        )
    })
    .await
    .map_err(|_| "extension_runtime_task_failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_strip_secret_payloads_and_never_expose_node_ids() {
        let node_id = "11111111-1111-4111-8111-111111111111";
        let prepared = prepare_snapshots(
            &[ManagedExtensionNodeInput {
                id: node_id.to_owned(),
                name: Some("Account".to_owned()),
                content: Some("before [[li:secret]]synthetic-secret[[/li]] after".to_owned()),
                direct_outgoing_node_ids: Vec::new(),
                direct_incoming_node_ids: Vec::new(),
            }],
            &[
                ExtensionCapability::NodeReadName,
                ExtensionCapability::NodeReadContent,
            ],
            true,
        )
        .unwrap();

        assert_eq!(prepared.snapshots[0].handle, NodeHandle(1));
        assert_eq!(prepared.snapshots[0].name.as_deref(), Some("Account"));
        assert_eq!(
            prepared.snapshots[0].content.as_deref(),
            Some("before  after")
        );
        assert!(
            !serde_json::to_string(&prepared.snapshots)
                .unwrap()
                .contains(node_id)
        );
        assert_eq!(
            prepared.handle_node_ids.get(&1).map(String::as_str),
            Some(node_id)
        );
    }

    #[test]
    fn direct_relations_use_temporary_handles_and_reject_self_links() {
        let source = "11111111-1111-4111-8111-111111111111";
        let target = "22222222-2222-4222-8222-222222222222";
        let prepared = prepare_snapshots(
            &[ManagedExtensionNodeInput {
                id: source.to_owned(),
                name: None,
                content: None,
                direct_outgoing_node_ids: vec![target.to_owned()],
                direct_incoming_node_ids: Vec::new(),
            }],
            &[ExtensionCapability::GraphReadDirect],
            true,
        )
        .unwrap();
        assert_eq!(prepared.snapshots[0].direct_outgoing, vec![NodeHandle(2)]);
        assert_eq!(
            prepared.handle_node_ids.get(&2).map(String::as_str),
            Some(target)
        );

        let self_link = prepare_snapshots(
            &[ManagedExtensionNodeInput {
                id: source.to_owned(),
                name: None,
                content: None,
                direct_outgoing_node_ids: vec![source.to_owned()],
                direct_incoming_node_ids: Vec::new(),
            }],
            &[ExtensionCapability::GraphReadDirect],
            true,
        );
        assert!(self_link.is_err());
    }

    #[test]
    fn passive_content_is_bounded_without_splitting_utf8() {
        let source = "界".repeat(MAXIMUM_PASSIVE_CONTENT_BYTES);
        let (bounded, truncated) = bounded_passive_content(&source);
        assert!(truncated);
        assert!(bounded.len() <= MAXIMUM_PASSIVE_CONTENT_BYTES);
        assert!(bounded.is_char_boundary(bounded.len()));
    }
}
