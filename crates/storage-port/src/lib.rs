use std::{error::Error, future::Future};

use linked_info_domain::{Node, NodeId, Reference};

pub trait GraphStore {
    type Error: Error;

    fn list_nodes(&self) -> impl Future<Output = Result<Vec<Node>, Self::Error>> + '_;

    fn find_node(&self, id: NodeId)
    -> impl Future<Output = Result<Option<Node>, Self::Error>> + '_;

    /// Saves a node and enforces name uniqueness atomically.
    fn save_node(&self, node: Node) -> impl Future<Output = Result<(), Self::Error>> + '_;

    /// Adds a reference only when both endpoint nodes exist.
    fn add_reference(
        &self,
        reference: Reference,
    ) -> impl Future<Output = Result<(), Self::Error>> + '_;

    fn list_nodes_referencing(
        &self,
        target_node_id: NodeId,
    ) -> impl Future<Output = Result<Vec<Node>, Self::Error>> + '_;
}
