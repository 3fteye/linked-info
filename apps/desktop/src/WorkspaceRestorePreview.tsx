import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ArchiveRestore, ArrowRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  InformationNode,
  NodeLayout,
  NodeReference,
  WorkspaceSnapshot,
} from "./workspaceData";
import {
  compareWorkspaces,
  createWorkspaceViewMetadataComparison,
  type WorkspaceViewMetadataComparison,
} from "./workspaceComparison";
import "@xyflow/react/dist/style.css";

type PreviewMode = "before" | "after" | "overlay";
type PreviewNodeStatus =
  | "added"
  | "modified"
  | "removed"
  | "unchanged"
  | "before-position";

interface RestorePreviewLabels {
  title: string;
  source: string;
  before: string;
  after: string;
  overlay: string;
  canvas: string;
  unplaced: string;
  cancel: string;
  confirm: string;
  identical: string;
  added: string;
  removed: string;
  modified: string;
  moved: string;
  resized: string;
  stacking: string;
  beforePosition: string;
  unnamed: string;
  noContent: string;
  legendAdded: string;
  legendRemoved: string;
  legendModified: string;
  legendMoved: string;
  legendResized: string;
}

interface WorkspaceRestorePreviewProps {
  changedOnly?: boolean;
  contextPadding?: number;
  current: WorkspaceSnapshot;
  replacement: WorkspaceSnapshot;
  labels: RestorePreviewLabels;
  onCancel: () => void;
  onConfirm: () => void;
}

interface PreviewNodeData extends Record<string, unknown> {
  name: string | null;
  content: string | null;
  status: PreviewNodeStatus;
  badges: string[];
  manualHeight: boolean;
  manualWidth: boolean;
  unnamedLabel: string;
  noContentLabel: string;
}

type RestoreFlowNode = Node<PreviewNodeData, "restore-preview">;

interface NodeDifference {
  added: boolean;
  removed: boolean;
  modified: boolean;
  moved: boolean;
  resized: boolean;
  stackingChanged: boolean;
}

function PreviewNodeCard({ data }: NodeProps<RestoreFlowNode>) {
  return (
    <article
      className="restore-preview-node"
      data-manual-height={data.manualHeight}
      data-manual-width={data.manualWidth}
      data-status={data.status}
    >
      <Handle
        className="restore-preview-handle"
        position={Position.Left}
        type="target"
      />
      <header>
        <strong data-unnamed={data.name === null}>
          {data.name ?? data.unnamedLabel}
        </strong>
        {data.badges.length > 0 && (
          <div className="restore-preview-node-badges">
            {data.badges.map((badge) => (
              <span key={badge}>{badge}</span>
            ))}
          </div>
        )}
      </header>
      <p>{data.content || data.noContentLabel}</p>
      <Handle
        className="restore-preview-handle"
        position={Position.Right}
        type="source"
      />
    </article>
  );
}

const previewNodeTypes = { "restore-preview": PreviewNodeCard };
const emptyPreviewLayout: NodeLayout[] = [];
const unplacedPreviewCanvasId = "__unplaced__";

function layoutsByNode(layout: NodeLayout[]): Map<string, NodeLayout> {
  return new Map(layout.map((item) => [item.nodeId, item]));
}

function referenceKey(reference: NodeReference): string {
  return `${reference.sourceNodeId}\0${reference.targetNodeId}`;
}

function makeNode(
  id: string,
  node: InformationNode,
  layout: NodeLayout,
  status: PreviewNodeStatus,
  badges: string[],
  labels: RestorePreviewLabels,
  zIndex: number,
): RestoreFlowNode {
  return {
    id,
    type: "restore-preview",
    position: { x: layout.x, y: layout.y },
    data: {
      name: node.name,
      content: node.content,
      status,
      badges,
      manualHeight: layout.height !== undefined,
      manualWidth: layout.width !== undefined,
      unnamedLabel: labels.unnamed,
      noContentLabel: labels.noContent,
    },
    draggable: false,
    selectable: false,
    style:
      layout.width === undefined && layout.height === undefined
        ? undefined
        : {
            ...(layout.height === undefined ? {} : { height: layout.height }),
            ...(layout.width === undefined ? {} : { width: layout.width }),
          },
    zIndex,
  };
}

