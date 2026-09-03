import { describe, expect, it } from "vitest";
import {
  defaultCanvasId,
  type WorkspaceSnapshot,
} from "./workspaceData";
import type {
  LegacyWorkspaceSource,
  WorkspaceFileBridge,
} from "./workspaceTauriPersistence";
import { createTauriWorkspacePersistence } from "./workspaceTauriPersistence";
import type {
  WorkspaceLoadResult,
  WorkspaceStorageSlot,
} from "./workspaceStore";

const nodeId = "11111111-1111-4111-8111-111111111111";

function validWorkspace(name = "OpenAI"): WorkspaceSnapshot {
  return {
    nodes: [{ id: nodeId, name, content: null }],
    references: [],
    view: {
      activeCanvasId: defaultCanvasId,
      canvases: [
        {
          id: defaultCanvasId,
          name: "Main",
          layout: [{ nodeId, x: 10, y: 20 }],
          viewport: null,
        },
      ],
      contentProcessorByNodeId: {},
      extensionMetadata: {},
      timeline: null,
    },
  };
}

class MemoryFileBridge implements WorkspaceFileBridge {
  readonly files = new Map<WorkspaceStorageSlot, string>();

  async read(slot: WorkspaceStorageSlot): Promise<string | null> {
    return this.files.get(slot) ?? null;
  }

  async swap() {
    const primary = this.files.get("primary");
    const recovery = this.files.get("recovery");
    if (primary === undefined || recovery === undefined) {
      throw new Error("workspace_recovery_unavailable");
    }
    this.files.set("primary", recovery);
    this.files.set("recovery", primary);
    return { status: "committed" as const, contents: recovery };
  }

  async write(slot: WorkspaceStorageSlot, contents: string): Promise<void> {
    this.files.set(slot, contents);
  }
}

class MemoryLegacySource implements LegacyWorkspaceSource {
  readonly removed: WorkspaceStorageSlot[] = [];
  readonly values = new Map<WorkspaceStorageSlot, WorkspaceLoadResult>();

  load(slot: WorkspaceStorageSlot): WorkspaceLoadResult {
    return this.values.get(slot) ?? { status: "missing" };
  }

  remove(slot: WorkspaceStorageSlot): void {
    this.removed.push(slot);
    this.values.delete(slot);
  }
}

