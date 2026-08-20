use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use linked_info_extension_contracts::{
    ExtensionActionRequestV1, ExtensionActionResultV1, ExtensionMetadataMigrationRequestV1,
    ExtensionPresentationV1, ExtensionRenderRequestV1, ValidatedExtensionPackage,
};
use wasmtime::component::types::ComponentItem;
use wasmtime::component::{Component, ComponentExportIndex, Linker, Val};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder, Trap};

use crate::{
    ExtensionRuntimeError,
    validation::{
        validate_action_request, validate_action_result, validate_migrated_metadata,
        validate_migration_request, validate_presentation, validate_render_request,
    },
    value,
};

const GUEST_EXPORT_NAMES: &[&str] = &["linked-info:extension/guest@1.0.0", "guest"];

#[derive(Debug, Clone)]
pub struct RuntimeLimits {
    pub linear_memory_bytes: usize,
    pub passive_fuel: u64,
    pub active_fuel: u64,
    pub migration_fuel: u64,
    pub passive_deadline: Duration,
    pub active_deadline: Duration,
    pub migration_deadline: Duration,
}

impl Default for RuntimeLimits {
    fn default() -> Self {
        Self {
            linear_memory_bytes: 128 * 1024 * 1024,
            passive_fuel: 5_000_000,
            active_fuel: 100_000_000,
            migration_fuel: 100_000_000,
            passive_deadline: Duration::from_millis(500),
            active_deadline: Duration::from_secs(30),
            migration_deadline: Duration::from_secs(30),
        }
    }
}

struct HostState {
    limits: StoreLimits,
}

struct RuntimeExports {
    render: ComponentExportIndex,
    invoke: ComponentExportIndex,
    migrate_metadata: ComponentExportIndex,
}

pub struct ExtensionRuntime {
    engine: Engine,
    component: Component,
    exports: RuntimeExports,
    package: ValidatedExtensionPackage,
    authorization_generation: Arc<AtomicU64>,
    limits: RuntimeLimits,
}

impl ExtensionRuntime {
    pub fn new(
        package: ValidatedExtensionPackage,
        authorization_generation: u64,
        limits: RuntimeLimits,
    ) -> Result<Self, ExtensionRuntimeError> {
        let linear_memory_bytes = u64::try_from(limits.linear_memory_bytes)
            .map_err(|_| ExtensionRuntimeError::Internal)?;
        let mut config = Config::new();
        config
            .wasm_component_model(true)
            .consume_fuel(true)
            .epoch_interruption(true)
            .concurrency_support(false)
            .memory_reservation(linear_memory_bytes)
            .memory_reservation_for_growth(0)
            .max_wasm_stack(512 * 1024);
        let engine = Engine::new(&config).map_err(|_| ExtensionRuntimeError::Internal)?;
        let component = Component::new(&engine, &package.component)
            .map_err(|_| ExtensionRuntimeError::ComponentCompileInvalid)?;
        if component
            .component_type()
            .imports(&engine)
            .any(|(_, item)| !matches!(item.ty, ComponentItem::Type(_)))
        {
            return Err(ExtensionRuntimeError::ComponentRuntimeImportForbidden);
        }
        let guest = GUEST_EXPORT_NAMES
            .iter()
            .find_map(|name| component.get_export_index(None, *name))
            .ok_or(ExtensionRuntimeError::ComponentGuestExportMissing)?;
        let exports = RuntimeExports {
            render: component
                .get_export_index(Some(&guest), "render")
                .ok_or(ExtensionRuntimeError::ComponentFunctionExportMissing)?,
            invoke: component
                .get_export_index(Some(&guest), "invoke")
                .ok_or(ExtensionRuntimeError::ComponentFunctionExportMissing)?,
            migrate_metadata: component
                .get_export_index(Some(&guest), "migrate-metadata")
                .ok_or(ExtensionRuntimeError::ComponentFunctionExportMissing)?,
        };
        Ok(Self {
            engine,
            component,
            exports,
            package,
            authorization_generation: Arc::new(AtomicU64::new(authorization_generation)),
            limits,
        })
    }

