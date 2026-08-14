import type { NodeReference } from "./workspaceStore";

export interface ReferenceNodeGeometry {
  height: number;
  hidden: boolean;
  id: string;
  width: number;
  x: number;
  y: number;
}

export interface ReferenceCurve {
  controlX: number;
  id: string;
  sourceNodeId: string;
  sourceX: number;
  sourceY: number;
  targetNodeId: string;
  targetX: number;
  targetY: number;
}

export interface BatchedReferencePaths {
  normal: string;
  selected: string;
}

export interface PartitionedReferences {
  moving: NodeReference[];
  stationary: NodeReference[];
}

export function referenceCurveId(reference: NodeReference): string {
  return `reference:${reference.sourceNodeId}:${reference.targetNodeId}`;
}

export function partitionReferencesByMovingNodes(
  references: readonly NodeReference[],
  movingNodeIds: ReadonlySet<string>,
): PartitionedReferences {
  const moving: NodeReference[] = [];
  const stationary: NodeReference[] = [];
  for (const reference of references) {
    const target =
      movingNodeIds.has(reference.sourceNodeId) ||
      movingNodeIds.has(reference.targetNodeId)
        ? moving
        : stationary;
    target.push(reference);
  }
  return { moving, stationary };
}

function curvePath(curve: ReferenceCurve): string {
  return `M ${curve.sourceX} ${curve.sourceY} C ${curve.controlX} ${curve.sourceY}, ${curve.controlX} ${curve.targetY}, ${curve.targetX} ${curve.targetY}`;
}

export function buildReferenceCurves(
  references: readonly NodeReference[],
  nodes: readonly ReferenceNodeGeometry[],
): ReferenceCurve[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const curves: ReferenceCurve[] = [];
  for (const reference of references) {
    const source = nodeById.get(reference.sourceNodeId);
    const target = nodeById.get(reference.targetNodeId);
    if (source === undefined || target === undefined || source.hidden || target.hidden) {
      continue;
    }
    const sourceX = source.x + source.width;
    const sourceY = source.y + source.height / 2;
    const targetX = target.x;
    const targetY = target.y + target.height / 2;
    curves.push({
      controlX: (sourceX + targetX) / 2,
      id: referenceCurveId(reference),
      sourceNodeId: reference.sourceNodeId,
      sourceX,
      sourceY,
      targetNodeId: reference.targetNodeId,
      targetX,
      targetY,
    });
  }
  return curves;
}

export function buildBatchedReferencePaths(
  curves: readonly ReferenceCurve[],
  selectedCurveId: string | null,
): BatchedReferencePaths {
  const normal: string[] = [];
  const selected: string[] = [];
  for (const curve of curves) {
    (curve.id === selectedCurveId ? selected : normal).push(curvePath(curve));
  }
  return { normal: normal.join(" "), selected: selected.join(" ") };
}

function cubicCoordinate(
  start: number,
  controlStart: number,
  controlEnd: number,
  end: number,
  progress: number,
): number {
  const inverse = 1 - progress;
  return (
    inverse ** 3 * start +
    3 * inverse ** 2 * progress * controlStart +
    3 * inverse * progress ** 2 * controlEnd +
    progress ** 3 * end
  );
}

function pointToSegmentDistanceSquared(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  if (lengthSquared === 0) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  }
  const progress = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
        lengthSquared,
    ),
  );
  const nearestX = start.x + progress * deltaX;
  const nearestY = start.y + progress * deltaY;
  return (point.x - nearestX) ** 2 + (point.y - nearestY) ** 2;
}

export function findReferenceCurveAtPoint(
  curves: readonly ReferenceCurve[],
  point: { x: number; y: number },
  maximumDistance: number,
  sampleCount = 20,
): ReferenceCurve | null {
  const maximumDistanceSquared = maximumDistance ** 2;
  let closest: ReferenceCurve | null = null;
  let closestDistanceSquared = maximumDistanceSquared;
  for (const curve of curves) {
    let previous = { x: curve.sourceX, y: curve.sourceY };
    for (let sample = 1; sample <= sampleCount; sample += 1) {
      const progress = sample / sampleCount;
      const current = {
        x: cubicCoordinate(
          curve.sourceX,
          curve.controlX,
          curve.controlX,
          curve.targetX,
          progress,
        ),
        y: cubicCoordinate(
          curve.sourceY,
          curve.sourceY,
          curve.targetY,
          curve.targetY,
          progress,
        ),
      };
      const distanceSquared = pointToSegmentDistanceSquared(point, previous, current);
      if (distanceSquared <= closestDistanceSquared) {
        closestDistanceSquared = distanceSquared;
        closest = curve;
      }
      previous = current;
    }
  }
  return closest;
}
