import { describe, expect, it } from "vitest";
import {
  avoidCanvasNodeOverlaps,
  canvasRectanglesOverlap,
  removeAllCanvasNodeOverlaps,
  type CanvasRectangle,
} from "./canvasOverlap";

function rectangle(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 80,
): CanvasRectangle {
  return { height, id, width, x, y };
}

describe("canvas overlap removal", () => {
  it("keeps the resized anchor fixed and moves only its collision chain", () => {
    const nodes = [
      rectangle("anchor", 0, 0, 180, 100),
      rectangle("first", 150, 10),
      rectangle("second", 260, 10),
      rectangle("unrelated-a", 1_000, 0),
      rectangle("unrelated-b", 1_020, 10),
    ];
    const result = avoidCanvasNodeOverlaps(nodes, new Set(["anchor"]));
    const byId = new Map(result.map((node) => [node.id, node]));

    expect(byId.get("anchor")).toEqual(nodes[0]);
    expect(byId.get("first")).not.toEqual(nodes[1]);
    expect(byId.get("second")).not.toEqual(nodes[2]);
    expect(byId.get("unrelated-a")).toEqual(nodes[3]);
    expect(byId.get("unrelated-b")).toEqual(nodes[4]);
    expect(
      canvasRectanglesOverlap(byId.get("anchor")!, byId.get("first")!),
    ).toBe(false);
    expect(
      canvasRectanglesOverlap(byId.get("first")!, byId.get("second")!),
    ).toBe(false);
  });

  it("removes every overlap in an explicit selection while retaining its origin", () => {
    const nodes = [
      rectangle("a", 40, 60),
      rectangle("b", 50, 70),
      rectangle("c", 60, 80),
    ];
    const result = removeAllCanvasNodeOverlaps(nodes);

    expect(Math.min(...result.map((node) => node.x))).toBeLessThanOrEqual(40);
    for (let left = 0; left < result.length; left += 1) {
      for (let right = left + 1; right < result.length; right += 1) {
        expect(canvasRectanglesOverlap(result[left], result[right])).toBe(false);
      }
    }
  });
});
