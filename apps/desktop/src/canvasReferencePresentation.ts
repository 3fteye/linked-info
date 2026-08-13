import type { NodeReference } from "./workspaceStore";

export const maximumVisibleIncomingReferences = 40;

export interface CanvasReferencePresentation {
  collapsedIncomingByTarget: ReadonlyMap<string, number>;
  visibleReferences: NodeReference[];
}

export function buildCanvasReferencePresentation(
  references: readonly NodeReference[],
  maximumIncoming = maximumVisibleIncomingReferences,
): CanvasReferencePresentation {
  if (!Number.isInteger(maximumIncoming) || maximumIncoming < 1) {
    throw new Error("maximum incoming references must be a positive integer");
  }
  const incomingSeenByTarget = new Map<string, number>();
  const collapsedIncomingByTarget = new Map<string, number>();
  const visibleReferences: NodeReference[] = [];

  for (const reference of references) {
    const incomingSeen = incomingSeenByTarget.get(reference.targetNodeId) ?? 0;
    incomingSeenByTarget.set(reference.targetNodeId, incomingSeen + 1);
    if (incomingSeen < maximumIncoming) {
      visibleReferences.push(reference);
    } else {
      collapsedIncomingByTarget.set(
        reference.targetNodeId,
        (collapsedIncomingByTarget.get(reference.targetNodeId) ?? 0) + 1,
      );
    }
  }

  return { collapsedIncomingByTarget, visibleReferences };
}
