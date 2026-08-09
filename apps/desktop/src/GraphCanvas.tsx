import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { GripVertical, Link2, Pencil, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type {
  InformationNode,
  NodeLayout,
  NodeReference,
} from "./workspaceStore";
import "@xyflow/react/dist/style.css";

interface InformationNodeData extends Record<string, unknown> {
  name: string | null;
  content: string | null;
  contentLabel: string;
  contentPlaceholder: string;
  editing: boolean;
  nameConflict: boolean;
  nameConflictLabel: string;
  nameLabel: string;
  namePlaceholder: string;
  unnamedLabel: string;
  sourceLabel: string;
  targetLabel: string;
  onCommit: (nodeId: string) => void;
  onContentChange: (nodeId: string, content: string) => void;
  onNameChange: (nodeId: string, name: string) => void;
}

type InformationFlowNode = Node<InformationNodeData, "information">;

interface GraphLabels {
  createNode: string;
  content: string;
  contentPlaceholder: string;
  editNode: string;
  empty: string;
  name: string;
  nameConflict: string;
  namePlaceholder: string;
  sourceHandle: string;
  targetHandle: string;
  unnamed: string;
}

interface GraphCanvasProps {
  nodes: InformationNode[];
  layout: NodeLayout[];
  references: NodeReference[];
  editingNodeId: string | null;
  nameConflictNodeIds: Set<string>;
  searchTerm: string;
  unnamedOnly: boolean;
  labels: GraphLabels;
  onCreateNode: (position: { x: number; y: number }) => void;
  onEditNode: (nodeId: string) => void;
  onLayoutChange: (layout: NodeLayout[]) => void;
  onNodeCommit: (nodeId: string) => void;
  onNodeContentChange: (nodeId: string, content: string) => void;
  onNodeNameChange: (nodeId: string, name: string) => void;
  onReferencesChange: (references: NodeReference[]) => void;
}

type ContextMenuState =
  | {
      kind: "pane";
      left: number;
      top: number;
      position: { x: number; y: number };
    }
  | {
      kind: "node";
      left: number;
      top: number;
      nodeId: string;
    };

function InformationNodeCard({ id, data, selected }: NodeProps<InformationFlowNode>) {
  const nodeRef = useRef<HTMLElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [nameValue, setNameValue] = useState(data.name ?? "");
  const [contentValue, setContentValue] = useState(data.content ?? "");

  useEffect(() => {
    if (data.editing) {
      return;
    }

    setNameValue(data.name ?? "");
    setContentValue(data.content ?? "");
  }, [data.content, data.editing, data.name]);

  useLayoutEffect(() => {
    if (!data.editing) {
      return;
    }

    nameInputRef.current?.focus({ preventScroll: true });
    const focusTimer = window.setTimeout(
      () => nameInputRef.current?.focus({ preventScroll: true }),
      0,
    );
    return () => window.clearTimeout(focusTimer);
  }, [data.editing]);

  const commitWhenLeavingNode = (event: ReactFocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof HTMLElement && event.currentTarget.contains(nextTarget)) {
      return;
    }

    window.setTimeout(() => {
      const nodeElement = nodeRef.current;
      if (nodeElement?.contains(document.activeElement)) {
        return;
      }
      data.onCommit(id);
    }, 0);
  };

  return (
    <article
      className="graph-node"
      data-editing={data.editing}
      data-selected={selected}
      onBlur={commitWhenLeavingNode}
      ref={nodeRef}
    >
      <Handle
        className="graph-handle graph-handle-target"
        position={Position.Left}
        title={data.targetLabel}
        type="target"
      />
      <header className="graph-node-header">
        {data.editing ? (
          <>
            <GripVertical aria-hidden="true" className="graph-node-drag-handle" size={15} />
            <input
              aria-invalid={data.nameConflict}
              aria-label={data.nameLabel}
              autoFocus
              className="nodrag nowheel graph-node-name-input"
              onChange={(event) => {
                setNameValue(event.target.value);
                data.onNameChange(id, event.target.value);
              }}
              placeholder={data.namePlaceholder}
              ref={nameInputRef}
              value={nameValue}
            />
          </>
        ) : (
          <>
            <Link2 aria-hidden="true" size={14} />
            <strong data-unnamed={data.name === null}>{data.name ?? data.unnamedLabel}</strong>
          </>
        )}
      </header>
      {data.editing ? (
        <div className="graph-node-editor">
          <textarea
            aria-label={data.contentLabel}
            className="nodrag nowheel graph-node-content-input"
            onChange={(event) => {
              setContentValue(event.target.value);
              data.onContentChange(id, event.target.value);
            }}
            placeholder={data.contentPlaceholder}
            rows={4}
            value={contentValue}
          />
          {data.nameConflict && (
            <span className="graph-node-error" role="alert">
              {data.nameConflictLabel}
            </span>
          )}
        </div>
      ) : (
        data.content !== null &&
        data.content.length > 0 && <p className="graph-node-content">{data.content}</p>
      )}
      <Handle
        className="graph-handle graph-handle-source"
        position={Position.Right}
        title={data.sourceLabel}
        type="source"
      />
    </article>
  );
}

