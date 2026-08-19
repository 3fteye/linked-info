use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
};

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use wasmparser::Validator;
use wit_parser::Resolve;
use zip::ZipArchive;

use crate::protocol::{
    ExtensionManifestV1, ManifestValidationError, valid_lower_hex, validate_extension_manifest,
};

pub const MAXIMUM_EXTENSION_PACKAGE_BYTES: usize = 32 * 1024 * 1024;
pub const MAXIMUM_EXTENSION_WASM_BYTES: u64 = 16 * 1024 * 1024;
pub const MAXIMUM_EXTENSION_MANIFEST_BYTES: u64 = 256 * 1024;
pub const MAXIMUM_EXTENSION_SCHEMA_BYTES: u64 = 256 * 1024;
pub const MAXIMUM_EXTENSION_LOCALE_BYTES: u64 = 256 * 1024;
pub const MAXIMUM_EXTENSION_ARCHIVE_ENTRIES: usize = 256;
pub const MAXIMUM_EXTENSION_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;

const MANIFEST_PATH: &str = "manifest.json";
const ENTRYPOINT_PATH: &str = "extension.wasm";
const METADATA_SCHEMA_PATH: &str = "metadata.schema.json";
const CHECKSUMS_PATH: &str = "checksums.json";
const SIGNATURE_PATH: &str = "signature.ed25519";
const WASM_COMPONENT_HEADER: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignaturePolicy {
    RequireSigned,
    AllowUnsignedDevelopment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedExtensionPackage {
    pub manifest: ExtensionManifestV1,
    pub package_sha256: String,
    pub publisher_fingerprint: Option<String>,
    pub signed: bool,
    pub file_count: usize,
    pub uncompressed_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ExtensionPackageError {
    #[error("extension package exceeds the compressed size limit")]
    PackageTooLarge,
    #[error("extension package is not a readable ZIP archive")]
    InvalidArchive,
    #[error("extension package contains too many entries")]
    TooManyEntries,
    #[error("extension package contains an invalid path: {0}")]
    InvalidEntryPath(String),
    #[error("extension package contains a duplicate entry: {0}")]
    DuplicateEntry(String),
    #[error("extension package entry exceeds its size limit: {0}")]
    EntryTooLarge(String),
    #[error("extension package exceeds the uncompressed size limit")]
    UncompressedPackageTooLarge,
    #[error("extension package is missing a required entry: {0}")]
    MissingEntry(&'static str),
    #[error("extension package contains an unexpected entry: {0}")]
    UnexpectedEntry(String),
    #[error("extension manifest JSON is invalid")]
    InvalidManifestJson,
    #[error(transparent)]
    InvalidManifest(#[from] ManifestValidationError),
    #[error("extension locale is invalid: {0}")]
    InvalidLocale(String),
    #[error("extension locale is missing a label: {0}")]
    MissingLocaleLabel(String),
    #[error("extension metadata schema is invalid")]
    InvalidMetadataSchema,
    #[error("extension metadata schema attempts to persist a hidden relationship")]
    HiddenRelationshipMetadata,
    #[error("extension checksum manifest is invalid")]
    InvalidChecksumManifest,
    #[error("extension checksum list is not canonical")]
    NonCanonicalChecksumList,
    #[error("extension file size differs from its checksum record: {0}")]
    ChecksumSizeMismatch(String),
    #[error("extension file hash differs from its checksum record: {0}")]
    ChecksumMismatch(String),
    #[error("extension entrypoint is not a WebAssembly component")]
    InvalidWasmComponent,
    #[error("extension signature is required")]
    MissingSignature,
    #[error("extension publisher key is invalid")]
    InvalidPublisherKey,
    #[error("extension signature is invalid")]
    InvalidSignature,
}

impl ExtensionPackageError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::PackageTooLarge => "extension_package_too_large",
            Self::InvalidArchive => "extension_package_archive_invalid",
            Self::TooManyEntries => "extension_package_entry_count_invalid",
            Self::InvalidEntryPath(_) => "extension_package_path_invalid",
            Self::DuplicateEntry(_) => "extension_package_entry_duplicate",
            Self::EntryTooLarge(_) => "extension_package_entry_too_large",
            Self::UncompressedPackageTooLarge => "extension_package_uncompressed_too_large",
            Self::MissingEntry(_) => "extension_package_entry_missing",
            Self::UnexpectedEntry(_) => "extension_package_entry_unexpected",
            Self::InvalidManifestJson => "extension_package_manifest_json_invalid",
            Self::InvalidManifest(error) => error.code(),
            Self::InvalidLocale(_) => "extension_package_locale_invalid",
            Self::MissingLocaleLabel(_) => "extension_package_locale_label_missing",
            Self::InvalidMetadataSchema => "extension_package_metadata_schema_invalid",
            Self::HiddenRelationshipMetadata => "extension_package_metadata_hidden_relationship",
            Self::InvalidChecksumManifest => "extension_package_checksums_invalid",
            Self::NonCanonicalChecksumList => "extension_package_checksums_noncanonical",
            Self::ChecksumSizeMismatch(_) => "extension_package_checksum_size_mismatch",
            Self::ChecksumMismatch(_) => "extension_package_checksum_mismatch",
            Self::InvalidWasmComponent => "extension_package_wasm_component_invalid",
            Self::MissingSignature => "extension_package_signature_missing",
            Self::InvalidPublisherKey => "extension_package_publisher_key_invalid",
            Self::InvalidSignature => "extension_package_signature_invalid",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChecksumManifestV1 {
    schema_version: u32,
    files: Vec<ChecksumFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChecksumFile {
    path: String,
    size_bytes: u64,
    sha256: String,
}

pub fn validate_extension_package(
    package: &[u8],
    signature_policy: SignaturePolicy,
) -> Result<ValidatedExtensionPackage, ExtensionPackageError> {
    if package.len() > MAXIMUM_EXTENSION_PACKAGE_BYTES {
        return Err(ExtensionPackageError::PackageTooLarge);
    }
    let package_sha256 = sha256_hex(package);
    let mut archive =
        ZipArchive::new(Cursor::new(package)).map_err(|_| ExtensionPackageError::InvalidArchive)?;
    if archive.len() > MAXIMUM_EXTENSION_ARCHIVE_ENTRIES {
        return Err(ExtensionPackageError::TooManyEntries);
    }

    let mut files = BTreeMap::<String, Vec<u8>>::new();
    let mut uncompressed_bytes = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| ExtensionPackageError::InvalidArchive)?;
        let path = entry.name().to_owned();
        validate_entry_path(&path)?;
        if entry.is_dir()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(ExtensionPackageError::InvalidEntryPath(path));
        }
        let entry_limit = entry_size_limit(&path);
        let declared_size = entry.size();
        if declared_size > entry_limit {
            return Err(ExtensionPackageError::EntryTooLarge(path));
        }
        let capacity = usize::try_from(declared_size)
            .map_err(|_| ExtensionPackageError::EntryTooLarge(path.clone()))?;
        let mut contents = Vec::with_capacity(capacity);
        entry
            .take(entry_limit + 1)
            .read_to_end(&mut contents)
            .map_err(|_| ExtensionPackageError::InvalidArchive)?;
        if contents.len() as u64 > entry_limit {
            return Err(ExtensionPackageError::EntryTooLarge(path));
        }
        if contents.len() as u64 != declared_size {
            return Err(ExtensionPackageError::InvalidArchive);
        }
        uncompressed_bytes = uncompressed_bytes
            .checked_add(contents.len() as u64)
            .ok_or(ExtensionPackageError::UncompressedPackageTooLarge)?;
        if uncompressed_bytes > MAXIMUM_EXTENSION_UNCOMPRESSED_BYTES {
            return Err(ExtensionPackageError::UncompressedPackageTooLarge);
        }
        if files.insert(path.clone(), contents).is_some() {
            return Err(ExtensionPackageError::DuplicateEntry(path));
        }
    }

    let manifest_bytes = required_file(&files, MANIFEST_PATH)?;
    let manifest = serde_json::from_slice::<ExtensionManifestV1>(manifest_bytes)
        .map_err(|_| ExtensionPackageError::InvalidManifestJson)?;
    validate_extension_manifest(&manifest)?;
    validate_declared_files(&files, &manifest)?;
    validate_locales(&files, &manifest)?;

    let metadata_schema = required_file(&files, METADATA_SCHEMA_PATH)?;
    validate_metadata_schema(metadata_schema)?;

    let checksums_bytes = required_file(&files, CHECKSUMS_PATH)?;
    validate_checksums(&files, checksums_bytes)?;

    let wasm = required_file(&files, ENTRYPOINT_PATH)?;
    if !wasm.starts_with(&WASM_COMPONENT_HEADER)
        || Validator::new().validate_all(wasm).is_err()
        || !component_targets_extension_world(wasm)
    {
        return Err(ExtensionPackageError::InvalidWasmComponent);
    }

    let (signed, publisher_fingerprint) =
        validate_signature(&files, &manifest, checksums_bytes, signature_policy)?;

    Ok(ValidatedExtensionPackage {
        manifest,
        package_sha256,
        publisher_fingerprint,
        signed,
        file_count: files.len(),
        uncompressed_bytes,
    })
}

fn component_targets_extension_world(component: &[u8]) -> bool {
    let mut resolve = Resolve::new();
    let Ok(package) = resolve.push_str("linked-info-extension.wit", crate::EXTENSION_WIT) else {
        return false;
    };
    let Ok(world) = resolve.select_world(&[package], Some("node-extension")) else {
        return false;
    };
    wit_component::targets(&resolve, world, component).is_ok()
}

fn required_file<'a>(
    files: &'a BTreeMap<String, Vec<u8>>,
    path: &'static str,
) -> Result<&'a [u8], ExtensionPackageError> {
    files
        .get(path)
        .map(Vec::as_slice)
        .ok_or(ExtensionPackageError::MissingEntry(path))
}

