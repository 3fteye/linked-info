import { describe, expect, it } from "vitest";
import { arrangeCanvasNodes } from "./canvasAutoLayout";
import { canvasRectanglesOverlap, type CanvasRectangle } from "./canvasOverlap";

const nodes: CanvasRectangle[] = [
  { height: 100, id: "a", width: 260, x: 80, y: 120 },
  { height: 180, id: "b", width: 480, x: 120, y: 150 },
  { height: 140, id: "c", width: 320, x: 180, y: 190 },
];

describe("canvas automatic arrangement", () => {
  it("uses relationship layout for connected selections and keeps their origin", () => {
    const result = arrangeCanvasNodes(
      nodes,
      [
        { sourceNodeId: "a", targetNodeId: "b" },
        { sourceNodeId: "b", targetNodeId: "c" },
      ],
      "auto",
      "preserve",
    );
    const byId = new Map(result.nodes.map((node) => [node.id, node]));

    expect(result.mode).toBe("relationship");
    expect(byId.get("a")!.x).toBeLessThan(byId.get("b")!.x);
    expect(byId.get("b")!.x).toBeLessThan(byId.get("c")!.x);
    expect(Math.min(...result.nodes.map((node) => node.x))).toBe(80);
    expect(Math.min(...result.nodes.map((node) => node.y))).toBe(120);
  });

  it("uses a grid for disconnected selections and normalizes the typical width", () => {
    const result = arrangeCanvasNodes(nodes, [], "auto", "equal-width");

    expect(result.mode).toBe("grid");
    expect(new Set(result.nodes.map((node) => node.width))).toEqual(new Set([320]));
    expect(result.nodes.map((node) => node.height)).toEqual([100, 180, 140]);
    for (let left = 0; left < result.nodes.length; left += 1) {
      for (let right = left + 1; right < result.nodes.length; right += 1) {
        expect(
          canvasRectanglesOverlap(result.nodes[left], result.nodes[right]),
        ).toBe(false);
      }
    }
  });

  it("can explicitly use one common width and height", () => {
    const result = arrangeCanvasNodes(nodes, [], "grid", "equal-size");

    expect(new Set(result.nodes.map((node) => node.width))).toEqual(new Set([320]));
    expect(new Set(result.nodes.map((node) => node.height))).toEqual(new Set([140]));
  });
});
