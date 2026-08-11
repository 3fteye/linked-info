use serde::Deserialize;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager};

#[cfg(unix)]
use std::fs::File;

const PRIMARY_FILE_NAME: &str = "workspace.v1.json";
const RECOVERY_FILE_NAME: &str = "workspace.recovery.v1.json";
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceFileSlot {
    Primary,
    Recovery,
}

impl WorkspaceFileSlot {
    fn file_name(self) -> &'static str {
        match self {
            Self::Primary => PRIMARY_FILE_NAME,
            Self::Recovery => RECOVERY_FILE_NAME,
        }
    }
}

struct WorkspaceFileStore {
    base_directory: PathBuf,
}

impl WorkspaceFileStore {
    fn new(base_directory: PathBuf) -> Self {
        Self { base_directory }
    }

    fn path(&self, slot: WorkspaceFileSlot) -> PathBuf {
        self.base_directory.join(slot.file_name())
    }

    fn read(&self, slot: WorkspaceFileSlot) -> io::Result<Option<String>> {
        match fs::read_to_string(self.path(slot)) {
            Ok(contents) => Ok(Some(contents)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn write(&self, slot: WorkspaceFileSlot, contents: &str) -> io::Result<()> {
        validate_storage_envelope(contents)?;
        fs::create_dir_all(&self.base_directory)?;
        write_atomically(&self.path(slot), contents.as_bytes())
    }
}

#[tauri::command]
pub async fn read_workspace_file(
    app: AppHandle,
    slot: WorkspaceFileSlot,
) -> Result<Option<String>, String> {
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || store.read(slot))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn write_workspace_file(
    app: AppHandle,
    slot: WorkspaceFileSlot,
    contents: String,
) -> Result<(), String> {
    let store = workspace_store(&app).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || store.write(slot, &contents))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

fn workspace_store(app: &AppHandle) -> io::Result<WorkspaceFileStore> {
    app.path()
        .app_data_dir()
        .map(WorkspaceFileStore::new)
        .map_err(io::Error::other)
}

fn validate_storage_envelope(contents: &str) -> io::Result<()> {
    let value: serde_json::Value = serde_json::from_str(contents)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if !value.is_object() || value.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "workspace storage envelope must use version 1",
        ));
    }
    Ok(())
}

fn write_atomically(target: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace file has no parent directory",
        )
    })?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "invalid workspace file name")
        })?;
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));

    let write_result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, target)?;
        sync_parent_directory(parent)
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory() -> PathBuf {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "linked-info-workspace-test-{}-{sequence}",
            std::process::id()
        ))
    }

    fn workspace(name: &str) -> String {
        serde_json::json!({
            "version": 1,
            "nodes": [{
                "id": "11111111-1111-4111-8111-111111111111",
                "name": name,
                "content": null
            }],
            "layout": [{
                "nodeId": "11111111-1111-4111-8111-111111111111",
                "x": 10,
                "y": 20
            }],
            "references": [],
            "viewport": null
        })
        .to_string()
    }

    #[test]
    fn writes_and_replaces_a_workspace_atomically() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let first = workspace("First");
        let second = workspace("Second");

        store.write(WorkspaceFileSlot::Primary, &first).unwrap();
        store.write(WorkspaceFileSlot::Primary, &second).unwrap();

        assert_eq!(
            store.read(WorkspaceFileSlot::Primary).unwrap(),
            Some(second)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_invalid_envelopes_without_overwriting_valid_data() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let original = workspace("Original");
        store.write(WorkspaceFileSlot::Primary, &original).unwrap();

        let error = store
            .write(WorkspaceFileSlot::Primary, r#"{"version":2}"#)
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            store.read(WorkspaceFileSlot::Primary).unwrap(),
            Some(original)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn keeps_primary_and_recovery_files_separate() {
        let directory = test_directory();
        let store = WorkspaceFileStore::new(directory.clone());
        let primary = workspace("Primary");
        let recovery = workspace("Recovery");

        store.write(WorkspaceFileSlot::Primary, &primary).unwrap();
        store.write(WorkspaceFileSlot::Recovery, &recovery).unwrap();

        assert_eq!(
            store.read(WorkspaceFileSlot::Primary).unwrap(),
            Some(primary)
        );
        assert_eq!(
            store.read(WorkspaceFileSlot::Recovery).unwrap(),
            Some(recovery)
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
