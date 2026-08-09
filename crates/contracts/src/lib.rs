use serde::{Deserialize, Serialize};
use utoipa::{OpenApi, ToSchema};
use uuid::Uuid;

pub const DEFAULT_PAGE_LIMIT: u16 = 100;
pub const MAX_PAGE_LIMIT: u16 = 200;

pub mod routes {
    pub const HEALTH: &str = "/health";
    pub const OPENAPI: &str = "/openapi.json";
    pub const NODES: &str = "/v1/nodes";
    pub const NODE: &str = "/v1/nodes/{node_id}";
    pub const NODE_REFERENCES: &str = "/v1/nodes/{node_id}/references";
    pub const NODE_REFERRERS: &str = "/v1/nodes/{node_id}/referrers";
    pub const REFERENCES: &str = "/v1/references";
    pub const REFERENCE: &str = "/v1/references/{source_node_id}/{target_node_id}";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CreateNodeRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PageQuery {
    #[serde(default)]
    pub offset: u32,
    #[serde(default = "default_page_limit")]
    pub limit: u16,
}

impl Default for PageQuery {
    fn default() -> Self {
        Self {
            offset: 0,
            limit: DEFAULT_PAGE_LIMIT,
        }
    }
}

const fn default_page_limit() -> u16 {
    DEFAULT_PAGE_LIMIT
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ListNodesQuery {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(flatten)]
    pub page: PageQuery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct UpdateNodeRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CreateReferenceRequest {
    pub source_node_id: Uuid,
    pub target_node_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct NodeResource {
    pub id: Uuid,
    pub name: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct NodeListResponse {
    pub items: Vec<NodeResource>,
    pub next_offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ReferenceResource {
    pub source_node_id: Uuid,
    pub target_node_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApiErrorCode {
    InvalidRequest,
    NodeNotFound,
    DuplicateNodeName,
    ReferenceEndpointNotFound,
    RouteNotFound,
    StorageFailure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ApiErrorResponse {
    pub code: ApiErrorCode,
}

#[derive(OpenApi)]
#[openapi(
    paths(
        endpoints::list_nodes,
        endpoints::create_node,
        endpoints::get_node,
        endpoints::update_node,
        endpoints::list_references,
        endpoints::list_referrers,
        endpoints::create_reference,
        endpoints::remove_reference,
    ),
    components(schemas(
        CreateNodeRequest,
        ListNodesQuery,
        PageQuery,
        UpdateNodeRequest,
        CreateReferenceRequest,
        NodeResource,
        NodeListResponse,
        ReferenceResource,
        ApiErrorCode,
        ApiErrorResponse,
    )),
    tags(
        (name = "nodes", description = "Node operations"),
        (name = "references", description = "Directed node reference operations")
    )
)]
pub struct ApiContract;

pub fn openapi_document() -> utoipa::openapi::OpenApi {
    ApiContract::openapi()
}

// Utoipa reads these marker functions through macros when building ApiContract.
#[allow(dead_code)]
mod endpoints {
    use super::*;

    #[utoipa::path(
        get,
        path = "/v1/nodes",
        params(
            ("search" = Option<String>, Query, description = "Name search query"),
            ("offset" = Option<u32>, Query, description = "Zero-based result offset"),
            ("limit" = Option<u16>, Query, description = "Page size, at most 200")
        ),
        responses(
            (status = 200, description = "Nodes ordered by normalized name", body = NodeListResponse),
            (status = 500, description = "Storage failure", body = ApiErrorResponse)
        ),
        tag = "nodes"
    )]
    pub fn list_nodes() {}

    #[utoipa::path(
        post,
        path = "/v1/nodes",
        request_body = CreateNodeRequest,
        responses(
            (status = 201, description = "Node created", body = NodeResource),
            (status = 400, description = "Invalid request", body = ApiErrorResponse),
            (status = 409, description = "Non-empty name already exists", body = ApiErrorResponse)
        ),
        tag = "nodes"
    )]
    pub fn create_node() {}

    #[utoipa::path(
        get,
        path = "/v1/nodes/{node_id}",
        params(("node_id" = Uuid, Path, description = "Stable node ID")),
        responses(
            (status = 200, description = "Node found", body = NodeResource),
            (status = 404, description = "Node not found", body = ApiErrorResponse)
        ),
        tag = "nodes"
    )]
    pub fn get_node() {}

    #[utoipa::path(
        put,
        path = "/v1/nodes/{node_id}",
        params(("node_id" = Uuid, Path, description = "Stable node ID")),
        request_body = UpdateNodeRequest,
        responses(
            (status = 200, description = "Node updated", body = NodeResource),
            (status = 400, description = "Invalid request", body = ApiErrorResponse),
            (status = 404, description = "Node not found", body = ApiErrorResponse),
            (status = 409, description = "Non-empty name already exists", body = ApiErrorResponse)
        ),
        tag = "nodes"
    )]
    pub fn update_node() {}

    #[utoipa::path(
        get,
        path = "/v1/nodes/{node_id}/references",
        params(
            ("node_id" = Uuid, Path, description = "Source node ID"),
            ("offset" = Option<u32>, Query, description = "Zero-based result offset"),
            ("limit" = Option<u16>, Query, description = "Page size, at most 200")
        ),
        responses((status = 200, description = "Nodes directly referenced by the source", body = NodeListResponse)),
        tag = "references"
    )]
    pub fn list_references() {}

    #[utoipa::path(
        get,
        path = "/v1/nodes/{node_id}/referrers",
        params(
            ("node_id" = Uuid, Path, description = "Target node ID"),
            ("offset" = Option<u32>, Query, description = "Zero-based result offset"),
            ("limit" = Option<u16>, Query, description = "Page size, at most 200")
        ),
        responses((status = 200, description = "Nodes directly referencing the target", body = NodeListResponse)),
        tag = "references"
    )]
    pub fn list_referrers() {}

    #[utoipa::path(
        post,
        path = "/v1/references",
        request_body = CreateReferenceRequest,
        responses(
            (status = 201, description = "Reference created", body = ReferenceResource),
            (status = 404, description = "Reference endpoint not found", body = ApiErrorResponse)
        ),
        tag = "references"
    )]
    pub fn create_reference() {}

    #[utoipa::path(
        delete,
        path = "/v1/references/{source_node_id}/{target_node_id}",
        params(
            ("source_node_id" = Uuid, Path, description = "Source node ID"),
            ("target_node_id" = Uuid, Path, description = "Target node ID")
        ),
        responses((status = 204, description = "Reference removed")),
        tag = "references"
    )]
    pub fn remove_reference() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openapi_document_contains_the_versioned_node_routes() {
        let document = serde_json::to_value(openapi_document()).expect("OpenAPI serializes");

        assert!(document["paths"][routes::NODES].is_object());
        assert!(document["paths"][routes::NODE_REFERENCES].is_object());
        assert!(document["paths"][routes::REFERENCE].is_object());
    }

    #[test]
    fn pagination_has_a_bounded_default() {
        let query = PageQuery::default();

        assert_eq!(query.offset, 0);
        assert_eq!(query.limit, DEFAULT_PAGE_LIMIT);
    }
}
