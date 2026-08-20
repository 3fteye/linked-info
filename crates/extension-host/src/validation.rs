use std::collections::BTreeSet;

use linked_info_extension_contracts::{
    ActionContribution, ChangeOperation, ChangeProposalV1, ExtensionActionRequestV1,
    ExtensionActionResultV1, ExtensionActionScope, ExtensionCapability, ExtensionManifestV1,
    ExtensionMetadataMigrationRequestV1, ExtensionPresentationV1, ExtensionRenderRequestV1,
    NodeHandle, NodeSnapshotV1, PresentationElement, ProposalEndpoint, ValidatedExtensionPackage,
    extension_metadata_matches_schema,
};
use serde_json::Value;

use crate::ExtensionRuntimeError;

const MAXIMUM_PASSIVE_CONTENT_BYTES: usize = 20_000;
const MAXIMUM_PASSIVE_LINES: usize = 500;
const MAXIMUM_NODE_NAME_BYTES: usize = 64 * 1024;
const MAXIMUM_ACTION_NODE_CONTENT_BYTES: usize = 1024 * 1024;
const MAXIMUM_ACTION_NODES: usize = 64;
const MAXIMUM_DIRECT_HANDLES: usize = 10_000;
const MAXIMUM_METADATA_JSON_BYTES: usize = 64 * 1024;
const MAXIMUM_NODE_METADATA_BYTES: usize = 16 * 1024;
const MAXIMUM_PRESENTATION_BYTES: usize = 1024 * 1024;
const MAXIMUM_PRESENTATION_ELEMENTS: usize = 128;
const MAXIMUM_PRESENTATION_STRING_CHARACTERS: usize = 20_000;
const MAXIMUM_PROPOSAL_OPERATIONS: usize = 256;
const MAXIMUM_TEMPORARY_ID_BYTES: usize = 64;

fn has_capability(manifest: &ExtensionManifestV1, capability: ExtensionCapability) -> bool {
    manifest.capabilities.contains(&capability)
}

fn valid_metadata_json(raw: &str, package: &ValidatedExtensionPackage, limit: usize) -> bool {
    raw.len() <= limit
        && serde_json::from_str::<Value>(raw)
            .ok()
            .is_some_and(|value| {
                extension_metadata_matches_schema(&package.metadata_schema, &value)
            })
}

fn valid_handles(snapshot: &NodeSnapshotV1) -> bool {
    if snapshot.handle.0 == 0
        || snapshot.direct_outgoing.len() > MAXIMUM_DIRECT_HANDLES
        || snapshot.direct_incoming.len() > MAXIMUM_DIRECT_HANDLES
    {
        return false;
    }
    let mut outgoing = BTreeSet::new();
    let mut incoming = BTreeSet::new();
    snapshot
        .direct_outgoing
        .iter()
        .all(|handle| handle.0 != 0 && *handle != snapshot.handle && outgoing.insert(*handle))
        && snapshot
            .direct_incoming
            .iter()
            .all(|handle| handle.0 != 0 && *handle != snapshot.handle && incoming.insert(*handle))
}

fn valid_snapshot(
    snapshot: &NodeSnapshotV1,
    manifest: &ExtensionManifestV1,
    maximum_content_bytes: usize,
    maximum_lines: Option<usize>,
) -> bool {
    if !valid_handles(snapshot)
        || (!has_capability(manifest, ExtensionCapability::NodeReadName) && snapshot.name.is_some())
        || (!has_capability(manifest, ExtensionCapability::NodeReadContent)
            && snapshot.content.is_some())
        || (!has_capability(manifest, ExtensionCapability::GraphReadDirect)
            && (!snapshot.direct_outgoing.is_empty() || !snapshot.direct_incoming.is_empty()))
        || snapshot
            .name
            .as_ref()
            .is_some_and(|name| name.len() > MAXIMUM_NODE_NAME_BYTES)
    {
        return false;
    }
    snapshot.content.as_ref().is_none_or(|content| {
        content.len() <= maximum_content_bytes
            && maximum_lines.is_none_or(|limit| content.lines().count().max(1) <= limit)
    })
}

