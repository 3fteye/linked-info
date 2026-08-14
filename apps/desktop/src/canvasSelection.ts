export interface CanvasSelectionPoint {
  x: number;
  y: number;
}

export interface CanvasSelectionRectangle extends CanvasSelectionPoint {
  height: number;
  width: number;
}

export interface CanvasSelectionNode extends CanvasSelectionPoint {
  height: number;
  hidden: boolean;
  id: string;
  width: number;
}

export function canvasSelectionRectangle(
  start: CanvasSelectionPoint,
  end: CanvasSelectionPoint,
): CanvasSelectionRectangle {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function nodesFullyInsideCanvasSelection(
  nodes: readonly CanvasSelectionNode[],
  rectangle: CanvasSelectionRectangle,
): Set<string> {
  const selected = new Set<string>();
  const right = rectangle.x + rectangle.width;
  const bottom = rectangle.y + rectangle.height;
  for (const node of nodes) {
    if (
      !node.hidden &&
      node.x >= rectangle.x &&
      node.y >= rectangle.y &&
      node.x + node.width <= right &&
      node.y + node.height <= bottom
    ) {
      selected.add(node.id);
    }
  }
  return selected;
}

function autoPanAxisDelta(
  position: number,
  length: number,
  edgeDistance: number,
  maximumSpeed: number,
): number {
  if (position < edgeDistance) {
    return maximumSpeed * Math.min(1, (edgeDistance - position) / edgeDistance);
  }
  if (position > length - edgeDistance) {
    return -maximumSpeed * Math.min(
      1,
      (position - (length - edgeDistance)) / edgeDistance,
    );
  }
  return 0;
}

export function canvasSelectionAutoPanDelta(
  pointer: CanvasSelectionPoint,
  viewportSize: { height: number; width: number },
  edgeDistance = 48,
  maximumSpeed = 15,
): CanvasSelectionPoint {
  return {
    x: autoPanAxisDelta(pointer.x, viewportSize.width, edgeDistance, maximumSpeed),
    y: autoPanAxisDelta(pointer.y, viewportSize.height, edgeDistance, maximumSpeed),
  };
}
