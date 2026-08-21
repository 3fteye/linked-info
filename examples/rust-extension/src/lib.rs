use linked_info_extension_sdk::guest::{
    ActionRequest, ActionResult, BadgeElement, BadgeTone, ButtonElement, ChangeOperation,
    ChangeProposal, Guest, MetadataMigrationRequest, Presentation, PresentationElement,
    RenderRequest, StringPatch, TextElement, UpdateCurrentNodeOperation,
};

struct ExampleExtension;

impl Guest for ExampleExtension {
    fn render(request: RenderRequest) -> Result<Presentation, String> {
        if request.processor_id != "summary" {
            return Err("unknown processor".to_owned());
        }
        let content = request.node.content.unwrap_or_default();
        Ok(Presentation {
            elements: vec![
                PresentationElement::Text(TextElement {
                    text: format!("{} characters", content.chars().count()),
                }),
                PresentationElement::Badge(BadgeElement {
                    text: "isolated Rust extension".to_owned(),
                    tone: BadgeTone::Positive,
                }),
                PresentationElement::Button(ButtonElement {
                    action_id: "uppercase".to_owned(),
                }),
            ],
        })
    }

    fn invoke(request: ActionRequest) -> Result<ActionResult, String> {
        if request.action_id != "uppercase" {
            return Err("unknown action".to_owned());
        }
        let node = request
            .nodes
            .first()
            .ok_or_else(|| "current node is required".to_owned())?;
        let uppercased = node.content.as_deref().unwrap_or_default().to_uppercase();
        Ok(ActionResult {
            presentation: Some(Presentation {
                elements: vec![PresentationElement::Text(TextElement {
                    text: "Uppercase change is ready for preview".to_owned(),
                })],
            }),
            node_metadata_json: Some(r#"{"lastAction":"uppercase"}"#.to_owned()),
            workspace_metadata_json: None,
            proposal: Some(ChangeProposal {
                base_revision: request.base_revision,
                title_key: "proposal.uppercase".to_owned(),
                operations: vec![ChangeOperation::UpdateCurrentNode(
                    UpdateCurrentNodeOperation {
                        name: StringPatch::Unchanged,
                        content: StringPatch::Set(uppercased),
                    },
                )],
            }),
        })
    }

    fn migrate_metadata(request: MetadataMigrationRequest) -> Result<String, String> {
        if request.to_version < request.from_version {
            return Err("metadata downgrade is not supported".to_owned());
        }
        Ok(request.metadata_json)
    }
}

linked_info_extension_sdk::export_extension!(ExampleExtension);
