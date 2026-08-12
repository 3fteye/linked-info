mod cloudflare_backup_target;
mod embedding;
mod file_transfer;
mod llm;
mod offsite_backup;
mod secret_clipboard;
mod system_unlock;
mod vector_cache;
#[cfg(windows)]
mod windows_session;
mod workspace_file;

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
    secret_clipboard::clear_active(&app);
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
        .manage(offsite_backup::OffsiteBackupState::default())
        .manage(secret_clipboard::SecretClipboardState::default())
        .manage(system_unlock::SystemUnlockState::default())
        .manage(vector_cache::VectorCacheState::default())
        .manage(workspace_file::WorkspaceVaultState::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(windows)]
            windows_session::register(app).map_err(std::io::Error::other)?;
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let should_lock = app_handle
                        .state::<workspace_file::WorkspaceVaultState>()
                        .should_idle_lock();
                    if should_lock {
                        workspace_file::lock_workspace_runtime(&app_handle, "idle_timeout");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            embedding::cancel_local_embedding_download,
            embedding::embed_local_texts,
            embedding::embed_remote_texts,
            embedding::inspect_local_embedding_models,
            embedding::prepare_local_embedding_model,
            file_transfer::export_workspace_transfer,
            file_transfer::import_workspace_transfer,
            llm::cancel_local_llm_download,
            llm::inspect_local_llm_models,
            llm::prepare_local_llm_model,
            llm::review_local_references,
            llm::stop_local_llm,
            offsite_backup::configure_cloudflare_backup_target,
            offsite_backup::create_offsite_backup,
            offsite_backup::download_cloudflare_recovery_backup,
            offsite_backup::download_offsite_backup,
            offsite_backup::inspect_offsite_backup_targets,
            offsite_backup::list_cloudflare_recovery_backups,
            offsite_backup::list_offsite_backups,
            offsite_backup::remove_offsite_backup_target,
            offsite_backup::verify_offsite_backup,
            secret_clipboard::copy_secret_to_clipboard,
            secret_clipboard::inspect_secret_clipboard,
            vector_cache::clear_embedding_vector_cache,
            vector_cache::inspect_embedding_vector_cache,
            vector_cache::read_embedding_vector_cache,
            vector_cache::write_embedding_vector_cache,
            workspace_file::capture_workspace_backup,
            workspace_file::cancel_workspace_restore,
            workspace_file::clear_workspace_recovery_data,
            workspace_file::commit_workspace_restore,
            exit_application,
            workspace_file::authorize_sensitive_operation,
            workspace_file::change_workspace_password,
            workspace_file::decrypt_workspace_export,
            workspace_file::disable_system_unlock,
            workspace_file::destroy_workspace,
            workspace_file::enable_system_unlock,
            workspace_file::enable_workspace_encryption,
            workspace_file::encrypt_workspace_export,
            workspace_file::inspect_workspace_security,
            workspace_file::inspect_workspace_backup_history,
            workspace_file::lock_workspace,
            workspace_file::prepare_workspace_restore,
            workspace_file::read_workspace_backup,
            workspace_file::read_workspace_file,
            workspace_file::record_workspace_activity,
            workspace_file::rotate_workspace_data_key,
            workspace_file::set_workspace_idle_timeout,
            workspace_file::unlock_workspace,
            workspace_file::unlock_workspace_with_system,
            workspace_file::write_workspace_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
