import type {
  InformationNode,
  NodeReference,
  WorkspaceSnapshot,
  WorkspaceViewMetadata,
} from "./workspaceData";

export interface WorkspaceHistoryViewMetadata
  extends Omit<WorkspaceViewMetadata, "activeCanvasId"> {}

export interface WorkspaceHistoryState {
  nodes: InformationNode[];
  references: NodeReference[];
  view: WorkspaceHistoryViewMetadata;
}

export interface WorkspaceHistoryEntry {
  before: WorkspaceHistoryState;
  after: WorkspaceHistoryState;
}

export interface WorkspaceHistoryTimeline {
  undo: WorkspaceHistoryEntry[];
  redo: WorkspaceHistoryEntry[];
}

export interface WorkspaceHistoryStep {
  state: WorkspaceHistoryState;
  timeline: WorkspaceHistoryTimeline;
}

export function emptyWorkspaceHistoryTimeline(): WorkspaceHistoryTimeline {
  return { undo: [], redo: [] };
}

export function captureWorkspaceHistory(
  workspace: WorkspaceSnapshot,
): WorkspaceHistoryState {
  return {
    nodes: workspace.nodes,
    references: workspace.references,
    view: {
      canvases: workspace.view.canvases,
      contentProcessorByNodeId: workspace.view.contentProcessorByNodeId,
      extensionMetadata: workspace.view.extensionMetadata,
      ...(workspace.view.bookmarks === undefined
        ? {}
        : { bookmarks: workspace.view.bookmarks }),
    },
  };
}

export function workspaceHistoryStatesEqual(
  left: WorkspaceHistoryState,
  right: WorkspaceHistoryState,
): boolean {
  const withoutViewports = (state: WorkspaceHistoryState) => ({
    ...state,
    view: {
      ...state.view,
      canvases: state.view.canvases.map(({ viewport: _viewport, ...canvas }) =>
        canvas,
      ),
    },
  });
  return JSON.stringify(withoutViewports(left)) === JSON.stringify(withoutViewports(right));
}

export function appendWorkspaceHistory(
  timeline: WorkspaceHistoryTimeline,
  before: WorkspaceHistoryState,
  after: WorkspaceHistoryState,
  limit: number,
): WorkspaceHistoryTimeline {
  if (workspaceHistoryStatesEqual(before, after)) {
    return timeline;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Workspace history limit must be a positive integer.");
  }

  return {
    undo: [...timeline.undo.slice(-(limit - 1)), { before, after }],
    redo: [],
  };
}

export function stepWorkspaceHistoryBackward(
  timeline: WorkspaceHistoryTimeline,
): WorkspaceHistoryStep | null {
  const entry = timeline.undo[timeline.undo.length - 1];
  if (entry === undefined) {
    return null;
  }
  return {
    state: entry.before,
    timeline: {
      undo: timeline.undo.slice(0, -1),
      redo: [...timeline.redo, entry],
    },
  };
}

export function stepWorkspaceHistoryForward(
  timeline: WorkspaceHistoryTimeline,
): WorkspaceHistoryStep | null {
  const entry = timeline.redo[timeline.redo.length - 1];
  if (entry === undefined) {
    return null;
  }
  return {
    state: entry.after,
    timeline: {
      undo: [...timeline.undo, entry],
      redo: timeline.redo.slice(0, -1),
    },
  };
}

export function restoreWorkspaceHistory(
  state: WorkspaceHistoryState,
  currentView: WorkspaceViewMetadata,
): WorkspaceSnapshot {
  const currentCanvasById = new Map(
    currentView.canvases.map((canvas) => [canvas.id, canvas]),
  );
  const canvases = state.view.canvases.map((canvas) => {
    const currentCanvas = currentCanvasById.get(canvas.id);
    return {
      ...canvas,
      viewport:
        currentCanvas === undefined ? canvas.viewport : currentCanvas.viewport,
    };
  });
  const fallbackCanvas = canvases[0];
  if (fallbackCanvas === undefined) {
    throw new Error("Workspace history must contain at least one canvas.");
  }
  const activeCanvasId = canvases.some(
    (canvas) => canvas.id === currentView.activeCanvasId,
  )
    ? currentView.activeCanvasId
    : fallbackCanvas.id;

  return {
    nodes: state.nodes,
    references: state.references,
    view: {
      activeCanvasId,
      canvases,
      contentProcessorByNodeId: state.view.contentProcessorByNodeId,
      extensionMetadata: state.view.extensionMetadata,
      bookmarks: state.view.bookmarks ?? currentView.bookmarks ?? [],
    },
  };
}