fn validate_entry_path(path: &str) -> Result<(), ExtensionPackageError> {
    if path.is_empty()
        || path.len() > 240
        || !path.is_ascii()
        || path.starts_with('/')
        || path.ends_with('/')
        || path
            .chars()
            .any(|character| matches!(character, '\\' | ':' | '\0'))
        || path
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(ExtensionPackageError::InvalidEntryPath(path.to_owned()));
    }
    Ok(())
}

fn entry_size_limit(path: &str) -> u64 {
    match path {
        ENTRYPOINT_PATH => MAXIMUM_EXTENSION_WASM_BYTES,
        MANIFEST_PATH | CHECKSUMS_PATH => MAXIMUM_EXTENSION_MANIFEST_BYTES,
        METADATA_SCHEMA_PATH => MAXIMUM_EXTENSION_SCHEMA_BYTES,
        SIGNATURE_PATH => 64,
        _ if path.starts_with("locales/") => MAXIMUM_EXTENSION_LOCALE_BYTES,
        _ => MAXIMUM_EXTENSION_MANIFEST_BYTES,
    }
}

fn validate_declared_files(
    files: &BTreeMap<String, Vec<u8>>,
    manifest: &ExtensionManifestV1,
) -> Result<(), ExtensionPackageError> {
    let mut allowed = BTreeSet::from([
        MANIFEST_PATH.to_owned(),
        ENTRYPOINT_PATH.to_owned(),
        METADATA_SCHEMA_PATH.to_owned(),
        CHECKSUMS_PATH.to_owned(),
        SIGNATURE_PATH.to_owned(),
    ]);
    for locale in &manifest.locales {
        allowed.insert(format!("locales/{locale}.json"));
    }
    for path in files.keys() {
        if !allowed.contains(path) {
            return Err(ExtensionPackageError::UnexpectedEntry(path.clone()));
        }
    }
    for required in [MANIFEST_PATH, ENTRYPOINT_PATH, METADATA_SCHEMA_PATH] {
        required_file(files, required)?;
    }
    for locale in &manifest.locales {
        let path = format!("locales/{locale}.json");
        if !files.contains_key(&path) {
            return Err(ExtensionPackageError::InvalidLocale(locale.clone()));
        }
    }
    Ok(())
}

