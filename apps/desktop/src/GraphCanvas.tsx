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
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import {
  Filter,
  GripVertical,
  Link2,
  Pencil,
  Plus,
  Redo2,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";
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
  CanvasViewport,
  InformationNode,
  NodeLayout,
  NodeReference,
} from "./workspaceStore";
import { updateNodeLayoutPositions } from "./workspaceStore";
import {
  appendNodeReference,
  availableReferenceTargets,
  referenceSearchCommand,
  referenceTargetCreationName,
  shouldCreateMissingReferenceTarget,
} from "./referenceSearch";
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
  referencedTargets: Array<{ filterActive: boolean; id: string; label: string }>;
  referencesLabel: string;
  unnamedLabel: string;
  filterActive: boolean;
  filterByNodeLabel: string;
  removeNodeFilterLabel: string;
  sourceLabel: string;
  targetLabel: string;
  onCommit: (nodeId: string) => void;
  onContentChange: (nodeId: string, content: string) => void;
  onNameChange: (nodeId: string, name: string) => boolean;
  onToggleReferenceFilter: (nodeId: string) => void;
}

type InformationFlowNode = Node<InformationNodeData, "information">;

interface GraphLabels {
  cancel: string;
  confirmDeleteNode: (count: number) => string;
  createNode: string;
  deleteNode: string;
  deleteNodeBody: (names: string[]) => string;
  deleteNodeTitle: (count: number) => string;
  content: string;
  contentPlaceholder: string;
  editNode: string;
  empty: string;
  filterByNode: string;
  name: string;
  nameConflict: string;
  namePlaceholder: string;
  noContent: string;
  references: string;
  referenceSearchEmpty: string;
  referenceSearchCreate: (name: string) => string;
  referenceSearchCreateHint: string;
  referenceSearchHint: string;
  referenceSearchLabel: string;
  referenceSearchPlaceholder: string;
  redo: string;
  removeNodeFilter: string;
  sourceHandle: string;
  targetHandle: string;
  undo: string;
  unnamed: string;
}

