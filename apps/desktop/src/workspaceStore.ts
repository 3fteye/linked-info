import {
  migrateWorkspaceSnapshotV1,
  migrateWorkspaceSnapshotV2,
  migrateWorkspaceSnapshotV3,
  migrateWorkspaceSnapshotV4,
  migrateWorkspaceSnapshotV5,
  parseWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "./workspaceData";

export {
  activeWorkspaceCanvas,
  defaultCanvasId,
  defaultCanvasName,
  emptyWorkspace,
  isNodeNameAvailable,
  isUnnamedNode,
  maximumCanvasBookmarkCount,
  maximumManualNodeDimension,
  maximumWorkspaceCanvasCount,
  minimumManualNodeHeight,
  minimumManualNodeWidth,
  moveNodeLayoutToFront,
  normalizeNodeName,
  persistedNodeNameFromDraft,
  replaceWorkspaceExtensionMetadata,
  removeNodesFromWorkspaceView,
  updateNodeLayoutDimensions,
  updateNodeLayoutSizeOverrides,
  updateNodeLayoutPositions,
  updateWorkspaceCanvas,
  updateNodeExtensionMetadata,
  type CanvasViewport,
  type CanvasBookmark,
  type InformationNode,
  type NodeLayout,
  type NodeLayoutSizeOverrideUpdate,
  type NodeReference,
  type ExtensionMetadataJsonValue,
  type ExtensionMetadataPayload,
  type WorkspaceSnapshot,
  type WorkspaceCanvas,
  type WorkspaceExtensionMetadata,
  type WorkspaceViewMetadata,
  type WorkspaceTimeline,
  type WorkspaceTimelineDay,
  type WorkspaceTimelineCapture,
} from "./workspaceData";

export type WorkspaceLoadResult =
  | { status: "missing" }
  | { status: "ready"; workspace: WorkspaceSnapshot }
  | { status: "invalid"; raw: string };

export type WorkspaceSwapResult =
  | { status: "committed"; workspace: WorkspaceSnapshot }
  | { status: "reloadRequired" };

export interface WorkspacePersistence {
  load(): Promise<WorkspaceLoadResult>;
  loadRecovery(): Promise<WorkspaceLoadResult>;
  preserveForRecovery(workspace: WorkspaceSnapshot): Promise<void>;
  runExclusiveTransaction<T>(transaction: () => Promise<T>): Promise<T>;
  save(workspace: WorkspaceSnapshot): Promise<void>;
  swapWithRecovery(): Promise<WorkspaceSwapResult>;
}

export type WorkspaceStorageSlot = "primary" | "recovery";

const workspaceStorageKey = "linked-info.workspace.v1";
const workspaceRecoveryStorageKey = "linked-info.workspace.recovery.v1";
export const currentWorkspaceStorageVersion = 6;

function storageKey(slot: WorkspaceStorageSlot): string {
  return slot === "primary" ? workspaceStorageKey : workspaceRecoveryStorageKey;
}

export function parseStoredWorkspaceText(raw: string): WorkspaceLoadResult {
  let stored: unknown;
  try {
    stored = JSON.parse(raw) as unknown;
  } catch {
    return { status: "invalid", raw };
  }

  if (typeof stored !== "object" || stored === null || !("version" in stored)) {
    return { status: "invalid", raw };
  }

  const workspace =
    stored.version === 1
      ? migrateWorkspaceSnapshotV1(stored)
      : stored.version === 2
        ? migrateWorkspaceSnapshotV2(stored)
        : stored.version === 3
          ? migrateWorkspaceSnapshotV3(stored)
          : stored.version === 4
            ? migrateWorkspaceSnapshotV4(stored)
            : stored.version === 5
              ? migrateWorkspaceSnapshotV5(stored)
              : stored.version === currentWorkspaceStorageVersion
                ? parseWorkspaceSnapshot(stored)
                : null;
  return workspace === null
    ? { status: "invalid", raw }
    : { status: "ready", workspace };
}

export function serializeStoredWorkspace(workspace: WorkspaceSnapshot): string {
  const validated = parseWorkspaceSnapshot(workspace);
  if (validated === null) {
    throw new Error("refusing to persist an invalid workspace snapshot");
  }
  return JSON.stringify({
    version: currentWorkspaceStorageVersion,
    ...validated,
    view: {
      ...validated.view,
      bookmarks: validated.view.bookmarks ?? [],
      timeline: validated.view.timeline ?? null,
    },
  });
}

export function loadLegacyBrowserWorkspace(
  slot: WorkspaceStorageSlot,
): WorkspaceLoadResult {
  const raw = localStorage.getItem(storageKey(slot));
  if (raw === null) {
    return { status: "missing" };
  }
  return parseStoredWorkspaceText(raw);
}

export function removeLegacyBrowserWorkspace(slot: WorkspaceStorageSlot): void {
  localStorage.removeItem(storageKey(slot));
}

function saveLegacyBrowserWorkspace(
  slot: WorkspaceStorageSlot,
  workspace: WorkspaceSnapshot,
): void {
  localStorage.setItem(storageKey(slot), serializeStoredWorkspace(workspace));
}

export const localWorkspacePersistence: WorkspacePersistence = {
  async load() {
    return loadLegacyBrowserWorkspace("primary");
  },
  async loadRecovery() {
    return loadLegacyBrowserWorkspace("recovery");
  },
  async preserveForRecovery(workspace) {
    saveLegacyBrowserWorkspace("recovery", workspace);
  },
  runExclusiveTransaction(transaction) {
    return transaction();
  },
  async save(workspace) {
    saveLegacyBrowserWorkspace("primary", workspace);
  },
  async swapWithRecovery() {
    const primaryRaw = localStorage.getItem(storageKey("primary"));
    const recoveryRaw = localStorage.getItem(storageKey("recovery"));
    if (primaryRaw === null || recoveryRaw === null) {
      throw new Error("workspace_recovery_unavailable");
    }
    const primary = parseStoredWorkspaceText(primaryRaw);
    const recovery = parseStoredWorkspaceText(recoveryRaw);
    if (primary.status !== "ready" || recovery.status !== "ready") {
      throw new Error("workspace_recovery_invalid");
    }

    localStorage.setItem(storageKey("recovery"), primaryRaw);
    try {
      localStorage.setItem(storageKey("primary"), recoveryRaw);
    } catch (error) {
      try {
        localStorage.setItem(storageKey("recovery"), recoveryRaw);
      } catch {
        throw new Error("workspace_recovery_swap_rollback_failed");
      }
      throw error;
    }
    return { status: "committed", workspace: recovery.workspace };
  },
};
