use std::collections::BTreeMap;

use linked_info_extension_contracts::{
    BadgeTone, ChangeOperation, ChangeProposalV1, ExtensionActionRequestV1,
    ExtensionActionResultV1, ExtensionMetadataMigrationRequestV1, ExtensionPresentationV1,
    ExtensionRenderRequestV1, KeyValueItem, NodeSnapshotV1, PresentationElement, ProposalEndpoint,
    SelectOption, StringPatch,
};
use serde_json::Value;
use wasmtime::component::Val;

use crate::ExtensionRuntimeError;

fn option_string(value: &Option<String>) -> Val {
    Val::Option(
        value
            .as_ref()
            .map(|value| Box::new(Val::String(value.clone()))),
    )
}

fn option_u64(value: Option<u64>) -> Val {
    Val::Option(value.map(|value| Box::new(Val::U64(value))))
}

fn snapshot(snapshot: &NodeSnapshotV1) -> Val {
    Val::Record(vec![
        ("handle".to_owned(), Val::U64(snapshot.handle.0)),
        ("name".to_owned(), option_string(&snapshot.name)),
        ("content".to_owned(), option_string(&snapshot.content)),
        (
            "direct-outgoing".to_owned(),
            Val::List(
                snapshot
                    .direct_outgoing
                    .iter()
                    .map(|handle| Val::U64(handle.0))
                    .collect(),
            ),
        ),
        (
            "direct-incoming".to_owned(),
            Val::List(
                snapshot
                    .direct_incoming
                    .iter()
                    .map(|handle| Val::U64(handle.0))
                    .collect(),
            ),
        ),
    ])
}

pub fn render_request(request: &ExtensionRenderRequestV1) -> Val {
    Val::Record(vec![
        (
            "processor-id".to_owned(),
            Val::String(request.processor_id.clone()),
        ),
        ("node".to_owned(), snapshot(&request.node)),
        (
            "node-metadata-json".to_owned(),
            option_string(&request.node_metadata_json),
        ),
        (
            "workspace-metadata-json".to_owned(),
            option_string(&request.workspace_metadata_json),
        ),
        (
            "monotonic-time-ms".to_owned(),
            option_u64(request.monotonic_time_ms),
        ),
    ])
}

pub fn action_request(request: &ExtensionActionRequestV1) -> Val {
    Val::Record(vec![
        (
            "action-id".to_owned(),
            Val::String(request.action_id.clone()),
        ),
        (
            "nodes".to_owned(),
            Val::List(request.nodes.iter().map(snapshot).collect()),
        ),
        (
            "node-metadata-json".to_owned(),
            option_string(&request.node_metadata_json),
        ),
        (
            "workspace-metadata-json".to_owned(),
            option_string(&request.workspace_metadata_json),
        ),
        (
            "input-value".to_owned(),
            option_string(&request.input_value),
        ),
        (
            "monotonic-time-ms".to_owned(),
            option_u64(request.monotonic_time_ms),
        ),
        ("base-revision".to_owned(), Val::U64(request.base_revision)),
    ])
}

pub fn migration_request(request: &ExtensionMetadataMigrationRequestV1) -> Val {
    Val::Record(vec![
        ("from-version".to_owned(), Val::U32(request.from_version)),
        ("to-version".to_owned(), Val::U32(request.to_version)),
        (
            "metadata-json".to_owned(),
            Val::String(request.metadata_json.clone()),
        ),
    ])
}

fn record(value: Val) -> Result<BTreeMap<String, Val>, ExtensionRuntimeError> {
    let Val::Record(fields) = value else {
        return Err(ExtensionRuntimeError::OutputInvalid);
    };
    let mut result = BTreeMap::new();
    for (name, value) in fields {
        if result.insert(name, value).is_some() {
            return Err(ExtensionRuntimeError::OutputInvalid);
        }
    }
    Ok(result)
}

