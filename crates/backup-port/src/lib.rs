use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

pub const BACKUP_API_VERSION: u16 = 1;
pub const BACKUP_CONTENT_TYPE: &str = "application/vnd.linked-info.encrypted-workspace-export+json";
pub const DEFAULT_BACKUP_PAGE_LIMIT: u16 = 50;
pub const MAX_BACKUP_PAGE_LIMIT: u16 = 200;

pub mod headers {
    pub const CREATED_AT_MS: &str = "x-linked-info-created-at-ms";
    pub const SHA256: &str = "x-linked-info-sha256";
    pub const SNAPSHOT_ID: &str = "x-linked-info-snapshot-id";
}

pub mod routes {
    pub const HEALTH: &str = "/v1/health";
    pub const BACKUPS: &str = "/v1/backups";
    pub const BACKUP: &str = "/v1/backups/:snapshot_id";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshotMetadata {
    pub id: Uuid,
    pub created_at_ms: u64,
    pub size_bytes: u64,
    pub sha256: String,
}

impl BackupSnapshotMetadata {
    pub fn validate(&self) -> Result<(), BackupContractError> {
        if self.created_at_ms == 0 || self.size_bytes == 0 || !is_sha256(&self.sha256) {
            return Err(BackupContractError::InvalidMetadata);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupSnapshot {
    pub metadata: BackupSnapshotMetadata,
    pub payload: Vec<u8>,
}

impl BackupSnapshot {
    pub fn new(
        id: Uuid,
        created_at_ms: u64,
        payload: Vec<u8>,
    ) -> Result<Self, BackupContractError> {
        let size_bytes =
            u64::try_from(payload.len()).map_err(|_| BackupContractError::PayloadTooLarge)?;
        let metadata = BackupSnapshotMetadata {
            id,
            created_at_ms,
            size_bytes,
            sha256: sha256_hex(&payload),
        };
        metadata.validate()?;
        Ok(Self { metadata, payload })
    }

    pub fn from_parts(
        metadata: BackupSnapshotMetadata,
        payload: Vec<u8>,
    ) -> Result<Self, BackupContractError> {
        metadata.validate()?;
        if metadata.size_bytes != payload.len() as u64 {
            return Err(BackupContractError::SizeMismatch);
        }
        if sha256_hex(&payload) != metadata.sha256 {
            return Err(BackupContractError::HashMismatch);
        }
        Ok(Self { metadata, payload })
    }

    pub fn verify_integrity(&self) -> Result<(), BackupContractError> {
        self.metadata.validate()?;
        if self.metadata.size_bytes != self.payload.len() as u64 {
            return Err(BackupContractError::SizeMismatch);
        }
        if sha256_hex(&self.payload) != self.metadata.sha256 {
            return Err(BackupContractError::HashMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupListPage {
    pub items: Vec<BackupSnapshotMetadata>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackupTargetCapabilities {
    pub maximum_upload_bytes: Option<u64>,
    pub supports_delete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupVerification {
    pub metadata: BackupSnapshotMetadata,
    pub downloaded_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupApiErrorCode {
    Unauthorized,
    InvalidRequest,
    SnapshotNotFound,
    SnapshotConflict,
    PayloadTooLarge,
    StorageFailure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupApiErrorResponse {
    pub code: BackupApiErrorCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum BackupContractError {
    #[error("backup metadata is invalid")]
    InvalidMetadata,
    #[error("backup payload is too large")]
    PayloadTooLarge,
    #[error("backup payload size does not match its metadata")]
    SizeMismatch,
    #[error("backup payload hash does not match its metadata")]
    HashMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum BackupTargetError {
    #[error("backup target authorization failed")]
    Unauthorized,
    #[error("backup target rejected the request")]
    InvalidRequest,
    #[error("backup snapshot was not found")]
    NotFound,
    #[error("backup snapshot already exists with different contents")]
    Conflict,
    #[error("backup payload exceeds the target limit")]
    PayloadTooLarge,
    #[error("backup target is unavailable")]
    Unavailable,
    #[error("backup target returned an invalid response")]
    InvalidResponse,
    #[error("downloaded backup failed integrity verification")]
    IntegrityFailure,
}

pub type BackupTargetFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, BackupTargetError>> + Send + 'a>>;

/// A provider-neutral target for opaque, client-encrypted workspace snapshots.
///
/// Implementations must verify downloaded bytes locally before returning a
/// successful `verify` result. Provider-reported metadata alone is not enough.
pub trait BackupTarget: Send + Sync {
    fn capabilities(&self) -> BackupTargetCapabilities;

    fn upload<'a>(
        &'a self,
        snapshot: BackupSnapshot,
    ) -> BackupTargetFuture<'a, BackupSnapshotMetadata>;

    fn list<'a>(
        &'a self,
        cursor: Option<String>,
        limit: u16,
    ) -> BackupTargetFuture<'a, BackupListPage>;

    fn download<'a>(&'a self, id: Uuid) -> BackupTargetFuture<'a, Option<BackupSnapshot>>;

    fn delete<'a>(&'a self, id: Uuid) -> BackupTargetFuture<'a, bool>;

    fn verify<'a>(&'a self, id: Uuid) -> BackupTargetFuture<'a, BackupVerification>;
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_constructor_binds_size_and_hash_to_payload() {
        let snapshot = BackupSnapshot::new(Uuid::new_v4(), 42, b"ciphertext".to_vec()).unwrap();

        assert_eq!(snapshot.metadata.size_bytes, 10);
        assert_eq!(snapshot.metadata.sha256, sha256_hex(b"ciphertext"));
        assert_eq!(snapshot.verify_integrity(), Ok(()));
    }

    #[test]
    fn downloaded_snapshot_rejects_tampered_payload() {
        let snapshot = BackupSnapshot::new(Uuid::new_v4(), 42, b"ciphertext".to_vec()).unwrap();

        assert_eq!(
            BackupSnapshot::from_parts(snapshot.metadata, b"tampered".to_vec()),
            Err(BackupContractError::SizeMismatch)
        );
    }

    #[test]
    fn metadata_requires_lowercase_sha256() {
        let metadata = BackupSnapshotMetadata {
            id: Uuid::new_v4(),
            created_at_ms: 42,
            size_bytes: 1,
            sha256: "A".repeat(64),
        };

        assert_eq!(
            metadata.validate(),
            Err(BackupContractError::InvalidMetadata)
        );
    }

    #[test]
    fn target_trait_is_object_safe() {
        fn accept_target(_: &dyn BackupTarget) {}

        let _ = accept_target;
    }
}
