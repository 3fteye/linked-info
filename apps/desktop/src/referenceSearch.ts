import {
  normalizeNodeName,
  type InformationNode,
  type NodeReference,
} from "./workspaceStore";

export type ReferenceSearchCommand =
  | "close"
  | "move-next"
  | "move-previous"
  | "select-and-close"
  | "select-and-continue";

export function availableReferenceTargets(
  nodes: InformationNode[],
  references: NodeReference[],
  sourceNodeId: string,
  selectedTargetNodeIds: string[],
  query: string,
): InformationNode[] {
  const unavailableNodeIds = new Set([sourceNodeId, ...selectedTargetNodeIds]);
  for (const reference of references) {
    if (reference.sourceNodeId === sourceNodeId) {
      unavailableNodeIds.add(reference.targetNodeId);
    }
  }

  const normalizedQuery = normalizeNodeName(query);
  return nodes.filter(
    (node) =>
      !unavailableNodeIds.has(node.id) &&
      (normalizedQuery.length === 0 ||
        normalizeNodeName(node.name ?? "").includes(normalizedQuery)),
  );
}

export function appendNodeReference(
  references: NodeReference[],
  sourceNodeId: string,
  targetNodeId: string,
): NodeReference[] {
  if (
    sourceNodeId === targetNodeId ||
    references.some(
      (reference) =>
        reference.sourceNodeId === sourceNodeId &&
        reference.targetNodeId === targetNodeId,
    )
  ) {
    return references;
  }

  return [...references, { sourceNodeId, targetNodeId }];
}

export function appendExistingNodeReference(
  nodes: InformationNode[],
  references: NodeReference[],
  sourceNodeId: string,
  targetNodeId: string,
): NodeReference[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  return nodeIds.has(sourceNodeId) && nodeIds.has(targetNodeId)
    ? appendNodeReference(references, sourceNodeId, targetNodeId)
    : references;
}

export function referenceTargetCreationName(
  nodes: InformationNode[],
  query: string,
): string | null {
  const name = query.trim();
  const normalizedName = normalizeNodeName(name);
  if (
    normalizedName.length === 0 ||
    nodes.some(
      (node) => normalizeNodeName(node.name ?? "") === normalizedName,
    )
  ) {
    return null;
  }
  return name;
}

export function referenceSearchCommand(key: string): ReferenceSearchCommand | null {
  switch (key) {
    case " ":
      return "select-and-continue";
    case "Enter":
      return "select-and-close";
    case "ArrowDown":
      return "move-next";
    case "ArrowUp":
      return "move-previous";
    case "Escape":
      return "close";
    default:
      return null;
  }
}

export function shouldCreateMissingReferenceTarget(
  command: ReferenceSearchCommand,
): boolean {
  return command === "select-and-close";
}
