import {
  Background,
  BackgroundVariant,
  Controls,
  getViewportForBounds,
  Handle,
  MiniMap,
  NodeResizer,
  Panel,
  Position,
  ReactFlow,
  ViewportPortal,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
  useNodesState,
  useKeyPress,
} from "@xyflow/react";
import {
  Copy,
  Filter,
  GripVertical,
  Keyboard,
  LayoutGrid,
  Link2,
  Maximize2,
  Pencil,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  X,
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
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  CanvasViewport,
  InformationNode,
  NodeLayout,
  NodeReference,
} from "./workspaceStore";
import {
  moveNodeLayoutToFront,
  maximumManualNodeDimension,
  minimumManualNodeHeight,
  minimumManualNodeWidth,
  normalizeNodeName,
  updateNodeLayoutDimensions,
  updateNodeLayoutSizeOverrides,
  updateNodeLayoutPositions,
} from "./workspaceStore";
import {
  avoidCanvasNodeOverlaps,
  type CanvasRectangle,
} from "./canvasOverlap";
import type {
  SmartArrangementMode,
  SmartArrangementSizeMode,
} from "./canvasAutoLayout";
import {
  appendExistingNodeReference,
  appendNodeReference,
  availableReferenceTargets,
  referenceSearchCommand,
  referenceTargetCreationName,
  shouldCreateMissingReferenceTarget,
} from "./referenceSearch";
import {
  NodeContentHost,
  canvasContentPreview,
  contentContainsSensitive,
  type ContentEnhancementLabels,
} from "./contentProcessor";
import {
  codePreviewLanguageFromProcessorId,
  type CodePreviewLanguage,
} from "./codePreviewLanguages";
import { TotpSecondClockProvider } from "./totpContent";
import type { CanvasOperationItem } from "./canvasOperations";
import {
  CONTENT_MARKER_NOTE_MAX_LENGTH,
  contentMarkerRegistry,
  type ContentMarkerSelection,
} from "./contentMarker";
import { buildCanvasReferencePresentation } from "./canvasReferencePresentation";
import {
  buildBatchedReferencePaths,
  buildReferenceCurves,
  findReferenceCurveAtPoint,
  partitionReferencesByMovingNodes,
  referenceCurveId,
  type ReferenceCurve,
} from "./batchedReferenceLayer";
import {
  canvasSelectionAutoPanDelta,
  canvasSelectionRectangle,
  nodesIntersectingCanvasSelection,
  selectedCanvasNodeBoundary,
  type CanvasSelectionPoint,
  type CanvasSelectionRectangle,
} from "./canvasSelection";
import {
  nodeEditorDraft,
  shouldCommitNodeEditor,
  updateNodeEditorContent,
  updateNodeEditorName,
} from "./nodeEditorState";
import "@xyflow/react/dist/style.css";

interface InformationNodeData extends Record<string, unknown> {
  name: string | null;
  content: string | null;
  contentProcessorId: string | null;
  codeSourceContainsSensitive: boolean;
  contentProcessorLabel: string;
  contentProcessorOptions: readonly ContentProcessorOption[];
  contentMarkerOptions: readonly ContentMarkerOption[];
  contentFullyRendered: boolean;
  contentTruncated: boolean;
  editMarkerLabel: (markerLabel: string) => string;
  markSelectionLabel: string;
  markerNoteLabel: string;
  markerNotePlaceholder: string;
  markerPayloadInvalidLabel: (markerLabel: string) => string;
  markerSelectionConflictLabel: string;
  manualHeight: boolean;
  manualSize: boolean;
  manualWidth: boolean;
  removeMarkerLabel: string;
  saveMarkerNoteLabel: string;
  fitNodeContentLabel: string;
  unsupportedContentProcessorLabel: (processorId: string) => string;
  contentLabel: string;
  contentPlaceholder: string;
  enhancementLabels: ContentEnhancementLabels;
  editing: boolean;
  interactive: boolean;
  nameConflict: boolean;
  nameConflictLabel: string;
  nameLabel: string;
  namePlaceholder: string;
  incomingReferenceCount: number;
  incomingReferencesLabel: string;
  referencedTargets: Array<{ filterActive: boolean; id: string; label: string }>;
  collapsedIncomingReferenceLabel: string | null;
  referencesLabel: string;
  unnamedLabel: string;
  filterActive: boolean;
  filterByNodeLabel: string;
  removeNodeFilterLabel: string;
  sourceLabel: string;
  targetLabel: string;
  onCommit: (nodeId: string) => void;
  onBrowseIncomingReferences: (
    nodeId: string,
    anchor: { bottom: number; left: number; top: number },
  ) => void;
  onContentChange: (nodeId: string, content: string) => void;
  onContentProcessorChange: (nodeId: string, processorId: string) => void;
  onCopyCodeSource: ((containsSensitive: boolean) => Promise<void>) | null;
  onCopyDerivedSecret: ((value: string) => Promise<void>) | null;
  onNameChange: (nodeId: string, name: string) => boolean;
  onFitNodeContent: (nodeId: string) => void;
  onResizeEnd: (
    nodeId: string,
    dimensions: { height: number; width: number; x: number; y: number },
  ) => void;
  onResizeStart: (nodeId: string) => void;
  onToggleReferenceFilter: (nodeId: string) => void;
}

interface ContentProcessorOption {
  id: string;
  label: string;
}

interface ContentMarkerOption {
  id: string;
  invalidPayloadLabel: string | null;
  label: string;
}

function contentMarkerAttributesWithNote(
  attributes: Readonly<Record<string, string>>,
  rawNote: string,
): Record<string, string> {
  const next = { ...attributes };
  const note = rawNote.trim();
  if (note.length === 0) {
    delete next.note;
  } else {
    next.note = note;
  }
  return next;
}

type InformationFlowNode = Node<InformationNodeData, "information">;

interface CanvasSelectionGesture {
  animationFrameId: number | null;
  autoPanDirection: string | null;
  autoPanStartedAt: number | null;
  currentClient: CanvasSelectionPoint;
  moved: boolean;
  pointerId: number;
  startClient: CanvasSelectionPoint;
  startFlow: CanvasSelectionPoint;
}

interface GraphLabels {
  analyzingNode: string;
  cancel: string;
  confirmDeleteNode: (count: number) => string;
  createNode: string;
  deleteNode: string;
  deleteNodeBody: (names: string[]) => string;
  deleteNodeTitle: (count: number) => string;
  content: string;
  contentPlaceholder: string;
  contentProcessor: string;
  codeCopy: string;
  codeLanguages: Record<CodePreviewLanguage, string>;
  unsupportedContentProcessor: (processorId: string) => string;
  copySecret: string;
  copyCodeFailed: string;
  copyCodeSuccess: string;
  copySecretFailed: string;
  copySecretSuccess: string;
  editMarker: (markerLabel: string) => string;
  markSelection: string;
  markerNote: string;
  markerNotePlaceholder: string;
  markerPayloadInvalid: (markerLabel: string) => string;
  markerSelectionConflict: string;
  removeMarker: string;
  saveMarkerNote: string;
  secretCopy: string;
  secretHide: string;
  secretLabel: string;
  secretMasked: string;
  secretReveal: string;
  totpCopy: string;
  totpGenerating: string;
  totpInvalid: string;
  totpMasked: string;
  totpRemaining: (seconds: number) => string;
  editNode: string;
  empty: string;
  noMatches: string;
  filterByNode: string;
  fitNodeContent: string;
  arrangeNodes: (count: number) => string;
  arrangementApply: string;
  arrangementDescription: (count: number) => string;
  arrangementFailed: string;
  arrangementMode: string;
  arrangementModes: Record<SmartArrangementMode, string>;
  arrangementSize: string;
  arrangementSizes: Record<SmartArrangementSizeMode, string>;
  arrangementTitle: string;
  incomingReferenceBrowserFilter: string;
  incomingReferenceBrowserNoMatches: string;
  incomingReferenceBrowserSearch: string;
  incomingReferenceBrowserShowing: (count: number, total: number) => string;
  incomingReferenceBrowserTitle: string;
  incomingReferenceFocus: (name: string) => string;
  incomingReferences: (count: number) => string;
  name: string;
  nameConflict: string;
  namePlaceholder: string;
  noContent: string;
  references: string;
  collapsedIncomingReferences: (count: number) => string;
  referenceSearchEmpty: string;
  referenceSearchCreate: (name: string) => string;
  referenceSearchCreateHint: string;
  referenceSearchHint: string;
  referenceSearchLabel: string;
  referenceSearchPlaceholder: string;
  redo: string;
  resetNodeSize: string;
  removeNodeFilter: string;
  sourceHandle: string;
  smartReference: string;
  smartReferenceMultiple: (count: number) => string;
  shortcuts: {
    items: readonly CanvasOperationItem[];
    open: string;
    title: string;
  };
  targetHandle: string;
  undo: string;
  unnamed: string;
}

interface GraphCanvasProps {
  analyzingNodeId: string | null;
  autoAvoidOverlaps: boolean;
  nodes: InformationNode[];
  layout: NodeLayout[];
  references: NodeReference[];
  contentProcessorByNodeId: Readonly<Record<string, string>>;
  contentProcessorOptions: readonly ContentProcessorOption[];
  contentMarkerOptions: readonly ContentMarkerOption[];
  viewport: CanvasViewport | null;
  editingNodeId: string | null;
  canRedo: boolean;
  canUndo: boolean;
  historyBlocked: boolean;
  nodeFiltersActive: boolean;
  nameConflictNodeIds: Set<string>;
  referenceFilterNodeIds: string[];
  filteredNodeIds: ReadonlySet<string>;
  unmatchedNodeOpacity: number;
  labels: GraphLabels;
  onAnalyzeNodes: (nodeIds: string[]) => void;
  onCreateNode: (position: { x: number; y: number }) => void;
  onCreateReferencedNode: (
    sourceNodeId: string,
    name: string,
    position: { x: number; y: number },
  ) => string | null;
  onCopySecret: ((text: string) => Promise<void>) | null;
  onClearNodeFilters: () => void;
  onDeleteNodes: (nodeIds: string[]) => void;
  onEditNode: (nodeId: string) => void;
  onLayoutChange: (layout: NodeLayout[]) => void;
  onNodeCommit: (nodeId: string) => void;
  onNodeContentChange: (nodeId: string, content: string) => void;
  onNodeContentProcessorChange: (nodeId: string, processorId: string) => void;
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
      nodeIds: string[];
    };

interface SmartArrangementState {
  busy: boolean;
  error: string | null;
  mode: SmartArrangementMode;
  nodeIds: string[];
  sizeMode: SmartArrangementSizeMode;
}

interface IncomingReferenceBrowserState {
  left: number;
  query: string;
  targetNodeId: string;
  top: number;
}

interface ReferenceSearchState {
  activeIndex: number;
  dropPosition: { x: number; y: number };
  left: number;
  query: string;
  selectedTargetNodeIds: string[];
  sourceNodeId: string;
  top: number;
}

