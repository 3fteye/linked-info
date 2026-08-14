import { describe, expect, it } from "vitest";
import {
  buildBatchedReferencePaths,
  buildReferenceCurves,
  findReferenceCurveAtPoint,
  partitionReferencesByMovingNodes,
  referenceCurveId,
} from "./batchedReferenceLayer";

const reference = { sourceNodeId: "source", targetNodeId: "target" };
const nodes = [
  { id: "source", x: 10, y: 20, width: 100, height: 80, hidden: false },
  { id: "target", x: 310, y: 120, width: 100, height: 100, hidden: false },
];

describe("batched reference layer", () => {
  it("builds one curve from the measured node handle centers", () => {
    expect(buildReferenceCurves([reference], nodes)).toEqual([
      {
        controlX: 210,
        id: referenceCurveId(reference),
        sourceNodeId: "source",
        sourceX: 110,
        sourceY: 60,
        targetNodeId: "target",
        targetX: 310,
        targetY: 170,
      },
    ]);
  });

  it("omits references whose source or target is hidden", () => {
    expect(
      buildReferenceCurves(
        [reference],
        nodes.map((node) => (node.id === "target" ? { ...node, hidden: true } : node)),
      ),
    ).toEqual([]);
  });

  it("batches normal curves separately from the selected curve", () => {
    const curves = buildReferenceCurves([reference], nodes);
    const selectedId = referenceCurveId(reference);
    expect(buildBatchedReferencePaths(curves, null)).toEqual({
      normal: "M 110 60 C 210 60, 210 170, 310 170",
      selected: "",
    });
    expect(buildBatchedReferencePaths(curves, selectedId)).toEqual({
      normal: "",
      selected: "M 110 60 C 210 60, 210 170, 310 170",
    });
  });

  it("separates only references incident to moving nodes", () => {
    const references = [
      { sourceNodeId: "moving", targetNodeId: "target" },
      { sourceNodeId: "source", targetNodeId: "moving" },
      { sourceNodeId: "source", targetNodeId: "target" },
    ];
    expect(partitionReferencesByMovingNodes(references, new Set(["moving"]))).toEqual({
      moving: references.slice(0, 2),
      stationary: references.slice(2),
    });
  });

  it("hit-tests the batched geometry without individual SVG paths", () => {
    const curves = buildReferenceCurves([reference], nodes);
    expect(findReferenceCurveAtPoint(curves, { x: 210, y: 115 }, 12)?.id).toBe(
      referenceCurveId(reference),
    );
    expect(findReferenceCurveAtPoint(curves, { x: 210, y: 220 }, 12)).toBeNull();
  });
});
