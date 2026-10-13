//! CI-only process interruption of the real file transactions. No Tauri commands.
use super::*;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const CHILD_TEST: &str = "workspace_file::tests::recovery_crash::crash_child";
const KEY: [u8; DATA_KEY_BYTES] = [73; DATA_KEY_BYTES];
const PASSWORD: &str = "synthetic recovery process password";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    SwapPreparedPrimary,
    SwapPreparedRecovery,
    SwapManifest,
    SwapPrimary,
    SwapRecovery,
    SwapCleaned,
    InstallPreparedPrimary,
    InstallPreparedRecovery,
    InstallPreparedVault,
    InstallPrimary,
    InstallRecovery,
    InstallVault,
}

const STAGES: [Stage; 12] = [
    Stage::SwapPreparedPrimary,
    Stage::SwapPreparedRecovery,
    Stage::SwapManifest,
    Stage::SwapPrimary,
    Stage::SwapRecovery,
    Stage::SwapCleaned,
    Stage::InstallPreparedPrimary,
    Stage::InstallPreparedRecovery,
    Stage::InstallPreparedVault,
    Stage::InstallPrimary,
    Stage::InstallRecovery,
    Stage::InstallVault,
];

thread_local! {
    static STOP_AT: RefCell<Option<(PathBuf, Stage)>> = const { RefCell::new(None) };
}

pub(crate) fn checkpoint(store: &WorkspaceFileStore, stage: Stage) {
    STOP_AT.with_borrow(|armed| {
        if let Some((directory, requested)) = armed
            && directory == &store.base_directory
            && *requested == stage
        {
            // A fixed marker, never a document, key, password or exception body.
            fs::write(directory.parent().unwrap().join("reached"), b"reached").unwrap();
            loop {
                std::thread::park();
            }
        }
    });
}

fn hosted_runner() -> PathBuf {
    for (key, value) in [
        ("GITHUB_ACTIONS", "true"),
        ("RUNNER_ENVIRONMENT", "github-hosted"),
        ("RUNNER_OS", "Windows"),
    ] {
        assert_eq!(std::env::var(key).as_deref(), Ok(value), "CI only");
    }
    fs::canonicalize(std::env::var_os("RUNNER_TEMP").expect("runner temp required")).unwrap()
}

fn fixture(name: &str) -> String {
    let mut value = timeline_workspace();
    value["nodes"][0]["name"] = serde_json::json!(name);
    value["nodes"][0]["content"] = serde_json::json!(format!("Synthetic {name}\nretained"));
    value["references"] = serde_json::json!([{
        "sourceNodeId": "22222222-2222-4222-8222-222222222222",
        "targetNodeId": "11111111-1111-4111-8111-111111111111"
    }]);
    value["view"]["canvases"][0]["layout"] = serde_json::json!([{
        "nodeId": "11111111-1111-4111-8111-111111111111",
        "x": if name == "original" { 20 } else { 300 }, "y": 80,
        "width": 320, "height": 200
    }]);
    value["view"]["extensionMetadata"] = serde_json::json!({
        "dev.example.crash-test": {
            "schemaVersion": 1, "workspace": {"fixture": name}, "byNodeId": {}
        }
    });
    normalize_storage_envelope(&value.to_string()).unwrap()
}

struct OwnedChild(Child);