    pub fn extension_id(&self) -> &str {
        &self.package.manifest.id
    }

    pub fn authorization_generation(&self) -> u64 {
        self.authorization_generation.load(Ordering::Acquire)
    }

    pub fn advance_generation(&self, generation: u64) -> Result<(), ExtensionRuntimeError> {
        let current = self.authorization_generation();
        if generation <= current {
            return Err(ExtensionRuntimeError::RequestInvalid);
        }
        self.authorization_generation
            .store(generation, Ordering::Release);
        self.engine.increment_epoch();
        Ok(())
    }

    pub fn render(
        &self,
        generation: u64,
        request: &ExtensionRenderRequestV1,
    ) -> Result<ExtensionPresentationV1, ExtensionRuntimeError> {
        self.ensure_generation(generation)?;
        validate_render_request(request, &self.package)?;
        let value = self.call(
            generation,
            self.limits.passive_fuel,
            self.limits.passive_deadline,
            &self.exports.render,
            value::render_request(request),
        )?;
        let presentation = value::presentation(value)?;
        validate_presentation(&presentation, &self.package)?;
        self.ensure_generation(generation)?;
        Ok(presentation)
    }

    pub fn invoke(
        &self,
        generation: u64,
        request: &ExtensionActionRequestV1,
    ) -> Result<ExtensionActionResultV1, ExtensionRuntimeError> {
        self.ensure_generation(generation)?;
        validate_action_request(request, &self.package)?;
        let value = self.call(
            generation,
            self.limits.active_fuel,
            self.limits.active_deadline,
            &self.exports.invoke,
            value::action_request(request),
        )?;
        let result = value::action_result(value)?;
        validate_action_result(&result, request, &self.package)?;
        self.ensure_generation(generation)?;
        Ok(result)
    }

    pub fn migrate_metadata(
        &self,
        generation: u64,
        request: &ExtensionMetadataMigrationRequestV1,
    ) -> Result<String, ExtensionRuntimeError> {
        self.ensure_generation(generation)?;
        validate_migration_request(request, &self.package)?;
        let value = self.call(
            generation,
            self.limits.migration_fuel,
            self.limits.migration_deadline,
            &self.exports.migrate_metadata,
            value::migration_request(request),
        )?;
        let metadata_json = value::migrated_metadata(value)?;
        validate_migrated_metadata(&metadata_json, &self.package)?;
        self.ensure_generation(generation)?;
        Ok(metadata_json)
    }

    fn ensure_generation(&self, generation: u64) -> Result<(), ExtensionRuntimeError> {
        (self.authorization_generation() == generation)
            .then_some(())
            .ok_or(ExtensionRuntimeError::GenerationRevoked)
    }

    fn store(&self, fuel: u64) -> Result<Store<HostState>, ExtensionRuntimeError> {
        let limits = StoreLimitsBuilder::new()
            .memory_size(self.limits.linear_memory_bytes)
            .memories(1)
            .instances(64)
            .tables(8)
            .table_elements(100_000)
            .trap_on_grow_failure(true)
            .build();
        let mut store = Store::new(&self.engine, HostState { limits });
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(fuel)
            .map_err(|_| ExtensionRuntimeError::Internal)?;
        store.set_epoch_deadline(1);
        store.epoch_deadline_trap();
        Ok(store)
    }

    fn call(
        &self,
        generation: u64,
        fuel: u64,
        deadline: Duration,
        export: &ComponentExportIndex,
        request: Val,
    ) -> Result<Val, ExtensionRuntimeError> {
        let mut store = self.store(fuel)?;
        let watchdog = DeadlineWatchdog::start(self.engine.clone(), deadline);
        let result = (|| {
            let linker = Linker::<HostState>::new(&self.engine);
            let instance = linker
                .instantiate(&mut store, &self.component)
                .map_err(|error| self.execution_error(generation, error, true))?;
            let function = instance
                .get_func(&mut store, export)
                .ok_or(ExtensionRuntimeError::ComponentInvalid)?;
            let mut results = [Val::Bool(false)];
            function
                .call(&mut store, &[request], &mut results)
                .map_err(|error| self.execution_error(generation, error, false))?;
            Ok(results.into_iter().next().expect("one result slot"))
        })();
        drop(watchdog);
        result
    }

