use std::time::SystemTime;

use aws_credential_types::Credentials;
use aws_sigv4::{
    http_request::{
        PayloadChecksumKind, PercentEncodingMode, SignableBody, SignableRequest, SigningParams,
        SigningSettings, UriPathNormalizationMode, sign,
    },
    sign::v4,
};
use linked_info_backup_port::{
    BACKUP_CONTENT_TYPE, BackupDeleteCapability, BackupDeleteOutcome, BackupListPage,
    BackupOperationGuard, BackupPurgeOutcome, BackupSnapshot, BackupSnapshotMetadata, BackupTarget,
    BackupTargetCapabilities, BackupTargetError, BackupTargetFuture, BackupVerification,
    MAX_BACKUP_PAGE_LIMIT,
};
use reqwest::{
    Client, Method, StatusCode, Url,
    header::{CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue},
    redirect::Policy,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

const DEFAULT_PREFIX: &str = "linked-info/v1";
const MAXIMUM_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
const MAXIMUM_LIST_RESPONSE_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT_SECONDS: u64 = 60;
const OBJECT_SUFFIX: &str = ".linked-info-backup";
const MAXIMUM_VERSION_ID_BYTES: usize = 1024;
const MAXIMUM_VERSIONS_TO_DELETE: usize = 4_096;
const MAXIMUM_DELETE_PASSES: usize = 3;

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct S3Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

pub struct S3BackupTarget {
    client: Client,
    endpoint: Url,
    region: String,
    bucket: String,
    prefix: String,
    credentials: S3Credentials,
}

fn check_operation_guard(
    guard: Option<&dyn BackupOperationGuard>,
) -> Result<(), BackupTargetError> {
    guard.map_or(Ok(()), BackupOperationGuard::check)
}

impl S3BackupTarget {
    pub fn new(
        endpoint: &str,
        region: &str,
        bucket: &str,
        prefix: &str,
        credentials: S3Credentials,
    ) -> Result<Self, BackupTargetError> {
        let endpoint = validate_endpoint(endpoint)?;
        let region = normalize_region(region)?;
        let bucket = normalize_bucket(bucket)?;
        let prefix = normalize_prefix(prefix)?;
        validate_credentials(&credentials)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
            .build()
            .map_err(|_| BackupTargetError::Unavailable)?;
        Ok(Self {
            client,
            endpoint,
            region,
            bucket,
            prefix,
            credentials,
        })
    }

    pub(crate) fn normalize_endpoint(endpoint: &str) -> Result<String, BackupTargetError> {
        validate_endpoint(endpoint).map(|url| url.to_string())
    }

    pub(crate) fn normalize_region(region: &str) -> Result<String, BackupTargetError> {
        normalize_region(region)
    }

    pub(crate) fn normalize_bucket(bucket: &str) -> Result<String, BackupTargetError> {
        normalize_bucket(bucket)
    }

    pub(crate) fn normalize_prefix(prefix: &str) -> Result<String, BackupTargetError> {
        normalize_prefix(prefix)
    }

    fn bucket_url(&self) -> Result<Url, BackupTargetError> {
        self.url_for_segments([self.bucket.as_str()])
    }

    fn object_url(&self, key: &str) -> Result<Url, BackupTargetError> {
        self.url_for_segments(std::iter::once(self.bucket.as_str()).chain(key.split('/')))
    }

    fn url_for_segments<'a>(
        &self,
        segments: impl IntoIterator<Item = &'a str>,
    ) -> Result<Url, BackupTargetError> {
        let mut url = self.endpoint.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| BackupTargetError::InvalidRequest)?;
            path.clear();
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }

    fn snapshot_directory(&self, id: Uuid) -> String {
        format!("{}/snapshots/{id}/", self.prefix)
    }

    fn snapshot_key(&self, metadata: &BackupSnapshotMetadata) -> String {
        format!(
            "{}{created:020}-{sha}{OBJECT_SUFFIX}",
            self.snapshot_directory(metadata.id),
            created = metadata.created_at_ms,
            sha = metadata.sha256,
        )
    }

    fn list_url(
        &self,
        prefix: &str,
        cursor: Option<&str>,
        limit: u16,
    ) -> Result<Url, BackupTargetError> {
        let mut url = self.bucket_url()?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("list-type", "2");
            query.append_pair("prefix", prefix);
            query.append_pair("max-keys", &limit.to_string());
            if let Some(cursor) = cursor {
                query.append_pair("continuation-token", cursor);
            }
        }
        Ok(url)
    }

    fn versions_url(
        &self,
        prefix: &str,
        key_marker: Option<&str>,
        version_id_marker: Option<&str>,
        limit: u16,
    ) -> Result<Url, BackupTargetError> {
        let mut url = self.bucket_url()?;
        {
            let mut query = url.query_pairs_mut();
            // An empty value is the canonical S3 query representation for the
            // ListObjectVersions subresource (`?versions`).
            query.append_pair("versions", "");
            query.append_pair("prefix", prefix);
            query.append_pair("max-keys", &limit.to_string());
            if let Some(key_marker) = key_marker {
                query.append_pair("key-marker", key_marker);
            }
            if let Some(version_id_marker) = version_id_marker {
                query.append_pair("version-id-marker", version_id_marker);
            }
        }
        Ok(url)
    }

    fn versioned_object_url(&self, key: &str, version_id: &str) -> Result<Url, BackupTargetError> {
        validate_version_id(version_id)?;
        let mut url = self.object_url(key)?;
        url.query_pairs_mut().append_pair("versionId", version_id);
        Ok(url)
    }

    fn signed_request(
        &self,
        method: Method,
        url: Url,
        headers: HeaderMap,
        body: Vec<u8>,
    ) -> Result<reqwest::Request, BackupTargetError> {
        let payload_hash = sha256_hex(&body);
        let mut request = self
            .client
            .request(method, url)
            .headers(headers)
            .body(body)
            .build()
            .map_err(|_| BackupTargetError::InvalidRequest)?;

        let identity = Credentials::new(
            self.credentials.access_key_id.clone(),
            self.credentials.secret_access_key.clone(),
            self.credentials.session_token.clone(),
            None,
            "linked-info-s3-target",
        )
        .into();
        let mut settings = SigningSettings::default();
        settings.payload_checksum_kind = PayloadChecksumKind::XAmzSha256;
        settings.percent_encoding_mode = PercentEncodingMode::Single;
        settings.uri_path_normalization_mode = UriPathNormalizationMode::Disabled;
        let params: SigningParams<'_> = v4::SigningParams::builder()
            .identity(&identity)
            .region(&self.region)
            .name("s3")
            .time(SystemTime::now())
            .settings(settings)
            .build()
            .map_err(|_| BackupTargetError::InvalidRequest)?
            .into();
        let header_pairs = request
            .headers()
            .iter()
            .map(|(name, value)| {
                value
                    .to_str()
                    .map(|value| (name.as_str(), value))
                    .map_err(|_| BackupTargetError::InvalidRequest)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let signable = SignableRequest::new(
            request.method().as_str(),
            request.url().as_str(),
            header_pairs.into_iter(),
            SignableBody::Precomputed(payload_hash),
        )
        .map_err(|_| BackupTargetError::InvalidRequest)?;
        let (instructions, _) = sign(signable, &params)
            .map_err(|_| BackupTargetError::InvalidRequest)?
            .into_parts();
        for (name, value) in instructions.headers() {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| BackupTargetError::InvalidRequest)?;
            let mut value =
                HeaderValue::from_str(value).map_err(|_| BackupTargetError::InvalidRequest)?;
            if name.as_str().eq_ignore_ascii_case("authorization")
                || name.as_str().eq_ignore_ascii_case("x-amz-security-token")
            {
                value.set_sensitive(true);
            }
            request.headers_mut().insert(name, value);
        }
        Ok(request)
    }

    async fn execute(
        &self,
        method: Method,
        url: Url,
        headers: HeaderMap,
        body: Vec<u8>,
    ) -> Result<reqwest::Response, BackupTargetError> {
        let request = self.signed_request(method, url, headers, body)?;
        self.client
            .execute(request)
            .await
            .map_err(|_| BackupTargetError::Unavailable)
    }

    async fn upload_snapshot(
        &self,
        snapshot: BackupSnapshot,
    ) -> Result<BackupSnapshotMetadata, BackupTargetError> {
        snapshot
            .verify_integrity()
            .map_err(|_| BackupTargetError::IntegrityFailure)?;
        if snapshot.metadata.size_bytes > MAXIMUM_UPLOAD_BYTES {
            return Err(BackupTargetError::PayloadTooLarge);
        }
        if self.lookup_snapshot(snapshot.metadata.id).await?.is_some() {
            return Err(BackupTargetError::Conflict);
        }
        let expected = snapshot.metadata.clone();
        let key = self.snapshot_key(&expected);
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(BACKUP_CONTENT_TYPE));
        let response = self
            .execute(
                Method::PUT,
                self.object_url(&key)?,
                headers,
                snapshot.payload,
            )
            .await?;
        require_success(response).await?;
        Ok(expected)
    }

    async fn list_snapshots(
        &self,
        cursor: Option<String>,
        limit: u16,
    ) -> Result<BackupListPage, BackupTargetError> {
        if limit == 0 || limit > linked_info_backup_port::MAX_BACKUP_PAGE_LIMIT {
            return Err(BackupTargetError::InvalidRequest);
        }
        if cursor
            .as_ref()
            .is_some_and(|cursor| cursor.is_empty() || cursor.len() > 2048)
        {
            return Err(BackupTargetError::InvalidRequest);
        }
        let prefix = format!("{}/snapshots/", self.prefix);
        let response = require_success(
            self.execute(
                Method::GET,
                self.list_url(&prefix, cursor.as_deref(), limit)?,
                HeaderMap::new(),
                Vec::new(),
            )
            .await?,
        )
        .await?;
        let result = parse_list_response(response).await?;
        let mut items = result
            .contents
            .into_iter()
            .filter_map(|object| metadata_from_object(&prefix, &object).ok())
            .collect::<Vec<_>>();
        items.sort_by_key(|item| std::cmp::Reverse(item.created_at_ms));
        let next_cursor = result.next_continuation_token.filter(|cursor| {
            !cursor.is_empty() && cursor.len() <= 2048 && result.is_truncated.unwrap_or(false)
        });
        Ok(BackupListPage { items, next_cursor })
    }

    async fn has_visible_objects_with_guard(
        &self,
        prefix: &str,
        operation_guard: Option<&dyn BackupOperationGuard>,
    ) -> Result<bool, BackupTargetError> {
        check_operation_guard(operation_guard)?;
        let response = require_success(
            self.execute(
                Method::GET,
                self.list_url(prefix, None, MAX_BACKUP_PAGE_LIMIT)?,
                HeaderMap::new(),
                Vec::new(),
            )
            .await?,
        )
        .await?;
        check_operation_guard(operation_guard)?;
        let result = parse_list_response(response).await?;

        // This probe deliberately checks raw object presence instead of the
        // parsed snapshot list. `list_snapshots` filters malformed keys for
        // ordinary browsing, but a destructive purge must fail closed when an
        // app-owned key is visible and cannot be parsed as our format.
        raw_list_indicates_visible_objects(&result)
    }

    async fn lookup_snapshot(
        &self,
        id: Uuid,
    ) -> Result<Option<(String, BackupSnapshotMetadata)>, BackupTargetError> {
        self.lookup_snapshot_with_guard(id, None).await
    }

    async fn lookup_snapshot_with_guard(
        &self,
        id: Uuid,
        operation_guard: Option<&dyn BackupOperationGuard>,
    ) -> Result<Option<(String, BackupSnapshotMetadata)>, BackupTargetError> {
        let prefix = self.snapshot_directory(id);
        check_operation_guard(operation_guard)?;
        let response = require_success(
            self.execute(
                Method::GET,
                self.list_url(&prefix, None, 2)?,
                HeaderMap::new(),
                Vec::new(),
            )
            .await?,
        )
        .await?;
        check_operation_guard(operation_guard)?;
        let result = parse_list_response(response).await?;
        let mut matches = result
            .contents
            .into_iter()
            .filter_map(|object| {
                metadata_from_object(&format!("{}/snapshots/", self.prefix), &object)
                    .ok()
                    .filter(|metadata| metadata.id == id)
                    .map(|metadata| (object.key, metadata))
            })
            .collect::<Vec<_>>();
        if matches.len() > 1 {
            return Err(BackupTargetError::InvalidResponse);
        }
        Ok(matches.pop())
    }

    /// Enumerate every S3 version and delete marker under an application
    /// prefix. `ListObjectsV2` cannot be used for destructive operations: on a
    /// versioned bucket it hides historical versions and an object whose
    /// latest record is a delete marker.
    async fn list_versions_for_prefix(
        &self,
        prefix: &str,
        operation_guard: Option<&dyn BackupOperationGuard>,
    ) -> Result<Vec<VersionedObject>, BackupTargetError> {
        let mut key_marker: Option<String> = None;
        let mut version_id_marker: Option<String> = None;
        let mut objects = Vec::new();

        loop {
            check_operation_guard(operation_guard)?;
            let response = self
                .execute(
                    Method::GET,
                    self.versions_url(
                        prefix,
                        key_marker.as_deref(),
                        version_id_marker.as_deref(),
                        MAX_BACKUP_PAGE_LIMIT,
                    )?,
                    HeaderMap::new(),
                    Vec::new(),
                )
                .await?;
            check_operation_guard(operation_guard)?;
            let response = require_success(response).await?;
            let page = parse_versions_response(response).await?;

            for version in page.versions {
                validate_version_id(&version.version_id)?;
                objects.push(VersionedObject {
                    key: version.key,
                    version_id: version.version_id,
                });
            }
            for marker in page.delete_markers {
                validate_version_id(&marker.version_id)?;
                objects.push(VersionedObject {
                    key: marker.key,
                    version_id: marker.version_id,
                });
            }
            if objects.len() > MAXIMUM_VERSIONS_TO_DELETE {
                return Err(BackupTargetError::InvalidResponse);
            }

            let is_truncated = page
                .is_truncated
                .ok_or(BackupTargetError::InvalidResponse)?;
            if !is_truncated {
                break;
            }

            let next_key_marker = validate_marker(page.next_key_marker)?;
            let next_version_id_marker =
                validate_optional_version_marker(page.next_version_id_marker)?;
            if next_key_marker.is_none()
                || (next_key_marker == key_marker && next_version_id_marker == version_id_marker)
            {
                // A truncated response without a progressing marker would
                // make a complete deletion claim impossible and could loop
                // forever against a broken provider.
                return Err(BackupTargetError::InvalidResponse);
            }
            key_marker = next_key_marker;
            version_id_marker = next_version_id_marker;
        }

        objects.sort_by(|left, right| {
            left.key
                .cmp(&right.key)
                .then_with(|| left.version_id.cmp(&right.version_id))
        });
        objects
            .dedup_by(|left, right| left.key == right.key && left.version_id == right.version_id);
        Ok(objects)
    }

    fn snapshot_versions_from_objects(
        &self,
        id: Uuid,
        objects: Vec<VersionedObject>,
    ) -> Result<Vec<VersionedObject>, BackupTargetError> {
        let snapshots_prefix = format!("{}/snapshots/", self.prefix);
        objects
            .into_iter()
            .map(|object| {
                let parsed = parse_snapshot_key(&snapshots_prefix, &object.key)?;
                if parsed.id != id {
                    return Err(BackupTargetError::InvalidResponse);
                }
                Ok(object)
            })
            .collect()
    }

    async fn list_snapshot_versions_with_guard(
        &self,
        id: Uuid,
        operation_guard: Option<&dyn BackupOperationGuard>,
    ) -> Result<Vec<VersionedObject>, BackupTargetError> {
        let objects = self
            .list_versions_for_prefix(&self.snapshot_directory(id), operation_guard)
            .await?;
        self.snapshot_versions_from_objects(id, objects)
    }

    async fn delete_version(
        &self,
        object: &VersionedObject,
        operation_guard: Option<&dyn BackupOperationGuard>,
    ) -> Result<(), BackupTargetError> {
        check_operation_guard(operation_guard)?;
        let response = self
            .execute(
                Method::DELETE,
                self.versioned_object_url(&object.key, &object.version_id)?,
                HeaderMap::new(),
                Vec::new(),
            )
            .await?;
        check_operation_guard(operation_guard)?;
        // Version-specific DELETE is idempotent. A concurrent cleanup may
        // have removed this exact version after the listing, which is already
        // the desired state.
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        require_success(response).await.map(|_| ())
    }

    async fn delete_snapshot_with_verification(
        &self,
        id: Uuid,
    ) -> Result<BackupDeleteOutcome, BackupTargetError> {
        self.delete_snapshot_with_verification_guard(id, None).await
    }

    async fn delete_snapshot_with_verification_guard(
        &self,
        id: Uuid,
        operation_guard: Option<&dyn BackupOperationGuard>,
    ) -> Result<BackupDeleteOutcome, BackupTargetError> {
        // Providers that implement ordinary S3 object operations but reject
        // ListObjectVersions cannot prove that old versions are gone. Do not
        // issue a current-object DELETE in that case; report an unverified
        // outcome so the caller can keep the target and its data intact.
        check_operation_guard(operation_guard)?;
        let mut objects = match self
            .list_snapshot_versions_with_guard(id, operation_guard)
            .await
        {
            Ok(objects) => objects,
            Err(BackupTargetError::InvalidRequest | BackupTargetError::InvalidResponse) => {
                return Ok(BackupDeleteOutcome::Unverified {
                    removed_versions: 0,
                });
            }
            Err(error) => return Err(error),
        };
        if objects.is_empty() {
            // A compliant unversioned S3 bucket exposes its `null` version via
            // ListObjectVersions. If an endpoint instead hides a live object,
            // refuse to claim it was deleted.
            let prefix = self.snapshot_directory(id);
            let visible = match self
                .has_visible_objects_with_guard(&prefix, operation_guard)
                .await
            {
                Ok(visible) => visible,
                Err(BackupTargetError::InvalidRequest | BackupTargetError::InvalidResponse) => {
                    return Ok(BackupDeleteOutcome::Unverified {
                        removed_versions: 0,
                    });
                }
                Err(error) => return Err(error),
            };
            return Ok(if visible {
                BackupDeleteOutcome::Unverified {
                    removed_versions: 0,
                }
            } else {
                BackupDeleteOutcome::NotFound
            });
        }

        let mut removed_versions = 0u32;
        for _ in 0..=MAXIMUM_DELETE_PASSES {
            for object in &objects {
                self.delete_version(object, operation_guard).await?;
                removed_versions = removed_versions
                    .checked_add(1)
                    .ok_or(BackupTargetError::InvalidResponse)?;
            }
            objects = match self
                .list_snapshot_versions_with_guard(id, operation_guard)
                .await
            {
                Ok(objects) => objects,
                Err(BackupTargetError::InvalidRequest | BackupTargetError::InvalidResponse) => {
                    return Ok(BackupDeleteOutcome::Unverified { removed_versions });
                }
                Err(error) => return Err(error),
            };
            if objects.is_empty() {
                let prefix = self.snapshot_directory(id);
                let visible = match self
                    .has_visible_objects_with_guard(&prefix, operation_guard)
                    .await
                {
                    Ok(visible) => visible,
                    Err(BackupTargetError::InvalidRequest | BackupTargetError::InvalidResponse) => {
                        return Ok(BackupDeleteOutcome::Unverified { removed_versions });
                    }
                    Err(error) => return Err(error),
                };
                return Ok(if visible {
                    BackupDeleteOutcome::Unverified { removed_versions }
                } else {
                    BackupDeleteOutcome::Deleted { removed_versions }
                });
            }
        }

        Ok(BackupDeleteOutcome::Unverified { removed_versions })
    }

    async fn purge_snapshots_with_verification(
        &self,
    ) -> Result<BackupPurgeOutcome, BackupTargetError> {
        self.purge_snapshots_with_verification_guard(None).await
    }

    async fn purge_snapshots_with_verification_guard(
        &self,
        operation_guard: Option<&dyn BackupOperationGuard>,
    ) -> Result<BackupPurgeOutcome, BackupTargetError> {
        let snapshots_prefix = format!("{}/snapshots/", self.prefix);
        check_operation_guard(operation_guard)?;
        let mut objects = match self
            .list_versions_for_prefix(&snapshots_prefix, operation_guard)
            .await
        {
            Ok(objects) => objects
                .into_iter()
                .map(|object| parse_snapshot_key(&snapshots_prefix, &object.key).map(|_| object))
                .collect::<Result<Vec<_>, _>>(),
            Err(BackupTargetError::InvalidRequest | BackupTargetError::InvalidResponse) => {
                return Ok(BackupPurgeOutcome::Unverified {
                    removed_versions: 0,
                });
            }
            Err(error) => return Err(error),
        }
        .map_err(|_| BackupTargetError::InvalidResponse)?;

        if objects.is_empty() {
            // A provider that returns an empty version listing while a live
            // application object is visible cannot support a complete purge.
            check_operation_guard(operation_guard)?;
            let visible = match self
                .has_visible_objects_with_guard(&snapshots_prefix, operation_guard)
                .await
            {
                Ok(visible) => visible,
                Err(BackupTargetError::InvalidRequest | BackupTargetError::InvalidResponse) => {
                    return Ok(BackupPurgeOutcome::Unverified {
                        removed_versions: 0,
                    });
                }
                Err(error) => return Err(error),
            };
            check_operation_guard(operation_guard)?;
            return Ok(if visible {
                BackupPurgeOutcome::Unverified {
                    removed_versions: 0,
                }
            } else {
                BackupPurgeOutcome::Deleted {
                    removed_versions: 0,
                }
            });
        }

        let mut removed_versions = 0u32;
        for _ in 0..=MAXIMUM_DELETE_PASSES {
            for object in &objects {
                self.delete_version(object, operation_guard).await?;
                removed_versions = removed_versions
                    .checked_add(1)
                    .ok_or(BackupTargetError::InvalidResponse)?;
            }
            objects = match self
                .list_versions_for_prefix(&snapshots_prefix, operation_guard)
                .await
            {
                Ok(objects) => objects
                    .into_iter()
                    .map(|object| {
                        parse_snapshot_key(&snapshots_prefix, &object.key).map(|_| object)
                    })
                    .collect::<Result<Vec<_>, _>>(),
                Err(BackupTargetError::InvalidRequest | BackupTargetError::InvalidResponse) => {
                    return Ok(BackupPurgeOutcome::Unverified { removed_versions });
                }
                Err(error) => return Err(error),
            }
            .map_err(|_| BackupTargetError::InvalidResponse)?;
            if objects.is_empty() {
                let visible = match self
                    .has_visible_objects_with_guard(&snapshots_prefix, operation_guard)
                    .await
                {
                    Ok(visible) => visible,
                    Err(BackupTargetError::InvalidRequest | BackupTargetError::InvalidResponse) => {
                        return Ok(BackupPurgeOutcome::Unverified { removed_versions });
                    }
                    Err(error) => return Err(error),
                };
                return Ok(if visible {
                    BackupPurgeOutcome::Unverified { removed_versions }
                } else {
                    BackupPurgeOutcome::Deleted { removed_versions }
                });
            }
        }

        Ok(BackupPurgeOutcome::Unverified { removed_versions })
    }

    async fn download_snapshot(
        &self,
        id: Uuid,
    ) -> Result<Option<BackupSnapshot>, BackupTargetError> {
        let Some((key, metadata)) = self.lookup_snapshot(id).await? else {
            return Ok(None);
        };
        if metadata.size_bytes > MAXIMUM_UPLOAD_BYTES {
            return Err(BackupTargetError::InvalidResponse);
        }
        let response = self
            .execute(
                Method::GET,
                self.object_url(&key)?,
                HeaderMap::new(),
                Vec::new(),
            )
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let response = require_success(response).await?;
        if response
            .content_length()
            .is_some_and(|length| length != metadata.size_bytes)
        {
            return Err(BackupTargetError::IntegrityFailure);
        }
        let payload = read_limited_response(response, MAXIMUM_UPLOAD_BYTES as usize).await?;
        BackupSnapshot::from_parts(metadata, payload)
            .map(Some)
            .map_err(|_| BackupTargetError::IntegrityFailure)
    }

    async fn delete_snapshot(&self, id: Uuid) -> Result<bool, BackupTargetError> {
        match self.delete_snapshot_with_verification(id).await? {
            BackupDeleteOutcome::NotFound => Ok(false),
            BackupDeleteOutcome::Deleted { .. } => Ok(true),
            // Keep the legacy bool API conservative. Existing callers that
            // have not migrated to `delete_with_verification` must not treat
            // an unverified operation as a successful deletion.
            BackupDeleteOutcome::Unverified { .. } => Err(BackupTargetError::InvalidResponse),
        }
    }
}