fn validate_locales(
    files: &BTreeMap<String, Vec<u8>>,
    manifest: &ExtensionManifestV1,
) -> Result<(), ExtensionPackageError> {
    let mut parsed = BTreeMap::<String, BTreeMap<String, String>>::new();
    for locale in &manifest.locales {
        let path = format!("locales/{locale}.json");
        let values = serde_json::from_slice::<BTreeMap<String, String>>(
            files
                .get(&path)
                .ok_or_else(|| ExtensionPackageError::InvalidLocale(locale.clone()))?,
        )
        .map_err(|_| ExtensionPackageError::InvalidLocale(locale.clone()))?;
        if values.is_empty()
            || values.len() > 512
            || values.iter().any(|(key, value)| {
                !valid_locale_key(key) || value.is_empty() || value.chars().count() > 4_096
            })
        {
            return Err(ExtensionPackageError::InvalidLocale(locale.clone()));
        }
        parsed.insert(locale.clone(), values);
    }
    let default_locale = parsed
        .get(&manifest.default_locale)
        .ok_or_else(|| ExtensionPackageError::InvalidLocale(manifest.default_locale.clone()))?;
    for label in manifest
        .contributions
        .processors
        .iter()
        .map(|processor| &processor.label_key)
        .chain(
            manifest
                .contributions
                .actions
                .iter()
                .map(|action| &action.label_key),
        )
    {
        if !default_locale.contains_key(label) {
            return Err(ExtensionPackageError::MissingLocaleLabel(label.clone()));
        }
    }
    Ok(())
}

fn valid_locale_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key.is_ascii()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        && !key.contains("..")
}