fn valid_read_metadata(
    node_metadata_json: Option<&String>,
    workspace_metadata_json: Option<&String>,
    package: &ValidatedExtensionPackage,
) -> bool {
    node_metadata_json.is_none_or(|raw| {
        has_capability(&package.manifest, ExtensionCapability::MetadataNodeRead)
            && valid_metadata_json(raw, package, MAXIMUM_NODE_METADATA_BYTES)
    }) && workspace_metadata_json.is_none_or(|raw| {
        has_capability(
            &package.manifest,
            ExtensionCapability::MetadataWorkspaceRead,
        ) && valid_metadata_json(raw, package, MAXIMUM_METADATA_JSON_BYTES)
    })
}

fn valid_clock(monotonic_time_ms: Option<u64>, manifest: &ExtensionManifestV1) -> bool {
    monotonic_time_ms.is_none() || has_capability(manifest, ExtensionCapability::ClockMonotonic)
}

pub fn validate_render_request(
    request: &ExtensionRenderRequestV1,
    package: &ValidatedExtensionPackage,
) -> Result<(), ExtensionRuntimeError> {
    if !package
        .manifest
        .contributions
        .processors
        .iter()
        .any(|processor| processor.id == request.processor_id)
        || !valid_snapshot(
            &request.node,
            &package.manifest,
            MAXIMUM_PASSIVE_CONTENT_BYTES,
            Some(MAXIMUM_PASSIVE_LINES),
        )
        || !valid_read_metadata(
            request.node_metadata_json.as_ref(),
            request.workspace_metadata_json.as_ref(),
            package,
        )
        || !valid_clock(request.monotonic_time_ms, &package.manifest)
    {
        return Err(ExtensionRuntimeError::RequestInvalid);
    }
    Ok(())
}

fn action<'a>(
    request: &ExtensionActionRequestV1,
    manifest: &'a ExtensionManifestV1,
) -> Option<&'a ActionContribution> {
    manifest
        .contributions
        .actions
        .iter()
        .find(|action| action.id == request.action_id)
}

pub fn validate_action_request(
    request: &ExtensionActionRequestV1,
    package: &ValidatedExtensionPackage,
) -> Result<(), ExtensionRuntimeError> {
    let Some(action) = action(request, &package.manifest) else {
        return Err(ExtensionRuntimeError::RequestInvalid);
    };
    let valid_scope = match action.scope {
        ExtensionActionScope::CurrentNode => request.nodes.len() == 1,
        ExtensionActionScope::Selection => {
            !request.nodes.is_empty() && request.nodes.len() <= MAXIMUM_ACTION_NODES
        }
    };
    let mut handles = BTreeSet::new();
    if !valid_scope
        || !request.nodes.iter().all(|node| {
            valid_snapshot(
                node,
                &package.manifest,
                MAXIMUM_ACTION_NODE_CONTENT_BYTES,
                None,
            ) && handles.insert(node.handle)
        })
        || request
            .input_value
            .as_ref()
            .is_some_and(|value| value.len() > MAXIMUM_METADATA_JSON_BYTES)
        || (request.nodes.len() != 1 && request.node_metadata_json.is_some())
        || !valid_read_metadata(
            request.node_metadata_json.as_ref(),
            request.workspace_metadata_json.as_ref(),
            package,
        )
        || !valid_clock(request.monotonic_time_ms, &package.manifest)
    {
        return Err(ExtensionRuntimeError::RequestInvalid);
    }
    Ok(())
}

pub fn validate_migration_request(
    request: &ExtensionMetadataMigrationRequestV1,
    package: &ValidatedExtensionPackage,
) -> Result<(), ExtensionRuntimeError> {
    if request.from_version == 0
        || request.to_version == 0
        || request.from_version >= request.to_version
        || request.to_version != package.manifest.metadata_schema_version
        || request.metadata_json.len() > 4 * 1024 * 1024
        || serde_json::from_str::<Value>(&request.metadata_json).is_err()
    {
        return Err(ExtensionRuntimeError::RequestInvalid);
    }
    Ok(())
}

fn locale_has(package: &ValidatedExtensionPackage, key: &str) -> bool {
    package
        .locales
        .get(&package.manifest.default_locale)
        .is_some_and(|locale| locale.contains_key(key))
}

