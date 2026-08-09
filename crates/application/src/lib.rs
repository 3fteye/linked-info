use linked_info_domain::{Node, NodeId, Reference, normalize_node_name};
use linked_info_storage_port::GraphStore;

pub struct GraphService<S> {
    store: S,
}

impl<S> GraphService<S>
where
    S: GraphStore,
{
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub async fn list_nodes(&self) -> Result<Vec<Node>, S::Error> {
        self.store.list_nodes().await
    }

    pub async fn save_node(&self, node: Node) -> Result<(), S::Error> {
        self.store.save_node(node).await
    }

    pub async fn search_nodes_by_name(&self, query: &str) -> Result<Vec<Node>, S::Error> {
        let query = normalize_node_name(query);
        let mut nodes = self.store.list_nodes().await?;
        nodes.retain(|node| node.normalized_name().contains(&query));
        Ok(nodes)
    }

    pub async fn add_reference(&self, reference: Reference) -> Result<(), S::Error> {
        self.store.add_reference(reference).await
    }

    pub async fn nodes_referencing(&self, target_node_id: NodeId) -> Result<Vec<Node>, S::Error> {
        self.store.list_nodes_referencing(target_node_id).await
    }
}

#[cfg(test)]
mod tests {
    use linked_info_domain::{Node, Reference};
    use linked_info_storage_memory::MemoryGraphStore;

    use super::*;

    #[tokio::test]
    async fn search_defaults_to_node_names() {
        let service = GraphService::new(MemoryGraphStore::default());
        service
            .save_node(Node::new("OpenAI", None).expect("valid node"))
            .await
            .expect("save succeeds");
        service
            .save_node(
                Node::new("Deployment script", Some("uses OpenAI".into())).expect("valid node"),
            )
            .await
            .expect("save succeeds");

        let result = service
            .search_nodes_by_name("open")
            .await
            .expect("search succeeds");

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name(), "OpenAI");
    }

    #[tokio::test]
    async fn filtering_by_a_node_returns_its_direct_referrers() {
        let service = GraphService::new(MemoryGraphStore::default());
        let tag = Node::new("OpenAI", None).expect("valid node");
        let script = Node::new("Deployment script", None).expect("valid node");
        let unrelated = Node::new("Unrelated", None).expect("valid node");

        for node in [&tag, &script, &unrelated] {
            service
                .save_node(node.clone())
                .await
                .expect("save succeeds");
        }
        service
            .add_reference(Reference::new(script.id(), tag.id()))
            .await
            .expect("reference succeeds");

        let result = service
            .nodes_referencing(tag.id())
            .await
            .expect("filter succeeds");

        assert_eq!(result, vec![script]);
    }

    #[tokio::test]
    async fn renaming_a_target_keeps_existing_references() {
        let service = GraphService::new(MemoryGraphStore::default());
        let mut tag = Node::new("OpenAI", None).expect("valid node");
        let note = Node::new("API note", None).expect("valid node");
        service.save_node(tag.clone()).await.expect("save succeeds");
        service
            .save_node(note.clone())
            .await
            .expect("save succeeds");
        service
            .add_reference(Reference::new(note.id(), tag.id()))
            .await
            .expect("reference succeeds");

        tag.rename("OpenAI API").expect("valid name");
        service
            .save_node(tag.clone())
            .await
            .expect("rename succeeds");

        assert_eq!(
            service
                .nodes_referencing(tag.id())
                .await
                .expect("filter succeeds"),
            vec![note]
        );
    }
}