fn validate_metadata_schema(bytes: &[u8]) -> Result<(), ExtensionPackageError> {
    let schema = serde_json::from_slice::<Value>(bytes)
        .map_err(|_| ExtensionPackageError::InvalidMetadataSchema)?;
    let root = schema
        .as_object()
        .ok_or(ExtensionPackageError::InvalidMetadataSchema)?;
    if root.get("type").and_then(Value::as_str) != Some("object")
        || root.get("additionalProperties").and_then(Value::as_bool) != Some(false)
    {
        return Err(ExtensionPackageError::InvalidMetadataSchema);
    }
    validate_schema_node(&schema, 0)
}

fn validate_schema_node(schema: &Value, depth: usize) -> Result<(), ExtensionPackageError> {
    if depth > 16 {
        return Err(ExtensionPackageError::InvalidMetadataSchema);
    }
    let object = schema
        .as_object()
        .ok_or(ExtensionPackageError::InvalidMetadataSchema)?;
    const ALLOWED_KEYS: &[&str] = &[
        "$schema",
        "title",
        "description",
        "type",
        "properties",
        "required",
        "additionalProperties",
        "items",
        "enum",
        "const",
        "default",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
    ];
    if object
        .keys()
        .any(|key| !ALLOWED_KEYS.contains(&key.as_str()))
    {
        return Err(ExtensionPackageError::InvalidMetadataSchema);
    }
    if let Some(dialect) = object.get("$schema")
        && (depth != 0 || dialect.as_str() != Some("https://json-schema.org/draft/2020-12/schema"))
    {
        return Err(ExtensionPackageError::InvalidMetadataSchema);
    }
    let value_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or(ExtensionPackageError::InvalidMetadataSchema)?;
    if !matches!(
        value_type,
        "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
    ) {
        return Err(ExtensionPackageError::InvalidMetadataSchema);
    }
    for key in ["title", "description"] {
        if object.get(key).is_some_and(|value| {
            value
                .as_str()
                .is_none_or(|value| value.chars().count() > 4_096)
        }) {
            return Err(ExtensionPackageError::InvalidMetadataSchema);
        }
    }
    if value_type == "object" {
        if object.get("additionalProperties").and_then(Value::as_bool) != Some(false) {
            return Err(ExtensionPackageError::InvalidMetadataSchema);
        }
        let properties = object
            .get("properties")
            .and_then(Value::as_object)
            .ok_or(ExtensionPackageError::InvalidMetadataSchema)?;
        if properties.len() > 128 {
            return Err(ExtensionPackageError::InvalidMetadataSchema);
        }
        for (name, child) in properties {
            if !valid_metadata_property_name(name) {
                return Err(ExtensionPackageError::InvalidMetadataSchema);
            }
            if hidden_relationship_property(name) {
                return Err(ExtensionPackageError::HiddenRelationshipMetadata);
            }
            validate_schema_node(child, depth + 1)?;
        }
        if let Some(required) = object.get("required") {
            let required = required
                .as_array()
                .ok_or(ExtensionPackageError::InvalidMetadataSchema)?;
            let mut unique = BTreeSet::new();
            for name in required {
                let name = name
                    .as_str()
                    .ok_or(ExtensionPackageError::InvalidMetadataSchema)?;
                if !properties.contains_key(name) || !unique.insert(name) {
                    return Err(ExtensionPackageError::InvalidMetadataSchema);
                }
            }
        }
    } else if object.contains_key("properties")
        || object.contains_key("required")
        || object.contains_key("additionalProperties")
    {
        return Err(ExtensionPackageError::InvalidMetadataSchema);
    }
    if value_type == "array" {
        let items = object
            .get("items")
            .ok_or(ExtensionPackageError::InvalidMetadataSchema)?;
        validate_schema_node(items, depth + 1)?;
        let minimum = object
            .get("minItems")
            .map(|value| {
                value
                    .as_u64()
                    .ok_or(ExtensionPackageError::InvalidMetadataSchema)
            })
            .transpose()?;
        let maximum = object
            .get("maxItems")
            .and_then(Value::as_u64)
            .ok_or(ExtensionPackageError::InvalidMetadataSchema)?;
        if maximum > 1_024 || minimum.is_some_and(|minimum| minimum > maximum) {
            return Err(ExtensionPackageError::InvalidMetadataSchema);
        }
    } else if object.contains_key("items")
        || object.contains_key("minItems")
        || object.contains_key("maxItems")
    {
        return Err(ExtensionPackageError::InvalidMetadataSchema);
    }
    if value_type == "string" {
        let minimum = object
            .get("minLength")
            .map(|value| {
                value
                    .as_u64()
                    .ok_or(ExtensionPackageError::InvalidMetadataSchema)
            })
            .transpose()?;
        let maximum = object
            .get("maxLength")
            .and_then(Value::as_u64)
            .ok_or(ExtensionPackageError::InvalidMetadataSchema)?;
        if maximum > 4_096 || minimum.is_some_and(|minimum| minimum > maximum) {
            return Err(ExtensionPackageError::InvalidMetadataSchema);
        }
    } else if object.contains_key("minLength") || object.contains_key("maxLength") {
        return Err(ExtensionPackageError::InvalidMetadataSchema);
    }
    if let Some(values) = object.get("enum") {
        let values = values
            .as_array()
            .ok_or(ExtensionPackageError::InvalidMetadataSchema)?;
        if values.is_empty() || values.len() > 128 {
            return Err(ExtensionPackageError::InvalidMetadataSchema);
        }
        for (index, value) in values.iter().enumerate() {
            validate_metadata_value(value, depth + 1)?;
            if !metadata_value_matches_type(value, value_type) || values[..index].contains(value) {
                return Err(ExtensionPackageError::InvalidMetadataSchema);
            }
        }
    }
    for key in ["const", "default"] {
        if let Some(value) = object.get(key) {
            validate_metadata_value(value, depth + 1)?;
            if !metadata_value_matches_type(value, value_type) {
                return Err(ExtensionPackageError::InvalidMetadataSchema);
            }
        }
    }
    let minimum = object
        .get("minimum")
        .map(|value| {
            value
                .as_f64()
                .ok_or(ExtensionPackageError::InvalidMetadataSchema)
        })
        .transpose()?;
    let maximum = object
        .get("maximum")
        .map(|value| {
            value
                .as_f64()
                .ok_or(ExtensionPackageError::InvalidMetadataSchema)
        })
        .transpose()?;
    if (minimum.is_some() || maximum.is_some()) && !matches!(value_type, "number" | "integer") {
        return Err(ExtensionPackageError::InvalidMetadataSchema);
    }
    if let (Some(minimum), Some(maximum)) = (minimum, maximum)
        && minimum > maximum
    {
        return Err(ExtensionPackageError::InvalidMetadataSchema);
    }
    Ok(())
}

