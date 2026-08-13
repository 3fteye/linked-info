use std::{
    collections::{HashMap, HashSet},
    sync::RwLock,
};

use linked_info_domain::{Node, NodeId, Reference};
use linked_info_storage_port::GraphStore;
use thiserror::Error;

fn sort_nodes(nodes: &mut [Node]) {
    nodes.sort_by_cached_key(|node| (node.normalized_name(), node.id()));
}

#[derive(Debug, Default)]
struct MemoryGraphState {
    nodes: HashMap<NodeId, Node>,
    node_names: HashMap<String, NodeId>,
    references: HashSet<Reference>,
}

#[derive(Debug, Default)]
pub struct MemoryGraphStore {
    state: RwLock<MemoryGraphState>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MemoryStoreError {
    #[error("node name already exists")]
    DuplicateNodeName,
    #[error("referenced node does not exist: {0:?}")]
    NodeNotFound(NodeId),
}

impl GraphStore for MemoryGraphStore {
    type Error = MemoryStoreError;

    async fn list_nodes(&self, offset: u32, limit: u32) -> Result<Vec<Node>, Self::Error> {
        let state = self.state.read().expect("memory store lock poisoned");
        let mut nodes: Vec<_> = state.nodes.values().cloned().collect();
        sort_nodes(&mut nodes);
        Ok(paginate(nodes, offset, limit))
    }

