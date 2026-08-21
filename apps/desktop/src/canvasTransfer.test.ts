import { describe, expect, it } from "vitest";
import {
  captureCanvasPlacements,
  pasteCanvasPlacements,
  suggestedCanvasTransferCenter,
} from "./canvasTransfer";
import type { WorkspaceSnapshot } from "./workspaceData";

const firstNodeId = "11111111-1111-4111-8111-111111111111";
const secondNodeId = "22222222-2222-4222-8222-222222222222";
const firstCanvasId = "33333333-3333-4333-8333-333333333333";
const secondCanvasId = "44444444-4444-4444-8444-444444444444";

function workspace(): WorkspaceSnapshot {
  return {
    nodes: [
      { id: firstNodeId, name: "A", content: null },
      { id: secondNodeId, name: "B", content: null },
    ],
    references: [],
    view: {
      activeCanvasId: firstCanvasId,
      canvases: [
        {
          id: firstCanvasId,
          name: "First",
          layout: [
            { nodeId: firstNodeId, x: 10, y: 20, width: 400 },
            { nodeId: secondNodeId, x: 510, y: 220 },
          ],
          viewport: null,
        },
        {
          id: secondCanvasId,
          name: "Second",
          layout: [],
          viewport: { x: -100, y: -50, zoom: 2 },
        },
      ],
      contentProcessorByNodeId: {},
      extensionMetadata: {},
    },
  };
}

describe("canvas placement transfer", () => {
  it("copies placements without cloning nodes and keeps their relative layout", () => {
    const base = workspace();
    const clipboard = captureCanvasPlacements(
      base,
      firstCanvasId,
      [firstNodeId, secondNodeId],
      "copy",
    )!;

    const result = pasteCanvasPlacements(base, clipboard, secondCanvasId, {
      x: 1_000,
      y: 800,
    });

    expect(result.workspace.nodes).toBe(base.nodes);
    expect(result.workspace.view.canvases[0].layout).toEqual(
      base.view.canvases[0].layout,
    );
    const pasted = result.workspace.view.canvases[1].layout;
    expect(pasted).toHaveLength(2);
    expect(pasted[0].width).toBe(400);
    expect(pasted[1].x - pasted[0].x).toBe(500);
    expect(pasted[1].y - pasted[0].y).toBe(200);
  });

  it("moves placements atomically and leaves an existing target placement untouched", () => {
    const base = workspace();
    base.view.canvases[1].layout = [
      { nodeId: firstNodeId, x: 7_000, y: 8_000 },
    ];
    const clipboard = captureCanvasPlacements(
      base,
      firstCanvasId,
      [firstNodeId, secondNodeId],
      "cut",
    )!;

    const result = pasteCanvasPlacements(base, clipboard, secondCanvasId, {
      x: 1_000,
      y: 800,
    });

    expect(result.workspace.view.canvases[0].layout).toEqual([]);
    expect(result.workspace.view.canvases[1].layout[0]).toEqual({
      nodeId: firstNodeId,
      x: 7_000,
      y: 8_000,
    });
    expect(result.workspace.view.canvases[1].layout).toHaveLength(2);
  });

  it("does nothing when pasting back to the source canvas", () => {
    const base = workspace();
    const clipboard = captureCanvasPlacements(
      base,
      firstCanvasId,
      [firstNodeId],
      "copy",
    )!;

    expect(
      pasteCanvasPlacements(base, clipboard, firstCanvasId, { x: 0, y: 0 })
        .workspace,
    ).toBe(base);
  });

  it("targets the saved viewport center and falls back beside existing content", () => {
    const base = workspace();
    const source = base.view.canvases[0].layout;
    expect(
      suggestedCanvasTransferCenter(
        base.view.canvases[1],
        { width: 1_000, height: 600 },
        source,
      ),
    ).toEqual({ x: 300, y: 175 });

    base.view.canvases[1].viewport = null;
    base.view.canvases[1].layout = [
      { nodeId: firstNodeId, x: 100, y: 200, width: 300, height: 200 },
    ];
    expect(
      suggestedCanvasTransferCenter(
        base.view.canvases[1],
        { width: 1_000, height: 600 },
        source,
      ).x,
    ).toBeGreaterThan(400);
  });
});
