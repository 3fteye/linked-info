use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Write},
    path::Path,
};

use ed25519_dalek::{Signer, SigningKey};
use linked_info_extension_contracts::{
    ExtensionManifestV1, SignaturePolicy, ValidatedExtensionPackage, validate_extension_manifest,
    validate_extension_package,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use wit_component::ComponentEncoder;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const MANIFEST_PATH: &str = "manifest.json";
const COMPONENT_PATH: &str = "extension.wasm";
const METADATA_SCHEMA_PATH: &str = "metadata.schema.json";
const CHECKSUMS_PATH: &str = "checksums.json";
const SIGNATURE_PATH: &str = "signature.ed25519";

#[derive(Debug, Error)]
pub enum ExtensionToolError {
    #[error("cannot read or write an extension file")]
    Io(#[from] std::io::Error),
    #[error("extension manifest JSON is invalid")]
    ManifestJson(#[source] serde_json::Error),
    #[error("extension manifest is invalid: {0}")]
    Manifest(String),
    #[error("component encoding failed")]
    ComponentEncoding,
    #[error("signing key must contain exactly 64 lowercase hexadecimal characters")]
    InvalidSigningKey,
    #[error("manifest publisher key does not match the signing key")]
    PublisherKeyMismatch,
    #[error("extension package serialization failed")]
    PackageSerialization,
    #[error("extension archive serialization failed")]
    Archive(#[from] zip::result::ZipError),
    #[error("built extension package failed validation: {0}")]
    BuiltPackageInvalid(String),
}

pub struct PackageInput<'a> {
    pub manifest_path: &'a Path,
    pub component_path: &'a Path,
    pub metadata_schema_path: &'a Path,
    pub locales_directory: &'a Path,
    pub signing_key: Option<&'a SigningKey>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChecksumManifestV1 {
    schema_version: u32,
    files: Vec<ChecksumFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChecksumFile {
    path: String,
    size_bytes: u64,
    sha256: String,
}

pub fn componentize(core_module: &[u8]) -> Result<Vec<u8>, ExtensionToolError> {
    ComponentEncoder::default()
        .module(core_module)
        .map_err(|_| ExtensionToolError::ComponentEncoding)?
        .validate(true)
        .encode()
        .map_err(|_| ExtensionToolError::ComponentEncoding)
}

pub fn parse_signing_key(contents: &str) -> Result<SigningKey, ExtensionToolError> {
    let encoded = contents.trim();
    let bytes = decode_lower_hex::<32>(encoded).ok_or(ExtensionToolError::InvalidSigningKey)?;
    Ok(SigningKey::from_bytes(&bytes))
}

pub fn encode_lower_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing into a string cannot fail");
    }
    encoded
}

pub fn build_package(
    input: PackageInput<'_>,
) -> Result<(Vec<u8>, ValidatedExtensionPackage), ExtensionToolError> {
    let manifest_bytes = fs::read(input.manifest_path)?;
    let mut manifest = serde_json::from_slice::<ExtensionManifestV1>(&manifest_bytes)
        .map_err(ExtensionToolError::ManifestJson)?;
    if let Some(signing_key) = input.signing_key {
        let public_key = encode_lower_hex(&signing_key.verifying_key().to_bytes());
        if manifest
            .publisher
            .public_key
            .as_deref()
            .is_some_and(|declared| declared != public_key)
        {
            return Err(ExtensionToolError::PublisherKeyMismatch);
        }
        manifest.publisher.public_key = Some(public_key);
    }
    validate_extension_manifest(&manifest)
        .map_err(|error| ExtensionToolError::Manifest(error.code().to_owned()))?;

    let mut protected_files = BTreeMap::<String, Vec<u8>>::new();
    protected_files.insert(
        MANIFEST_PATH.to_owned(),
        serde_json::to_vec(&manifest).map_err(|_| ExtensionToolError::PackageSerialization)?,
    );
    protected_files.insert(COMPONENT_PATH.to_owned(), fs::read(input.component_path)?);
    protected_files.insert(
        METADATA_SCHEMA_PATH.to_owned(),
        fs::read(input.metadata_schema_path)?,
    );
    for locale in &manifest.locales {
        let path = format!("locales/{locale}.json");
        protected_files.insert(
            path,
            fs::read(input.locales_directory.join(format!("{locale}.json")))?,
        );
    }

    let checksum_manifest = ChecksumManifestV1 {
        schema_version: 1,
        files: protected_files
            .iter()
            .map(|(path, contents)| ChecksumFile {
                path: path.clone(),
                size_bytes: contents.len() as u64,
                sha256: sha256_hex(contents),
            })
            .collect(),
    };
    let checksums = serde_json::to_vec(&checksum_manifest)
        .map_err(|_| ExtensionToolError::PackageSerialization)?;
    let mut archive_files = protected_files;
    archive_files.insert(CHECKSUMS_PATH.to_owned(), checksums.clone());
    if let Some(signing_key) = input.signing_key {
        archive_files.insert(
            SIGNATURE_PATH.to_owned(),
            signing_key.sign(&checksums).to_bytes().to_vec(),
        );
    }

    let package = write_archive(archive_files)?;
    let policy = if input.signing_key.is_some() {
        SignaturePolicy::RequireSigned
    } else {
        SignaturePolicy::AllowUnsignedDevelopment
    };
    let validated = validate_extension_package(&package, policy)
        .map_err(|error| ExtensionToolError::BuiltPackageInvalid(error.code().to_owned()))?;
    Ok((package, validated))
}

pub fn validate_package_file(
    path: &Path,
    policy: SignaturePolicy,
) -> Result<ValidatedExtensionPackage, ExtensionToolError> {
    let bytes = fs::read(path)?;
    validate_extension_package(&bytes, policy)
        .map_err(|error| ExtensionToolError::BuiltPackageInvalid(error.code().to_owned()))
}

pub fn write_output(path: &Path, contents: &[u8], force: bool) -> Result<(), ExtensionToolError> {
    if !force {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        output.write_all(contents)?;
        output.sync_all()?;
        return Ok(());
    }
    fs::write(path, contents)?;
    Ok(())
}

pub fn read_signing_key(path: &Path) -> Result<SigningKey, ExtensionToolError> {
    parse_signing_key(&fs::read_to_string(path)?)
}

pub fn generated_key_file(signing_key: &SigningKey) -> Vec<u8> {
    let mut encoded = encode_lower_hex(&signing_key.to_bytes());
    encoded.push('\n');
    encoded.into_bytes()
}

fn write_archive(files: BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, ExtensionToolError> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for (path, contents) in files {
        writer.start_file(path, options)?;
        writer.write_all(&contents)?;
    }
    writer
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(ExtensionToolError::Archive)
}

fn sha256_hex(bytes: &[u8]) -> String {
    encode_lower_hex(&Sha256::digest(bytes))
}

fn decode_lower_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2 {
        return None;
    }
    let mut result = [0_u8; N];
    for (index, slot) in result.iter_mut().enumerate() {
        let high = hex_nibble(value.as_bytes()[index * 2])?;
        let low = hex_nibble(value.as_bytes()[index * 2 + 1])?;
        *slot = (high << 4) | low;
    }
    Some(result)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

pub fn package_summary(package: &ValidatedExtensionPackage) -> serde_json::Value {
    serde_json::json!({
        "extensionId": package.manifest.id,
        "version": package.manifest.version,
        "packageSha256": package.package_sha256,
        "publisherFingerprint": package.publisher_fingerprint,
        "signed": package.signed,
        "fileCount": package.file_count,
        "uncompressedBytes": package.uncompressed_bytes,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use ed25519_dalek::SigningKey;
    use wit_component::{ComponentEncoder, StringEncoding, dummy_module, embed_component_metadata};
    use wit_parser::{ManglingAndAbi, Resolve};

    use super::*;

    fn valid_component() -> Vec<u8> {
        let mut resolve = Resolve::new();
        let package = resolve
            .push_str(
                "linked-info-extension.wit",
                linked_info_extension_contracts::EXTENSION_WIT,
            )
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

    #[test]
    fn signing_key_parser_requires_canonical_lower_hex() {
        let encoded = "11".repeat(32);
        assert_eq!(parse_signing_key(&encoded).unwrap().to_bytes(), [0x11; 32]);
        assert!(parse_signing_key(&encoded.to_uppercase()).is_err());
        assert!(parse_signing_key("11").is_err());
    }

    #[test]
    fn sdk_and_host_contract_use_identical_wit() {
        assert_eq!(
            linked_info_extension_sdk::EXTENSION_WIT.replace("\r\n", "\n"),
            linked_info_extension_contracts::EXTENSION_WIT.replace("\r\n", "\n")
        );
    }

    #[test]
    fn signed_package_build_is_deterministic_and_self_validating() {
        let root =
            std::env::temp_dir().join(format!("linked-info-extension-tool-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("locales")).unwrap();
        fs::write(
            root.join("manifest.json"),
            r#"{
              "schemaVersion":1,
              "id":"dev.example.tool-test",
              "version":"1.0.0",
              "apiVersion":"1.0",
              "publisher":{"name":"Tool test"},
              "defaultLocale":"en",
              "locales":["en"],
              "entrypoint":"extension.wasm",
              "metadataSchema":"metadata.schema.json",
              "metadataSchemaVersion":1,
              "capabilities":["node.read.content"],
              "contributions":{"processors":[{"id":"inspect","labelKey":"processor.label"}],"actions":[]}
            }"#,
        )
        .unwrap();
        fs::write(root.join("extension.wasm"), valid_component()).unwrap();
        fs::write(
            root.join("metadata.schema.json"),
            r#"{"type":"object","additionalProperties":false,"properties":{}}"#,
        )
        .unwrap();
        fs::write(
            root.join("locales/en.json"),
            r#"{"processor.label":"Inspector"}"#,
        )
        .unwrap();
        let key = SigningKey::from_bytes(&[7; 32]);
        let manifest_path = root.join("manifest.json");
        let component_path = root.join("extension.wasm");
        let metadata_schema_path = root.join("metadata.schema.json");
        let locales_directory = root.join("locales");
        let input = || PackageInput {
            manifest_path: &manifest_path,
            component_path: &component_path,
            metadata_schema_path: &metadata_schema_path,
            locales_directory: &locales_directory,
            signing_key: Some(&key),
        };

        let (first, validated) = build_package(input()).unwrap();
        let (second, _) = build_package(input()).unwrap();

        assert_eq!(first, second);
        assert!(validated.signed);
        assert_eq!(validated.manifest.id, "dev.example.tool-test");
        fs::remove_dir_all(root).unwrap();
    }
}
