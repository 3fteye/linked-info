use std::str::FromStr;

use linked_info_domain::{Node, NodeId, Reference, normalize_node_name};
use linked_info_storage_port::GraphStore;
use serde::Deserialize;
use thiserror::Error;
use uuid::Error as UuidError;
use worker::{D1Database, D1PreparedStatement, D1Result, D1Type};

const LIST_NODES_SQL: &str = "SELECT id, name, content FROM nodes \
     ORDER BY normalized_name IS NOT NULL, normalized_name, id LIMIT ? OFFSET ?";
const SEARCH_NODES_SQL: &str = "SELECT id, name, content FROM nodes \
     WHERE COALESCE(normalized_name, '') LIKE '%' || ? || '%' ESCAPE '\\' \
     ORDER BY normalized_name IS NOT NULL, normalized_name, id LIMIT ? OFFSET ?";
const FIND_NODE_SQL: &str = "SELECT id, name, content FROM nodes WHERE id = ?";
const SAVE_NODE_SQL: &str = "INSERT INTO nodes (id, name, normalized_name, content) \
     VALUES (?, ?, ?, ?) \
     ON CONFLICT(id) DO UPDATE SET \
       name = excluded.name, \
       normalized_name = excluded.normalized_name, \
       content = excluded.content";
const DELETE_NODE_REFERENCES_SQL: &str = "DELETE FROM node_references \
     WHERE source_node_id = ? OR target_node_id = ?";
const DELETE_NODE_SQL: &str = "DELETE FROM nodes WHERE id = ?";
const ADD_REFERENCE_SQL: &str = "INSERT OR IGNORE INTO node_references \
     (source_node_id, target_node_id) VALUES (?, ?)";
const REMOVE_REFERENCE_SQL: &str = "DELETE FROM node_references \
     WHERE source_node_id = ? AND target_node_id = ?";
const LIST_REFERRERS_SQL: &str = "SELECT n.id, n.name, n.content \
     FROM node_references r \
     JOIN nodes n ON n.id = r.source_node_id \
     WHERE r.target_node_id = ? \
     ORDER BY n.normalized_name IS NOT NULL, n.normalized_name, n.id LIMIT ? OFFSET ?";
const LIST_REFERENCES_SQL: &str = "SELECT n.id, n.name, n.content \
     FROM node_references r \
     JOIN nodes n ON n.id = r.target_node_id \
     WHERE r.source_node_id = ? \
     ORDER BY n.normalized_name IS NOT NULL, n.normalized_name, n.id LIMIT ? OFFSET ?";

#[derive(Debug)]
pub struct D1GraphStore {
    database: D1Database,
}

impl D1GraphStore {
    pub fn new(database: D1Database) -> Self {
        Self { database }
    }

    async fn nodes_from_statement(
        statement: D1PreparedStatement,
    ) -> Result<Vec<Node>, D1StoreError> {
        let result = statement.all().await.map_err(D1StoreError::from)?;
        ensure_success(&result)?;
        result
            .results::<NodeRow>()
            .map_err(D1StoreError::from)?
            .into_iter()
            .map(NodeRow::into_node)
            .collect()
    }

    async fn require_node(&self, id: NodeId) -> Result<(), D1StoreError> {
        if self.find_node(id).await?.is_some() {
            Ok(())
        } else {
            Err(D1StoreError::NodeNotFound(id))
        }
    }
}

impl GraphStore for D1GraphStore {
    type Error = D1StoreError;

    async fn list_nodes(&self, offset: u32, limit: u32) -> Result<Vec<Node>, Self::Error> {
        let values = [
            D1Type::Integer(to_d1_integer(limit)?),
            D1Type::Integer(to_d1_integer(offset)?),
        ];
        let statement = self
            .database
            .prepare(LIST_NODES_SQL)
            .bind_refs(&values)
            .map_err(D1StoreError::from)?;
        Self::nodes_from_statement(statement).await
    }

