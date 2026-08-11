mod embedding;
mod llm;
mod vector_cache;
mod workspace_file;

#[cfg(desktop)]
use tauri::Manager;

#[tauri::command]
fn exit_application(
    app: tauri::AppHandle,
    embedding_state: tauri::State<'_, embedding::EmbeddingState>,
    llm_state: tauri::State<'_, llm::LlmState>,
    vault_state: tauri::State<'_, workspace_file::WorkspaceVaultState>,
) {
    let _ = embedding_state.shutdown();
    llm_state.shutdown();
    vault_state.shutdown();
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .manage(embedding::EmbeddingState::default())
        .manage(llm::LlmState::default())
        .manage(vector_cache::VectorCacheState::default())
        .manage(workspace_file::WorkspaceVaultState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            embedding::cancel_local_embedding_download,
            embedding::embed_local_texts,
            embedding::embed_remote_texts,
            embedding::inspect_local_embedding_models,
            embedding::prepare_local_embedding_model,
            llm::cancel_local_llm_download,
            llm::inspect_local_llm_models,
            llm::prepare_local_llm_model,
            llm::review_local_references,
            llm::stop_local_llm,
            vector_cache::clear_embedding_vector_cache,
            vector_cache::inspect_embedding_vector_cache,
            vector_cache::read_embedding_vector_cache,
            vector_cache::write_embedding_vector_cache,
            exit_application,
            workspace_file::change_workspace_password,
            workspace_file::decrypt_workspace_export,
            workspace_file::enable_workspace_encryption,
            workspace_file::encrypt_workspace_export,
            workspace_file::inspect_workspace_security,
            workspace_file::lock_workspace,
            workspace_file::read_workspace_file,
            workspace_file::unlock_workspace,
            workspace_file::write_workspace_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
