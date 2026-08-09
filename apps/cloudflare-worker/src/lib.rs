use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get},
};
use linked_info_application::GraphService;
use linked_info_contracts::{
    ApiErrorCode, ApiErrorResponse, CreateNodeRequest, CreateReferenceRequest, ListNodesQuery,
    MAX_PAGE_LIMIT, NodeListResponse, NodeResource, PageQuery, ReferenceResource,
    UpdateNodeRequest, openapi_document, routes,
};
use linked_info_domain::{Node, NodeId, Reference};
use linked_info_storage_d1::{D1GraphStore, D1StoreError};
use serde::Serialize;
use tower_service::Service;
use uuid::Uuid;
use worker::{Context, Env, HttpRequest, event};

const DATABASE_BINDING: &str = "DB";

#[derive(Clone)]
struct AppState {
    env: Env,
}

fn router(env: Env) -> Router {
    Router::new()
        .route("/", get(health))
        .route(routes::HEALTH, get(health))
        .route(routes::OPENAPI, get(openapi))
        .route(routes::NODES, get(list_nodes).post(create_node))
        .route(routes::NODE, get(get_node).put(update_node))
        .route(routes::NODE_REFERENCES, get(list_references))
        .route(routes::NODE_REFERRERS, get(list_referrers))
        .route(routes::REFERENCES, axum::routing::post(create_reference))
        .route(routes::REFERENCE, delete(remove_reference))
        .fallback(not_found)
        .with_state(AppState { env })
}

