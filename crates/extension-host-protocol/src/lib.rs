use linked_info_extension_contracts::{
    ExtensionActionRequestV1, ExtensionActionResultV1, ExtensionMetadataMigrationRequestV1,
    ExtensionPresentationV1, ExtensionRenderRequestV1,
};
use serde::{Deserialize, Serialize};

pub const EXTENSION_HOST_PROTOCOL_VERSION: u32 = 1;
pub const MAXIMUM_EXTENSION_HOST_REQUEST_BYTES: usize = 72 * 1024 * 1024;
pub const MAXIMUM_EXTENSION_HOST_RESPONSE_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ExtensionHostRequestV1 {
    Hello {
        protocol_version: u32,
    },
    Render {
        request_id: u64,
        generation: u64,
        request: ExtensionRenderRequestV1,
    },
    Invoke {
        request_id: u64,
        generation: u64,
        request: ExtensionActionRequestV1,
    },
    MigrateMetadata {
        request_id: u64,
        generation: u64,
        request: ExtensionMetadataMigrationRequestV1,
    },
    Revoke {
        generation: u64,
    },
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionHostErrorCode {
    ProtocolInvalid,
    GenerationRevoked,
    RequestInvalid,
    PackageInvalid,
    ComponentInvalid,
    ComponentTrap,
    ResourceLimit,
    DeadlineExceeded,
    OutputInvalid,
    GuestRejected,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ExtensionHostResponseV1 {
    Ready {
        protocol_version: u32,
        extension_id: String,
        generation: u64,
    },
    Rendered {
        request_id: u64,
        generation: u64,
        presentation: ExtensionPresentationV1,
    },
    Invoked {
        request_id: u64,
        generation: u64,
        result: ExtensionActionResultV1,
    },
    MetadataMigrated {
        request_id: u64,
        generation: u64,
        metadata_json: String,
    },
    Revoked {
        generation: u64,
    },
    ShuttingDown,
    Error {
        request_id: Option<u64>,
        generation: u64,
        code: ExtensionHostErrorCode,
    },
}

impl ExtensionHostRequestV1 {
    pub const fn request_id(&self) -> Option<u64> {
        match self {
            Self::Render { request_id, .. }
            | Self::Invoke { request_id, .. }
            | Self::MigrateMetadata { request_id, .. } => Some(*request_id),
            Self::Hello { .. } | Self::Revoke { .. } | Self::Shutdown => None,
        }
    }

    pub const fn generation(&self) -> Option<u64> {
        match self {
            Self::Render { generation, .. }
            | Self::Invoke { generation, .. }
            | Self::MigrateMetadata { generation, .. }
            | Self::Revoke { generation } => Some(*generation),
            Self::Hello { .. } | Self::Shutdown => None,
        }
    }
}

impl ExtensionHostResponseV1 {
    pub const fn request_id(&self) -> Option<u64> {
        match self {
            Self::Rendered { request_id, .. }
            | Self::Invoked { request_id, .. }
            | Self::MetadataMigrated { request_id, .. } => Some(*request_id),
            Self::Error { request_id, .. } => *request_id,
            Self::Ready { .. } | Self::Revoked { .. } | Self::ShuttingDown => None,
        }
    }

    pub const fn generation(&self) -> Option<u64> {
        match self {
            Self::Ready { generation, .. }
            | Self::Rendered { generation, .. }
            | Self::Invoked { generation, .. }
            | Self::MetadataMigrated { generation, .. }
            | Self::Revoked { generation }
            | Self::Error { generation, .. } => Some(*generation),
            Self::ShuttingDown => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use linked_info_extension_contracts::{ExtensionRenderRequestV1, NodeHandle, NodeSnapshotV1};

    use super::*;

    #[test]
    fn request_envelope_rejects_unknown_fields_and_keeps_large_ids_exact() {
        let request = ExtensionHostRequestV1::Render {
            request_id: u64::MAX,
            generation: 7,
            request: ExtensionRenderRequestV1 {
                processor_id: "inspect".to_owned(),
                node: NodeSnapshotV1 {
                    handle: NodeHandle(1),
                    name: None,
                    content: Some("{}".to_owned()),
                    direct_outgoing: Vec::new(),
                    direct_incoming: Vec::new(),
                },
                node_metadata_json: None,
                workspace_metadata_json: None,
                monotonic_time_ms: None,
            },
        };
        let encoded = serde_json::to_string(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<ExtensionHostRequestV1>(&encoded).unwrap(),
            request
        );
        assert!(
            serde_json::from_str::<ExtensionHostRequestV1>(
                r#"{"type":"shutdown","unexpected":true}"#
            )
            .is_err()
        );
    }
}
