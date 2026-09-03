import {
  parseStoredWorkspaceText,
  serializeStoredWorkspace,
  type WorkspaceLoadResult,
  type WorkspacePersistence,
  type WorkspaceStorageSlot,
} from "./workspaceStore";

export interface WorkspaceFileBridge {
  /** Capture authorization when a write is queued, never when it later runs. */
  captureWrite?(): WorkspaceFileBridge["write"];
  captureSwap?(): WorkspaceFileBridge["swap"];
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

export interface ManagedWorkspacePersistence extends WorkspacePersistence {
  dispose(): void;
}

function hasDurableResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null || !("status" in result)) {
    return false;
  }
  return result.status === "committed" ||
    result.status === "committedLocked" ||
    result.status === "recoveryRequired";
}

export function createTauriWorkspacePersistence(
  bridge: WorkspaceFileBridge,
  legacy: LegacyWorkspaceSource,
): ManagedWorkspacePersistence {
  let writeTail: Promise<void> = Promise.resolve();
  let writeGeneration = 0;
  let writesQuarantined = false;
  let exclusiveInProgress = false;
  let disposed = false;

  function assertActive() {
    if (disposed) {
      throw new Error("workspace_session_disposed");
    }
  }

  function enqueueWrite(
    slot: WorkspaceStorageSlot,
    contents: string,
  ): Promise<void> {
    assertActive();
    if (writesQuarantined) {
      return Promise.reject(new Error("workspace_persistence_reload_required"));
    }
    const generation = writeGeneration;
    const writeCaptured = bridge.captureWrite?.() ?? bridge.write.bind(bridge);
    const write = writeTail
      .catch(() => undefined)
      .then(() => {
        assertActive();
        if (writesQuarantined) {
          throw new Error("workspace_persistence_reload_required");
        }
        if (generation !== writeGeneration) {
          throw new Error("workspace_persistence_stale_operation");
        }
        return writeCaptured(slot, contents);
      })
      .then(() => {
        assertActive();
        if (generation !== writeGeneration) {
          throw new Error("workspace_persistence_stale_operation");
        }
      });
    writeTail = write;
    return write;
  }

  async function loadSlot(slot: WorkspaceStorageSlot): Promise<WorkspaceLoadResult> {
    assertActive();
    if (exclusiveInProgress) {
      throw new Error("workspace_persistence_transaction_in_progress");
    }
    const generation = writeGeneration;
    const contents = await bridge.read(slot);
    assertActive();
    if (generation !== writeGeneration) {
      throw new Error("workspace_persistence_stale_operation");
    }
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
      assertActive();
      legacy.remove(slot);
    }
    return legacyWorkspace;
  }

  async function saveSlot(
    slot: WorkspaceStorageSlot,
    workspace: Parameters<WorkspacePersistence["save"]>[0],
  ): Promise<void> {
    await enqueueWrite(slot, serializeStoredWorkspace(workspace));
    assertActive();
    legacy.remove(slot);
  }

  async function swapWithRecovery() {
    assertActive();
    const swapCaptured = bridge.captureSwap?.() ?? bridge.swap.bind(bridge);
    await writeTail.catch(() => undefined);
    assertActive();
    writeGeneration += 1;
    const swap = swapCaptured().then((result) => {
      const safeResult = disposed && result.status === "committed"
        ? { status: "committedLocked" } as const
        : result;
      writeGeneration += 1;
      if (safeResult.status !== "committed") {
        writesQuarantined = true;
      }
      return safeResult;
    });
    writeTail = swap.then(
      () => undefined,
      () => undefined,
    );
    const result = await swap;
    if (disposed || result.status !== "committed") {
      writesQuarantined = true;
      return { status: "reloadRequired" } as const;
    }
    const parsed = parseStoredWorkspaceText(result.contents);
    if (parsed.status !== "ready") {
      writesQuarantined = true;
      return { status: "reloadRequired" } as const;
    }
    try {
      legacy.remove("primary");
      legacy.remove("recovery");
    } catch {
      writesQuarantined = true;
      return { status: "reloadRequired" } as const;
    }
    return { status: "committed", workspace: parsed.workspace } as const;
  }

  return {
    dispose() {
      disposed = true;
      writeGeneration += 1;
    },
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
      assertActive();
      if (writesQuarantined) {
        throw new Error("workspace_persistence_transaction_in_progress");
      }
      await writeTail.catch(() => undefined);
      assertActive();
      // Two callers can both start while the same write tail is pending. The
      // second caller must re-check after the await; otherwise its pre-commit
      // failure could clear the first transaction's quarantine.
      if (writesQuarantined) {
        throw new Error("workspace_persistence_transaction_in_progress");
      }
      writeGeneration += 1;
      writesQuarantined = true;
      exclusiveInProgress = true;
      try {
        const result = await transaction();
        // A completed durable transaction is not a pre-commit rejection just
        // because its owner unmounted while the response was in flight.
        if (!hasDurableResult(result)) {
          assertActive();
        }
        return result;
      } catch (error) {
        // The transaction contract only rejects before its durable commit
        // point. A structured committed/recovery-required result keeps the
        // quarantine active until an authoritative Rust read succeeds.
        writeGeneration += 1;
        writesQuarantined = false;
        throw error;
      } finally {
        exclusiveInProgress = false;
      }
    },
    save(workspace) {
      return saveSlot("primary", workspace);
    },
    swapWithRecovery,
  };
}
