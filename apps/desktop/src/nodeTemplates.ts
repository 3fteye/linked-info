import { contentMarkerRegistry } from "./contentMarker";
import { parseTotpDirectiveLine } from "./totp";
import {
  activeWorkspaceCanvas,
  isNodeNameAvailable,
  normalizeNodeName,
  replaceWorkspaceExtensionMetadata,
  updateWorkspaceCanvas,
  type WorkspaceSnapshot,
} from "./workspaceData";

export const nodeTemplatesExtensionId = "app.linked-info.node-templates";
export interface NodeTemplate {
  id: string;
  name: string;
  content: string;
  targetNodeIds: string[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalid = () => new Error("node_template_invalid");

// 模板不携带已标记的秘密；无法可靠解释的标记拒绝处理，不静默复制。
export function prepareTemplateContent(source: string): string {
  return contentMarkerRegistry.segment(source).map((segment) => {
    if (segment.kind === "text") {
      if (segment.text.includes("[[li:")) throw invalid();
      return segment.text.split(/(\r?\n)/u).map((line) =>
        parseTotpDirectiveLine(line) === null ? line : "[[li:totp]][[/li]]",
      ).join("");
    }
    const { marker } = segment;
    if (marker.malformed || marker.definition === null) throw invalid();
    const note = marker.attributes.note;
    if (note !== undefined && (note.includes("\n") || note.includes("\r") || [...note].length > 160)) {
      throw invalid();
    }
    return `[[li:${marker.id}${note ? ` note=${JSON.stringify(note)}` : ""}]][[/li]]`;
  }).join("");
}

export function readNodeTemplates(workspace: WorkspaceSnapshot): NodeTemplate[] {
  const metadata = workspace.view.extensionMetadata[nodeTemplatesExtensionId];
  if (metadata === undefined) return [];
  if (metadata.schemaVersion !== 1 || Object.keys(metadata.byNodeId).length !== 0 ||
      Object.keys(metadata.workspace).length !== 1 || !Array.isArray(metadata.workspace.templates)) throw invalid();
  const items = metadata.workspace.templates;
  if (items.length > 128) throw invalid();
  const ids = new Set<string>();
  const names = new Set<string>();
  return items.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 4) throw invalid();
    const { id, name, content, targetNodeIds } = item;
    if (typeof id !== "string" || !uuid.test(id) || ids.has(id) ||
        typeof name !== "string" || name !== name.trim() || name.length === 0 || [...name].length > 128 ||
        names.has(normalizeNodeName(name)) || typeof content !== "string" || [...content].length > 4096 ||
        !Array.isArray(targetNodeIds) || targetNodeIds.length > 128 ||
        targetNodeIds.some((target) => typeof target !== "string" || !uuid.test(target)) ||
        new Set(targetNodeIds).size !== targetNodeIds.length || prepareTemplateContent(content) !== content) throw invalid();
    ids.add(id);
    names.add(normalizeNodeName(name));
    return { id, name, content, targetNodeIds: targetNodeIds as string[] };
  });
}

export function writeNodeTemplates(workspace: WorkspaceSnapshot, templates: NodeTemplate[]): WorkspaceSnapshot {
  // 先拒绝未知版本/损坏库，避免保存一条模板时覆盖无法解释的旧定义。
  readNodeTemplates(workspace);
  const view = replaceWorkspaceExtensionMetadata(workspace.view, workspace.nodes, nodeTemplatesExtensionId, {
    schemaVersion: 1,
    workspace: { templates: templates.map((item) => ({ ...item })) },
    byNodeId: {},
  });
  if (view === null) throw invalid();
  const next = { ...workspace, view };
  readNodeTemplates(next);
  return next;
}

export function templateFromNode(workspace: WorkspaceSnapshot, nodeId: string, templateId: string): NodeTemplate {
  const node = workspace.nodes.find((item) => item.id === nodeId);
  if (node === undefined) throw invalid();
  return {
    id: templateId,
    name: node.name ?? "",
    content: prepareTemplateContent(node.content ?? ""),
    targetNodeIds: workspace.references.filter((ref) => ref.sourceNodeId === nodeId).map((ref) => ref.targetNodeId),
  };
}

export function instantiateNodeTemplate(
  workspace: WorkspaceSnapshot, templateId: string, nodeId: string, name: string,
  position: { x: number; y: number }, skipMissing: boolean,
): WorkspaceSnapshot {
  const template = readNodeTemplates(workspace).find((item) => item.id === templateId);
  if (template === undefined || !uuid.test(nodeId) || workspace.nodes.some((item) => item.id === nodeId) ||
      !Number.isFinite(position.x) || !Number.isFinite(position.y) || !isNodeNameAvailable(workspace.nodes, nodeId, name)) throw invalid();
  const existing = new Set(workspace.nodes.map((item) => item.id));
  if (!skipMissing && template.targetNodeIds.some((id) => !existing.has(id))) throw invalid();
  const canvas = activeWorkspaceCanvas(workspace);
  return {
    ...workspace,
    nodes: [...workspace.nodes, { id: nodeId, name: name.trim() || null, content: template.content }],
    references: [...workspace.references, ...template.targetNodeIds.filter((id) => existing.has(id)).map((id) => ({ sourceNodeId: nodeId, targetNodeId: id }))],
    view: updateWorkspaceCanvas(workspace.view, canvas.id, (item) => ({ ...item, layout: [...item.layout, { nodeId, ...position }] })),
  };
}
