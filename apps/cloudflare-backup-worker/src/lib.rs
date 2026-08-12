use std::collections::HashMap;

use linked_info_backup_port::{
    BACKUP_API_VERSION, BACKUP_CONTENT_TYPE, BackupApiErrorCode, BackupApiErrorResponse,
    BackupListPage, BackupSnapshotMetadata, DEFAULT_BACKUP_PAGE_LIMIT, MAX_BACKUP_PAGE_LIMIT,
    headers, is_sha256, routes,
};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use worker::{
    Conditional, Context, Env, Headers, Include, Request, Response, ResponseBuilder, RouteContext,
    Router, event,
};

const BUCKET_BINDING: &str = "BACKUP_BUCKET";
const AUTH_SECRET_BINDING: &str = "BACKUP_AUTH_TOKEN";
const OBJECT_PREFIX: &str = "snapshots/";
const MAXIMUM_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
const METADATA_API_VERSION: &str = "api_version";
const METADATA_CREATED_AT_MS: &str = "created_at_ms";
const METADATA_SHA256: &str = "sha256";

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> worker::Result<Response> {
    Router::new()
        .get(routes::HEALTH, |_, _| {
            Response::from_json(&serde_json::json!({
                "status": "ok",
                "service": "linked-info-backup-api",
                "apiVersion": BACKUP_API_VERSION,
                "maximumUploadBytes": MAXIMUM_UPLOAD_BYTES,
            }))
        })
        .get_async(routes::BACKUPS, list_backups)
        .put_async(routes::BACKUP, upload_backup)
        .get_async(routes::BACKUP, download_backup)
        .head_async(routes::BACKUP, head_backup)
        .delete_async(routes::BACKUP, delete_backup)
        .run(req, env)
        .await
}

async fn list_backups(req: Request, ctx: RouteContext<()>) -> worker::Result<Response> {
    finish(list_backups_inner(req, ctx).await)
}

async fn list_backups_inner(
    req: Request,
    ctx: RouteContext<()>,
) -> Result<Response, BackupFailure> {
    authorize(&req, &ctx)?;
    let url = req.url()?;
    let mut cursor = None;
    let mut limit = DEFAULT_BACKUP_PAGE_LIMIT;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "cursor" if !value.is_empty() && value.len() <= 2048 => {
                cursor = Some(value.into_owned());
            }
            "limit" => {
                limit = value
                    .parse::<u16>()
                    .map_err(|_| BackupFailure::InvalidRequest)?;
            }
            "cursor" => return Err(BackupFailure::InvalidRequest),
            _ => {}
        }
    }
    if limit == 0 || limit > MAX_BACKUP_PAGE_LIMIT {
        return Err(BackupFailure::InvalidRequest);
    }

    let bucket = ctx.bucket(BUCKET_BINDING)?;
    let mut request = bucket
        .list()
        .prefix(OBJECT_PREFIX)
        .limit(u32::from(limit))
        .include(vec![Include::CustomMetadata]);
    if let Some(cursor) = cursor {
        request = request.cursor(cursor);
    }
    let objects = request.execute().await?;
    let mut items = objects
        .objects()
        .into_iter()
        .map(|object| metadata_from_object(&object))
        .collect::<Result<Vec<_>, _>>()?;
    items.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| right.id.cmp(&left.id))
    });
    let next_cursor = objects.truncated().then(|| objects.cursor()).flatten();
    json_response(200, &BackupListPage { items, next_cursor })
}

async fn upload_backup(req: Request, ctx: RouteContext<()>) -> worker::Result<Response> {
    finish(upload_backup_inner(req, ctx).await)
}

async fn upload_backup_inner(
    req: Request,
    ctx: RouteContext<()>,
) -> Result<Response, BackupFailure> {
    authorize(&req, &ctx)?;
    let id = snapshot_id(&ctx)?;
    let metadata = upload_metadata(&req, id)?;
    let bucket = ctx.bucket(BUCKET_BINDING)?;
    let key = object_key(id);

    if let Some(existing) = bucket.head(&key).await? {
        let existing_metadata = metadata_from_object(&existing)?;
        return if existing_metadata == metadata {
            json_response(200, &existing_metadata)
        } else {
            Err(BackupFailure::Conflict)
        };
    }

    let stream = req.inner().body().ok_or(BackupFailure::InvalidRequest)?;
    let sha256 = decode_sha256(&metadata.sha256)?;
    let mut custom_metadata = HashMap::new();
    custom_metadata.insert(
        METADATA_API_VERSION.to_owned(),
        BACKUP_API_VERSION.to_string(),
    );
    custom_metadata.insert(
        METADATA_CREATED_AT_MS.to_owned(),
        metadata.created_at_ms.to_string(),
    );
    custom_metadata.insert(METADATA_SHA256.to_owned(), metadata.sha256.clone());

    let stored = bucket
        .put(&key, stream)
        .custom_metadata(custom_metadata)
        .sha256(sha256)
        .only_if(Conditional {
            etag_does_not_match: Some("*".to_owned()),
            ..Conditional::default()
        })
        .execute()
        .await?;

    match stored {
        Some(object) => json_response(201, &metadata_from_object(&object)?),
        None => {
            let existing = bucket.head(&key).await?.ok_or(BackupFailure::Storage)?;
            let existing_metadata = metadata_from_object(&existing)?;
            if existing_metadata == metadata {
                json_response(200, &existing_metadata)
            } else {
                Err(BackupFailure::Conflict)
            }
        }
    }
}

