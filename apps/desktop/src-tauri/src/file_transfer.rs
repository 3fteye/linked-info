use serde::Serialize;
use std::{ffi::OsStr, fs, path::Path};
use tauri_plugin_dialog::DialogExt;

const MAXIMUM_TRANSFER_BYTES: usize = 256 * 1024 * 1024;
const MAXIMUM_DOCUMENT_IMPORT_BYTES: u64 = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedWorkspaceFile {
    name: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDocumentFile {
    name: String,
    text: String,
}

fn validate_suggested_name(name: &str) -> Result<(), String> {
    let path = Path::new(name);
    if name.is_empty()
        || name.len() > 180
        || path.file_name() != Some(OsStr::new(name))
        || path.extension() != Some(OsStr::new("json"))
    {
        return Err("workspace_transfer_invalid_suggested_name".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub async fn export_workspace_transfer(
    app: tauri::AppHandle,
    text: String,
    suggested_name: String,
) -> Result<bool, String> {
    validate_suggested_name(&suggested_name)?;
    if text.len() > MAXIMUM_TRANSFER_BYTES {
        return Err("workspace_transfer_too_large".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selection) = app
            .dialog()
            .file()
            .add_filter("JSON", &["json"])
            .set_file_name(suggested_name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = selection
            .into_path()
            .map_err(|_| "workspace_transfer_invalid_path".to_owned())?;
        crate::workspace_file::write_atomically(&path, text.as_bytes())
            .map_err(|error| error.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn import_workspace_transfer(
    app: tauri::AppHandle,
) -> Result<Option<ImportedWorkspaceFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selection) = app
            .dialog()
            .file()
            .add_filter("JSON", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = selection
            .into_path()
            .map_err(|_| "workspace_transfer_invalid_path".to_owned())?;
        let size = fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .len();
        if size > MAXIMUM_TRANSFER_BYTES as u64 {
            return Err("workspace_transfer_too_large".to_owned());
        }
        let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .ok_or_else(|| "workspace_transfer_invalid_path".to_owned())?;
        Ok(Some(ImportedWorkspaceFile { name, text }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn import_text_document(
    app: tauri::AppHandle,
    vault_state: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
) -> Result<Option<ImportedDocumentFile>, String> {
    let permit = crate::workspace_file::begin_workspace_access(&app, &vault_state)?;
    let dialog_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let Some(selection) = dialog_app
            .dialog()
            .file()
            .add_filter("Text", &["txt", "md", "markdown"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = selection
            .into_path()
            .map_err(|_| "document_import_invalid_path".to_owned())?;
        let size = fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .len();
        if size > MAXIMUM_DOCUMENT_IMPORT_BYTES {
            return Err("document_import_too_large".to_owned());
        }
        let extension = path
            .extension()
            .and_then(OsStr::to_str)
            .map(str::to_ascii_lowercase);
        if !matches!(extension.as_deref(), Some("txt" | "md" | "markdown")) {
            return Err("document_import_unsupported_type".to_owned());
        }
        let text =
            fs::read_to_string(&path).map_err(|_| "document_import_invalid_utf8".to_owned())?;
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .ok_or_else(|| "document_import_invalid_path".to_owned())?;
        Ok(Some(ImportedDocumentFile { name, text }))
    })
    .await
    .map_err(|error| error.to_string())??;
    crate::workspace_file::ensure_workspace_access(&app, &vault_state, permit)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggested_export_names_cannot_escape_the_dialog_directory() {
        assert!(validate_suggested_name("linked-info-2026-08-12.json").is_ok());
        assert!(validate_suggested_name("../workspace.json").is_err());
        assert!(validate_suggested_name("workspace.txt").is_err());
    }

    #[test]
    fn document_import_limit_is_smaller_than_workspace_transfer_limit() {
        assert!(MAXIMUM_DOCUMENT_IMPORT_BYTES < MAXIMUM_TRANSFER_BYTES as u64);
    }
}