function makeReferenceEdge(
  prefix: string,
  reference: NodeReference,
  source: string,
  target: string,
  status: "added" | "removed" | "unchanged",
): Edge {
  const color =
    status === "added" ? "#2f8a58" : status === "removed" ? "#b64c43" : "#718279";
  return {
    id: `${prefix}:${reference.sourceNodeId}:${reference.targetNodeId}`,
    source,
    target,
    selectable: false,
    animated: false,
    style: {
      stroke: color,
      strokeWidth: status === "unchanged" ? 1.6 : 2.2,
      strokeDasharray: status === "removed" ? "7 5" : undefined,
      opacity: status === "unchanged" ? 0.62 : 0.95,
    },
  };
}

function nodeDifferences(
  current: WorkspaceSnapshot,
  replacement: WorkspaceSnapshot,
  currentLayoutItems: NodeLayout[],
  replacementLayoutItems: NodeLayout[],
  viewComparison: WorkspaceViewMetadataComparison,
): Map<string, NodeDifference> {
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const replacementNodes = new Map(replacement.nodes.map((node) => [node.id, node]));
  const currentLayout = layoutsByNode(currentLayoutItems);
  const replacementLayout = layoutsByNode(replacementLayoutItems);
  const retained = new Set(
    currentLayoutItems
      .map((item) => item.nodeId)
      .filter((nodeId) => replacementLayout.has(nodeId)),
  );
  const currentStack = new Map(
    currentLayoutItems
      .filter((item) => retained.has(item.nodeId))
      .map((item, index) => [item.nodeId, index]),
  );
  const replacementStack = new Map(
    replacementLayoutItems
      .filter((item) => retained.has(item.nodeId))
      .map((item, index) => [item.nodeId, index]),
  );
  const result = new Map<string, NodeDifference>();
  for (const nodeId of new Set([...currentNodes.keys(), ...replacementNodes.keys()])) {
    const before = currentNodes.get(nodeId);
    const after = replacementNodes.get(nodeId);
    const beforeLayout = currentLayout.get(nodeId);
    const afterLayout = replacementLayout.get(nodeId);
    result.set(nodeId, {
      added:
        before === undefined ||
        (beforeLayout === undefined && afterLayout !== undefined),
      removed:
        after === undefined ||
        (beforeLayout !== undefined && afterLayout === undefined),
      modified:
        before !== undefined &&
        after !== undefined &&
        (before.name !== after.name ||
          before.content !== after.content ||
          !viewComparison.nodeEqual(nodeId)),
      moved:
        beforeLayout !== undefined &&
        afterLayout !== undefined &&
        (beforeLayout.x !== afterLayout.x || beforeLayout.y !== afterLayout.y),
      resized:
        beforeLayout !== undefined &&
        afterLayout !== undefined &&
        (beforeLayout.width !== afterLayout.width ||
          beforeLayout.height !== afterLayout.height),
      stackingChanged:
        before !== undefined &&
        after !== undefined &&
        currentStack.get(nodeId) !== replacementStack.get(nodeId),
    });
  }
  return result;
}

function badgesFor(
  difference: NodeDifference,
  status: PreviewNodeStatus,
  labels: RestorePreviewLabels,
): string[] {
  if (status === "before-position") {
    return difference.resized
      ? [labels.beforePosition, labels.resized]
      : [labels.beforePosition];
  }
  const badges: string[] = [];
  if (difference.added) badges.push(labels.added);
  if (difference.removed) badges.push(labels.removed);
  if (difference.modified) badges.push(labels.modified);
  if (difference.moved) badges.push(labels.moved);
  if (difference.resized) badges.push(labels.resized);
  if (difference.stackingChanged) badges.push(labels.stacking);
  return badges;
}

