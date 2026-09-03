import { describe, expect, it } from "vitest";
import {
  activeWorkspaceCanvas,
  defaultCanvasId,
  isNodeNameAvailable,
  migrateWorkspaceSnapshotV3,
  migrateWorkspaceSnapshotV4,
  migrateWorkspaceSnapshotV5,
  moveNodeLayoutToFront,
  parseWorkspaceSnapshot,
  persistedNodeNameFromDraft,
  replaceWorkspaceExtensionMetadata,
  removeNodesFromWorkspaceView,
  updateNodeExtensionMetadata,
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
    references: [{ sourceNodeId: accountId, targetNodeId: serviceId }],
    view: {
      activeCanvasId: defaultCanvasId,
      canvases: [
        {
          id: defaultCanvasId,
          name: "Main",
          layout: [
            { nodeId: accountId, x: 10, y: 20 },
            { nodeId: serviceId, x: 30, y: 40 },
          ],
          viewport: { x: 100, y: -50, zoom: 1.25 },
        },
      ],
      contentProcessorByNodeId: {},
      extensionMetadata: {},
      timeline: null,
    },
  };
}

function layout(workspace: WorkspaceSnapshot) {
  return activeWorkspaceCanvas(workspace).layout;
}

function timelineWorkspace(): WorkspaceSnapshot {
  const workspace = validWorkspace();
  workspace.view.timeline = {
    canvasId: defaultCanvasId,
    days: [{ date: "1970-01-01", nodeId: accountId }],
    captures: [
      { nodeId: serviceId, capturedAtMs: 0, utcOffsetMinutes: 0, day: "1970-01-01" },
    ],
  };
  return workspace;
}

describe("workspace timeline metadata", () => {
  it("normalizes missing and undefined in-memory timeline metadata to null", () => {
    const workspace = validWorkspace();
    delete workspace.view.timeline;
    expect(parseWorkspaceSnapshot(workspace)?.view.timeline).toBeNull();
    workspace.view.timeline = undefined;
    expect(parseWorkspaceSnapshot(workspace)?.view.timeline).toBeNull();
  });

  it("requires timeline and bookmarks in a version 6 snapshot", () => {
    const workspace = validWorkspace();
    const storage = { version: 6, ...workspace };
    expect(parseWorkspaceSnapshot(storage)).toBeNull();
    storage.view.bookmarks = [];
    expect(parseWorkspaceSnapshot(storage)?.view.timeline).toBeNull();
    delete storage.view.timeline;
    expect(parseWorkspaceSnapshot(storage)).toBeNull();
  });

  it("keeps the version 5 bookmarks boundary strict during migration", () => {
    const workspace = validWorkspace();
    delete workspace.view.timeline;
    expect(migrateWorkspaceSnapshotV5(workspace)).toBeNull();
    workspace.view.bookmarks = [];
    expect(migrateWorkspaceSnapshotV5(workspace)?.view.timeline).toBeNull();
    workspace.view.timeline = null;
    expect(migrateWorkspaceSnapshotV5(workspace)).toBeNull();
  });

  it("retains capture metadata after placements and visible references are removed", () => {
    const workspace = timelineWorkspace();
    workspace.view.canvases[0].layout = [];
    workspace.references = [];
    expect(parseWorkspaceSnapshot(workspace)?.view.timeline).toEqual(workspace.view.timeline);
  });

  it("removes only deleted capture metadata while retaining its date", () => {
    const workspace = timelineWorkspace();
    const view = removeNodesFromWorkspaceView(workspace.view, new Set([serviceId]));
    expect(view.timeline).toEqual({
      canvasId: defaultCanvasId,
      days: [{ date: "1970-01-01", nodeId: accountId }],
      captures: [],
    });
    expect(workspace.view.timeline?.captures).toHaveLength(1);
  });

  it("drops dependent capture metadata when deleting a date but retains capture placements", () => {
    const workspace = timelineWorkspace();
    const view = removeNodesFromWorkspaceView(workspace.view, new Set([accountId]));
    expect(view.timeline).toEqual({ canvasId: defaultCanvasId, days: [], captures: [] });
    expect(view.canvases[0].layout).toEqual([{ nodeId: serviceId, x: 30, y: 40 }]);
    expect(removeNodesFromWorkspaceView(view, new Set())).toBe(view);
  });
});

