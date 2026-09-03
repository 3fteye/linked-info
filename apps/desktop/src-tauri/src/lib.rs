mod capsule;
mod embedding;
mod extension_manager;
mod extension_runtime;
mod extension_runtime_content;
mod file_transfer;
mod llm;
mod managed_extension_runtime;
mod offsite_backup;
mod s3_backup_target;
mod secret_clipboard;
mod smart_reference_cache;
mod system_unlock;
mod vector_cache;
#[cfg(windows)]
mod windows_session;
mod workspace_file;

use tauri::Manager;

fn prepare_application_shutdown(app: &tauri::AppHandle) {
    let embedding_state = app.state::<embedding::EmbeddingState>();
    let extension_runtime_state = app.state::<extension_runtime::ExtensionRuntimeState>();
    let llm_state = app.state::<llm::LlmState>();
    let vault_state = app.state::<workspace_file::WorkspaceVaultState>();
    // Revoke plaintext authority before waiting for any model or extension
    // process cleanup. Application exit is not an exception to lock ordering.
    workspace_file::run_workspace_lock_transition(
        || {
            extension_runtime_state
                .revoke_all(vault_state.next_access_generation().unwrap_or(u64::MAX));
            vault_state.shutdown();
            capsule::revoke(app);
        },
        || secret_clipboard::clear_active(app),
        || {
            extension_runtime_state.shutdown();
            let _ = embedding_state.shutdown();
            llm_state.shutdown();
        },
    );
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle) {
    prepare_application_shutdown(&app);
    app.exit(0);
}

#[tauri::command]
async fn restart_application(app: tauri::AppHandle) -> Result<(), String> {
    // Tauri's restart waits for Exit on a non-main thread. Keep both model
    // cleanup and that wait off the window event loop; a WebView reload cannot
    // release the process-level persistence quarantine.
    tauri::async_runtime::spawn_blocking(move || -> () {
        prepare_application_shutdown(&app);
        app.restart();
    })
    .await
    .map_err(|_| "application_restart_failed".to_owned())
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
        .manage(capsule::CapsuleState::default())
        .manage(embedding::EmbeddingState::default())
        .manage(extension_runtime::ExtensionRuntimeState::default())
        .manage(extension_manager::ExtensionManagerState::default())
        .manage(llm::LlmState::default())
        .manage(offsite_backup::OffsiteBackupState::default())
        .manage(secret_clipboard::SecretClipboardState::default())
        .manage(smart_reference_cache::SmartReferenceCacheState::default())
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
        .invoke_handler(|invoke| {
            let webview = invoke.message.webview_ref();
            if !capsule::command_allowed(
                webview.window().label(),
                webview.label(),
                invoke.message.command(),
            ) {
                invoke.resolver.reject("capsule_command_forbidden");
                return true;
            }
            let handler = tauri::generate_handler![
            capsule::open_workspace_owner,
            capsule::close_workspace_owner,
            capsule::set_workspace_owner_ready,
            capsule::inspect_capsule,
            capsule::submit_capsule_note,
            capsule::inspect_capsule_submission,
            capsule::take_capsule_note,
            capsule::commit_capsule_note,
            capsule::reject_capsule_note,
            capsule::open_capsule_window,
            capsule::set_capsule_expanded,
            capsule::hide_capsule_window,
            capsule::focus_main_window,
            capsule::drag_capsule_window,
            capsule::capsule_record_activity,
            embedding::cancel_local_embedding_download,
            embedding::embed_local_texts,
            embedding::embed_remote_texts,
            embedding::inspect_local_embedding_models,
            embedding::prepare_local_embedding_model,
            file_transfer::export_workspace_transfer,
            file_transfer::import_document_draft,
            file_transfer::import_workspace_transfer,
            file_transfer::import_text_document,
            extension_manager::choose_extension_install,
            extension_manager::commit_extension_install,
            extension_manager::inspect_installed_extensions,
            extension_manager::migrate_prepared_extension_metadata,
            extension_manager::recover_pending_extension_upgrades,
            extension_manager::set_extension_enabled,
            extension_manager::uninstall_extension,
            llm::cancel_local_llm_download,
            llm::extract_local_document_import,
            llm::inspect_local_llm_models,
            llm::prepare_local_llm_model,
            managed_extension_runtime::invoke_managed_extension_action,
            managed_extension_runtime::render_managed_extension_processor,
            llm::review_local_references,
            llm::stop_local_llm,
            offsite_backup::configure_s3_backup_target,
            offsite_backup::create_offsite_backup,
            offsite_backup::delete_all_offsite_backups_and_remove_target,
            offsite_backup::delete_offsite_backup,
            offsite_backup::download_s3_recovery_backup,
            offsite_backup::download_offsite_backup,
            offsite_backup::inspect_offsite_backup_targets,
            offsite_backup::list_s3_recovery_backups,
            offsite_backup::list_offsite_backups,
            offsite_backup::mark_automatic_offsite_backup_pending,
            offsite_backup::remove_offsite_backup_target,
            offsite_backup::run_due_automatic_offsite_backups,
            offsite_backup::test_offsite_backup_restore,
            offsite_backup::update_offsite_backup_automatic_settings,
            offsite_backup::update_offsite_backup_retention_settings,
            offsite_backup::update_s3_backup_target,
            offsite_backup::verify_offsite_backup,
            secret_clipboard::copy_secret_to_clipboard,
            secret_clipboard::inspect_secret_clipboard,
            smart_reference_cache::clear_smart_reference_result_cache,
            smart_reference_cache::inspect_smart_reference_result_cache,
            smart_reference_cache::read_smart_reference_result_cache,
            smart_reference_cache::write_smart_reference_result_cache,
            vector_cache::clear_embedding_vector_cache,
            vector_cache::inspect_embedding_vector_cache,
            vector_cache::read_embedding_vector_cache,
            vector_cache::write_embedding_vector_cache,
            workspace_file::capture_workspace_backup,
            workspace_file::cancel_workspace_restore,
            workspace_file::clear_workspace_recovery_data,
            workspace_file::commit_workspace_restore,
            exit_application,
            restart_application,
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
            workspace_file::swap_workspace_recovery_files,
            workspace_file::unlock_workspace,
            workspace_file::unlock_workspace_with_system,
            workspace_file::write_workspace_file
            ];
            handler(invoke)
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
