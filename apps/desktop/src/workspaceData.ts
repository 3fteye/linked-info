export interface InformationNode {
  id: string;
  name: string | null;
  content: string | null;
}

export interface NodeLayout {
  nodeId: string;
  x: number;
  y: number;
}

export interface NodeReference {
  sourceNodeId: string;
  targetNodeId: string;
}

export interface WorkspaceSnapshot {
  nodes: InformationNode[];
  layout: NodeLayout[];
  references: NodeReference[];
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function canonicalNodeId(value: unknown): string | null {
  return typeof value === "string" && uuidPattern.test(value)
    ? value.toLowerCase()
    : null;
}

export function emptyWorkspace(): WorkspaceSnapshot {
  return { nodes: [], layout: [], references: [] };
}

export function normalizeNodeName(name: string): string {
  return name.trim().toLowerCase();
}

export function isUnnamedNode(node: InformationNode): boolean {
  return node.name === null || node.name.trim().length === 0;
}

export function isNodeNameAvailable(
  nodes: InformationNode[],
  nodeId: string,
  candidateName: string,
): boolean {
  const normalizedCandidate = normalizeNodeName(candidateName);
  return (
    normalizedCandidate.length === 0 ||
    !nodes.some(
      (node) =>
        node.id !== nodeId &&
        normalizeNodeName(node.name ?? "") === normalizedCandidate,
    )
  );
}

export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | null {
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
      (candidate.name !== null && typeof candidate.name !== "string") ||
      (candidate.content !== null && typeof candidate.content !== "string")
    ) {
      return null;
    }

    const id = canonicalNodeId(candidate.id);
    if (id === null || nodeIds.has(id)) {
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

    nodeIds.add(id);
    nodes.push({ id, name, content: candidate.content });
  }

  if (value.layout.length !== nodes.length) {
    return null;
  }
  const layout: NodeLayout[] = [];
  const layoutNodeIds = new Set<string>();
  for (const candidate of value.layout) {
    if (!isRecord(candidate)) {
      return null;
    }
    const nodeId = canonicalNodeId(candidate.nodeId);
    if (
      nodeId === null ||
      !nodeIds.has(nodeId) ||
      layoutNodeIds.has(nodeId) ||
      !isFiniteNumber(candidate.x) ||
      !isFiniteNumber(candidate.y)
    ) {
      return null;
    }
    layoutNodeIds.add(nodeId);
    layout.push({ nodeId, x: candidate.x, y: candidate.y });
  }

  const references: NodeReference[] = [];
  const referenceKeys = new Set<string>();
  for (const candidate of value.references) {
    if (!isRecord(candidate)) {
      return null;
    }
    const sourceNodeId = canonicalNodeId(candidate.sourceNodeId);
    const targetNodeId = canonicalNodeId(candidate.targetNodeId);
    if (
      sourceNodeId === null ||
      targetNodeId === null ||
      !nodeIds.has(sourceNodeId) ||
      !nodeIds.has(targetNodeId)
    ) {
      return null;
    }
    const key = `${sourceNodeId}\u0000${targetNodeId}`;
    if (referenceKeys.has(key)) {
      return null;
    }
    referenceKeys.add(key);
    references.push({ sourceNodeId, targetNodeId });
  }

  return { nodes, layout, references };
}
