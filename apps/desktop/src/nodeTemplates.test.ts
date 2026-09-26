import { describe, expect, it } from "vitest";
import { emptyWorkspace } from "./workspaceData";
import { parseStoredWorkspaceText, serializeStoredWorkspace } from "./workspaceStore";
import { captureWorkspaceHistory, restoreWorkspaceHistory } from "./workspaceHistory";
import { instantiateNodeTemplate, nodeTemplatesExtensionId, prepareTemplateContent, readNodeTemplates, templateFromNode, writeNodeTemplates } from "./nodeTemplates";

const sourceId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const templateId = "33333333-3333-4333-8333-333333333333";
const newId = "44444444-4444-4444-8444-444444444444";
function fixture() {
  const workspace = emptyWorkspace();
  workspace.nodes = [
    { id: sourceId, name: "Account", content: 'plain\n[[li:secret note="Service｜password"]]synthetic-password[[/li]]\n[[li:totp note="Service｜2FA"]]JBSWY3DPEHPK3PXP[[/li]]' },
    { id: targetId, name: "Service", content: null },
  ];
  workspace.references = [{ sourceNodeId: sourceId, targetNodeId: targetId }];
  return workspace;
}
describe("node templates", () => {
  it("clears marked values while retaining notes and outgoing reference instructions", () => {
    const source = fixture();
    const template = templateFromNode(source, sourceId, templateId);
    expect(template.content).toBe('plain\n[[li:secret note="Service｜password"]][[/li]]\n[[li:totp note="Service｜2FA"]][[/li]]');
    expect(template.targetNodeIds).toEqual([targetId]);
    expect(source.nodes[0].content).toContain("synthetic-password");
  });
  it("clears legacy TOTP including invalid payloads and handles fenced examples conservatively", () => {
    expect(prepareTemplateContent("TOTP: invalid\n```\n[[li:secret]]synthetic[[/li]]\n```"))
      .toBe("[[li:totp]][[/li]]\n```\n[[li:secret]][[/li]]\n```");
  });
  it("does not claim to recognize unmarked secrets", () => {
    expect(prepareTemplateContent("unmarked-synthetic-password")).toBe("unmarked-synthetic-password");
  });
  it.each(['[[li:secret]]unclosed', '[[li:unknown]][[li:secret]]nested[[/li]][[/li]]', '[[li:secret note=broken]]synthetic[[/li]]'])("rejects ambiguous marker syntax: %s", (content) => {
    expect(() => prepareTemplateContent(content)).toThrow("node_template_invalid");
  });
  it("round trips in the workspace envelope and ordinary history", () => {
    const source = fixture();
    const next = writeNodeTemplates(source, [templateFromNode(source, sourceId, templateId)]);
    const loaded = parseStoredWorkspaceText(serializeStoredWorkspace(next));
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") throw new Error("fixture failed");
    expect(readNodeTemplates(loaded.workspace)).toEqual(readNodeTemplates(next));
    expect(readNodeTemplates(restoreWorkspaceHistory(captureWorkspaceHistory(source), next.view))).toEqual([]);
  });
  it("creates node, references and placement without changing the source or templates", () => {
    const source = fixture();
    const base = writeNodeTemplates(source, [templateFromNode(source, sourceId, templateId)]);
    const next = instantiateNodeTemplate(base, templateId, newId, "New account", { x: 700, y: 500 }, false);
    expect(next.nodes.at(-1)?.content).not.toContain("synthetic-password");
    expect(next.references.at(-1)).toEqual({ sourceNodeId: newId, targetNodeId: targetId });
    expect(next.view.canvases[0].layout).toEqual([{ nodeId: newId, x: 700, y: 500 }]);
    expect(next.nodes[0]).toBe(base.nodes[0]);
    expect(readNodeTemplates(next)).toEqual(readNodeTemplates(base));
    expect(base.nodes).toHaveLength(2);
  });
  it("requires explicit consent before skipping a deleted reference target", () => {
    const source = fixture();
    const base = writeNodeTemplates(source, [templateFromNode(source, sourceId, templateId)]);
    base.nodes = base.nodes.filter((node) => node.id !== targetId);
    base.references = [];
    expect(() => instantiateNodeTemplate(base, templateId, newId, "", { x: 0, y: 0 }, false)).toThrow();
    expect(instantiateNodeTemplate(base, templateId, newId, "", { x: 0, y: 0 }, true).references).toEqual([]);
  });
  it("rejects duplicate names, invalid IDs, excessive content and marked payloads", () => {
    const base = fixture();
    const template = templateFromNode(base, sourceId, templateId);
    for (const bad of [{ ...template, id: "bad" }, { ...template, content: "x".repeat(4097) }, { ...template, content: "[[li:secret]]synthetic[[/li]]" }]) {
      expect(() => writeNodeTemplates(base, [bad])).toThrow();
    }
    expect(() => writeNodeTemplates(base, [template, { ...template, id: newId }])).toThrow();
    const saved = writeNodeTemplates(base, [template]);
    expect(() => instantiateNodeTemplate(saved, templateId, newId, " Account ", { x: 0, y: 0 }, false)).toThrow();
  });
  it("does not overwrite a future or damaged template library", () => {
    const base = fixture();
    base.view.extensionMetadata[nodeTemplatesExtensionId] = { schemaVersion: 2, workspace: { templates: [] }, byNodeId: {} };
    expect(() => writeNodeTemplates(base, [])).toThrow();
    expect(base.view.extensionMetadata[nodeTemplatesExtensionId].schemaVersion).toBe(2);
  });
});
