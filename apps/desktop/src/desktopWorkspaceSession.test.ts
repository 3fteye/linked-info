import { describe, expect, it, vi } from "vitest";
import {
  createDesktopWorkspaceSession,
  type DesktopWorkspaceSessionBridge,
} from "./desktopWorkspaceSession";
import { emptyWorkspace, type WorkspaceSnapshot } from "./workspaceData";
import { serializeStoredWorkspace, type WorkspaceStorageSlot } from "./workspaceStore";
import type { LegacyWorkspaceSource } from "./workspaceTauriPersistence";
import type { TimelineNoteInput } from "./timelineWorkspace";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function workspace(name = "Synthetic"): WorkspaceSnapshot {
  return {
    ...emptyWorkspace(),
    nodes: [{
      id: "11111111-1111-4111-8111-111111111111",
      name,
      content: "Synthetic test content",
    }],
  };
}

const missingLegacy: LegacyWorkspaceSource = {
  load: () => ({ status: "missing" }),
  remove() {},
};

const note: TimelineNoteInput = {
  nodeId: "22222222-2222-4222-8222-222222222222",
  name: "Synthetic note",
  content: "Synthetic capsule content",
  capturedAtMs: 1_788_399_000_000,
  utcOffsetMinutes: 480,
};

class MemorySessionBridge implements DesktopWorkspaceSessionBridge {
  readonly calls: { command: string; args?: Record<string, unknown> }[] = [];
  readonly files = new Map<WorkspaceStorageSlot, string>([
    ["primary", serializeStoredWorkspace(workspace())],
    ["recovery", serializeStoredWorkspace(workspace("Recovery"))],
  ]);
  readonly listeners = new Set<() => void>();
  activeOwner: string | null = null;
  openCount = 0;
  handler: ((command: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args });
    if (this.handler !== null) {
      return await this.handler(command, args) as T;
    }
    return this.dispatch(command, args) as T;
  }

  dispatch(command: string, args?: Record<string, unknown>): unknown {
    if (command === "open_workspace_owner") {
      this.openCount += 1;
      this.activeOwner = `owner-${this.openCount}`;
      return { ownerId: this.activeOwner };
    }
    if (command === "close_workspace_owner") {
      if (this.activeOwner === args?.ownerId) {
        this.activeOwner = null;
      }
      return undefined;
    }
    if (command === "open_capsule_window") {
      return undefined;
    }
    if (args === undefined || args.ownerId !== this.activeOwner || this.activeOwner === null) {
      throw new Error("workspace_owner_stale");
    }
    if (command === "read_workspace_file") {
      return this.files.get(args.slot as WorkspaceStorageSlot) ?? null;
    }
    if (command === "write_workspace_file") {
      this.files.set(args.slot as WorkspaceStorageSlot, args.contents as string);
      return undefined;
    }
    if (command === "swap_workspace_recovery_files") {
      const primary = this.files.get("primary")!;
      const recovery = this.files.get("recovery")!;
      this.files.set("primary", recovery);
      this.files.set("recovery", primary);
      return { status: "committed", contents: recovery };
    }
    if (command === "take_capsule_note") {
      return note;
    }
    if (command === "commit_capsule_note") {
      return { status: "committed" };
    }
    if (command === "set_workspace_owner_ready" || command === "reject_capsule_note") {
      return undefined;
    }
    throw new Error(`unsupported synthetic command: ${command}`);
  }

  async subscribePending(listener: () => void): Promise<() => void> {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

describe("createDesktopWorkspaceSession", () => {
  it("lazily shares one owner across primary/recovery reads and every owned command", async () => {
    const bridge = new MemorySessionBridge();
    const session = createDesktopWorkspaceSession(bridge, missingLegacy);
    expect(bridge.calls).toEqual([]);
    await expect(session.persistence.save(workspace())).rejects.toThrow("workspace_owner_not_initialized");
    await expect(session.persistence.loadRecovery()).rejects.toThrow("workspace_owner_not_initialized");
    await expect(session.capsuleHost.setReady(true)).rejects.toThrow("workspace_owner_not_initialized");
    expect(bridge.openCount).toBe(0);

    await Promise.all([session.persistence.load(), session.persistence.loadRecovery()]);
    await session.persistence.save(workspace("Saved"));
    await session.persistence.preserveForRecovery(workspace("Preserved"));
    await session.capsuleHost.setReady(true);
    await expect(session.capsuleHost.take()).resolves.toEqual(note);
    await expect(session.capsuleHost.commit(note.nodeId, "synthetic-workspace"))
      .resolves.toEqual({ status: "committed" });
    await session.capsuleHost.reject(note.nodeId, "busy");
    await session.capsuleHost.open();

    expect(bridge.openCount).toBe(1);
    for (const call of bridge.calls) {
      if (call.command !== "open_workspace_owner" && call.command !== "open_capsule_window") {
        expect(call.args?.ownerId).toBe("owner-1");
      }
    }
    expect(bridge.calls.filter((call) => call.command === "set_workspace_owner_ready"))
      .toEqual([{ command: "set_workspace_owner_ready", args: { ownerId: "owner-1", ready: true } }]);
  });

  it("closes a delayed disposed owner without reading or revoking a newer mount", async () => {
    const bridge = new MemorySessionBridge();
    const firstOpen = deferred<{ ownerId: string }>();
    bridge.handler = async (command, args) => {
      if (command === "open_workspace_owner" && bridge.openCount === 0) {
        bridge.dispatch(command, args);
        return firstOpen.promise;
      }
      return bridge.dispatch(command, args);
    };
    const oldSession = createDesktopWorkspaceSession(bridge, missingLegacy);
    const oldRead = oldSession.persistence.load();
    const oldRejected = expect(oldRead).rejects.toThrow("workspace_session_disposed");
    oldSession.dispose();
    const currentSession = createDesktopWorkspaceSession(bridge, missingLegacy);
    await currentSession.persistence.load();
    expect(bridge.activeOwner).toBe("owner-2");

    firstOpen.resolve({ ownerId: "owner-1" });
    await oldRejected;
    expect(bridge.activeOwner).toBe("owner-2");
    expect(bridge.calls.filter((call) => call.command === "read_workspace_file"))
      .toEqual([{ command: "read_workspace_file", args: { ownerId: "owner-2", slot: "primary" } }]);
    expect(bridge.calls).toContainEqual({
      command: "close_workspace_owner", args: { ownerId: "owner-1" },
    });
    await expect(oldSession.persistence.load()).rejects.toThrow("workspace_session_disposed");
    expect(bridge.openCount).toBe(2);
  });

  it("rejects plaintext returned after disposal from a read or capsule take", async () => {
    const bridge = new MemorySessionBridge();
    const session = createDesktopWorkspaceSession(bridge, missingLegacy);
    await session.persistence.load();
    const read = deferred<string>();
    const take = deferred<TimelineNoteInput>();
    const readStarted = deferred<void>();
    const takeStarted = deferred<void>();
    bridge.handler = async (command, args) => {
      if (command === "read_workspace_file") {
        readStarted.resolve();
        return read.promise;
      }
      if (command === "take_capsule_note") {
        takeStarted.resolve();
        return take.promise;
      }
      return bridge.dispatch(command, args);
    };
    const lateRead = expect(session.persistence.load()).rejects.toThrow("workspace_session_disposed");
    const lateTake = expect(session.capsuleHost.take()).rejects.toThrow("workspace_session_disposed");
    await Promise.all([readStarted.promise, takeStarted.promise]);
    session.dispose();
    read.resolve(serializeStoredWorkspace(workspace()));
    take.resolve(note);
    await Promise.all([lateRead, lateTake]);
  });

  it("rejects old queued writes and never re-signs them with the next owner's token", async () => {
    const bridge = new MemorySessionBridge();
    const oldSession = createDesktopWorkspaceSession(bridge, missingLegacy);
    await oldSession.persistence.load();
    const releaseWrite = deferred<void>();
    const writeStarted = deferred<void>();
    bridge.handler = async (command, args) => {
      if (command === "write_workspace_file" && args?.ownerId === "owner-1") {
        writeStarted.resolve();
        await releaseWrite.promise;
        return undefined;
      }
      return bridge.dispatch(command, args);
    };
    const first = expect(oldSession.persistence.save(workspace("In flight")))
      .rejects.toThrow("workspace_session_disposed");
    const queued = expect(oldSession.persistence.save(workspace("Queued stale")))
      .rejects.toThrow("workspace_session_disposed");
    await writeStarted.promise;
    oldSession.dispose();
    const current = createDesktopWorkspaceSession(bridge, missingLegacy);
    await current.persistence.load();
    await current.persistence.save(workspace("New owner"));
    releaseWrite.resolve();
    await Promise.all([first, queued]);

    expect(bridge.calls.filter((call) => call.command === "write_workspace_file")
      .map((call) => [call.args?.ownerId, JSON.parse(call.args?.contents as string).nodes[0].name]))
      .toEqual([["owner-1", "In flight"], ["owner-2", "New owner"]]);
    expect(bridge.openCount).toBe(2);
    await expect(oldSession.capsuleHost.open()).rejects.toThrow("workspace_session_disposed");
    await expect(oldSession.capsuleHost.commit(note.nodeId, "stale"))
      .rejects.toThrow("workspace_session_disposed");
  });

  it("does not open a fresh owner when ordinary reads or writes encounter a stale native permit", async () => {
    const bridge = new MemorySessionBridge();
    const session = createDesktopWorkspaceSession(bridge, missingLegacy);
    await session.persistence.load();
    bridge.activeOwner = null;
    await expect(session.persistence.load()).rejects.toThrow("workspace_owner_stale");
    await expect(session.persistence.save(workspace())).rejects.toThrow("workspace_owner_stale");
    await expect(session.capsuleHost.take()).rejects.toThrow("workspace_owner_stale");
    expect(bridge.openCount).toBe(1);
  });

  it("renews only after a confirmed exclusive commit and a subsequent primary load", async () => {
    const bridge = new MemorySessionBridge();
    const session = createDesktopWorkspaceSession(bridge, missingLegacy);
    await session.persistence.load();
    await session.capsuleHost.setReady(true);
    const result = await session.persistence.runExclusiveTransaction(async () => {
      expect(bridge.calls[bridge.calls.length - 1]).toEqual({
        command: "set_workspace_owner_ready", args: { ownerId: "owner-1", ready: false },
      });
      bridge.files.set("primary", serializeStoredWorkspace(workspace("Replaced")));
      return { status: "committed", syntheticMetadata: true };
    });
    expect(result).toEqual({ status: "committed", syntheticMetadata: true });
    expect(bridge.openCount).toBe(1);
    await expect(session.capsuleHost.setReady(true)).rejects.toThrow("workspace_owner_not_initialized");
    await expect(session.persistence.save(workspace("Stale")))
      .rejects.toThrow("workspace_persistence_reload_required");

    const loaded = await session.persistence.load();
    expect(loaded.status === "ready" && loaded.workspace.nodes[0].name).toBe("Replaced");
    await session.capsuleHost.setReady(true);
    await session.persistence.save(workspace("New epoch"));
    expect(bridge.openCount).toBe(2);
    expect(bridge.calls[bridge.calls.length - 1]?.args?.ownerId).toBe("owner-2");
  });

  it.each(["committedLocked", "recoveryRequired"] as const)(
    "keeps %s exclusive results closed without creating a new owner",
    async (status) => {
      const bridge = new MemorySessionBridge();
      const session = createDesktopWorkspaceSession(bridge, missingLegacy);
      await session.persistence.load();
      await expect(session.persistence.runExclusiveTransaction(async () => ({ status })))
        .resolves.toEqual({ status });
      await expect(session.persistence.load()).rejects.toThrow("workspace_session_reload_required");
      await expect(session.capsuleHost.setReady(true)).rejects.toThrow("workspace_session_reload_required");
      expect(bridge.openCount).toBe(1);
    },
  );

  it("does not renew when a disposed transaction eventually reports a commit", async () => {
    const bridge = new MemorySessionBridge();
    const session = createDesktopWorkspaceSession(bridge, missingLegacy);
    await session.persistence.load();
    const entered = deferred<void>();
    const result = deferred<{ status: "committed" }>();
    const committed = expect(session.persistence.runExclusiveTransaction(async () => {
      entered.resolve();
      return result.promise;
    })).resolves.toEqual({ status: "committed" });
    await entered.promise;
    session.dispose();
    result.resolve({ status: "committed" });
    await committed;
    await expect(session.persistence.load()).rejects.toThrow("workspace_session_disposed");
    expect(bridge.openCount).toBe(1);
  });

  it("drops pre-replacement reads and takes even after a new owner has loaded", async () => {
    const bridge = new MemorySessionBridge();
    const session = createDesktopWorkspaceSession(bridge, missingLegacy);
    await session.persistence.load();
    const read = deferred<string>();
    const take = deferred<TimelineNoteInput>();
    const readStarted = deferred<void>();
    const takeStarted = deferred<void>();
    bridge.handler = async (command, args) => {
      if (args?.ownerId === "owner-1" && command === "read_workspace_file") {
        readStarted.resolve();
        return read.promise;
      }
      if (args?.ownerId === "owner-1" && command === "take_capsule_note") {
        takeStarted.resolve();
        return take.promise;
      }
      return bridge.dispatch(command, args);
    };
    const staleRead = expect(session.persistence.load()).rejects.toThrow("workspace_owner_stale");
    const staleTake = expect(session.capsuleHost.take()).rejects.toThrow("workspace_owner_stale");
    await Promise.all([readStarted.promise, takeStarted.promise]);
    await session.persistence.runExclusiveTransaction(async () => ({ status: "committed" }));
    await session.persistence.load();
    read.resolve(serializeStoredWorkspace(workspace("Old plaintext")));
    take.resolve(note);
    await Promise.all([staleRead, staleTake]);
    expect(bridge.activeOwner).toBe("owner-2");
  });

  it("reloads under a renewed owner after a committed recovery swap", async () => {
    const bridge = new MemorySessionBridge();
    const session = createDesktopWorkspaceSession(bridge, missingLegacy);
    await session.persistence.load();
    const result = await session.persistence.swapWithRecovery();
    expect(result.status === "committed" && result.workspace.nodes[0].name).toBe("Recovery");
    expect(bridge.openCount).toBe(2);
    const swapIndex = bridge.calls.findIndex((call) => call.command === "swap_workspace_recovery_files");
    expect(bridge.calls[swapIndex - 1]).toEqual({
      command: "set_workspace_owner_ready", args: { ownerId: "owner-1", ready: false },
    });
    expect(bridge.calls[bridge.calls.length - 1]).toEqual({
      command: "read_workspace_file", args: { ownerId: "owner-2", slot: "primary" },
    });
    await session.capsuleHost.setReady(true);
    expect(bridge.calls[bridge.calls.length - 1]?.args?.ownerId).toBe("owner-2");
  });

  it.each(["committed", "committedLocked", "recoveryRequired"] as const)(
    "preserves a late capsule %s outcome without returning a generic save failure",
    async (status) => {
      const bridge = new MemorySessionBridge();
      const session = createDesktopWorkspaceSession(bridge, missingLegacy);
      await session.persistence.load();
      const entered = deferred<void>();
      const result = deferred<{ status: typeof status }>();
      bridge.handler = async (command, args) => {
        if (command === "commit_capsule_note") {
          entered.resolve();
          return result.promise;
        }
        return bridge.dispatch(command, args);
      };
      const commit = session.capsuleHost.commit(note.nodeId, "synthetic-workspace");
      await entered.promise;
      session.dispose();
      result.resolve({ status });

      await expect(commit).resolves.toEqual({
        status: status === "recoveryRequired" ? "recoveryRequired" : "committedLocked",
      });
      expect(bridge.openCount).toBe(1);
    },
  );

  it("discards late swap plaintext while preserving its reload-required outcome", async () => {
    const bridge = new MemorySessionBridge();
    const session = createDesktopWorkspaceSession(bridge, missingLegacy);
    await session.persistence.load();
    const entered = deferred<void>();
    const result = deferred<{ status: "committed"; contents: string }>();
    bridge.handler = async (command, args) => {
      if (command === "swap_workspace_recovery_files") {
        entered.resolve();
        return result.promise;
      }
      return bridge.dispatch(command, args);
    };
    const swap = session.persistence.swapWithRecovery();
    await entered.promise;
    session.dispose();
    result.resolve({ status: "committed", contents: serializeStoredWorkspace(workspace("Late plaintext")) });
    await expect(swap).resolves.toEqual({ status: "reloadRequired" });
    expect(bridge.openCount).toBe(1);
  });

  it("reports reload required when opening the next owner fails after a swap committed", async () => {
    const bridge = new MemorySessionBridge();
    const session = createDesktopWorkspaceSession(bridge, missingLegacy);
    await session.persistence.load();
    bridge.handler = async (command, args) => {
      if (command === "open_workspace_owner") {
        throw new Error("synthetic reopen failure");
      }
      return bridge.dispatch(command, args);
    };
    await expect(session.persistence.swapWithRecovery()).resolves.toEqual({ status: "reloadRequired" });
    expect(JSON.parse(bridge.files.get("primary")!).nodes[0].name).toBe("Recovery");
    await expect(session.persistence.load()).rejects.toThrow("workspace_session_reload_required");
  });

  it("removes active and late event subscriptions on disposal", async () => {
    const bridge = new MemorySessionBridge();
    const session = createDesktopWorkspaceSession(bridge, missingLegacy);
    const listener = vi.fn();
    const remove = await session.capsuleHost.subscribePending(listener);
    for (const pending of bridge.listeners) pending();
    expect(listener).toHaveBeenCalledTimes(1);
    session.dispose();
    remove();
    expect(bridge.listeners.size).toBe(0);
    await expect(session.capsuleHost.subscribePending(listener)).rejects.toThrow("workspace_session_disposed");

    const subscription = deferred<() => void>();
    const unsubscribe = vi.fn();
    bridge.subscribePending = async () => subscription.promise;
    const lateSession = createDesktopWorkspaceSession(bridge, missingLegacy);
    const rejected = expect(lateSession.capsuleHost.subscribePending(listener))
      .rejects.toThrow("workspace_session_disposed");
    lateSession.dispose();
    subscription.resolve(unsubscribe);
    await rejected;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
