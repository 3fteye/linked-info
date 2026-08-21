import type { WorkspaceCanvas } from "./workspaceData";

export interface NodeCanvasMembership {
  canvasId: string;
  canvasName: string;
}

export function buildCanvasMembershipIndex(
  canvases: readonly WorkspaceCanvas[],
): ReadonlyMap<string, readonly NodeCanvasMembership[]> {
  const memberships = new Map<string, NodeCanvasMembership[]>();
  for (const canvas of canvases) {
    for (const placement of canvas.layout) {
      const current = memberships.get(placement.nodeId) ?? [];
      current.push({ canvasId: canvas.id, canvasName: canvas.name });
      memberships.set(placement.nodeId, current);
    }
  }
  return memberships;
}

export function preferredCanvasForNode(
  memberships: readonly NodeCanvasMembership[],
  activeCanvasId: string,
  preferredCanvasId?: string,
): string | null {
  if (
    preferredCanvasId !== undefined &&
    memberships.some((item) => item.canvasId === preferredCanvasId)
  ) {
    return preferredCanvasId;
  }
  if (memberships.some((item) => item.canvasId === activeCanvasId)) {
    return activeCanvasId;
  }
  return memberships[0]?.canvasId ?? null;
}
