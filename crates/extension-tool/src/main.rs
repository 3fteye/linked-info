use std::{collections::BTreeMap, env, path::PathBuf, process::ExitCode};

use ed25519_dalek::SigningKey;
use linked_info_extension_contracts::{
    ExtensionActionRequestV1, ExtensionRenderRequestV1, NodeHandle, NodeSnapshotV1, SignaturePolicy,
};
use linked_info_extension_host::{ExtensionRuntime, RuntimeLimits};
use linked_info_extension_tool::{
    PackageInput, build_package, componentize, generated_key_file, package_summary,
    read_signing_key, validate_package_file, write_output,
};
use rand_core::OsRng;

const USAGE: &str = "\
linked-info-extension-tool commands:\n\
  componentize --module <core.wasm> --output <extension.wasm> [--force]\n\
  keygen --output <private-key-file>\n\
  pack --manifest <manifest.json> --component <extension.wasm> --metadata-schema <schema.json> --locales-dir <dir> --output <package.liext> [--signing-key <file>] [--force]\n\
  verify --package <package.liext> [--allow-unsigned-development]\n\
  render --package <package.liext> --processor-id <id> [--content <text>] [--allow-unsigned-development]\n\
  invoke --package <package.liext> --action-id <id> [--content <text>] [--input <value>] [--base-revision <number>] [--allow-unsigned-development]";

struct Options {
    values: BTreeMap<String, String>,
    flags: BTreeMap<String, bool>,
}

impl Options {
    fn parse(
        arguments: Vec<String>,
        value_names: &[&str],
        flag_names: &[&str],
    ) -> Result<Self, String> {
        let mut values = BTreeMap::new();
        let mut flags = BTreeMap::new();
        let mut index = 0;
        while index < arguments.len() {
            let name = &arguments[index];
            if flag_names.contains(&name.as_str()) {
                if flags.insert(name.clone(), true).is_some() {
                    return Err(format!("duplicate option: {name}"));
                }
                index += 1;
                continue;
            }
            if !value_names.contains(&name.as_str()) {
                return Err(format!("unknown option: {name}"));
            }
            let value = arguments
                .get(index + 1)
                .ok_or_else(|| format!("missing value for {name}"))?;
            if values.insert(name.clone(), value.clone()).is_some() {
                return Err(format!("duplicate option: {name}"));
            }
            index += 2;
        }
        Ok(Self { values, flags })
    }

    fn required(&self, name: &str) -> Result<&str, String> {
        self.values
            .get(name)
            .map(String::as_str)
            .ok_or_else(|| format!("missing required option: {name}"))
    }

    fn optional(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.get(name).copied().unwrap_or(false)
    }
}

fn signature_policy(options: &Options) -> SignaturePolicy {
    if options.flag("--allow-unsigned-development") {
        SignaturePolicy::AllowUnsignedDevelopment
    } else {
        SignaturePolicy::RequireSigned
    }
}

fn runtime(
    options: &Options,
) -> Result<
    (
        ExtensionRuntime,
        linked_info_extension_contracts::ValidatedExtensionPackage,
    ),
    String,
