import { describe, expect, it } from "vitest";
import {
  isNodeNameAvailable,
  moveNodeLayoutToFront,
  parseWorkspaceSnapshot,
  persistedNodeNameFromDraft,
  updateNodeLayoutDimensions,
  updateNodeLayoutSizeOverrides,
  updateNodeLayoutPositions,
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
    viewport: { x: 100, y: -50, zoom: 1.25 },
    view: { contentProcessorByNodeId: {} },
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

  it("accepts independent manual dimensions and rejects unsafe sizes", () => {
    const manual = validWorkspace();
    manual.layout[0] = {
      ...manual.layout[0],
      height: 360,
      width: 480,
    };
    expect(parseWorkspaceSnapshot(manual)?.layout[0]).toEqual(manual.layout[0]);

    const partial = validWorkspace() as WorkspaceSnapshot & {
      layout: Array<Record<string, unknown>>;
    };
    partial.layout[0].width = 480;
    expect(parseWorkspaceSnapshot(partial)?.layout[0]).toEqual(partial.layout[0]);

    const unsafe = validWorkspace();
    unsafe.layout[0] = { ...unsafe.layout[0], height: 91, width: 480 };
    expect(parseWorkspaceSnapshot(unsafe)).toBeNull();
  });

  it("rejects dangling and duplicate references", () => {
    const dangling = validWorkspace();
    dangling.references[0].targetNodeId = "33333333-3333-4333-8333-333333333333";
    expect(parseWorkspaceSnapshot(dangling)).toBeNull();

    const duplicate = validWorkspace();
    duplicate.references.push({ ...duplicate.references[0] });
    expect(parseWorkspaceSnapshot(duplicate)).toBeNull();
  });

  it("accepts legacy snapshots without a viewport and rejects invalid viewports", () => {
    const { viewport: _viewport, ...legacy } = validWorkspace();
    expect(parseWorkspaceSnapshot(legacy)?.viewport).toBeNull();

    const invalid = validWorkspace();
    invalid.viewport = { x: 0, y: 0, zoom: 0 };
    expect(parseWorkspaceSnapshot(invalid)).toBeNull();
  });

  it("preserves unknown content processor ids and rejects dangling selections", () => {
    const workspace = validWorkspace();
    workspace.view.contentProcessorByNodeId[accountId] = "plugin.example";
    expect(parseWorkspaceSnapshot(workspace)?.view).toEqual(workspace.view);

    workspace.view.contentProcessorByNodeId[
      "33333333-3333-4333-8333-333333333333"
    ] = "plugin.example";
    expect(parseWorkspaceSnapshot(workspace)).toBeNull();
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

describe("persistedNodeNameFromDraft", () => {
  it("keeps meaningful editing text but never exposes whitespace-only names to persistence", () => {
    expect(persistedNodeNameFromDraft("   \t")).toBeNull();
    expect(persistedNodeNameFromDraft(" OpenAI ")).toBe(" OpenAI ");
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

describe("updateNodeLayoutPositions", () => {
  it("updates every dragged node while preserving the stacking order", () => {
    const layout = validWorkspace().layout;

    const next = updateNodeLayoutPositions(layout, [
      { nodeId: accountId, x: 110, y: 120 },
      { nodeId: serviceId, x: 230, y: 240 },
    ]);

    expect(next).toEqual([
      { nodeId: accountId, x: 110, y: 120 },
      { nodeId: serviceId, x: 230, y: 240 },
    ]);
    expect(next.map((item) => item.nodeId)).toEqual([accountId, serviceId]);
  });

  it("keeps the same array when no position changed", () => {
    const layout = validWorkspace().layout;

    expect(updateNodeLayoutPositions(layout, layout)).toBe(layout);
  });
});

describe("updateNodeLayoutDimensions", () => {
  it("stores a manual size and preserves position changes from top or left resizing", () => {
    const layout = validWorkspace().layout;
    expect(
      updateNodeLayoutDimensions(layout, accountId, {
        height: 420,
        width: 560,
        x: -25,
        y: -35,
      }),
    ).toEqual([
      { nodeId: accountId, x: -25, y: -35, width: 560, height: 420 },
      layout[1],
    ]);
  });

  it("removes only saved dimensions when returning to automatic size", () => {
    const layout = validWorkspace().layout;
    layout[0] = { ...layout[0], height: 420, width: 560 };
    expect(updateNodeLayoutDimensions(layout, accountId, null)[0]).toEqual({
      nodeId: accountId,
      x: 10,
      y: 20,
    });
  });
});

describe("updateNodeLayoutSizeOverrides", () => {
  it("can normalize width without disabling automatic height", () => {
    const layout = validWorkspace().layout;
    const next = updateNodeLayoutSizeOverrides(layout, [
      { nodeId: accountId, width: 360 },
      { nodeId: serviceId, width: 360 },
    ]);

    expect(next).toEqual([
      { nodeId: accountId, x: 10, y: 20, width: 360 },
      { nodeId: serviceId, x: 30, y: 40, width: 360 },
    ]);
  });

  it("preserves an untouched axis and can clear one override", () => {
    const layout = validWorkspace().layout;
    layout[0] = { ...layout[0], height: 420, width: 560 };

    expect(
      updateNodeLayoutSizeOverrides(layout, [
        { nodeId: accountId, width: null },
      ])[0],
    ).toEqual({ nodeId: accountId, x: 10, y: 20, height: 420 });
  });
});