    async fn search_nodes_by_name(
        &self,
        query: String,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Node>, Self::Error> {
        let query = linked_info_domain::normalize_node_name(&query);
        let state = self.state.read().expect("memory store lock poisoned");
        let mut nodes: Vec<_> = state.nodes.values().cloned().collect();
        nodes.retain(|node| node.normalized_name().unwrap_or_default().contains(&query));
        sort_nodes(&mut nodes);
        Ok(paginate(nodes, offset, limit))
    }

    async fn find_node(&self, id: NodeId) -> Result<Option<Node>, Self::Error> {
        let state = self.state.read().expect("memory store lock poisoned");
        Ok(state.nodes.get(&id).cloned())
    }

    async fn save_node(&self, node: Node) -> Result<(), Self::Error> {
        let mut state = self.state.write().expect("memory store lock poisoned");
        let normalized_name = node.normalized_name();

        if let Some(normalized_name) = normalized_name.as_ref()
            && let Some(existing_id) = state.node_names.get(normalized_name)
            && *existing_id != node.id()
        {
            return Err(MemoryStoreError::DuplicateNodeName);
        }

        if let Some(existing_name) = state.nodes.get(&node.id()).and_then(Node::normalized_name) {
            state.node_names.remove(&existing_name);
        }

        if let Some(normalized_name) = normalized_name {
            state.node_names.insert(normalized_name, node.id());
        }
        state.nodes.insert(node.id(), node);
        Ok(())
    }

    async fn delete_node(&self, id: NodeId) -> Result<(), Self::Error> {
        let mut state = self.state.write().expect("memory store lock poisoned");
        let deleted = state
            .nodes
            .remove(&id)
            .ok_or(MemoryStoreError::NodeNotFound(id))?;
        if let Some(normalized_name) = deleted.normalized_name() {
            state.node_names.remove(&normalized_name);
        }
        state.references.retain(|reference| {
            reference.source_node_id() != id && reference.target_node_id() != id
        });
        Ok(())
    }

    async fn add_reference(&self, reference: Reference) -> Result<(), Self::Error> {
        let mut state = self.state.write().expect("memory store lock poisoned");

        for node_id in [reference.source_node_id(), reference.target_node_id()] {
            if !state.nodes.contains_key(&node_id) {
                return Err(MemoryStoreError::NodeNotFound(node_id));
            }
        }

        state.references.insert(reference);
        Ok(())
    }

    async fn list_nodes_referencing(
        &self,
        target_node_id: NodeId,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Node>, Self::Error> {
        let state = self.state.read().expect("memory store lock poisoned");
        let mut nodes: Vec<_> = state
            .references
            .iter()
            .filter(|reference| reference.target_node_id() == target_node_id)
            .map(|reference| {
                state
                    .nodes
                    .get(&reference.source_node_id())
                    .cloned()
                    .ok_or(MemoryStoreError::NodeNotFound(reference.source_node_id()))
            })
            .collect::<Result<_, _>>()?;
        sort_nodes(&mut nodes);
        Ok(paginate(nodes, offset, limit))
    }

    async fn list_nodes_referenced_by(
        &self,
        source_node_id: NodeId,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Node>, Self::Error> {
        let state = self.state.read().expect("memory store lock poisoned");
        let mut nodes: Vec<_> = state
            .references
            .iter()
            .filter(|reference| reference.source_node_id() == source_node_id)
            .map(|reference| {
                state
                    .nodes
                    .get(&reference.target_node_id())
                    .cloned()
                    .ok_or(MemoryStoreError::NodeNotFound(reference.target_node_id()))
            })
            .collect::<Result<_, _>>()?;
        sort_nodes(&mut nodes);
        Ok(paginate(nodes, offset, limit))
    }

    async fn remove_reference(&self, reference: Reference) -> Result<(), Self::Error> {
        let mut state = self.state.write().expect("memory store lock poisoned");
        state.references.remove(&reference);
        Ok(())
    }
}

fn paginate(nodes: Vec<Node>, offset: u32, limit: u32) -> Vec<Node> {
    nodes
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_duplicate_names_after_normalization() {
        let store = MemoryGraphStore::default();
        store
            .save_node(Node::new(Some("OpenAI".into()), None))
            .await
            .expect("first save succeeds");

        let result = store
            .save_node(Node::new(Some(" openai ".into()), None))
            .await;

        assert_eq!(result, Err(MemoryStoreError::DuplicateNodeName));
    }

    #[tokio::test]
    async fn rename_updates_the_name_index_without_changing_the_id() {
        let store = MemoryGraphStore::default();
        let mut node = Node::new(Some("Old name".into()), None);
        let id = node.id();
        store.save_node(node.clone()).await.expect("initial save");

        node.set_name(Some("New name".into()));
        store.save_node(node).await.expect("renamed save");
        store
            .save_node(Node::new(Some("Old name".into()), None))
            .await
            .expect("old name is available again");

        assert_eq!(
            store
                .find_node(id)
                .await
                .expect("find succeeds")
                .unwrap()
                .id(),
            id
        );
    }

    #[tokio::test]
    async fn reference_requires_existing_endpoints() {
        let store = MemoryGraphStore::default();
        let source = Node::new(Some("Source".into()), None);
        let missing_target = NodeId::new();
        store
            .save_node(source.clone())
            .await
            .expect("save succeeds");

        let result = store
            .add_reference(Reference::new(source.id(), missing_target))
            .await;

        assert_eq!(result, Err(MemoryStoreError::NodeNotFound(missing_target)));
    }

    #[tokio::test]
    async fn multiple_unnamed_nodes_are_allowed() {
        let store = MemoryGraphStore::default();

        store
            .save_node(Node::new(None, None))
            .await
            .expect("first unnamed node saves");
        store
            .save_node(Node::new(Some("   ".into()), None))
            .await
            .expect("second unnamed node saves");

        assert_eq!(store.list_nodes(0, 100).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn deleting_a_missing_node_returns_not_found() {
        let store = MemoryGraphStore::default();
        let missing_id = NodeId::new();

        assert_eq!(
            store.delete_node(missing_id).await,
            Err(MemoryStoreError::NodeNotFound(missing_id))
        );
    }

    #[tokio::test]
    async fn unnamed_node_pagination_has_a_stable_id_tiebreaker() {
        let store = MemoryGraphStore::default();
        let first = Node::restore(
            "11111111-1111-4111-8111-111111111111".parse().unwrap(),
            None,
            None,
        );
        let second = Node::restore(
            "22222222-2222-4222-8222-222222222222".parse().unwrap(),
            None,
            None,
        );
        store.save_node(second.clone()).await.unwrap();
        store.save_node(first.clone()).await.unwrap();

        assert_eq!(store.list_nodes(0, 1).await.unwrap(), vec![first]);
        assert_eq!(store.list_nodes(1, 1).await.unwrap(), vec![second]);
    }
}
