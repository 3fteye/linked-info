use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use hf_hub::Cache;
use reqwest::{StatusCode, Url, header::RANGE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

const MAXIMUM_INPUT_COUNT: usize = 64;
const MAXIMUM_INPUT_LENGTH: usize = 2_000;
const LOCAL_PROGRESS_EVENT: &str = "linked-info://local-embedding-progress";
const LOCAL_DOWNLOAD_CANCELLED: &str = "local embedding download cancelled";

#[derive(Clone, Copy)]
struct LocalModelFileSpec {
    path: &'static str,
    size: u64,
    sha256: Option<&'static str>,
}

struct LocalModelSpec {
    id: &'static str,
    repository: &'static str,
    revision: &'static str,
    files: &'static [LocalModelFileSpec],
    model: EmbeddingModel,
    query_prefix: &'static str,
    document_prefix: &'static str,
}

const BGE_SMALL_ZH_FILES: &[LocalModelFileSpec] = &[
    LocalModelFileSpec {
        path: "onnx/model.onnx",
        size: 94_851_877,
        sha256: Some("69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a"),
    },
    LocalModelFileSpec {
        path: "tokenizer.json",
        size: 439_125,
        sha256: None,
    },
    LocalModelFileSpec {
        path: "config.json",
        size: 716,
        sha256: None,
    },
    LocalModelFileSpec {
        path: "special_tokens_map.json",
        size: 125,
        sha256: None,
    },
    LocalModelFileSpec {
        path: "tokenizer_config.json",
        size: 367,
        sha256: None,
    },
];

const MINI_LM_L6_FILES: &[LocalModelFileSpec] = &[
    LocalModelFileSpec {
        path: "onnx/model_quantized.onnx",
        size: 22_972_370,
        sha256: Some("afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"),
    },
    LocalModelFileSpec {
        path: "tokenizer.json",
        size: 711_661,
        sha256: None,
    },
    LocalModelFileSpec {
        path: "config.json",
        size: 650,
        sha256: None,
    },
    LocalModelFileSpec {
        path: "special_tokens_map.json",
        size: 125,
        sha256: None,
    },
    LocalModelFileSpec {
        path: "tokenizer_config.json",
        size: 366,
        sha256: None,
    },
];

const MULTILINGUAL_E5_SMALL_FILES: &[LocalModelFileSpec] = &[
    LocalModelFileSpec {
        path: "onnx/model.onnx",
        size: 470_268_510,
        sha256: Some("ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665"),
    },
    LocalModelFileSpec {
        path: "tokenizer.json",
        size: 17_082_730,
        sha256: Some("0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"),
    },
    LocalModelFileSpec {
        path: "config.json",
        size: 655,
        sha256: None,
    },
    LocalModelFileSpec {
        path: "special_tokens_map.json",
        size: 167,
        sha256: None,
    },
    LocalModelFileSpec {
        path: "tokenizer_config.json",
        size: 443,
        sha256: None,
    },
];

static LOCAL_MODELS: &[LocalModelSpec] = &[
    LocalModelSpec {
        id: "BAAI/bge-small-zh-v1.5",
        repository: "Xenova/bge-small-zh-v1.5",
        revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
        files: BGE_SMALL_ZH_FILES,
        model: EmbeddingModel::BGESmallZHV15,
        query_prefix: "",
        document_prefix: "",
    },
    LocalModelSpec {
        id: "sentence-transformers/all-MiniLM-L6-v2",
        repository: "Xenova/all-MiniLM-L6-v2",
        revision: "751bff37182d3f1213fa05d7196b954e230abad9",
        files: MINI_LM_L6_FILES,
        model: EmbeddingModel::AllMiniLML6V2Q,
        query_prefix: "",
        document_prefix: "",
    },
    LocalModelSpec {
        id: "intfloat/multilingual-e5-small",
        repository: "intfloat/multilingual-e5-small",
        revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
        files: MULTILINGUAL_E5_SMALL_FILES,
        model: EmbeddingModel::MultilingualE5Small,
        query_prefix: "query: ",
        document_prefix: "passage: ",
    },
];

struct LoadedLocalModel {
    id: String,
    model: TextEmbedding,
}

pub struct EmbeddingState {
    local_model: Arc<Mutex<Option<LoadedLocalModel>>>,
    local_task_active: Arc<AtomicBool>,
    local_download_cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl Default for EmbeddingState {
    fn default() -> Self {
        Self {
            local_model: Arc::new(Mutex::new(None)),
            local_task_active: Arc::new(AtomicBool::new(false)),
            local_download_cancel: Arc::new(Mutex::new(None)),
        }
    }
}

impl EmbeddingState {
    pub fn shutdown(&self) -> Result<(), String> {
        if let Ok(slot) = self.local_download_cancel.lock() {
            if let Some(cancel) = slot.as_ref() {
                cancel.store(true, Ordering::Release);
            }
        }
        match self.local_model.try_lock() {
            Ok(mut model) => {
                *model = None;
                Ok(())
            }
            Err(std::sync::TryLockError::WouldBlock) => Ok(()),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                Err("local embedding model lock is unavailable".to_owned())
            }
        }
    }
}

struct LocalTaskGuard {
    active: Arc<AtomicBool>,
    cancel_slot: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl Drop for LocalTaskGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.cancel_slot.lock() {
            *slot = None;
        }
        self.active.store(false, Ordering::Release);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEmbeddingInput {
    role: EmbeddingRole,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum EmbeddingRole {
    Query,
    Document,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEmbeddingRequest {
    endpoint: String,
    model: String,
    token: Option<String>,
    inputs: Vec<String>,
}

#[derive(Serialize)]
struct CompatibleEmbeddingRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Deserialize)]
struct CompatibleEmbeddingResponse {
    data: Vec<CompatibleEmbeddingItem>,
}

#[derive(Deserialize)]
struct CompatibleEmbeddingItem {
    index: usize,
    embedding: Vec<f32>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum LocalEmbeddingPhase {
    Checking,
    Downloading,
    Verifying,
    Loading,
    Inferencing,
    Ready,
    Cancelled,
    Failed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalEmbeddingProgress<'a> {
    model_id: &'a str,
    phase: LocalEmbeddingPhase,
    file_name: Option<&'a str>,
    file_index: usize,
    file_count: usize,
    file_downloaded_bytes: u64,
    file_total_bytes: u64,
    downloaded_bytes: u64,
    total_bytes: u64,
    bytes_per_second: Option<u64>,
    eta_seconds: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEmbeddingModelStatus {
    model_id: &'static str,
    cached_bytes: u64,
    total_bytes: u64,
    ready: bool,
}

enum PrepareModelError {
    Cancelled,
    Message(String),
}

impl From<std::io::Error> for PrepareModelError {
    fn from(error: std::io::Error) -> Self {
        Self::Message(error.to_string())
    }
}

impl From<reqwest::Error> for PrepareModelError {
    fn from(error: reqwest::Error) -> Self {
        Self::Message(error.to_string())
    }
}

fn local_model_spec(model_id: &str) -> Result<&'static LocalModelSpec, String> {
    LOCAL_MODELS
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| "local embedding model is not supported".to_owned())
}

fn model_total_bytes(spec: &LocalModelSpec) -> u64 {
    spec.files.iter().map(|file| file.size).sum()
}

fn model_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("cannot resolve model cache directory: {error}"))?
        .join("models")
        .join("fastembed"))
}

