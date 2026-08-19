import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "./workspaceData";
import { compareWorkspaces } from "./workspaceComparison";

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
    layout: [
      { nodeId: firstId, x: 10, y: 20 },
      { nodeId: secondId, x: 30, y: 40 },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    view: { contentProcessorByNodeId: {}, extensionMetadata: {} },
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
    replacement.layout = [
      replacement.layout[0],
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
    replacement.layout = [
      { nodeId: secondId, x: 31, y: 40 },
      { nodeId: firstId, x: 10, y: 20 },
    ];

    expect(compareWorkspaces(current, replacement).changedLayouts).toBe(2);
  });

  it("counts manual node dimension changes as layout changes", () => {
    const current = workspace();
    const replacement = workspace();
    replacement.layout[0] = {
      ...replacement.layout[0],
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
    replacement.layout = [replacement.layout[1]];

    expect(compareWorkspaces(current, replacement).changedLayouts).toBe(0);
  });

  it("reports viewport-only changes", () => {
    const current = workspace();
    const replacement = workspace();
    replacement.viewport = null;

    expect(compareWorkspaces(current, replacement)).toMatchObject({
      viewportChanged: true,
      identical: false,
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