fn valid_presentation_string(value: &str) -> bool {
    value.chars().count() <= MAXIMUM_PRESENTATION_STRING_CHARACTERS
}

pub fn validate_presentation(
    presentation: &ExtensionPresentationV1,
    package: &ValidatedExtensionPackage,
) -> Result<(), ExtensionRuntimeError> {
    if presentation.elements.len() > MAXIMUM_PRESENTATION_ELEMENTS
        || serde_json::to_vec(presentation)
            .ok()
            .is_none_or(|encoded| encoded.len() > MAXIMUM_PRESENTATION_BYTES)
    {
        return Err(ExtensionRuntimeError::OutputInvalid);
    }
    let declared_actions = package
        .manifest
        .contributions
        .actions
        .iter()
        .map(|action| action.id.as_str())
        .collect::<BTreeSet<_>>();
    for element in &presentation.elements {
        let valid = match element {
            PresentationElement::Text { text } => valid_presentation_string(text),
            PresentationElement::Code { language, source } => {
                !language.is_empty()
                    && language.len() <= 64
                    && language.is_ascii()
                    && valid_presentation_string(source)
            }
            PresentationElement::KeyValue { items } => {
                items.len() <= 128
                    && items.iter().all(|item| {
                        valid_presentation_string(&item.key)
                            && valid_presentation_string(&item.value)
                    })
            }
            PresentationElement::Table { columns, rows } => {
                !columns.is_empty()
                    && columns.len() <= 128
                    && rows.len() <= 1_024
                    && columns
                        .iter()
                        .all(|column| valid_presentation_string(column))
                    && rows.iter().all(|row| {
                        row.len() == columns.len()
                            && row.iter().all(|cell| valid_presentation_string(cell))
                    })
            }
            PresentationElement::Badge { text, .. } => valid_presentation_string(text),
            PresentationElement::Divider => true,
            PresentationElement::Button { action_id } => {
                declared_actions.contains(action_id.as_str())
            }
            PresentationElement::Select {
                action_id,
                label_key,
                selected,
                options,
            } => {
                let values = options
                    .iter()
                    .map(|option| option.value.as_str())
                    .collect::<BTreeSet<_>>();
                declared_actions.contains(action_id.as_str())
                    && locale_has(package, label_key)
                    && !options.is_empty()
                    && options.len() <= 128
                    && values.len() == options.len()
                    && selected
                        .as_ref()
                        .is_none_or(|selected| values.contains(selected.as_str()))
                    && options.iter().all(|option| {
                        valid_presentation_string(&option.value)
                            && locale_has(package, &option.label_key)
                    })
            }
        };
        if !valid {
            return Err(ExtensionRuntimeError::OutputInvalid);
        }
    }
    Ok(())
}

fn valid_temporary_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAXIMUM_TEMPORARY_ID_BYTES
        && value.is_ascii()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_endpoint(
    endpoint: &ProposalEndpoint,
    handles: &BTreeSet<NodeHandle>,
    temporary_ids: &BTreeSet<&str>,
) -> bool {
    match endpoint {
        ProposalEndpoint::Existing { handle } => handles.contains(handle),
        ProposalEndpoint::Created { temporary_id } => temporary_ids.contains(temporary_id.as_str()),
    }
}

