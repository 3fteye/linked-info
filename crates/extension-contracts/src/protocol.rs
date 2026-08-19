use std::collections::BTreeSet;

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const EXTENSION_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const EXTENSION_API_VERSION: &str = "1.0";
pub const MAXIMUM_EXTENSION_ID_BYTES: usize = 128;
pub const MAXIMUM_CONTRIBUTION_ID_BYTES: usize = 192;
pub const MAXIMUM_LABEL_KEY_BYTES: usize = 128;
pub const MAXIMUM_MANIFEST_CAPABILITIES: usize = 9;
pub const MAXIMUM_PROCESSOR_CONTRIBUTIONS: usize = 32;
pub const MAXIMUM_ACTION_CONTRIBUTIONS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ExtensionCapability {
    #[serde(rename = "node.read.name")]
    NodeReadName,
    #[serde(rename = "node.read.content")]
    NodeReadContent,
    #[serde(rename = "graph.read.direct")]
    GraphReadDirect,
    #[serde(rename = "metadata.node.read")]
    MetadataNodeRead,
    #[serde(rename = "metadata.node.write")]
    MetadataNodeWrite,
    #[serde(rename = "metadata.workspace.read")]
    MetadataWorkspaceRead,
    #[serde(rename = "metadata.workspace.write")]
    MetadataWorkspaceWrite,
    #[serde(rename = "workspace.propose")]
    WorkspacePropose,
    #[serde(rename = "clock.monotonic")]
    ClockMonotonic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionPublisher {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessorContribution {
    pub id: String,
    pub label_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionActionScope {
    CurrentNode,
    Selection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionContribution {
    pub id: String,
    pub label_key: String,
    pub scope: ExtensionActionScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionContributions {
    pub processors: Vec<ProcessorContribution>,
    pub actions: Vec<ActionContribution>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionManifestV1 {
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub api_version: String,
    pub publisher: ExtensionPublisher,
    pub default_locale: String,
    pub locales: Vec<String>,
    pub entrypoint: String,
    pub metadata_schema: String,
    pub capabilities: Vec<ExtensionCapability>,
    pub contributions: ExtensionContributions,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ManifestValidationError {
    #[error("unsupported extension manifest schema version")]
    UnsupportedSchemaVersion,
    #[error("extension id is invalid")]
    InvalidExtensionId,
    #[error("extension version is invalid")]
    InvalidExtensionVersion,
    #[error("extension API version is unsupported")]
    UnsupportedApiVersion,
    #[error("extension publisher is invalid")]
    InvalidPublisher,
    #[error("extension publisher key is invalid")]
    InvalidPublisherKey,
    #[error("extension locale declaration is invalid")]
    InvalidLocale,
    #[error("extension entrypoint is invalid")]
    InvalidEntrypoint,
    #[error("extension metadata schema path is invalid")]
    InvalidMetadataSchemaPath,
    #[error("extension capabilities contain a duplicate or exceed the limit")]
    InvalidCapabilities,
    #[error("extension must contribute at least one processor or action")]
    MissingContribution,
    #[error("extension contribution is invalid or duplicated")]
    InvalidContribution,
}

impl ManifestValidationError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedSchemaVersion => "extension_manifest_schema_unsupported",
            Self::InvalidExtensionId => "extension_manifest_id_invalid",
            Self::InvalidExtensionVersion => "extension_manifest_version_invalid",
            Self::UnsupportedApiVersion => "extension_manifest_api_unsupported",
            Self::InvalidPublisher => "extension_manifest_publisher_invalid",
            Self::InvalidPublisherKey => "extension_manifest_publisher_key_invalid",
            Self::InvalidLocale => "extension_manifest_locale_invalid",
            Self::InvalidEntrypoint => "extension_manifest_entrypoint_invalid",
            Self::InvalidMetadataSchemaPath => "extension_manifest_metadata_schema_invalid",
            Self::InvalidCapabilities => "extension_manifest_capabilities_invalid",
            Self::MissingContribution => "extension_manifest_contribution_missing",
            Self::InvalidContribution => "extension_manifest_contribution_invalid",
        }
    }
}

pub fn validate_extension_manifest(
    manifest: &ExtensionManifestV1,
) -> Result<(), ManifestValidationError> {
    if manifest.schema_version != EXTENSION_MANIFEST_SCHEMA_VERSION {
        return Err(ManifestValidationError::UnsupportedSchemaVersion);
    }
    if !valid_extension_id(&manifest.id) {
        return Err(ManifestValidationError::InvalidExtensionId);
    }
    if manifest.version.len() > 64 || Version::parse(&manifest.version).is_err() {
        return Err(ManifestValidationError::InvalidExtensionVersion);
    }
    if manifest.api_version != EXTENSION_API_VERSION {
        return Err(ManifestValidationError::UnsupportedApiVersion);
    }
    let publisher_name = manifest.publisher.name.trim();
    if publisher_name.is_empty() || publisher_name.chars().count() > 128 {
        return Err(ManifestValidationError::InvalidPublisher);
    }
    if manifest
        .publisher
        .public_key
        .as_deref()
        .is_some_and(|key| !valid_lower_hex(key, 64))
    {
        return Err(ManifestValidationError::InvalidPublisherKey);
    }
    if manifest.locales.is_empty() || manifest.locales.len() > 32 {
        return Err(ManifestValidationError::InvalidLocale);
    }
    let locales = manifest.locales.iter().collect::<BTreeSet<_>>();
    if locales.len() != manifest.locales.len()
        || !manifest.locales.iter().all(|locale| valid_locale(locale))
        || !locales.contains(&manifest.default_locale)
    {
        return Err(ManifestValidationError::InvalidLocale);
    }
    if manifest.entrypoint != "extension.wasm" {
        return Err(ManifestValidationError::InvalidEntrypoint);
    }
    if manifest.metadata_schema != "metadata.schema.json" {
        return Err(ManifestValidationError::InvalidMetadataSchemaPath);
    }
    if manifest.capabilities.len() > MAXIMUM_MANIFEST_CAPABILITIES
        || manifest.capabilities.iter().collect::<BTreeSet<_>>().len()
            != manifest.capabilities.len()
    {
        return Err(ManifestValidationError::InvalidCapabilities);
    }
    if manifest.contributions.processors.is_empty() && manifest.contributions.actions.is_empty() {
        return Err(ManifestValidationError::MissingContribution);
    }
    if manifest.contributions.processors.len() > MAXIMUM_PROCESSOR_CONTRIBUTIONS
        || manifest.contributions.actions.len() > MAXIMUM_ACTION_CONTRIBUTIONS
    {
        return Err(ManifestValidationError::InvalidContribution);
    }
    let mut contribution_ids = BTreeSet::new();
    for processor in &manifest.contributions.processors {
        if !valid_contribution_id(&manifest.id, &processor.id)
            || !valid_label_key(&processor.label_key)
            || !contribution_ids.insert(&processor.id)
        {
            return Err(ManifestValidationError::InvalidContribution);
        }
    }
    for action in &manifest.contributions.actions {
        if !valid_contribution_id(&manifest.id, &action.id)
            || !valid_label_key(&action.label_key)
            || !contribution_ids.insert(&action.id)
        {
            return Err(ManifestValidationError::InvalidContribution);
        }
    }
    Ok(())
}

fn valid_extension_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAXIMUM_EXTENSION_ID_BYTES || !id.is_ascii() {
        return false;
    }
    let segments = id.split('.').collect::<Vec<_>>();
    segments.len() >= 3 && segments.into_iter().all(valid_identifier_segment)
}

fn valid_identifier_segment(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_lowercase)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn valid_contribution_id(extension_id: &str, id: &str) -> bool {
    if id.len() > MAXIMUM_CONTRIBUTION_ID_BYTES {
        return false;
    }
    let Some(suffix) = id
        .strip_prefix(extension_id)
        .and_then(|value| value.strip_prefix('.'))
    else {
        return false;
    };
    !suffix.is_empty() && suffix.split('.').all(valid_identifier_segment)
}

fn valid_label_key(value: &str) -> bool {
    if value.is_empty() || value.len() > MAXIMUM_LABEL_KEY_BYTES || !value.is_ascii() {
        return false;
    }
    let bytes = value.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_lowercase)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'-' | b'_'))
        && !value.contains("..")
}