describe("parseWorkspaceSnapshot", () => {
  it("normalizes UUID casing before validating nodes, layout, and references", () => {
    const workspace = validWorkspace();
    workspace.nodes[0].id = accountId.toUpperCase();
    layout(workspace)[0].nodeId = accountId.toUpperCase();
    workspace.references[0].sourceNodeId = accountId.toUpperCase();

    const parsed = parseWorkspaceSnapshot(workspace);

    expect(parsed?.nodes[0].id).toBe(accountId);
    expect(parsed === null ? null : layout(parsed)[0].nodeId).toBe(accountId);
    expect(parsed?.references[0].sourceNodeId).toBe(accountId);
  });

  it("rejects the same UUID written with different casing", () => {
    const workspace = validWorkspace();
    workspace.nodes[1].id = accountId.toUpperCase();
    layout(workspace)[1].nodeId = accountId.toUpperCase();
    workspace.references = [];

    expect(parseWorkspaceSnapshot(workspace)).toBeNull();
  });

  it("rejects normalized duplicate non-empty names", () => {
    const workspace = validWorkspace();
    workspace.nodes[1].name = " account ";

    expect(parseWorkspaceSnapshot(workspace)).toBeNull();
  });

  it("allows nodes outside every canvas and rejects duplicate placements within one canvas", () => {
    const missing = validWorkspace();
    layout(missing).pop();
    expect(parseWorkspaceSnapshot(missing)).not.toBeNull();

    const duplicate = validWorkspace();
    layout(duplicate)[1].nodeId = accountId;
    expect(parseWorkspaceSnapshot(duplicate)).toBeNull();
  });

  it("accepts independent manual dimensions and rejects unsafe sizes", () => {
    const manual = validWorkspace();
    layout(manual)[0] = {
      ...layout(manual)[0],
      height: 360,
      width: 480,
    };
    const parsedManual = parseWorkspaceSnapshot(manual);
    expect(parsedManual === null ? null : layout(parsedManual)[0]).toEqual(
      layout(manual)[0],
    );

    const partial = validWorkspace();
    layout(partial)[0].width = 480;
    const parsedPartial = parseWorkspaceSnapshot(partial);
    expect(parsedPartial === null ? null : layout(parsedPartial)[0]).toEqual(
      layout(partial)[0],
    );

    const unsafe = validWorkspace();
    layout(unsafe)[0] = {
      ...layout(unsafe)[0],
      height: 91,
      width: 480,
    };
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

  it("accepts a null canvas viewport and rejects invalid viewports", () => {
    const withoutViewport = validWorkspace();
    activeWorkspaceCanvas(withoutViewport).viewport = null;
    expect(parseWorkspaceSnapshot(withoutViewport)).not.toBeNull();
    const invalid = validWorkspace();
    activeWorkspaceCanvas(invalid).viewport = { x: 0, y: 0, zoom: 0 };
    expect(parseWorkspaceSnapshot(invalid)).toBeNull();
  });

  it("migrates a version 3 layout and viewport into the default canvas", () => {
    const workspace = validWorkspace();
    const currentCanvas = activeWorkspaceCanvas(workspace);
    const migrated = migrateWorkspaceSnapshotV3({
      nodes: workspace.nodes,
      layout: currentCanvas.layout,
      references: workspace.references,
      viewport: currentCanvas.viewport,
      view: {
        contentProcessorByNodeId: {},
        extensionMetadata: {},
      },
    });

    expect(migrated).toEqual(workspace);
  });

  it("accepts one node on multiple canvases with independent layout", () => {
    const workspace = validWorkspace();
    const secondCanvasId = "33333333-3333-4333-8333-333333333333";
    workspace.view.canvases.push({
      id: secondCanvasId,
      name: "Second",
      layout: [{ nodeId: accountId, x: 900, y: -300, width: 640 }],
      viewport: null,
    });

    const parsed = parseWorkspaceSnapshot(workspace);

    expect(parsed?.view.canvases[1].layout).toEqual([
      { nodeId: accountId, x: 900, y: -300, width: 640 },
    ]);
  });

  it("accepts, normalizes and validates portable canvas bookmarks", () => {
    const workspace = validWorkspace();
    const bookmarkId = "33333333-3333-4333-8333-333333333333";
    workspace.view.bookmarks = [
      {
        id: bookmarkId.toUpperCase(),
        name: "  Account focus  ",
        canvasId: defaultCanvasId.toUpperCase(),
        x: -120,
        y: 80,
        zoom: 1.5,
      },
    ];
    const parsed = parseWorkspaceSnapshot(workspace);
    expect(parsed?.view.bookmarks).toEqual([
      {
        id: bookmarkId,
        name: "Account focus",
        canvasId: defaultCanvasId,
        x: -120,
        y: 80,
        zoom: 1.5,
      },
    ]);

    const danglingCanvas = structuredClone(workspace);
    danglingCanvas.view.bookmarks![0].canvasId = bookmarkId;
    expect(parseWorkspaceSnapshot(danglingCanvas)).toBeNull();

    const duplicateName = structuredClone(workspace);
    duplicateName.view.bookmarks!.push({
      id: "44444444-4444-4444-8444-444444444444",
      name: "account focus",
      canvasId: defaultCanvasId,
      x: 0,
      y: 0,
      zoom: 1,
    });
    expect(parseWorkspaceSnapshot(duplicateName)).toBeNull();
  });

  it("migrates a version 4 workspace with no bookmarks into an empty bookmark set", () => {
    const workspace = validWorkspace();
    const migrated = migrateWorkspaceSnapshotV4({
      version: 4,
      nodes: workspace.nodes,
      references: workspace.references,
      view: {
        activeCanvasId: defaultCanvasId,
        canvases: workspace.view.canvases,
        contentProcessorByNodeId: {},
        extensionMetadata: {},
      },
    });
    expect(migrated?.view.bookmarks).toEqual([]);
  });

  it("rejects duplicate canvas identity, normalized names, and a dangling active canvas", () => {
    const duplicateId = validWorkspace();
    duplicateId.view.canvases.push({
      ...structuredClone(duplicateId.view.canvases[0]),
      name: "Second",
    });
    expect(parseWorkspaceSnapshot(duplicateId)).toBeNull();

    const duplicateName = validWorkspace();
    duplicateName.view.canvases.push({
      id: "33333333-3333-4333-8333-333333333333",
      name: " main ",
      layout: [],
      viewport: null,
    });
    expect(parseWorkspaceSnapshot(duplicateName)).toBeNull();

    const danglingActive = validWorkspace();
    danglingActive.view.activeCanvasId =
      "33333333-3333-4333-8333-333333333333";
    expect(parseWorkspaceSnapshot(danglingActive)).toBeNull();
  });

  it("rejects legacy top-level layout fields in a version 4 snapshot", () => {
    const workspace = {
      ...validWorkspace(),
      layout: [],
      viewport: null,
    };

    expect(parseWorkspaceSnapshot(workspace)).toBeNull();
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

  it("preserves namespaced metadata for unknown extensions", () => {
    const workspace = validWorkspace();
    workspace.view.extensionMetadata["dev.example.preview"] = {
      schemaVersion: 3,
      workspace: { theme: "dark", columns: ["name", "value"] },
      byNodeId: {
        [accountId.toUpperCase()]: {
          collapsed: false,
          options: { wrapLines: true },
        },
      },
    };

    const parsed = parseWorkspaceSnapshot(workspace);

    expect(parsed?.view.extensionMetadata).toEqual({
      "dev.example.preview": {
        schemaVersion: 3,
        workspace: { theme: "dark", columns: ["name", "value"] },
        byNodeId: {
          [accountId]: {
            collapsed: false,
            options: { wrapLines: true },
          },
        },
      },
    });
  });

  it("rejects invalid extension metadata envelopes, values, and dangling nodes", () => {
    const tooDeep: Record<string, unknown> = {};
    let cursor = tooDeep;
    for (let depth = 0; depth < 17; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const oversizedNodePayload = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `value${index}`,
        "x".repeat(4_096),
      ]),
    );
    const invalidCases = [
      {
        schemaVersion: 0,
        workspace: {},
        byNodeId: {},
      },
      {
        schemaVersion: 1,
        workspace: { output: "x".repeat(4_097) },
        byNodeId: {},
      },
      {
        schemaVersion: 1,
        workspace: { invalidUnicode: "\ud800" },
        byNodeId: {},
      },
      {
        schemaVersion: 1,
        workspace: { unsafeNumber: Number.MAX_SAFE_INTEGER + 1 },
        byNodeId: {},
      },
      {
        schemaVersion: 1,
        workspace: tooDeep,
        byNodeId: {},
      },
      {
        schemaVersion: 1,
        workspace: {},
        byNodeId: { [accountId]: oversizedNodePayload },
      },
      {
        schemaVersion: 1,
        workspace: {},
        byNodeId: {
          "33333333-3333-4333-8333-333333333333": {},
        },
      },
      {
        schemaVersion: 1,
        workspace: {},
        byNodeId: {},
        hiddenField: true,
      },
    ];

    for (const metadata of invalidCases) {
      const workspace = validWorkspace();
      workspace.view.extensionMetadata["dev.example.preview"] = metadata as never;
      expect(parseWorkspaceSnapshot(workspace)).toBeNull();
    }
  });
});

describe("removeNodesFromWorkspaceView", () => {
  it("removes node-owned built-in and extension metadata without touching workspace metadata", () => {
    const workspace = validWorkspace();
    workspace.view.contentProcessorByNodeId[accountId] = "markdown";
    workspace.view.extensionMetadata["dev.example.preview"] = {
      schemaVersion: 1,
      workspace: { theme: "dark" },
      byNodeId: {
        [accountId]: { collapsed: true },
        [serviceId]: { collapsed: false },
      },
    };

    expect(
      removeNodesFromWorkspaceView(workspace.view, new Set([accountId])),
    ).toEqual({
      activeCanvasId: defaultCanvasId,
      canvases: [
        {
          id: defaultCanvasId,
          name: "Main",
          layout: [{ nodeId: serviceId, x: 30, y: 40 }],
          viewport: { x: 100, y: -50, zoom: 1.25 },
        },
      ],
      contentProcessorByNodeId: {},
      extensionMetadata: {
        "dev.example.preview": {
          schemaVersion: 1,
          workspace: { theme: "dark" },
          byNodeId: { [serviceId]: { collapsed: false } },
        },
      },
      timeline: null,
    });
  });
});

describe("updateNodeExtensionMetadata", () => {
  it("updates only the selected extension and node namespace", () => {
    const workspace = validWorkspace();
    workspace.view.extensionMetadata["dev.example.other"] = {
      schemaVersion: 3,
      workspace: { retained: true },
      byNodeId: { [serviceId]: { retained: true } },
    };

    const next = updateNodeExtensionMetadata(
      workspace.view,
      workspace.nodes,
      "app.linked-info.json-inspector",
      1,
      accountId,
      { indentSize: 4 },
    );

    expect(next?.extensionMetadata).toEqual({
      "dev.example.other": workspace.view.extensionMetadata["dev.example.other"],
      "app.linked-info.json-inspector": {
        schemaVersion: 1,
        workspace: {},
        byNodeId: { [accountId]: { indentSize: 4 } },
      },
    });
    expect(workspace.view.extensionMetadata).not.toHaveProperty(
      "app.linked-info.json-inspector",
    );
  });

  it("removes canonical defaults and refuses stale schemas or missing nodes", () => {
    const workspace = validWorkspace();
    workspace.view.extensionMetadata["app.linked-info.json-inspector"] = {
      schemaVersion: 1,
      workspace: {},
      byNodeId: { [accountId]: { indentSize: 4 } },
    };

    expect(
      updateNodeExtensionMetadata(
        workspace.view,
        workspace.nodes,
        "app.linked-info.json-inspector",
        1,
        accountId,
        {},
      )?.extensionMetadata,
    ).toEqual({});
    expect(
      updateNodeExtensionMetadata(
        workspace.view,
        workspace.nodes,
        "app.linked-info.json-inspector",
        2,
        accountId,
        { indentSize: 2 },
      ),
    ).toBeNull();
    expect(
      updateNodeExtensionMetadata(
        workspace.view,
        workspace.nodes,
        "app.linked-info.json-inspector",
        1,
        "33333333-3333-4333-8333-333333333333",
        { indentSize: 4 },
      ),
    ).toBeNull();
  });
});

describe("replaceWorkspaceExtensionMetadata", () => {
  it("atomically replaces or clears exactly one validated namespace", () => {
    const workspace = validWorkspace();
    workspace.view.extensionMetadata["dev.example.preview"] = {
      schemaVersion: 1,
      workspace: { theme: "light" },
      byNodeId: { [accountId]: { collapsed: false } },
    };

    const replaced = replaceWorkspaceExtensionMetadata(
      workspace.view,
      workspace.nodes,
      "dev.example.preview",
      {
        schemaVersion: 2,
        workspace: { theme: "dark" },
        byNodeId: { [accountId]: { collapsed: true } },
      },
    );
    expect(replaced?.extensionMetadata["dev.example.preview"]).toEqual({
      schemaVersion: 2,
      workspace: { theme: "dark" },
      byNodeId: { [accountId]: { collapsed: true } },
    });
    expect(
      replaceWorkspaceExtensionMetadata(
        replaced!,
        workspace.nodes,
        "dev.example.preview",
        null,
      )?.extensionMetadata,
    ).toEqual({});
  });

  it("rejects migrated metadata that points at a missing node", () => {
    const workspace = validWorkspace();
    expect(
      replaceWorkspaceExtensionMetadata(
        workspace.view,
        workspace.nodes,
        "dev.example.preview",
        {
          schemaVersion: 2,
          workspace: {},
          byNodeId: {
            "33333333-3333-4333-8333-333333333333": { collapsed: true },
          },
        },
      ),
    ).toBeNull();
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
    const layout = activeWorkspaceCanvas(validWorkspace()).layout;

    const next = moveNodeLayoutToFront(layout, accountId);

    expect(next).toEqual([layout[1], layout[0]]);
    expect(next[1]).toBe(layout[0]);
  });

  it("keeps the same array when the node is already frontmost or missing", () => {
    const layout = activeWorkspaceCanvas(validWorkspace()).layout;

    expect(moveNodeLayoutToFront(layout, serviceId)).toBe(layout);
    expect(
      moveNodeLayoutToFront(layout, "33333333-3333-4333-8333-333333333333"),
    ).toBe(layout);
  });
});

describe("updateNodeLayoutPositions", () => {
  it("updates every dragged node while preserving the stacking order", () => {
    const layout = activeWorkspaceCanvas(validWorkspace()).layout;

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
    const layout = activeWorkspaceCanvas(validWorkspace()).layout;

    expect(updateNodeLayoutPositions(layout, layout)).toBe(layout);
  });
});

describe("updateNodeLayoutDimensions", () => {
  it("stores a manual size and preserves position changes from top or left resizing", () => {
    const layout = activeWorkspaceCanvas(validWorkspace()).layout;
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
    const layout = activeWorkspaceCanvas(validWorkspace()).layout;
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
    const layout = activeWorkspaceCanvas(validWorkspace()).layout;
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
    const layout = activeWorkspaceCanvas(validWorkspace()).layout;
    layout[0] = { ...layout[0], height: 420, width: 560 };

    expect(
      updateNodeLayoutSizeOverrides(layout, [
        { nodeId: accountId, width: null },
      ])[0],
    ).toEqual({ nodeId: accountId, x: 10, y: 20, height: 420 });
  });
});
