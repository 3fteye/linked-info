use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use linked_info_extension_contracts::{
    EXTENSION_WIT, ExtensionCapability, ExtensionContributions, ExtensionManifestV1,
    ExtensionPublisher, ExtensionRenderRequestV1, NodeHandle, NodeSnapshotV1,
    ProcessorContribution,
};
use linked_info_extension_host_protocol::{
    EXTENSION_HOST_PROTOCOL_VERSION, ExtensionHostErrorCode, ExtensionHostRequestV1,
    ExtensionHostResponseV1,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use wit_component::{ComponentEncoder, StringEncoding, dummy_module, embed_component_metadata};
use wit_parser::{ManglingAndAbi, Resolve};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

fn component() -> Vec<u8> {
    let mut resolve = Resolve::new();
    let package = resolve
        .push_str("linked-info-extension.wit", EXTENSION_WIT)
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

fn package() -> Vec<u8> {
    let manifest = ExtensionManifestV1 {
        schema_version: 1,
        id: "dev.example.process-test".to_owned(),
        version: "1.0.0".to_owned(),
        api_version: "1.0".to_owned(),
        publisher: ExtensionPublisher {
            name: "Process test".to_owned(),
            public_key: None,
        },
        default_locale: "en".to_owned(),
        locales: vec!["en".to_owned()],
        entrypoint: "extension.wasm".to_owned(),
        metadata_schema: "metadata.schema.json".to_owned(),
        metadata_schema_version: 1,
        capabilities: vec![ExtensionCapability::NodeReadContent],
        contributions: ExtensionContributions {
            processors: vec![ProcessorContribution {
                id: "inspect".to_owned(),
                label_key: "processor.label".to_owned(),
            }],
            actions: Vec::new(),
        },
    };
    let files = BTreeMap::from([
        (
            "manifest.json".to_owned(),
            serde_json::to_vec(&manifest).unwrap(),
        ),
        ("extension.wasm".to_owned(), component()),
        (
            "metadata.schema.json".to_owned(),
            serde_json::to_vec(&json!({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "additionalProperties": false,
                "properties": {}
            }))
            .unwrap(),
        ),
        (
            "locales/en.json".to_owned(),
            serde_json::to_vec(&json!({ "processor.label": "Process test" })).unwrap(),
        ),
    ]);
    let checksums = serde_json::to_vec(&json!({
        "schemaVersion": 1,
        "files": files.iter().map(|(path, contents)| json!({
            "path": path,
            "sizeBytes": contents.len(),
            "sha256": format!("{:x}", Sha256::digest(contents))
        })).collect::<Vec<_>>()
    }))
    .unwrap();
    let cursor = std::io::Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (path, contents) in files {
        writer.start_file(path, options).unwrap();
        writer.write_all(&contents).unwrap();
    }
    writer.start_file("checksums.json", options).unwrap();
    writer.write_all(&checksums).unwrap();
    writer.finish().unwrap().into_inner()
}

fn send(input: &mut impl Write, request: &ExtensionHostRequestV1) {
    serde_json::to_writer(&mut *input, request).unwrap();
    input.write_all(b"\n").unwrap();
    input.flush().unwrap();
}

fn receive(reader: &mut impl BufRead) -> ExtensionHostResponseV1 {
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

#[test]
fn subprocess_handshake_trap_revoke_and_shutdown_are_framed() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let package_path = std::env::temp_dir().join(format!(
        "linked-info-extension-host-{}-{unique}.liext",
        std::process::id()
    ));
    fs::write(&package_path, package()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_linked-info-extension-host"))
        .arg("--package")
        .arg(&package_path)
        .arg("--generation")
        .arg("1")
        .arg("--allow-unsigned-development")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());

    send(
        &mut input,
        &ExtensionHostRequestV1::Hello {
            protocol_version: EXTENSION_HOST_PROTOCOL_VERSION,
        },
    );
    assert!(matches!(
        receive(&mut output),
        ExtensionHostResponseV1::Ready {
            extension_id,
            generation: 1,
            ..
        } if extension_id == "dev.example.process-test"
    ));

    send(
        &mut input,
        &ExtensionHostRequestV1::Render {
            request_id: 41,
            generation: 1,
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
        },
    );
    assert!(matches!(
        receive(&mut output),
        ExtensionHostResponseV1::Error {
            request_id: Some(41),
            generation: 1,
            code: ExtensionHostErrorCode::ComponentTrap,
        }
    ));

    send(
        &mut input,
        &ExtensionHostRequestV1::Revoke { generation: 2 },
    );
    assert_eq!(
        receive(&mut output),
        ExtensionHostResponseV1::Revoked { generation: 2 }
    );
    send(&mut input, &ExtensionHostRequestV1::Shutdown {});
    assert_eq!(
        receive(&mut output),
        ExtensionHostResponseV1::ShuttingDown {}
    );
    assert!(child.wait().unwrap().success());
    fs::remove_file(package_path).unwrap();
}
