export interface InformationNode {
  id: string;
  name: string | null;
  content: string | null;
}

export interface NodeLayout {
  height?: number;
  nodeId: string;
  width?: number;
  x: number;
  y: number;
}

export const minimumManualNodeWidth = 220;
export const minimumManualNodeHeight = 92;
export const maximumManualNodeDimension = 5_000;

export interface NodeReference {
  sourceNodeId: string;
  targetNodeId: string;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface WorkspaceViewMetadata {
  contentProcessorByNodeId: Record<string, string>;
}

export interface WorkspaceSnapshot {
  nodes: InformationNode[];
  layout: NodeLayout[];
  references: NodeReference[];
  viewport: CanvasViewport | null;
  view: WorkspaceViewMetadata;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const contentProcessorIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;

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
  return {
    nodes: [],
    layout: [],
    references: [],
    viewport: null,
    view: { contentProcessorByNodeId: {} },
  };
}

export function normalizeNodeName(name: string): string {
  return name.trim().toLowerCase();
}

export function persistedNodeNameFromDraft(name: string): string | null {
  return name.trim().length === 0 ? null : name;
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

export function moveNodeLayoutToFront(
  layout: NodeLayout[],
  nodeId: string,
): NodeLayout[] {
  const currentIndex = layout.findIndex((item) => item.nodeId === nodeId);
  if (currentIndex < 0 || currentIndex === layout.length - 1) {
    return layout;
  }

  const item = layout[currentIndex];
  return [
    ...layout.slice(0, currentIndex),
    ...layout.slice(currentIndex + 1),
    item,
  ];
}

export function updateNodeLayoutPositions(
  layout: NodeLayout[],
  positions: Array<{ nodeId: string; x: number; y: number }>,
): NodeLayout[] {
  if (positions.length === 0) {
    return layout;
  }

  const positionByNodeId = new Map(positions.map((position) => [position.nodeId, position]));
  const existingNodeIds = new Set(layout.map((item) => item.nodeId));
  let changed = false;
  const updated = layout.map((item) => {
    const position = positionByNodeId.get(item.nodeId);
    if (position === undefined || (position.x === item.x && position.y === item.y)) {
      return item;
    }
    changed = true;
    return { ...item, x: position.x, y: position.y };
  });
  const missing = positions.filter((position) => !existingNodeIds.has(position.nodeId));
  if (missing.length > 0) {
    changed = true;
    updated.push(...missing.map((position) => ({ ...position })));
  }

  return changed ? updated : layout;
}

export function updateNodeLayoutDimensions(
  layout: NodeLayout[],
  nodeId: string,
  dimensions: { height: number; width: number; x: number; y: number } | null,
): NodeLayout[] {
  const index = layout.findIndex((item) => item.nodeId === nodeId);
  if (index < 0) {
    return layout;
  }
  const current = layout[index];
  const next =
    dimensions === null
      ? { nodeId: current.nodeId, x: current.x, y: current.y }
      : {
          nodeId: current.nodeId,
          x: dimensions.x,
          y: dimensions.y,
          width: Math.min(
            maximumManualNodeDimension,
            Math.max(minimumManualNodeWidth, dimensions.width),
          ),
          height: Math.min(
            maximumManualNodeDimension,
            Math.max(minimumManualNodeHeight, dimensions.height),
          ),
        };
  if (
    current.x === next.x &&
    current.y === next.y &&
    current.width === next.width &&
    current.height === next.height
  ) {
    return layout;
  }
  const updated = [...layout];
  updated[index] = next;
  return updated;
}

function parseWorkspaceSnapshotValue(
  value: unknown,
  allowMissingView: boolean,
): WorkspaceSnapshot | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.layout) ||
    !Array.isArray(value.references)
  ) {
    return null;
  }

  let viewport: CanvasViewport | null = null;
  if (value.viewport !== undefined && value.viewport !== null) {
    if (
      !isRecord(value.viewport) ||
      !isFiniteNumber(value.viewport.x) ||
      !isFiniteNumber(value.viewport.y) ||
      !isFiniteNumber(value.viewport.zoom) ||
      value.viewport.zoom <= 0
    ) {
      return null;
    }
    viewport = {
      x: value.viewport.x,
      y: value.viewport.y,
      zoom: value.viewport.zoom,
    };
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
    const hasWidth = candidate.width !== undefined;
    const hasHeight = candidate.height !== undefined;
    if (hasWidth !== hasHeight) {
      return null;
    }
    let width: number | undefined;
    let height: number | undefined;
    if (hasWidth && hasHeight) {
      if (
        !isFiniteNumber(candidate.width) ||
        !isFiniteNumber(candidate.height) ||
        candidate.width < minimumManualNodeWidth ||
        candidate.height < minimumManualNodeHeight ||
        candidate.width > maximumManualNodeDimension ||
        candidate.height > maximumManualNodeDimension
      ) {
        return null;
      }
      width = candidate.width;
      height = candidate.height;
    }
    layoutNodeIds.add(nodeId);
    layout.push(
      width === undefined || height === undefined
        ? { nodeId, x: candidate.x, y: candidate.y }
        : { nodeId, x: candidate.x, y: candidate.y, width, height },
    );
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

  let contentProcessorByNodeId: Record<string, string> = {};
  if (!allowMissingView && value.view !== undefined) {
    if (
      !isRecord(value.view) ||
      !isRecord(value.view.contentProcessorByNodeId)
    ) {
      return null;
    }
    contentProcessorByNodeId = {};
    for (const [rawNodeId, processorId] of Object.entries(
      value.view.contentProcessorByNodeId,
    )) {
      const nodeId = canonicalNodeId(rawNodeId);
      if (
        nodeId === null ||
        !nodeIds.has(nodeId) ||
        Object.prototype.hasOwnProperty.call(contentProcessorByNodeId, nodeId) ||
        typeof processorId !== "string" ||
        processorId === "text" ||
        !contentProcessorIdPattern.test(processorId)
      ) {
        return null;
      }
      contentProcessorByNodeId[nodeId] = processorId;
    }
  } else if (!allowMissingView) {
    return null;
  }

  return {
    nodes,
    layout,
    references,
    viewport,
    view: { contentProcessorByNodeId },
  };
}

export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | null {
  return parseWorkspaceSnapshotValue(value, false);
}

export function migrateWorkspaceSnapshotV1(
  value: unknown,
): WorkspaceSnapshot | null {
  return parseWorkspaceSnapshotValue(value, true);
}

export function removeNodesFromWorkspaceView(
  view: WorkspaceViewMetadata,
  deletedNodeIds: ReadonlySet<string>,
): WorkspaceViewMetadata {
  const entries = Object.entries(view.contentProcessorByNodeId).filter(
    ([nodeId]) => !deletedNodeIds.has(nodeId),
  );
  if (entries.length === Object.keys(view.contentProcessorByNodeId).length) {
    return view;
  }
  return { contentProcessorByNodeId: Object.fromEntries(entries) };
}
