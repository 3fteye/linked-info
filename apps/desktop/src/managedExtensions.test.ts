import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invokeManagedExtensionAction,
  managedExtensionNodeInputForWorkspace,
  managedExtensionRegistry,
} from "./managedExtensions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("managed extension frontend boundary", () => {
  afterEach(() => {
    vi.mocked(invoke).mockReset();
    managedExtensionRegistry.replace([]);
  });

  it("loads full current node content only at the active action boundary", () => {
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const targetId = "22222222-2222-4222-8222-222222222222";
    const fullContent = "full action content ".repeat(1_000);
    const input = managedExtensionNodeInputForWorkspace(
      {
        nodes: [
          { id: sourceId, name: "Source", content: fullContent },
          { id: targetId, name: "Target", content: null },
        ],
        references: [{ sourceNodeId: sourceId, targetNodeId: targetId }],
        view: {
          activeCanvasId: "00000000-0000-4000-8000-000000000001",
          canvases: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              name: "Main",
              layout: [
                { nodeId: sourceId, x: 0, y: 0 },
                { nodeId: targetId, x: 300, y: 0 },
              ],
              viewport: null,
            },
          ],
          contentProcessorByNodeId: {},
          extensionMetadata: {},
        },
      },
      sourceId,
    );

    expect(input?.content).toBe(fullContent);
    expect(input?.directOutgoingNodeIds).toEqual([targetId]);
    expect(input?.directIncomingNodeIds).toEqual([]);
  });

  it("normalizes wire handles to bigint without exposing them as stable ids", async () => {
    vi.mocked(invoke).mockResolvedValue({
      extensionId: "dev.example.preview",
      metadataSchemaVersion: 1,
      handleNodeIds: {
        "1": "11111111-1111-4111-8111-111111111111",
        "2": "22222222-2222-4222-8222-222222222222",
      },
      result: {
        presentation: null,
        nodeMetadata: null,
        workspaceMetadata: null,
        proposal: {
          baseRevision: 7,
          titleKey: "proposal.link",
          operations: [
            {
              type: "create-reference",
              source: { kind: "existing", handle: 1 },
              target: { kind: "existing", handle: 2 },
            },
          ],
        },
      },
    });

    const result = await invokeManagedExtensionAction(
      "dev.example.preview",
      "link",
      [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Source",
          content: "Content",
          directOutgoingNodeIds: [],
          directIncomingNodeIds: [],
        },
      ],
      null,
      null,
      7,
    );

    expect(result.handleNodeIds).toEqual(
      new Map([
        [1n, "11111111-1111-4111-8111-111111111111"],
        [2n, "22222222-2222-4222-8222-222222222222"],
      ]),
    );
    expect(result.proposal?.operations).toEqual([
      {
        type: "create-reference",
        source: { kind: "existing", handle: 1n },
        target: { kind: "existing", handle: 2n },
      },
    ]);
  });
});