fn field(fields: &mut BTreeMap<String, Val>, name: &str) -> Result<Val, ExtensionRuntimeError> {
    fields
        .remove(name)
        .ok_or(ExtensionRuntimeError::OutputInvalid)
}

fn finish(fields: BTreeMap<String, Val>) -> Result<(), ExtensionRuntimeError> {
    fields
        .is_empty()
        .then_some(())
        .ok_or(ExtensionRuntimeError::OutputInvalid)
}

fn string(value: Val) -> Result<String, ExtensionRuntimeError> {
    match value {
        Val::String(value) => Ok(value),
        _ => Err(ExtensionRuntimeError::OutputInvalid),
    }
}

fn u64_value(value: Val) -> Result<u64, ExtensionRuntimeError> {
    match value {
        Val::U64(value) => Ok(value),
        _ => Err(ExtensionRuntimeError::OutputInvalid),
    }
}

fn list(value: Val) -> Result<Vec<Val>, ExtensionRuntimeError> {
    match value {
        Val::List(value) => Ok(value),
        _ => Err(ExtensionRuntimeError::OutputInvalid),
    }
}

fn optional(value: Val) -> Result<Option<Val>, ExtensionRuntimeError> {
    match value {
        Val::Option(value) => Ok(value.map(|value| *value)),
        _ => Err(ExtensionRuntimeError::OutputInvalid),
    }
}

fn guest_result(value: Val) -> Result<Val, ExtensionRuntimeError> {
    match value {
        Val::Result(Ok(Some(value))) => Ok(*value),
        Val::Result(Err(Some(value))) if matches!(*value, Val::String(_)) => {
            Err(ExtensionRuntimeError::GuestRejected)
        }
        _ => Err(ExtensionRuntimeError::OutputInvalid),
    }
}

fn strings(value: Val) -> Result<Vec<String>, ExtensionRuntimeError> {
    list(value)?
        .into_iter()
        .map(string)
        .collect::<Result<Vec<_>, _>>()
}

fn key_value_item(value: Val) -> Result<KeyValueItem, ExtensionRuntimeError> {
    let mut fields = record(value)?;
    let result = KeyValueItem {
        key: string(field(&mut fields, "key")?)?,
        value: string(field(&mut fields, "value")?)?,
    };
    finish(fields)?;
    Ok(result)
}

fn select_option(value: Val) -> Result<SelectOption, ExtensionRuntimeError> {
    let mut fields = record(value)?;
    let result = SelectOption {
        value: string(field(&mut fields, "value")?)?,
        label_key: string(field(&mut fields, "label-key")?)?,
    };
    finish(fields)?;
    Ok(result)
}

