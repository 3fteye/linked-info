use linked_info_backup_port::{
    BACKUP_CONTENT_TYPE, BackupApiErrorCode, BackupApiErrorResponse, BackupListPage,
    BackupSnapshot, BackupSnapshotMetadata, BackupTarget, BackupTargetCapabilities,
    BackupTargetError, BackupTargetFuture, BackupVerification, headers,
};
use reqwest::{
    Client, StatusCode, Url,
    header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, HeaderValue},
    redirect::Policy,
};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAXIMUM_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
const MAXIMUM_JSON_RESPONSE_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT_SECONDS: u64 = 60;

pub struct CloudflareBackupTarget {
    client: Client,
    endpoint: Url,
    token: Zeroizing<String>,
}

impl CloudflareBackupTarget {
    pub fn new(endpoint: &str, token: String) -> Result<Self, BackupTargetError> {
        let endpoint = validate_endpoint(endpoint)?;
        validate_token(&token)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
            .build()
            .map_err(|_| BackupTargetError::Unavailable)?;
        Ok(Self {
            client,
            endpoint,
            token: Zeroizing::new(token),
        })
    }

    pub(crate) fn normalize_endpoint(endpoint: &str) -> Result<String, BackupTargetError> {
        validate_endpoint(endpoint).map(|url| url.to_string())
    }

    fn backups_url(&self) -> Result<Url, BackupTargetError> {
        self.endpoint
            .join("v1/backups")
            .map_err(|_| BackupTargetError::InvalidRequest)
    }

    fn backup_url(&self, id: Uuid) -> Result<Url, BackupTargetError> {
        self.endpoint
            .join(&format!("v1/backups/{id}"))
            .map_err(|_| BackupTargetError::InvalidRequest)
    }

    fn authorized(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let mut value = HeaderValue::from_str(&format!("Bearer {}", self.token.as_str()))
            .expect("validated backup token always forms a valid HTTP header");
        value.set_sensitive(true);
        builder.header(AUTHORIZATION, value)
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
        let expected = snapshot.metadata.clone();
        let response = self
            .authorized(self.client.put(self.backup_url(expected.id)?))
            .header(CONTENT_TYPE, BACKUP_CONTENT_TYPE)
            .header(headers::CREATED_AT_MS, expected.created_at_ms.to_string())
            .header(headers::SHA256, expected.sha256.as_str())
            .body(snapshot.payload)
            .send()
            .await
            .map_err(|_| BackupTargetError::Unavailable)?;
        let response = require_success(response).await?;
        let returned = serde_json::from_slice::<BackupSnapshotMetadata>(
            &read_limited_response(response, MAXIMUM_JSON_RESPONSE_BYTES).await?,
        )
        .map_err(|_| BackupTargetError::InvalidResponse)?;
        returned
            .validate()
            .map_err(|_| BackupTargetError::InvalidResponse)?;
        if returned != expected {
            return Err(BackupTargetError::InvalidResponse);
        }
        Ok(returned)
    }

    async fn list_snapshots(
        &self,
        cursor: Option<String>,
        limit: u16,
    ) -> Result<BackupListPage, BackupTargetError> {
        if limit == 0 || limit > linked_info_backup_port::MAX_BACKUP_PAGE_LIMIT {
            return Err(BackupTargetError::InvalidRequest);
        }
        let mut request = self.authorized(self.client.get(self.backups_url()?));
        request = request.query(&[("limit", limit.to_string())]);
        if let Some(cursor) = cursor {
            if cursor.is_empty() || cursor.len() > 2048 {
                return Err(BackupTargetError::InvalidRequest);
            }
            request = request.query(&[("cursor", cursor)]);
        }
        let response = require_success(
            request
                .send()
                .await
                .map_err(|_| BackupTargetError::Unavailable)?,
        )
        .await?;
        let page = serde_json::from_slice::<BackupListPage>(
            &read_limited_response(response, MAXIMUM_JSON_RESPONSE_BYTES).await?,
        )
        .map_err(|_| BackupTargetError::InvalidResponse)?;
        if page
            .items
            .iter()
            .any(|metadata| metadata.validate().is_err())
            || page
                .next_cursor
                .as_ref()
                .is_some_and(|cursor| cursor.is_empty() || cursor.len() > 2048)
        {
            return Err(BackupTargetError::InvalidResponse);
        }
        Ok(page)
    }

    async fn download_snapshot(
        &self,
        id: Uuid,
    ) -> Result<Option<BackupSnapshot>, BackupTargetError> {
        let response = self
            .authorized(self.client.get(self.backup_url(id)?))
            .send()
            .await
            .map_err(|_| BackupTargetError::Unavailable)?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let response = require_success(response).await?;
        let metadata = metadata_from_headers(response.headers(), id)?;
        if metadata.size_bytes > MAXIMUM_UPLOAD_BYTES {
            return Err(BackupTargetError::InvalidResponse);
        }
        let bytes = read_limited_response(response, MAXIMUM_UPLOAD_BYTES as usize).await?;
        let snapshot = BackupSnapshot::from_parts(metadata, bytes)
            .map_err(|_| BackupTargetError::IntegrityFailure)?;
        Ok(Some(snapshot))
    }