fn model_snapshot_dir(cache_dir: &Path, spec: &LocalModelSpec) -> PathBuf {
    Cache::new(cache_dir.to_path_buf())
        .model(spec.repository.to_owned())
        .pointer_path(spec.revision)
}

fn model_file_path(cache_dir: &Path, spec: &LocalModelSpec, file: LocalModelFileSpec) -> PathBuf {
    model_snapshot_dir(cache_dir, spec).join(file.path)
}

fn model_partial_path(
    cache_dir: &Path,
    spec: &LocalModelSpec,
    file: LocalModelFileSpec,
) -> PathBuf {
    if let Some(sha256) = file.sha256 {
        let mut path = Cache::new(cache_dir.to_path_buf())
            .model(spec.repository.to_owned())
            .blob_path(sha256);
        path.set_extension("part");
        path
    } else {
        let mut path = model_file_path(cache_dir, spec, file);
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!("{extension}.part"))
            .unwrap_or_else(|| "part".to_owned());
        path.set_extension(extension);
        path
    }
}

fn existing_file_bytes(path: &Path, maximum: u64) -> u64 {
    path.metadata()
        .map(|metadata| metadata.len().min(maximum))
        .unwrap_or(0)
}

fn model_status(cache_dir: &Path, spec: &'static LocalModelSpec) -> LocalEmbeddingModelStatus {
    let mut ready = true;
    let cached_bytes = spec
        .files
        .iter()
        .map(|file| {
            let final_path = model_file_path(cache_dir, spec, *file);
            if final_path
                .metadata()
                .map(|metadata| metadata.len() == file.size)
                .unwrap_or(false)
            {
                file.size
            } else {
                ready = false;
                existing_file_bytes(&model_partial_path(cache_dir, spec, *file), file.size)
            }
        })
        .sum();
    LocalEmbeddingModelStatus {
        model_id: spec.id,
        cached_bytes,
        total_bytes: model_total_bytes(spec),
        ready,
    }
}