fn presentation_element(value: Val) -> Result<PresentationElement, ExtensionRuntimeError> {
    let Val::Variant(case, payload) = value else {
        return Err(ExtensionRuntimeError::OutputInvalid);
    };
    let payload = payload.map(|value| *value);
    match case.as_str() {
        "text" => {
            let mut fields = record(payload.ok_or(ExtensionRuntimeError::OutputInvalid)?)?;
            let result = PresentationElement::Text {
                text: string(field(&mut fields, "text")?)?,
            };
            finish(fields)?;
            Ok(result)
        }
        "code" => {
            let mut fields = record(payload.ok_or(ExtensionRuntimeError::OutputInvalid)?)?;
            let result = PresentationElement::Code {
                language: string(field(&mut fields, "language")?)?,
                source: string(field(&mut fields, "source")?)?,
            };
            finish(fields)?;
            Ok(result)
        }
        "key-value" => {
            let mut fields = record(payload.ok_or(ExtensionRuntimeError::OutputInvalid)?)?;
            let items = list(field(&mut fields, "items")?)?
                .into_iter()
                .map(key_value_item)
                .collect::<Result<Vec<_>, _>>()?;
            finish(fields)?;
            Ok(PresentationElement::KeyValue { items })
        }
        "table" => {
            let mut fields = record(payload.ok_or(ExtensionRuntimeError::OutputInvalid)?)?;
            let columns = strings(field(&mut fields, "columns")?)?;
            let rows = list(field(&mut fields, "rows")?)?
                .into_iter()
                .map(strings)
                .collect::<Result<Vec<_>, _>>()?;
            finish(fields)?;
            Ok(PresentationElement::Table { columns, rows })
        }
        "badge" => {
            let mut fields = record(payload.ok_or(ExtensionRuntimeError::OutputInvalid)?)?;
            let text = string(field(&mut fields, "text")?)?;
            let tone = match field(&mut fields, "tone")? {
                Val::Enum(tone) if tone == "neutral" => BadgeTone::Neutral,
                Val::Enum(tone) if tone == "positive" => BadgeTone::Positive,
                Val::Enum(tone) if tone == "warning" => BadgeTone::Warning,
                Val::Enum(tone) if tone == "critical" => BadgeTone::Critical,
                _ => return Err(ExtensionRuntimeError::OutputInvalid),
            };
            finish(fields)?;
            Ok(PresentationElement::Badge { text, tone })
        }
        "divider" if payload.is_none() => Ok(PresentationElement::Divider),
        "button" => {
            let mut fields = record(payload.ok_or(ExtensionRuntimeError::OutputInvalid)?)?;
            let result = PresentationElement::Button {
                action_id: string(field(&mut fields, "action-id")?)?,
            };
            finish(fields)?;
            Ok(result)
        }
        "select" => {
            let mut fields = record(payload.ok_or(ExtensionRuntimeError::OutputInvalid)?)?;
            let action_id = string(field(&mut fields, "action-id")?)?;
            let label_key = string(field(&mut fields, "label-key")?)?;
            let selected = optional(field(&mut fields, "selected")?)?
                .map(string)
                .transpose()?;
            let options = list(field(&mut fields, "options")?)?
                .into_iter()
                .map(select_option)
                .collect::<Result<Vec<_>, _>>()?;
            finish(fields)?;
            Ok(PresentationElement::Select {
                action_id,
                label_key,
                selected,
                options,
            })
        }
        _ => Err(ExtensionRuntimeError::OutputInvalid),
    }
}

fn presentation_value(value: Val) -> Result<ExtensionPresentationV1, ExtensionRuntimeError> {
    let mut fields = record(value)?;
    let elements = list(field(&mut fields, "elements")?)?
        .into_iter()
        .map(presentation_element)
        .collect::<Result<Vec<_>, _>>()?;
    finish(fields)?;
    Ok(ExtensionPresentationV1 { elements })
}

pub fn presentation(value: Val) -> Result<ExtensionPresentationV1, ExtensionRuntimeError> {
    presentation_value(guest_result(value)?)
}

fn string_patch(value: Val) -> Result<StringPatch, ExtensionRuntimeError> {
    let Val::Variant(case, payload) = value else {
        return Err(ExtensionRuntimeError::OutputInvalid);
    };
    match (case.as_str(), payload) {
        ("unchanged", None) => Ok(StringPatch::Unchanged),
        ("set", Some(value)) => Ok(StringPatch::Set(string(*value)?)),
        _ => Err(ExtensionRuntimeError::OutputInvalid),
    }
}

fn proposal_endpoint(value: Val) -> Result<ProposalEndpoint, ExtensionRuntimeError> {
    let Val::Variant(case, payload) = value else {
        return Err(ExtensionRuntimeError::OutputInvalid);
    };
    let payload = payload.ok_or(ExtensionRuntimeError::OutputInvalid)?;
    match case.as_str() {
        "existing" => Ok(ProposalEndpoint::Existing {
            handle: linked_info_extension_contracts::NodeHandle(u64_value(*payload)?),
        }),
        "created" => Ok(ProposalEndpoint::Created {
            temporary_id: string(*payload)?,
        }),
        _ => Err(ExtensionRuntimeError::OutputInvalid),
    }
}