    async fn delete_snapshot(&self, id: Uuid) -> Result<bool, BackupTargetError> {
        let response = self
            .authorized(self.client.delete(self.backup_url(id)?))
            .send()
            .await
            .map_err(|_| BackupTargetError::Unavailable)?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if response.status() != StatusCode::NO_CONTENT {
            return Err(error_from_response(response).await);
        }
        Ok(true)
    }
}

impl BackupTarget for CloudflareBackupTarget {
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

fn validate_endpoint(endpoint: &str) -> Result<Url, BackupTargetError> {
    let mut endpoint =
        Url::parse(endpoint.trim()).map_err(|_| BackupTargetError::InvalidRequest)?;
    if endpoint.scheme() != "https"
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(BackupTargetError::InvalidRequest);
    }
    if !endpoint.path().ends_with('/') {
        let normalized_path = format!("{}/", endpoint.path());
        endpoint.set_path(&normalized_path);
    }
    Ok(endpoint)
}

fn validate_token(token: &str) -> Result<(), BackupTargetError> {
    if token.len() < 32
        || token.len() > 512
        || token.as_bytes().iter().any(|byte| !byte.is_ascii_graphic())
    {
        return Err(BackupTargetError::InvalidRequest);
    }
    Ok(())
}

fn metadata_from_headers(
    headers_map: &reqwest::header::HeaderMap,
    expected_id: Uuid,
) -> Result<BackupSnapshotMetadata, BackupTargetError> {
    if header_text(headers_map, CONTENT_TYPE.as_str())?
        .split(';')
        .next()
        != Some(BACKUP_CONTENT_TYPE)
    {
        return Err(BackupTargetError::InvalidResponse);
    }
    let id = header_text(headers_map, headers::SNAPSHOT_ID)?
        .parse::<Uuid>()
        .map_err(|_| BackupTargetError::InvalidResponse)?;
    if id != expected_id {
        return Err(BackupTargetError::InvalidResponse);
    }
    let created_at_ms = header_text(headers_map, headers::CREATED_AT_MS)?
        .parse::<u64>()
        .map_err(|_| BackupTargetError::InvalidResponse)?;
    let size_bytes = header_text(headers_map, CONTENT_LENGTH.as_str())?
        .parse::<u64>()
        .map_err(|_| BackupTargetError::InvalidResponse)?;
    let sha256 = header_text(headers_map, headers::SHA256)?.to_owned();
    let metadata = BackupSnapshotMetadata {
        id,
        created_at_ms,
        size_bytes,
        sha256,
    };
    metadata
        .validate()
        .map_err(|_| BackupTargetError::InvalidResponse)?;
    Ok(metadata)
}

fn header_text<'a>(
    headers_map: &'a reqwest::header::HeaderMap,
    name: &str,
) -> Result<&'a str, BackupTargetError> {
    headers_map
        .get(name)
        .ok_or(BackupTargetError::InvalidResponse)?
        .to_str()
        .map_err(|_| BackupTargetError::InvalidResponse)
}

async fn require_success(
    response: reqwest::Response,
) -> Result<reqwest::Response, BackupTargetError> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(error_from_response(response).await)
    }
}

async fn error_from_response(response: reqwest::Response) -> BackupTargetError {
    let status = response.status();
    let code = read_limited_response(response, 16 * 1024)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<BackupApiErrorResponse>(&bytes).ok())
        .map(|body| body.code);
    match (status, code) {
        (StatusCode::UNAUTHORIZED, _) | (_, Some(BackupApiErrorCode::Unauthorized)) => {
            BackupTargetError::Unauthorized
        }
        (StatusCode::NOT_FOUND, _) | (_, Some(BackupApiErrorCode::SnapshotNotFound)) => {
            BackupTargetError::NotFound
        }
        (StatusCode::CONFLICT, _) | (_, Some(BackupApiErrorCode::SnapshotConflict)) => {
            BackupTargetError::Conflict
        }
        (StatusCode::PAYLOAD_TOO_LARGE, _) | (_, Some(BackupApiErrorCode::PayloadTooLarge)) => {
            BackupTargetError::PayloadTooLarge
        }
        (StatusCode::BAD_REQUEST, _) | (_, Some(BackupApiErrorCode::InvalidRequest)) => {
            BackupTargetError::InvalidRequest
        }
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

    #[test]
    fn endpoint_requires_https_without_embedded_credentials() {
        assert!(validate_endpoint("https://backup.example.test").is_ok());
        assert!(validate_endpoint("http://backup.example.test").is_err());
        assert!(validate_endpoint("https://user:secret@backup.example.test").is_err());
        assert!(validate_endpoint("https://backup.example.test?token=secret").is_err());
    }

    #[test]
    fn token_rejects_short_or_control_character_values() {
        assert!(validate_token(&"a".repeat(32)).is_ok());
        assert!(validate_token("short").is_err());
        assert!(validate_token(&format!("{}\n", "a".repeat(32))).is_err());
    }
}
