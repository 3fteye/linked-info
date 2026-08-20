import { describe, expect, it } from "vitest";
import { reconcileSmartReferenceAcceptance } from "./smartReferenceAcceptance";

describe("smart reference acceptance", () => {
  it("drops deleted automatic references from accepted result state", () => {
    expect(
      reconcileSmartReferenceAcceptance(
        "source",
        ["source", "automatic", "manual"],
        [{ sourceNodeId: "source", targetNodeId: "manual" }],
        ["automatic"],
      ),
    ).toEqual({
      acceptedNodeIds: ["manual"],
      automaticallyAddedNodeIds: [],
    });
  });

  it("keeps only existing targets referenced by the analyzed source", () => {
    expect(
      reconcileSmartReferenceAcceptance(
        "source",
        ["source", "automatic"],
        [
          { sourceNodeId: "source", targetNodeId: "automatic" },
          { sourceNodeId: "other", targetNodeId: "automatic" },
          { sourceNodeId: "source", targetNodeId: "deleted" },
        ],
        ["automatic", "deleted"],
      ),
    ).toEqual({
      acceptedNodeIds: ["automatic"],
      automaticallyAddedNodeIds: ["automatic"],
    });
  });
});
