use super::*;
use crate::offsite_backup::tests::roundtrip_retention_plan;
use crate::s3_backup_target::test_service::Service;
use linked_info_backup_port::{
    BackupDeleteOutcome, BackupSnapshot, BackupTarget, BackupTargetError,
};

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        if self.0.exists() {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
}

#[test]
fn encrypted_s3_roundtrip_restores_without_source_vault_and_preserves_protected_snapshots() {
    tauri::async_runtime::block_on(async {
        let scratch = Scratch(test_directory());
        let source = WorkspaceFileStore::new(scratch.0.join("source"));
        let destination = WorkspaceFileStore::new(scratch.0.join("fresh-device"));
        let key = random_array::<DATA_KEY_BYTES>().unwrap();
        let password = "synthetic recovery password";
        let metadata = create_vault_metadata(password, &key, Vec::new()).unwrap();
        source
            .write(
                WorkspaceFileSlot::Primary,
                &workspace("before-edit"),
                Some(&key),
            )
            .unwrap();

        let mut export: serde_json::Value =
            serde_json::from_str(&workspace_export("synthetic-account")).unwrap();
        let data = &mut export["workspace"];
        data["nodes"][0]["content"] = serde_json::json!("synthetic-secret-only-for-ci");
        data["nodes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "22222222-2222-4222-8222-222222222222",
                "name": "synthetic-service", "content": "synthetic subscription"
            }));
        data["references"] = serde_json::json!([{
            "sourceNodeId": "11111111-1111-4111-8111-111111111111",
            "targetNodeId": "22222222-2222-4222-8222-222222222222"
        }]);
        data["view"]["canvases"][0]["layout"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "nodeId": "22222222-2222-4222-8222-222222222222", "x": 340, "y": 70
            }));
        let export = export.to_string();
        let expected = workspace_storage_from_export(&export).unwrap();
        source
            .write(WorkspaceFileSlot::Primary, &expected, Some(&key))
            .unwrap();
        assert_eq!(
            source.read(WorkspaceFileSlot::Primary, Some(&key)).unwrap(),
            Some(expected.clone())
        );
        let source_bytes = fs::read(source.path(WorkspaceFileSlot::Primary)).unwrap();
        let encrypted = encrypt_export(&export, &metadata, &key).unwrap();
        assert!(!encrypted.contains("synthetic-secret-only-for-ci"));

        let service = Service::start();
        let target = service.target();
        let day = 24 * 60 * 60 * 1_000;
        let now = 200 * day;
        let proof = BackupSnapshot::new(
            uuid::Uuid::new_v4(),
            now - 40 * day,
            encrypted.clone().into_bytes(),
        )
        .unwrap();
        let expired = BackupSnapshot::new(
            uuid::Uuid::new_v4(),
            now - 35 * day,
            encrypted.clone().into_bytes(),
        )
        .unwrap();
        let latest =
            BackupSnapshot::new(uuid::Uuid::new_v4(), now, encrypted.clone().into_bytes()).unwrap();
        for snapshot in [&proof, &expired, &latest] {
            target.upload(snapshot.clone()).await.unwrap();
        }
        assert_eq!(target.list(None, 100).await.unwrap().items.len(), 3);
        assert_eq!(
            target
                .verify(proof.metadata.id)
                .await
                .unwrap()
                .downloaded_bytes,
            proof.metadata.size_bytes
        );

        let downloaded = target.download(proof.metadata.id).await.unwrap().unwrap();
        let ciphertext = String::from_utf8(downloaded.payload).unwrap();
        assert!(open_encrypted_export(&ciphertext, "incorrect synthetic password").is_err());
        assert!(!destination.base_directory.exists());
        let (envelope, opened_key, preview) = open_encrypted_export(&ciphertext, password).unwrap();
        assert_eq!(preview, export);
        let installed_key = install_prepared_workspace_restore(
            &destination,
            PreparedWorkspaceRestore {
                id: uuid::Uuid::new_v4(),
                expires_at_milliseconds: u64::MAX,
                envelope,
                data_key: Zeroizing::new(opened_key),
            },
        )
        .unwrap();
        let restored_metadata = destination.read_vault_metadata().unwrap().unwrap();
        let reopened_key = unwrap_data_key(&restored_metadata, password).unwrap();
        assert_eq!(reopened_key, installed_key);
        assert!(restored_metadata.system_unlock.is_none());
        assert_eq!(
            destination
                .read(WorkspaceFileSlot::Primary, Some(&reopened_key))
                .unwrap(),
            Some(expected)
        );
        let restored_bytes = fs::read(destination.path(WorkspaceFileSlot::Primary)).unwrap();

        service.interrupt_next_upload();
        let interrupted =
            BackupSnapshot::new(uuid::Uuid::new_v4(), now + 1, encrypted.into_bytes()).unwrap();
        assert!(target.upload(interrupted.clone()).await.is_err());
        assert!(
            target
                .download(interrupted.metadata.id)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(target.list(None, 100).await.unwrap().items.len(), 3);
        service.corrupt_next_download();
        assert!(matches!(
            target.download(latest.metadata.id).await,
            Err(BackupTargetError::IntegrityFailure)
        ));
        assert_eq!(
            target
                .download(latest.metadata.id)
                .await
                .unwrap()
                .unwrap()
                .payload,
            latest.payload
        );

        let listing = target.list(None, 100).await.unwrap().items;
        assert!(roundtrip_retention_plan(listing.clone(), uuid::Uuid::new_v4(), now).is_err());
        let candidates = roundtrip_retention_plan(listing, proof.metadata.id, now).unwrap();
        assert_eq!(
            candidates.iter().map(|item| item.id).collect::<Vec<_>>(),
            vec![expired.metadata.id]
        );
        for candidate in candidates {
            assert_eq!(
                target.delete_with_verification(candidate.id).await.unwrap(),
                BackupDeleteOutcome::Deleted {
                    removed_versions: 1
                }
            );
        }
        assert!(
            target
                .download(expired.metadata.id)
                .await
                .unwrap()
                .is_none()
        );
        for protected in [&proof, &latest] {
            assert_eq!(
                target
                    .download(protected.metadata.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .payload,
                protected.payload
            );
        }
        assert_eq!(target.list(None, 100).await.unwrap().items.len(), 2);
        assert_eq!(
            fs::read(source.path(WorkspaceFileSlot::Primary)).unwrap(),
            source_bytes
        );
        assert_eq!(
            fs::read(destination.path(WorkspaceFileSlot::Primary)).unwrap(),
            restored_bytes
        );
    });
}
