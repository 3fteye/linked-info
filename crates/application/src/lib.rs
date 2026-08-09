use linked_info_domain::{Node, NodeId, Reference};
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

    pub async fn list_nodes(&self, offset: u32, limit: u32) -> Result<Vec<Node>, S::Error> {
        self.store.list_nodes(offset, limit).await
    }

    pub async fn find_node(&self, id: NodeId) -> Result<Option<Node>, S::Error> {
        self.store.find_node(id).await
    }

    pub async fn save_node(&self, node: Node) -> Result<(), S::Error> {
        self.store.save_node(node).await
    }

    pub async fn search_nodes_by_name(
        &self,
        query: &str,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Node>, S::Error> {
        self.store
            .search_nodes_by_name(query.to_owned(), offset, limit)
            .await
    }

    pub async fn add_reference(&self, reference: Reference) -> Result<(), S::Error> {
        self.store.add_reference(reference).await
    }

    pub async fn nodes_referencing(
        &self,
        target_node_id: NodeId,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Node>, S::Error> {
        self.store
            .list_nodes_referencing(target_node_id, offset, limit)
            .await
    }

    pub async fn nodes_referenced_by(
        &self,
        source_node_id: NodeId,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Node>, S::Error> {
        self.store
            .list_nodes_referenced_by(source_node_id, offset, limit)
            .await
    }

    pub async fn remove_reference(&self, reference: Reference) -> Result<(), S::Error> {
        self.store.remove_reference(reference).await
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
            .save_node(Node::new(Some("OpenAI".into()), None))
            .await
            .expect("save succeeds");
        service
            .save_node(Node::new(
                Some("Deployment script".into()),
                Some("uses OpenAI".into()),
            ))
            .await
            .expect("save succeeds");

        let result = service
            .search_nodes_by_name("open", 0, 100)
            .await
            .expect("search succeeds");

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name(), Some("OpenAI"));
    }

    #[tokio::test]
    async fn node_listing_uses_stable_name_order_and_pagination() {
        let service = GraphService::new(MemoryGraphStore::default());
        for name in ["Charlie", "Alpha", "Bravo"] {
            service
                .save_node(Node::new(Some(name.into()), None))
                .await
                .expect("save succeeds");
        }

        let result = service.list_nodes(1, 1).await.expect("list succeeds");

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name(), Some("Bravo"));
    }

    #[tokio::test]
    async fn filtering_by_a_node_returns_its_direct_referrers() {
        let service = GraphService::new(MemoryGraphStore::default());
        let tag = Node::new(Some("OpenAI".into()), None);
        let script = Node::new(Some("Deployment script".into()), None);
        let unrelated = Node::new(Some("Unrelated".into()), None);

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
            .nodes_referencing(tag.id(), 0, 100)
            .await
            .expect("filter succeeds");

        assert_eq!(result, vec![script]);
    }

    #[tokio::test]
    async fn references_can_be_listed_from_the_source_and_removed() {
        let service = GraphService::new(MemoryGraphStore::default());
        let source = Node::new(Some("Script".into()), None);
        let target = Node::new(Some("OpenAI".into()), None);
        service
            .save_node(source.clone())
            .await
            .expect("save succeeds");
        service
            .save_node(target.clone())
            .await
            .expect("save succeeds");
        let reference = Reference::new(source.id(), target.id());
        service
            .add_reference(reference)
            .await
            .expect("reference succeeds");

        assert_eq!(
            service
                .nodes_referenced_by(source.id(), 0, 100)
                .await
                .expect("query succeeds"),
            vec![target]
        );

        service
            .remove_reference(reference)
            .await
            .expect("removal succeeds");
        assert!(
            service
                .nodes_referenced_by(source.id(), 0, 100)
                .await
                .expect("query succeeds")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn renaming_a_target_keeps_existing_references() {
        let service = GraphService::new(MemoryGraphStore::default());
        let mut tag = Node::new(Some("OpenAI".into()), None);
        let note = Node::new(Some("API note".into()), None);
        service.save_node(tag.clone()).await.expect("save succeeds");
        service
            .save_node(note.clone())
            .await
            .expect("save succeeds");
        service
            .add_reference(Reference::new(note.id(), tag.id()))
            .await
            .expect("reference succeeds");

        tag.set_name(Some("OpenAI API".into()));
        service
            .save_node(tag.clone())
            .await
            .expect("rename succeeds");

        assert_eq!(
            service
                .nodes_referencing(tag.id(), 0, 100)
                .await
                .expect("filter succeeds"),
            vec![note]
        );
    }
}
