import type { NodeReference } from "./workspaceStore";

export interface SmartReferenceAcceptance {
  acceptedNodeIds: string[];
  automaticallyAddedNodeIds: string[];
}

export function reconcileSmartReferenceAcceptance(
  sourceNodeId: string,
  existingNodeIds: readonly string[],
  references: readonly NodeReference[],
  automaticallyAddedNodeIds: readonly string[],
): SmartReferenceAcceptance {
  const existingNodeIdSet = new Set(existingNodeIds);
  const acceptedNodeIds = references
    .filter(
      (reference) =>
        reference.sourceNodeId === sourceNodeId &&
        existingNodeIdSet.has(reference.targetNodeId),
    )
    .map((reference) => reference.targetNodeId);
  const acceptedNodeIdSet = new Set(acceptedNodeIds);
  return {
    acceptedNodeIds,
    automaticallyAddedNodeIds: automaticallyAddedNodeIds.filter((nodeId) =>
      acceptedNodeIdSet.has(nodeId),
    ),
  };
}
