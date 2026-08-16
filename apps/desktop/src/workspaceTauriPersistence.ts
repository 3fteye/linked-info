import { invoke } from "@tauri-apps/api/core";
import {
  loadLegacyBrowserWorkspace,
  parseStoredWorkspaceText,
  removeLegacyBrowserWorkspace,
  serializeStoredWorkspace,
  type WorkspaceLoadResult,
  type WorkspacePersistence,
  type WorkspaceStorageSlot,
} from "./workspaceStore";

export interface WorkspaceFileBridge {
  read(slot: WorkspaceStorageSlot): Promise<string | null>;
  write(slot: WorkspaceStorageSlot, contents: string): Promise<void>;
}

export interface LegacyWorkspaceSource {
  load(slot: WorkspaceStorageSlot): WorkspaceLoadResult;
  remove(slot: WorkspaceStorageSlot): void;
}

const invokeWorkspaceFileBridge: WorkspaceFileBridge = {
  read(slot) {
    return invoke<string | null>("read_workspace_file", { slot });
  },
  write(slot, contents) {
    return invoke<void>("write_workspace_file", { contents, slot });
  },
};

const browserLegacyWorkspaceSource: LegacyWorkspaceSource = {
  load: loadLegacyBrowserWorkspace,
  remove: removeLegacyBrowserWorkspace,
};

export function createTauriWorkspacePersistence(
  bridge: WorkspaceFileBridge,
  legacy: LegacyWorkspaceSource,
): WorkspacePersistence {
  let writeTail: Promise<void> = Promise.resolve();

  function enqueueWrite(
    slot: WorkspaceStorageSlot,
    contents: string,
  ): Promise<void> {
    const write = writeTail
      .catch(() => undefined)
      .then(() => bridge.write(slot, contents));
    writeTail = write;
    return write;
  }

  async function loadSlot(slot: WorkspaceStorageSlot): Promise<WorkspaceLoadResult> {
    const contents = await bridge.read(slot);
    if (contents !== null) {
      return parseStoredWorkspaceText(contents);
    }

    const legacyWorkspace = legacy.load(slot);
    if (legacyWorkspace.status === "ready") {
      await enqueueWrite(slot, serializeStoredWorkspace(legacyWorkspace.workspace));
      legacy.remove(slot);
    }
    return legacyWorkspace;
  }

  async function saveSlot(
    slot: WorkspaceStorageSlot,
    workspace: Parameters<WorkspacePersistence["save"]>[0],
  ): Promise<void> {
    await enqueueWrite(slot, serializeStoredWorkspace(workspace));
    legacy.remove(slot);
  }

  async function swapWithRecovery() {
    await writeTail.catch(() => undefined);
    const primary = await loadSlot("primary");
    const recovery = await loadSlot("recovery");
    if (primary.status !== "ready" || recovery.status === "missing") {
      throw new Error("workspace_recovery_unavailable");
    }
    if (recovery.status !== "ready") {
      throw new Error("workspace_recovery_invalid");
    }

    await saveSlot("recovery", primary.workspace);
    try {
      await saveSlot("primary", recovery.workspace);
    } catch (error) {
      try {
        await saveSlot("recovery", recovery.workspace);
      } catch {
        throw new Error("workspace_recovery_swap_rollback_failed");
      }
      throw error;
    }
    return recovery.workspace;
  }

  return {
    load() {
      return loadSlot("primary");
    },
    loadRecovery() {
      return loadSlot("recovery");
    },
    preserveForRecovery(workspace) {
      return saveSlot("recovery", workspace);
    },
    save(workspace) {
      return saveSlot("primary", workspace);
    },
    swapWithRecovery,
  };
}

export const tauriWorkspacePersistence = createTauriWorkspacePersistence(
  invokeWorkspaceFileBridge,
  browserLegacyWorkspaceSource,
);