async fn download_backup(req: Request, ctx: RouteContext<()>) -> worker::Result<Response> {
    finish(download_backup_inner(req, ctx).await)
}

async fn download_backup_inner(
    req: Request,
    ctx: RouteContext<()>,
) -> Result<Response, BackupFailure> {
    authorize(&req, &ctx)?;
    let id = snapshot_id(&ctx)?;
    let object = ctx
        .bucket(BUCKET_BINDING)?
        .get(object_key(id))
        .execute()
        .await?
        .ok_or(BackupFailure::NotFound)?;
    let metadata = metadata_from_object(&object)?;
    let body = object
        .body()
        .ok_or(BackupFailure::Storage)?
        .response_body()?;
    Ok(snapshot_response_headers(ResponseBuilder::new(), &metadata)?.body(body))
}

async fn head_backup(req: Request, ctx: RouteContext<()>) -> worker::Result<Response> {
    finish(head_backup_inner(req, ctx).await)
}

async fn head_backup_inner(req: Request, ctx: RouteContext<()>) -> Result<Response, BackupFailure> {
    authorize(&req, &ctx)?;
    let id = snapshot_id(&ctx)?;
    let object = ctx
        .bucket(BUCKET_BINDING)?
        .head(object_key(id))
        .await?
        .ok_or(BackupFailure::NotFound)?;
    let metadata = metadata_from_object(&object)?;
    Ok(snapshot_response_headers(ResponseBuilder::new(), &metadata)?.empty())
}

async fn delete_backup(req: Request, ctx: RouteContext<()>) -> worker::Result<Response> {
    finish(delete_backup_inner(req, ctx).await)
}

async fn delete_backup_inner(
    req: Request,
    ctx: RouteContext<()>,
) -> Result<Response, BackupFailure> {
    authorize(&req, &ctx)?;
    let id = snapshot_id(&ctx)?;
    let bucket = ctx.bucket(BUCKET_BINDING)?;
    let key = object_key(id);
    if bucket.head(&key).await?.is_none() {
        return Err(BackupFailure::NotFound);
    }
    bucket.delete(key).await?;
    Ok(ResponseBuilder::new().with_status(204).empty())
}

fn authorize(req: &Request, ctx: &RouteContext<()>) -> Result<(), BackupFailure> {
    let authorization = req
        .headers()
        .get("authorization")
        .map_err(|_| BackupFailure::Unauthorized)?
        .ok_or(BackupFailure::Unauthorized)?;
    let provided = authorization
        .strip_prefix("Bearer ")
        .ok_or(BackupFailure::Unauthorized)?;
    let expected = ctx
        .secret(AUTH_SECRET_BINDING)
        .map_err(|_| BackupFailure::Storage)?
        .to_string();
    if expected.len() < 32 || expected.len() > 512 {
        return Err(BackupFailure::Storage);
    }
    if provided.as_bytes().ct_eq(expected.as_bytes()).into() {
        Ok(())
    } else {
        Err(BackupFailure::Unauthorized)
    }
}

fn snapshot_id(ctx: &RouteContext<()>) -> Result<Uuid, BackupFailure> {
    ctx.param("snapshot_id")
        .ok_or(BackupFailure::InvalidRequest)
        .and_then(|value| Uuid::parse_str(value).map_err(|_| BackupFailure::InvalidRequest))
}

fn upload_metadata(req: &Request, id: Uuid) -> Result<BackupSnapshotMetadata, BackupFailure> {
    let headers = req.headers();
    let content_type = required_header(headers, "content-type")?;
    if content_type.split(';').next() != Some(BACKUP_CONTENT_TYPE) {
        return Err(BackupFailure::InvalidRequest);
    }
    let created_at_ms = required_header(headers, headers::CREATED_AT_MS)?
        .parse::<u64>()
        .map_err(|_| BackupFailure::InvalidRequest)?;
    let size_bytes = required_header(headers, "content-length")?
        .parse::<u64>()
        .map_err(|_| BackupFailure::InvalidRequest)?;
    if size_bytes == 0 {
        return Err(BackupFailure::InvalidRequest);
    }
    if size_bytes > MAXIMUM_UPLOAD_BYTES {
        return Err(BackupFailure::PayloadTooLarge);
    }
    let sha256 = required_header(headers, headers::SHA256)?;
    if !is_sha256(&sha256) {
        return Err(BackupFailure::InvalidRequest);
    }
    let metadata = BackupSnapshotMetadata {
        id,
        created_at_ms,
        size_bytes,
        sha256,
    };
    metadata
        .validate()
        .map_err(|_| BackupFailure::InvalidRequest)?;
    Ok(metadata)
}

