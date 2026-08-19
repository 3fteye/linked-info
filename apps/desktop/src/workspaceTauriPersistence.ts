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
  swap(): Promise<WorkspaceFileSwapResult>;
  write(slot: WorkspaceStorageSlot, contents: string): Promise<void>;
}

export type WorkspaceFileSwapResult =
  | { status: "committed"; contents: string }
  | { status: "committedLocked" }
  | { status: "recoveryRequired" };

export interface LegacyWorkspaceSource {
  load(slot: WorkspaceStorageSlot): WorkspaceLoadResult;
  remove(slot: WorkspaceStorageSlot): void;
}

const invokeWorkspaceFileBridge: WorkspaceFileBridge = {
  read(slot) {
    return invoke<string | null>("read_workspace_file", { slot });
  },
  swap() {
    return invoke<WorkspaceFileSwapResult>("swap_workspace_recovery_files");
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
  let writeGeneration = 0;

  function enqueueWrite(
    slot: WorkspaceStorageSlot,
    contents: string,
  ): Promise<void> {
    const generation = writeGeneration;
    const write = writeTail
      .catch(() => undefined)
      .then(() => {
        if (generation !== writeGeneration) {
          return;
        }
        return bridge.write(slot, contents);
      });
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
    writeGeneration += 1;
    const swap = bridge.swap();
    writeTail = swap.then(
      () => undefined,
      () => undefined,
    );
    const result = await swap.finally(() => {
      // Drop any stale React save that was queued while Rust owned the
      // cross-file transaction. The committed workspace becomes the next
      // authoritative generation.
      writeGeneration += 1;
    });
    if (result.status !== "committed") {
      return { status: "reloadRequired" } as const;
    }
    const parsed = parseStoredWorkspaceText(result.contents);
    if (parsed.status !== "ready") {
      throw new Error("workspace_recovery_invalid");
    }
    legacy.remove("primary");
    legacy.remove("recovery");
    return { status: "committed", workspace: parsed.workspace } as const;
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