export default function WorkspaceRestorePreview({
  changedOnly = false,
  contextPadding = 0,
  current,
  replacement,
  labels,
  onCancel,
  onConfirm,
}: WorkspaceRestorePreviewProps) {
  const [mode, setMode] = useState<PreviewMode>("overlay");
  const unplacedLayouts = useMemo(() => {
    const currentPlacedNodeIds = new Set(
      current.view.canvases.flatMap((canvas) =>
        canvas.layout.map((layout) => layout.nodeId),
      ),
    );
    const replacementPlacedNodeIds = new Set(
      replacement.view.canvases.flatMap((canvas) =>
        canvas.layout.map((layout) => layout.nodeId),
      ),
    );
    const currentUnplacedNodeIds = new Set(
      current.nodes
        .map((node) => node.id)
        .filter((nodeId) => !currentPlacedNodeIds.has(nodeId)),
    );
    const replacementUnplacedNodeIds = new Set(
      replacement.nodes
        .map((node) => node.id)
        .filter((nodeId) => !replacementPlacedNodeIds.has(nodeId)),
    );
    const orderedNodeIds: string[] = [];
    const seenNodeIds = new Set<string>();
    for (const nodes of [current.nodes, replacement.nodes]) {
      for (const node of nodes) {
        if (
          !seenNodeIds.has(node.id) &&
          (currentUnplacedNodeIds.has(node.id) ||
            replacementUnplacedNodeIds.has(node.id))
        ) {
          seenNodeIds.add(node.id);
          orderedNodeIds.push(node.id);
        }
      }
    }
    const positions = new Map(
      orderedNodeIds.map((nodeId, index) => [
        nodeId,
        { x: (index % 4) * 320, y: Math.floor(index / 4) * 210 },
      ]),
    );
    const layoutFor = (nodeIds: ReadonlySet<string>): NodeLayout[] =>
      orderedNodeIds
        .filter((nodeId) => nodeIds.has(nodeId))
        .map((nodeId) => ({ nodeId, ...positions.get(nodeId)! }));
    return {
      current: layoutFor(currentUnplacedNodeIds),
      replacement: layoutFor(replacementUnplacedNodeIds),
    };
  }, [current.nodes, current.view.canvases, replacement.nodes, replacement.view.canvases]);
  const canvasOptions = useMemo(() => {
    const byId = new Map<
      string,
      { id: string; name: string; before: boolean; after: boolean }
    >();
    for (const canvas of current.view.canvases) {
      byId.set(canvas.id, {
        id: canvas.id,
        name: canvas.name,
        before: true,
        after: false,
      });
    }
    for (const canvas of replacement.view.canvases) {
      const existing = byId.get(canvas.id);
      byId.set(canvas.id, {
        id: canvas.id,
        name: canvas.name,
        before: existing?.before ?? false,
        after: true,
      });
    }
    if (unplacedLayouts.current.length > 0 || unplacedLayouts.replacement.length > 0) {
      byId.set(unplacedPreviewCanvasId, {
        id: unplacedPreviewCanvasId,
        name: labels.unplaced,
        before: unplacedLayouts.current.length > 0,
        after: unplacedLayouts.replacement.length > 0,
      });
    }
    return [...byId.values()];
  }, [
    current.view.canvases,
    labels.unplaced,
    replacement.view.canvases,
    unplacedLayouts,
  ]);
  const [selectedCanvasId, setSelectedCanvasId] = useState(
    replacement.view.activeCanvasId,
  );
  useEffect(() => {
    if (!canvasOptions.some((canvas) => canvas.id === selectedCanvasId)) {
      setSelectedCanvasId(
        canvasOptions[0]?.id ?? replacement.view.activeCanvasId,
      );
    }
  }, [canvasOptions, replacement.view.activeCanvasId, selectedCanvasId]);
  const currentCanvas = current.view.canvases.find(
    (canvas) => canvas.id === selectedCanvasId,
  );
  const replacementCanvas = replacement.view.canvases.find(
    (canvas) => canvas.id === selectedCanvasId,
  );
  const currentLayout =
    selectedCanvasId === unplacedPreviewCanvasId
      ? unplacedLayouts.current
      : currentCanvas?.layout ?? emptyPreviewLayout;
  const replacementLayout =
    selectedCanvasId === unplacedPreviewCanvasId
      ? unplacedLayouts.replacement
      : replacementCanvas?.layout ?? emptyPreviewLayout;
  const viewComparison = useMemo(
    () => createWorkspaceViewMetadataComparison(current, replacement),
    [current, replacement],
  );
  const differences = useMemo(
    () =>
      nodeDifferences(
        current,
        replacement,
        currentLayout,
        replacementLayout,
        viewComparison,
      ),
    [current, currentLayout, replacement, replacementLayout, viewComparison],
  );
  const currentNodes = useMemo(
    () => new Map(current.nodes.map((node) => [node.id, node])),
    [current.nodes],
  );
  const replacementNodes = useMemo(
    () => new Map(replacement.nodes.map((node) => [node.id, node])),
    [replacement.nodes],
  );
  const currentReferenceKeys = useMemo(
    () => new Set(current.references.map(referenceKey)),
    [current.references],
  );
  const replacementReferenceKeys = useMemo(
    () => new Set(replacement.references.map(referenceKey)),
    [replacement.references],
  );
  const currentLayoutNodeIds = useMemo(
    () => new Set(currentLayout.map((layout) => layout.nodeId)),
    [currentLayout],
  );
  const replacementLayoutNodeIds = useMemo(
    () => new Set(replacementLayout.map((layout) => layout.nodeId)),
    [replacementLayout],
  );
  const previewNodeIds = useMemo(() => {
    if (!changedOnly) return null;
    const nodeIds = new Set<string>();
    for (const [nodeId, difference] of differences) {
      if (
        difference.added ||
        difference.removed ||
        difference.modified ||
        difference.moved ||
        difference.resized ||
        difference.stackingChanged
      ) {
        nodeIds.add(nodeId);
      }
    }
    for (const reference of current.references) {
      if (!replacementReferenceKeys.has(referenceKey(reference))) {
        nodeIds.add(reference.sourceNodeId);
        nodeIds.add(reference.targetNodeId);
      }
    }
    for (const reference of replacement.references) {
      if (!currentReferenceKeys.has(referenceKey(reference))) {
        nodeIds.add(reference.sourceNodeId);
        nodeIds.add(reference.targetNodeId);
      }
    }
    if (contextPadding <= 0 || nodeIds.size === 0) {
      return nodeIds;
    }
    const relevantLayouts = [...currentLayout, ...replacementLayout].filter(
      (layout) => nodeIds.has(layout.nodeId),
    );
    if (relevantLayouts.length === 0) {
      return nodeIds;
    }
    const left = Math.min(...relevantLayouts.map((layout) => layout.x)) - contextPadding;
    const top = Math.min(...relevantLayouts.map((layout) => layout.y)) - contextPadding;
    const right =
      Math.max(
        ...relevantLayouts.map(
          (layout) => layout.x + (layout.width ?? 270),
        ),
      ) + contextPadding;
    const bottom =
      Math.max(
        ...relevantLayouts.map(
          (layout) => layout.y + (layout.height ?? 160),
        ),
      ) + contextPadding;
    for (const layout of [...currentLayout, ...replacementLayout]) {
      const layoutRight = layout.x + (layout.width ?? 270);
      const layoutBottom = layout.y + (layout.height ?? 160);
      if (
        layout.x <= right &&
        layoutRight >= left &&
        layout.y <= bottom &&
        layoutBottom >= top
      ) {
        nodeIds.add(layout.nodeId);
      }
    }
    return nodeIds;
  }, [
    changedOnly,
    contextPadding,
    currentLayout,
    current.references,
    currentReferenceKeys,
    differences,
    replacement.references,
    replacementLayout,
    replacementReferenceKeys,
  ]);

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [onCancel]);

  const graph = useMemo(() => {
    const nodes: RestoreFlowNode[] = [];
    const edges: Edge[] = [];
    const nodeIsVisible = (nodeId: string) =>
      previewNodeIds === null || previewNodeIds.has(nodeId);

    if (mode === "before") {
      currentLayout.forEach((layout, index) => {
        if (!nodeIsVisible(layout.nodeId)) return;
        const node = currentNodes.get(layout.nodeId);
        const difference = differences.get(layout.nodeId);
        if (node === undefined || difference === undefined) return;
        const status: PreviewNodeStatus = difference.removed
          ? "removed"
          : difference.modified
            ? "modified"
            : "unchanged";
        nodes.push(
          makeNode(
            node.id,
            node,
            layout,
            status,
            badgesFor(difference, status, labels),
            labels,
            index,
          ),
        );
      });
      current.references.forEach((reference) => {
        if (
          !currentLayoutNodeIds.has(reference.sourceNodeId) ||
          !currentLayoutNodeIds.has(reference.targetNodeId) ||
          !nodeIsVisible(reference.sourceNodeId) ||
          !nodeIsVisible(reference.targetNodeId)
        ) return;
        edges.push(
          makeReferenceEdge(
            "before",
            reference,
            reference.sourceNodeId,
            reference.targetNodeId,
            replacementReferenceKeys.has(referenceKey(reference))
              ? "unchanged"
              : "removed",
          ),
        );
      });
      return { nodes, edges };
    }

    replacementLayout.forEach((layout, index) => {
      if (!nodeIsVisible(layout.nodeId)) return;
      const node = replacementNodes.get(layout.nodeId);
      const difference = differences.get(layout.nodeId);
      if (node === undefined || difference === undefined) return;
      const status: PreviewNodeStatus = difference.added
        ? "added"
        : difference.modified
          ? "modified"
          : "unchanged";
      nodes.push(
        makeNode(
          node.id,
          node,
          layout,
          status,
          badgesFor(difference, status, labels),
          labels,
          index * 2 + 1,
        ),
      );
    });
    replacement.references.forEach((reference) => {
      if (
        !replacementLayoutNodeIds.has(reference.sourceNodeId) ||
        !replacementLayoutNodeIds.has(reference.targetNodeId) ||
        !nodeIsVisible(reference.sourceNodeId) ||
        !nodeIsVisible(reference.targetNodeId)
      ) return;
      edges.push(
        makeReferenceEdge(
          "after",
          reference,
          reference.sourceNodeId,
          reference.targetNodeId,
          currentReferenceKeys.has(referenceKey(reference)) ? "unchanged" : "added",
        ),
      );
    });

    if (mode === "after") {
      return { nodes, edges };
    }

    const beforeEndpoint = new Map<string, string>();
    currentLayout.forEach((layout, index) => {
      if (!nodeIsVisible(layout.nodeId)) return;
      const node = currentNodes.get(layout.nodeId);
      const difference = differences.get(layout.nodeId);
      if (node === undefined || difference === undefined) return;
      if (difference.removed || difference.moved || difference.resized) {
        const ghostId = `before:${node.id}`;
        beforeEndpoint.set(node.id, ghostId);
        const status: PreviewNodeStatus = difference.removed
          ? "removed"
          : "before-position";
        nodes.push(
          makeNode(
            ghostId,
            node,
            layout,
            status,
            badgesFor(difference, status, labels),
            labels,
            index * 2,
          ),
        );
        if (difference.moved && !difference.removed) {
          edges.push({
            id: `movement:${node.id}`,
            source: ghostId,
            target: node.id,
            selectable: false,
            style: {
              stroke: "#477ca8",
              strokeWidth: 2,
              strokeDasharray: "6 5",
            },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#477ca8" },
          });
        }
      } else {
        beforeEndpoint.set(node.id, node.id);
      }
    });
    current.references.forEach((reference) => {
      if (
        !currentLayoutNodeIds.has(reference.sourceNodeId) ||
        !currentLayoutNodeIds.has(reference.targetNodeId) ||
        !nodeIsVisible(reference.sourceNodeId) ||
        !nodeIsVisible(reference.targetNodeId)
      ) return;
      if (replacementReferenceKeys.has(referenceKey(reference))) return;
      const source = beforeEndpoint.get(reference.sourceNodeId);
      const target = beforeEndpoint.get(reference.targetNodeId);
      if (source !== undefined && target !== undefined) {
        edges.push(makeReferenceEdge("removed", reference, source, target, "removed"));
      }
    });
    return { nodes, edges };
  }, [
    currentLayout,
    currentLayoutNodeIds,
    current.references,
    currentNodes,
    currentReferenceKeys,
    differences,
    labels,
    mode,
    previewNodeIds,
    replacementLayout,
    replacementLayoutNodeIds,
    replacement.references,
    replacementNodes,
    replacementReferenceKeys,
  ]);

  const identical = useMemo(
    () => compareWorkspaces(current, replacement, viewComparison).identical,
    [current, replacement, viewComparison],
  );

  return (
    <section
      className="restore-preview-canvas"
      aria-label={labels.title}
      data-testid="workspace-restore-preview"
    >
      <ReactFlow<RestoreFlowNode, Edge>
        key={selectedCanvasId}
        colorMode="light"
        deleteKeyCode={null}
        edges={graph.edges}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
        maxZoom={2.2}
        minZoom={0.2}
        nodes={graph.nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodeTypes={previewNodeTypes}
        panOnDrag={[0, 1]}
        proOptions={{ hideAttribution: true }}
        zoomOnDoubleClick={false}
      >
        <Background
          color="#d0d8d2"
          gap={24}
          id="restore-minor-grid"
          lineWidth={1}
          variant={BackgroundVariant.Lines}
        />
        <Background
          color="#aebbb2"
          gap={120}
          id="restore-major-grid"
          lineWidth={1.2}
          variant={BackgroundVariant.Lines}
        />
        <MiniMap
          className="graph-minimap"
          maskColor="rgb(245 247 245 / 72%)"
          nodeColor={(node) => {
            const status = (node.data as PreviewNodeData).status;
            if (status === "added") return "#bfe6cb";
            if (status === "removed") return "#efc1bc";
            if (status === "modified") return "#f2d6a3";
            if (status === "before-position") return "#c6d9e9";
            return "#d7e5dc";
          }}
          pannable
          zoomable
        />
        <Controls className="graph-controls" position="bottom-left" showInteractive={false} />
        <Panel className="restore-preview-panel" position="top-center">
          <div className="restore-preview-heading">
            <div>
              <strong>{labels.title}</strong>
              <small>{labels.source}</small>
            </div>
            <button
              aria-label={labels.cancel}
              className="restore-preview-close"
              onClick={onCancel}
              title={labels.cancel}
              type="button"
            >
              <X size={17} />
            </button>
          </div>
          <div className="restore-preview-mode" role="group" aria-label={labels.title}>
            {(["before", "overlay", "after"] as const).map((value) => (
              <button
                data-active={mode === value}
                key={value}
                onClick={() => setMode(value)}
                type="button"
              >
                {value === "before"
                  ? labels.before
                  : value === "after"
                    ? labels.after
                    : labels.overlay}
              </button>
            ))}
          </div>
          <label className="restore-preview-canvas-picker">
            <span>{labels.canvas}</span>
            <select
              aria-label={labels.canvas}
              data-testid="workspace-restore-canvas-select"
              onChange={(event) => setSelectedCanvasId(event.target.value)}
              value={selectedCanvasId}
            >
              {canvasOptions.map((canvas) => (
                <option key={canvas.id} value={canvas.id}>
                  {canvas.name}
                  {!canvas.before
                    ? ` (${labels.after})`
                    : !canvas.after
                      ? ` (${labels.before})`
                      : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="restore-preview-legend">
            <span data-status="added">{labels.legendAdded}</span>
            <span data-status="removed">{labels.legendRemoved}</span>
            <span data-status="modified">{labels.legendModified}</span>
            <span data-status="moved">{labels.legendMoved}</span>
            <span data-status="moved">{labels.legendResized}</span>
          </div>
          {identical && <p className="restore-preview-identical">{labels.identical}</p>}
          <div className="restore-preview-actions">
            <button className="secondary-button" onClick={onCancel} type="button">
              {labels.cancel}
            </button>
            <button
              className="primary-button"
              data-testid="workspace-restore-confirm"
              disabled={identical}
              onClick={onConfirm}
              type="button"
            >
              <ArchiveRestore size={15} />
              {labels.confirm}
              <ArrowRight size={14} />
            </button>
          </div>
        </Panel>
      </ReactFlow>
    </section>
  );
}
