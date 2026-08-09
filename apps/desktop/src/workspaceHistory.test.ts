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
import type { WorkspaceSnapshot } from "./workspaceData";

const nodeId = "11111111-1111-4111-8111-111111111111";

function workspace(): WorkspaceSnapshot {
  return {
    nodes: [{ id: nodeId, name: "Account", content: null }],
    layout: [{ nodeId, x: 10, y: 20 }],
    references: [],
    viewport: { x: 100, y: -50, zoom: 1.2 },
  };
}

describe("workspace history", () => {
  it("excludes viewport changes from undoable state", () => {
    const first = workspace();
    const second = { ...first, viewport: { x: 500, y: 300, zoom: 2 } };

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

    expect(restoreWorkspaceHistory(state, viewport)).toEqual({ ...state, viewport });
  });

  it("detects an undoable layout change", () => {
    const before = captureWorkspaceHistory(workspace());
    const after = {
      ...before,
      layout: [{ nodeId, x: 40, y: 60 }],
    };

    expect(workspaceHistoryStatesEqual(before, after)).toBe(false);
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
    const first = { ...base, layout: [{ nodeId, x: 20, y: 20 }] };
    const second = { ...base, layout: [{ nodeId, x: 30, y: 20 }] };
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
    const changed = { ...state, layout: [{ nodeId, x: 50, y: 60 }] };

    expect(() => appendWorkspaceHistory(emptyWorkspaceHistoryTimeline(), state, changed, 0))
      .toThrow("positive integer");
  });
});