const nodeTypes = { information: InformationNodeCard };

function edgeId(reference: NodeReference): string {
  return `reference:${reference.sourceNodeId}:${reference.targetNodeId}`;
}

export default function GraphCanvas({
  nodes,
  layout,
  references,
  editingNodeId,
  nameConflictNodeIds,
  searchTerm,
  unnamedOnly,
  labels,
  onCreateNode,
  onEditNode,
  onLayoutChange,
  onNodeCommit,
  onNodeContentChange,
  onNodeNameChange,
  onReferencesChange,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<InformationFlowNode, Edge> | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [flowNodes, setFlowNodes, applyNodeChanges] =
    useNodesState<InformationFlowNode>([]);
  const [flowEdges, setFlowEdges, applyEdgeChanges] = useEdgesState<Edge>([]);
  const normalizedSearch = searchTerm.trim().toLowerCase();

  const layoutByNode = useMemo(
    () => new Map(layout.map((item) => [item.nodeId, item])),
    [layout],
  );

  useEffect(() => {
    setFlowNodes((current) => {
      const currentById = new Map(current.map((node) => [node.id, node]));
      return nodes.map((node, index) => {
        const savedLayout = layoutByNode.get(node.id);
        const currentNode = currentById.get(node.id);
        return {
          id: node.id,
          type: "information",
          deletable: false,
          position: savedLayout
            ? { x: savedLayout.x, y: savedLayout.y }
            : { x: 80 + (index % 4) * 300, y: 80 + Math.floor(index / 4) * 210 },
          selected: currentNode?.selected ?? false,
          hidden:
            editingNodeId !== node.id &&
            ((unnamedOnly && node.name !== null) ||
              (normalizedSearch.length > 0 &&
                !(node.name ?? "").toLowerCase().includes(normalizedSearch))),
          data: {
            name: node.name,
            content: node.content,
            contentLabel: labels.content,
            contentPlaceholder: labels.contentPlaceholder,
            editing: editingNodeId === node.id,
            nameConflict: nameConflictNodeIds.has(node.id),
            nameConflictLabel: labels.nameConflict,
            nameLabel: labels.name,
            namePlaceholder: labels.namePlaceholder,
            unnamedLabel: labels.unnamed,
            sourceLabel: labels.sourceHandle,
            targetLabel: labels.targetHandle,
            onCommit: onNodeCommit,
            onContentChange: onNodeContentChange,
            onNameChange: onNodeNameChange,
          },
        };
      });
    });
  }, [
    editingNodeId,
    labels,
    layoutByNode,
    nameConflictNodeIds,
    nodes,
    normalizedSearch,
    onNodeCommit,
    onNodeContentChange,
    onNodeNameChange,
    setFlowNodes,
    unnamedOnly,
  ]);

  useEffect(() => {
    const visibleNodeIds = new Set(
      flowNodes.filter((node) => !node.hidden).map((node) => node.id),
    );
    setFlowEdges((current) => {
      const selectedEdgeIds = new Set(
        current.filter((edge) => edge.selected).map((edge) => edge.id),
      );
      return references.map((reference) => {
        const id = edgeId(reference);
        return {
          id,
          source: reference.sourceNodeId,
          target: reference.targetNodeId,
          selected: selectedEdgeIds.has(id),
          hidden:
            !visibleNodeIds.has(reference.sourceNodeId) ||
            !visibleNodeIds.has(reference.targetNodeId),
          animated: false,
          style: { strokeWidth: 1.8 },
        };
      });
    });
  }, [flowNodes, references, setFlowEdges]);

  useEffect(() => {
    if (contextMenu === null) {
      return;
    }

    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<InformationFlowNode>[]) => {
      applyNodeChanges(changes);
    },
    [applyNodeChanges],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      applyEdgeChanges(changes);
      const removed = new Set(
        changes.filter((change) => change.type === "remove").map((change) => change.id),
      );
      if (removed.size > 0) {
        onReferencesChange(
          references.filter((reference) => !removed.has(edgeId(reference))),
        );
      }
    },
    [applyEdgeChanges, onReferencesChange, references],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (connection.source === null || connection.target === null) {
        return;
      }

      const exists = references.some(
        (reference) =>
          reference.sourceNodeId === connection.source &&
          reference.targetNodeId === connection.target,
      );
      if (!exists) {
        onReferencesChange([
          ...references,
          {
            sourceNodeId: connection.source,
            targetNodeId: connection.target,
          },
        ]);
      }
    },
    [onReferencesChange, references],
  );

  const handleNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: InformationFlowNode) => {
      const nextLayout = layout.some((item) => item.nodeId === node.id)
        ? layout.map((item) =>
            item.nodeId === node.id
              ? { ...item, x: node.position.x, y: node.position.y }
              : item,
          )
        : [...layout, { nodeId: node.id, x: node.position.x, y: node.position.y }];
      onLayoutChange(nextLayout);
    },
    [layout, onLayoutChange],
  );

  const positionContextMenu = useCallback((clientX: number, clientY: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) {
      return { left: 0, top: 0 };
    }

    return {
      left: Math.min(clientX - bounds.left, Math.max(8, bounds.width - 190)),
      top: Math.min(clientY - bounds.top, Math.max(8, bounds.height - 70)),
    };
  }, []);

  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent<Element, MouseEvent>) => {
      event.preventDefault();
      if (flowInstance === null) {
        return;
      }
      const menuPosition = positionContextMenu(event.clientX, event.clientY);
      setContextMenu({
        kind: "pane",
        ...menuPosition,
        position: flowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        }),
      });
    },
    [flowInstance, positionContextMenu],
  );

  const handleNodeContextMenu: NodeMouseHandler<InformationFlowNode> = useCallback(
    (event, node) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        kind: "node",
        ...positionContextMenu(event.clientX, event.clientY),
        nodeId: node.id,
      });
    },
    [positionContextMenu],
  );

  const createAtCenter = useCallback(() => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (bounds && flowInstance) {
      onCreateNode(
        flowInstance.screenToFlowPosition({
          x: bounds.left + bounds.width / 2,
          y: bounds.top + bounds.height / 2,
        }),
      );
    }
  }, [flowInstance, onCreateNode]);

  const visibleNodeCount = flowNodes.filter((node) => !node.hidden).length;

  return (
    <div
      className="graph-canvas"
      onContextMenu={(event) => event.preventDefault()}
      ref={containerRef}
    >
      <ReactFlow<InformationFlowNode, Edge>
        colorMode="light"
        defaultEdgeOptions={{
          style: { stroke: "#7a8c82", strokeWidth: 1.8 },
        }}
        deleteKeyCode={["Backspace", "Delete"]}
        edges={flowEdges}
        edgesReconnectable={false}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
        maxZoom={2.2}
        minZoom={0.25}
        nodeTypes={nodeTypes}
        nodes={flowNodes}
        onConnect={handleConnect}
        onEdgesChange={handleEdgesChange}
        onInit={setFlowInstance}
        onNodeContextMenu={handleNodeContextMenu}
        onNodeDoubleClick={(_event, node) => onEditNode(node.id)}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={handleNodesChange}
        onPaneClick={() => setContextMenu(null)}
        onPaneContextMenu={handlePaneContextMenu}
        panOnDrag={[0, 1]}
        proOptions={{ hideAttribution: true }}
        selectNodesOnDrag={false}
        selectionOnDrag
        zoomOnDoubleClick={false}
      >
        <Background
          color="#d0d8d2"
          gap={24}
          id="minor-grid"
          lineWidth={1}
          variant={BackgroundVariant.Lines}
        />
        <Background
          color="#aebbb2"
          gap={120}
          id="major-grid"
          lineWidth={1.2}
          variant={BackgroundVariant.Lines}
        />
        <MiniMap
          className="graph-minimap"
          maskColor="rgb(245 247 245 / 72%)"
          nodeColor="#d7e5dc"
          nodeStrokeColor="#2e7152"
          pannable
          zoomable
        />
        <Controls className="graph-controls" position="bottom-left" showInteractive={false} />
        <Panel position="top-right">
          <button
            aria-label={labels.createNode}
            className="canvas-icon-button"
            onClick={createAtCenter}
            title={labels.createNode}
            type="button"
          >
            <Plus size={18} />
          </button>
        </Panel>
      </ReactFlow>

      {visibleNodeCount === 0 && (
        <div className="graph-empty" aria-live="polite">
          <span>{labels.empty}</span>
        </div>
      )}

      {contextMenu !== null && (
        <div
          className="graph-context-menu"
          onPointerDown={(event) => event.stopPropagation()}
          style={{ left: contextMenu.left, top: contextMenu.top }}
        >
          {contextMenu.kind === "pane" ? (
            <button
              onClick={() => {
                onCreateNode(contextMenu.position);
                setContextMenu(null);
              }}
              type="button"
            >
              <Plus size={16} />
              <span>{labels.createNode}</span>
            </button>
          ) : (
            <button
              onClick={() => {
                onEditNode(contextMenu.nodeId);
                setContextMenu(null);
              }}
              type="button"
            >
              <Pencil size={16} />
              <span>{labels.editNode}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
