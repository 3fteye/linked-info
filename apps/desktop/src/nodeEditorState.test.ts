import { describe, expect, it } from "vitest";
import {
  nodeEditorDraft,
  shouldCommitNodeEditor,
  updateNodeEditorContent,
  updateNodeEditorName,
} from "./nodeEditorState";

describe("node editor state", () => {
  it("keeps multiline edits exactly, including Enter and Shift+Enter newlines", () => {
    const longText = "a".repeat(2_000);
    const draft = nodeEditorDraft("Node", longText);
    const withNewlines = updateNodeEditorContent(
      draft,
      `${longText.slice(0, 1)}\n\n${longText.slice(1)}`,
    );

    expect(withNewlines.content.slice(0, 5)).toBe("a\n\naa");
    expect(withNewlines.content.length).toBe(longText.length + 2);
  });

  it("keeps Backspace results without rebuilding content from persisted props", () => {
    const draft = nodeEditorDraft("Node", "first\n\nsecond");
    const afterBackspace = updateNodeEditorContent(draft, "first\nsecond");

    expect(afterBackspace.content).toBe("first\nsecond");
  });

  it("does not commit while focus moves inside the node or the name conflicts", () => {
    const draft = nodeEditorDraft("Node", "content");
    expect(shouldCommitNodeEditor(draft, true)).toBe(false);

    const conflicting = updateNodeEditorName(draft, "Duplicate", false);
    expect(shouldCommitNodeEditor(conflicting, false)).toBe(false);
    expect(shouldCommitNodeEditor(draft, false)).toBe(true);
  });
});