impl OwnedChild {
    fn wait(&mut self) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "child deadline exceeded");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        // Only the child handle owned by this test, never PID/name discovery.
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn spawn_child(root: &Path, token: &str, kind: &str, stage: Stage, mode: &str) -> OwnedChild {
    OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", CHILD_TEST, "--ignored", "--test-threads=1"])
            .env("LI_CRASH_ROOT", root)
            .env("LI_CRASH_TOKEN", token)
            .env("LI_CRASH_KIND", kind)
            .env("LI_CRASH_STAGE", format!("{stage:?}"))
            .env("LI_CRASH_MODE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

fn interrupt(kind: &str, stage: Stage) -> (PathBuf, String) {
    let token = uuid::Uuid::new_v4().to_string();
    let root = hosted_runner().join(format!("linked-info-recovery-crash-{token}"));
    fs::create_dir(&root).unwrap();
    fs::write(root.join("owner"), token.as_bytes()).unwrap();
    let mut child = spawn_child(&root, &token, kind, stage, "mutate");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !root.join("reached").is_file() {
        assert!(child.0.try_wait().unwrap().is_none(), "child exited early");
        assert!(Instant::now() < deadline, "checkpoint not reached: {stage:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read(root.join("reached")).unwrap(), b"reached");
    assert!(child.0.try_wait().unwrap().is_none());
    child.0.kill().unwrap();
    assert!(!child.wait().success(), "termination must be abnormal");
    (root, token)
}

fn verify_twice(root: &Path, token: &str, kind: &str, stage: Stage, mode: &str) {
    for pass in 0..2 {
        assert!(!root.join("verified").exists());
        assert!(
            spawn_child(root, token, kind, stage, mode).wait().success(),
            "fresh recovery failed: {kind}/{stage:?}/{mode}/{pass}"
        );
        assert_eq!(fs::read(root.join("verified")).unwrap(), mode.as_bytes());
        fs::remove_file(root.join("verified")).unwrap();
    }
}

#[test]
fn recovery_swap_survives_each_process_interruption() {
    for kind in ["plain", "encrypted"] {
        for stage in &STAGES[..6] {
            let (root, token) = interrupt(kind, *stage);
            verify_twice(&root, &token, kind, *stage, "verify");
        }
    }
}

#[test]
fn encrypted_restore_install_survives_each_process_interruption() {
    for stage in &STAGES[6..] {
        let (root, token) = interrupt("install", *stage);
        verify_twice(&root, &token, "install", *stage, "verify");
    }
}

#[test]
fn interrupted_swap_with_damaged_evidence_fails_closed_after_two_restarts() {
    for corrupt_manifest in [false, true] {
        let stage = Stage::SwapPrimary;
        let (root, token) = interrupt("encrypted", stage);
        let store = WorkspaceFileStore::new(root.join("workspace"));
        let damaged = if corrupt_manifest {
            store.recovery_swap_manifest_path()
        } else {
            store.recovery_swap_slot_path(WorkspaceFileSlot::Recovery)
        };
        fs::write(&damaged, b"synthetic damaged evidence").unwrap();
        let primary_before = fs::read(store.path(WorkspaceFileSlot::Primary)).unwrap();
        let recovery_before = fs::read(store.path(WorkspaceFileSlot::Recovery)).unwrap();
        verify_twice(&root, &token, "encrypted", stage, "reject");
        assert!(store.recovery_swap_directory().is_dir());
        assert!(fs::read(store.path(WorkspaceFileSlot::Primary)).unwrap() == primary_before);
        assert!(fs::read(store.path(WorkspaceFileSlot::Recovery)).unwrap() == recovery_before);
        assert_eq!(fs::read(damaged).unwrap(), b"synthetic damaged evidence");
    }
}

#[test]
#[ignore = "only the CI parent spawns this test with an owned temporary directory"]
fn crash_child() {
    let runner = hosted_runner();
    let root = fs::canonicalize(std::env::var_os("LI_CRASH_ROOT").unwrap()).unwrap();
    let token = std::env::var("LI_CRASH_TOKEN").unwrap();
    uuid::Uuid::parse_str(&token).unwrap();
    assert_eq!(root.parent(), Some(runner.as_path()));
    assert_eq!(root, runner.join(format!("linked-info-recovery-crash-{token}")));
    assert_eq!(fs::read(root.join("owner")).unwrap(), token.as_bytes());
    let stage_name = std::env::var("LI_CRASH_STAGE").unwrap();
    let stage = *STAGES
        .iter()
        .find(|s| format!("{s:?}") == stage_name)
        .unwrap();
    let kind = std::env::var("LI_CRASH_KIND").unwrap();
    assert!(["plain", "encrypted", "install"].contains(&kind.as_str()));
    let mode = std::env::var("LI_CRASH_MODE").unwrap();
    assert!(["mutate", "verify", "reject"].contains(&mode.as_str()));
    let store = WorkspaceFileStore::new(root.join("workspace"));
    let original = fixture("original");
    let incoming = fixture("incoming");
    let key = (kind == "encrypted").then_some(&KEY);
    if mode == "mutate" {
        assert!(!store.base_directory.exists());
        store
            .write(WorkspaceFileSlot::Primary, &original, key)
            .unwrap();
        store
            .write(WorkspaceFileSlot::Recovery, &incoming, key)
            .unwrap();
        STOP_AT.with_borrow_mut(|armed| *armed = Some((store.base_directory.clone(), stage)));
        if kind == "install" {
            let metadata = create_vault_metadata(PASSWORD, &KEY, Vec::new()).unwrap();
            let mut payload: serde_json::Value = serde_json::from_str(&incoming).unwrap();
            payload.as_object_mut().unwrap().remove("version");
            let export = serde_json::json!({
                "format": WORKSPACE_EXPORT_FORMAT,
                "version": CURRENT_WORKSPACE_STORAGE_VERSION,
                "exportedAt": "2026-10-13T00:00:00.000Z", "workspace": payload
            });
            let encrypted = encrypt_export(&export.to_string(), &metadata, &KEY).unwrap();
            let (envelope, data_key, _) = open_encrypted_export(&encrypted, PASSWORD).unwrap();
            install_prepared_workspace_restore(
                &store,
                PreparedWorkspaceRestore {
                    id: uuid::Uuid::new_v4(),
                    expires_at_milliseconds: u64::MAX,
                    envelope,
                    data_key: Zeroizing::new(data_key),
                },
            )
            .unwrap();
        } else {
            prepare_workspace_recovery_swap(&store, key).unwrap();
            finish_pending_workspace_recovery_swap(&store).unwrap();
        }
        panic!("requested checkpoint was not reached");
    }
    if mode == "reject" {
        assert!(recover_pending_migration(&store).is_err());
        assert!(recover_before_prepared_restore(&store));
        fs::write(root.join("verified"), mode.as_bytes()).unwrap();
        return;
    }
    recover_pending_migration(&store).unwrap();
    let committed = !matches!(
        stage,
        Stage::SwapPreparedPrimary
            | Stage::SwapPreparedRecovery
            | Stage::InstallPreparedPrimary
            | Stage::InstallPreparedRecovery
    );
    let key = if kind == "install" && committed {
        let metadata = store.read_vault_metadata().unwrap().unwrap();
        assert!(metadata.system_unlock.is_none());
        assert!(unwrap_data_key(&metadata, PASSWORD).unwrap() == KEY);
        Some(&KEY)
    } else {
        if kind == "install" {
            assert!(!store.encryption_configured());
        }
        key
    };
    let (expected_primary, expected_recovery) = if committed {
        (&incoming, &original)
    } else {
        (&original, &incoming)
    };
    for (slot, expected) in [
        (WorkspaceFileSlot::Primary, expected_primary),
        (WorkspaceFileSlot::Recovery, expected_recovery),
    ] {
        let actual = store.read(slot, key).unwrap().unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(&actual).unwrap()
                == serde_json::from_str::<serde_json::Value>(expected).unwrap()
        );
    }
    assert!(!store.recovery_swap_directory().exists());
    fs::write(root.join("verified"), mode.as_bytes()).unwrap();
}
