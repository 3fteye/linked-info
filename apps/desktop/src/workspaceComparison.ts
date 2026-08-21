import type { NodeLayout, WorkspaceSnapshot } from "./workspaceData";

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

function placementKey(canvasId: string, nodeId: string): string {
  return `${canvasId}\0${nodeId}`;
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

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  return (
    leftKeys.length === Object.keys(rightRecord).length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        jsonValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

type NodeExtensionMetadataIndex = Map<string, Map<string, unknown>>;

function indexNodeExtensionMetadata(
  workspace: WorkspaceSnapshot,
): NodeExtensionMetadataIndex {
  const index: NodeExtensionMetadataIndex = new Map();
  for (const [extensionId, metadata] of Object.entries(
    workspace.view.extensionMetadata,
  )) {
    for (const [nodeId, payload] of Object.entries(metadata.byNodeId)) {
      const nodeMetadata = index.get(nodeId) ?? new Map<string, unknown>();
      nodeMetadata.set(extensionId, payload);
      index.set(nodeId, nodeMetadata);
    }
  }
  return index;
}

export interface WorkspaceViewMetadataComparison {
  nodeEqual(nodeId: string): boolean;
}

export function createWorkspaceViewMetadataComparison(
  current: WorkspaceSnapshot,
  replacement: WorkspaceSnapshot,
): WorkspaceViewMetadataComparison {
  const currentByNodeId = indexNodeExtensionMetadata(current);
  const replacementByNodeId = indexNodeExtensionMetadata(replacement);
  const nodeEqualityCache = new Map<string, boolean>();
  return {
    nodeEqual(nodeId) {
      const cached = nodeEqualityCache.get(nodeId);
      if (cached !== undefined) {
        return cached;
      }
      const currentMetadata = currentByNodeId.get(nodeId);
      const replacementMetadata = replacementByNodeId.get(nodeId);
      const equal =
        current.view.contentProcessorByNodeId[nodeId] ===
          replacement.view.contentProcessorByNodeId[nodeId] &&
        (currentMetadata?.size ?? 0) === (replacementMetadata?.size ?? 0) &&
        [...(currentMetadata?.entries() ?? [])].every(
          ([extensionId, payload]) =>
            replacementMetadata?.has(extensionId) === true &&
            jsonValuesEqual(payload, replacementMetadata.get(extensionId)),
        );
      nodeEqualityCache.set(nodeId, equal);
      return equal;
    },
  };
}

export function compareWorkspaces(
  current: WorkspaceSnapshot,
  replacement: WorkspaceSnapshot,
  viewComparison = createWorkspaceViewMetadataComparison(current, replacement),
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
      !viewComparison.nodeEqual(nodeId)
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

  const currentCanvasesById = new Map(
    current.view.canvases.map((canvas) => [canvas.id, canvas]),
  );
  const replacementCanvasesById = new Map(
    replacement.view.canvases.map((canvas) => [canvas.id, canvas]),
  );
  const currentStackIndex = new Map<string, number>();
  const replacementStackIndex = new Map<string, number>();
  const currentLayout = new Map<string, NodeLayout>();
  const replacementLayout = new Map<string, NodeLayout>();
  for (const canvas of current.view.canvases) {
    canvas.layout.forEach((layout) => {
      const key = placementKey(canvas.id, layout.nodeId);
      currentLayout.set(key, layout);
    });
  }
  for (const canvas of replacement.view.canvases) {
    canvas.layout.forEach((layout) => {
      const key = placementKey(canvas.id, layout.nodeId);
      replacementLayout.set(key, layout);
    });
  }
  for (const canvas of current.view.canvases) {
    const replacementCanvas = replacementCanvasesById.get(canvas.id);
    if (replacementCanvas === undefined) {
      continue;
    }
    const replacementPlacementNodeIds = new Set(
      replacementCanvas.layout.map((layout) => layout.nodeId),
    );
    const sharedNodeIds = new Set(
      canvas.layout
        .map((layout) => layout.nodeId)
        .filter((nodeId) => replacementPlacementNodeIds.has(nodeId)),
    );
    canvas.layout
      .filter((layout) => sharedNodeIds.has(layout.nodeId))
      .forEach((layout, index) => {
        currentStackIndex.set(placementKey(canvas.id, layout.nodeId), index);
      });
    replacementCanvas.layout
      .filter((layout) => sharedNodeIds.has(layout.nodeId))
      .forEach((layout, index) => {
        replacementStackIndex.set(
          placementKey(canvas.id, layout.nodeId),
          index,
        );
      });
  }
  let changedLayouts = 0;
  for (const [key, layout] of replacementLayout) {
    const currentItem = currentLayout.get(key);
    if (currentItem === undefined) {
      const canvasId = key.slice(0, key.indexOf("\0"));
      if (currentNodes.has(layout.nodeId) && currentCanvasesById.has(canvasId)) {
        changedLayouts += 1;
      }
    } else if (
      currentItem.x !== layout.x ||
        currentItem.y !== layout.y ||
        currentItem.width !== layout.width ||
        currentItem.height !== layout.height ||
        currentStackIndex.get(key) !== replacementStackIndex.get(key)
    ) {
      changedLayouts += 1;
    }
  }
  for (const [key, layout] of currentLayout) {
    const canvasId = key.slice(0, key.indexOf("\0"));
    if (
      !replacementLayout.has(key) &&
      replacementNodes.has(layout.nodeId) &&
      replacementCanvasesById.has(canvasId)
    ) {
      changedLayouts += 1;
    }
  }

  const viewportChanged =
    current.view.activeCanvasId !== replacement.view.activeCanvasId ||
    current.view.canvases.some((canvas) => {
      const next = replacementCanvasesById.get(canvas.id);
      return (
        next === undefined ||
        canvas.viewport?.x !== next.viewport?.x ||
        canvas.viewport?.y !== next.viewport?.y ||
        canvas.viewport?.zoom !== next.viewport?.zoom
      );
    }) ||
    replacement.view.canvases.some(
      (canvas) => !currentCanvasesById.has(canvas.id),
    );
  const viewMetadataChanged =
    !stringRecordsEqual(
      current.view.contentProcessorByNodeId,
      replacement.view.contentProcessorByNodeId,
    ) ||
    !jsonValuesEqual(
      current.view.extensionMetadata,
      replacement.view.extensionMetadata,
    ) ||
    !jsonValuesEqual(
      current.view.canvases.map(({ id, name }) => ({ id, name })),
      replacement.view.canvases.map(({ id, name }) => ({ id, name })),
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
