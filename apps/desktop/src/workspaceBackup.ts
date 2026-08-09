import {
  normalizeNodeName,
  type InformationNode,
  type NodeLayout,
  type NodeReference,
  type WorkspaceSnapshot,
} from "./workspaceStore";

const exportFormat = "linked-info-workspace";
const exportVersion = 1;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkspaceImportFailure =
  | "invalidJson"
  | "invalidFormat"
  | "unsupportedVersion"
  | "invalidWorkspace";

export type WorkspaceImportResult =
  | {
      ok: true;
      exportedAt: string;
      workspace: WorkspaceSnapshot;
    }
  | {
      ok: false;
      reason: WorkspaceImportFailure;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseWorkspace(value: unknown): WorkspaceSnapshot | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.layout) ||
    !Array.isArray(value.references)
  ) {
    return null;
  }

  const nodes: InformationNode[] = [];
  const nodeIds = new Set<string>();
  const normalizedNames = new Set<string>();
  for (const candidate of value.nodes) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !uuidPattern.test(candidate.id) ||
      (candidate.name !== null && typeof candidate.name !== "string") ||
      (candidate.content !== null && typeof candidate.content !== "string") ||
      nodeIds.has(candidate.id)
    ) {
      return null;
    }

    const name = candidate.name === null ? null : candidate.name.trim();
    if (name !== null) {
      const normalizedName = normalizeNodeName(name);
      if (normalizedName.length === 0 || normalizedNames.has(normalizedName)) {
        return null;
      }
      normalizedNames.add(normalizedName);
    }

    nodeIds.add(candidate.id);
    nodes.push({ id: candidate.id, name, content: candidate.content });
  }

  if (value.layout.length !== nodes.length) {
    return null;
  }
  const layout: NodeLayout[] = [];
  const layoutNodeIds = new Set<string>();
  for (const candidate of value.layout) {
    if (
      !isRecord(candidate) ||
      typeof candidate.nodeId !== "string" ||
      !nodeIds.has(candidate.nodeId) ||
      layoutNodeIds.has(candidate.nodeId) ||
      !isFiniteNumber(candidate.x) ||
      !isFiniteNumber(candidate.y)
    ) {
      return null;
    }
    layoutNodeIds.add(candidate.nodeId);
    layout.push({ nodeId: candidate.nodeId, x: candidate.x, y: candidate.y });
  }

  const references: NodeReference[] = [];
  const referenceKeys = new Set<string>();
  for (const candidate of value.references) {
    if (
      !isRecord(candidate) ||
      typeof candidate.sourceNodeId !== "string" ||
      typeof candidate.targetNodeId !== "string" ||
      !nodeIds.has(candidate.sourceNodeId) ||
      !nodeIds.has(candidate.targetNodeId)
    ) {
      return null;
    }
    const key = `${candidate.sourceNodeId}\u0000${candidate.targetNodeId}`;
    if (referenceKeys.has(key)) {
      return null;
    }
    referenceKeys.add(key);
    references.push({
      sourceNodeId: candidate.sourceNodeId,
      targetNodeId: candidate.targetNodeId,
    });
  }

  return { nodes, layout, references };
}

export function serializeWorkspaceExport(workspace: WorkspaceSnapshot): string {
  return JSON.stringify(
    {
      format: exportFormat,
      version: exportVersion,
      exportedAt: new Date().toISOString(),
      workspace,
    },
    null,
    2,
  );
}

export function parseWorkspaceExport(text: string): WorkspaceImportResult {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "invalidJson" };
  }

  if (!isRecord(document) || document.format !== exportFormat) {
    return { ok: false, reason: "invalidFormat" };
  }
  if (document.version !== exportVersion) {
    return { ok: false, reason: "unsupportedVersion" };
  }
  if (
    typeof document.exportedAt !== "string" ||
    Number.isNaN(Date.parse(document.exportedAt))
  ) {
    return { ok: false, reason: "invalidFormat" };
  }

  const workspace = parseWorkspace(document.workspace);
  if (workspace === null) {
    return { ok: false, reason: "invalidWorkspace" };
  }
  return { ok: true, exportedAt: document.exportedAt, workspace };
}
