import { describe, expect, it } from "vitest";
import {
  appendNodeReference,
  availableReferenceTargets,
  referenceTargetCreationName,
  referenceSearchCommand,
  shouldCreateMissingReferenceTarget,
} from "./referenceSearch";
import type { InformationNode, NodeReference } from "./workspaceStore";

const sourceId = "11111111-1111-4111-8111-111111111111";
const existingId = "22222222-2222-4222-8222-222222222222";
const selectedId = "33333333-3333-4333-8333-333333333333";
const availableId = "44444444-4444-4444-8444-444444444444";
const unnamedId = "55555555-5555-4555-8555-555555555555";

const nodes: InformationNode[] = [
  { id: sourceId, name: "Account", content: null },
  { id: existingId, name: "OpenAI", content: null },
  { id: selectedId, name: "GitHub", content: null },
  { id: availableId, name: "OpenAI Plus", content: null },
  { id: unnamedId, name: null, content: "Unsorted" },
];
const references: NodeReference[] = [
  { sourceNodeId: sourceId, targetNodeId: existingId },
];

describe("availableReferenceTargets", () => {
  it("excludes the source, existing references, and targets selected in this session", () => {
    expect(
      availableReferenceTargets(nodes, references, sourceId, [selectedId], "").map(
        (node) => node.id,
      ),
    ).toEqual([availableId, unnamedId]);
  });

  it("searches normalized node names and does not match unnamed content", () => {
    expect(
      availableReferenceTargets(nodes, references, sourceId, [], " plus ").map(
        (node) => node.id,
      ),
    ).toEqual([availableId]);
    expect(
      availableReferenceTargets(nodes, references, sourceId, [], "unsorted"),
    ).toEqual([]);
  });
});

describe("appendNodeReference", () => {
  it("appends one valid reference and rejects duplicates or self references", () => {
    const appended = appendNodeReference(references, sourceId, availableId);

    expect(appended).toEqual([
      ...references,
      { sourceNodeId: sourceId, targetNodeId: availableId },
    ]);
    expect(appendNodeReference(appended, sourceId, availableId)).toBe(appended);
    expect(appendNodeReference(appended, sourceId, sourceId)).toBe(appended);
  });
});

describe("referenceSearchCommand", () => {
  it("keeps Space distinct from Enter and maps navigation and cancellation", () => {
    expect(referenceSearchCommand(" ")).toBe("select-and-continue");
    expect(referenceSearchCommand("Enter")).toBe("select-and-close");
    expect(referenceSearchCommand("ArrowDown")).toBe("move-next");
    expect(referenceSearchCommand("ArrowUp")).toBe("move-previous");
    expect(referenceSearchCommand("Escape")).toBe("close");
    expect(referenceSearchCommand("a")).toBeNull();
  });
});

describe("referenceTargetCreationName", () => {
  it("returns a trimmed unique name and rejects blank or existing names", () => {
    expect(referenceTargetCreationName(nodes, "  New service  ")).toBe(
      "New service",
    );
    expect(referenceTargetCreationName(nodes, "   ")).toBeNull();
    expect(referenceTargetCreationName(nodes, " openai ")).toBeNull();
  });
});

describe("shouldCreateMissingReferenceTarget", () => {
  it("allows Enter confirmation but not Space continuation", () => {
    expect(shouldCreateMissingReferenceTarget("select-and-close")).toBe(true);
    expect(shouldCreateMissingReferenceTarget("select-and-continue")).toBe(false);
  });
});
