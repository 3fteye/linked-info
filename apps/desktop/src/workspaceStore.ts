import {
  migrateWorkspaceSnapshotV1,
  parseWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "./workspaceData";

export {
  emptyWorkspace,
  isNodeNameAvailable,
  isUnnamedNode,
  maximumManualNodeDimension,
  minimumManualNodeHeight,
  minimumManualNodeWidth,
  moveNodeLayoutToFront,
  normalizeNodeName,
  persistedNodeNameFromDraft,
  removeNodesFromWorkspaceView,
  updateNodeLayoutDimensions,
  updateNodeLayoutSizeOverrides,
  updateNodeLayoutPositions,
  type CanvasViewport,
  type InformationNode,
  type NodeLayout,
  type NodeLayoutSizeOverrideUpdate,
  type NodeReference,
  type WorkspaceSnapshot,
  type WorkspaceViewMetadata,
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
  save(workspace: WorkspaceSnapshot): Promise<void>;
  swapWithRecovery(): Promise<WorkspaceSwapResult>;
}

export type WorkspaceStorageSlot = "primary" | "recovery";

const workspaceStorageKey = "linked-info.workspace.v1";
const workspaceRecoveryStorageKey = "linked-info.workspace.recovery.v1";
export const currentWorkspaceStorageVersion = 2;

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
  return JSON.stringify({ version: currentWorkspaceStorageVersion, ...validated });
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
