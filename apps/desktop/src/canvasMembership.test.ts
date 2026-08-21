import { describe, expect, it } from "vitest";
import {
  buildCanvasMembershipIndex,
  preferredCanvasForNode,
} from "./canvasMembership";
import type { WorkspaceCanvas } from "./workspaceData";

const canvases: WorkspaceCanvas[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Main",
    layout: [{ nodeId: "a", x: 0, y: 0 }],
    viewport: null,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Archive",
    layout: [
      { nodeId: "a", x: 10, y: 20 },
      { nodeId: "b", x: 30, y: 40 },
    ],
    viewport: null,
  },
];

describe("canvas membership", () => {
  it("indexes every placement in stable canvas order", () => {
    const index = buildCanvasMembershipIndex(canvases);
    expect(index.get("a")).toEqual([
      { canvasId: canvases[0].id, canvasName: "Main" },
      { canvasId: canvases[1].id, canvasName: "Archive" },
    ]);
    expect(index.get("b")).toEqual([
      { canvasId: canvases[1].id, canvasName: "Archive" },
    ]);
    expect(index.has("missing")).toBe(false);
  });

  it("prefers an explicit destination, then the active canvas, then the first placement", () => {
    const memberships = buildCanvasMembershipIndex(canvases).get("a")!;
    expect(
      preferredCanvasForNode(memberships, canvases[0].id, canvases[1].id),
    ).toBe(canvases[1].id);
    expect(preferredCanvasForNode(memberships, canvases[0].id)).toBe(
      canvases[0].id,
    );
    expect(preferredCanvasForNode(memberships, "missing")).toBe(canvases[0].id);
    expect(preferredCanvasForNode([], canvases[0].id)).toBeNull();
  });
});