fn valid_locale(locale: &str) -> bool {
    if locale.len() < 2 || locale.len() > 35 || !locale.is_ascii() {
        return false;
    }
    let mut segments = locale.split('-');
    let Some(language) = segments.next() else {
        return false;
    };
    (2..=8).contains(&language.len())
        && language.bytes().all(|byte| byte.is_ascii_alphabetic())
        && segments.all(|segment| {
            !segment.is_empty()
                && segment.len() <= 8
                && segment.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

pub(crate) fn valid_lower_hex(value: &str, expected_length: usize) -> bool {
    value.len() == expected_length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeHandle(pub u64);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeSnapshotV1 {
    pub handle: NodeHandle,
    pub name: Option<String>,
    pub content: Option<String>,
    pub direct_outgoing: Vec<NodeHandle>,
    pub direct_incoming: Vec<NodeHandle>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PresentationElement {
    Text {
        text: String,
    },
    Code {
        language: String,
        source: String,
    },
    KeyValue {
        items: Vec<KeyValueItem>,
    },
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    Badge {
        text: String,
        tone: BadgeTone,
    },
    Divider,
    Button {
        action_id: String,
        label: String,
    },
    Select {
        action_id: String,
        label: String,
        selected: Option<String>,
        options: Vec<SelectOption>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyValueItem {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BadgeTone {
    Neutral,
    Positive,
    Warning,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionPresentationV1 {
    pub elements: Vec<PresentationElement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ProposalEndpoint {
    Existing { handle: NodeHandle },
    Created { temporary_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ChangeOperation {
    CreateNode {
        temporary_id: String,
        name: Option<String>,
        content: Option<String>,
    },
    UpdateCurrentNode {
        name: Option<String>,
        content: Option<String>,
    },
    CreateReference {
        source: ProposalEndpoint,
        target: ProposalEndpoint,
    },
    RemoveReference {
        source: ProposalEndpoint,
        target: ProposalEndpoint,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeProposalV1 {
    pub base_revision: u64,
    pub title: String,
    pub operations: Vec<ChangeOperation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionActionResultV1 {
    pub presentation: Option<ExtensionPresentationV1>,
    pub node_metadata: Option<Value>,
    pub workspace_metadata: Option<Value>,
    pub proposal: Option<ChangeProposalV1>,
}

#[cfg(test)]
mod tests {
    use regex::Regex;

    use super::*;

    fn manifest() -> ExtensionManifestV1 {
        ExtensionManifestV1 {
            schema_version: 1,
            id: "dev.example.json-tools".to_owned(),
            version: "1.2.3".to_owned(),
            api_version: "1.0".to_owned(),
            publisher: ExtensionPublisher {
                name: "Example".to_owned(),
                public_key: Some("a".repeat(64)),
            },
            default_locale: "en".to_owned(),
            locales: vec!["en".to_owned(), "zh-CN".to_owned()],
            entrypoint: "extension.wasm".to_owned(),
            metadata_schema: "metadata.schema.json".to_owned(),
            capabilities: vec![
                ExtensionCapability::NodeReadContent,
                ExtensionCapability::MetadataNodeWrite,
            ],
            contributions: ExtensionContributions {
                processors: vec![ProcessorContribution {
                    id: "dev.example.json-tools.processor".to_owned(),
                    label_key: "processor.label".to_owned(),
                }],
                actions: Vec::new(),
            },
        }
    }

    #[test]
    fn accepts_a_namespaced_manifest() {
        assert_eq!(validate_extension_manifest(&manifest()), Ok(()));
    }

    #[test]
    fn rejects_non_namespaced_contributions() {
        let mut invalid = manifest();
        invalid.contributions.processors[0].id = "processor".to_owned();

        assert_eq!(
            validate_extension_manifest(&invalid),
            Err(ManifestValidationError::InvalidContribution)
        );
    }

    #[test]
    fn rejects_duplicate_capabilities() {
        let mut invalid = manifest();
        invalid
            .capabilities
            .push(ExtensionCapability::NodeReadContent);

        assert_eq!(
            validate_extension_manifest(&invalid),
            Err(ManifestValidationError::InvalidCapabilities)
        );
    }

    #[test]
    fn rejects_unknown_manifest_fields_during_deserialization() {
        let mut value = serde_json::to_value(manifest()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("networkAccess".to_owned(), Value::Bool(true));

        assert!(serde_json::from_value::<ExtensionManifestV1>(value).is_err());
    }

    #[test]
    fn wit_contract_is_versioned_and_has_no_wasi_imports() {
        assert!(crate::EXTENSION_WIT.contains("package linked-info:extension@1.0.0;"));
        assert!(crate::EXTENSION_WIT.contains("world node-extension"));
        assert!(!crate::EXTENSION_WIT.contains("wasi:"));
    }

    #[test]
    fn published_manifest_schema_is_valid_json() {
        let value = serde_json::from_str::<Value>(crate::EXTENSION_MANIFEST_SCHEMA).unwrap();
        assert_eq!(value["properties"]["apiVersion"]["const"], "1.0");
    }

    #[test]
    fn published_manifest_schema_matches_semantic_versions() {
        let value = serde_json::from_str::<Value>(crate::EXTENSION_MANIFEST_SCHEMA).unwrap();
        let pattern = value["properties"]["version"]["pattern"].as_str().unwrap();
        let regex = Regex::new(pattern).unwrap();

        for version in ["0.1.0", "1.2.3", "1.0.0-alpha.1", "2.0.0+build.7"] {
            assert!(Version::parse(version).is_ok());
            assert!(regex.is_match(version));
        }
        for invalid in ["not-semver", "1.0", "01.0.0", "1.0.0-01"] {
            assert!(Version::parse(invalid).is_err());
            assert!(!regex.is_match(invalid));
        }
    }
}