export function InformationNodeCard({
  id,
  data,
  selected,
}: NodeProps<InformationFlowNode>) {
  const nodeRef = useRef<HTMLElement>(null);
  const nodeBodyRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const contentInputRef = useRef<HTMLTextAreaElement>(null);
  const contentMarkerNoteInputRef = useRef<HTMLInputElement>(null);
  const contentKeyboardSelectionRef = useRef(false);
  const processorSelectRef = useRef<HTMLSelectElement>(null);
  const processorFocusTransferRef = useRef(false);
  const [draft, setDraft] = useState(() => nodeEditorDraft(data.name, data.content));
  const [contentSelection, setContentSelection] =
    useState<ContentMarkerSelection | null>(null);
  const [contentMarkerNote, setContentMarkerNote] = useState("");
  const [contentMarkerError, setContentMarkerError] = useState<string | null>(null);
  const [bodyOverflowing, setBodyOverflowing] = useState(false);
  const [resizing, setResizing] = useState(false);
  const wasEditingRef = useRef(data.editing);

  useEffect(() => {
    if (data.editing) {
      return;
    }

    setDraft(nodeEditorDraft(data.name, data.content));
    setContentSelection(null);
    setContentMarkerNote("");
    setContentMarkerError(null);
  }, [data.content, data.editing, data.name]);

  useLayoutEffect(() => {
    if (data.editing && !wasEditingRef.current) {
      setDraft(nodeEditorDraft(data.name, data.content));
    }
    wasEditingRef.current = data.editing;
  }, [data.content, data.editing, data.name]);

  useLayoutEffect(() => {
    if (!data.editing) {
      return;
    }

    nameInputRef.current?.focus({ preventScroll: true });
    const focusTimer = window.setTimeout(() => {
      const nodeElement = nodeRef.current;
      if (nodeElement === null || !nodeElement.contains(document.activeElement)) {
        nameInputRef.current?.focus({ preventScroll: true });
      }
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [data.editing]);

  useLayoutEffect(() => {
    const body = nodeBodyRef.current;
    if (body === null) {
      return;
    }
    const update = () => {
      setBodyOverflowing(
        body.scrollHeight > body.clientHeight + 1 ||
          body.scrollWidth > body.clientWidth + 1,
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(body);
    return () => observer.disconnect();
  }, [data.content, data.editing, data.manualSize, data.referencedTargets.length]);

  const contentOverflowing = data.contentTruncated || bodyOverflowing;

  useLayoutEffect(() => {
    if (!data.editing || !processorFocusTransferRef.current) {
      return;
    }
    const processorSelect = processorSelectRef.current;
    processorSelect?.focus({ preventScroll: true });
  }, [data.contentProcessorId, data.editing]);

  useEffect(() => {
    if (!data.editing) {
      return;
    }
    const clearProcessorFocusTransfer = (event: PointerEvent) => {
      const nodeElement = nodeRef.current;
      if (event.target instanceof Node && !nodeElement?.contains(event.target)) {
        processorFocusTransferRef.current = false;
      }
    };
    document.addEventListener("pointerdown", clearProcessorFocusTransfer, true);
    return () =>
      document.removeEventListener("pointerdown", clearProcessorFocusTransfer, true);
  }, [data.editing]);

  const commitWhenLeavingNode = (event: ReactFocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof HTMLElement && event.currentTarget.contains(nextTarget)) {
      return;
    }
    const blurredNodeElement = event.currentTarget;

    window.setTimeout(() => {
      if (processorFocusTransferRef.current && nextTarget === null) {
        processorSelectRef.current?.focus({ preventScroll: true });
        return;
      }
      if (!shouldCommitNodeEditor(draft, false)) {
        return;
      }
      const nodeElement = nodeRef.current;
      if (nodeElement !== blurredNodeElement) {
        return;
      }
      if (nodeElement?.contains(document.activeElement)) {
        return;
      }
      data.onCommit(id);
    }, 0);
  };

  const markSelectedContent = (markerId: string) => {
    if (contentSelection === null) {
      return;
    }
    const option = data.contentMarkerOptions.find(
      (candidate) => candidate.id === markerId,
    );
    const selectionStart =
      contentSelection.kind === "marker"
        ? contentSelection.located.start
        : contentSelection.start;
    const selectionEnd =
      contentSelection.kind === "marker"
        ? contentSelection.located.end
        : contentSelection.end;
    const result = contentMarkerRegistry.applyMarker(
      draft.content,
      selectionStart,
      selectionEnd,
      markerId,
      contentSelection.kind === "marker"
        ? contentMarkerAttributesWithNote(
            contentSelection.located.marker.attributes,
            contentMarkerNote,
          )
        : undefined,
    );
    if (!result.ok) {
      setContentMarkerError(
        result.reason === "conflict"
          ? data.markerSelectionConflictLabel
          : option?.invalidPayloadLabel ??
              data.markerPayloadInvalidLabel(option?.label ?? markerId),
      );
      return;
    }
    setDraft((current) => updateNodeEditorContent(current, result.content));
    const markerSelection = contentMarkerRegistry.inspectSelection(
      result.content,
      Math.max(0, result.caret - 1),
      Math.max(0, result.caret - 1),
    );
    setContentSelection(markerSelection);
    setContentMarkerNote(
      markerSelection?.kind === "marker"
        ? markerSelection.located.marker.attributes.note ?? ""
        : "",
    );
    setContentMarkerError(null);
    data.onContentChange(id, result.content);
    window.setTimeout(() => {
      if (markerSelection?.kind === "marker") {
        contentMarkerNoteInputRef.current?.focus({ preventScroll: true });
        contentMarkerNoteInputRef.current?.select();
      } else {
        contentInputRef.current?.focus({ preventScroll: true });
        contentInputRef.current?.setSelectionRange(result.caret, result.caret);
      }
    }, 0);
  };

  const saveSelectedMarkerNote = () => {
    if (contentSelection?.kind !== "marker") {
      return;
    }
    const note = contentMarkerNote.trim();
    const attributes = contentMarkerAttributesWithNote(
      contentSelection.located.marker.attributes,
      note,
    );
    const result = contentMarkerRegistry.applyMarker(
      draft.content,
      contentSelection.located.start,
      contentSelection.located.end,
      contentSelection.located.marker.id,
      attributes,
    );
    if (!result.ok) {
      setContentMarkerError(data.markerSelectionConflictLabel);
      return;
    }
    const markerSelection = contentMarkerRegistry.inspectSelection(
      result.content,
      Math.max(0, result.caret - 1),
      Math.max(0, result.caret - 1),
    );
    setDraft((current) => updateNodeEditorContent(current, result.content));
    setContentSelection(markerSelection);
    setContentMarkerNote(note);
    setContentMarkerError(null);
    data.onContentChange(id, result.content);
    window.setTimeout(() => {
      contentMarkerNoteInputRef.current?.focus({ preventScroll: true });
      contentMarkerNoteInputRef.current?.setSelectionRange(note.length, note.length);
    }, 0);
  };

  const removeSelectedMarker = () => {
    if (contentSelection?.kind !== "marker") {
      return;
    }
    const result = contentMarkerRegistry.removeMarker(
      draft.content,
      contentSelection.located.start,
      contentSelection.located.end,
    );
    if (!result.ok) {
      setContentMarkerError(data.markerSelectionConflictLabel);
      return;
    }
    setDraft((current) => updateNodeEditorContent(current, result.content));
    setContentSelection(null);
    setContentMarkerError(null);
    data.onContentChange(id, result.content);
    window.setTimeout(() => {
      contentInputRef.current?.focus({ preventScroll: true });
      contentInputRef.current?.setSelectionRange(result.caret, result.caret);
    }, 0);
  };

  const captureContentSelection = (input: HTMLTextAreaElement) => {
    const { selectionEnd, selectionStart } = input;
    const selection = contentMarkerRegistry.inspectSelection(
      input.value,
      selectionStart,
      selectionEnd,
    );
    setContentSelection(selection);
    setContentMarkerNote(
      selection?.kind === "marker"
        ? selection.located.marker.attributes.note ?? ""
        : "",
    );
    setContentMarkerError(
      selection?.kind === "conflict" ? data.markerSelectionConflictLabel : null,
    );
  };

  return (
    <article
      aria-disabled={!data.interactive}
      className="graph-node"
      data-editing={data.editing}
      data-interactive={data.interactive}
      data-manual-height={data.manualHeight || resizing}
      data-manual-size={data.manualSize || resizing}
      data-manual-width={data.manualWidth || resizing}
      data-node-id={id}
      data-overflowing={contentOverflowing}
      data-selected={selected}
      inert={!data.interactive}
      onBlur={commitWhenLeavingNode}
      onFocus={(event) => {
        if (event.target !== processorSelectRef.current) {
          processorFocusTransferRef.current = false;
        }
      }}
      onKeyDownCapture={(event) => {
        if (event.target === contentMarkerNoteInputRef.current) {
          return;
        }
        if (
          data.editing &&
          event.key === "Escape" &&
          (event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement)
        ) {
          event.preventDefault();
          event.stopPropagation();
          data.onCommit(id);
        }
      }}
      ref={nodeRef}
    >
      <NodeResizer
        handleClassName="graph-node-resize-handle"
        isVisible={selected && data.interactive}
        lineClassName="graph-node-resize-line"
        maxHeight={maximumManualNodeDimension}
        maxWidth={maximumManualNodeDimension}
        minHeight={minimumManualNodeHeight}
        minWidth={minimumManualNodeWidth}
        onResizeEnd={(_event, dimensions) => {
          setResizing(false);
          data.onResizeEnd(id, dimensions);
        }}
        onResizeStart={() => {
          setResizing(true);
          data.onResizeStart(id);
        }}
      />
      <Handle
        className="graph-handle graph-handle-target"
        isConnectable={data.interactive ? undefined : false}
        position={Position.Left}
        title={data.targetLabel}
        type="target"
      />
      <header className="graph-node-header">
        {data.editing ? (
          <>
            <GripVertical aria-hidden="true" className="graph-node-drag-handle" size={15} />
            <input
              aria-invalid={data.nameConflict || draft.nameConflict}
              aria-label={data.nameLabel}
              autoFocus
              className="nodrag nowheel graph-node-name-input"
              onChange={(event) => {
                const name = event.target.value;
                setDraft((current) =>
                  updateNodeEditorName(current, name, data.onNameChange(id, name)),
                );
              }}
              placeholder={data.namePlaceholder}
              ref={nameInputRef}
              value={draft.name}
            />
          </>
        ) : (
          <>
            <Link2 aria-hidden="true" size={14} />
            <strong data-unnamed={data.name === null}>{data.name ?? data.unnamedLabel}</strong>
          </>
        )}
        {contentOverflowing && (
          <button
            aria-label={data.fitNodeContentLabel}
            className="nodrag nowheel graph-node-fit-button"
            onClick={(event) => {
              event.stopPropagation();
              data.onFitNodeContent(id);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            title={data.fitNodeContentLabel}
            type="button"
          >
            <Maximize2 aria-hidden="true" size={13} />
          </button>
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
      <div className="graph-node-body" ref={nodeBodyRef}>
      {data.editing ? (
        <div className="graph-node-editor">
          <label className="graph-node-processor-field">
            <span>{data.contentProcessorLabel}</span>
            <select
              className="nodrag nowheel graph-node-processor-select"
              onChange={(event) => {
                processorFocusTransferRef.current = true;
                data.onContentProcessorChange(id, event.target.value);
              }}
              ref={processorSelectRef}
              value={data.contentProcessorId ?? "text"}
            >
              {data.contentProcessorId !== null &&
                !data.contentProcessorOptions.some(
                  (option) => option.id === data.contentProcessorId,
                ) && (
                  <option value={data.contentProcessorId}>
                    {data.unsupportedContentProcessorLabel(data.contentProcessorId)}
                  </option>
                )}
              {data.contentProcessorOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label={data.contentLabel}
            className="nodrag nowheel graph-node-content-input"
            onBlur={() => {
              contentKeyboardSelectionRef.current = false;
            }}
            onChange={(event) => {
              const content = event.target.value;
              setDraft((current) => updateNodeEditorContent(current, content));
              setContentSelection(null);
              setContentMarkerNote("");
              setContentMarkerError(null);
              data.onContentChange(id, content);
            }}
            onKeyDown={(event) => {
              if (event.key === "Shift") {
                contentKeyboardSelectionRef.current = true;
              }
            }}
            onKeyUp={(event) => {
              if (event.key === "Shift") {
                contentKeyboardSelectionRef.current = false;
                captureContentSelection(event.currentTarget);
              } else if (!contentKeyboardSelectionRef.current) {
                captureContentSelection(event.currentTarget);
              }
            }}
            onMouseUp={(event) => {
              contentKeyboardSelectionRef.current = false;
              captureContentSelection(event.currentTarget);
            }}
            placeholder={data.contentPlaceholder}
            ref={contentInputRef}
            rows={4}
            value={draft.content}
          />
          {contentSelection !== null && contentSelection.kind !== "conflict" && (
            <div
              aria-label={
                contentSelection.kind === "marker"
                  ? data.editMarkerLabel(
                      data.contentMarkerOptions.find(
                        (option) =>
                          option.id === contentSelection.located.marker.id,
                      )?.label ?? contentSelection.located.marker.id,
                    )
                  : data.markSelectionLabel
              }
              className="graph-node-content-marker-toolbar"
            >
              <span>
                {contentSelection.kind === "marker"
                  ? data.editMarkerLabel(
                      data.contentMarkerOptions.find(
                        (option) =>
                          option.id === contentSelection.located.marker.id,
                      )?.label ?? contentSelection.located.marker.id,
                    )
                  : data.markSelectionLabel}
              </span>
              {data.contentMarkerOptions.map((option) => (
                <button
                  aria-pressed={
                    contentSelection.kind === "marker" &&
                    contentSelection.located.marker.id === option.id
                  }
                  className="nodrag nowheel graph-node-content-marker-button"
                  disabled={
                    contentSelection.kind === "marker" &&
                    contentSelection.located.marker.id === option.id
                  }
                  key={option.id}
                  onClick={() => markSelectedContent(option.id)}
                  onPointerDown={(event) => event.preventDefault()}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
              {contentSelection.kind === "marker" && (
                <>
                  <label className="graph-node-content-marker-note-field">
                    <span>{data.markerNoteLabel}</span>
                    <input
                      aria-label={data.markerNoteLabel}
                      className="nodrag nowheel graph-node-content-marker-note-input"
                      maxLength={CONTENT_MARKER_NOTE_MAX_LENGTH}
                      onChange={(event) => setContentMarkerNote(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.stopPropagation();
                          saveSelectedMarkerNote();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          const marker = contentSelection.located;
                          setContentMarkerNote(marker.marker.attributes.note ?? "");
                          contentInputRef.current?.focus({ preventScroll: true });
                          contentInputRef.current?.setSelectionRange(
                            marker.payloadStart,
                            marker.payloadEnd,
                          );
                        }
                      }}
                      placeholder={data.markerNotePlaceholder}
                      ref={contentMarkerNoteInputRef}
                      value={contentMarkerNote}
                    />
                  </label>
                  <button
                    className="nodrag nowheel graph-node-content-marker-button"
                    disabled={
                      contentMarkerNote.trim() ===
                      (contentSelection.located.marker.attributes.note ?? "")
                    }
                    onClick={saveSelectedMarkerNote}
                    onPointerDown={(event) => event.preventDefault()}
                    type="button"
                  >
                    {data.saveMarkerNoteLabel}
                  </button>
                  <button
                    className="nodrag nowheel graph-node-content-marker-button graph-node-content-marker-remove"
                    onClick={removeSelectedMarker}
                    onPointerDown={(event) => event.preventDefault()}
                    type="button"
                  >
                    {data.removeMarkerLabel}
                  </button>
                </>
              )}
            </div>
          )}
          {contentMarkerError !== null && (
            <span className="graph-node-error" role="alert">
              {contentMarkerError}
            </span>
          )}
          {(data.nameConflict || draft.nameConflict) && (
            <span className="graph-node-error" role="alert">
              {data.nameConflictLabel}
            </span>
          )}
        </div>
      ) : (
        <NodeContentHost
          canvasPreviewEnabled={!data.contentFullyRendered}
          className="graph-node-content"
          codeSourceContainsSensitive={data.codeSourceContainsSensitive}
          content={data.content}
          enhancementLabels={data.enhancementLabels}
          hideWhenEmpty
          onCopyCodeSource={data.onCopyCodeSource ?? undefined}
          onCopySecret={data.onCopyDerivedSecret ?? undefined}
          processorId={data.contentProcessorId}
          variant="canvas"
        />
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
      {data.incomingReferenceCount > 0 && (
        <button
          aria-haspopup="dialog"
          className="nodrag nowheel graph-node-incoming-button"
          onClick={(event) => {
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            data.onBrowseIncomingReferences(id, {
              bottom: bounds.bottom,
              left: bounds.left,
              top: bounds.top,
            });
          }}
          onPointerDown={(event) => event.stopPropagation()}
          title={
            data.collapsedIncomingReferenceLabel ?? data.incomingReferencesLabel
          }
          type="button"
        >
          <Link2 aria-hidden="true" size={12} />
          <span>{data.incomingReferencesLabel}</span>
        </button>
      )}
      </div>
      <Handle
        className="graph-handle graph-handle-source"
        isConnectable={data.interactive ? undefined : false}
        position={Position.Right}
        title={data.sourceLabel}
        type="source"
      />
    </article>
  );
}

const nodeTypes = { information: InformationNodeCard };
const noFlowEdges: Edge[] = [];
const defaultCanvasViewport: Viewport = { x: 0, y: 0, zoom: 1 };
const minimumCanvasZoom = 0.25;
const maximumCanvasZoom = 2.2;
const canvasSelectionAutoPanDelayMs = 160;
const incomingReferenceBrowserRenderLimit = 100;
const maximumFitContentNodeWidth = 900;
const maximumFitContentNodeHeight = 1_200;
const defaultAutomaticNodeWidth = 270;
const defaultAutomaticNodeHeight = 92;

function flowNodeWidth(node: InformationFlowNode): number {
  const styledWidth = node.style?.width;
  return (
    node.measured?.width ??
    node.width ??
    (typeof styledWidth === "number" ? styledWidth : defaultAutomaticNodeWidth)
  );
}

function flowNodeHeight(node: InformationFlowNode): number {
  const styledHeight = node.style?.height;
  return (
    node.measured?.height ??
    node.height ??
    (typeof styledHeight === "number" ? styledHeight : defaultAutomaticNodeHeight)
  );
}

export function finalizeNodeDragLayout(
  layout: NodeLayout[],
  movedNodes: ReadonlyArray<{
    id: string;
    position: { x: number; y: number };
  }>,
  frontNodeId: string,
): NodeLayout[] {
  const positionedLayout = updateNodeLayoutPositions(
    layout,
    movedNodes.map((node) => ({
      nodeId: node.id,
      x: node.position.x,
      y: node.position.y,
    })),
  );
  return moveNodeLayoutToFront(positionedLayout, frontNodeId);
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isCanvasShortcutBlockedTarget(target: EventTarget | null): boolean {
  if (isTextEntryTarget(target)) {
    return true;
  }
  const element = target instanceof Element ? target : null;
  if (element === null) {
    return false;
  }
  return (
    element.closest(
      "button, select, option, a, [role='dialog'], [role='menu'], [role='listbox']",
    ) !== null
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
  analyzingNodeId,
  autoAvoidOverlaps,
  contentMarkerOptions,
  contentProcessorByNodeId,
  contentProcessorOptions,
  nodes,
  layout,
  references,
  viewport,
  editingNodeId,
  canRedo,
  canUndo,
  historyBlocked,
  nodeFiltersActive,
  nameConflictNodeIds,
  referenceFilterNodeIds,
  filteredNodeIds,
  unmatchedNodeOpacity,
  labels,
  onAnalyzeNodes,
  onCreateNode,
  onCreateReferencedNode,
  onCopySecret,
  onClearNodeFilters,
  onDeleteNodes,
  onEditNode,
  onLayoutChange,
  onNodeCommit,
  onNodeContentChange,
  onNodeContentProcessorChange,
  onNodeBringToFront,
  onNodeNameChange,
  onReferencesChange,
  onRedo,
  onToggleReferenceFilter,
  onUndo,
  onViewportChange,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const incomingReferenceBrowserRef = useRef<HTMLDivElement>(null);
  const referenceSearchInputRef = useRef<HTMLInputElement>(null);
  const referenceSearchPopoverRef = useRef<HTMLDivElement>(null);
  const connectionSourceRef = useRef<string | null>(null);
  const canvasPointerGestureRef = useRef<{
    moved: boolean;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const canvasSelectionGestureRef = useRef<CanvasSelectionGesture | null>(null);
  const contextMenuSelectionRef = useRef<string[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const referencesRef = useRef(references);
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<InformationFlowNode, Edge> | null>(null);
  const lastWorkspaceViewportRef = useRef<CanvasViewport | null>(viewport);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [incomingReferenceBrowser, setIncomingReferenceBrowser] =
    useState<IncomingReferenceBrowserState | null>(null);
  const [navigationFocusNodeId, setNavigationFocusNodeId] =
    useState<string | null>(null);
  const [fitContentNodeId, setFitContentNodeId] = useState<string | null>(null);
  const [smartArrangement, setSmartArrangement] =
    useState<SmartArrangementState | null>(null);
  const [pendingDeletionNodeIds, setPendingDeletionNodeIds] = useState<string[]>([]);
  const [secretClipboardNotice, setSecretClipboardNotice] = useState<{
    error: boolean;
    message: string;
  } | null>(null);
  const secretClipboardNoticeTimerRef = useRef<number | null>(null);
  const [referenceSearch, setReferenceSearch] =
    useState<ReferenceSearchState | null>(null);
  const [selectedReferenceId, setSelectedReferenceId] = useState<string | null>(null);
  const [draggingNodeIds, setDraggingNodeIds] = useState<string[]>([]);
  const [canvasSelection, setCanvasSelection] =
    useState<CanvasSelectionRectangle | null>(null);
  const [flowNodes, setFlowNodes, applyNodeChanges] =
    useNodesState<InformationFlowNode>([]);
  const spacePanActive = useKeyPress("Space");
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const flowNodesRef = useRef(flowNodes);
  flowNodesRef.current = flowNodes;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const lastFilteredNodeIdsRef = useRef(filteredNodeIds);
  const settledNodeSizeByIdRef = useRef(
    new Map<string, { height: number; width: number }>(),
  );
  const pendingCommitAvoidanceRef = useRef<{
    before: { height: number; width: number } | null;
    nodeId: string;
  } | null>(null);
  const smartArrangementAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      smartArrangementAbortControllerRef.current?.abort();
      smartArrangementAbortControllerRef.current = null;
    },
    [],
  );

  const canvasRectangles = useCallback(
    (
      anchorOverride?: {
        height: number;
        nodeId: string;
        width: number;
        x: number;
        y: number;
      },
    ): CanvasRectangle[] =>
      flowNodesRef.current.map((node) =>
        anchorOverride?.nodeId === node.id
          ? {
              height: anchorOverride.height,
              id: node.id,
              width: anchorOverride.width,
              x: anchorOverride.x,
              y: anchorOverride.y,
            }
          : {
              height: flowNodeHeight(node),
              id: node.id,
              width: flowNodeWidth(node),
              x: node.position.x,
              y: node.position.y,
            },
      ),
    [],
  );

  const layoutWithAutomaticAvoidance = useCallback(
    (
      baseLayout: NodeLayout[],
      nodeId: string,
      anchorOverride?: {
        height: number;
        nodeId: string;
        width: number;
        x: number;
        y: number;
      },
    ): NodeLayout[] => {
      if (!autoAvoidOverlaps) {
        return baseLayout;
      }
      const before = canvasRectangles(anchorOverride);
      const after = avoidCanvasNodeOverlaps(before, new Set([nodeId]));
      const moved = after.filter((node, index) => {
        const previous = before[index];
        return node.x !== previous.x || node.y !== previous.y;
      });
      return moved.length === 0
        ? baseLayout
        : updateNodeLayoutPositions(
            baseLayout,
            moved.map((node) => ({ nodeId: node.id, x: node.x, y: node.y })),
          );
    },
    [autoAvoidOverlaps, canvasRectangles],
  );

  const commitNodeDimensions = useCallback(
    (
      nodeId: string,
      dimensions: { height: number; width: number; x: number; y: number } | null,
    ) => {
      const resized = updateNodeLayoutDimensions(
        layoutRef.current,
        nodeId,
        dimensions,
      );
      const avoided =
        dimensions === null
          ? resized
          : layoutWithAutomaticAvoidance(resized, nodeId, {
              ...dimensions,
              nodeId,
            });
      const nextLayout = moveNodeLayoutToFront(avoided, nodeId);
      if (nextLayout !== layoutRef.current) {
        onLayoutChange(nextLayout);
      }
    },
    [layoutWithAutomaticAvoidance, onLayoutChange],
  );

  const fitNodeContent = useCallback((nodeId: string) => {
    setFitContentNodeId(nodeId);
  }, []);

  useEffect(() => {
    if (fitContentNodeId === null) {
      return;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      const nodeElement = containerRef.current?.querySelector<HTMLElement>(
        `.graph-node[data-node-id="${fitContentNodeId}"]`,
      );
      const body = nodeElement?.querySelector<HTMLElement>(".graph-node-body");
      const flowNode = flowNodesRef.current.find(
        (node) => node.id === fitContentNodeId,
      );
      if (
        nodeElement === undefined ||
        nodeElement === null ||
        body == null ||
        flowNode === undefined
      ) {
        setFitContentNodeId(null);
        return;
      }
      const header = nodeElement.querySelector<HTMLElement>(".graph-node-header");
      const width = Math.min(
        maximumFitContentNodeWidth,
        Math.max(
          minimumManualNodeWidth,
          nodeElement.offsetWidth,
          body.scrollWidth + 2,
          (header?.scrollWidth ?? 0) + 2,
        ),
      );
      const height = Math.min(
        maximumFitContentNodeHeight,
        Math.max(
          minimumManualNodeHeight,
          (header?.offsetHeight ?? 0) + body.scrollHeight + 2,
        ),
      );
      commitNodeDimensions(fitContentNodeId, {
        height,
        width,
        x: flowNode.position.x,
        y: flowNode.position.y,
      });
      setFitContentNodeId(null);
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [commitNodeDimensions, fitContentNodeId]);

  const resetNodeSize = useCallback(
    (nodeId: string) => {
      setFitContentNodeId((current) => (current === nodeId ? null : current));
      commitNodeDimensions(nodeId, null);
    },
    [commitNodeDimensions],
  );

  const commitNodeAndScheduleAvoidance = useCallback(
    (nodeId: string) => {
      pendingCommitAvoidanceRef.current = autoAvoidOverlaps
        ? {
            before:
              settledNodeSizeByIdRef.current.get(nodeId) ??
              {
                height: defaultAutomaticNodeHeight,
                width: defaultAutomaticNodeWidth,
              },
            nodeId,
          }
        : null;
      onNodeCommit(nodeId);
    },
    [autoAvoidOverlaps, onNodeCommit],
  );

  useEffect(() => {
    for (const node of flowNodes) {
      if (node.id === editingNodeId) {
        continue;
      }
      settledNodeSizeByIdRef.current.set(node.id, {
        height: flowNodeHeight(node),
        width: flowNodeWidth(node),
      });
    }
  }, [editingNodeId, flowNodes]);

  useEffect(() => {
    const pending = pendingCommitAvoidanceRef.current;
    if (pending === null || editingNodeId === pending.nodeId) {
      return;
    }
    pendingCommitAvoidanceRef.current = null;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const nodeElement = containerRef.current?.querySelector<HTMLElement>(
          `.graph-node[data-node-id="${pending.nodeId}"]`,
        );
        const flowNode = flowNodesRef.current.find(
          (node) => node.id === pending.nodeId,
        );
        if (
          nodeElement === null ||
          nodeElement === undefined ||
          flowNode === undefined
        ) {
          return;
        }
        const after = {
          height: nodeElement.offsetHeight,
          width: nodeElement.offsetWidth,
        };
        settledNodeSizeByIdRef.current.set(pending.nodeId, after);
        if (
          pending.before === null ||
          (Math.abs(pending.before.width - after.width) < 1 &&
            Math.abs(pending.before.height - after.height) < 1)
        ) {
          return;
        }
        const nextLayout = layoutWithAutomaticAvoidance(
          layoutRef.current,
          pending.nodeId,
          {
            ...after,
            nodeId: pending.nodeId,
            x: flowNode.position.x,
            y: flowNode.position.y,
          },
        );
        if (nextLayout !== layoutRef.current) {
          onLayoutChange(nextLayout);
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [editingNodeId, layoutWithAutomaticAvoidance, onLayoutChange]);

  const openSmartArrangement = useCallback((nodeIds: readonly string[]) => {
    const uniqueNodeIds = Array.from(new Set(nodeIds));
    if (uniqueNodeIds.length < 2) {
      return;
    }
    setSmartArrangement({
      busy: false,
      error: null,
      mode: "auto",
      nodeIds: uniqueNodeIds,
      sizeMode: "equal-width",
    });
  }, []);

  const applySmartArrangement = useCallback(async () => {
    if (smartArrangement === null || smartArrangement.busy) {
      return;
    }
    setSmartArrangement((current) =>
      current === null ? null : { ...current, busy: true, error: null },
    );
    const abortController = new AbortController();
    smartArrangementAbortControllerRef.current?.abort();
    smartArrangementAbortControllerRef.current = abortController;
    try {
      const selectedNodeIds = new Set(smartArrangement.nodeIds);
      const selectedNodes = canvasRectangles().filter((node) =>
        selectedNodeIds.has(node.id),
      );
      if (selectedNodes.length < 2) {
        setSmartArrangement(null);
        return;
      }
      const { arrangeCanvasNodesInWorker } = await import(
        "./canvasAutoLayoutClient"
      );
      const result = await arrangeCanvasNodesInWorker(
        {
          mode: smartArrangement.mode,
          nodes: selectedNodes,
          references: references.filter(
            (reference) =>
              selectedNodeIds.has(reference.sourceNodeId) &&
              selectedNodeIds.has(reference.targetNodeId),
          ),
          sizeMode: smartArrangement.sizeMode,
        },
        abortController.signal,
      );
      if (abortController.signal.aborted) {
        return;
      }
      let nextLayout = updateNodeLayoutPositions(
        layoutRef.current,
        result.nodes.map((node) => ({
          nodeId: node.id,
          x: node.x,
          y: node.y,
        })),
      );
      if (smartArrangement.sizeMode !== "preserve") {
        nextLayout = updateNodeLayoutSizeOverrides(
          nextLayout,
          result.nodes.map((node) => ({
            nodeId: node.id,
            width: node.width,
            ...(smartArrangement.sizeMode === "equal-size"
              ? { height: node.height }
              : {}),
          })),
        );
      }
      if (nextLayout !== layoutRef.current) {
        onLayoutChange(nextLayout);
      }
      setSmartArrangement(null);
    } catch {
      if (abortController.signal.aborted) {
        return;
      }
      setSmartArrangement((current) =>
        current === null
          ? null
          : { ...current, busy: false, error: labels.arrangementFailed },
      );
    } finally {
      if (smartArrangementAbortControllerRef.current === abortController) {
        smartArrangementAbortControllerRef.current = null;
      }
    }
  }, [
    canvasRectangles,
    labels.arrangementFailed,
    onLayoutChange,
    references,
    smartArrangement,
  ]);

  const frameCanvasNodes = useCallback(
    (nodesToFrame: readonly InformationFlowNode[], maximumZoom: number) => {
      const canvasBounds = containerRef.current?.getBoundingClientRect();
      if (
        flowInstance === null ||
        canvasBounds === undefined ||
        nodesToFrame.length === 0
      ) {
        return;
      }
      const left = Math.min(...nodesToFrame.map((node) => node.position.x));
      const top = Math.min(...nodesToFrame.map((node) => node.position.y));
      const right = Math.max(
        ...nodesToFrame.map(
          (node) =>
            node.position.x + flowNodeWidth(node),
        ),
      );
      const bottom = Math.max(
        ...nodesToFrame.map(
          (node) =>
            node.position.y + flowNodeHeight(node),
        ),
      );
      const nextViewport = getViewportForBounds(
        {
          height: Math.max(1, bottom - top),
          width: Math.max(1, right - left),
          x: left,
          y: top,
        },
        canvasBounds.width,
        canvasBounds.height,
        minimumCanvasZoom,
        maximumZoom,
        0.2,
      );
      void flowInstance.setViewport(nextViewport, { duration: 140 });
    },
    [flowInstance],
  );

  const openIncomingReferenceBrowser = useCallback(
    (
      targetNodeId: string,
      anchor: { bottom: number; left: number; top: number },
    ) => {
      const canvasBounds = containerRef.current?.getBoundingClientRect();
      if (canvasBounds === undefined) {
        return;
      }
      const popoverWidth = 320;
      const popoverHeight = 380;
      const preferredTop = anchor.bottom - canvasBounds.top + 6;
      const top =
        preferredTop + popoverHeight <= canvasBounds.height - 8
          ? preferredTop
          : Math.max(8, anchor.top - canvasBounds.top - popoverHeight - 6);
      setContextMenu(null);
      setReferenceSearch(null);
      setIncomingReferenceBrowser({
        left: Math.min(
          Math.max(8, anchor.left - canvasBounds.left),
          Math.max(8, canvasBounds.width - popoverWidth - 8),
        ),
        query: "",
        targetNodeId,
        top,
      });
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (secretClipboardNoticeTimerRef.current !== null) {
        window.clearTimeout(secretClipboardNoticeTimerRef.current);
      }
      const selectionGesture = canvasSelectionGestureRef.current;
      if (selectionGesture?.animationFrameId != null) {
        window.cancelAnimationFrame(selectionGesture.animationFrameId);
      }
    };
  }, []);

  const copyTextAsSecret = useCallback(async (text: string) => {
    if (text.length === 0 || onCopySecret === null) {
      return;
    }
    if (secretClipboardNoticeTimerRef.current !== null) {
      window.clearTimeout(secretClipboardNoticeTimerRef.current);
    }
    try {
      await onCopySecret(text);
      setSecretClipboardNotice({
        error: false,
        message: labels.copySecretSuccess,
      });
    } catch {
      setSecretClipboardNotice({ error: true, message: labels.copySecretFailed });
    }
    secretClipboardNoticeTimerRef.current = window.setTimeout(() => {
      setSecretClipboardNotice(null);
      secretClipboardNoticeTimerRef.current = null;
    }, 6_000);
  }, [labels.copySecretFailed, labels.copySecretSuccess, onCopySecret]);

  const copyText = useCallback(async (text: string) => {
    if (text.length === 0) {
      return;
    }
    if (secretClipboardNoticeTimerRef.current !== null) {
      window.clearTimeout(secretClipboardNoticeTimerRef.current);
    }
    try {
      await navigator.clipboard.writeText(text);
      setSecretClipboardNotice({ error: false, message: labels.copyCodeSuccess });
    } catch {
      setSecretClipboardNotice({ error: true, message: labels.copyCodeFailed });
    }
    secretClipboardNoticeTimerRef.current = window.setTimeout(() => {
      setSecretClipboardNotice(null);
      secretClipboardNoticeTimerRef.current = null;
    }, 6_000);
  }, [labels.copyCodeFailed, labels.copyCodeSuccess]);

  const copyCodeSource = useCallback(async (
    nodeId: string,
    containsSensitive: boolean,
  ) => {
    const content = nodesRef.current.find((node) => node.id === nodeId)?.content;
    if (content === null || content === undefined || content.length === 0) {
      return;
    }
    if (containsSensitive) {
      await copyTextAsSecret(content);
    } else {
      await copyText(content);
    }
  }, [copyText, copyTextAsSecret]);

  const copyNodeContentAsSecret = async (nodeId: string) => {
    const content = nodes.find((node) => node.id === nodeId)?.content;
    if (content === null || content === undefined || content.length === 0) {
      return;
    }
    setContextMenu(null);
    await copyTextAsSecret(content);
  };

  useEffect(() => {
    referencesRef.current = references;
  }, [references]);

  useEffect(() => {
    if (
      selectedReferenceId !== null &&
      !references.some(
        (reference) => referenceCurveId(reference) === selectedReferenceId,
      )
    ) {
      setSelectedReferenceId(null);
    }
  }, [references, selectedReferenceId]);

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

  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );

  const referencedNodesBySource = useMemo(() => {
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
  }, [nodesById, references]);

  const incomingNodesByTarget = useMemo(() => {
    const result = new Map<string, InformationNode[]>();
    for (const reference of references) {
      const sourceNode = nodesById.get(reference.sourceNodeId);
      if (sourceNode === undefined) {
        continue;
      }
      const incomingNodes = result.get(reference.targetNodeId) ?? [];
      incomingNodes.push(sourceNode);
      result.set(reference.targetNodeId, incomingNodes);
    }
    return result;
  }, [nodesById, references]);

  const incomingReferenceBrowserTarget =
    incomingReferenceBrowser === null
      ? undefined
      : nodesById.get(incomingReferenceBrowser.targetNodeId);
  const incomingReferenceBrowserMatches = useMemo(() => {
    if (incomingReferenceBrowser === null) {
      return [];
    }
    const query = normalizeNodeName(incomingReferenceBrowser.query);
    return [...(incomingNodesByTarget.get(incomingReferenceBrowser.targetNodeId) ?? [])]
      .filter(
        (node) =>
          query.length === 0 ||
          normalizeNodeName(
            referencedNodeLabel(node, labels.unnamed, labels.noContent),
          ).includes(query),
      )
      .sort((left, right) =>
        referencedNodeLabel(left, labels.unnamed, labels.noContent).localeCompare(
          referencedNodeLabel(right, labels.unnamed, labels.noContent),
        ),
      );
  }, [
    incomingNodesByTarget,
    incomingReferenceBrowser,
    labels.noContent,
    labels.unnamed,
  ]);
  const visibleIncomingReferenceBrowserSources =
    incomingReferenceBrowserMatches.slice(0, incomingReferenceBrowserRenderLimit);

  const canvasReferencePresentation = useMemo(
    () => buildCanvasReferencePresentation(references),
    [references],
  );

  const filteredOutNodeIdSet = useMemo(() => {
    const result = new Set<string>();
    for (const node of nodes) {
      if (
        editingNodeId === node.id ||
        navigationFocusNodeId === node.id ||
        referenceFilterNodeIdSet.has(node.id)
      ) {
        continue;
      }
      if (!filteredNodeIds.has(node.id)) {
        result.add(node.id);
      }
    }
    return result;
  }, [
    editingNodeId,
    filteredNodeIds,
    navigationFocusNodeId,
    nodes,
    referenceFilterNodeIdSet,
  ]);
  const clampedUnmatchedNodeOpacity = Math.max(
    0,
    Math.min(100, unmatchedNodeOpacity),
  );
  const hiddenNodeIdSet = useMemo(
    () =>
      clampedUnmatchedNodeOpacity === 0
        ? filteredOutNodeIdSet
        : new Set<string>(),
    [clampedUnmatchedNodeOpacity, filteredOutNodeIdSet],
  );
  const dimmedNodeIdSet = useMemo(
    () =>
      clampedUnmatchedNodeOpacity > 0 && clampedUnmatchedNodeOpacity < 100
        ? filteredOutNodeIdSet
        : new Set<string>(),
    [clampedUnmatchedNodeOpacity, filteredOutNodeIdSet],
  );

  const focusIncomingReferenceSource = useCallback(
    (nodeId: string) => {
      if (!nodesById.has(nodeId)) {
        return;
      }
      setIncomingReferenceBrowser(null);
      setNavigationFocusNodeId(nodeId);
      onNodeBringToFront(nodeId);
    },
    [nodesById, onNodeBringToFront],
  );

  useEffect(() => {
    if (lastFilteredNodeIdsRef.current !== filteredNodeIds) {
      lastFilteredNodeIdsRef.current = filteredNodeIds;
      setNavigationFocusNodeId(null);
    }
  }, [filteredNodeIds]);

  useEffect(() => {
    if (navigationFocusNodeId === null) {
      return;
    }
    if (!nodesById.has(navigationFocusNodeId)) {
      setNavigationFocusNodeId(null);
      return;
    }
    const focusTimer = window.setTimeout(() => {
      const target = flowNodesRef.current.find(
        (node) => node.id === navigationFocusNodeId,
      );
      if (target === undefined) {
        return;
      }
      setSelectedReferenceId(null);
      setFlowNodes((current) =>
        current.map((node) => ({
          ...node,
          selected: node.id === navigationFocusNodeId,
        })),
      );
      frameCanvasNodes([target], 1.4);
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [
    frameCanvasNodes,
    navigationFocusNodeId,
    nodesById,
    setFlowNodes,
  ]);

  useEffect(() => {
    if (incomingReferenceBrowser === null) {
      return;
    }
    if (
      incomingReferenceBrowserTarget === undefined ||
      (incomingNodesByTarget.get(incomingReferenceBrowser.targetNodeId)?.length ??
        0) === 0
    ) {
      setIncomingReferenceBrowser(null);
    }
  }, [
    incomingNodesByTarget,
    incomingReferenceBrowser,
    incomingReferenceBrowserTarget,
  ]);

  const liveReferenceNodeGeometry = useMemo(
    () =>
      flowNodes.map((node) => ({
        height: flowNodeHeight(node),
        hidden: node.hidden === true,
        id: node.id,
        width: flowNodeWidth(node),
        x: node.position.x,
        y: node.position.y,
      })),
    [flowNodes],
  );
  const committedReferenceNodeGeometry = useMemo(
    () =>
      liveReferenceNodeGeometry.map((node) => {
        const savedLayout = layoutByNode.get(node.id);
        return savedLayout === undefined
          ? node
          : { ...node, x: savedLayout.x, y: savedLayout.y };
      }),
    [layoutByNode, liveReferenceNodeGeometry],
  );
  const draggingNodeIdSet = useMemo(
    () => new Set(draggingNodeIds),
    [draggingNodeIds],
  );
  const partitionedReferences = useMemo(
    () =>
      partitionReferencesByMovingNodes(
        canvasReferencePresentation.visibleReferences,
        draggingNodeIdSet,
      ),
    [canvasReferencePresentation, draggingNodeIdSet],
  );
  const stationaryReferenceCurves = useMemo(
    () =>
      buildReferenceCurves(
        partitionedReferences.stationary,
        committedReferenceNodeGeometry,
      ),
    [committedReferenceNodeGeometry, partitionedReferences.stationary],
  );
  const movingReferenceCurves = useMemo(
    () =>
      buildReferenceCurves(
        partitionedReferences.moving,
        liveReferenceNodeGeometry,
      ),
    [liveReferenceNodeGeometry, partitionedReferences.moving],
  );
  const referenceCurves = useMemo(
    () => [...stationaryReferenceCurves, ...movingReferenceCurves],
    [movingReferenceCurves, stationaryReferenceCurves],
  );
  const interactiveReferenceCurves = useMemo(
    () =>
      referenceCurves.filter(
        (curve) =>
          !filteredOutNodeIdSet.has(curve.sourceNodeId) &&
          !filteredOutNodeIdSet.has(curve.targetNodeId),
      ),
    [filteredOutNodeIdSet, referenceCurves],
  );
  const interactiveReferenceIdSet = useMemo(
    () => new Set(interactiveReferenceCurves.map((curve) => curve.id)),
    [interactiveReferenceCurves],
  );
  useEffect(() => {
    if (
      selectedReferenceId !== null &&
      !interactiveReferenceIdSet.has(selectedReferenceId)
    ) {
      setSelectedReferenceId(null);
    }
  }, [interactiveReferenceIdSet, selectedReferenceId]);
  const partitionCurvesByFilteredState = useCallback(
    (curves: readonly ReferenceCurve[]) => {
      const regular: ReferenceCurve[] = [];
      const dimmed: ReferenceCurve[] = [];
      for (const curve of curves) {
        (dimmedNodeIdSet.has(curve.sourceNodeId) ||
        dimmedNodeIdSet.has(curve.targetNodeId)
          ? dimmed
          : regular
        ).push(curve);
      }
      return { dimmed, regular };
    },
    [dimmedNodeIdSet],
  );
  const stationaryCurvesByFilteredState = useMemo(
    () => partitionCurvesByFilteredState(stationaryReferenceCurves),
    [partitionCurvesByFilteredState, stationaryReferenceCurves],
  );
  const movingCurvesByFilteredState = useMemo(
    () => partitionCurvesByFilteredState(movingReferenceCurves),
    [movingReferenceCurves, partitionCurvesByFilteredState],
  );
  const stationaryReferencePaths = useMemo(
    () => ({
      dimmed: buildBatchedReferencePaths(
        stationaryCurvesByFilteredState.dimmed,
        selectedReferenceId,
      ),
      regular: buildBatchedReferencePaths(
        stationaryCurvesByFilteredState.regular,
        selectedReferenceId,
      ),
    }),
    [selectedReferenceId, stationaryCurvesByFilteredState],
  );
  const movingReferencePaths = useMemo(
    () => ({
      dimmed: buildBatchedReferencePaths(
        movingCurvesByFilteredState.dimmed,
        selectedReferenceId,
      ),
      regular: buildBatchedReferencePaths(
        movingCurvesByFilteredState.regular,
        selectedReferenceId,
      ),
    }),
    [movingCurvesByFilteredState, selectedReferenceId],
  );
  const selectedNodeBoundary = useMemo(
    () =>
      selectedCanvasNodeBoundary(
        flowNodes.map((node) => ({
          height: flowNodeHeight(node),
          hidden: node.hidden === true || filteredOutNodeIdSet.has(node.id),
          id: node.id,
          selected: node.selected === true,
          width: flowNodeWidth(node),
          x: node.position.x,
          y: node.position.y,
        })),
      ),
    [filteredOutNodeIdSet, flowNodes],
  );

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
  }, [
    labels.noContent,
    labels.unnamed,
    nodes,
    referenceSearch,
    references,
  ]);

  const referenceSearchCreationName = useMemo(() => {
    if (referenceSearch === null || referenceSearchCandidates.length > 0) {
      return null;
    }
    return referenceTargetCreationName(nodes, referenceSearch.query);
  }, [nodes, referenceSearch, referenceSearchCandidates.length]);

  useEffect(() => {
    if (
      referenceSearch !== null &&
      filteredOutNodeIdSet.has(referenceSearch.sourceNodeId)
    ) {
      setReferenceSearch(null);
    }
  }, [filteredOutNodeIdSet, referenceSearch]);

  const sensitiveCodeContentByNodeId = useMemo(() => {
    const result = new Map<string, boolean>();
    for (const node of nodes) {
      if (
        codePreviewLanguageFromProcessorId(
          contentProcessorByNodeId[node.id] ?? "",
        ) !== null
      ) {
        result.set(node.id, contentContainsSensitive(node.content));
      }
    }
    return result;
  }, [contentProcessorByNodeId, nodes]);

  useEffect(() => {
    setFlowNodes((current) => {
      const currentById = new Map(current.map((node) => [node.id, node]));
      return nodes.map((node, index) => {
        const savedLayout = layoutByNode.get(node.id);
        const currentNode = currentById.get(node.id);
        const referencedNodes = referencedNodesBySource.get(node.id) ?? [];
        const incomingNodes = incomingNodesByTarget.get(node.id) ?? [];
        const interactive = !filteredOutNodeIdSet.has(node.id);
        const manualWidth = savedLayout?.width !== undefined;
        const manualHeight = savedLayout?.height !== undefined;
        const manualSize = manualWidth || manualHeight;
        const codeSourceContainsSensitive =
          sensitiveCodeContentByNodeId.get(node.id) ?? false;
        const contentFullyRendered =
          editingNodeId === node.id ||
          manualHeight ||
          fitContentNodeId === node.id;
        const renderedContent = contentFullyRendered
          ? node.content
          : canvasContentPreview(node.content);
        return {
          ...(currentNode ?? {}),
          connectable: interactive ? undefined : false,
          draggable: interactive ? undefined : false,
          id: node.id,
          type: "information",
          deletable: false,
          focusable: interactive ? undefined : false,
          position: savedLayout
            ? { x: savedLayout.x, y: savedLayout.y }
            : { x: 80 + (index % 4) * 300, y: 80 + Math.floor(index / 4) * 210 },
          selectable: interactive ? undefined : false,
          selected: interactive && (currentNode?.selected ?? false),
          style: {
            ...(manualHeight ? { height: savedLayout.height } : {}),
            ...(manualWidth ? { width: savedLayout.width } : {}),
            ...(!interactive
              ? {
                opacity: clampedUnmatchedNodeOpacity / 100,
                pointerEvents: "none" as const,
                }
              : {}),
          },
          zIndex: stackOrderByNode.get(node.id) ?? index,
          hidden: hiddenNodeIdSet.has(node.id),
          data: {
            name: node.name,
            content: renderedContent,
            contentFullyRendered,
            contentTruncated: renderedContent !== node.content,
            contentProcessorId: contentProcessorByNodeId[node.id] ?? null,
            codeSourceContainsSensitive,
            contentProcessorLabel: labels.contentProcessor,
            contentProcessorOptions,
            contentMarkerOptions,
            editMarkerLabel: labels.editMarker,
            markSelectionLabel: labels.markSelection,
            markerNoteLabel: labels.markerNote,
            markerNotePlaceholder: labels.markerNotePlaceholder,
            markerPayloadInvalidLabel: labels.markerPayloadInvalid,
            markerSelectionConflictLabel: labels.markerSelectionConflict,
            manualHeight,
            manualSize,
            manualWidth,
            removeMarkerLabel: labels.removeMarker,
            saveMarkerNoteLabel: labels.saveMarkerNote,
            fitNodeContentLabel: labels.fitNodeContent,
            unsupportedContentProcessorLabel: labels.unsupportedContentProcessor,
            contentLabel: labels.content,
            contentPlaceholder: labels.contentPlaceholder,
            enhancementLabels: {
              code: {
                copy: labels.codeCopy,
                languages: labels.codeLanguages,
              },
              secret: {
                copy: labels.secretCopy,
                hide: labels.secretHide,
                label: labels.secretLabel,
                masked: labels.secretMasked,
                reveal: labels.secretReveal,
              },
              totp: {
                copy: labels.totpCopy,
                generating: labels.totpGenerating,
                invalid: labels.totpInvalid,
                masked: labels.totpMasked,
                remaining: labels.totpRemaining,
              },
            },
            editing: editingNodeId === node.id,
            interactive,
            nameConflict: nameConflictNodeIds.has(node.id),
            nameConflictLabel: labels.nameConflict,
            nameLabel: labels.name,
            namePlaceholder: labels.namePlaceholder,
            incomingReferenceCount: incomingNodes.length,
            incomingReferencesLabel: labels.incomingReferences(
              incomingNodes.length,
            ),
            referencedTargets: referencedNodes
              .map((target) => ({
                filterActive: referenceFilterNodeIdSet.has(target.id),
                id: target.id,
                label: referencedNodeLabel(target, labels.unnamed, labels.noContent),
              }))
              .sort((left, right) => left.label.localeCompare(right.label)),
            collapsedIncomingReferenceLabel: (() => {
              const count =
                canvasReferencePresentation.collapsedIncomingByTarget.get(node.id) ?? 0;
              return count === 0 ? null : labels.collapsedIncomingReferences(count);
            })(),
            referencesLabel: labels.references,
            unnamedLabel: labels.unnamed,
            filterActive: referenceFilterNodeIdSet.has(node.id),
            filterByNodeLabel: labels.filterByNode,
            removeNodeFilterLabel: labels.removeNodeFilter,
            sourceLabel: labels.sourceHandle,
            targetLabel: labels.targetHandle,
            onCommit: commitNodeAndScheduleAvoidance,
            onBrowseIncomingReferences: openIncomingReferenceBrowser,
            onContentChange: onNodeContentChange,
            onContentProcessorChange: onNodeContentProcessorChange,
            onCopyCodeSource:
              codeSourceContainsSensitive && onCopySecret === null
                ? null
                : (containsSensitive) => copyCodeSource(node.id, containsSensitive),
            onCopyDerivedSecret:
              onCopySecret === null ? null : copyTextAsSecret,
            onNameChange: onNodeNameChange,
            onFitNodeContent: fitNodeContent,
            onResizeEnd: commitNodeDimensions,
            onResizeStart: onNodeBringToFront,
            onToggleReferenceFilter,
          },
        };
      });
    });
  }, [
    contentMarkerOptions,
    contentProcessorByNodeId,
    contentProcessorOptions,
    copyCodeSource,
    copyTextAsSecret,
    commitNodeDimensions,
    commitNodeAndScheduleAvoidance,
    canvasReferencePresentation,
    editingNodeId,
    fitContentNodeId,
    clampedUnmatchedNodeOpacity,
    filteredOutNodeIdSet,
    hiddenNodeIdSet,
    fitNodeContent,
    incomingNodesByTarget,
    labels,
    layoutByNode,
    nameConflictNodeIds,
    nodes,
    onNodeContentChange,
    onNodeContentProcessorChange,
    onCopySecret,
    onNodeNameChange,
    openIncomingReferenceBrowser,
    onToggleReferenceFilter,
    referenceFilterNodeIdSet,
    referencedNodesBySource,
    setFlowNodes,
    sensitiveCodeContentByNodeId,
    stackOrderByNode,
  ]);

  useEffect(() => {
    setPendingDeletionNodeIds((current) => {
      const next = current.filter((nodeId) => !filteredOutNodeIdSet.has(nodeId));
      return next.length === current.length ? current : next;
    });
    setContextMenu((current) =>
      current?.kind === "node" && filteredOutNodeIdSet.has(current.nodeId)
        ? null
        : current,
    );
  }, [filteredOutNodeIdSet]);

  useEffect(() => {
    if (incomingReferenceBrowser === null) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof globalThis.Node &&
        !incomingReferenceBrowserRef.current?.contains(event.target)
      ) {
        setIncomingReferenceBrowser(null);
      }
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [incomingReferenceBrowser]);

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
      const key = event.key.toLowerCase();
      const canvasTransientControlFocused =
        key === "escape" &&
        event.target instanceof Element &&
        event.target.closest(
          ".graph-node-filter-button, .graph-node-reference-chip, .graph-node-incoming-button, .incoming-reference-browser",
        ) !== null;
      if (
        isCanvasShortcutBlockedTarget(event.target) &&
        !canvasTransientControlFocused
      ) {
        return;
      }

      const modifierPressed = event.ctrlKey || event.metaKey;
      if (!modifierPressed && key === "?") {
        event.preventDefault();
        setShortcutHelpOpen((current) => !current);
        return;
      }
      if (key === "escape") {
        event.preventDefault();
        if (shortcutHelpOpen) {
          setShortcutHelpOpen(false);
          return;
        }
        if (incomingReferenceBrowser !== null) {
          setIncomingReferenceBrowser(null);
          return;
        }
        if (referenceSearch !== null) {
          setReferenceSearch(null);
          return;
        }
        if (contextMenu !== null) {
          setContextMenu(null);
          return;
        }
        if (pendingDeletionNodeIds.length > 0) {
          setPendingDeletionNodeIds([]);
          return;
        }
        const hadSelection =
          selectedReferenceId !== null ||
          flowNodesRef.current.some((node) => node.selected);
        setSelectedReferenceId(null);
        setFlowNodes((current) =>
          current.map((node) =>
            node.selected ? { ...node, selected: false } : node,
          ),
        );
        if (!hadSelection && nodeFiltersActive) {
          onClearNodeFilters();
        }
        return;
      }

      if (key === "home") {
        const visibleNodes = flowNodesRef.current.filter((node) => !node.hidden);
        if (visibleNodes.length > 0) {
          event.preventDefault();
          frameCanvasNodes(visibleNodes, 1);
        }
        return;
      }

      if (!modifierPressed && key === "f") {
        const selectedNodes = flowNodesRef.current.filter(
          (node) => node.selected && !node.hidden && node.selectable !== false,
        );
        if (selectedNodes.length > 0) {
          event.preventDefault();
          frameCanvasNodes(selectedNodes, 1.4);
        }
        return;
      }

      if (!modifierPressed && (key === "+" || key === "=")) {
        if (flowInstance !== null) {
          event.preventDefault();
          void flowInstance.zoomIn({ duration: 120 });
        }
        return;
      }

      if (!modifierPressed && (key === "-" || key === "_")) {
        if (flowInstance !== null) {
          event.preventDefault();
          void flowInstance.zoomOut({ duration: 120 });
        }
        return;
      }

      if (modifierPressed && key === "0") {
        if (flowInstance !== null) {
          event.preventDefault();
          void flowInstance.zoomTo(1, { duration: 120 });
        }
        return;
      }

      if (!modifierPressed && (key === "enter" || key === "f2")) {
        const selectedNodes = flowNodesRef.current.filter(
          (node) => node.selected && !node.hidden && node.selectable !== false,
        );
        if (selectedNodes.length === 1) {
          event.preventDefault();
          onEditNode(selectedNodes[0].id);
        }
        return;
      }

      if (modifierPressed && key === "a") {
        event.preventDefault();
        setSelectedReferenceId(null);
        setFlowNodes((current) =>
          current.map((node) => ({
            ...node,
            selected: !node.hidden && node.selectable !== false,
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
        const selectedNodeIds = flowNodesRef.current
          .filter(
            (node) => node.selected && !node.hidden && node.selectable !== false,
          )
          .map((node) => node.id);
        if (selectedNodeIds.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          setPendingDeletionNodeIds(selectedNodeIds);
          return;
        }
        if (
          selectedReferenceId !== null &&
          interactiveReferenceIdSet.has(selectedReferenceId)
        ) {
          event.preventDefault();
          event.stopPropagation();
          const nextReferences = references.filter(
            (reference) => referenceCurveId(reference) !== selectedReferenceId,
          );
          if (nextReferences.length !== references.length) {
            referencesRef.current = nextReferences;
            onReferencesChange(nextReferences);
          }
          setSelectedReferenceId(null);
        }
      }
    };

    window.addEventListener("keydown", handleCanvasShortcut, true);
    return () => window.removeEventListener("keydown", handleCanvasShortcut, true);
  }, [
    contextMenu,
    frameCanvasNodes,
    flowInstance,
    historyBlocked,
    incomingReferenceBrowser,
    interactiveReferenceIdSet,
    nodeFiltersActive,
    onClearNodeFilters,
    onEditNode,
    onRedo,
    onReferencesChange,
    onUndo,
    pendingDeletionNodeIds.length,
    references,
    referenceSearch,
    selectedReferenceId,
    setFlowNodes,
    shortcutHelpOpen,
  ]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<InformationFlowNode>[]) => {
      applyNodeChanges(
        changes.filter(
          (change) =>
            change.type === "add" ||
            !filteredOutNodeIdSet.has(change.id) ||
            (change.type !== "position" &&
              change.type !== "select" &&
              change.type !== "remove"),
        ),
      );
    },
    [applyNodeChanges, filteredOutNodeIdSet],
  );

  const bringFlowNodeToFront = useCallback(
    (nodeId: string) => {
      if (filteredOutNodeIdSet.has(nodeId)) {
        return;
      }
      setFlowNodes((current) => {
        const target = current.find((node) => node.id === nodeId);
        if (target === undefined) {
          return current;
        }
        const maximumZIndex = current.reduce(
          (maximum, node) => Math.max(maximum, node.zIndex ?? 0),
          0,
        );
        if ((target.zIndex ?? 0) >= maximumZIndex) {
          return current;
        }
        return current.map((node) =>
          node.id === nodeId ? { ...node, zIndex: maximumZIndex + 1 } : node,
        );
      });
    },
    [filteredOutNodeIdSet, setFlowNodes],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (connection.source === null || connection.target === null) {
        return;
      }
      if (
        filteredOutNodeIdSet.has(connection.source) ||
        filteredOutNodeIdSet.has(connection.target)
      ) {
        return;
      }

      const currentReferences = referencesRef.current;
      const nextReferences = appendExistingNodeReference(
        nodes,
        currentReferences,
        connection.source,
        connection.target,
      );
      if (nextReferences !== currentReferences) {
        referencesRef.current = nextReferences;
        onReferencesChange(nextReferences);
      }
    },
    [filteredOutNodeIdSet, nodes, onReferencesChange],
  );

  const appendReference = useCallback(
    (sourceNodeId: string, targetNodeId: string) => {
      if (filteredOutNodeIdSet.has(sourceNodeId)) {
        return;
      }
      const currentReferences = referencesRef.current;
      const nextReferences = appendExistingNodeReference(
        nodes,
        currentReferences,
        sourceNodeId,
        targetNodeId,
      );
      if (nextReferences !== currentReferences) {
        referencesRef.current = nextReferences;
        onReferencesChange(nextReferences);
      }
    },
    [filteredOutNodeIdSet, nodes, onReferencesChange],
  );

  const chooseReferenceSearchTarget = useCallback(
    (targetNodeId: string, closeAfterSelection: boolean) => {
      if (referenceSearch === null) {
        return;
      }
      if (filteredOutNodeIdSet.has(referenceSearch.sourceNodeId)) {
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
    [appendReference, filteredOutNodeIdSet, referenceSearch],
  );

  const createReferenceSearchTarget = useCallback(
    () => {
      if (
        referenceSearch === null ||
        referenceSearchCreationName === null ||
        filteredOutNodeIdSet.has(referenceSearch.sourceNodeId)
      ) {
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
    [
      filteredOutNodeIdSet,
      onCreateReferencedNode,
      referenceSearch,
      referenceSearchCreationName,
    ],
  );

  const handleConnectEnd = useCallback(
    (
      event: MouseEvent | TouchEvent,
      connectionState: FinalConnectionState,
    ) => {
      const sourceNodeId = connectionSourceRef.current;
      connectionSourceRef.current = null;
      const targetElement = event.target instanceof Element ? event.target : null;
      const droppedOnEmptyCanvas =
        targetElement !== null &&
        (targetElement.classList.contains("react-flow__pane") ||
          targetElement.closest(".react-flow__background") !== null);
      if (
        sourceNodeId === null ||
        filteredOutNodeIdSet.has(sourceNodeId) ||
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
    [filteredOutNodeIdSet, flowInstance],
  );

  const handleNodeDragStop = useCallback(
    (
      _event: MouseEvent | TouchEvent,
      node: InformationFlowNode,
      draggedNodes: InformationFlowNode[],
    ) => {
      setDraggingNodeIds([]);
      if (filteredOutNodeIdSet.has(node.id)) {
        return;
      }
      const movedNodes = (draggedNodes.length > 0 ? draggedNodes : [node]).filter(
        (movedNode) => !filteredOutNodeIdSet.has(movedNode.id),
      );
      const nextLayout = finalizeNodeDragLayout(
        layout,
        movedNodes,
        node.id,
      );
      if (nextLayout !== layout) {
        onLayoutChange(nextLayout);
      }
    },
    [filteredOutNodeIdSet, layout, onLayoutChange],
  );

  const positionContextMenu = useCallback((
    clientX: number,
    clientY: number,
    estimatedHeight = 70,
  ) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) {
      return { left: 0, top: 0 };
    }

    return {
      left: Math.min(clientX - bounds.left, Math.max(8, bounds.width - 190)),
      top: Math.min(
        clientY - bounds.top,
        Math.max(8, bounds.height - estimatedHeight - 8),
      ),
    };
  }, []);

  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent<Element, MouseEvent>) => {
      event.preventDefault();
      if (flowInstance === null) {
        return;
      }
      setSelectedReferenceId(null);
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
      if (filteredOutNodeIdSet.has(node.id)) {
        return;
      }
      setSelectedReferenceId(null);
      onNodeBringToFront(node.id);
      const currentSelectedNodeIds = flowNodesRef.current
        .filter(
          (candidate) =>
            candidate.selected &&
            !candidate.hidden &&
            candidate.selectable !== false,
        )
        .map((candidate) => candidate.id);
      const selectedNodeIds = contextMenuSelectionRef.current.includes(node.id)
        ? contextMenuSelectionRef.current
        : currentSelectedNodeIds;
      contextMenuSelectionRef.current = [];
      setContextMenu({
        kind: "node",
        ...positionContextMenu(event.clientX, event.clientY, 290),
        nodeId: node.id,
        nodeIds:
          selectedNodeIds.length > 1 ? selectedNodeIds : [node.id],
      });
    },
    [filteredOutNodeIdSet, onNodeBringToFront, positionContextMenu],
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

  const updateCanvasSelectionGesture = useCallback(
    (gesture: CanvasSelectionGesture, currentViewport?: Viewport) => {
      const bounds = containerRef.current?.getBoundingClientRect();
      if (bounds === undefined || flowInstance === null) {
        return;
      }
      const viewportForSelection = currentViewport ?? flowInstance.getViewport();
      const endFlow = {
        x:
          (gesture.currentClient.x - bounds.left - viewportForSelection.x) /
          viewportForSelection.zoom,
        y:
          (gesture.currentClient.y - bounds.top - viewportForSelection.y) /
          viewportForSelection.zoom,
      };
      const flowRectangle = canvasSelectionRectangle(gesture.startFlow, endFlow);
      const selectedNodeIds = nodesIntersectingCanvasSelection(
        flowNodesRef.current.map((node) => ({
          height: flowNodeHeight(node),
          hidden: node.hidden === true || filteredOutNodeIdSet.has(node.id),
          id: node.id,
          width: flowNodeWidth(node),
          x: node.position.x,
          y: node.position.y,
        })),
        flowRectangle,
      );
      setFlowNodes((current) => {
        let changed = false;
        const next = current.map((node) => {
          const selected = selectedNodeIds.has(node.id);
          if (Boolean(node.selected) === selected) {
            return node;
          }
          changed = true;
          return { ...node, selected };
        });
        return changed ? next : current;
      });

      const startScreen = {
        x: gesture.startFlow.x * viewportForSelection.zoom + viewportForSelection.x,
        y: gesture.startFlow.y * viewportForSelection.zoom + viewportForSelection.y,
      };
      const currentScreen = {
        x: gesture.currentClient.x - bounds.left,
        y: gesture.currentClient.y - bounds.top,
      };
      setCanvasSelection(canvasSelectionRectangle(startScreen, currentScreen));
    },
    [filteredOutNodeIdSet, flowInstance, setFlowNodes],
  );

  const startCanvasSelectionAutoPan = useCallback(
    (gesture: CanvasSelectionGesture) => {
      const step = () => {
        if (canvasSelectionGestureRef.current !== gesture || !gesture.moved) {
          gesture.animationFrameId = null;
          return;
        }
        const bounds = containerRef.current?.getBoundingClientRect();
        if (bounds !== undefined && flowInstance !== null) {
          const delta = canvasSelectionAutoPanDelta(
            {
              x: gesture.currentClient.x - bounds.left,
              y: gesture.currentClient.y - bounds.top,
            },
            { height: bounds.height, width: bounds.width },
          );
          const direction = `${Math.sign(delta.x)},${Math.sign(delta.y)}`;
          if (delta.x === 0 && delta.y === 0) {
            gesture.autoPanDirection = null;
            gesture.autoPanStartedAt = null;
          } else if (gesture.autoPanDirection !== direction) {
            gesture.autoPanDirection = direction;
            gesture.autoPanStartedAt = performance.now();
          } else if (
            gesture.autoPanStartedAt !== null &&
            performance.now() - gesture.autoPanStartedAt >=
              canvasSelectionAutoPanDelayMs
          ) {
            const currentViewport = flowInstance.getViewport();
            const nextViewport = {
              x: currentViewport.x + delta.x,
              y: currentViewport.y + delta.y,
              zoom: currentViewport.zoom,
            };
            void flowInstance.setViewport(nextViewport, { duration: 0 });
            updateCanvasSelectionGesture(gesture, nextViewport);
          }
        }
        gesture.animationFrameId = window.requestAnimationFrame(step);
      };
      gesture.animationFrameId = window.requestAnimationFrame(step);
    },
    [flowInstance, updateCanvasSelectionGesture],
  );

  const finishCanvasSelectionGesture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const gesture = canvasSelectionGestureRef.current;
      if (gesture === null || gesture.pointerId !== event.pointerId) {
        return false;
      }
      if (!cancelled) {
        gesture.currentClient = { x: event.clientX, y: event.clientY };
      }
      if (gesture.animationFrameId !== null) {
        window.cancelAnimationFrame(gesture.animationFrameId);
      }
      if (gesture.moved) {
        updateCanvasSelectionGesture(gesture);
      }
      canvasSelectionGestureRef.current = null;
      setCanvasSelection(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      event.stopPropagation();
      return true;
    },
    [updateCanvasSelectionGesture],
  );

  const handleCanvasPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target instanceof Element ? event.target : null;
      contextMenuSelectionRef.current =
        event.button === 2
          ? flowNodesRef.current
              .filter(
                (node) =>
                  node.selected && !node.hidden && node.selectable !== false,
              )
              .map((node) => node.id)
          : [];
      const selectionSurface =
        target !== null &&
        (target.classList.contains("react-flow__pane") ||
          target.closest(".react-flow__background") !== null);
      if (
        event.button === 0 &&
        event.shiftKey &&
        selectionSurface &&
        flowInstance !== null
      ) {
        const startClient = { x: event.clientX, y: event.clientY };
        canvasPointerGestureRef.current = null;
        canvasSelectionGestureRef.current = {
          animationFrameId: null,
          autoPanDirection: null,
          autoPanStartedAt: null,
          currentClient: startClient,
          moved: false,
          pointerId: event.pointerId,
          startClient,
          startFlow: flowInstance.screenToFlowPosition(startClient),
        };
        setContextMenu(null);
        setSelectedReferenceId(null);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (
        event.button !== 0 ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        target === null ||
        target.closest(
          ".react-flow__node, .react-flow__controls, .react-flow__minimap, .canvas-action-panel, .reference-search-popover, button, input, textarea",
        ) !== null
      ) {
        canvasPointerGestureRef.current = null;
        return;
      }
      canvasPointerGestureRef.current = {
        moved: false,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
    },
    [flowInstance],
  );

  const handleCanvasPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const selectionGesture = canvasSelectionGestureRef.current;
      if (
        selectionGesture !== null &&
        selectionGesture.pointerId === event.pointerId
      ) {
        selectionGesture.currentClient = { x: event.clientX, y: event.clientY };
        if (
          !selectionGesture.moved &&
          Math.hypot(
            event.clientX - selectionGesture.startClient.x,
            event.clientY - selectionGesture.startClient.y,
          ) > 4
        ) {
          selectionGesture.moved = true;
          updateCanvasSelectionGesture(selectionGesture);
          startCanvasSelectionAutoPan(selectionGesture);
        } else if (selectionGesture.moved) {
          updateCanvasSelectionGesture(selectionGesture);
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const gesture = canvasPointerGestureRef.current;
      if (gesture === null || gesture.pointerId !== event.pointerId || gesture.moved) {
        return;
      }
      if (
        Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 4
      ) {
        gesture.moved = true;
      }
    },
    [startCanvasSelectionAutoPan, updateCanvasSelectionGesture],
  );

  const handleCanvasPointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      finishCanvasSelectionGesture(event, false);
    },
    [finishCanvasSelectionGesture],
  );

  const handleCanvasPointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!finishCanvasSelectionGesture(event, true)) {
        canvasPointerGestureRef.current = null;
      }
    },
    [finishCanvasSelectionGesture],
  );

  const handleCanvasClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const gesture = canvasPointerGestureRef.current;
      canvasPointerGestureRef.current = null;
      if (gesture === null || gesture.moved || flowInstance === null) {
        return;
      }
      const point = flowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const zoom = flowInstance.getViewport().zoom;
      const selected = findReferenceCurveAtPoint(
        interactiveReferenceCurves,
        point,
        9 / zoom,
      );
      if (selected === null) {
        setSelectedReferenceId(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectedReferenceId(selected.id);
      setFlowNodes((current) =>
        current.map((node) => (node.selected ? { ...node, selected: false } : node)),
      );
    },
    [flowInstance, interactiveReferenceCurves, setFlowNodes],
  );

  const emptyStateLabel =
    nodes.length === 0
      ? labels.empty
      : filteredNodeIds.size === 0
        ? labels.noMatches
        : null;
  const pendingDeletionNodes = pendingDeletionNodeIds
    .map((nodeId) => nodes.find((node) => node.id === nodeId))
    .filter((node): node is InformationNode => node !== undefined);

  return (
    <div
      className="graph-canvas"
      data-flow-ready={flowInstance !== null}
      data-space-pan={spacePanActive}
      data-testid="graph-canvas"
      onClickCapture={handleCanvasClickCapture}
      onContextMenu={(event) => event.preventDefault()}
      onPointerCancelCapture={handleCanvasPointerCancelCapture}
      onPointerDownCapture={handleCanvasPointerDownCapture}
      onPointerMoveCapture={handleCanvasPointerMoveCapture}
      onPointerUpCapture={handleCanvasPointerUpCapture}
      ref={containerRef}
    >
      <TotpSecondClockProvider>
        <ReactFlow<InformationFlowNode, Edge>
        colorMode="light"
        deleteKeyCode={["Backspace", "Delete"]}
        edges={noFlowEdges}
        edgesReconnectable={false}
        elementsSelectable={!spacePanActive}
        elevateNodesOnSelect={false}
        defaultViewport={viewport ?? defaultCanvasViewport}
        fitView={viewport === null}
        fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
        maxZoom={maximumCanvasZoom}
        minZoom={minimumCanvasZoom}
        nodeTypes={nodeTypes}
        nodes={flowNodes}
        nodesConnectable={!spacePanActive}
        nodesDraggable={!spacePanActive}
        onlyRenderVisibleElements
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        onConnectStart={(_event, params) => {
          connectionSourceRef.current =
            params.handleType === "source" &&
            params.nodeId !== null &&
            !filteredOutNodeIdSet.has(params.nodeId)
              ? params.nodeId
              : null;
        }}
        onInit={setFlowInstance}
        onNodeContextMenu={handleNodeContextMenu}
        onNodeClick={(_event, node) => {
          if (filteredOutNodeIdSet.has(node.id)) {
            return;
          }
          setSelectedReferenceId(null);
          onNodeBringToFront(node.id);
        }}
        onNodeDoubleClick={(_event, node) => {
          if (!filteredOutNodeIdSet.has(node.id)) {
            onEditNode(node.id);
          }
        }}
        onNodeDragStart={(_event, node, draggedNodes) => {
          if (filteredOutNodeIdSet.has(node.id)) {
            setDraggingNodeIds([]);
            return;
          }
          setDraggingNodeIds(
            Array.from(
              new Set(
                (draggedNodes.length > 0 ? draggedNodes : [node]).map(
                  (draggedNode) => draggedNode.id,
                ),
              ),
            ),
          );
          bringFlowNodeToFront(node.id);
        }}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={handleNodesChange}
        onMoveEnd={(_event, nextViewport) => onViewportChange(nextViewport)}
        onPaneClick={() => {
          setContextMenu(null);
          setSelectedReferenceId(null);
        }}
        onPaneContextMenu={handlePaneContextMenu}
        panActivationKeyCode="Space"
        panOnDrag={[0, 1]}
        proOptions={{ hideAttribution: true }}
        multiSelectionKeyCode={["Control", "Shift"]}
        selectionKeyCode={null}
        zoomOnDoubleClick={false}
        zIndexMode="manual"
      >
        <ViewportPortal>
          <svg
            aria-hidden="true"
            className="graph-reference-layer"
            height="1"
            width="1"
          >
            {stationaryReferencePaths.dimmed.normal.length > 0 && (
              <path
                className="graph-reference-path graph-reference-path-dimmed"
                d={stationaryReferencePaths.dimmed.normal}
                style={{ opacity: clampedUnmatchedNodeOpacity / 100 }}
              />
            )}
            {stationaryReferencePaths.dimmed.selected.length > 0 && (
              <path
                className="graph-reference-path graph-reference-path-selected graph-reference-path-dimmed"
                d={stationaryReferencePaths.dimmed.selected}
                style={{ opacity: clampedUnmatchedNodeOpacity / 100 }}
              />
            )}
            <path
              className="graph-reference-path"
              d={stationaryReferencePaths.regular.normal}
            />
            {stationaryReferencePaths.regular.selected.length > 0 && (
              <path
                className="graph-reference-path graph-reference-path-selected"
                d={stationaryReferencePaths.regular.selected}
              />
            )}
            {movingReferencePaths.dimmed.normal.length > 0 && (
              <path
                className="graph-reference-path graph-reference-path-dimmed"
                d={movingReferencePaths.dimmed.normal}
                style={{ opacity: clampedUnmatchedNodeOpacity / 100 }}
              />
            )}
            {movingReferencePaths.dimmed.selected.length > 0 && (
              <path
                className="graph-reference-path graph-reference-path-selected graph-reference-path-dimmed"
                d={movingReferencePaths.dimmed.selected}
                style={{ opacity: clampedUnmatchedNodeOpacity / 100 }}
              />
            )}
            {movingReferencePaths.regular.normal.length > 0 && (
              <path
                className="graph-reference-path"
                d={movingReferencePaths.regular.normal}
              />
            )}
            {movingReferencePaths.regular.selected.length > 0 && (
              <path
                className="graph-reference-path graph-reference-path-selected"
                d={movingReferencePaths.regular.selected}
              />
            )}
          </svg>
          {selectedNodeBoundary !== null && (
            <div
              aria-hidden="true"
              className="graph-selected-nodes-boundary"
              data-testid="selected-node-boundary"
              style={{
                height: selectedNodeBoundary.height,
                transform: `translate(${selectedNodeBoundary.x}px, ${selectedNodeBoundary.y}px)`,
                width: selectedNodeBoundary.width,
              }}
            />
          )}
        </ViewportPortal>
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
            data-testid="create-node"
            onClick={createAtCenter}
            title={labels.createNode}
            type="button"
          >
            <Plus size={18} />
          </button>
          <button
            aria-expanded={shortcutHelpOpen}
            aria-label={labels.shortcuts.open}
            className="canvas-icon-button"
            data-testid="canvas-shortcuts-toggle"
            onClick={() => setShortcutHelpOpen((current) => !current)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && shortcutHelpOpen) {
                event.preventDefault();
                setShortcutHelpOpen(false);
              }
            }}
            title={labels.shortcuts.open}
            type="button"
          >
            <Keyboard size={18} />
          </button>
          {shortcutHelpOpen && (
            <aside
              aria-label={labels.shortcuts.title}
              className="canvas-shortcuts-popover"
              data-testid="canvas-shortcuts-popover"
            >
              <strong>{labels.shortcuts.title}</strong>
              <dl>
                {labels.shortcuts.items.map((item) => (
                  <div key={item.id}>
                    <dt>{item.action}</dt>
                    <dd><kbd>{item.keys}</kbd></dd>
                  </div>
                ))}
              </dl>
            </aside>
          )}
        </Panel>
        </ReactFlow>
      </TotpSecondClockProvider>

      {canvasSelection !== null && (
        <div
          aria-hidden="true"
          className="graph-canvas-selection"
          data-testid="canvas-selection-marquee"
          style={{
            height: canvasSelection.height,
            transform: `translate(${canvasSelection.x}px, ${canvasSelection.y}px)`,
            width: canvasSelection.width,
          }}
        />
      )}

      {incomingReferenceBrowser !== null &&
        incomingReferenceBrowserTarget !== undefined && (
          <div
            aria-label={labels.incomingReferenceBrowserTitle}
            className="incoming-reference-browser"
            data-testid="incoming-reference-browser"
            onPointerDown={(event) => event.stopPropagation()}
            ref={incomingReferenceBrowserRef}
            role="dialog"
            style={{
              left: incomingReferenceBrowser.left,
              top: incomingReferenceBrowser.top,
            }}
          >
            <header className="incoming-reference-browser-header">
              <div>
                <strong>{labels.incomingReferenceBrowserTitle}</strong>
                <span>
                  {referencedNodeLabel(
                    incomingReferenceBrowserTarget,
                    labels.unnamed,
                    labels.noContent,
                  )}
                </span>
              </div>
              <button
                aria-label={labels.cancel}
                onClick={() => setIncomingReferenceBrowser(null)}
                title={labels.cancel}
                type="button"
              >
                <X aria-hidden="true" size={15} />
              </button>
            </header>
            <label className="incoming-reference-browser-search">
              <Search aria-hidden="true" size={14} />
              <input
                aria-label={labels.incomingReferenceBrowserSearch}
                autoFocus
                onChange={(event) =>
                  setIncomingReferenceBrowser((current) =>
                    current === null
                      ? null
                      : { ...current, query: event.target.value },
                  )
                }
                placeholder={labels.incomingReferenceBrowserSearch}
                value={incomingReferenceBrowser.query}
              />
            </label>
            <div className="incoming-reference-browser-list">
              {visibleIncomingReferenceBrowserSources.length === 0 ? (
                <p>{labels.incomingReferenceBrowserNoMatches}</p>
              ) : (
                visibleIncomingReferenceBrowserSources.map((sourceNode) => {
                  const sourceLabel = referencedNodeLabel(
                    sourceNode,
                    labels.unnamed,
                    labels.noContent,
                  );
                  return (
                    <button
                      aria-label={labels.incomingReferenceFocus(sourceLabel)}
                      key={sourceNode.id}
                      onClick={() =>
                        focusIncomingReferenceSource(sourceNode.id)
                      }
                      type="button"
                    >
                      <Link2 aria-hidden="true" size={13} />
                      <span>{sourceLabel}</span>
                    </button>
                  );
                })
              )}
            </div>
            {(canvasReferencePresentation.collapsedIncomingByTarget.get(
              incomingReferenceBrowser.targetNodeId,
            ) ?? 0) > 0 && (
              <p className="incoming-reference-browser-note">
                {labels.collapsedIncomingReferences(
                  canvasReferencePresentation.collapsedIncomingByTarget.get(
                    incomingReferenceBrowser.targetNodeId,
                  ) ?? 0,
                )}
              </p>
            )}
            <footer className="incoming-reference-browser-footer">
              <span>
                {labels.incomingReferenceBrowserShowing(
                  visibleIncomingReferenceBrowserSources.length,
                  incomingReferenceBrowserMatches.length,
                )}
              </span>
              <button
                onClick={() => {
                  onToggleReferenceFilter(
                    incomingReferenceBrowser.targetNodeId,
                  );
                  setIncomingReferenceBrowser(null);
                }}
                type="button"
              >
                <Filter aria-hidden="true" size={13} />
                <span>
                  {referenceFilterNodeIdSet.has(
                    incomingReferenceBrowser.targetNodeId,
                  )
                    ? labels.removeNodeFilter
                    : labels.incomingReferenceBrowserFilter}
                </span>
              </button>
            </footer>
          </div>
        )}

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

      {emptyStateLabel !== null && (
        <div className="graph-empty" aria-live="polite">
          <span>{emptyStateLabel}</span>
        </div>
      )}

      {contextMenu !== null && (
        <div
          className="graph-context-menu"
          data-kind={contextMenu.kind}
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
                onClick={() => {
                  fitNodeContent(contextMenu.nodeId);
                  setContextMenu(null);
                }}
                type="button"
              >
                <Maximize2 size={16} />
                <span>{labels.fitNodeContent}</span>
              </button>
              {layoutByNode.get(contextMenu.nodeId)?.width !== undefined && (
                <button
                  onClick={() => {
                    resetNodeSize(contextMenu.nodeId);
                    setContextMenu(null);
                  }}
                  type="button"
                >
                  <RotateCcw size={16} />
                  <span>{labels.resetNodeSize}</span>
                </button>
              )}
              {onCopySecret !== null &&
                (nodes.find((node) => node.id === contextMenu.nodeId)?.content
                  ?.length ?? 0) > 0 && (
                  <button
                    onClick={() => void copyNodeContentAsSecret(contextMenu.nodeId)}
                    type="button"
                  >
                    <Copy size={16} />
                    <span>{labels.copySecret}</span>
                  </button>
                )}
              {contextMenu.nodeIds.length > 1 && (
                <button
                  data-node-count={contextMenu.nodeIds.length}
                  data-testid="arrange-nodes-context-action"
                  onClick={() => {
                    openSmartArrangement(contextMenu.nodeIds);
                    setContextMenu(null);
                  }}
                  type="button"
                >
                  <LayoutGrid size={16} />
                  <span>{labels.arrangeNodes(contextMenu.nodeIds.length)}</span>
                </button>
              )}
              <button
                data-node-count={contextMenu.nodeIds.length}
                data-testid="smart-reference-context-action"
                onClick={() => {
                  onAnalyzeNodes(contextMenu.nodeIds);
                  setContextMenu(null);
                }}
                type="button"
              >
                <Sparkles size={16} />
                <span>
                  {analyzingNodeId === contextMenu.nodeId && contextMenu.nodeIds.length === 1
                    ? labels.analyzingNode
                    : contextMenu.nodeIds.length > 1
                      ? labels.smartReferenceMultiple(contextMenu.nodeIds.length)
                      : labels.smartReference}
                </span>
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

      {secretClipboardNotice !== null && (
        <div
          className="graph-status-toast"
          data-error={secretClipboardNotice.error}
          role={secretClipboardNotice.error ? "alert" : "status"}
        >
          {secretClipboardNotice.message}
        </div>
      )}

      {smartArrangement !== null && (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="smart-arrangement-dialog-title"
            aria-modal="true"
            className="confirmation-dialog smart-arrangement-dialog"
            data-testid="smart-arrangement-dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !smartArrangement.busy) {
                event.preventDefault();
                setSmartArrangement(null);
              }
            }}
            role="dialog"
          >
            <h2 id="smart-arrangement-dialog-title">
              {labels.arrangementTitle}
            </h2>
            <p>{labels.arrangementDescription(smartArrangement.nodeIds.length)}</p>
            <div className="smart-arrangement-options">
              <label>
                <span>{labels.arrangementMode}</span>
                <select
                  autoFocus
                  disabled={smartArrangement.busy}
                  onChange={(event) =>
                    setSmartArrangement((current) =>
                      current === null
                        ? null
                        : {
                            ...current,
                            error: null,
                            mode: event.target.value as SmartArrangementMode,
                          },
                    )
                  }
                  value={smartArrangement.mode}
                >
                  {(
                    [
                      "auto",
                      "overlap",
                      "relationship",
                      "grid",
                    ] as SmartArrangementMode[]
                  ).map((mode) => (
                    <option key={mode} value={mode}>
                      {labels.arrangementModes[mode]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{labels.arrangementSize}</span>
                <select
                  disabled={smartArrangement.busy}
                  onChange={(event) =>
                    setSmartArrangement((current) =>
                      current === null
                        ? null
                        : {
                            ...current,
                            error: null,
                            sizeMode: event.target
                              .value as SmartArrangementSizeMode,
                          },
                    )
                  }
                  value={smartArrangement.sizeMode}
                >
                  {(
                    [
                      "preserve",
                      "equal-width",
                      "equal-size",
                    ] as SmartArrangementSizeMode[]
                  ).map((sizeMode) => (
                    <option key={sizeMode} value={sizeMode}>
                      {labels.arrangementSizes[sizeMode]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {smartArrangement.error !== null && (
              <p className="dialog-error" role="alert">
                {smartArrangement.error}
              </p>
            )}
            <div className="confirmation-dialog-actions">
              <button
                className="secondary-button"
                disabled={smartArrangement.busy}
                onClick={() => setSmartArrangement(null)}
                type="button"
              >
                {labels.cancel}
              </button>
              <button
                className="primary-button"
                disabled={smartArrangement.busy}
                onClick={() => void applySmartArrangement()}
                type="button"
              >
                {labels.arrangementApply}
              </button>
            </div>
          </section>
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
