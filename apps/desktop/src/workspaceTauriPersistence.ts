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
  let writesQuarantined = false;

  function enqueueWrite(
    slot: WorkspaceStorageSlot,
    contents: string,
  ): Promise<void> {
    if (writesQuarantined) {
      return Promise.reject(new Error("workspace_persistence_reload_required"));
    }
    const generation = writeGeneration;
    const write = writeTail
      .catch(() => undefined)
      .then(() => {
        if (writesQuarantined) {
          throw new Error("workspace_persistence_reload_required");
        }
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
      const loaded = parseStoredWorkspaceText(contents);
      if (slot === "primary" && loaded.status === "ready" && writesQuarantined) {
        // A successful Rust primary read first completes any pending recovery
        // transaction. A remounted App can persist again only after that
        // authoritative read has succeeded.
        writeGeneration += 1;
        writesQuarantined = false;
      }
      return loaded;
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
    const swap = bridge.swap().then((result) => {
      writeGeneration += 1;
      if (result.status !== "committed") {
        writesQuarantined = true;
      }
      return result;
    });
    writeTail = swap.then(
      () => undefined,
      () => undefined,
    );
    const result = await swap;
    if (result.status !== "committed") {
      return { status: "reloadRequired" } as const;
    }
    const parsed = parseStoredWorkspaceText(result.contents);
    if (parsed.status !== "ready") {
      writesQuarantined = true;
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
    async runExclusiveTransaction(transaction) {
      if (writesQuarantined) {
        throw new Error("workspace_persistence_transaction_in_progress");
      }
      await writeTail.catch(() => undefined);
      // Two callers can both start while the same write tail is pending. The
      // second caller must re-check after the await; otherwise its pre-commit
      // failure could clear the first transaction's quarantine.
      if (writesQuarantined) {
        throw new Error("workspace_persistence_transaction_in_progress");
      }
      writeGeneration += 1;
      writesQuarantined = true;
      try {
        return await transaction();
      } catch (error) {
        // The transaction contract only rejects before its durable commit
        // point. A structured committed/recovery-required result keeps the
        // quarantine active until an authoritative Rust read succeeds.
        writeGeneration += 1;
        writesQuarantined = false;
        throw error;
      }
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
