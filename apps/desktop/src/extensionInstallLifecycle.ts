import type {
  ExtensionMetadataMigrationInput,
  ExtensionMetadataMigrationPreview,
} from "./extensionManager";
import type { WorkspaceExtensionMetadata } from "./workspaceStore";

export interface PreparedWorkspaceExtensionMetadataMigration {
  input: ExtensionMetadataMigrationInput | null;
  nodeIds: string[];
}

export function prepareWorkspaceExtensionMetadataMigration(
  metadata: WorkspaceExtensionMetadata | undefined,
): PreparedWorkspaceExtensionMetadataMigration {
  if (metadata === undefined) {
    return { input: null, nodeIds: [] };
  }
  const entries = Object.entries(metadata.byNodeId).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return {
    input: {
      schemaVersion: metadata.schemaVersion,
      workspace: metadata.workspace,
      nodes: entries.map(([, value]) => value),
    },
    nodeIds: entries.map(([nodeId]) => nodeId),
  };
}

export function finishWorkspaceExtensionMetadataMigration(
  prepared: PreparedWorkspaceExtensionMetadataMigration,
  preview: ExtensionMetadataMigrationPreview,
): WorkspaceExtensionMetadata | null {
  if (prepared.input === null) {
    if (preview.metadata !== null) {
      throw new Error("extension_metadata_migration_result_invalid");
    }
    return null;
  }
  if (
    preview.metadata === null ||
    preview.metadata.nodes.length !== prepared.nodeIds.length
  ) {
    throw new Error("extension_metadata_migration_result_invalid");
  }
  return {
    schemaVersion: preview.metadata.schemaVersion,
    workspace: preview.metadata.workspace,
    byNodeId: Object.fromEntries(
      prepared.nodeIds.map((nodeId, index) => [
        nodeId,
        preview.metadata!.nodes[index],
      ]),
    ),
  };
}
