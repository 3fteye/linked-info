use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::Manager;

const MAXIMUM_INPUT_COUNT: usize = 64;
const MAXIMUM_INPUT_LENGTH: usize = 2_000;

#[derive(Default)]
pub struct EmbeddingState {
    local_model: Arc<Mutex<Option<TextEmbedding>>>,
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
pub async fn embed_local_texts(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddingState>,
    inputs: Vec<LocalEmbeddingInput>,
) -> Result<Vec<Vec<f32>>, String> {
    let texts = inputs
        .into_iter()
        .map(|input| {
            let prefix = match input.role {
                EmbeddingRole::Query => "query: ",
                EmbeddingRole::Document => "passage: ",
            };
            format!("{prefix}{}", input.text)
        })
        .collect::<Vec<_>>();
    validate_inputs(&texts)?;

    let model_cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("cannot resolve model cache directory: {error}"))?
        .join("models")
        .join("fastembed");
    let local_model = Arc::clone(&state.local_model);

    tauri::async_runtime::spawn_blocking(move || {
        let mut model_guard = local_model
            .lock()
            .map_err(|_| "local embedding model lock is unavailable".to_owned())?;
        if model_guard.is_none() {
            let available_threads = std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1)
                .min(4);
            let options = TextInitOptions::new(EmbeddingModel::MultilingualE5Small)
                .with_cache_dir(model_cache)
                .with_intra_threads(available_threads)
                .with_show_download_progress(false);
            *model_guard =
                Some(TextEmbedding::try_new(options).map_err(|error| {
                    format!("cannot initialize local embedding model: {error}")
                })?);
        }
        model_guard
            .as_mut()
            .ok_or_else(|| "local embedding model was not initialized".to_owned())?
            .embed(texts, Some(MAXIMUM_INPUT_COUNT))
            .map_err(|error| format!("local embedding failed: {error}"))
    })
    .await
    .map_err(|error| format!("local embedding task failed: {error}"))?
}

#[tauri::command]
pub async fn embed_remote_texts(request: RemoteEmbeddingRequest) -> Result<Vec<Vec<f32>>, String> {
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
    use super::{local_http_endpoint_allowed, validate_remote_endpoint};
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
}
