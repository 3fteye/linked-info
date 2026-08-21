import { describe, expect, it } from "vitest";
import {
  activeWorkspaceCanvas,
  defaultCanvasId,
  type WorkspaceSnapshot,
} from "./workspaceData";
import {
  compareWorkspaces,
  createWorkspaceViewMetadataComparison,
} from "./workspaceComparison";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const thirdId = "33333333-3333-4333-8333-333333333333";

function workspace(): WorkspaceSnapshot {
  return {
    nodes: [
      { id: firstId, name: "账号", content: "当前内容" },
      { id: secondId, name: "OpenAI", content: null },
    ],
    references: [{ sourceNodeId: firstId, targetNodeId: secondId }],
    view: {
      activeCanvasId: defaultCanvasId,
      canvases: [
        {
          id: defaultCanvasId,
          name: "Main",
          layout: [
            { nodeId: firstId, x: 10, y: 20 },
            { nodeId: secondId, x: 30, y: 40 },
          ],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      ],
      contentProcessorByNodeId: {},
      extensionMetadata: {},
    },
  };
}

describe("workspace replacement comparison", () => {
  it("recognizes an identical workspace", () => {
    const current = workspace();
    expect(compareWorkspaces(current, structuredClone(current))).toEqual({
      addedNodes: 0,
      removedNodes: 0,
      modifiedNodes: 0,
      addedReferences: 0,
      removedReferences: 0,
      changedLayouts: 0,
      viewportChanged: false,
      viewMetadataChanged: false,
      identical: true,
    });
  });

  it("reports node and reference changes in restore direction", () => {
    const current = workspace();
    const replacement = workspace();
    replacement.nodes = [
      { ...replacement.nodes[0], content: "备份内容" },
      { id: thirdId, name: "新增节点", content: null },
    ];
    replacement.references = [{ sourceNodeId: firstId, targetNodeId: thirdId }];
    const replacementCanvas = activeWorkspaceCanvas(replacement);
    replacementCanvas.layout = [
      replacementCanvas.layout[0],
      { nodeId: thirdId, x: 50, y: 60 },
    ];

    expect(compareWorkspaces(current, replacement)).toMatchObject({
      addedNodes: 1,
      removedNodes: 1,
      modifiedNodes: 1,
      addedReferences: 1,
      removedReferences: 1,
      identical: false,
    });
  });

  it("counts coordinate and stacking-order changes for retained nodes", () => {
    const current = workspace();
    const replacement = workspace();
    activeWorkspaceCanvas(replacement).layout = [
      { nodeId: secondId, x: 31, y: 40 },
      { nodeId: firstId, x: 10, y: 20 },
    ];

    expect(compareWorkspaces(current, replacement).changedLayouts).toBe(2);
  });

  it("counts manual node dimension changes as layout changes", () => {
    const current = workspace();
    const replacement = workspace();
    const replacementCanvas = activeWorkspaceCanvas(replacement);
    replacementCanvas.layout[0] = {
      ...replacementCanvas.layout[0],
      height: 360,
      width: 480,
    };

    expect(compareWorkspaces(current, replacement).changedLayouts).toBe(1);
  });

  it("does not report retained stacking changes caused only by node removal", () => {
    const current = workspace();
    const replacement = workspace();
    replacement.nodes = [replacement.nodes[1]];
    replacement.references = [];
    const replacementCanvas = activeWorkspaceCanvas(replacement);
    replacementCanvas.layout = [replacementCanvas.layout[1]];

    expect(compareWorkspaces(current, replacement).changedLayouts).toBe(0);
  });

  it("reports viewport-only changes", () => {
    const current = workspace();
    const replacement = workspace();
    activeWorkspaceCanvas(replacement).viewport = null;

    expect(compareWorkspaces(current, replacement)).toMatchObject({
      viewportChanged: true,
      identical: false,
    });
  });

  it("compares independent placements on every canvas", () => {
    const current = workspace();
    const replacement = workspace();
    const secondCanvasId = "44444444-4444-4444-8444-444444444444";
    current.view.canvases.push({
      id: secondCanvasId,
      name: "Second",
      layout: [{ nodeId: firstId, x: 400, y: 500 }],
      viewport: null,
    });
    replacement.view.canvases.push({
      id: secondCanvasId,
      name: "Second",
      layout: [{ nodeId: firstId, x: 700, y: 500 }],
      viewport: null,
    });

    expect(compareWorkspaces(current, replacement)).toMatchObject({
      changedLayouts: 1,
      identical: false,
      viewMetadataChanged: false,
      viewportChanged: false,
    });
  });

  it("reports a canvas added without duplicating node additions", () => {
    const current = workspace();
    const replacement = workspace();
    replacement.view.canvases.push({
      id: "44444444-4444-4444-8444-444444444444",
      name: "Second",
      layout: [{ nodeId: firstId, x: 400, y: 500 }],
      viewport: null,
    });

    expect(compareWorkspaces(current, replacement)).toMatchObject({
      addedNodes: 0,
      changedLayouts: 0,
      identical: false,
      viewMetadataChanged: true,
      viewportChanged: true,
    });
  });

  it("does not treat content processor metadata changes as identical", () => {
    const current = workspace();
    const replacement = workspace();
    replacement.view.contentProcessorByNodeId[firstId] = "plugin.example";

    expect(compareWorkspaces(current, replacement)).toMatchObject({
      modifiedNodes: 1,
      viewMetadataChanged: true,
      identical: false,
    });
  });

  it("attributes node extension metadata changes to that node", () => {
    const current = workspace();
    const replacement = workspace();
    replacement.view.extensionMetadata["dev.example.preview"] = {
      schemaVersion: 1,
      workspace: {},
      byNodeId: { [firstId]: { collapsed: true } },
    };

    expect(compareWorkspaces(current, replacement)).toMatchObject({
      modifiedNodes: 1,
      viewMetadataChanged: true,
      identical: false,
    });
  });

  it("indexes extension namespaces once for repeated per-node comparisons", () => {
    const current = workspace();
    const replacement = workspace();
    const metadata = {
      "dev.example.preview": {
        schemaVersion: 1,
        workspace: {},
        byNodeId: { [firstId]: { collapsed: true } },
      },
    };
    let currentScans = 0;
    let replacementScans = 0;
    current.view.extensionMetadata = new Proxy(structuredClone(metadata), {
      ownKeys(target) {
        currentScans += 1;
        return Reflect.ownKeys(target);
      },
    });
    replacement.view.extensionMetadata = new Proxy(structuredClone(metadata), {
      ownKeys(target) {
        replacementScans += 1;
        return Reflect.ownKeys(target);
      },
    });

    const comparison = createWorkspaceViewMetadataComparison(
      current,
      replacement,
    );
    expect(comparison.nodeEqual(firstId)).toBe(true);
    expect(comparison.nodeEqual(secondId)).toBe(true);
    expect(comparison.nodeEqual(firstId)).toBe(true);
    expect({ currentScans, replacementScans }).toEqual({
      currentScans: 1,
      replacementScans: 1,
    });
  });

  it("reports workspace-level extension metadata without modifying a node", () => {
    const current = workspace();
    const replacement = workspace();
    replacement.view.extensionMetadata["dev.example.preview"] = {
      schemaVersion: 1,
      workspace: { theme: "dark" },
      byNodeId: {},
    };

    expect(compareWorkspaces(current, replacement)).toMatchObject({
      modifiedNodes: 0,
      viewMetadataChanged: true,
      identical: false,
    });
  });

  it("ignores JSON key insertion order when comparing view metadata", () => {
    const current = workspace();
    const replacement = workspace();
    current.view.contentProcessorByNodeId = {
      [firstId]: "plugin.first",
      [secondId]: "plugin.second",
    };
    replacement.view.contentProcessorByNodeId = {
      [secondId]: "plugin.second",
      [firstId]: "plugin.first",
    };
    current.view.extensionMetadata = {
      "dev.example.preview": {
        schemaVersion: 1,
        workspace: { first: 1, second: 2 },
        byNodeId: {},
      },
    };
    replacement.view.extensionMetadata = {
      "dev.example.preview": {
        schemaVersion: 1,
        workspace: { second: 2, first: 1 },
        byNodeId: {},
      },
    };

    expect(compareWorkspaces(current, replacement)).toMatchObject({
      viewMetadataChanged: false,
      identical: true,
    });
  });
});
