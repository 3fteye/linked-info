import { describe, expect, it } from "vitest";
import {
  finishWorkspaceExtensionMetadataMigration,
  prepareWorkspaceExtensionMetadataMigration,
} from "./extensionInstallLifecycle";

describe("workspace extension metadata migration lifecycle", () => {
  it("keeps stable node ids outside the untrusted migration payload", () => {
    const prepared = prepareWorkspaceExtensionMetadataMigration({
      schemaVersion: 1,
      workspace: { theme: "light" },
      byNodeId: {
        "22222222-2222-4222-8222-222222222222": { collapsed: false },
        "11111111-1111-4111-8111-111111111111": { collapsed: true },
      },
    });

    expect(JSON.stringify(prepared.input)).not.toContain("11111111");
    expect(prepared.input?.nodes).toEqual([
      { collapsed: true },
      { collapsed: false },
    ]);
    expect(
      finishWorkspaceExtensionMetadataMigration(prepared, {
        metadataMigrationId: "migration-1",
        metadata: {
          schemaVersion: 2,
          workspace: { theme: "dark" },
          nodes: [{ collapsed: false }, { collapsed: true }],
        },
      }),
    ).toEqual({
      schemaVersion: 2,
      workspace: { theme: "dark" },
      byNodeId: {
        "11111111-1111-4111-8111-111111111111": { collapsed: false },
        "22222222-2222-4222-8222-222222222222": { collapsed: true },
      },
    });
  });

  it("rejects a missing or partial migration result", () => {
    const prepared = prepareWorkspaceExtensionMetadataMigration({
      schemaVersion: 1,
      workspace: {},
      byNodeId: {
        "11111111-1111-4111-8111-111111111111": { collapsed: true },
      },
    });
    expect(() =>
      finishWorkspaceExtensionMetadataMigration(prepared, {
        metadataMigrationId: "migration-1",
        metadata: null,
      }),
    ).toThrow("extension_metadata_migration_result_invalid");
    expect(() =>
      finishWorkspaceExtensionMetadataMigration(prepared, {
        metadataMigrationId: "migration-1",
        metadata: { schemaVersion: 2, workspace: {}, nodes: [] },
      }),
    ).toThrow("extension_metadata_migration_result_invalid");
  });
});