fn change_operation(value: Val) -> Result<ChangeOperation, ExtensionRuntimeError> {
    let Val::Variant(case, payload) = value else {
        return Err(ExtensionRuntimeError::OutputInvalid);
    };
    let mut fields = record(
        payload
            .ok_or(ExtensionRuntimeError::OutputInvalid)
            .map(|v| *v)?,
    )?;
    let result = match case.as_str() {
        "create-node" => ChangeOperation::CreateNode {
            temporary_id: string(field(&mut fields, "temporary-id")?)?,
            name: string(field(&mut fields, "name")?)?,
            content: string(field(&mut fields, "content")?)?,
        },
        "update-current-node" => ChangeOperation::UpdateCurrentNode {
            name: string_patch(field(&mut fields, "name")?)?,
            content: string_patch(field(&mut fields, "content")?)?,
        },
        "create-reference" | "remove-reference" => {
            let source = proposal_endpoint(field(&mut fields, "source")?)?;
            let target = proposal_endpoint(field(&mut fields, "target")?)?;
            if case == "create-reference" {
                ChangeOperation::CreateReference { source, target }
            } else {
                ChangeOperation::RemoveReference { source, target }
            }
        }
        _ => return Err(ExtensionRuntimeError::OutputInvalid),
    };
    finish(fields)?;
    Ok(result)
}

fn change_proposal(value: Val) -> Result<ChangeProposalV1, ExtensionRuntimeError> {
    let mut fields = record(value)?;
    let result = ChangeProposalV1 {
        base_revision: u64_value(field(&mut fields, "base-revision")?)?,
        title_key: string(field(&mut fields, "title-key")?)?,
        operations: list(field(&mut fields, "operations")?)?
            .into_iter()
            .map(change_operation)
            .collect::<Result<Vec<_>, _>>()?,
    };
    finish(fields)?;
    Ok(result)
}

fn optional_json(value: Val) -> Result<Option<Value>, ExtensionRuntimeError> {
    optional(value)?
        .map(|value| {
            string(value).and_then(|value| {
                serde_json::from_str(&value).map_err(|_| ExtensionRuntimeError::OutputInvalid)
            })
        })
        .transpose()
}

pub fn action_result(value: Val) -> Result<ExtensionActionResultV1, ExtensionRuntimeError> {
    let mut fields = record(guest_result(value)?)?;
    let result = ExtensionActionResultV1 {
        presentation: optional(field(&mut fields, "presentation")?)?
            .map(presentation_value)
            .transpose()?,
        node_metadata: optional_json(field(&mut fields, "node-metadata-json")?)?,
        workspace_metadata: optional_json(field(&mut fields, "workspace-metadata-json")?)?,
        proposal: optional(field(&mut fields, "proposal")?)?
            .map(change_proposal)
            .transpose()?,
    };
    finish(fields)?;
    Ok(result)
}

pub fn migrated_metadata(value: Val) -> Result<String, ExtensionRuntimeError> {
    string(guest_result(value)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_declarative_presentation_without_html_interpretation() {
        let value = Val::Result(Ok(Some(Box::new(Val::Record(vec![(
            "elements".to_owned(),
            Val::List(vec![Val::Variant(
                "text".to_owned(),
                Some(Box::new(Val::Record(vec![(
                    "text".to_owned(),
                    Val::String("<script>inert</script>".to_owned()),
                )]))),
            )]),
        )])))));

        assert_eq!(
            presentation(value).unwrap(),
            ExtensionPresentationV1 {
                elements: vec![PresentationElement::Text {
                    text: "<script>inert</script>".to_owned()
                }]
            }
        );
    }

    #[test]
    fn discards_guest_error_text() {
        let value = Val::Result(Err(Some(Box::new(Val::String(
            "sensitive guest details".to_owned(),
        )))));
        assert_eq!(
            presentation(value),
            Err(ExtensionRuntimeError::GuestRejected)
        );
    }
}