interface GraphCanvasProps {
  nodes: InformationNode[];
  layout: NodeLayout[];
  references: NodeReference[];
  viewport: CanvasViewport | null;
  editingNodeId: string | null;
  canRedo: boolean;
  canUndo: boolean;
  historyBlocked: boolean;
  nameConflictNodeIds: Set<string>;
  referenceFilterNodeIds: string[];
  searchTerm: string;
  unnamedOnly: boolean;
  labels: GraphLabels;
  onCreateNode: (position: { x: number; y: number }) => void;
  onCreateReferencedNode: (
    sourceNodeId: string,
    name: string,
    position: { x: number; y: number },
  ) => string | null;
  onDeleteNodes: (nodeIds: string[]) => void;
  onEditNode: (nodeId: string) => void;
  onLayoutChange: (layout: NodeLayout[]) => void;
  onNodeCommit: (nodeId: string) => void;
  onNodeContentChange: (nodeId: string, content: string) => void;
  onNodeBringToFront: (nodeId: string) => void;
  onNodeNameChange: (nodeId: string, name: string) => boolean;
  onReferencesChange: (references: NodeReference[]) => void;
  onRedo: () => void;
  onToggleReferenceFilter: (nodeId: string) => void;
  onUndo: () => void;
  onViewportChange: (viewport: CanvasViewport) => void;
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

interface ReferenceSearchState {
  activeIndex: number;
  dropPosition: { x: number; y: number };
  left: number;
  query: string;
  selectedTargetNodeIds: string[];
  sourceNodeId: string;
  top: number;
}

function InformationNodeCard({ id, data, selected }: NodeProps<InformationFlowNode>) {
  const nodeRef = useRef<HTMLElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [nameValue, setNameValue] = useState(data.name ?? "");
  const [contentValue, setContentValue] = useState(data.content ?? "");
  const [draftNameConflict, setDraftNameConflict] = useState(false);

  useEffect(() => {
    if (data.editing) {
      return;
    }

    setNameValue(data.name ?? "");
    setContentValue(data.content ?? "");
    setDraftNameConflict(false);
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
      if (draftNameConflict) {
        return;
      }
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
              aria-invalid={data.nameConflict || draftNameConflict}
              aria-label={data.nameLabel}
              autoFocus
              className="nodrag nowheel graph-node-name-input"
              onChange={(event) => {
                setNameValue(event.target.value);
                setDraftNameConflict(!data.onNameChange(id, event.target.value));
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
        <button
          aria-label={data.filterActive ? data.removeNodeFilterLabel : data.filterByNodeLabel}
          aria-pressed={data.filterActive}
          className="nodrag nowheel graph-node-filter-button"
          data-active={data.filterActive}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggleReferenceFilter(id);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          title={data.filterActive ? data.removeNodeFilterLabel : data.filterByNodeLabel}
          type="button"
        >
          <Filter aria-hidden="true" size={13} />
        </button>
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
          {(data.nameConflict || draftNameConflict) && (
            <span className="graph-node-error" role="alert">
              {data.nameConflictLabel}
            </span>
          )}
        </div>
      ) : (
        data.content !== null &&
        data.content.length > 0 && <p className="graph-node-content">{data.content}</p>
      )}
      {data.referencedTargets.length > 0 && (
        <section aria-label={data.referencesLabel} className="graph-node-references">
          <span className="graph-node-references-label">{data.referencesLabel}</span>
          <div className="graph-node-reference-list">
            {data.referencedTargets.map((target) => (
              <button
                aria-pressed={target.filterActive}
                className="nodrag nowheel graph-node-reference-chip"
                data-active={target.filterActive}
                key={target.id}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onToggleReferenceFilter(target.id);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title={target.filterActive ? data.removeNodeFilterLabel : data.filterByNodeLabel}
                type="button"
              >
                <Link2 aria-hidden="true" size={11} />
                <span>{target.label}</span>
              </button>
            ))}
          </div>
        </section>
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
const defaultCanvasViewport: Viewport = { x: 0, y: 0, zoom: 1 };

function isTextEntryTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function canvasViewportsEqual(
  left: CanvasViewport | null,
  right: CanvasViewport | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.x === right.x &&
      left.y === right.y &&
      left.zoom === right.zoom)
  );
}

function edgeId(reference: NodeReference): string {
  return `reference:${reference.sourceNodeId}:${reference.targetNodeId}`;
}

function compactNodeContent(content: string | null, maxLength = 32): string {
  const compacted = (content ?? "").replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, maxLength - 1)}…`;
}

function referencedNodeLabel(
  node: InformationNode,
  unnamedLabel: string,
  noContentLabel: string,
): string {
  if (node.name !== null) {
    return node.name;
  }

  return `${unnamedLabel} · ${compactNodeContent(node.content) || noContentLabel}`;
}

export default function GraphCanvas({
  nodes,
  layout,
  references,
  viewport,
  editingNodeId,
  canRedo,
  canUndo,
  historyBlocked,
  nameConflictNodeIds,
  referenceFilterNodeIds,
  searchTerm,
  unnamedOnly,
  labels,
  onCreateNode,
  onCreateReferencedNode,
  onDeleteNodes,
  onEditNode,
  onLayoutChange,
  onNodeCommit,
  onNodeContentChange,
  onNodeBringToFront,
  onNodeNameChange,
  onReferencesChange,
  onRedo,
  onToggleReferenceFilter,
  onUndo,
  onViewportChange,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const referenceSearchInputRef = useRef<HTMLInputElement>(null);
  const referenceSearchPopoverRef = useRef<HTMLDivElement>(null);
  const shiftConnectionSourceRef = useRef<string | null>(null);
  const referencesRef = useRef(references);
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<InformationFlowNode, Edge> | null>(null);
  const lastWorkspaceViewportRef = useRef<CanvasViewport | null>(viewport);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [pendingDeletionNodeIds, setPendingDeletionNodeIds] = useState<string[]>([]);
  const [referenceSearch, setReferenceSearch] =
    useState<ReferenceSearchState | null>(null);
  const [flowNodes, setFlowNodes, applyNodeChanges] =
    useNodesState<InformationFlowNode>([]);
  const [flowEdges, setFlowEdges, applyEdgeChanges] = useEdgesState<Edge>([]);
  const normalizedSearch = searchTerm.trim().toLowerCase();

  useEffect(() => {
    referencesRef.current = references;
  }, [references]);

  useLayoutEffect(() => {
    if (referenceSearch === null) {
      return;
    }
    referenceSearchInputRef.current?.focus({ preventScroll: true });
  }, [referenceSearch?.selectedTargetNodeIds.length, referenceSearch?.sourceNodeId]);

  useEffect(() => {
    if (
      referenceSearch !== null &&
      !nodes.some((node) => node.id === referenceSearch.sourceNodeId)
    ) {
      setReferenceSearch(null);
    }
  }, [nodes, referenceSearch]);

  useEffect(() => {
    if (referenceSearch === null) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof globalThis.Node &&
        !referenceSearchPopoverRef.current?.contains(event.target)
      ) {
        setReferenceSearch(null);
      }
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [referenceSearch]);

  useEffect(() => {
    if (flowInstance === null) {
      return;
    }

    const previousViewport = lastWorkspaceViewportRef.current;
    if (canvasViewportsEqual(previousViewport, viewport)) {
      return;
    }
    lastWorkspaceViewportRef.current = viewport;

    if (viewport === null) {
      const fitTimer = window.setTimeout(() => {
        void flowInstance.fitView({ maxZoom: 1, padding: 0.25 });
      }, 0);
      return () => window.clearTimeout(fitTimer);
    }

    const currentViewport = flowInstance.getViewport();
    if (!canvasViewportsEqual(currentViewport, viewport)) {
      void flowInstance.setViewport(viewport, { duration: 0 });
    }
  }, [flowInstance, viewport]);

  const layoutByNode = useMemo(
    () => new Map(layout.map((item) => [item.nodeId, item])),
    [layout],
  );
  const stackOrderByNode = useMemo(
    () => new Map(layout.map((item, index) => [item.nodeId, index])),
    [layout],
  );

  const referenceFilterNodeIdSet = useMemo(
    () => new Set(referenceFilterNodeIds),
    [referenceFilterNodeIds],
  );

  const referencedNodesBySource = useMemo(() => {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const result = new Map<string, InformationNode[]>();
    for (const reference of references) {
      const targetNode = nodesById.get(reference.targetNodeId);
      if (targetNode === undefined) {
        continue;
      }
      const referencedNodes = result.get(reference.sourceNodeId) ?? [];
      referencedNodes.push(targetNode);
      result.set(reference.sourceNodeId, referencedNodes);
    }
    return result;
  }, [nodes, references]);

  const referenceSearchCandidates = useMemo(() => {
    if (referenceSearch === null) {
      return [];
    }
    return availableReferenceTargets(
      nodes,
      references,
      referenceSearch.sourceNodeId,
      referenceSearch.selectedTargetNodeIds,
      referenceSearch.query,
    ).sort((left, right) =>
      referencedNodeLabel(left, labels.unnamed, labels.noContent).localeCompare(
        referencedNodeLabel(right, labels.unnamed, labels.noContent),
      ),
    );
  }, [labels.noContent, labels.unnamed, nodes, referenceSearch, references]);

  const referenceSearchCreationName = useMemo(() => {
    if (referenceSearch === null || referenceSearchCandidates.length > 0) {
      return null;
    }
    return referenceTargetCreationName(nodes, referenceSearch.query);
  }, [nodes, referenceSearch, referenceSearchCandidates.length]);

  useEffect(() => {
    setFlowNodes((current) => {
      const currentById = new Map(current.map((node) => [node.id, node]));
      return nodes.map((node, index) => {
        const savedLayout = layoutByNode.get(node.id);
        const currentNode = currentById.get(node.id);
        const referencedNodes = referencedNodesBySource.get(node.id) ?? [];
        const referencedTargetIds = new Set(referencedNodes.map((target) => target.id));
        return {
          id: node.id,
          type: "information",
          deletable: false,
          position: savedLayout
            ? { x: savedLayout.x, y: savedLayout.y }
            : { x: 80 + (index % 4) * 300, y: 80 + Math.floor(index / 4) * 210 },
          selected: currentNode?.selected ?? false,
          zIndex: stackOrderByNode.get(node.id) ?? index,
          hidden:
            editingNodeId !== node.id &&
            !referenceFilterNodeIdSet.has(node.id) &&
            ((unnamedOnly && node.name !== null) ||
              (normalizedSearch.length > 0 &&
                !(node.name ?? "").toLowerCase().includes(normalizedSearch)) ||
              referenceFilterNodeIds.some(
                (targetNodeId) => !referencedTargetIds.has(targetNodeId),
              )),
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
            referencedTargets: referencedNodes
              .map((target) => ({
                filterActive: referenceFilterNodeIdSet.has(target.id),
                id: target.id,
                label: referencedNodeLabel(target, labels.unnamed, labels.noContent),
              }))
              .sort((left, right) => left.label.localeCompare(right.label)),
            referencesLabel: labels.references,
            unnamedLabel: labels.unnamed,
            filterActive: referenceFilterNodeIdSet.has(node.id),
            filterByNodeLabel: labels.filterByNode,
            removeNodeFilterLabel: labels.removeNodeFilter,
            sourceLabel: labels.sourceHandle,
            targetLabel: labels.targetHandle,
            onCommit: onNodeCommit,
            onContentChange: onNodeContentChange,
            onNameChange: onNodeNameChange,
            onToggleReferenceFilter,
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
    onToggleReferenceFilter,
    referenceFilterNodeIds,
    referenceFilterNodeIdSet,
    referencedNodesBySource,
    setFlowNodes,
    stackOrderByNode,
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

  useEffect(() => {
    if (pendingDeletionNodeIds.length === 0) {
      return;
    }

    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPendingDeletionNodeIds([]);
      }
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [pendingDeletionNodeIds.length]);

  useEffect(() => {
    const handleCanvasShortcut = (event: KeyboardEvent) => {
      if (isTextEntryTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      const modifierPressed = event.ctrlKey || event.metaKey;
      if (modifierPressed && key === "a") {
        event.preventDefault();
        setFlowNodes((current) =>
          current.map((node) => ({
            ...node,
            selected: !node.hidden,
          })),
        );
        return;
      }

      if (modifierPressed && key === "z") {
        if (historyBlocked) {
          return;
        }
        event.preventDefault();
        if (event.shiftKey) {
          onRedo();
        } else {
          onUndo();
        }
        return;
      }

      if (modifierPressed && key === "y") {
        if (historyBlocked) {
          return;
        }
        event.preventDefault();
        onRedo();
        return;
      }

      if (key === "delete" || key === "backspace") {
        const selectedNodeIds = flowNodes
          .filter((node) => node.selected && !node.hidden)
          .map((node) => node.id);
        if (selectedNodeIds.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          setPendingDeletionNodeIds(selectedNodeIds);
        }
      }
    };

    window.addEventListener("keydown", handleCanvasShortcut, true);
    return () => window.removeEventListener("keydown", handleCanvasShortcut, true);
  }, [flowNodes, historyBlocked, onRedo, onUndo, setFlowNodes]);

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

      const currentReferences = referencesRef.current;
      const nextReferences = appendNodeReference(
        currentReferences,
        connection.source,
        connection.target,
      );
      if (nextReferences !== currentReferences) {
        referencesRef.current = nextReferences;
        onReferencesChange(nextReferences);
      }
    },
    [onReferencesChange],
  );

  const appendReference = useCallback(
    (sourceNodeId: string, targetNodeId: string) => {
      const currentReferences = referencesRef.current;
      const nextReferences = appendNodeReference(
        currentReferences,
        sourceNodeId,
        targetNodeId,
      );
      if (nextReferences !== currentReferences) {
        referencesRef.current = nextReferences;
        onReferencesChange(nextReferences);
      }
    },
    [onReferencesChange],
  );

  const chooseReferenceSearchTarget = useCallback(
    (targetNodeId: string, closeAfterSelection: boolean) => {
      if (referenceSearch === null) {
        return;
      }
      appendReference(referenceSearch.sourceNodeId, targetNodeId);
      if (closeAfterSelection) {
        setReferenceSearch(null);
        return;
      }
      setReferenceSearch({
        ...referenceSearch,
        activeIndex: 0,
        query: "",
        selectedTargetNodeIds: [
          ...referenceSearch.selectedTargetNodeIds,
          targetNodeId,
        ],
      });
    },
    [appendReference, referenceSearch],
  );

  const createReferenceSearchTarget = useCallback(
    () => {
      if (referenceSearch === null || referenceSearchCreationName === null) {
        return;
      }
      const nodeId = onCreateReferencedNode(
        referenceSearch.sourceNodeId,
        referenceSearchCreationName,
        referenceSearch.dropPosition,
      );
      if (nodeId === null) {
        return;
      }
      referencesRef.current = appendNodeReference(
        referencesRef.current,
        referenceSearch.sourceNodeId,
        nodeId,
      );
      setReferenceSearch(null);
    },
    [onCreateReferencedNode, referenceSearch, referenceSearchCreationName],
  );

  const handleConnectEnd = useCallback(
    (
      event: MouseEvent | TouchEvent,
      connectionState: FinalConnectionState,
    ) => {
      const sourceNodeId = shiftConnectionSourceRef.current;
      shiftConnectionSourceRef.current = null;
      const targetElement = event.target instanceof Element ? event.target : null;
      const droppedOnEmptyCanvas =
        targetElement !== null &&
        (targetElement.classList.contains("react-flow__pane") ||
          targetElement.closest(".react-flow__background") !== null);
      if (
        sourceNodeId === null ||
        connectionState.isValid === true ||
        connectionState.toNode !== null ||
        !droppedOnEmptyCanvas ||
        !(event instanceof MouseEvent)
      ) {
        return;
      }

      const bounds = containerRef.current?.getBoundingClientRect();
      if (bounds === undefined || flowInstance === null) {
        return;
      }
      const popoverWidth = 300;
      const popoverHeight = 330;
      setReferenceSearch({
        activeIndex: 0,
        dropPosition: flowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        }),
        left: Math.min(
          Math.max(8, event.clientX - bounds.left),
          Math.max(8, bounds.width - popoverWidth - 8),
        ),
        query: "",
        selectedTargetNodeIds: [],
        sourceNodeId,
        top: Math.min(
          Math.max(8, event.clientY - bounds.top),
          Math.max(8, bounds.height - popoverHeight - 8),
        ),
      });
    },
    [flowInstance],
  );

  const handleNodeDragStop = useCallback(
    (
      _event: MouseEvent | TouchEvent,
      node: InformationFlowNode,
      draggedNodes: InformationFlowNode[],
    ) => {
      const movedNodes = draggedNodes.length > 0 ? draggedNodes : [node];
      const nextLayout = updateNodeLayoutPositions(
        layout,
        movedNodes.map((movedNode) => ({
          nodeId: movedNode.id,
          x: movedNode.position.x,
          y: movedNode.position.y,
        })),
      );
      if (nextLayout !== layout) {
        onLayoutChange(nextLayout);
      }
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
      onNodeBringToFront(node.id);
      setContextMenu({
        kind: "node",
        ...positionContextMenu(event.clientX, event.clientY),
        nodeId: node.id,
      });
    },
    [onNodeBringToFront, positionContextMenu],
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
  const pendingDeletionNodes = pendingDeletionNodeIds
    .map((nodeId) => nodes.find((node) => node.id === nodeId))
    .filter((node): node is InformationNode => node !== undefined);

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
        elevateNodesOnSelect={false}
        defaultViewport={viewport ?? defaultCanvasViewport}
        fitView={viewport === null}
        fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
        maxZoom={2.2}
        minZoom={0.25}
        nodeTypes={nodeTypes}
        nodes={flowNodes}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        onConnectStart={(event, params) => {
          shiftConnectionSourceRef.current =
            event instanceof MouseEvent &&
            event.shiftKey &&
            params.handleType === "source"
              ? params.nodeId
              : null;
        }}
        onEdgesChange={handleEdgesChange}
        onInit={setFlowInstance}
        onNodeContextMenu={handleNodeContextMenu}
        onNodeClick={(_event, node) => onNodeBringToFront(node.id)}
        onNodeDoubleClick={(_event, node) => onEditNode(node.id)}
        onNodeDragStart={(_event, node) => onNodeBringToFront(node.id)}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={handleNodesChange}
        onMoveEnd={(_event, nextViewport) => onViewportChange(nextViewport)}
        onPaneClick={() => setContextMenu(null)}
        onPaneContextMenu={handlePaneContextMenu}
        panOnDrag={[0, 1]}
        proOptions={{ hideAttribution: true }}
        multiSelectionKeyCode={["Control", "Shift"]}
        zoomOnDoubleClick={false}
        zIndexMode="manual"
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
        <Panel className="canvas-action-panel" position="top-right">
          <button
            aria-label={labels.undo}
            className="canvas-icon-button"
            disabled={historyBlocked || !canUndo}
            onClick={onUndo}
            title={labels.undo}
            type="button"
          >
            <Undo2 size={18} />
          </button>
          <button
            aria-label={labels.redo}
            className="canvas-icon-button"
            disabled={historyBlocked || !canRedo}
            onClick={onRedo}
            title={labels.redo}
            type="button"
          >
            <Redo2 size={18} />
          </button>
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

      {referenceSearch !== null && (
        <div
          className="reference-search-popover"
          onPointerDown={(event) => event.stopPropagation()}
          ref={referenceSearchPopoverRef}
          style={{ left: referenceSearch.left, top: referenceSearch.top }}
        >
          <label className="reference-search-input-shell">
            <Search aria-hidden="true" size={15} />
            <input
              aria-activedescendant={
                referenceSearchCandidates[referenceSearch.activeIndex] === undefined
                  ? referenceSearchCreationName === null
                    ? undefined
                    : "reference-search-create-option"
                  : `reference-search-option-${referenceSearchCandidates[referenceSearch.activeIndex].id}`
              }
              aria-autocomplete="list"
              aria-controls="reference-search-results"
              aria-expanded="true"
              aria-label={labels.referenceSearchLabel}
              onChange={(event) =>
                setReferenceSearch((current) =>
                  current === null
                    ? null
                    : { ...current, activeIndex: 0, query: event.target.value },
                )
              }
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  return;
                }
                const command = referenceSearchCommand(event.key);
                if (command === null) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                if (command === "close") {
                  setReferenceSearch(null);
                  return;
                }
                if (command === "move-next" || command === "move-previous") {
                  if (referenceSearchCandidates.length === 0) {
                    return;
                  }
                  const offset = command === "move-next" ? 1 : -1;
                  setReferenceSearch((current) =>
                    current === null
                      ? null
                      : {
                          ...current,
                          activeIndex:
                            (current.activeIndex +
                              offset +
                              referenceSearchCandidates.length) %
                            referenceSearchCandidates.length,
                        },
                  );
                  return;
                }
                const candidate =
                  referenceSearchCandidates[referenceSearch.activeIndex];
                if (candidate !== undefined) {
                  chooseReferenceSearchTarget(
                    candidate.id,
                    command === "select-and-close",
                  );
                } else if (referenceSearchCreationName !== null) {
                  if (shouldCreateMissingReferenceTarget(command)) {
                    createReferenceSearchTarget();
                  }
                } else if (command === "select-and-close") {
                  setReferenceSearch(null);
                }
              }}
              placeholder={labels.referenceSearchPlaceholder}
              ref={referenceSearchInputRef}
              role="combobox"
              value={referenceSearch.query}
            />
          </label>
          <div
            aria-label={labels.referenceSearchLabel}
            className="reference-search-results"
            id="reference-search-results"
            role="listbox"
          >
            {referenceSearchCandidates.length === 0 ? (
              referenceSearchCreationName === null ? (
                <p className="reference-search-empty">{labels.referenceSearchEmpty}</p>
              ) : (
                <button
                  aria-selected="true"
                  className="reference-search-option reference-search-create-option"
                  data-active="true"
                  id="reference-search-create-option"
                  onClick={createReferenceSearchTarget}
                  role="option"
                  type="button"
                >
                  <Plus aria-hidden="true" size={15} />
                  <strong>
                    {labels.referenceSearchCreate(referenceSearchCreationName)}
                  </strong>
                </button>
              )
            ) : (
              referenceSearchCandidates.map((node, index) => (
                <button
                  aria-selected={index === referenceSearch.activeIndex}
                  className="reference-search-option"
                  data-active={index === referenceSearch.activeIndex}
                  id={`reference-search-option-${node.id}`}
                  key={node.id}
                  onClick={() => chooseReferenceSearchTarget(node.id, false)}
                  onMouseEnter={() =>
                    setReferenceSearch((current) =>
                      current === null ? null : { ...current, activeIndex: index },
                    )
                  }
                  role="option"
                  type="button"
                >
                  <strong>{node.name ?? labels.unnamed}</strong>
                  {node.name === null && (
                    <span>{compactNodeContent(node.content) || labels.noContent}</span>
                  )}
                </button>
              ))
            )}
          </div>
          <p className="reference-search-hint">
            {referenceSearchCreationName === null
              ? labels.referenceSearchHint
              : labels.referenceSearchCreateHint}
          </p>
        </div>
      )}

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
            <>
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
              <button
                className="danger-menu-item"
                onClick={() => {
                  setPendingDeletionNodeIds([contextMenu.nodeId]);
                  setContextMenu(null);
                }}
                type="button"
              >
                <Trash2 size={16} />
                <span>{labels.deleteNode}</span>
              </button>
            </>
          )}
        </div>
      )}

      {pendingDeletionNodes.length > 0 && (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="delete-node-dialog-title"
            aria-modal="true"
            className="confirmation-dialog"
            role="dialog"
          >
            <h2 id="delete-node-dialog-title">
              {labels.deleteNodeTitle(pendingDeletionNodes.length)}
            </h2>
            <p>
              {labels.deleteNodeBody(
                pendingDeletionNodes.map((node) =>
                  referencedNodeLabel(node, labels.unnamed, labels.noContent),
                ),
              )}
            </p>
            <div className="confirmation-dialog-actions">
              <button
                className="secondary-button"
                onClick={() => setPendingDeletionNodeIds([])}
                type="button"
              >
                {labels.cancel}
              </button>
              <button
                className="danger-button"
                onClick={() => {
                  onDeleteNodes(pendingDeletionNodes.map((node) => node.id));
                  setPendingDeletionNodeIds([]);
                }}
                type="button"
              >
                <Trash2 size={15} />
                {labels.confirmDeleteNode(pendingDeletionNodes.length)}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
