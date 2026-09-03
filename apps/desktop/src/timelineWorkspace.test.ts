import { describe, expect, it } from "vitest";
import { captureTimelineNote, TimelineCaptureError, timelineDayAt, type TimelineNoteInput } from "./timelineWorkspace";
import { emptyWorkspace, removeNodesFromWorkspaceView, type WorkspaceSnapshot } from "./workspaceData";
import { captureWorkspaceHistory, restoreWorkspaceHistory } from "./workspaceHistory";
import { parseWorkspaceExport, serializeWorkspaceExport } from "./workspaceBackup";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const labels = { canvasName: "Timeline", dateNodeName: (date: string) => date };
function ids() {
  let next = 100;
  return () => id(next++);
}
function input(number: number, date = "2026-09-03T03:00:00Z"): TimelineNoteInput {
  return { nodeId: id(number), name: "", content: `Synthetic note ${number}`, capturedAtMs: Date.parse(date), utcOffsetMinutes: 480 };
}

describe("timeline note transactions", () => {
  it("creates the canvas, date, note, placements and reference without mutating its input", () => {
    const before = emptyWorkspace();
    const snapshot = JSON.stringify(before);
    const result = captureTimelineNote(before, input(10), labels, ids());
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(result.workspace.nodes).toHaveLength(2);
    expect(result.workspace.references).toEqual([{ sourceNodeId: id(10), targetNodeId: result.dayNodeId }]);
    expect(result.workspace.view.canvases).toHaveLength(2);
    expect(result.workspace.view.activeCanvasId).toBe(before.view.activeCanvasId);
    expect(result.workspace.view.canvases[1].layout).toHaveLength(2);
    expect(result.workspace.view.timeline?.days).toEqual([{ date: "2026-09-03", nodeId: result.dayNodeId }]);
  });

  it("reuses stable date identity after renaming and appends without moving existing cards", () => {
    const newId = ids();
    const first = captureTimelineNote(emptyWorkspace(), input(10), labels, newId);
    const moved: WorkspaceSnapshot = {
      ...first.workspace,
      nodes: first.workspace.nodes.map((node) => node.id === first.dayNodeId ? { ...node, name: "Renamed day" } : node),
      view: { ...first.workspace.view, canvases: first.workspace.view.canvases.map((canvas) => canvas.id !== first.canvasId ? canvas : {
        ...canvas, name: "Renamed timeline", layout: canvas.layout.map((item) => ({ ...item, x: item.x + 900, width: 500 })),
      }) },
    };
    const previousLayout = moved.view.canvases[1].layout;
    const second = captureTimelineNote(moved, input(11), labels, newId);
    expect(second.dayNodeId).toBe(first.dayNodeId);
    expect(second.workspace.nodes).toHaveLength(3);
    expect(second.workspace.view.canvases[1].layout.slice(0, 2)).toEqual(previousLayout);
    expect(second.workspace.view.canvases[1].layout[2].x).toBeGreaterThan(previousLayout[1].x + 500);
  });

  it("inserts an out-of-order date into the formal chronological chain without moving old layouts", () => {
    const newId = ids();
    const first = captureTimelineNote(emptyWorkspace(), input(10, "2026-09-01T03:00:00Z"), labels, newId);
    const third = captureTimelineNote(first.workspace, input(12), labels, newId);
    const second = captureTimelineNote(third.workspace, input(11, "2026-09-02T03:00:00Z"), labels, newId);
    expect(second.workspace.view.timeline?.days.map((day) => day.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(second.workspace.references).toContainEqual({ sourceNodeId: first.dayNodeId, targetNodeId: second.dayNodeId });
    expect(second.workspace.references).toContainEqual({ sourceNodeId: second.dayNodeId, targetNodeId: third.dayNodeId });
    expect(second.workspace.references).not.toContainEqual({ sourceNodeId: first.dayNodeId, targetNodeId: third.dayNodeId });
    expect(second.workspace.view.canvases[1].layout.slice(0, 4)).toEqual(third.workspace.view.canvases[1].layout);
  });

  it("does not create empty days or connect every note to every other note", () => {
    const newId = ids();
    const first = captureTimelineNote(emptyWorkspace(), input(10), labels, newId);
    const second = captureTimelineNote(first.workspace, input(11, "2026-09-20T03:00:00Z"), labels, newId);
    expect(second.workspace.view.timeline?.days).toHaveLength(2);
    expect(second.workspace.references).toHaveLength(3);
    expect(second.workspace.references).not.toContainEqual({ sourceNodeId: id(10), targetNodeId: id(11) });
  });

  it("is idempotent for a lost acknowledgement and rejects reuse with different content", () => {
    const newId = ids();
    const request = input(10);
    const first = captureTimelineNote(emptyWorkspace(), request, labels, newId);
    const retry = captureTimelineNote(first.workspace, request, labels, newId);
    expect(retry.duplicate).toBe(true);
    expect(retry.workspace).toBe(first.workspace);
    expect(() => captureTimelineNote(first.workspace, { ...request, content: "Changed" }, labels, newId)).toThrowError("timeline_capture_identity-conflict");
  });

  it("rejects a colliding non-timeline node instead of treating it as a retry", () => {
    const workspace = emptyWorkspace();
    workspace.nodes.push({ id: id(10), name: null, content: "Synthetic note 10" });
    expect(() => captureTimelineNote(workspace, input(10), labels, ids())).toThrowError("timeline_capture_identity-conflict");
  });

  it("recognizes a retry after the persistence boundary canonicalizes a padded name", () => {
    const request = { ...input(10), name: "  Named record  " };
    const first = captureTimelineNote(emptyWorkspace(), request, labels, ids());
    const decoded = parseWorkspaceExport(serializeWorkspaceExport(first.workspace));
    if (!decoded.ok) throw new Error("synthetic export rejected");
    expect(captureTimelineNote(decoded.workspace, request, labels, ids()).duplicate).toBe(true);
  });

  it("uses unique generated names without relabeling user nodes or canvases", () => {
    const workspace = emptyWorkspace();
    workspace.nodes.push({ id: id(20), name: "2026-09-03", content: "User content" });
    workspace.view.canvases[0].name = "Timeline";
    const result = captureTimelineNote(workspace, input(10), labels, ids());
    expect(result.workspace.nodes.find((node) => node.id === result.dayNodeId)?.name).toBe("2026-09-03 (2)");
    expect(result.workspace.view.canvases[1].name).toBe("Timeline (2)");
    expect(result.workspace.nodes[0]).toEqual(workspace.nodes[0]);
  });

  it("preserves content exactly, including marked secrets, and does not generate a title from it", () => {
    const content = '  [[li:secret note="Synthetic"]]fake-test-password[[/li]]\n';
    const result = captureTimelineNote(emptyWorkspace(), { ...input(10), content }, labels, ids());
    expect(result.workspace.nodes.find((node) => node.id === id(10))).toEqual({ id: id(10), name: null, content });
  });

  it("rejects empty records and name collisions without partial changes", () => {
    const workspace = emptyWorkspace();
    workspace.nodes.push({ id: id(20), name: "Existing", content: null });
    const before = JSON.stringify(workspace);
    expect(() => captureTimelineNote(workspace, { ...input(10), content: " \n " }, labels, ids())).toThrowError("timeline_capture_empty-note");
    expect(() => captureTimelineNote(workspace, { ...input(10), name: " existing " }, labels, ids())).toThrowError("timeline_capture_duplicate-name");
    expect(JSON.stringify(workspace)).toBe(before);
  });

  it("uses the captured offset and rejects invalid dates, offsets and allocator collisions", () => {
    expect(timelineDayAt(Date.parse("2026-09-03T23:30:00Z"), 480)).toBe("2026-09-04");
    expect(timelineDayAt(Date.parse("2026-09-03T00:30:00Z"), -300)).toBe("2026-09-02");
    for (const args of [[NaN, 0], [1.5, 0], [-1, 0], [0, 841], [0, 0.5], [253402300799999, 840]]) {
      expect(() => timelineDayAt(args[0], args[1])).toThrow(TimelineCaptureError);
    }
    expect(() => captureTimelineNote(emptyWorkspace(), input(10), labels, () => id(10))).toThrowError("timeline_capture_identity-conflict");
  });

  it("retains a user-removed date placement when another record uses that day", () => {
    const newId = ids();
    const first = captureTimelineNote(emptyWorkspace(), input(10), labels, newId);
    const withoutPlacement = { ...first.workspace, view: { ...first.workspace.view, canvases: first.workspace.view.canvases.map((canvas) => ({ ...canvas, layout: canvas.layout.filter((item) => item.nodeId !== first.dayNodeId) })) } };
    const next = captureTimelineNote(withoutPlacement, input(11), labels, newId);
    expect(next.workspace.view.canvases[1].layout.some((item) => item.nodeId === first.dayNodeId)).toBe(false);
    expect(next.workspace.view.timeline?.days).toHaveLength(1);
  });

  it("round trips through export and restores the entire transaction with one history state", () => {
    const before = emptyWorkspace();
    const first = captureTimelineNote(before, input(10), labels, ids());
    const decoded = parseWorkspaceExport(serializeWorkspaceExport(first.workspace));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("synthetic export rejected");
    expect(decoded.workspace.view.timeline).toEqual(first.workspace.view.timeline);
    const undone = restoreWorkspaceHistory(captureWorkspaceHistory(before), first.workspace.view);
    expect(undone.nodes).toEqual(before.nodes);
    expect(undone.references).toEqual(before.references);
    expect(undone.view.timeline ?? null).toBeNull();
    expect(undone.view.canvases).toEqual(before.view.canvases);
    const redone = restoreWorkspaceHistory(captureWorkspaceHistory(first.workspace), undone.view);
    expect(redone.view.timeline).toEqual(first.workspace.view.timeline);
  });

  it("cleans managed identities on deletion without deleting other user records", () => {
    const first = captureTimelineNote(emptyWorkspace(), input(10), labels, ids());
    const view = removeNodesFromWorkspaceView(first.workspace.view, new Set([first.dayNodeId]));
    expect(view.timeline?.days).toEqual([]);
    expect(view.timeline?.captures).toEqual([]);
    expect(first.workspace.nodes.some((node) => node.id === id(10))).toBe(true);
  });
});
