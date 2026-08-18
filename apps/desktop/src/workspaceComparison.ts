import type { WorkspaceSnapshot } from "./workspaceData";

export interface WorkspaceComparison {
  addedNodes: number;
  removedNodes: number;
  modifiedNodes: number;
  addedReferences: number;
  removedReferences: number;
  changedLayouts: number;
  viewportChanged: boolean;
  viewMetadataChanged: boolean;
  identical: boolean;
}

function referenceKey(sourceNodeId: string, targetNodeId: string): string {
  return `${sourceNodeId}\0${targetNodeId}`;
}

function stringRecordsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

export function compareWorkspaces(
  current: WorkspaceSnapshot,
  replacement: WorkspaceSnapshot,
): WorkspaceComparison {
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const replacementNodes = new Map(
    replacement.nodes.map((node) => [node.id, node]),
  );
  let addedNodes = 0;
  let removedNodes = 0;
  let modifiedNodes = 0;

  for (const [nodeId, node] of replacementNodes) {
    const currentNode = currentNodes.get(nodeId);
    if (currentNode === undefined) {
      addedNodes += 1;
    } else if (
      currentNode.name !== node.name ||
      currentNode.content !== node.content ||
      current.view.contentProcessorByNodeId[nodeId] !==
        replacement.view.contentProcessorByNodeId[nodeId]
    ) {
      modifiedNodes += 1;
    }
  }
  for (const nodeId of currentNodes.keys()) {
    if (!replacementNodes.has(nodeId)) {
      removedNodes += 1;
    }
  }

  const currentReferences = new Set(
    current.references.map((reference) =>
      referenceKey(reference.sourceNodeId, reference.targetNodeId),
    ),
  );
  const replacementReferences = new Set(
    replacement.references.map((reference) =>
      referenceKey(reference.sourceNodeId, reference.targetNodeId),
    ),
  );
  let addedReferences = 0;
  let removedReferences = 0;
  for (const reference of replacementReferences) {
    if (!currentReferences.has(reference)) {
      addedReferences += 1;
    }
  }
  for (const reference of currentReferences) {
    if (!replacementReferences.has(reference)) {
      removedReferences += 1;
    }
  }

  const retainedNodeIds = new Set(
    current.nodes
      .map((node) => node.id)
      .filter((nodeId) => replacementNodes.has(nodeId)),
  );
  const currentStackIndex = new Map(
    current.layout
      .filter((layout) => retainedNodeIds.has(layout.nodeId))
      .map((layout, index) => [layout.nodeId, index]),
  );
  const replacementStackIndex = new Map(
    replacement.layout
      .filter((layout) => retainedNodeIds.has(layout.nodeId))
      .map((layout, index) => [layout.nodeId, index]),
  );
  const currentLayout = new Map(
    current.layout.map((layout) => [layout.nodeId, layout]),
  );
  let changedLayouts = 0;
  replacement.layout.forEach((layout) => {
    const currentItem = currentLayout.get(layout.nodeId);
    if (
      currentItem !== undefined &&
      (currentItem.x !== layout.x ||
        currentItem.y !== layout.y ||
        currentItem.width !== layout.width ||
        currentItem.height !== layout.height ||
        currentStackIndex.get(layout.nodeId) !==
          replacementStackIndex.get(layout.nodeId))
    ) {
      changedLayouts += 1;
    }
  });

  const viewportChanged =
    current.viewport?.x !== replacement.viewport?.x ||
    current.viewport?.y !== replacement.viewport?.y ||
    current.viewport?.zoom !== replacement.viewport?.zoom;
  const viewMetadataChanged = !stringRecordsEqual(
    current.view.contentProcessorByNodeId,
    replacement.view.contentProcessorByNodeId,
  );
  const identical =
    addedNodes === 0 &&
    removedNodes === 0 &&
    modifiedNodes === 0 &&
    addedReferences === 0 &&
    removedReferences === 0 &&
    changedLayouts === 0 &&
    !viewportChanged &&
    !viewMetadataChanged;

  return {
    addedNodes,
    removedNodes,
    modifiedNodes,
    addedReferences,
    removedReferences,
    changedLayouts,
    viewportChanged,
    viewMetadataChanged,
    identical,
  };
}
