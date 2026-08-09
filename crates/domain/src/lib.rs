use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(Uuid);

impl NodeId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for NodeId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Node {
    id: NodeId,
    name: NodeName,
    content: Option<String>,
}

impl Node {
    pub fn new(name: impl Into<String>, content: Option<String>) -> Result<Self, DomainError> {
        let name = NodeName::new(name)?;

        Ok(Self {
            id: NodeId::new(),
            name,
            content,
        })
    }

    pub fn id(&self) -> NodeId {
        self.id
    }

    pub fn name(&self) -> &str {
        self.name.as_str()
    }

    pub fn content(&self) -> Option<&str> {
        self.content.as_deref()
    }

    pub fn rename(&mut self, name: impl Into<String>) -> Result<(), DomainError> {
        self.name = NodeName::new(name)?;
        Ok(())
    }

    pub fn set_content(&mut self, content: Option<String>) {
        self.content = content;
    }

    pub fn normalized_name(&self) -> String {
        normalize_node_name(self.name.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
struct NodeName(String);

impl NodeName {
    fn new(name: impl Into<String>) -> Result<Self, DomainError> {
        let name = name.into();
        let name = name.trim().to_owned();
        if name.is_empty() {
            return Err(DomainError::EmptyNodeName);
        }

        Ok(Self(name))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for NodeName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let name = String::deserialize(deserializer)?;
        Self::new(name).map_err(D::Error::custom)
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

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainError {
    #[error("node name cannot be empty")]
    EmptyNodeName,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_requires_a_name() {
        let result = Node::new("   ", None);

        assert_eq!(result.unwrap_err(), DomainError::EmptyNodeName);
    }

    #[test]
    fn node_content_can_be_empty() {
        let node = Node::new("OpenAI", None).expect("valid node");

        assert_eq!(node.content(), None);
    }

    #[test]
    fn renaming_keeps_the_stable_id() {
        let mut node = Node::new("OpenAI", None).expect("valid node");
        let id = node.id();

        node.rename("OpenAI API").expect("valid new name");

        assert_eq!(node.id(), id);
        assert_eq!(node.name(), "OpenAI API");
    }

    #[test]
    fn normalized_names_ignore_surrounding_whitespace_and_case() {
        assert_eq!(
            normalize_node_name("  OpenAI  "),
            normalize_node_name("openai")
        );
    }
}