fn metadata_from_object(object: &worker::Object) -> Result<BackupSnapshotMetadata, BackupFailure> {
    let id = object
        .key()
        .strip_prefix(OBJECT_PREFIX)
        .and_then(|value| value.strip_suffix(".json"))
        .ok_or(BackupFailure::Storage)
        .and_then(|value| Uuid::parse_str(value).map_err(|_| BackupFailure::Storage))?;
    let custom = object
        .custom_metadata()
        .map_err(|_| BackupFailure::Storage)?;
    let expected_api_version = BACKUP_API_VERSION.to_string();
    if custom.get(METADATA_API_VERSION).map(String::as_str) != Some(expected_api_version.as_str()) {
        return Err(BackupFailure::Storage);
    }
    let created_at_ms = custom
        .get(METADATA_CREATED_AT_MS)
        .ok_or(BackupFailure::Storage)?
        .parse::<u64>()
        .map_err(|_| BackupFailure::Storage)?;
    let sha256 = custom
        .get(METADATA_SHA256)
        .cloned()
        .ok_or(BackupFailure::Storage)?;
    let metadata = BackupSnapshotMetadata {
        id,
        created_at_ms,
        size_bytes: object.size(),
        sha256,
    };
    metadata.validate().map_err(|_| BackupFailure::Storage)?;
    Ok(metadata)
}

fn required_header(headers: &Headers, name: &str) -> Result<String, BackupFailure> {
    headers
        .get(name)
        .map_err(|_| BackupFailure::InvalidRequest)?
        .ok_or(BackupFailure::InvalidRequest)
}

fn object_key(id: Uuid) -> String {
    format!("{OBJECT_PREFIX}{id}.json")
}

fn decode_sha256(value: &str) -> Result<Vec<u8>, BackupFailure> {
    if !is_sha256(value) {
        return Err(BackupFailure::InvalidRequest);
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(|_| BackupFailure::InvalidRequest)?;
            u8::from_str_radix(text, 16).map_err(|_| BackupFailure::InvalidRequest)
        })
        .collect()
}

fn snapshot_response_headers(
    builder: ResponseBuilder,
    metadata: &BackupSnapshotMetadata,
) -> Result<ResponseBuilder, BackupFailure> {
    Ok(builder
        .with_header("content-type", BACKUP_CONTENT_TYPE)?
        .with_header("content-length", &metadata.size_bytes.to_string())?
        .with_header(headers::SNAPSHOT_ID, &metadata.id.to_string())?
        .with_header(headers::CREATED_AT_MS, &metadata.created_at_ms.to_string())?
        .with_header(headers::SHA256, &metadata.sha256)?)
}

fn json_response<T: serde::Serialize>(status: u16, value: &T) -> Result<Response, BackupFailure> {
    ResponseBuilder::new()
        .with_status(status)
        .from_json(value)
        .map_err(BackupFailure::from)
}

fn finish(result: Result<Response, BackupFailure>) -> worker::Result<Response> {
    match result {
        Ok(response) => Ok(response),
        Err(error) => error.response(),
    }
}

#[derive(Debug, Clone, Copy)]
enum BackupFailure {
    Unauthorized,
    InvalidRequest,
    NotFound,
    Conflict,
    PayloadTooLarge,
    Storage,
}

impl BackupFailure {
    fn response(self) -> worker::Result<Response> {
        let (status, code) = match self {
            BackupFailure::Unauthorized => (401, BackupApiErrorCode::Unauthorized),
            BackupFailure::InvalidRequest => (400, BackupApiErrorCode::InvalidRequest),
            BackupFailure::NotFound => (404, BackupApiErrorCode::SnapshotNotFound),
            BackupFailure::Conflict => (409, BackupApiErrorCode::SnapshotConflict),
            BackupFailure::PayloadTooLarge => (413, BackupApiErrorCode::PayloadTooLarge),
            BackupFailure::Storage => (500, BackupApiErrorCode::StorageFailure),
        };
        let mut builder = ResponseBuilder::new().with_status(status);
        if matches!(self, BackupFailure::Unauthorized) {
            builder = builder.with_header("www-authenticate", "Bearer")?;
        }
        builder.from_json(&BackupApiErrorResponse { code })
    }
}

impl From<worker::Error> for BackupFailure {
    fn from(_: worker::Error) -> Self {
        Self::Storage
    }
}
