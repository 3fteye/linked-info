mod package;
mod protocol;

pub use package::{
    ExtensionPackageError, SignaturePolicy, ValidatedExtensionPackage, validate_extension_package,
};
pub use protocol::*;

pub const EXTENSION_WIT: &str = include_str!("../wit/extension.wit");
pub const EXTENSION_MANIFEST_SCHEMA: &str = include_str!("../schemas/manifest-v1.schema.json");