impl BackupTarget for S3BackupTarget {
    fn capabilities(&self) -> BackupTargetCapabilities {
        BackupTargetCapabilities {
            maximum_upload_bytes: Some(MAXIMUM_UPLOAD_BYTES),
            supports_delete: true,
        }
    }

    fn delete_capability(&self) -> BackupDeleteCapability {
        BackupDeleteCapability::AllVersions
    }

    fn upload<'a>(
        &'a self,
        snapshot: BackupSnapshot,
    ) -> BackupTargetFuture<'a, BackupSnapshotMetadata> {
        Box::pin(async move { self.upload_snapshot(snapshot).await })
    }

    fn list<'a>(
        &'a self,
        cursor: Option<String>,
        limit: u16,
    ) -> BackupTargetFuture<'a, BackupListPage> {
        Box::pin(async move { self.list_snapshots(cursor, limit).await })
    }

    fn download<'a>(&'a self, id: Uuid) -> BackupTargetFuture<'a, Option<BackupSnapshot>> {
        Box::pin(async move { self.download_snapshot(id).await })
    }

    fn delete<'a>(&'a self, id: Uuid) -> BackupTargetFuture<'a, bool> {
        Box::pin(async move { self.delete_snapshot(id).await })
    }

    fn delete_with_verification<'a>(
        &'a self,
        id: Uuid,
    ) -> BackupTargetFuture<'a, BackupDeleteOutcome> {
        Box::pin(async move { self.delete_snapshot_with_verification(id).await })
    }

    fn delete_with_verification_guarded<'a>(
        &'a self,
        id: Uuid,
        guard: &'a dyn BackupOperationGuard,
    ) -> BackupTargetFuture<'a, BackupDeleteOutcome> {
        Box::pin(async move {
            guard.check()?;
            self.delete_snapshot_with_verification_guard(id, Some(guard))
                .await
        })
    }

    fn purge_with_verification<'a>(&'a self) -> BackupTargetFuture<'a, BackupPurgeOutcome> {
        Box::pin(async move { self.purge_snapshots_with_verification().await })
    }

    fn purge_with_verification_guarded<'a>(
        &'a self,
        guard: &'a dyn BackupOperationGuard,
    ) -> BackupTargetFuture<'a, BackupPurgeOutcome> {
        Box::pin(async move {
            guard.check()?;
            self.purge_snapshots_with_verification_guard(Some(guard))
                .await
        })
    }

    fn verify<'a>(&'a self, id: Uuid) -> BackupTargetFuture<'a, BackupVerification> {
        Box::pin(async move {
            let snapshot = self
                .download_snapshot(id)
                .await?
                .ok_or(BackupTargetError::NotFound)?;
            let downloaded_bytes = snapshot.metadata.size_bytes;
            Ok(BackupVerification {
                metadata: snapshot.metadata,
                downloaded_bytes,
            })
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListBucketResult {
    #[serde(default)]
    contents: Vec<ListedObject>,
    next_continuation_token: Option<String>,
    is_truncated: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListedObject {
    key: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListObjectVersionsResult {
    #[serde(rename = "Version", default)]
    versions: Vec<ListedVersion>,
    #[serde(rename = "DeleteMarker", default)]
    delete_markers: Vec<ListedDeleteMarker>,
    next_key_marker: Option<String>,
    next_version_id_marker: Option<String>,
    is_truncated: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListedVersion {
    key: String,
    version_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListedDeleteMarker {
    key: String,
    version_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VersionedObject {
    key: String,
    version_id: String,
}

async fn parse_list_response(
    response: reqwest::Response,
) -> Result<ListBucketResult, BackupTargetError> {
    let bytes = read_limited_response(response, MAXIMUM_LIST_RESPONSE_BYTES).await?;
    quick_xml::de::from_reader(bytes.as_slice()).map_err(|_| BackupTargetError::InvalidResponse)
}

async fn parse_versions_response(
    response: reqwest::Response,
) -> Result<ListObjectVersionsResult, BackupTargetError> {
    let bytes = read_limited_response(response, MAXIMUM_LIST_RESPONSE_BYTES).await?;
    ensure_xml_root(&bytes, b"ListVersionsResult")?;
    quick_xml::de::from_reader(bytes.as_slice()).map_err(|_| BackupTargetError::InvalidResponse)
}

fn ensure_xml_root(bytes: &[u8], expected_local_name: &[u8]) -> Result<(), BackupTargetError> {
    let mut reader = quick_xml::Reader::from_reader(bytes);
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(event))
            | Ok(quick_xml::events::Event::Empty(event)) => {
                if event.local_name().as_ref() == expected_local_name {
                    return Ok(());
                }
                return Err(BackupTargetError::InvalidResponse);
            }
            Ok(quick_xml::events::Event::Eof) | Err(_) => {
                return Err(BackupTargetError::InvalidResponse);
            }
            Ok(_) => {}
        }
    }
}

fn validate_version_id(version_id: &str) -> Result<(), BackupTargetError> {
    if version_id.is_empty()
        || version_id.len() > MAXIMUM_VERSION_ID_BYTES
        || version_id.chars().any(char::is_control)
    {
        return Err(BackupTargetError::InvalidResponse);
    }
    Ok(())
}

fn validate_marker(marker: Option<String>) -> Result<Option<String>, BackupTargetError> {
    let Some(marker) = marker else {
        return Ok(None);
    };
    if marker.is_empty() || marker.len() > 2048 || marker.chars().any(char::is_control) {
        return Err(BackupTargetError::InvalidResponse);
    }
    Ok(Some(marker))
}

fn validate_optional_version_marker(
    marker: Option<String>,
) -> Result<Option<String>, BackupTargetError> {
    let Some(marker) = marker else {
        return Ok(None);
    };
    // Some S3-compatible implementations serialize an absent marker as an
    // empty element when pagination crosses to a new key. Treat that form as
    // absent; actual version records still require a non-empty ID.
    if marker.is_empty() {
        return Ok(None);
    }
    validate_version_id(&marker)?;
    Ok(Some(marker))
}

fn metadata_from_object(
    snapshots_prefix: &str,
    object: &ListedObject,
) -> Result<BackupSnapshotMetadata, BackupTargetError> {
    let parsed = parse_snapshot_key(snapshots_prefix, &object.key)?;
    let metadata = BackupSnapshotMetadata {
        id: parsed.id,
        created_at_ms: parsed.created_at_ms,
        size_bytes: object.size,
        sha256: parsed.sha256,
    };
    metadata
        .validate()
        .map_err(|_| BackupTargetError::InvalidResponse)?;
    Ok(metadata)
}

fn raw_list_indicates_visible_objects(
    result: &ListBucketResult,
) -> Result<bool, BackupTargetError> {
    if !result.contents.is_empty() {
        return Ok(true);
    }
    if result.is_truncated == Some(true) {
        let cursor = result
            .next_continuation_token
            .as_deref()
            .filter(|cursor| !cursor.is_empty() && cursor.len() <= 2048);
        return cursor
            .map(|_| true)
            .ok_or(BackupTargetError::InvalidResponse);
    }
    match result.is_truncated {
        Some(false) if result.next_continuation_token.is_none() => Ok(false),
        Some(false) | None => Err(BackupTargetError::InvalidResponse),
        Some(true) => Err(BackupTargetError::InvalidResponse),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSnapshotKey {
    id: Uuid,
    created_at_ms: u64,
    sha256: String,
}

fn parse_snapshot_key(
    snapshots_prefix: &str,
    key: &str,
) -> Result<ParsedSnapshotKey, BackupTargetError> {
    let relative = key
        .strip_prefix(snapshots_prefix)
        .ok_or(BackupTargetError::InvalidResponse)?;
    let (id, file_name) = relative
        .split_once('/')
        .ok_or(BackupTargetError::InvalidResponse)?;
    if file_name.contains('/') || !file_name.ends_with(OBJECT_SUFFIX) {
        return Err(BackupTargetError::InvalidResponse);
    }
    let id = id
        .parse::<Uuid>()
        .map_err(|_| BackupTargetError::InvalidResponse)?;
    let stem = file_name
        .strip_suffix(OBJECT_SUFFIX)
        .ok_or(BackupTargetError::InvalidResponse)?;
    let (created_at_ms, sha256) = stem
        .split_once('-')
        .ok_or(BackupTargetError::InvalidResponse)?;
    let parsed = ParsedSnapshotKey {
        id,
        created_at_ms: created_at_ms
            .parse::<u64>()
            .map_err(|_| BackupTargetError::InvalidResponse)?,
        sha256: sha256.to_owned(),
    };
    if parsed.created_at_ms == 0 || !linked_info_backup_port::is_sha256(&parsed.sha256) {
        return Err(BackupTargetError::InvalidResponse);
    }
    Ok(parsed)
}

fn validate_endpoint(endpoint: &str) -> Result<Url, BackupTargetError> {
    let mut endpoint =
        Url::parse(endpoint.trim()).map_err(|_| BackupTargetError::InvalidRequest)?;
    if endpoint.scheme() != "https"
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || !matches!(endpoint.path(), "" | "/")
    {
        return Err(BackupTargetError::InvalidRequest);
    }
    endpoint.set_path("/");
    Ok(endpoint)
}

fn normalize_region(region: &str) -> Result<String, BackupTargetError> {
    let region = region.trim();
    if region.is_empty()
        || region.len() > 63
        || !region
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(BackupTargetError::InvalidRequest);
    }
    Ok(region.to_owned())
}

fn normalize_bucket(bucket: &str) -> Result<String, BackupTargetError> {
    let bucket = bucket.trim();
    if bucket.is_empty()
        || bucket.len() > 256
        || matches!(bucket, "." | "..")
        || !bucket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(BackupTargetError::InvalidRequest);
    }
    Ok(bucket.to_owned())
}

fn normalize_prefix(prefix: &str) -> Result<String, BackupTargetError> {
    let prefix = if prefix.trim().is_empty() {
        DEFAULT_PREFIX
    } else {
        prefix.trim().trim_matches('/')
    };
    if prefix.is_empty()
        || prefix.len() > 240
        || prefix.split('/').any(|segment| {
            segment.is_empty()
                || segment == "."
                || segment == ".."
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    {
        return Err(BackupTargetError::InvalidRequest);
    }
    Ok(prefix.to_owned())
}

fn validate_credentials(credentials: &S3Credentials) -> Result<(), BackupTargetError> {
    let valid_field = |value: &str, minimum: usize, maximum: usize| {
        value.len() >= minimum
            && value.len() <= maximum
            && value.as_bytes().iter().all(|byte| byte.is_ascii_graphic())
    };
    if !valid_field(&credentials.access_key_id, 3, 256)
        || !valid_field(&credentials.secret_access_key, 8, 1024)
        || credentials
            .session_token
            .as_ref()
            .is_some_and(|token| !valid_field(token, 1, 4096))
    {
        return Err(BackupTargetError::InvalidRequest);
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn require_success(
    response: reqwest::Response,
) -> Result<reqwest::Response, BackupTargetError> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(error_from_status(response.status()))
    }
}

fn error_from_status(status: StatusCode) -> BackupTargetError {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => BackupTargetError::Unauthorized,
        StatusCode::NOT_FOUND => BackupTargetError::NotFound,
        StatusCode::CONFLICT | StatusCode::PRECONDITION_FAILED => BackupTargetError::Conflict,
        StatusCode::PAYLOAD_TOO_LARGE => BackupTargetError::PayloadTooLarge,
        StatusCode::BAD_REQUEST => BackupTargetError::InvalidRequest,
        _ if status.is_server_error() => BackupTargetError::Unavailable,
        _ => BackupTargetError::InvalidResponse,
    }
}

async fn read_limited_response(
    mut response: reqwest::Response,
    maximum_bytes: usize,
) -> Result<Vec<u8>, BackupTargetError> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(BackupTargetError::InvalidResponse);
    }
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or_default()
            .min(maximum_bytes as u64) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| BackupTargetError::Unavailable)?
    {
        if bytes.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(BackupTargetError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread::{self, JoinHandle},
        time::Duration,
    };

    use super::*;

    struct ScriptedS3Server {
        endpoint: String,
        requests: Arc<Mutex<Vec<String>>>,
        stopped: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl ScriptedS3Server {
        fn start(responses: Vec<(u16, String)>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint = format!("http://{}/", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let stopped = Arc::new(AtomicBool::new(false));
            let server_requests = Arc::clone(&requests);
            let server_stopped = Arc::clone(&stopped);
            let thread = thread::spawn(move || {
                let mut response_index = 0;
                while response_index < responses.len() && !server_stopped.load(Ordering::SeqCst) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(connection) => connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(1));
                            continue;
                        }
                        Err(error) => panic!("scripted S3 server failed to accept: {error}"),
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = Vec::new();
                    loop {
                        let mut chunk = [0; 1024];
                        let read = stream.read(&mut chunk).unwrap();
                        if read == 0 {
                            break;
                        }
                        request.extend_from_slice(&chunk[..read]);
                        if request.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let request_line = String::from_utf8_lossy(&request)
                        .lines()
                        .next()
                        .unwrap()
                        .to_owned();
                    server_requests.lock().unwrap().push(request_line);

                    let (status, body) = &responses[response_index];
                    let reason = match status {
                        200 => "OK",
                        204 => "No Content",
                        _ => panic!("unsupported scripted status {status}"),
                    };
                    let response = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len(),
                    );
                    stream.write_all(response.as_bytes()).unwrap();
                    stream.flush().unwrap();
                    response_index += 1;
                }
            });
            Self {
                endpoint,
                requests,
                stopped,
                thread: Some(thread),
            }
        }

        fn finish(mut self) -> Vec<String> {
            self.stopped.store(true, Ordering::SeqCst);
            self.thread.take().unwrap().join().unwrap();
            let requests = self.requests.lock().unwrap().clone();
            requests
        }
    }

    impl Drop for ScriptedS3Server {
        fn drop(&mut self) {
            self.stopped.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn credentials() -> S3Credentials {
        S3Credentials {
            access_key_id: "AKIDEXAMPLE".to_owned(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_owned(),
            session_token: None,
        }
    }

    fn http_test_target(endpoint: &str) -> S3BackupTarget {
        S3BackupTarget {
            client: Client::builder()
                .redirect(Policy::none())
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            endpoint: Url::parse(endpoint).unwrap(),
            region: "us-east-1".to_owned(),
            bucket: "backup-bucket".to_owned(),
            prefix: "linked-info/v1".to_owned(),
            credentials: credentials(),
        }
    }

    fn visible_object_after_version_deletion_script(id: Uuid) -> Vec<(u16, String)> {
        let key = format!(
            "linked-info/v1/snapshots/{id}/00000000000000000042-{sha}{OBJECT_SUFFIX}",
            sha = "e".repeat(64),
        );
        vec![
            (
                200,
                format!(
                    r#"<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
                      <IsTruncated>false</IsTruncated>
                      <Version><Key>{key}</Key><VersionId>version-1</VersionId></Version>
                    </ListVersionsResult>"#,
                ),
            ),
            (204, String::new()),
            (
                200,
                r#"<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
                  <IsTruncated>false</IsTruncated>
                </ListVersionsResult>"#
                    .to_owned(),
            ),
            (
                200,
                format!(
                    r#"<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
                      <IsTruncated>false</IsTruncated>
                      <Contents><Key>{key}</Key><Size>7</Size></Contents>
                    </ListBucketResult>"#,
                ),
            ),
        ]
    }

    #[test]
    fn final_snapshot_version_check_rejects_a_still_visible_object() {
        let id = Uuid::new_v4();
        let server = ScriptedS3Server::start(visible_object_after_version_deletion_script(id));
        let target = http_test_target(&server.endpoint);

        let result = tauri::async_runtime::block_on(target.delete_snapshot_with_verification(id));
        let requests = server.finish();

        assert_eq!(
            result.unwrap(),
            BackupDeleteOutcome::Unverified {
                removed_versions: 1,
            }
        );
        assert_eq!(requests.len(), 4);
        assert!(requests[0].contains("versions="));
        assert!(requests[1].starts_with("DELETE "));
        assert!(requests[2].contains("versions="));
        assert!(requests[3].contains("list-type=2"));
    }

    #[test]
    fn final_purge_version_check_rejects_a_still_visible_object() {
        let id = Uuid::new_v4();
        let server = ScriptedS3Server::start(visible_object_after_version_deletion_script(id));
        let target = http_test_target(&server.endpoint);

        let result = tauri::async_runtime::block_on(target.purge_snapshots_with_verification());
        let requests = server.finish();

        assert_eq!(
            result.unwrap(),
            BackupPurgeOutcome::Unverified {
                removed_versions: 1,
            }
        );
        assert_eq!(requests.len(), 4);
        assert!(requests[0].contains("versions="));
        assert!(requests[1].starts_with("DELETE "));
        assert!(requests[2].contains("versions="));
        assert!(requests[3].contains("list-type=2"));
    }

    #[test]
    fn endpoint_and_object_scope_are_strictly_normalized() {
        assert_eq!(
            S3BackupTarget::normalize_endpoint("https://s3.example.test"),
            Ok("https://s3.example.test/".to_owned())
        );
        assert!(S3BackupTarget::normalize_endpoint("http://s3.example.test").is_err());
        assert!(S3BackupTarget::normalize_endpoint("https://key@s3.example.test").is_err());
        assert!(S3BackupTarget::normalize_endpoint("https://s3.example.test/base").is_err());
        assert_eq!(
            normalize_prefix("/linked-info/backup/"),
            Ok("linked-info/backup".to_owned())
        );
        assert!(normalize_prefix("linked-info/../backup").is_err());
        assert_eq!(
            normalize_bucket("Example-Bucket"),
            Ok("Example-Bucket".to_owned())
        );
        assert_eq!(normalize_bucket("OCI_Bucket"), Ok("OCI_Bucket".to_owned()));
    }

    #[test]
    fn object_key_round_trips_snapshot_metadata() {
        let target = S3BackupTarget::new(
            "https://s3.example.test",
            "us-east-1",
            "backup-bucket",
            "linked-info/v1",
            credentials(),
        )
        .unwrap();
        let metadata = BackupSnapshotMetadata {
            id: Uuid::new_v4(),
            created_at_ms: 1_786_553_274_180,
            size_bytes: 22_398,
            sha256: "a".repeat(64),
        };
        let key = target.snapshot_key(&metadata);
        let parsed = metadata_from_object(
            "linked-info/v1/snapshots/",
            &ListedObject {
                key,
                size: metadata.size_bytes,
            },
        )
        .unwrap();
        assert_eq!(parsed, metadata);
    }

    #[test]
    fn list_xml_ignores_no_fields_needed_for_snapshot_metadata() {
        let id = Uuid::new_v4();
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
              <IsTruncated>true</IsTruncated>
              <Contents><Key>linked-info/v1/snapshots/{id}/00000000000000000042-{sha}{OBJECT_SUFFIX}</Key><Size>7</Size></Contents>
              <NextContinuationToken>opaque-token</NextContinuationToken>
            </ListBucketResult>"#,
            sha = "b".repeat(64),
        );
        let parsed: ListBucketResult = quick_xml::de::from_str(&xml).unwrap();
        assert_eq!(parsed.contents.len(), 1);
        assert_eq!(
            parsed.next_continuation_token.as_deref(),
            Some("opaque-token")
        );
        assert_eq!(parsed.is_truncated, Some(true));
    }

    #[test]
    fn destructive_empty_version_fallback_detects_malformed_raw_objects() {
        let result = ListBucketResult {
            contents: vec![ListedObject {
                key: "linked-info/v1/snapshots/not-a-snapshot".to_owned(),
                size: 12,
            }],
            next_continuation_token: None,
            is_truncated: Some(false),
        };
        assert_eq!(raw_list_indicates_visible_objects(&result), Ok(true));
    }

    #[test]
    fn destructive_empty_version_fallback_rejects_invalid_pagination() {
        let result = ListBucketResult {
            contents: Vec::new(),
            next_continuation_token: Some(String::new()),
            is_truncated: Some(true),
        };
        assert_eq!(
            raw_list_indicates_visible_objects(&result),
            Err(BackupTargetError::InvalidResponse)
        );
    }

    #[test]
    fn destructive_empty_version_fallback_rejects_missing_truncation_flag() {
        let result = ListBucketResult {
            contents: Vec::new(),
            next_continuation_token: None,
            is_truncated: None,
        };
        assert_eq!(
            raw_list_indicates_visible_objects(&result),
            Err(BackupTargetError::InvalidResponse)
        );
    }

    #[test]
    fn version_list_xml_includes_versions_and_delete_markers() {
        let id = Uuid::new_v4();
        let key = format!(
            "linked-info/v1/snapshots/{id}/00000000000000000042-{sha}{OBJECT_SUFFIX}",
            sha = "c".repeat(64),
        );
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
              <IsTruncated>true</IsTruncated>
              <Version><Key>{key}</Key><VersionId>version-1</VersionId><Size>7</Size></Version>
              <DeleteMarker><Key>{key}</Key><VersionId>delete-marker-1</VersionId></DeleteMarker>
              <NextKeyMarker>{key}</NextKeyMarker>
              <NextVersionIdMarker>delete-marker-1</NextVersionIdMarker>
            </ListVersionsResult>"#,
        );
        let parsed: ListObjectVersionsResult = quick_xml::de::from_str(&xml).unwrap();

        assert_eq!(parsed.versions.len(), 1);
        assert_eq!(parsed.delete_markers.len(), 1);
        assert_eq!(parsed.versions[0].key, key);
        assert_eq!(parsed.versions[0].version_id, "version-1");
        assert_eq!(parsed.delete_markers[0].version_id, "delete-marker-1");
        assert_eq!(parsed.is_truncated, Some(true));
        assert!(parsed.next_key_marker.is_some());
        assert_eq!(
            parsed.next_version_id_marker.as_deref(),
            Some("delete-marker-1")
        );
        assert!(ensure_xml_root(xml.as_bytes(), b"ListVersionsResult").is_ok());
        assert!(ensure_xml_root(xml.as_bytes(), b"ListBucketResult").is_err());
    }

    #[test]
    fn versioned_urls_use_s3_version_queries() {
        let target = S3BackupTarget::new(
            "https://s3.example.test",
            "us-east-1",
            "backup-bucket",
            "linked-info/v1",
            credentials(),
        )
        .unwrap();
        let versions_url = target
            .versions_url(
                "linked-info/v1/snapshots/",
                Some("key-marker"),
                Some("version/marker"),
                200,
            )
            .unwrap();
        let query = versions_url
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        assert!(query.contains(&("versions".to_owned(), String::new())));
        assert!(query.contains(&("key-marker".to_owned(), "key-marker".to_owned())));
        assert!(query.contains(&("version-id-marker".to_owned(), "version/marker".to_owned())));

        let object_url = target
            .versioned_object_url("linked-info/v1/snapshots/id/object", "version/1")
            .unwrap();
        assert_eq!(
            object_url
                .query_pairs()
                .next()
                .map(|(_, value)| value.into_owned()),
            Some("version/1".to_owned())
        );
    }

    #[test]
    fn malformed_version_ids_are_rejected_before_delete() {
        assert!(validate_version_id("version-1").is_ok());
        assert!(validate_version_id("version\n1").is_err());
        assert!(validate_version_id(&"v".repeat(MAXIMUM_VERSION_ID_BYTES + 1)).is_err());
        assert_eq!(
            validate_optional_version_marker(Some(String::new())),
            Ok(None)
        );
    }

    #[test]
    fn snapshot_version_filter_does_not_cross_snapshot_or_prefix_boundaries() {
        let target = S3BackupTarget::new(
            "https://s3.example.test",
            "us-east-1",
            "backup-bucket",
            "linked-info/v1",
            credentials(),
        )
        .unwrap();
        let metadata = BackupSnapshotMetadata {
            id: Uuid::new_v4(),
            created_at_ms: 42,
            size_bytes: 7,
            sha256: "d".repeat(64),
        };
        let other_metadata = BackupSnapshotMetadata {
            id: Uuid::new_v4(),
            ..metadata.clone()
        };
        let matching = VersionedObject {
            key: target.snapshot_key(&metadata),
            version_id: "v1".to_owned(),
        };
        let other = VersionedObject {
            key: target.snapshot_key(&other_metadata),
            version_id: "v2".to_owned(),
        };
        let malformed = VersionedObject {
            key: format!("{}/snapshots/{}/unrelated", target.prefix, metadata.id),
            version_id: "v3".to_owned(),
        };

        let filtered = target
            .snapshot_versions_from_objects(metadata.id, vec![matching.clone()])
            .unwrap();
        assert_eq!(filtered, vec![matching]);
        assert!(
            target
                .snapshot_versions_from_objects(metadata.id, vec![other])
                .is_err()
        );
        assert!(
            target
                .snapshot_versions_from_objects(metadata.id, vec![malformed])
                .is_err()
        );
    }

    #[test]
    fn s3_advertises_all_version_delete_capability() {
        let target = S3BackupTarget::new(
            "https://s3.example.test",
            "us-east-1",
            "backup-bucket",
            "linked-info/v1",
            credentials(),
        )
        .unwrap();

        assert_eq!(
            target.delete_capability(),
            BackupDeleteCapability::AllVersions
        );
    }

    #[test]
    fn signed_s3_request_contains_authorization_and_payload_hash() {
        let target = S3BackupTarget::new(
            "https://s3.example.test",
            "us-east-1",
            "backup-bucket",
            "linked-info/v1",
            credentials(),
        )
        .unwrap();
        let request = target
            .signed_request(
                Method::GET,
                target.bucket_url().unwrap(),
                HeaderMap::new(),
                Vec::new(),
            )
            .unwrap();
        assert!(request.headers().contains_key("authorization"));
        assert!(request.headers().contains_key("x-amz-content-sha256"));
        assert!(request.headers().contains_key("x-amz-date"));
    }
}
