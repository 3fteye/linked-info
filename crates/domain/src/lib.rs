use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

macro_rules! entity_id {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }
    };
}

entity_id!(InformationTypeId);
entity_id!(InformationId);
entity_id!(RelationTypeId);
entity_id!(RelationId);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    ShortText,
    LongText,
    Number,
    Boolean,
    Date,
    Url,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum FieldValue {
    Text(String),
    Number(f64),
    Boolean(bool),
    Date(String),
    Url(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldDefinition {
    pub key: String,
    pub name: String,
    pub kind: FieldKind,
    pub required: bool,
    pub position: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InformationType {
    pub id: InformationTypeId,
    pub name: String,
    pub description: String,
    pub fields: Vec<FieldDefinition>,
    pub active: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InformationContext {
    pub source: String,
    pub reason: String,
    pub scene: String,
    pub outcome: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Information {
    pub id: InformationId,
    pub information_type_id: Option<InformationTypeId>,
    pub title: String,
    pub body: String,
    pub fields: BTreeMap<String, FieldValue>,
    pub context: InformationContext,
    pub archived: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Information {
    pub fn new(
        title: impl Into<String>,
        body: impl Into<String>,
        information_type_id: Option<InformationTypeId>,
        context: InformationContext,
    ) -> Result<Self, DomainError> {
        let title = title.into().trim().to_owned();
        if title.is_empty() {
            return Err(DomainError::EmptyTitle);
        }

        let now = Utc::now();
        Ok(Self {
            id: InformationId::new(),
            information_type_id,
            title,
            body: body.into(),
            fields: BTreeMap::new(),
            context,
            archived: false,
            created_at: now,
            updated_at: now,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationType {
    pub id: RelationTypeId,
    pub forward_name: String,
    pub reverse_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InformationRelation {
    pub id: RelationId,
    pub relation_type_id: RelationTypeId,
    pub from_id: InformationId,
    pub to_id: InformationId,
    pub note: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainError {
    #[error("information title cannot be empty")]
    EmptyTitle,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn information_requires_a_title() {
        let result = Information::new("   ", "body", None, InformationContext::default());

        assert_eq!(result.unwrap_err(), DomainError::EmptyTitle);
    }

    #[test]
    fn information_keeps_the_manual_context() {
        let context = InformationContext {
            source: "project documentation".into(),
            reason: "needed for deployment".into(),
            scene: "setting up a new machine".into(),
            outcome: "not used yet".into(),
        };

        let information = Information::new("Deploy script", "cargo run", None, context.clone())
            .expect("valid information");

        assert_eq!(information.context, context);
    }
}
