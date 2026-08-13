import type {
  CanvasViewport,
  InformationNode,
  NodeLayout,
  NodeReference,
  WorkspaceSnapshot,
  WorkspaceViewMetadata,
} from "./workspaceData";

export interface WorkspaceHistoryState {
  nodes: InformationNode[];
  layout: NodeLayout[];
  references: NodeReference[];
  view: WorkspaceViewMetadata;
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
    layout: workspace.layout,
    references: workspace.references,
    view: workspace.view,
  };
}

export function workspaceHistoryStatesEqual(
  left: WorkspaceHistoryState,
  right: WorkspaceHistoryState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  viewport: CanvasViewport | null,
): WorkspaceSnapshot {
  return { ...state, viewport };
}
