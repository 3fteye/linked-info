import { describe, expect, it } from "vitest";
import {
  isNodeNameAvailable,
  moveNodeLayoutToFront,
  parseWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "./workspaceData";

const accountId = "11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";

function validWorkspace(): WorkspaceSnapshot {
  return {
    nodes: [
      { id: accountId, name: "Account", content: null },
      { id: serviceId, name: "OpenAI", content: "Shared service" },
    ],
    layout: [
      { nodeId: accountId, x: 10, y: 20 },
      { nodeId: serviceId, x: 30, y: 40 },
    ],
    references: [{ sourceNodeId: accountId, targetNodeId: serviceId }],
  };
}

describe("parseWorkspaceSnapshot", () => {
  it("normalizes UUID casing before validating nodes, layout, and references", () => {
    const workspace = validWorkspace();
    workspace.nodes[0].id = accountId.toUpperCase();
    workspace.layout[0].nodeId = accountId.toUpperCase();
    workspace.references[0].sourceNodeId = accountId.toUpperCase();

    const parsed = parseWorkspaceSnapshot(workspace);

    expect(parsed?.nodes[0].id).toBe(accountId);
    expect(parsed?.layout[0].nodeId).toBe(accountId);
    expect(parsed?.references[0].sourceNodeId).toBe(accountId);
  });

  it("rejects the same UUID written with different casing", () => {
    const workspace = validWorkspace();
    workspace.nodes[1].id = accountId.toUpperCase();
    workspace.layout[1].nodeId = accountId.toUpperCase();
    workspace.references = [];

    expect(parseWorkspaceSnapshot(workspace)).toBeNull();
  });

  it("rejects normalized duplicate non-empty names", () => {
    const workspace = validWorkspace();
    workspace.nodes[1].name = " account ";

    expect(parseWorkspaceSnapshot(workspace)).toBeNull();
  });

  it("rejects missing or duplicate layout entries", () => {
    const missing = validWorkspace();
    missing.layout.pop();
    expect(parseWorkspaceSnapshot(missing)).toBeNull();

    const duplicate = validWorkspace();
    duplicate.layout[1].nodeId = accountId;
    expect(parseWorkspaceSnapshot(duplicate)).toBeNull();
  });

  it("rejects dangling and duplicate references", () => {
    const dangling = validWorkspace();
    dangling.references[0].targetNodeId = "33333333-3333-4333-8333-333333333333";
    expect(parseWorkspaceSnapshot(dangling)).toBeNull();

    const duplicate = validWorkspace();
    duplicate.references.push({ ...duplicate.references[0] });
    expect(parseWorkspaceSnapshot(duplicate)).toBeNull();
  });
});

describe("isNodeNameAvailable", () => {
  it("allows empty or unchanged names and rejects another node's normalized name", () => {
    const nodes = validWorkspace().nodes;

    expect(isNodeNameAvailable(nodes, accountId, "")).toBe(true);
    expect(isNodeNameAvailable(nodes, accountId, " Account ")).toBe(true);
    expect(isNodeNameAvailable(nodes, accountId, " openai ")).toBe(false);
  });
});

describe("moveNodeLayoutToFront", () => {
  it("moves the interacted node to the end without changing coordinates", () => {
    const layout = validWorkspace().layout;

    const next = moveNodeLayoutToFront(layout, accountId);

    expect(next).toEqual([layout[1], layout[0]]);
    expect(next[1]).toBe(layout[0]);
  });

  it("keeps the same array when the node is already frontmost or missing", () => {
    const layout = validWorkspace().layout;

    expect(moveNodeLayoutToFront(layout, serviceId)).toBe(layout);
    expect(
      moveNodeLayoutToFront(layout, "33333333-3333-4333-8333-333333333333"),
    ).toBe(layout);
  });
});
