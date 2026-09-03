import { describe, expect, it } from "vitest";
import {
  appendWorkspaceHistory,
  captureWorkspaceHistory,
  emptyWorkspaceHistoryTimeline,
  restoreWorkspaceHistory,
  stepWorkspaceHistoryBackward,
  stepWorkspaceHistoryForward,
  workspaceHistoryStatesEqual,
} from "./workspaceHistory";
import {
  activeWorkspaceCanvas,
  defaultCanvasId,
  type WorkspaceSnapshot,
} from "./workspaceData";

const nodeId = "11111111-1111-4111-8111-111111111111";

function workspace(): WorkspaceSnapshot {
  return {
    nodes: [{ id: nodeId, name: "Account", content: null }],
    references: [],
    view: {
      activeCanvasId: defaultCanvasId,
      canvases: [
        {
          id: defaultCanvasId,
          name: "Main",
          layout: [{ nodeId, x: 10, y: 20 }],
          viewport: { x: 100, y: -50, zoom: 1.2 },
        },
      ],
      contentProcessorByNodeId: {},
      extensionMetadata: {},
    },
  };
}

describe("workspace history", () => {
  it("undoes and redoes timeline creation without retaining the current metadata", () => {
    const first = workspace();
    const second = structuredClone(first);
    second.view.timeline = {
      canvasId: defaultCanvasId,
      days: [{ date: "1970-01-01", nodeId }],
      captures: [],
    };
    const before = captureWorkspaceHistory(first);
    const after = captureWorkspaceHistory(second);
    const timeline = appendWorkspaceHistory(emptyWorkspaceHistoryTimeline(), before, after, 100);
    const undone = stepWorkspaceHistoryBackward(timeline);

    expect(before.view.timeline).toBeNull();
    expect(restoreWorkspaceHistory(undone!.state, second.view).view.timeline).toBeNull();
    const redone = stepWorkspaceHistoryForward(undone!.timeline);
    expect(restoreWorkspaceHistory(redone!.state, first.view).view.timeline).toEqual(
      second.view.timeline,
    );
  });

  it("treats absent and null timeline metadata as equal history state", () => {
    const before = captureWorkspaceHistory(workspace());
    const after = structuredClone(before);
    delete before.view.timeline;
    after.view.timeline = null;
    expect(workspaceHistoryStatesEqual(before, after)).toBe(true);
  });

  it("excludes viewport changes from undoable state", () => {
    const first = workspace();
    const second = structuredClone(first);
    activeWorkspaceCanvas(second).viewport = { x: 500, y: 300, zoom: 2 };

    expect(
      workspaceHistoryStatesEqual(
        captureWorkspaceHistory(first),
        captureWorkspaceHistory(second),
      ),
    ).toBe(true);
  });

  it("restores nodes, references, and layout while preserving the current viewport", () => {
    const state = captureWorkspaceHistory(workspace());
    const viewport = { x: -20, y: 80, zoom: 0.7 };
    const currentView = structuredClone(workspace().view);
    currentView.canvases[0].viewport = viewport;

    expect(
      activeWorkspaceCanvas(restoreWorkspaceHistory(state, currentView)).viewport,
    ).toEqual(viewport);
  });

  it("detects an undoable layout change", () => {
    const before = captureWorkspaceHistory(workspace());
    const after = structuredClone(before);
    after.view.canvases[0].layout = [{ nodeId, x: 40, y: 60 }];

    expect(workspaceHistoryStatesEqual(before, after)).toBe(false);
  });

  it("includes content processor choices in undoable state", () => {
    const before = captureWorkspaceHistory(workspace());
    const after = {
      ...before,
      view: {
        ...before.view,
        contentProcessorByNodeId: { [nodeId]: "plugin.example" },
      },
    };

    expect(workspaceHistoryStatesEqual(before, after)).toBe(false);
    expect(
      restoreWorkspaceHistory(after, workspace().view).view
        .contentProcessorByNodeId,
    ).toEqual(after.view.contentProcessorByNodeId);
  });

  it("keeps position bookmarks in the undoable state", () => {
    const before = captureWorkspaceHistory(workspace());
    const after = structuredClone(before);
    after.view.bookmarks = [
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Account focus",
        canvasId: defaultCanvasId,
        x: -40,
        y: 80,
        zoom: 1.3,
      },
    ];

    const timeline = appendWorkspaceHistory(
      emptyWorkspaceHistoryTimeline(),
      before,
      after,
      100,
    );

    expect(stepWorkspaceHistoryBackward(timeline)?.state).toEqual(before);
    expect(
      restoreWorkspaceHistory(after, workspace().view).view.bookmarks,
    ).toEqual(after.view.bookmarks);
  });

  it("undoes the first bookmark when the source workspace omitted bookmarks", () => {
    const before = captureWorkspaceHistory(workspace());
    const afterWorkspace = structuredClone(workspace());
    afterWorkspace.view.bookmarks = [
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "First focus",
        canvasId: defaultCanvasId,
        x: 40,
        y: 50,
        zoom: 1.1,
      },
    ];
    const after = captureWorkspaceHistory(afterWorkspace);

    expect(before.view.bookmarks).toEqual([]);
    const timeline = appendWorkspaceHistory(
      emptyWorkspaceHistoryTimeline(),
      before,
      after,
      100,
    );
    const undone = stepWorkspaceHistoryBackward(timeline);

    expect(undone?.state.view.bookmarks).toEqual([]);
    expect(
      restoreWorkspaceHistory(undone!.state, afterWorkspace.view).view.bookmarks,
    ).toEqual([]);
  });

  it("keeps unknown extension metadata inside the same undo transaction", () => {
    const before = captureWorkspaceHistory(workspace());
    const after = structuredClone(before);
    after.view.extensionMetadata["dev.example.preview"] = {
      schemaVersion: 1,
      workspace: { theme: "dark" },
      byNodeId: { [nodeId]: { collapsed: true } },
    };

    const timeline = appendWorkspaceHistory(
      emptyWorkspaceHistoryTimeline(),
      before,
      after,
      100,
    );

    expect(stepWorkspaceHistoryBackward(timeline)?.state).toEqual(before);
    expect(
      restoreWorkspaceHistory(after, workspace().view).view.extensionMetadata,
    ).toEqual(after.view.extensionMetadata);
  });

  it("steps backward and forward through an operation", () => {
    const before = captureWorkspaceHistory(workspace());
    const after = { ...before, nodes: [{ ...before.nodes[0], name: "Updated" }] };
    const recorded = appendWorkspaceHistory(
      emptyWorkspaceHistoryTimeline(),
      before,
      after,
      100,
    );

    const undone = stepWorkspaceHistoryBackward(recorded);
    expect(undone?.state).toEqual(before);
    expect(undone?.timeline.undo).toHaveLength(0);
    expect(undone?.timeline.redo).toHaveLength(1);

    const redone = stepWorkspaceHistoryForward(undone!.timeline);
    expect(redone?.state).toEqual(after);
    expect(redone?.timeline.undo).toHaveLength(1);
    expect(redone?.timeline.redo).toHaveLength(0);
  });

  it("caps undo entries and clears redo when a new operation is recorded", () => {
    const base = captureWorkspaceHistory(workspace());
    const first = structuredClone(base);
    first.view.canvases[0].layout = [{ nodeId, x: 20, y: 20 }];
    const second = structuredClone(base);
    second.view.canvases[0].layout = [{ nodeId, x: 30, y: 20 }];
    let timeline = appendWorkspaceHistory(
      emptyWorkspaceHistoryTimeline(),
      base,
      first,
      1,
    );
    const undone = stepWorkspaceHistoryBackward(timeline)!;
    timeline = appendWorkspaceHistory(undone.timeline, first, second, 1);

    expect(timeline.undo).toHaveLength(1);
    expect(timeline.undo[0].after).toEqual(second);
    expect(timeline.redo).toHaveLength(0);
  });

  it("rejects an invalid history limit", () => {
    const state = captureWorkspaceHistory(workspace());
    const changed = structuredClone(state);
    changed.view.canvases[0].layout = [{ nodeId, x: 50, y: 60 }];

    expect(() => appendWorkspaceHistory(emptyWorkspaceHistoryTimeline(), state, changed, 0))
      .toThrow("positive integer");
  });

  it("preserves the currently selected canvas across undo", () => {
    const original = workspace();
    const secondCanvasId = "22222222-2222-4222-8222-222222222222";
    original.view.canvases.push({
      id: secondCanvasId,
      name: "Second",
      layout: [{ nodeId, x: 300, y: 400 }],
      viewport: { x: 20, y: 30, zoom: 0.9 },
    });
    const state = captureWorkspaceHistory(original);
    const currentView = structuredClone(original.view);
    currentView.activeCanvasId = secondCanvasId;

    const restored = restoreWorkspaceHistory(state, currentView);

    expect(restored.view.activeCanvasId).toBe(secondCanvasId);
    expect(activeWorkspaceCanvas(restored).viewport).toEqual({
      x: 20,
      y: 30,
      zoom: 0.9,
    });
  });

  it("restores the last saved viewport when undo brings back a deleted canvas", () => {
    const original = workspace();
    const secondCanvasId = "22222222-2222-4222-8222-222222222222";
    original.view.canvases.push({
      id: secondCanvasId,
      name: "Second",
      layout: [],
      viewport: { x: 500, y: -200, zoom: 1.4 },
    });
    const state = captureWorkspaceHistory(original);
    const currentView = structuredClone(original.view);
    currentView.canvases.pop();

    const restored = restoreWorkspaceHistory(state, currentView);

    expect(restored.view.canvases[1].viewport).toEqual({
      x: 500,
      y: -200,
      zoom: 1.4,
    });
  });
});