    async fn search_nodes_by_name(
        &self,
        query: String,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Node>, Self::Error> {
        let query = escape_like(&normalize_node_name(&query));
        let values = [
            D1Type::Text(&query),
            D1Type::Integer(to_d1_integer(limit)?),
            D1Type::Integer(to_d1_integer(offset)?),
        ];
        let statement = self
            .database
            .prepare(SEARCH_NODES_SQL)
            .bind_refs(&values)
            .map_err(D1StoreError::from)?;
        Self::nodes_from_statement(statement).await
    }

    async fn find_node(&self, id: NodeId) -> Result<Option<Node>, Self::Error> {
        let id = id.to_string();
        let values = [D1Type::Text(&id)];
        let row = self
            .database
            .prepare(FIND_NODE_SQL)
            .bind_refs(&values)
            .map_err(D1StoreError::from)?
            .first::<NodeRow>(None)
            .await
            .map_err(D1StoreError::from)?;
        row.map(NodeRow::into_node).transpose()
    }

    async fn save_node(&self, node: Node) -> Result<(), Self::Error> {
        let id = node.id().to_string();
        let normalized_name = node.normalized_name();
        let name = match node.name() {
            Some(name) => D1Type::Text(name),
            None => D1Type::Null,
        };
        let normalized_name = match normalized_name.as_deref() {
            Some(normalized_name) => D1Type::Text(normalized_name),
            None => D1Type::Null,
        };
        let content = match node.content() {
            Some(content) => D1Type::Text(content),
            None => D1Type::Null,
        };
        let values = [D1Type::Text(&id), name, normalized_name, content];
        let result = self
            .database
            .prepare(SAVE_NODE_SQL)
            .bind_refs(&values)
            .map_err(D1StoreError::from)?
            .run()
            .await
            .map_err(D1StoreError::from)?;
        ensure_success(&result)
    }

    async fn delete_node(&self, id: NodeId) -> Result<(), Self::Error> {
        let node_id = id;
        let id = id.to_string();
        let reference_values = [D1Type::Text(&id), D1Type::Text(&id)];
        let node_values = [D1Type::Text(&id)];
        let delete_references = self
            .database
            .prepare(DELETE_NODE_REFERENCES_SQL)
            .bind_refs(&reference_values)
            .map_err(D1StoreError::from)?;
        let delete_node = self
            .database
            .prepare(DELETE_NODE_SQL)
            .bind_refs(&node_values)
            .map_err(D1StoreError::from)?;
        let results = self
            .database
            .batch(vec![delete_references, delete_node])
            .await
            .map_err(D1StoreError::from)?;
        if results.len() != 2 {
            return Err(D1StoreError::Operation(format!(
                "D1 deletion batch returned {} results instead of 2",
                results.len()
            )));
        }
        for result in &results {
            ensure_success(result)?;
        }
        let deleted_node_count = results[1]
            .meta()
            .map_err(D1StoreError::from)?
            .and_then(|meta| meta.changes)
            .unwrap_or(0);
        if deleted_node_count == 0 {
            return Err(D1StoreError::NodeNotFound(node_id));
        }
        Ok(())
    }

    async fn add_reference(&self, reference: Reference) -> Result<(), Self::Error> {
        self.require_node(reference.source_node_id()).await?;
        self.require_node(reference.target_node_id()).await?;

        let source_id = reference.source_node_id().to_string();
        let target_id = reference.target_node_id().to_string();
        let values = [D1Type::Text(&source_id), D1Type::Text(&target_id)];
        let result = self
            .database
            .prepare(ADD_REFERENCE_SQL)
            .bind_refs(&values)
            .map_err(D1StoreError::from)?
            .run()
            .await
            .map_err(D1StoreError::from)?;
        ensure_success(&result)
    }

    async fn list_nodes_referencing(
        &self,
        target_node_id: NodeId,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Node>, Self::Error> {
        let target_id = target_node_id.to_string();
        let values = [
            D1Type::Text(&target_id),
            D1Type::Integer(to_d1_integer(limit)?),
            D1Type::Integer(to_d1_integer(offset)?),
        ];
        let statement = self
            .database
            .prepare(LIST_REFERRERS_SQL)
            .bind_refs(&values)
            .map_err(D1StoreError::from)?;
        Self::nodes_from_statement(statement).await
    }

    async fn list_nodes_referenced_by(
        &self,
        source_node_id: NodeId,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Node>, Self::Error> {
        let source_id = source_node_id.to_string();
        let values = [
            D1Type::Text(&source_id),
            D1Type::Integer(to_d1_integer(limit)?),
            D1Type::Integer(to_d1_integer(offset)?),
        ];
        let statement = self
            .database
            .prepare(LIST_REFERENCES_SQL)
            .bind_refs(&values)
            .map_err(D1StoreError::from)?;
        Self::nodes_from_statement(statement).await
    }

    async fn remove_reference(&self, reference: Reference) -> Result<(), Self::Error> {
        let source_id = reference.source_node_id().to_string();
        let target_id = reference.target_node_id().to_string();
        let values = [D1Type::Text(&source_id), D1Type::Text(&target_id)];
        let result = self
            .database
            .prepare(REMOVE_REFERENCE_SQL)
            .bind_refs(&values)
            .map_err(D1StoreError::from)?
            .run()
            .await
            .map_err(D1StoreError::from)?;
        ensure_success(&result)
    }
}

#[derive(Debug, Deserialize)]
struct NodeRow {
    id: String,
    name: Option<String>,
    content: Option<String>,
}

impl NodeRow {
    fn into_node(self) -> Result<Node, D1StoreError> {
        let id = NodeId::from_str(&self.id).map_err(|source| D1StoreError::InvalidNodeId {
            value: self.id,
            source,
        })?;
        Ok(Node::restore(id, self.name, self.content))
    }
}

#[derive(Debug, Error)]
pub enum D1StoreError {
    #[error("node name already exists")]
    DuplicateNodeName,
    #[error("referenced node does not exist: {0}")]
    NodeNotFound(NodeId),
    #[error("stored node ID is invalid: {value}")]
    InvalidNodeId {
        value: String,
        #[source]
        source: UuidError,
    },
    #[error("pagination value exceeds the D1 integer range: {0}")]
    InvalidPagination(u32),
    #[error("D1 operation failed: {0}")]
    Operation(String),
    #[error("Cloudflare D1 binding failed: {0}")]
    Worker(#[source] worker::Error),
}

impl From<worker::Error> for D1StoreError {
    fn from(error: worker::Error) -> Self {
        if is_duplicate_name_error(&error) {
            Self::DuplicateNodeName
        } else {
            Self::Worker(error)
        }
    }
}

fn ensure_success(result: &D1Result) -> Result<(), D1StoreError> {
    if result.success() {
        return Ok(());
    }

    let message = result.error().unwrap_or_else(|| "unknown D1 error".into());
    if is_duplicate_name_message(&message) {
        Err(D1StoreError::DuplicateNodeName)
    } else {
        Err(D1StoreError::Operation(message))
    }
}

fn is_duplicate_name_error(error: &worker::Error) -> bool {
    match error {
        worker::Error::D1(error) => is_duplicate_name_message(&error.cause()),
        _ => is_duplicate_name_message(&error.to_string()),
    }
}

fn is_duplicate_name_message(message: &str) -> bool {
    message.contains("UNIQUE constraint failed") && message.contains("nodes.normalized_name")
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn to_d1_integer(value: u32) -> Result<i32, D1StoreError> {
    i32::try_from(value).map_err(|_| D1StoreError::InvalidPagination(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_search_treats_wildcards_as_text() {
        assert_eq!(escape_like(r"50%_off\\today"), r"50\%\_off\\\\today");
    }
}
