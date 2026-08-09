use std::{
    fmt::{Display, Formatter},
    str::FromStr,
};

use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(Uuid);

impl NodeId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub const fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    pub const fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl Default for NodeId {
    fn default() -> Self {
        Self::new()
    }
}

impl Display for NodeId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for NodeId {
    type Err = uuid::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value).map(Self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Node {
    id: NodeId,
    name: Option<NodeName>,
    content: Option<String>,
}

impl Node {
    pub fn new(name: Option<String>, content: Option<String>) -> Self {
        Self {
            id: NodeId::new(),
            name: NodeName::new(name),
            content,
        }
    }

    pub fn restore(id: NodeId, name: Option<String>, content: Option<String>) -> Self {
        Self {
            id,
            name: NodeName::new(name),
            content,
        }
    }

    pub fn id(&self) -> NodeId {
        self.id
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_ref().map(NodeName::as_str)
    }

    pub fn content(&self) -> Option<&str> {
        self.content.as_deref()
    }

    pub fn set_name(&mut self, name: Option<String>) {
        self.name = NodeName::new(name);
    }

    pub fn set_content(&mut self, content: Option<String>) {
        self.content = content;
    }

    pub fn normalized_name(&self) -> Option<String> {
        self.name().map(normalize_node_name)
    }
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct StoredNode {
            id: NodeId,
            name: Option<String>,
            content: Option<String>,
        }

        let stored = StoredNode::deserialize(deserializer)?;
        Ok(Self::restore(stored.id, stored.name, stored.content))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
struct NodeName(String);

impl NodeName {
    fn new(name: Option<String>) -> Option<Self> {
        let name = name?.trim().to_owned();
        (!name.is_empty()).then_some(Self(name))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Reference {
    source_node_id: NodeId,
    target_node_id: NodeId,
}

impl Reference {
    pub fn new(source_node_id: NodeId, target_node_id: NodeId) -> Self {
        Self {
            source_node_id,
            target_node_id,
        }
    }

    pub fn source_node_id(&self) -> NodeId {
        self.source_node_id
    }

    pub fn target_node_id(&self) -> NodeId {
        self.target_node_id
    }
}

pub fn normalize_node_name(name: &str) -> String {
    name.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_names_are_stored_as_unnamed() {
        let node = Node::new(Some("   ".into()), None);

        assert_eq!(node.name(), None);
        assert_eq!(node.normalized_name(), None);
    }

    #[test]
    fn node_content_can_be_empty() {
        let node = Node::new(Some("OpenAI".into()), None);

        assert_eq!(node.content(), None);
    }

    #[test]
    fn renaming_keeps_the_stable_id() {
        let mut node = Node::new(Some("OpenAI".into()), None);
        let id = node.id();

        node.set_name(Some("OpenAI API".into()));

        assert_eq!(node.id(), id);
        assert_eq!(node.name(), Some("OpenAI API"));
    }

    #[test]
    fn normalized_names_ignore_surrounding_whitespace_and_case() {
        assert_eq!(
            normalize_node_name("  OpenAI  "),
            normalize_node_name("openai")
        );
    }

    #[test]
    fn restored_nodes_keep_their_persisted_id() {
        let id = NodeId::new();
        let restored = Node::restore(id, Some("OpenAI".into()), None);

        assert_eq!(restored.id(), id);
        assert_eq!(NodeId::from_str(&id.to_string()).expect("valid ID"), id);
    }
}
