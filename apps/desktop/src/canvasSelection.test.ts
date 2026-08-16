import { describe, expect, it } from "vitest";
import {
  canvasSelectionAutoPanDelta,
  canvasSelectionRectangle,
  nodesIntersectingCanvasSelection,
  selectedCanvasNodeBoundary,
} from "./canvasSelection";

describe("canvas selection", () => {
  it("normalizes a rectangle dragged in any direction", () => {
    expect(canvasSelectionRectangle({ x: 80, y: 60 }, { x: 20, y: 10 })).toEqual({
      x: 20,
      y: 10,
      width: 60,
      height: 50,
    });
  });

  it("selects visible nodes with a positive-area intersection", () => {
    const rectangle = canvasSelectionRectangle({ x: 0, y: 0 }, { x: 200, y: 200 });
    expect(
      nodesIntersectingCanvasSelection(
        [
          { id: "inside", x: 10, y: 10, width: 50, height: 50, hidden: false },
          { id: "partial", x: 180, y: 20, width: 50, height: 50, hidden: false },
          { id: "touching", x: 200, y: 20, width: 50, height: 50, hidden: false },
          { id: "hidden", x: 20, y: 20, width: 50, height: 50, hidden: true },
          { id: "outside", x: 300, y: 300, width: 50, height: 50, hidden: false },
        ],
        rectangle,
      ),
    ).toEqual(new Set(["inside", "partial"]));
  });

  it("keeps an auto-panned selection inside its narrow column", () => {
    const nodes = Array.from({ length: 500 }, (_, index) => {
      const column = index % 10;
      const row = Math.floor(index / 10);
      return {
        id: `node-${index}`,
        x: 100 + column * 310,
        y: 100 + row * 170,
        width: 270,
        height: 92,
        hidden: false,
      };
    });
    const selected = nodesIntersectingCanvasSelection(nodes, {
      x: 30,
      y: 30,
      width: 360,
      height: 800,
    });
    expect(selected).toEqual(
      new Set(["node-0", "node-10", "node-20", "node-30", "node-40"]),
    );
  });

  it("pans toward nearby canvas edges and stops in the center", () => {
    const size = { width: 800, height: 600 };
    expect(canvasSelectionAutoPanDelta({ x: 400, y: 300 }, size)).toEqual({
      x: 0,
      y: 0,
    });
    expect(canvasSelectionAutoPanDelta({ x: 0, y: 600 }, size)).toEqual({
      x: 15,
      y: -15,
    });
  });

  it("builds one padded boundary around multiple selected visible nodes", () => {
    expect(
      selectedCanvasNodeBoundary(
        [
          {
            id: "first",
            x: 100,
            y: 80,
            width: 270,
            height: 100,
            hidden: false,
            selected: true,
          },
          {
            id: "second",
            x: 500,
            y: 300,
            width: 270,
            height: 120,
            hidden: false,
            selected: true,
          },
          {
            id: "hidden",
            x: 900,
            y: 600,
            width: 270,
            height: 120,
            hidden: true,
            selected: true,
          },
        ],
        10,
      ),
    ).toEqual({ x: 90, y: 70, width: 690, height: 360 });
  });

  it("does not draw a group boundary for a single selected node", () => {
    expect(
      selectedCanvasNodeBoundary([
        {
          id: "only",
          x: 100,
          y: 80,
          width: 270,
          height: 100,
          hidden: false,
          selected: true,
        },
      ]),
    ).toBeNull();
  });
});