fn metadata_value_matches_type(value: &Value, value_type: &str) -> bool {
    match value_type {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => false,
    }
}

fn validate_metadata_value(value: &Value, depth: usize) -> Result<(), ExtensionPackageError> {
    if depth > 16 {
        return Err(ExtensionPackageError::InvalidMetadataSchema);
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(value) if value.chars().count() <= 4_096 => Ok(()),
        Value::Array(values) if values.len() <= 1_024 => {
            for value in values {
                validate_metadata_value(value, depth + 1)?;
            }
            Ok(())
        }
        Value::Object(values) if values.len() <= 128 => {
            for (key, value) in values {
                if !valid_metadata_property_name(key) || hidden_relationship_property(key) {
                    return Err(ExtensionPackageError::HiddenRelationshipMetadata);
                }
                validate_metadata_value(value, depth + 1)?;
            }
            Ok(())
        }
        _ => Err(ExtensionPackageError::InvalidMetadataSchema),
    }
}

fn valid_metadata_property_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.is_ascii()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn hidden_relationship_property(name: &str) -> bool {
    let normalized = name
        .bytes()
        .filter(|byte| byte.is_ascii_alphanumeric())
        .map(|byte| byte.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let normalized = String::from_utf8(normalized).expect("ASCII metadata key remains UTF-8");
    [
        "nodeid",
        "nodehandle",
        "reference",
        "sourcenode",
        "targetnode",
        "relatednode",
    ]
    .iter()
    .any(|forbidden| normalized.contains(forbidden))
}

fn validate_checksums(
    files: &BTreeMap<String, Vec<u8>>,
    checksums_bytes: &[u8],
) -> Result<(), ExtensionPackageError> {
    let checksums = serde_json::from_slice::<ChecksumManifestV1>(checksums_bytes)
        .map_err(|_| ExtensionPackageError::InvalidChecksumManifest)?;
    if checksums.schema_version != 1 {
        return Err(ExtensionPackageError::InvalidChecksumManifest);
    }
    let expected_paths = files
        .keys()
        .filter(|path| path.as_str() != CHECKSUMS_PATH && path.as_str() != SIGNATURE_PATH)
        .cloned()
        .collect::<Vec<_>>();
    let actual_paths = checksums
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    if actual_paths != expected_paths {
        return Err(ExtensionPackageError::NonCanonicalChecksumList);
    }
    for record in checksums.files {
        if !valid_lower_hex(&record.sha256, 64) {
            return Err(ExtensionPackageError::InvalidChecksumManifest);
        }
        let contents = files
            .get(&record.path)
            .ok_or(ExtensionPackageError::InvalidChecksumManifest)?;
        if record.size_bytes != contents.len() as u64 {
            return Err(ExtensionPackageError::ChecksumSizeMismatch(record.path));
        }
        if record.sha256 != sha256_hex(contents) {
            return Err(ExtensionPackageError::ChecksumMismatch(record.path));
        }
    }
    Ok(())
}

fn validate_signature(
    files: &BTreeMap<String, Vec<u8>>,
    manifest: &ExtensionManifestV1,
    checksums_bytes: &[u8],
    policy: SignaturePolicy,
) -> Result<(bool, Option<String>), ExtensionPackageError> {
    let public_key = match &manifest.publisher.public_key {
        Some(encoded) => Some(
            decode_lower_hex::<32>(encoded).ok_or(ExtensionPackageError::InvalidPublisherKey)?,
        ),
        None => None,
    };
    let publisher_fingerprint = public_key.as_ref().map(|key| sha256_hex(key));
    let verifying_key = public_key
        .map(|key| {
            let verifying_key = VerifyingKey::from_bytes(&key)
                .map_err(|_| ExtensionPackageError::InvalidPublisherKey)?;
            if verifying_key.is_weak() {
                return Err(ExtensionPackageError::InvalidPublisherKey);
            }
            Ok(verifying_key)
        })
        .transpose()?;
    let Some(signature_bytes) = files.get(SIGNATURE_PATH) else {
        return match policy {
            SignaturePolicy::RequireSigned => Err(ExtensionPackageError::MissingSignature),
            SignaturePolicy::AllowUnsignedDevelopment => Ok((false, publisher_fingerprint)),
        };
    };
    let verifying_key = verifying_key.ok_or(ExtensionPackageError::InvalidPublisherKey)?;
    let signature_bytes: [u8; 64] = signature_bytes
        .as_slice()
        .try_into()
        .map_err(|_| ExtensionPackageError::InvalidSignature)?;
    let signature = Signature::from_bytes(&signature_bytes);
    verifying_key
        .verify_strict(checksums_bytes, &signature)
        .map_err(|_| ExtensionPackageError::InvalidSignature)?;
    Ok((true, publisher_fingerprint))
}

fn decode_lower_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if !valid_lower_hex(value, N * 2) {
        return None;
    }
    let mut decoded = [0_u8; N];
    for (index, slot) in decoded.iter_mut().enumerate() {
        let high = hex_nibble(value.as_bytes()[index * 2])?;
        let low = hex_nibble(value.as_bytes()[index * 2 + 1])?;
        *slot = (high << 4) | low;
    }
    Some(decoded)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    use wit_component::{ComponentEncoder, StringEncoding, dummy_module, embed_component_metadata};
    use wit_parser::ManglingAndAbi;
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    use super::*;
    use crate::protocol::{
        ExtensionCapability, ExtensionContributions, ExtensionPublisher, ProcessorContribution,
    };

    fn manifest(signing_key: Option<&SigningKey>) -> ExtensionManifestV1 {
        ExtensionManifestV1 {
            schema_version: 1,
            id: "dev.example.json-tools".to_owned(),
            version: "1.0.0".to_owned(),
            api_version: "1.0".to_owned(),
            publisher: ExtensionPublisher {
                name: "Example".to_owned(),
                public_key: signing_key.map(|key| {
                    key.verifying_key()
                        .to_bytes()
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect()
                }),
            },
            default_locale: "en".to_owned(),
            locales: vec!["en".to_owned(), "zh-CN".to_owned()],
            entrypoint: ENTRYPOINT_PATH.to_owned(),
            metadata_schema: METADATA_SCHEMA_PATH.to_owned(),
            capabilities: vec![
                ExtensionCapability::NodeReadContent,
                ExtensionCapability::MetadataNodeRead,
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

    fn metadata_schema() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "wrapLines": { "type": "boolean", "default": false },
                "indentSize": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 8,
                    "default": 2
                },
                "theme": {
                    "type": "string",
                    "maxLength": 32,
                    "enum": ["light", "dark"]
                }
            }
        }))
        .unwrap()
    }

    fn protected_files(signing_key: Option<&SigningKey>) -> BTreeMap<String, Vec<u8>> {
        BTreeMap::from([
            (
                MANIFEST_PATH.to_owned(),
                serde_json::to_vec(&manifest(signing_key)).unwrap(),
            ),
            (ENTRYPOINT_PATH.to_owned(), valid_wasm_component()),
            (METADATA_SCHEMA_PATH.to_owned(), metadata_schema()),
            (
                "locales/en.json".to_owned(),
                serde_json::to_vec(&json!({ "processor.label": "JSON tools" })).unwrap(),
            ),
            (
                "locales/zh-CN.json".to_owned(),
                serde_json::to_vec(&json!({ "processor.label": "JSON 工具" })).unwrap(),
            ),
        ])
    }

    fn valid_wasm_component() -> Vec<u8> {
        let mut resolve = Resolve::new();
        let package = resolve
            .push_str("linked-info-extension.wit", crate::EXTENSION_WIT)
            .unwrap();
        let world = resolve
            .select_world(&[package], Some("node-extension"))
            .unwrap();
        let mut module = dummy_module(&resolve, world, ManglingAndAbi::Standard32);
        embed_component_metadata(&mut module, &resolve, world, StringEncoding::UTF8).unwrap();
        ComponentEncoder::default()
            .module(&module)
            .unwrap()
            .validate(true)
            .encode()
            .unwrap()
    }

    fn checksum_bytes(files: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
        serde_json::to_vec(&ChecksumManifestV1 {
            schema_version: 1,
            files: files
                .iter()
                .map(|(path, contents)| ChecksumFile {
                    path: path.clone(),
                    size_bytes: contents.len() as u64,
                    sha256: sha256_hex(contents),
                })
                .collect(),
        })
        .unwrap()
    }

    fn write_package(
        mut files: BTreeMap<String, Vec<u8>>,
        checksums: Vec<u8>,
        signature: Option<Vec<u8>>,
    ) -> Vec<u8> {
        files.insert(CHECKSUMS_PATH.to_owned(), checksums);
        if let Some(signature) = signature {
            files.insert(SIGNATURE_PATH.to_owned(), signature);
        }
        let cursor = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (path, contents) in files {
            writer.start_file(path, options).unwrap();
            writer.write_all(&contents).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn valid_signed_package() -> Vec<u8> {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let files = protected_files(Some(&signing_key));
        let checksums = checksum_bytes(&files);
        let signature = signing_key.sign(&checksums).to_bytes().to_vec();
        write_package(files, checksums, Some(signature))
    }

    #[test]
    fn validates_a_signed_package_without_executing_it() {
        let package = valid_signed_package();

        let validated =
            validate_extension_package(&package, SignaturePolicy::RequireSigned).unwrap();

        assert_eq!(validated.manifest.id, "dev.example.json-tools");
        assert!(validated.signed);
        assert_eq!(validated.file_count, 7);
        assert_eq!(validated.package_sha256.len(), 64);
        assert_eq!(validated.publisher_fingerprint.unwrap().len(), 64);
    }

    #[test]
    fn unsigned_packages_require_developer_policy() {
        let files = protected_files(None);
        let checksums = checksum_bytes(&files);
        let package = write_package(files, checksums, None);

        assert_eq!(
            validate_extension_package(&package, SignaturePolicy::RequireSigned),
            Err(ExtensionPackageError::MissingSignature)
        );
        assert!(
            validate_extension_package(&package, SignaturePolicy::AllowUnsignedDevelopment).is_ok()
        );
    }

    #[test]
    fn unsigned_development_packages_still_reject_weak_publisher_keys() {
        let mut files = protected_files(None);
        let mut invalid_manifest = manifest(None);
        invalid_manifest.publisher.public_key = Some("00".repeat(32));
        files.insert(
            MANIFEST_PATH.to_owned(),
            serde_json::to_vec(&invalid_manifest).unwrap(),
        );
        let checksums = checksum_bytes(&files);
        let package = write_package(files, checksums, None);

        assert_eq!(
            validate_extension_package(&package, SignaturePolicy::AllowUnsignedDevelopment),
            Err(ExtensionPackageError::InvalidPublisherKey)
        );
    }

    #[test]
    fn rejects_content_changed_after_signing() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut files = protected_files(Some(&signing_key));
        let checksums = checksum_bytes(&files);
        let signature = signing_key.sign(&checksums).to_bytes().to_vec();
        let wasm = files.get_mut(ENTRYPOINT_PATH).unwrap();
        wasm[0] ^= 0xff;
        let package = write_package(files, checksums, Some(signature));

        assert!(matches!(
            validate_extension_package(&package, SignaturePolicy::RequireSigned),
            Err(ExtensionPackageError::ChecksumMismatch(path)) if path == ENTRYPOINT_PATH
        ));
    }

    #[test]
    fn rejects_a_core_wasm_module_instead_of_a_component() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut files = protected_files(Some(&signing_key));
        files.insert(
            ENTRYPOINT_PATH.to_owned(),
            vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
        );
        let checksums = checksum_bytes(&files);
        let signature = signing_key.sign(&checksums).to_bytes().to_vec();
        let package = write_package(files, checksums, Some(signature));

        assert_eq!(
            validate_extension_package(&package, SignaturePolicy::RequireSigned),
            Err(ExtensionPackageError::InvalidWasmComponent)
        );
    }

    #[test]
    fn rejects_an_empty_component_that_does_not_implement_the_wit_world() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut files = protected_files(Some(&signing_key));
        files.insert(ENTRYPOINT_PATH.to_owned(), WASM_COMPONENT_HEADER.to_vec());
        let checksums = checksum_bytes(&files);
        let signature = signing_key.sign(&checksums).to_bytes().to_vec();
        let package = write_package(files, checksums, Some(signature));

        assert_eq!(
            validate_extension_package(&package, SignaturePolicy::RequireSigned),
            Err(ExtensionPackageError::InvalidWasmComponent)
        );
    }

    #[test]
    fn rejects_archive_path_traversal_before_reading_unknown_files() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut files = protected_files(Some(&signing_key));
        files.insert("../escape".to_owned(), b"no".to_vec());
        let checksums = checksum_bytes(&files);
        let signature = signing_key.sign(&checksums).to_bytes().to_vec();
        let package = write_package(files, checksums, Some(signature));

        assert_eq!(
            validate_extension_package(&package, SignaturePolicy::RequireSigned),
            Err(ExtensionPackageError::InvalidEntryPath(
                "../escape".to_owned()
            ))
        );
    }

    #[test]
    fn rejects_metadata_fields_that_would_hide_graph_relationships() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut files = protected_files(Some(&signing_key));
        files.insert(
            METADATA_SCHEMA_PATH.to_owned(),
            serde_json::to_vec(&json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "targetNodeId": { "type": "string", "maxLength": 64 }
                }
            }))
            .unwrap(),
        );
        let checksums = checksum_bytes(&files);
        let signature = signing_key.sign(&checksums).to_bytes().to_vec();
        let package = write_package(files, checksums, Some(signature));

        assert_eq!(
            validate_extension_package(&package, SignaturePolicy::RequireSigned),
            Err(ExtensionPackageError::HiddenRelationshipMetadata)
        );
    }

    #[test]
    fn rejects_non_numeric_schema_bounds() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut files = protected_files(Some(&signing_key));
        files.insert(
            METADATA_SCHEMA_PATH.to_owned(),
            serde_json::to_vec(&json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "indentSize": {
                        "type": "integer",
                        "minimum": "zero",
                        "maximum": 8
                    }
                }
            }))
            .unwrap(),
        );
        let checksums = checksum_bytes(&files);
        let signature = signing_key.sign(&checksums).to_bytes().to_vec();
        let package = write_package(files, checksums, Some(signature));

        assert_eq!(
            validate_extension_package(&package, SignaturePolicy::RequireSigned),
            Err(ExtensionPackageError::InvalidMetadataSchema)
        );
    }

    #[test]
    fn rejects_malformed_collection_and_default_constraints() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let invalid_properties = [
            json!({ "type": "string", "minLength": "zero", "maxLength": 8 }),
            json!({
                "type": "array",
                "items": { "type": "boolean" },
                "minItems": "zero",
                "maxItems": 8
            }),
            json!({ "type": "string", "maxLength": 8, "enum": ["x", "x"] }),
            json!({ "type": "string", "maxLength": 8, "default": false }),
        ];

        for invalid_property in invalid_properties {
            let mut files = protected_files(Some(&signing_key));
            files.insert(
                METADATA_SCHEMA_PATH.to_owned(),
                serde_json::to_vec(&json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": { "value": invalid_property }
                }))
                .unwrap(),
            );
            let checksums = checksum_bytes(&files);
            let signature = signing_key.sign(&checksums).to_bytes().to_vec();
            let package = write_package(files, checksums, Some(signature));

            assert_eq!(
                validate_extension_package(&package, SignaturePolicy::RequireSigned),
                Err(ExtensionPackageError::InvalidMetadataSchema)
            );
        }
    }

    #[test]
    fn rejects_an_invalid_signature_even_when_checksums_match() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let files = protected_files(Some(&signing_key));
        let checksums = checksum_bytes(&files);
        let signature = vec![0_u8; 64];
        let package = write_package(files, checksums, Some(signature));

        assert_eq!(
            validate_extension_package(&package, SignaturePolicy::RequireSigned),
            Err(ExtensionPackageError::InvalidSignature)
        );
    }

    #[test]
    fn rejects_checksum_records_that_are_not_sorted_by_path() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let files = protected_files(Some(&signing_key));
        let mut checksums: ChecksumManifestV1 =
            serde_json::from_slice(&checksum_bytes(&files)).unwrap();
        checksums.files.reverse();
        let checksums = serde_json::to_vec(&checksums).unwrap();
        let signature = signing_key.sign(&checksums).to_bytes().to_vec();
        let package = write_package(files, checksums, Some(signature));

        assert_eq!(
            validate_extension_package(&package, SignaturePolicy::RequireSigned),
            Err(ExtensionPackageError::NonCanonicalChecksumList)
        );
    }
}
