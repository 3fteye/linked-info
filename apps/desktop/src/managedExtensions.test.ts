import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invokeManagedExtensionAction,
  managedExtensionRegistry,
} from "./managedExtensions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("managed extension frontend boundary", () => {
  afterEach(() => {
    vi.mocked(invoke).mockReset();
    managedExtensionRegistry.replace([]);
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
