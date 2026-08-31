use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

pub const BACKUP_CONTENT_TYPE: &str = "application/vnd.linked-info.encrypted-workspace-export+json";
pub const DEFAULT_BACKUP_PAGE_LIMIT: u16 = 50;
pub const MAX_BACKUP_PAGE_LIMIT: u16 = 200;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTargetCapabilities {
    pub maximum_upload_bytes: Option<u64>,
    pub supports_delete: bool,
}

/// Describes which remote object versions a target can remove and verify.
///
/// Object-store providers often expose a current-object delete even when
/// bucket versioning keeps older versions and delete markers. The distinction
/// is part of the provider-neutral port so a caller cannot infer a complete
/// deletion from a successful HTTP DELETE alone.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupDeleteCapability {
    /// The target cannot delete snapshots.
    #[default]
    Unsupported,
    /// The target can delete the current object, but cannot prove that older
    /// versions or delete markers are gone.
    CurrentObjectOnly,
    /// The target can enumerate and remove all versions and delete markers,
    /// then verify that none remain.
    AllVersions,
}

/// Result of a deletion operation that explicitly reports its verification
/// boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupDeleteOutcome {
    /// No matching snapshot was present at the time of the final check.
    NotFound,
    /// All discovered object versions and delete markers were removed and a
    /// subsequent version listing confirmed that none remain.
    Deleted { removed_versions: u32 },
    /// The target could not prove complete deletion. `removed_versions` is the
    /// number of version records removed before verification became
    /// impossible; it must never be interpreted as a complete deletion.
    Unverified { removed_versions: u32 },
}

impl BackupDeleteOutcome {
    pub fn is_verified(&self) -> bool {
        matches!(self, Self::NotFound | Self::Deleted { .. })
    }
}

/// Result of purging every application-owned remote snapshot, including
/// historical object versions and delete markers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupPurgeOutcome {
    /// The application-owned version records are gone, and a final version
    /// listing confirmed the empty state.
    Deleted { removed_versions: u32 },
    /// The provider could not prove a complete purge. The count is only a
    /// progress indicator and must not be interpreted as a success.
    Unverified { removed_versions: u32 },
}

impl BackupPurgeOutcome {
    pub fn is_verified(&self) -> bool {
        matches!(self, Self::Deleted { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupVerification {
    pub metadata: BackupSnapshotMetadata,
    pub downloaded_bytes: u64,
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
    #[error("backup operation was cancelled before the next remote step")]
    Cancelled,
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

/// A caller-owned guard for long-running backup operations.
///
/// Implementations should invalidate the guard when the workspace is locked,
/// the authorization generation changes, or the caller otherwise wants to
/// stop a destructive operation. Targets call `check` before every network
/// step; a step already in flight may finish, but no subsequent step may
/// start after invalidation is observed.
pub trait BackupOperationGuard: Send + Sync {
    fn check(&self) -> Result<(), BackupTargetError>;
}

/// A provider-neutral target for opaque, client-encrypted workspace snapshots.
///
/// Implementations must verify downloaded bytes locally before returning a
/// successful `verify` result. Provider-reported metadata alone is not enough.
pub trait BackupTarget: Send + Sync {
    fn capabilities(&self) -> BackupTargetCapabilities;

    /// Returns the strongest deletion guarantee this target can provide.
    ///
    /// This is a trait method instead of another required capabilities field
    /// so existing adapters that construct `BackupTargetCapabilities` remain
    /// source-compatible. Callers removing a target or claiming that data is
    /// gone must still use [`Self::delete_with_verification`] or
    /// [`Self::purge_with_verification`] and inspect the returned outcome.
    fn delete_capability(&self) -> BackupDeleteCapability {
        if self.capabilities().supports_delete {
            BackupDeleteCapability::CurrentObjectOnly
        } else {
            BackupDeleteCapability::Unsupported
        }
    }

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

    /// Deletes a snapshot and reports whether all provider versions and delete
    /// markers were verified absent afterwards.
    ///
    /// The default keeps older adapters source-compatible but deliberately
    /// returns `Unverified`; a provider must opt in with an implementation
    /// that can enumerate its complete deletion surface.
    fn delete_with_verification<'a>(
        &'a self,
        id: Uuid,
    ) -> BackupTargetFuture<'a, BackupDeleteOutcome> {
        Box::pin(async move {
            let found = self.delete(id).await?;
            Ok(BackupDeleteOutcome::Unverified {
                removed_versions: u32::from(found),
            })
        })
    }

    /// Guarded variant for callers that must stop between remote steps when
    /// the workspace session is revoked.
    fn delete_with_verification_guarded<'a>(
        &'a self,
        id: Uuid,
        guard: &'a dyn BackupOperationGuard,
    ) -> BackupTargetFuture<'a, BackupDeleteOutcome> {
        Box::pin(async move {
            guard.check()?;
            self.delete_with_verification(id).await
        })
    }

    /// Purges all snapshots owned by this application and reports whether the
    /// provider's complete version surface was verified empty.
    ///
    /// This is intentionally separate from iterating [`Self::list`] followed
    /// by [`Self::delete`]: a versioned object store can hide snapshots whose
    /// latest record is a delete marker. The default keeps older adapters
    /// source-compatible but refuses to claim a complete purge.
    fn purge_with_verification<'a>(&'a self) -> BackupTargetFuture<'a, BackupPurgeOutcome> {
        Box::pin(async {
            Ok(BackupPurgeOutcome::Unverified {
                removed_versions: 0,
            })
        })
    }

    /// Guarded variant for a potentially long, destructive purge.
    fn purge_with_verification_guarded<'a>(
        &'a self,
        guard: &'a dyn BackupOperationGuard,
    ) -> BackupTargetFuture<'a, BackupPurgeOutcome> {
        Box::pin(async move {
            guard.check()?;
            self.purge_with_verification().await
        })
    }

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
        fn accept_target(target: &dyn BackupTarget) {
            let _ = target.delete_capability();
            drop(target.delete_with_verification(Uuid::nil()));
            drop(target.purge_with_verification());
        }

        let _ = accept_target;
    }

    #[test]
    fn operation_guard_can_cancel_between_remote_steps() {
        struct TestGuard(std::sync::atomic::AtomicBool);

        impl BackupOperationGuard for TestGuard {
            fn check(&self) -> Result<(), BackupTargetError> {
                if self.0.load(std::sync::atomic::Ordering::Acquire) {
                    Err(BackupTargetError::Cancelled)
                } else {
                    Ok(())
                }
            }
        }

        let guard = TestGuard(std::sync::atomic::AtomicBool::new(false));
        assert_eq!(guard.check(), Ok(()));
        guard.0.store(true, std::sync::atomic::Ordering::Release);
        assert_eq!(guard.check(), Err(BackupTargetError::Cancelled));
    }

    #[test]
    fn unverified_delete_is_not_a_complete_success() {
        let outcome = BackupDeleteOutcome::Unverified {
            removed_versions: 1,
        };

        assert!(!outcome.is_verified());
    }

    #[test]
    fn not_found_delete_is_verified_empty_state() {
        let outcome = BackupDeleteOutcome::NotFound;

        assert!(outcome.is_verified());
    }

    #[test]
    fn unverified_purge_is_not_a_complete_success() {
        let outcome = BackupPurgeOutcome::Unverified {
            removed_versions: 2,
        };

        assert!(!outcome.is_verified());
    }
}
