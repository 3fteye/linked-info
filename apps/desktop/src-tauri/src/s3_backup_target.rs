use std::str::FromStr;
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
    BACKUP_CONTENT_TYPE, BackupListPage, BackupSnapshot, BackupSnapshotMetadata, BackupTarget,
    BackupTargetCapabilities, BackupTargetError, BackupTargetFuture, BackupVerification,
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
        items.sort_by(|left, right| right.created_at_ms.cmp(&left.created_at_ms));
        let next_cursor = result.next_continuation_token.filter(|cursor| {
            !cursor.is_empty() && cursor.len() <= 2048 && result.is_truncated.unwrap_or(false)
        });
        Ok(BackupListPage { items, next_cursor })
    }

    async fn lookup_snapshot(
        &self,
        id: Uuid,
    ) -> Result<Option<(String, BackupSnapshotMetadata)>, BackupTargetError> {
        let prefix = self.snapshot_directory(id);
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
        let Some((key, _)) = self.lookup_snapshot(id).await? else {
            return Ok(false);
        };
        let response = self
            .execute(
                Method::DELETE,
                self.object_url(&key)?,
                HeaderMap::new(),
                Vec::new(),
            )
            .await?;
        require_success(response).await?;
        Ok(true)
    }
}

impl BackupTarget for S3BackupTarget {
    fn capabilities(&self) -> BackupTargetCapabilities {
        BackupTargetCapabilities {
            maximum_upload_bytes: Some(MAXIMUM_UPLOAD_BYTES),
            supports_delete: true,
        }
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

async fn parse_list_response(
    response: reqwest::Response,
) -> Result<ListBucketResult, BackupTargetError> {
    let bytes = read_limited_response(response, MAXIMUM_LIST_RESPONSE_BYTES).await?;
    quick_xml::de::from_reader(bytes.as_slice()).map_err(|_| BackupTargetError::InvalidResponse)
}

fn metadata_from_object(
    snapshots_prefix: &str,
    object: &ListedObject,
) -> Result<BackupSnapshotMetadata, BackupTargetError> {
    let relative = object
        .key
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
    let metadata = BackupSnapshotMetadata {
        id,
        created_at_ms: created_at_ms
            .parse::<u64>()
            .map_err(|_| BackupTargetError::InvalidResponse)?,
        size_bytes: object.size,
        sha256: sha256.to_owned(),
    };
    metadata
        .validate()
        .map_err(|_| BackupTargetError::InvalidResponse)?;
    Ok(metadata)
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
    use super::*;

    fn credentials() -> S3Credentials {
        S3Credentials {
            access_key_id: "AKIDEXAMPLE".to_owned(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_owned(),
            session_token: None,
        }
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
