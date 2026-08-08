use axum::{Json, Router, http::StatusCode, routing::get};
use serde::Serialize;
use tower_service::Service;
use worker::*;

fn router() -> Router {
    Router::new()
        .route("/", get(health))
        .route("/health", get(health))
        .fallback(not_found)
}

#[event(fetch)]
async fn fetch(
    req: HttpRequest,
    _env: Env,
    _ctx: Context,
) -> Result<axum::http::Response<axum::body::Body>> {
    Ok(router().call(req).await?)
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "linked-info-api",
    })
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

async fn not_found() -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorResponse { error: "not_found" }),
    )
}