> {
    let package = validate_package_file(
        &PathBuf::from(options.required("--package")?),
        signature_policy(options),
    )
    .map_err(|error| error.to_string())?;
    let runtime = ExtensionRuntime::new(package.clone(), 1, RuntimeLimits::default())
        .map_err(|error| format!("extension runtime failed: {:?}", error.code()))?;
    Ok((runtime, package))
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let command = arguments.next().ok_or_else(|| USAGE.to_owned())?;
    let arguments = arguments.collect::<Vec<_>>();
    match command.as_str() {
        "help" | "--help" | "-h" => println!("{USAGE}"),
        "componentize" => {
            let options = Options::parse(arguments, &["--module", "--output"], &["--force"])?;
            let module =
                std::fs::read(options.required("--module")?).map_err(|error| error.to_string())?;
            let component = componentize(&module).map_err(|error| error.to_string())?;
            write_output(
                &PathBuf::from(options.required("--output")?),
                &component,
                options.flag("--force"),
            )
            .map_err(|error| error.to_string())?;
        }
        "keygen" => {
            let options = Options::parse(arguments, &["--output"], &[])?;
            let key = SigningKey::generate(&mut OsRng);
            write_output(
                &PathBuf::from(options.required("--output")?),
                &generated_key_file(&key),
                false,
            )
            .map_err(|error| error.to_string())?;
            println!(
                "{}",
                serde_json::json!({
                    "publicKey": linked_info_extension_tool::encode_lower_hex(
                        &key.verifying_key().to_bytes()
                    )
                })
            );
        }
        "pack" => {
            let options = Options::parse(
                arguments,
                &[
                    "--manifest",
                    "--component",
                    "--metadata-schema",
                    "--locales-dir",
                    "--output",
                    "--signing-key",
                ],
                &["--force"],
            )?;
            let signing_key = options
                .optional("--signing-key")
                .map(|path| read_signing_key(&PathBuf::from(path)))
                .transpose()
                .map_err(|error| error.to_string())?;
            let (package, validated) = build_package(PackageInput {
                manifest_path: &PathBuf::from(options.required("--manifest")?),
                component_path: &PathBuf::from(options.required("--component")?),
                metadata_schema_path: &PathBuf::from(options.required("--metadata-schema")?),
                locales_directory: &PathBuf::from(options.required("--locales-dir")?),
                signing_key: signing_key.as_ref(),
            })
            .map_err(|error| error.to_string())?;
            write_output(
                &PathBuf::from(options.required("--output")?),
                &package,
                options.flag("--force"),
            )
            .map_err(|error| error.to_string())?;
            println!("{}", package_summary(&validated));
        }
        "verify" => {
            let options =
                Options::parse(arguments, &["--package"], &["--allow-unsigned-development"])?;
            let package = validate_package_file(
                &PathBuf::from(options.required("--package")?),
                signature_policy(&options),
            )
            .map_err(|error| error.to_string())?;
            println!("{}", package_summary(&package));
        }
        "render" => {
            let options = Options::parse(
                arguments,
                &["--package", "--processor-id", "--content"],
                &["--allow-unsigned-development"],
            )?;
            let (runtime, _) = runtime(&options)?;
            let result = runtime
                .render(
                    1,
                    &ExtensionRenderRequestV1 {
                        processor_id: options.required("--processor-id")?.to_owned(),
                        node: NodeSnapshotV1 {
                            handle: NodeHandle(1),
                            name: None,
                            content: options.optional("--content").map(str::to_owned),
                            direct_outgoing: Vec::new(),
                            direct_incoming: Vec::new(),
                        },
                        node_metadata_json: None,
                        workspace_metadata_json: None,
                        monotonic_time_ms: None,
                    },
                )
                .map_err(|error| format!("extension render failed: {:?}", error.code()))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
            );
        }
        "invoke" => {
            let options = Options::parse(
                arguments,
                &[
                    "--package",
                    "--action-id",
                    "--content",
                    "--input",
                    "--base-revision",
                ],
                &["--allow-unsigned-development"],
            )?;
            let (runtime, _) = runtime(&options)?;
            let base_revision = options
                .optional("--base-revision")
                .unwrap_or("1")
                .parse::<u64>()
                .map_err(|_| "base revision must be an unsigned integer".to_owned())?;
            let result = runtime
                .invoke(
                    1,
                    &ExtensionActionRequestV1 {
                        action_id: options.required("--action-id")?.to_owned(),
                        nodes: vec![NodeSnapshotV1 {
                            handle: NodeHandle(1),
                            name: None,
                            content: options.optional("--content").map(str::to_owned),
                            direct_outgoing: Vec::new(),
                            direct_incoming: Vec::new(),
                        }],
                        node_metadata_json: None,
                        workspace_metadata_json: None,
                        input_value: options.optional("--input").map(str::to_owned),
                        monotonic_time_ms: None,
                        base_revision,
                    },
                )
                .map_err(|error| format!("extension action failed: {:?}", error.code()))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
            );
        }
        _ => return Err(USAGE.to_owned()),
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
