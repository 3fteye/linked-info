import { describe, expect, it } from "vitest";
import { buildCanvasReferencePresentation } from "./canvasReferencePresentation";
import type { NodeReference } from "./workspaceStore";

function referencesTo(targetNodeId: string, count: number): NodeReference[] {
  return Array.from({ length: count }, (_, index) => ({
    sourceNodeId: `${targetNodeId}-source-${index}`,
    targetNodeId,
  }));
}

describe("canvas reference presentation", () => {
  it("keeps sparse relationships unchanged", () => {
    const references = referencesTo("target-a", 3);
    const result = buildCanvasReferencePresentation(references, 4);

    expect(result.visibleReferences).toEqual(references);
    expect(result.collapsedIncomingByTarget.size).toBe(0);
  });

  it("caps only dense incoming edges while preserving their data count", () => {
    const dense = referencesTo("source-document", 222);
    const sparse = referencesTo("service", 3);
    const result = buildCanvasReferencePresentation([...dense, ...sparse], 40);

    expect(result.visibleReferences).toHaveLength(43);
    expect(result.visibleReferences.filter((item) => item.targetNodeId === "service"))
      .toHaveLength(3);
    expect(result.collapsedIncomingByTarget.get("source-document")).toBe(182);
  });

  it("rejects an invalid rendering cap", () => {
    expect(() => buildCanvasReferencePresentation([], 0)).toThrow("positive integer");
  });
});
