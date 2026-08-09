use std::{error::Error, future::Future};

use linked_info_domain::{Node, NodeId, Reference};

pub trait GraphStore {
    type Error: Error;

    fn list_nodes(
        &self,
        offset: u32,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<Node>, Self::Error>> + '_;

    fn search_nodes_by_name(
        &self,
        query: String,
        offset: u32,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<Node>, Self::Error>> + '_;

    fn find_node(&self, id: NodeId)
    -> impl Future<Output = Result<Option<Node>, Self::Error>> + '_;

    /// Saves a node and atomically enforces uniqueness for non-empty names.
    fn save_node(&self, node: Node) -> impl Future<Output = Result<(), Self::Error>> + '_;

    /// Deletes a node and atomically removes every reference connected to it.
    fn delete_node(&self, id: NodeId) -> impl Future<Output = Result<(), Self::Error>> + '_;

    /// Adds a reference only when both endpoint nodes exist.
    fn add_reference(
        &self,
        reference: Reference,
    ) -> impl Future<Output = Result<(), Self::Error>> + '_;

    fn list_nodes_referencing(
        &self,
        target_node_id: NodeId,
        offset: u32,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<Node>, Self::Error>> + '_;

    fn list_nodes_referenced_by(
        &self,
        source_node_id: NodeId,
        offset: u32,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<Node>, Self::Error>> + '_;

    fn remove_reference(
        &self,
        reference: Reference,
    ) -> impl Future<Output = Result<(), Self::Error>> + '_;
}
