export interface NodeEditorDraft {
  content: string;
  name: string;
  nameConflict: boolean;
}

export function nodeEditorDraft(
  name: string | null,
  content: string | null,
): NodeEditorDraft {
  return { name: name ?? "", content: content ?? "", nameConflict: false };
}

export function updateNodeEditorName(
  draft: NodeEditorDraft,
  name: string,
  available: boolean,
): NodeEditorDraft {
  return { ...draft, name, nameConflict: !available };
}

export function updateNodeEditorContent(
  draft: NodeEditorDraft,
  content: string,
): NodeEditorDraft {
  return { ...draft, content };
}

export function shouldCommitNodeEditor(
  draft: NodeEditorDraft,
  focusRemainsInsideNode: boolean,
): boolean {
  return !focusRemainsInsideNode && !draft.nameConflict;
}