#[event(fetch)]
async fn fetch(req: HttpRequest, env: Env, _ctx: Context) -> worker::Result<Response> {
    Ok(router(env).call(req).await?)
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

async fn openapi() -> impl IntoResponse {
    Json(openapi_document())
}

#[worker::send]
async fn list_nodes(
    State(state): State<AppState>,
    query: Result<Query<ListNodesQuery>, QueryRejection>,
) -> Result<Json<NodeListResponse>, ApiFailure> {
    let Query(query) = query.map_err(|_| ApiFailure::InvalidRequest)?;
    let page = page_window(&query.page)?;
    let service = graph_service(&state)?;
    let nodes = match query.search {
        Some(search) => {
            service
                .search_nodes_by_name(&search, page.offset, page.fetch_limit)
                .await?
        }
        None => service.list_nodes(page.offset, page.fetch_limit).await?,
    };
    Ok(Json(node_list_response(nodes, page)))
}

#[worker::send]
async fn create_node(
    State(state): State<AppState>,
    payload: Result<Json<CreateNodeRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<NodeResource>), ApiFailure> {
    let Json(request) = payload.map_err(|_| ApiFailure::InvalidRequest)?;
    let node = Node::new(request.name, request.content);
    graph_service(&state)?.save_node(node.clone()).await?;
    Ok((StatusCode::CREATED, Json(node_resource(&node))))
}

#[worker::send]
async fn get_node(
    State(state): State<AppState>,
    Path(node_id): Path<String>,
) -> Result<Json<NodeResource>, ApiFailure> {
    let node_id = parse_node_id(&node_id)?;
    let node = graph_service(&state)?
        .find_node(node_id)
        .await?
        .ok_or(ApiFailure::NodeNotFound)?;
    Ok(Json(node_resource(&node)))
}

#[worker::send]
async fn update_node(
    State(state): State<AppState>,
    Path(node_id): Path<String>,
    payload: Result<Json<UpdateNodeRequest>, JsonRejection>,
) -> Result<Json<NodeResource>, ApiFailure> {
    let node_id = parse_node_id(&node_id)?;
    let Json(request) = payload.map_err(|_| ApiFailure::InvalidRequest)?;
    let service = graph_service(&state)?;
    let mut node = service
        .find_node(node_id)
        .await?
        .ok_or(ApiFailure::NodeNotFound)?;
    node.set_name(request.name);
    node.set_content(request.content);
    service.save_node(node.clone()).await?;
    Ok(Json(node_resource(&node)))
}

#[worker::send]
async fn list_references(
    State(state): State<AppState>,
    Path(node_id): Path<String>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Result<Json<NodeListResponse>, ApiFailure> {
    let node_id = parse_node_id(&node_id)?;
    let Query(query) = query.map_err(|_| ApiFailure::InvalidRequest)?;
    let page = page_window(&query)?;
    let service = graph_service(&state)?;
    require_node(&service, node_id).await?;
    let nodes = service
        .nodes_referenced_by(node_id, page.offset, page.fetch_limit)
        .await?;
    Ok(Json(node_list_response(nodes, page)))
}

#[worker::send]
async fn list_referrers(
    State(state): State<AppState>,
    Path(node_id): Path<String>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Result<Json<NodeListResponse>, ApiFailure> {
    let node_id = parse_node_id(&node_id)?;
    let Query(query) = query.map_err(|_| ApiFailure::InvalidRequest)?;
    let page = page_window(&query)?;
    let service = graph_service(&state)?;
    require_node(&service, node_id).await?;
    let nodes = service
        .nodes_referencing(node_id, page.offset, page.fetch_limit)
        .await?;
    Ok(Json(node_list_response(nodes, page)))
}

#[worker::send]
async fn create_reference(
    State(state): State<AppState>,
    payload: Result<Json<CreateReferenceRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<ReferenceResource>), ApiFailure> {
    let Json(request) = payload.map_err(|_| ApiFailure::InvalidRequest)?;
    let reference = Reference::new(
        NodeId::from_uuid(request.source_node_id),
        NodeId::from_uuid(request.target_node_id),
    );
    graph_service(&state)?.add_reference(reference).await?;
    Ok((
        StatusCode::CREATED,
        Json(ReferenceResource {
            source_node_id: request.source_node_id,
            target_node_id: request.target_node_id,
        }),
    ))
}

#[worker::send]
async fn remove_reference(
    State(state): State<AppState>,
    Path((source_node_id, target_node_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiFailure> {
    let reference = Reference::new(
        parse_node_id(&source_node_id)?,
        parse_node_id(&target_node_id)?,
    );
    graph_service(&state)?.remove_reference(reference).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn not_found() -> (StatusCode, Json<ApiErrorResponse>) {
    error_response(StatusCode::NOT_FOUND, ApiErrorCode::RouteNotFound)
}

type D1GraphService = GraphService<D1GraphStore>;

fn graph_service(state: &AppState) -> Result<D1GraphService, ApiFailure> {
    let database = state.env.d1(DATABASE_BINDING).map_err(D1StoreError::from)?;
    Ok(GraphService::new(D1GraphStore::new(database)))
}

async fn require_node(service: &D1GraphService, id: NodeId) -> Result<(), ApiFailure> {
    if service.find_node(id).await?.is_some() {
        Ok(())
    } else {
        Err(ApiFailure::NodeNotFound)
    }
}

fn parse_node_id(value: &str) -> Result<NodeId, ApiFailure> {
    Uuid::parse_str(value)
        .map(NodeId::from_uuid)
        .map_err(|_| ApiFailure::InvalidRequest)
}

fn node_resource(node: &Node) -> NodeResource {
    NodeResource {
        id: node.id().as_uuid(),
        name: node.name().map(str::to_owned),
        content: node.content().map(str::to_owned),
    }
}

#[derive(Clone, Copy)]
struct PageWindow {
    offset: u32,
    requested_limit: u32,
    fetch_limit: u32,
}

fn page_window(query: &PageQuery) -> Result<PageWindow, ApiFailure> {
    if query.limit == 0 || query.limit > MAX_PAGE_LIMIT || query.offset > i32::MAX as u32 {
        return Err(ApiFailure::InvalidRequest);
    }

    let requested_limit = u32::from(query.limit);
    let fetch_limit = requested_limit + 1;
    query
        .offset
        .checked_add(requested_limit)
        .ok_or(ApiFailure::InvalidRequest)?;

    Ok(PageWindow {
        offset: query.offset,
        requested_limit,
        fetch_limit,
    })
}

fn node_list_response(mut nodes: Vec<Node>, page: PageWindow) -> NodeListResponse {
    let has_more = nodes.len() > page.requested_limit as usize;
    nodes.truncate(page.requested_limit as usize);
    NodeListResponse {
        items: nodes.iter().map(node_resource).collect(),
        next_offset: has_more.then_some(page.offset + page.requested_limit),
    }
}

#[derive(Debug)]
enum ApiFailure {
    InvalidRequest,
    NodeNotFound,
    DuplicateNodeName,
    ReferenceEndpointNotFound,
    Storage(D1StoreError),
}

impl From<D1StoreError> for ApiFailure {
    fn from(error: D1StoreError) -> Self {
        match error {
            D1StoreError::DuplicateNodeName => Self::DuplicateNodeName,
            D1StoreError::NodeNotFound(_) => Self::ReferenceEndpointNotFound,
            other => Self::Storage(other),
        }
    }
}

impl IntoResponse for ApiFailure {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::InvalidRequest => (StatusCode::BAD_REQUEST, ApiErrorCode::InvalidRequest),
            Self::NodeNotFound => (StatusCode::NOT_FOUND, ApiErrorCode::NodeNotFound),
            Self::DuplicateNodeName => (StatusCode::CONFLICT, ApiErrorCode::DuplicateNodeName),
            Self::ReferenceEndpointNotFound => (
                StatusCode::NOT_FOUND,
                ApiErrorCode::ReferenceEndpointNotFound,
            ),
            Self::Storage(error) => {
                worker::console_error!(
                    "{}",
                    serde_json::json!({
                        "event": "request_failed",
                        "error": error.to_string(),
                    })
                );
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ApiErrorCode::StorageFailure,
                )
            }
        };
        error_response(status, code).into_response()
    }
}

fn error_response(status: StatusCode, code: ApiErrorCode) -> (StatusCode, Json<ApiErrorResponse>) {
    (status, Json(ApiErrorResponse { code }))
}
