import type {
  NodeLayout,
  WorkspaceCanvas,
  WorkspaceSnapshot,
} from "./workspaceData";

export type CanvasPlacementClipboardMode = "copy" | "cut";

export interface CanvasPlacementClipboard {
  mode: CanvasPlacementClipboardMode;
  placements: NodeLayout[];
  sourceCanvasId: string;
}

export interface CanvasPlacementTransferResult {
  targetNodeIds: string[];
  workspace: WorkspaceSnapshot;
}

const automaticNodeWidth = 270;
const automaticNodeHeight = 160;
const transferGap = 80;

interface PlacementBounds {
  bottom: number;
  centerX: number;
  centerY: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

function placementBounds(placements: readonly NodeLayout[]): PlacementBounds {
  if (placements.length === 0) {
    return {
      bottom: 0,
      centerX: 0,
      centerY: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
    };
  }
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const item of placements) {
    left = Math.min(left, item.x);
    top = Math.min(top, item.y);
    right = Math.max(right, item.x + (item.width ?? automaticNodeWidth));
    bottom = Math.max(bottom, item.y + (item.height ?? automaticNodeHeight));
  }
  return {
    bottom,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
    height: bottom - top,
    left,
    right,
    top,
    width: right - left,
  };
}

export function captureCanvasPlacements(
  workspace: WorkspaceSnapshot,
  sourceCanvasId: string,
  nodeIds: readonly string[],
  mode: CanvasPlacementClipboardMode,
): CanvasPlacementClipboard | null {
  const source = workspace.view.canvases.find(
    (canvas) => canvas.id === sourceCanvasId,
  );
  if (source === undefined) {
    return null;
  }
  const selectedNodeIds = new Set(nodeIds);
  const placements = source.layout.filter((item) =>
    selectedNodeIds.has(item.nodeId),
  );
  return placements.length === 0
    ? null
    : { mode, placements, sourceCanvasId };
}

export function suggestedCanvasTransferCenter(
  target: WorkspaceCanvas,
  viewportSize: { height: number; width: number },
  sourcePlacements: readonly NodeLayout[],
): { x: number; y: number } {
  const sourceBounds = placementBounds(sourcePlacements);
  if (target.viewport !== null) {
    return {
      x: (viewportSize.width / 2 - target.viewport.x) / target.viewport.zoom,
      y: (viewportSize.height / 2 - target.viewport.y) / target.viewport.zoom,
    };
  }
  if (target.layout.length === 0) {
    return {
      x: 80 + sourceBounds.width / 2,
      y: 80 + sourceBounds.height / 2,
    };
  }
  const targetBounds = placementBounds(target.layout);
  return {
    x: targetBounds.right + transferGap + sourceBounds.width / 2,
    y: targetBounds.top + sourceBounds.height / 2,
  };
}

export function pasteCanvasPlacements(
  workspace: WorkspaceSnapshot,
  clipboard: CanvasPlacementClipboard,
  targetCanvasId: string,
  targetCenter: { x: number; y: number },
): CanvasPlacementTransferResult {
  if (clipboard.sourceCanvasId === targetCanvasId) {
    return { targetNodeIds: [], workspace };
  }
  const target = workspace.view.canvases.find(
    (canvas) => canvas.id === targetCanvasId,
  );
  const source = workspace.view.canvases.find(
    (canvas) => canvas.id === clipboard.sourceCanvasId,
  );
  if (
    target === undefined ||
    (clipboard.mode === "cut" && source === undefined)
  ) {
    return { targetNodeIds: [], workspace };
  }

  const existingNodeIds = new Set(workspace.nodes.map((node) => node.id));
  const placements = clipboard.placements.filter((item) =>
    existingNodeIds.has(item.nodeId),
  );
  if (placements.length === 0) {
    return { targetNodeIds: [], workspace };
  }
  const bounds = placementBounds(placements);
  const offsetX = targetCenter.x - bounds.centerX;
  const offsetY = targetCenter.y - bounds.centerY;
  const targetPlacementNodeIds = new Set(
    target.layout.map((item) => item.nodeId),
  );
  const appended = placements
    .filter((item) => !targetPlacementNodeIds.has(item.nodeId))
    .map((item) => ({
      ...item,
      x: item.x + offsetX,
      y: item.y + offsetY,
    }));
  const transferredNodeIds = new Set(placements.map((item) => item.nodeId));
  const removeFromSource = clipboard.mode === "cut";
  if (appended.length === 0 && !removeFromSource) {
    return {
      targetNodeIds: placements.map((item) => item.nodeId),
      workspace,
    };
  }

  const canvases = workspace.view.canvases.map((canvas) => {
    if (canvas.id === targetCanvasId) {
      return appended.length === 0
        ? canvas
        : { ...canvas, layout: [...canvas.layout, ...appended] };
    }
    if (removeFromSource && canvas.id === clipboard.sourceCanvasId) {
      const layout = canvas.layout.filter(
        (item) => !transferredNodeIds.has(item.nodeId),
      );
      return layout.length === canvas.layout.length
        ? canvas
        : { ...canvas, layout };
    }
    return canvas;
  });
  const changed = canvases.some(
    (canvas, index) => canvas !== workspace.view.canvases[index],
  );
  return {
    targetNodeIds: placements.map((item) => item.nodeId),
    workspace: changed
      ? { ...workspace, view: { ...workspace.view, canvases } }
      : workspace,
  };
}
