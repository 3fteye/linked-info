mod runtime;
mod validation;
mod value;

pub use runtime::{ExtensionRuntime, RuntimeLimits};

use linked_info_extension_host_protocol::ExtensionHostErrorCode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtensionRuntimeError {
    GenerationRevoked,
    RequestInvalid,
    ComponentInvalid,
    ComponentCompileInvalid,
    ComponentRuntimeImportForbidden,
    ComponentGuestExportMissing,
    ComponentFunctionExportMissing,
    ComponentTrap,
    ResourceLimit,
    DeadlineExceeded,
    OutputInvalid,
    GuestRejected,
    Internal,
}

impl ExtensionRuntimeError {
    pub const fn code(self) -> ExtensionHostErrorCode {
        match self {
            Self::GenerationRevoked => ExtensionHostErrorCode::GenerationRevoked,
            Self::RequestInvalid => ExtensionHostErrorCode::RequestInvalid,
            Self::ComponentInvalid
            | Self::ComponentCompileInvalid
            | Self::ComponentRuntimeImportForbidden
            | Self::ComponentGuestExportMissing
            | Self::ComponentFunctionExportMissing => ExtensionHostErrorCode::ComponentInvalid,
            Self::ComponentTrap => ExtensionHostErrorCode::ComponentTrap,
            Self::ResourceLimit => ExtensionHostErrorCode::ResourceLimit,
            Self::DeadlineExceeded => ExtensionHostErrorCode::DeadlineExceeded,
            Self::OutputInvalid => ExtensionHostErrorCode::OutputInvalid,
            Self::GuestRejected => ExtensionHostErrorCode::GuestRejected,
            Self::Internal => ExtensionHostErrorCode::Internal,
        }
    }
}