fn emit_local_progress(
    app: &tauri::AppHandle,
    spec: &LocalModelSpec,
    phase: LocalEmbeddingPhase,
    file: Option<(usize, LocalModelFileSpec, u64)>,
    downloaded_bytes: u64,
    bytes_per_second: Option<u64>,
) {
    let total_bytes = model_total_bytes(spec);
    let eta_seconds = bytes_per_second
        .filter(|speed| *speed > 0)
        .map(|speed| total_bytes.saturating_sub(downloaded_bytes) / speed);
    let payload = LocalEmbeddingProgress {
        model_id: spec.id,
        phase,
        file_name: file.map(|(_, file, _)| file.path),
        file_index: file.map(|(index, _, _)| index + 1).unwrap_or(0),
        file_count: spec.files.len(),
        file_downloaded_bytes: file.map(|(_, _, bytes)| bytes).unwrap_or(0),
        file_total_bytes: file.map(|(_, file, _)| file.size).unwrap_or(0),
        downloaded_bytes,
        total_bytes,
        bytes_per_second,
        eta_seconds,
    };
    let _ = app.emit(LOCAL_PROGRESS_EVENT, payload);
}

fn begin_local_task(state: &EmbeddingState) -> Result<(Arc<AtomicBool>, LocalTaskGuard), String> {
    state
        .local_task_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "another local embedding task is already running".to_owned())?;
    let cancel = Arc::new(AtomicBool::new(false));
    match state.local_download_cancel.lock() {
        Ok(mut slot) => *slot = Some(Arc::clone(&cancel)),
        Err(_) => {
            state.local_task_active.store(false, Ordering::Release);
            return Err("local embedding cancellation state is unavailable".to_owned());
        }
    }
    let guard = LocalTaskGuard {
        active: Arc::clone(&state.local_task_active),
        cancel_slot: Arc::clone(&state.local_download_cancel),
    };
    Ok((cancel, guard))
}

async fn wait_for_cancellation(cancel: Arc<AtomicBool>) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
}

