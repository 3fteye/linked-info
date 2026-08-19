import {
  Graph,
  layout as runDagreLayout,
  type GraphLabel,
  type NodeLabel,
} from "@dagrejs/dagre";
import {
  defaultCanvasNodeGap,
  removeAllCanvasNodeOverlaps,
  type CanvasRectangle,
} from "./canvasOverlap";

export type SmartArrangementMode =
  | "auto"
  | "grid"
  | "overlap"
  | "relationship";
export type SmartArrangementSizeMode = "equal-size" | "equal-width" | "preserve";

export interface SmartArrangementReference {
  sourceNodeId: string;
  targetNodeId: string;
}

export interface SmartArrangementResult {
  mode: Exclude<SmartArrangementMode, "auto">;
  nodes: CanvasRectangle[];
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function normalizeSizes(
  nodes: readonly CanvasRectangle[],
  sizeMode: SmartArrangementSizeMode,
): CanvasRectangle[] {
  if (sizeMode === "preserve" || nodes.length === 0) {
    return nodes.map((node) => ({ ...node }));
  }
  const width = median(nodes.map((node) => node.width));
  const height = median(nodes.map((node) => node.height));
  return nodes.map((node) => ({
    ...node,
    width,
    ...(sizeMode === "equal-size" ? { height } : {}),
  }));
}

function translateToOriginalOrigin(
  original: readonly CanvasRectangle[],
  arranged: readonly CanvasRectangle[],
): CanvasRectangle[] {
  const originalLeft = Math.min(...original.map((node) => node.x));
  const originalTop = Math.min(...original.map((node) => node.y));
  const arrangedLeft = Math.min(...arranged.map((node) => node.x));
  const arrangedTop = Math.min(...arranged.map((node) => node.y));
  return arranged.map((node) => ({
    ...node,
    x: node.x + originalLeft - arrangedLeft,
    y: node.y + originalTop - arrangedTop,
  }));
}

function arrangeAsGrid(nodes: readonly CanvasRectangle[]): CanvasRectangle[] {
  const ordered = [...nodes].sort(
    (left, right) =>
      left.y - right.y ||
      left.x - right.x ||
      left.id.localeCompare(right.id),
  );
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const rows = Math.ceil(ordered.length / columns);
  const columnWidths = Array.from({ length: columns }, () => 0);
  const rowHeights = Array.from({ length: rows }, () => 0);
  ordered.forEach((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(columnWidths[column], node.width);
    rowHeights[row] = Math.max(rowHeights[row], node.height);
  });
  const columnOffsets = columnWidths.map((_, index) =>
    columnWidths
      .slice(0, index)
      .reduce((sum, width) => sum + width + defaultCanvasNodeGap, 0),
  );
  const rowOffsets = rowHeights.map((_, index) =>
    rowHeights
      .slice(0, index)
      .reduce((sum, height) => sum + height + defaultCanvasNodeGap, 0),
  );
  return ordered.map((node, index) => ({
    ...node,
    x: columnOffsets[index % columns],
    y: rowOffsets[Math.floor(index / columns)],
  }));
}

function arrangeByRelationship(
  nodes: readonly CanvasRectangle[],
  references: readonly SmartArrangementReference[],
): CanvasRectangle[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const graph = new Graph<GraphLabel, NodeLabel>()
    .setDefaultEdgeLabel(() => ({}))
    .setGraph({
      edgesep: 24,
      marginx: 0,
      marginy: 0,
      nodesep: 60,
      rankdir: "LR",
      ranksep: 100,
    });
  for (const node of nodes) {
    graph.setNode(node.id, { height: node.height, width: node.width });
  }
  for (const reference of references) {
    if (
      nodeIds.has(reference.sourceNodeId) &&
      nodeIds.has(reference.targetNodeId) &&
      reference.sourceNodeId !== reference.targetNodeId
    ) {
      graph.setEdge(reference.sourceNodeId, reference.targetNodeId);
    }
  }
  runDagreLayout(graph);
  return nodes.map((node) => {
    const position = graph.node(node.id);
    return {
      ...node,
      x: (position.x ?? node.width / 2) - node.width / 2,
      y: (position.y ?? node.height / 2) - node.height / 2,
    };
  });
}

export function arrangeCanvasNodes(
  nodes: readonly CanvasRectangle[],
  references: readonly SmartArrangementReference[],
  requestedMode: SmartArrangementMode,
  sizeMode: SmartArrangementSizeMode,
): SmartArrangementResult {
  if (nodes.length === 0) {
    return { mode: requestedMode === "auto" ? "grid" : requestedMode, nodes: [] };
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const internalReferences = references.filter(
    (reference) =>
      nodeIds.has(reference.sourceNodeId) &&
      nodeIds.has(reference.targetNodeId),
  );
  const mode =
    requestedMode === "auto"
      ? internalReferences.length > 0
        ? "relationship"
        : "grid"
      : requestedMode;
  const sized = normalizeSizes(nodes, sizeMode);
  const arranged =
    mode === "relationship"
      ? arrangeByRelationship(sized, internalReferences)
      : mode === "grid"
        ? arrangeAsGrid(sized)
        : removeAllCanvasNodeOverlaps(sized);
  return {
    mode,
    nodes: translateToOriginalOrigin(nodes, arranged),
  };
}