    fn execution_error(
        &self,
        generation: u64,
        error: wasmtime::Error,
        instantiating: bool,
    ) -> ExtensionRuntimeError {
        if self.authorization_generation() != generation {
            return ExtensionRuntimeError::GenerationRevoked;
        }
        match error.downcast_ref::<Trap>() {
            Some(Trap::Interrupt) => ExtensionRuntimeError::DeadlineExceeded,
            Some(Trap::OutOfFuel) => ExtensionRuntimeError::ResourceLimit,
            Some(_) => ExtensionRuntimeError::ComponentTrap,
            None if instantiating => ExtensionRuntimeError::ResourceLimit,
            None => ExtensionRuntimeError::ComponentTrap,
        }
    }
}

struct DeadlineWatchdog {
    done: Option<mpsc::Sender<()>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl DeadlineWatchdog {
    fn start(engine: Engine, deadline: Duration) -> Self {
        let (done, receiver) = mpsc::channel();
        let thread = thread::spawn(move || {
            if receiver.recv_timeout(deadline).is_err() {
                engine.increment_epoch();
            }
        });
        Self {
            done: Some(done),
            thread: Some(thread),
        }
    }
}

impl Drop for DeadlineWatchdog {
    fn drop(&mut self) {
        if let Some(done) = self.done.take() {
            let _ = done.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use linked_info_extension_contracts::{
        ExtensionCapability, ExtensionContributions, ExtensionManifestV1, ExtensionPublisher,
        NodeHandle, NodeSnapshotV1, ProcessorContribution,
    };
    use serde_json::json;
    use wit_component::{ComponentEncoder, StringEncoding, dummy_module, embed_component_metadata};
    use wit_parser::{ManglingAndAbi, Resolve};

    use super::*;

    fn component_from_wit(wit: &str, module_transform: impl FnOnce(Vec<u8>) -> Vec<u8>) -> Vec<u8> {
        let mut resolve = Resolve::new();
        let package = resolve.push_str("linked-info-extension.wit", wit).unwrap();
        let world = resolve
            .select_world(&[package], Some("node-extension"))
            .unwrap();
        let mut module =
            module_transform(dummy_module(&resolve, world, ManglingAndAbi::Standard32));
        embed_component_metadata(&mut module, &resolve, world, StringEncoding::UTF8).unwrap();
        ComponentEncoder::default()
            .module(&module)
            .unwrap()
            .validate(true)
            .encode()
            .unwrap()
    }

    fn package_with_component(component: Vec<u8>) -> ValidatedExtensionPackage {
        ValidatedExtensionPackage {
            manifest: ExtensionManifestV1 {
                schema_version: 1,
                id: "dev.example.runtime".to_owned(),
                version: "1.0.0".to_owned(),
                api_version: "1.0".to_owned(),
                publisher: ExtensionPublisher {
                    name: "Runtime test".to_owned(),
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
            },
            component,
            metadata_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {}
            }),
            locales: BTreeMap::from([(
                "en".to_owned(),
                BTreeMap::from([("processor.label".to_owned(), "Inspector".to_owned())]),
            )]),
            package_sha256: "00".repeat(32),
            publisher_fingerprint: None,
            signed: false,
            file_count: 5,
            uncompressed_bytes: 0,
        }
    }

    fn package() -> ValidatedExtensionPackage {
        package_with_component(component_from_wit(
            linked_info_extension_contracts::EXTENSION_WIT,
            |module| module,
        ))
    }

    fn component_with_start(start_body: &str) -> Vec<u8> {
        component_from_wit(linked_info_extension_contracts::EXTENSION_WIT, |module| {
            let mut text = wasmprinter::print_bytes(module).unwrap();
            let module_end = text.rfind(')').unwrap();
            text.insert_str(
                module_end,
                &format!("(func $host-test-start {start_body})\n(start $host-test-start)\n"),
            );
            wat::parse_str(text).unwrap()
        })
    }

    fn render_request() -> ExtensionRenderRequestV1 {
        ExtensionRenderRequestV1 {
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
        }
    }

    #[test]
    fn links_the_declared_world_without_wasi_and_contains_guest_traps() {
        let runtime = ExtensionRuntime::new(package(), 1, RuntimeLimits::default()).unwrap();

        assert_eq!(
            runtime.render(1, &render_request()),
            Err(ExtensionRuntimeError::ComponentTrap)
        );
    }

    #[test]
    fn rejects_revoked_generations_before_guest_execution() {
        let runtime = ExtensionRuntime::new(package(), 4, RuntimeLimits::default()).unwrap();
        runtime.advance_generation(5).unwrap();

        assert_eq!(
            runtime.render(4, &render_request()),
            Err(ExtensionRuntimeError::GenerationRevoked)
        );
        assert_eq!(
            runtime.advance_generation(5),
            Err(ExtensionRuntimeError::RequestInvalid)
        );
    }

    #[test]
    fn rejects_fields_not_granted_by_the_manifest() {
        let runtime = ExtensionRuntime::new(package(), 1, RuntimeLimits::default()).unwrap();
        let mut request = render_request();
        request.node.name = Some("not authorized".to_owned());

        assert_eq!(
            runtime.render(1, &request),
            Err(ExtensionRuntimeError::RequestInvalid)
        );
    }

    #[test]
    fn refuses_components_with_any_host_import_including_wasi() {
        let wit = linked_info_extension_contracts::EXTENSION_WIT.replace(
            "world node-extension {\n  export guest;",
            "world node-extension {\n  import forbidden: func();\n  export guest;",
        );
        let package = package_with_component(component_from_wit(&wit, |module| module));

        assert!(matches!(
            ExtensionRuntime::new(package, 1, RuntimeLimits::default()),
            Err(ExtensionRuntimeError::ComponentRuntimeImportForbidden)
        ));
    }

    #[test]
    fn deterministic_fuel_stops_infinite_guest_initialization() {
        let package = package_with_component(component_with_start("(loop $spin br $spin)"));
        let limits = RuntimeLimits {
            passive_fuel: 100,
            passive_deadline: Duration::from_secs(1),
            ..RuntimeLimits::default()
        };
        let runtime = ExtensionRuntime::new(package, 1, limits).unwrap();

        assert_eq!(
            runtime.render(1, &render_request()),
            Err(ExtensionRuntimeError::ResourceLimit)
        );
    }

    #[test]
    fn wall_clock_deadline_stops_guest_with_unbounded_fuel() {
        let package = package_with_component(component_with_start("(loop $spin br $spin)"));
        let limits = RuntimeLimits {
            passive_fuel: u64::MAX,
            passive_deadline: Duration::from_millis(10),
            ..RuntimeLimits::default()
        };
        let runtime = ExtensionRuntime::new(package, 1, limits).unwrap();

        assert_eq!(
            runtime.render(1, &render_request()),
            Err(ExtensionRuntimeError::DeadlineExceeded)
        );
    }

    #[test]
    fn advancing_generation_interrupts_and_discards_an_inflight_guest() {
        let package = package_with_component(component_with_start("(loop $spin br $spin)"));
        let limits = RuntimeLimits {
            passive_fuel: u64::MAX,
            passive_deadline: Duration::from_secs(5),
            ..RuntimeLimits::default()
        };
        let runtime = Arc::new(ExtensionRuntime::new(package, 1, limits).unwrap());
        let worker_runtime = Arc::clone(&runtime);
        let worker = thread::spawn(move || worker_runtime.render(1, &render_request()));
        thread::sleep(Duration::from_millis(20));

        runtime.advance_generation(2).unwrap();

        assert_eq!(
            worker.join().unwrap(),
            Err(ExtensionRuntimeError::GenerationRevoked)
        );
    }
}