async fn send_download_request(
    client: &reqwest::Client,
    url: &str,
    start: u64,
    cancel: Arc<AtomicBool>,
) -> Result<reqwest::Response, PrepareModelError> {
    let mut request = client.get(url);
    if start > 0 {
        request = request.header(RANGE, format!("bytes={start}-"));
    }
    tokio::select! {
        response = tokio::time::timeout(Duration::from_secs(60), request.send()) => {
            match response {
                Ok(response) => Ok(response?),
                Err(_) => Err(PrepareModelError::Message("model download connection timed out".to_owned())),
            }
        },
        _ = wait_for_cancellation(cancel) => Err(PrepareModelError::Cancelled),
    }
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let actual = format!("{:x}", digest.finalize());
    if actual == expected {
        Ok(())
    } else {
        Err("downloaded model file checksum does not match the fixed model version".to_owned())
    }
}

async fn download_model_file(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    cache_dir: &Path,
    spec: &'static LocalModelSpec,
    file_index: usize,
    file: LocalModelFileSpec,
    completed_bytes: u64,
    session_started: Instant,
    session_downloaded: &mut u64,
    cancel: Arc<AtomicBool>,
) -> Result<(), PrepareModelError> {
    let final_path = model_file_path(cache_dir, spec, file);
    if final_path
        .metadata()
        .map(|metadata| metadata.len() == file.size)
        .unwrap_or(false)
    {
        return Ok(());
    }

    let partial_path = model_partial_path(cache_dir, spec, file);
    if let Some(parent) = partial_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut partial_bytes = existing_file_bytes(&partial_path, file.size);
    if partial_path
        .metadata()
        .map(|metadata| metadata.len() > file.size)
        .unwrap_or(false)
    {
        OpenOptions::new()
            .write(true)
            .open(&partial_path)?
            .set_len(0)?;
        partial_bytes = 0;
    }

    let url = format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        spec.repository, spec.revision, file.path
    );
    let mut response =
        send_download_request(client, &url, partial_bytes, Arc::clone(&cancel)).await?;
    if partial_bytes > 0 && response.status() != StatusCode::PARTIAL_CONTENT {
        OpenOptions::new()
            .write(true)
            .open(&partial_path)?
            .set_len(0)?;
        partial_bytes = 0;
        response = send_download_request(client, &url, 0, Arc::clone(&cancel)).await?;
    }
    if !response.status().is_success() {
        return Err(PrepareModelError::Message(format!(
            "model download returned HTTP {} for {}",
            response.status(),
            file.path
        )));
    }

    let mut output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&partial_path)?;
    let mut downloaded = partial_bytes;
    let mut last_emitted = Instant::now() - Duration::from_secs(1);
    emit_local_progress(
        app,
        spec,
        LocalEmbeddingPhase::Downloading,
        Some((file_index, file, downloaded)),
        completed_bytes + downloaded,
        None,
    );

    loop {
        let next = tokio::select! {
            chunk = tokio::time::timeout(Duration::from_secs(60), response.chunk()) => {
                match chunk {
                    Ok(chunk) => chunk?,
                    Err(_) => {
                        output.flush()?;
                        return Err(PrepareModelError::Message(
                            "model download stopped receiving data".to_owned(),
                        ));
                    }
                }
            },
            _ = wait_for_cancellation(Arc::clone(&cancel)) => {
                output.flush()?;
                return Err(PrepareModelError::Cancelled);
            },
        };
        let Some(chunk) = next else {
            break;
        };
        if downloaded + chunk.len() as u64 > file.size {
            return Err(PrepareModelError::Message(format!(
                "model download exceeded the expected size for {}",
                file.path
            )));
        }
        output.write_all(&chunk)?;
        downloaded += chunk.len() as u64;
        *session_downloaded += chunk.len() as u64;
        if last_emitted.elapsed() >= Duration::from_millis(120) || downloaded == file.size {
            let elapsed = session_started.elapsed().as_secs_f64();
            let speed = (elapsed > 0.0).then(|| (*session_downloaded as f64 / elapsed) as u64);
            emit_local_progress(
                app,
                spec,
                LocalEmbeddingPhase::Downloading,
                Some((file_index, file, downloaded)),
                completed_bytes + downloaded,
                speed,
            );
            last_emitted = Instant::now();
        }
    }
    output.flush()?;
    drop(output);

    if downloaded != file.size {
        return Err(PrepareModelError::Message(format!(
            "model download ended at {downloaded} of {} bytes for {}",
            file.size, file.path
        )));
    }
    if cancel.load(Ordering::Acquire) {
        return Err(PrepareModelError::Cancelled);
    }

    emit_local_progress(
        app,
        spec,
        LocalEmbeddingPhase::Verifying,
        Some((file_index, file, downloaded)),
        completed_bytes + downloaded,
        None,
    );
    if let Some(expected) = file.sha256 {
        let verification_path = partial_path.clone();
        let verification = tauri::async_runtime::spawn_blocking(move || {
            verify_sha256(&verification_path, expected)
        })
        .await
        .map_err(|error| PrepareModelError::Message(error.to_string()))?;
        if let Err(error) = verification {
            OpenOptions::new()
                .write(true)
                .open(&partial_path)?
                .set_len(0)?;
            return Err(PrepareModelError::Message(error));
        }
    }
    if cancel.load(Ordering::Acquire) {
        return Err(PrepareModelError::Cancelled);
    }

    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent)?;
    }
    if final_path.exists() {
        fs::remove_file(&final_path)?;
    }
    fs::rename(&partial_path, &final_path)?;
    Ok(())
}