fn validate_proposal(
    proposal: &ChangeProposalV1,
    request: &ExtensionActionRequestV1,
    package: &ValidatedExtensionPackage,
) -> bool {
    if proposal.base_revision != request.base_revision
        || !locale_has(package, &proposal.title_key)
        || proposal.operations.is_empty()
        || proposal.operations.len() > MAXIMUM_PROPOSAL_OPERATIONS
    {
        return false;
    }
    let temporary_ids = proposal
        .operations
        .iter()
        .filter_map(|operation| match operation {
            ChangeOperation::CreateNode { temporary_id, .. } => Some(temporary_id.as_str()),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    if temporary_ids.len()
        != proposal
            .operations
            .iter()
            .filter(|operation| matches!(operation, ChangeOperation::CreateNode { .. }))
            .count()
        || !temporary_ids
            .iter()
            .all(|temporary_id| valid_temporary_id(temporary_id))
    {
        return false;
    }
    let handles = request
        .nodes
        .iter()
        .flat_map(|node| {
            std::iter::once(node.handle)
                .chain(node.direct_outgoing.iter().copied())
                .chain(node.direct_incoming.iter().copied())
        })
        .collect::<BTreeSet<_>>();
    proposal.operations.iter().all(|operation| match operation {
        ChangeOperation::CreateNode { name, content, .. } => {
            name.len() <= MAXIMUM_METADATA_JSON_BYTES
                && content.len() <= MAXIMUM_ACTION_NODE_CONTENT_BYTES
        }
        ChangeOperation::UpdateCurrentNode { name, content } => {
            request.nodes.len() == 1
                && serde_json::to_vec(name)
                    .is_ok_and(|value| value.len() <= MAXIMUM_METADATA_JSON_BYTES)
                && serde_json::to_vec(content)
                    .is_ok_and(|value| value.len() <= MAXIMUM_ACTION_NODE_CONTENT_BYTES)
        }
        ChangeOperation::CreateReference { source, target }
        | ChangeOperation::RemoveReference { source, target } => {
            source != target
                && valid_endpoint(source, &handles, &temporary_ids)
                && valid_endpoint(target, &handles, &temporary_ids)
        }
    })
}

pub fn validate_action_result(
    result: &ExtensionActionResultV1,
    request: &ExtensionActionRequestV1,
    package: &ValidatedExtensionPackage,
) -> Result<(), ExtensionRuntimeError> {
    if serde_json::to_vec(result)
        .ok()
        .is_none_or(|encoded| encoded.len() > MAXIMUM_PRESENTATION_BYTES)
        || result
            .presentation
            .as_ref()
            .is_some_and(|presentation| validate_presentation(presentation, package).is_err())
        || result.node_metadata.as_ref().is_some_and(|metadata| {
            request.nodes.len() != 1
                || !has_capability(&package.manifest, ExtensionCapability::MetadataNodeWrite)
                || serde_json::to_vec(metadata)
                    .ok()
                    .is_none_or(|encoded| encoded.len() > MAXIMUM_NODE_METADATA_BYTES)
                || !extension_metadata_matches_schema(&package.metadata_schema, metadata)
        })
        || result.workspace_metadata.as_ref().is_some_and(|metadata| {
            !has_capability(
                &package.manifest,
                ExtensionCapability::MetadataWorkspaceWrite,
            ) || serde_json::to_vec(metadata)
                .ok()
                .is_none_or(|encoded| encoded.len() > MAXIMUM_METADATA_JSON_BYTES)
                || !extension_metadata_matches_schema(&package.metadata_schema, metadata)
        })
        || result.proposal.as_ref().is_some_and(|proposal| {
            !has_capability(&package.manifest, ExtensionCapability::WorkspacePropose)
                || !validate_proposal(proposal, request, package)
        })
    {
        return Err(ExtensionRuntimeError::OutputInvalid);
    }
    Ok(())
}

pub fn validate_migrated_metadata(
    metadata_json: &str,
    package: &ValidatedExtensionPackage,
) -> Result<(), ExtensionRuntimeError> {
    if metadata_json.len() > 4 * 1024 * 1024
        || serde_json::from_str::<Value>(metadata_json)
            .ok()
            .is_none_or(|value| {
                !extension_metadata_matches_schema(&package.metadata_schema, &value)
            })
    {
        return Err(ExtensionRuntimeError::OutputInvalid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use linked_info_extension_contracts::NodeHandle;

    use super::*;

    #[test]
    fn direct_handles_allow_a_mutual_reference_but_reject_duplicates() {
        let mut snapshot = NodeSnapshotV1 {
            handle: NodeHandle(1),
            name: None,
            content: None,
            direct_outgoing: vec![NodeHandle(2)],
            direct_incoming: vec![NodeHandle(2)],
        };
        assert!(valid_handles(&snapshot));

        snapshot.direct_outgoing.push(NodeHandle(2));
        assert!(!valid_handles(&snapshot));
    }
}
