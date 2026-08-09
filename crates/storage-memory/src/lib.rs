use std::{
    collections::{HashMap, HashSet},
    sync::RwLock,
};

use linked_info_domain::{Node, NodeId, Reference};
use linked_info_storage_port::GraphStore;
use thiserror::Error;

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
        nodes.sort_by_key(Node::normalized_name);
        Ok(paginate(nodes, offset, limit))
    }

    async fn search_nodes_by_name(
        &self,
        query: &str,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Node>, Self::Error> {
        let query = linked_info_domain::normalize_node_name(query);
        let state = self.state.read().expect("memory store lock poisoned");
        let mut nodes: Vec<_> = state.nodes.values().cloned().collect();
        nodes.retain(|node| node.normalized_name().contains(&query));
        nodes.sort_by_key(Node::normalized_name);
        Ok(paginate(nodes, offset, limit))
    }

    async fn find_node(&self, id: NodeId) -> Result<Option<Node>, Self::Error> {
        let state = self.state.read().expect("memory store lock poisoned");
        Ok(state.nodes.get(&id).cloned())
    }

    async fn save_node(&self, node: Node) -> Result<(), Self::Error> {
        let mut state = self.state.write().expect("memory store lock poisoned");
        let normalized_name = node.normalized_name();

        if let Some(existing_id) = state.node_names.get(&normalized_name)
            && *existing_id != node.id()
        {
            return Err(MemoryStoreError::DuplicateNodeName);
        }

        if let Some(existing_name) = state.nodes.get(&node.id()).map(Node::normalized_name) {
            state.node_names.remove(&existing_name);
        }

        state.node_names.insert(normalized_name, node.id());
        state.nodes.insert(node.id(), node);
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
        nodes.sort_by_key(Node::normalized_name);
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
        nodes.sort_by_key(Node::normalized_name);
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
            .save_node(Node::new("OpenAI", None).expect("valid node"))
            .await
            .expect("first save succeeds");

        let result = store
            .save_node(Node::new(" openai ", None).expect("valid node"))
            .await;

        assert_eq!(result, Err(MemoryStoreError::DuplicateNodeName));
    }

    #[tokio::test]
    async fn rename_updates_the_name_index_without_changing_the_id() {
        let store = MemoryGraphStore::default();
        let mut node = Node::new("Old name", None).expect("valid node");
        let id = node.id();
        store.save_node(node.clone()).await.expect("initial save");

        node.rename("New name").expect("valid new name");
        store.save_node(node).await.expect("renamed save");
        store
            .save_node(Node::new("Old name", None).expect("valid node"))
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
        let source = Node::new("Source", None).expect("valid node");
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
}