async fn ensure_model_files(
    app: &tauri::AppHandle,
    cache_dir: &Path,
    spec: &'static LocalModelSpec,
    cancel: Arc<AtomicBool>,
) -> Result<(), PrepareModelError> {
    fs::create_dir_all(cache_dir)?;
    let initial_status = model_status(cache_dir, spec);
    emit_local_progress(
        app,
        spec,
        LocalEmbeddingPhase::Checking,
        None,
        initial_status.cached_bytes,
        None,
    );
    if cancel.load(Ordering::Acquire) {
        return Err(PrepareModelError::Cancelled);
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .user_agent("linked-info-desktop/0.1")
        .build()
        .map_err(|error| PrepareModelError::Message(error.to_string()))?;
    let session_started = Instant::now();
    let mut session_downloaded = 0_u64;
    let mut completed_bytes = 0_u64;
    for (index, file) in spec.files.iter().copied().enumerate() {
        download_model_file(
            app,
            &client,
            cache_dir,
            spec,
            index,
            file,
            completed_bytes,
            session_started,
            &mut session_downloaded,
            Arc::clone(&cancel),
        )
        .await?;
        completed_bytes += file.size;
    }

    Cache::new(cache_dir.to_path_buf())
        .model(spec.repository.to_owned())
        .create_ref(spec.revision)?;
    emit_local_progress(
        app,
        spec,
        LocalEmbeddingPhase::Ready,
        None,
        model_total_bytes(spec),
        None,
    );
    Ok(())
}

fn emit_prepare_failure(
    app: &tauri::AppHandle,
    spec: &'static LocalModelSpec,
    error: PrepareModelError,
) -> String {
    let status = model_status(
        &model_cache_dir(app).unwrap_or_else(|_| PathBuf::new()),
        spec,
    );
    match error {
        PrepareModelError::Cancelled => {
            emit_local_progress(
                app,
                spec,
                LocalEmbeddingPhase::Cancelled,
                None,
                status.cached_bytes,
                None,
            );
            LOCAL_DOWNLOAD_CANCELLED.to_owned()
        }
        PrepareModelError::Message(message) => {
            emit_local_progress(
                app,
                spec,
                LocalEmbeddingPhase::Failed,
                None,
                status.cached_bytes,
                None,
            );
            format!("cannot prepare local embedding model: {message}")
        }
    }
}

fn validate_inputs(inputs: &[String]) -> Result<(), String> {
    if inputs.is_empty() || inputs.len() > MAXIMUM_INPUT_COUNT {
        return Err("embedding input count is outside the supported range".to_owned());
    }
    if inputs
        .iter()
        .any(|input| input.is_empty() || input.chars().count() > MAXIMUM_INPUT_LENGTH)
    {
        return Err("an embedding input is empty or too long".to_owned());
    }
    Ok(())
}

fn local_http_endpoint_allowed(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(host)
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

fn validate_remote_endpoint(endpoint: &str) -> Result<Url, String> {
    let url =
        Url::parse(endpoint).map_err(|_| "remote embedding endpoint is invalid".to_owned())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("remote embedding endpoint cannot contain credentials".to_owned());
    }
    if url.scheme() != "https" && !(url.scheme() == "http" && local_http_endpoint_allowed(&url)) {
        return Err(
            "remote embedding endpoint must use HTTPS, except for a loopback address".to_owned(),
        );
    }
    Ok(url)
}

#[tauri::command]
pub fn inspect_local_embedding_models(
    app: tauri::AppHandle,
) -> Result<Vec<LocalEmbeddingModelStatus>, String> {
    let cache_dir = model_cache_dir(&app)?;
    Ok(LOCAL_MODELS
        .iter()
        .map(|spec| model_status(&cache_dir, spec))
        .collect())
}

#[tauri::command]
pub fn cancel_local_embedding_download(
    state: tauri::State<'_, EmbeddingState>,
) -> Result<(), String> {
    let slot = state
        .local_download_cancel
        .lock()
        .map_err(|_| "local embedding cancellation state is unavailable".to_owned())?;
    if let Some(cancel) = slot.as_ref() {
        cancel.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_local_embedding_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddingState>,
    model_id: String,
) -> Result<(), String> {
    let spec = local_model_spec(&model_id)?;
    let (cancel, _guard) = begin_local_task(&state)?;
    let cache_dir = model_cache_dir(&app)?;
    ensure_model_files(&app, &cache_dir, spec, cancel)
        .await
        .map_err(|error| emit_prepare_failure(&app, spec, error))
}

#[tauri::command]
pub async fn embed_local_texts(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddingState>,
    vault_state: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
    model_id: String,
    inputs: Vec<LocalEmbeddingInput>,
) -> Result<Vec<Vec<f32>>, String> {
    crate::workspace_file::require_workspace_unlocked(&app, &vault_state)?;
    let spec = local_model_spec(&model_id)?;
    let texts = inputs
        .into_iter()
        .map(|input| {
            let prefix = match input.role {
                EmbeddingRole::Query => spec.query_prefix,
                EmbeddingRole::Document => spec.document_prefix,
            };
            format!("{prefix}{}", input.text)
        })
        .collect::<Vec<_>>();
    validate_inputs(&texts)?;

    let (cancel, _guard) = begin_local_task(&state)?;
    let cache_dir = model_cache_dir(&app)?;
    ensure_model_files(&app, &cache_dir, spec, Arc::clone(&cancel))
        .await
        .map_err(|error| emit_prepare_failure(&app, spec, error))?;

    emit_local_progress(
        &app,
        spec,
        LocalEmbeddingPhase::Loading,
        None,
        model_total_bytes(spec),
        None,
    );
    let local_model = Arc::clone(&state.local_model);
    let loading_model_id = model_id.clone();
    let embedding_model = spec.model.clone();
    let loading_cache_dir = cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut model_guard = local_model
            .lock()
            .map_err(|_| "local embedding model lock is unavailable".to_owned())?;
        if model_guard.as_ref().map(|loaded| loaded.id.as_str()) != Some(loading_model_id.as_str())
        {
            let available_threads = std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1)
                .min(4);
            let options = TextInitOptions::new(embedding_model)
                .with_cache_dir(loading_cache_dir)
                .with_intra_threads(available_threads)
                .with_show_download_progress(false);
            let model = TextEmbedding::try_new(options)
                .map_err(|error| format!("cannot initialize local embedding model: {error}"))?;
            *model_guard = Some(LoadedLocalModel {
                id: loading_model_id,
                model,
            });
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("local embedding loading task failed: {error}"))??;

    emit_local_progress(
        &app,
        spec,
        LocalEmbeddingPhase::Inferencing,
        None,
        model_total_bytes(spec),
        None,
    );
    let local_model = Arc::clone(&state.local_model);
    let vectors = tauri::async_runtime::spawn_blocking(move || {
        let mut model_guard = local_model
            .lock()
            .map_err(|_| "local embedding model lock is unavailable".to_owned())?;
        model_guard
            .as_mut()
            .ok_or_else(|| "local embedding model was not initialized".to_owned())?
            .model
            .embed(texts, Some(MAXIMUM_INPUT_COUNT))
            .map_err(|error| format!("local embedding failed: {error}"))
    })
    .await
    .map_err(|error| format!("local embedding task failed: {error}"))??;
    emit_local_progress(
        &app,
        spec,
        LocalEmbeddingPhase::Ready,
        None,
        model_total_bytes(spec),
        None,
    );
    Ok(vectors)
}

#[tauri::command]
pub async fn embed_remote_texts(
    app: tauri::AppHandle,
    request: RemoteEmbeddingRequest,
) -> Result<Vec<Vec<f32>>, String> {
    if crate::workspace_file::workspace_encryption_configured(&app) {
        return Err("remote_embedding_blocked_for_encrypted_workspace".to_owned());
    }
    if request.endpoint.len() > 2_048
        || request.model.trim().is_empty()
        || request.model.len() > 256
        || request.token.as_deref().map(str::len).unwrap_or(0) > 8_192
    {
        return Err("remote embedding configuration is incomplete or too long".to_owned());
    }
    validate_inputs(&request.inputs)?;
    let endpoint = validate_remote_endpoint(request.endpoint.trim())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("cannot create remote embedding client: {error}"))?;
    let body = CompatibleEmbeddingRequest {
        model: request.model.trim(),
        input: &request.inputs,
    };
    let mut http_request = client.post(endpoint).json(&body);
    if let Some(token) = request
        .token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        http_request = http_request.bearer_auth(token);
    }
    let response = http_request
        .send()
        .await
        .map_err(|error| format!("remote embedding request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "remote embedding endpoint returned HTTP {}",
            response.status()
        ));
    }
    let mut response = response
        .json::<CompatibleEmbeddingResponse>()
        .await
        .map_err(|error| format!("remote embedding response is invalid: {error}"))?;
    response.data.sort_by_key(|item| item.index);
    if response.data.len() != request.inputs.len()
        || response
            .data
            .iter()
            .enumerate()
            .any(|(index, item)| item.index != index || item.embedding.is_empty())
    {
        return Err("remote embedding response does not match the request".to_owned());
    }
    Ok(response
        .data
        .into_iter()
        .map(|item| item.embedding)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        LOCAL_MODELS, local_http_endpoint_allowed, local_model_spec, model_total_bytes,
        validate_remote_endpoint,
    };
    use reqwest::Url;

    #[test]
    fn remote_endpoint_requires_https_except_for_loopback() {
        assert!(validate_remote_endpoint("https://example.com/v1/embeddings").is_ok());
        assert!(validate_remote_endpoint("http://127.0.0.1:11434/v1/embeddings").is_ok());
        assert!(validate_remote_endpoint("http://example.com/v1/embeddings").is_err());
        assert!(validate_remote_endpoint("https://token@example.com/v1/embeddings").is_err());
        assert!(local_http_endpoint_allowed(
            &Url::parse("http://[::1]:11434/v1/embeddings").unwrap()
        ));
    }

    #[test]
    fn local_model_catalog_uses_fixed_non_empty_files() {
        assert_eq!(LOCAL_MODELS.len(), 3);
        for model in LOCAL_MODELS {
            assert_eq!(local_model_spec(model.id).unwrap().id, model.id);
            assert!(!model.revision.is_empty());
            assert!(model.files.iter().all(|file| file.size > 0));
            assert_eq!(
                model_total_bytes(model),
                model.files.iter().map(|file| file.size).sum::<u64>()
            );
        }
    }
}