describe("createTauriWorkspacePersistence", () => {
  it("migrates a valid legacy workspace once and removes the browser copy", async () => {
    const bridge = new MemoryFileBridge();
    const legacy = new MemoryLegacySource();
    const workspace = validWorkspace();
    legacy.values.set("primary", { status: "ready", workspace });
    const persistence = createTauriWorkspacePersistence(bridge, legacy);

    expect(await persistence.load()).toEqual({ status: "ready", workspace });
    expect(JSON.parse(bridge.files.get("primary") ?? "null")).toEqual({
      version: 6,
      ...workspace,
      view: { ...workspace.view, bookmarks: [] },
    });
    expect(legacy.removed).toEqual(["primary"]);
  });

  it("never replaces an existing Rust file with stale browser data", async () => {
    const bridge = new MemoryFileBridge();
    const legacy = new MemoryLegacySource();
    const fileWorkspace = validWorkspace("File");
    const browserWorkspace = validWorkspace("Browser");
    bridge.files.set("primary", JSON.stringify({ version: 4, ...fileWorkspace, view: { ...fileWorkspace.view, timeline: undefined } }));
    legacy.values.set("primary", { status: "ready", workspace: browserWorkspace });
    const persistence = createTauriWorkspacePersistence(bridge, legacy);

    expect(await persistence.load()).toEqual({
      status: "ready",
      workspace: { ...fileWorkspace, view: { ...fileWorkspace.view, bookmarks: [] } },
    });
    expect(legacy.removed).toEqual([]);
  });

  it("preserves unreadable legacy data instead of migrating or deleting it", async () => {
    const bridge = new MemoryFileBridge();
    const legacy = new MemoryLegacySource();
    legacy.values.set("primary", { status: "invalid", raw: "{broken" });
    const persistence = createTauriWorkspacePersistence(bridge, legacy);

    expect(await persistence.load()).toEqual({
      status: "invalid",
      raw: "{broken",
    });
    expect(bridge.files.size).toBe(0);
    expect(legacy.removed).toEqual([]);
  });

  it("returns a damaged Rust file verbatim without falling back", async () => {
    const bridge = new MemoryFileBridge();
    const legacy = new MemoryLegacySource();
    bridge.files.set("primary", "{damaged");
    legacy.values.set("primary", {
      status: "ready",
      workspace: validWorkspace("Stale"),
    });
    const persistence = createTauriWorkspacePersistence(bridge, legacy);

    expect(await persistence.load()).toEqual({
      status: "invalid",
      raw: "{damaged",
    });
    expect(legacy.removed).toEqual([]);
  });

  it("validates before writing primary and recovery files", async () => {
    const bridge = new MemoryFileBridge();
    const legacy = new MemoryLegacySource();
    const persistence = createTauriWorkspacePersistence(bridge, legacy);
    const workspace = validWorkspace();

    await persistence.save(workspace);
    await persistence.preserveForRecovery(workspace);
    expect([...bridge.files.keys()]).toEqual(["primary", "recovery"]);
    expect(legacy.removed).toEqual(["primary", "recovery"]);

    const invalid = structuredClone(workspace);
    invalid.view.canvases = [];
    await expect(persistence.save(invalid)).rejects.toThrow(
      "refusing to persist an invalid workspace snapshot",
    );
  });

  it("serializes writes so an older snapshot cannot finish after a newer one", async () => {
    const files = new Map<WorkspaceStorageSlot, string>();
    const events: string[] = [];
    let releaseFirstWrite: () => void = () => {};
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writeCount = 0;
    const bridge: WorkspaceFileBridge = {
      async read(slot) {
        return files.get(slot) ?? null;
      },
      async swap() {
        throw new Error("swap is not used in this test");
      },
      async write(slot, contents) {
        writeCount += 1;
        const currentWrite = writeCount;
        events.push(`start-${currentWrite}`);
        if (currentWrite === 1) {
          await firstWriteBlocked;
        }
        files.set(slot, contents);
        events.push(`finish-${currentWrite}`);
      },
    };
    const persistence = createTauriWorkspacePersistence(
      bridge,
      new MemoryLegacySource(),
    );

    const firstSave = persistence.save(validWorkspace("First"));
    const secondSave = persistence.save(validWorkspace("Second"));
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["start-1"]);

    releaseFirstWrite();
    await Promise.all([firstSave, secondSave]);

    expect(events).toEqual(["start-1", "finish-1", "start-2", "finish-2"]);
    expect(JSON.parse(files.get("primary") ?? "null").nodes[0].name).toBe(
      "Second",
    );
  });

  it("swaps the primary workspace and recovery copy through the write queue", async () => {
    const bridge = new MemoryFileBridge();
    const persistence = createTauriWorkspacePersistence(
      bridge,
      new MemoryLegacySource(),
    );
    const first = validWorkspace("First");
    const second = validWorkspace("Second");
    await persistence.preserveForRecovery(first);
    await persistence.save(second);

    expect(await persistence.swapWithRecovery()).toEqual({
      status: "committed",
      workspace: first,
    });
    expect(await persistence.load()).toEqual({ status: "ready", workspace: first });
    expect(await persistence.loadRecovery()).toEqual({
      status: "ready",
      workspace: second,
    });

    expect(await persistence.swapWithRecovery()).toEqual({
      status: "committed",
      workspace: second,
    });
    expect(await persistence.loadRecovery()).toEqual({
      status: "ready",
      workspace: first,
    });
  });

  it("does not modify either slot when the Rust swap fails before commit", async () => {
    const files = new Map<WorkspaceStorageSlot, string>();
    const bridge: WorkspaceFileBridge = {
      async read(slot) {
        return files.get(slot) ?? null;
      },
      async swap() {
        throw new Error("swap preparation failed");
      },
      async write(slot, contents) {
        files.set(slot, contents);
      },
    };
    const persistence = createTauriWorkspacePersistence(
      bridge,
      new MemoryLegacySource(),
    );
    const first = validWorkspace("First");
    const second = validWorkspace("Second");
    await persistence.preserveForRecovery(first);
    await persistence.save(second);

    await expect(persistence.swapWithRecovery()).rejects.toThrow(
      "swap preparation failed",
    );
    expect(await persistence.load()).toEqual({ status: "ready", workspace: second });
    expect(await persistence.loadRecovery()).toEqual({
      status: "ready",
      workspace: first,
    });
  });

  it("never performs partial JavaScript writes after the Rust commit point", async () => {
    const files = new Map<WorkspaceStorageSlot, string>();
    let writeCount = 0;
    let swapCount = 0;
    const bridge: WorkspaceFileBridge = {
      async read(slot) {
        return files.get(slot) ?? null;
      },
      async swap() {
        swapCount += 1;
        return { status: "recoveryRequired" as const };
      },
      async write(slot, contents) {
        writeCount += 1;
        files.set(slot, contents);
      },
    };
    const persistence = createTauriWorkspacePersistence(
      bridge,
      new MemoryLegacySource(),
    );
    const recovery = validWorkspace("Unique recovery");
    const primary = validWorkspace("Current primary");
    await persistence.preserveForRecovery(recovery);
    await persistence.save(primary);

    expect(await persistence.swapWithRecovery()).toEqual({
      status: "reloadRequired",
    });
    expect(swapCount).toBe(1);
    expect(writeCount).toBe(2);
    await expect(persistence.save(validWorkspace("Must not write"))).rejects.toThrow(
      "workspace_persistence_reload_required",
    );
    expect(await persistence.load()).toEqual({ status: "ready", workspace: primary });
    expect(await persistence.loadRecovery()).toEqual({
      status: "ready",
      workspace: recovery,
    });
    const afterRecoveryRead = validWorkspace("Writable after recovered primary read");
    await persistence.save(afterRecoveryRead);
    expect(await persistence.load()).toEqual({
      status: "ready",
      workspace: afterRecoveryRead,
    });
  });

  it("drops stale saves queued while Rust owns the recovery transaction", async () => {
    const files = new Map<WorkspaceStorageSlot, string>();
    let signalSwapStarted: () => void = () => {};
    const swapStarted = new Promise<void>((resolve) => {
      signalSwapStarted = resolve;
    });
    let releaseSwap: () => void = () => {};
    const swapBlocked = new Promise<void>((resolve) => {
      releaseSwap = resolve;
    });
    const bridge: WorkspaceFileBridge = {
      async read(slot) {
        return files.get(slot) ?? null;
      },
      async swap() {
        signalSwapStarted();
        await swapBlocked;
        const primary = files.get("primary");
        const recovery = files.get("recovery");
        if (primary === undefined || recovery === undefined) {
          throw new Error("workspace_recovery_unavailable");
        }
        files.set("primary", recovery);
        files.set("recovery", primary);
        return { status: "committed" as const, contents: recovery };
      },
      async write(slot, contents) {
        files.set(slot, contents);
      },
    };
    const persistence = createTauriWorkspacePersistence(
      bridge,
      new MemoryLegacySource(),
    );
    const recovery = validWorkspace("Recovery becomes primary");
    const stalePrimary = validWorkspace("Stale React primary");
    await persistence.preserveForRecovery(recovery);
    await persistence.save(stalePrimary);

    const swapping = persistence.swapWithRecovery();
    await swapStarted;
    const staleSave = persistence.save(stalePrimary);
    releaseSwap();
    await expect(swapping).resolves.toEqual({
      status: "committed",
      workspace: recovery,
    });
    await staleSave;

    expect(await persistence.load()).toEqual({
      status: "ready",
      workspace: recovery,
    });
    expect(await persistence.loadRecovery()).toEqual({
      status: "ready",
      workspace: stalePrimary,
    });
  });

  it("preserves a save queued while a pre-commit swap attempt fails", async () => {
    const files = new Map<WorkspaceStorageSlot, string>();
    let signalSwapStarted: () => void = () => {};
    const swapStarted = new Promise<void>((resolve) => {
      signalSwapStarted = resolve;
    });
    let rejectSwap: (error: Error) => void = () => {};
    const swapBlocked = new Promise<never>((_resolve, reject) => {
      rejectSwap = reject;
    });
    const bridge: WorkspaceFileBridge = {
      async read(slot) {
        return files.get(slot) ?? null;
      },
      async swap() {
        signalSwapStarted();
        return swapBlocked;
      },
      async write(slot, contents) {
        files.set(slot, contents);
      },
    };
    const persistence = createTauriWorkspacePersistence(
      bridge,
      new MemoryLegacySource(),
    );
    const primary = validWorkspace("Before failed swap");
    const edited = validWorkspace("Edit during failed swap");
    await persistence.preserveForRecovery(validWorkspace("Recovery"));
    await persistence.save(primary);

    const swapping = persistence.swapWithRecovery();
    await swapStarted;
    const queuedSave = persistence.save(edited);
    rejectSwap(new Error("swap failed before commit"));

    await expect(swapping).rejects.toThrow("swap failed before commit");
    await queuedSave;
    expect(await persistence.load()).toEqual({ status: "ready", workspace: edited });
  });

  it("quarantines stale writes after an external transaction commits until Rust is reloaded", async () => {
    const bridge = new MemoryFileBridge();
    const persistence = createTauriWorkspacePersistence(
      bridge,
      new MemoryLegacySource(),
    );
    const before = validWorkspace("Before external commit");
    const restored = validWorkspace("Authoritative restored workspace");
    await persistence.save(before);

    const result = await persistence.runExclusiveTransaction(async () => {
      bridge.files.set("primary", JSON.stringify({ version: 4, ...restored, view: { ...restored.view, timeline: undefined } }));
      return { status: "committed" as const };
    });

    expect(result).toEqual({ status: "committed" });
    await expect(persistence.save(before)).rejects.toThrow(
      "workspace_persistence_reload_required",
    );
    expect(await persistence.load()).toEqual({
      status: "ready",
      workspace: { ...restored, view: { ...restored.view, bookmarks: [] } },
    });
    await expect(persistence.save(restored)).resolves.toBeUndefined();
  });

  it("allows writes again when an external transaction rejects before commit", async () => {
    const bridge = new MemoryFileBridge();
    const persistence = createTauriWorkspacePersistence(
      bridge,
      new MemoryLegacySource(),
    );
    const before = validWorkspace("Before rejected transaction");
    const after = validWorkspace("After rejected transaction");
    await persistence.save(before);

    await expect(
      persistence.runExclusiveTransaction(async () => {
        throw new Error("not committed");
      }),
    ).rejects.toThrow("not committed");
    await persistence.save(after);

    expect(await persistence.load()).toEqual({ status: "ready", workspace: after });
  });

  it("does not let an overlapping transaction clear the active quarantine", async () => {
    const bridge = new MemoryFileBridge();
    const persistence = createTauriWorkspacePersistence(
      bridge,
      new MemoryLegacySource(),
    );
    const before = validWorkspace("Before overlapping transaction");
    const restored = validWorkspace("Committed by first transaction");
    await persistence.save(before);
    let signalFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = persistence.runExclusiveTransaction(async () => {
      signalFirstStarted();
      await firstBlocked;
      bridge.files.set("primary", JSON.stringify({ version: 4, ...restored, view: { ...restored.view, timeline: undefined } }));
      return { status: "committed" as const };
    });
    await firstStarted;

    await expect(
      persistence.runExclusiveTransaction(async () => {
        throw new Error("second transaction must not start");
      }),
    ).rejects.toThrow("workspace_persistence_transaction_in_progress");
    await expect(persistence.save(before)).rejects.toThrow(
      "workspace_persistence_reload_required",
    );

    releaseFirst();
    await expect(first).resolves.toEqual({ status: "committed" });
    await expect(persistence.save(before)).rejects.toThrow(
      "workspace_persistence_reload_required",
    );
    expect(await persistence.load()).toEqual({
      status: "ready",
      workspace: { ...restored, view: { ...restored.view, bookmarks: [] } },
    });
    await expect(persistence.save(restored)).resolves.toBeUndefined();
  });
});
