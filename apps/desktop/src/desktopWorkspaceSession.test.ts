import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  activeRequest: { requestId: string; requestSequence: string } | null = null;
  latestRequestSequence = 0n;
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
      const sequence = BigInt(args?.requestSequence as string);
      if (sequence <= this.latestRequestSequence) {
        throw new Error("workspace_owner_request_expired");
      }
      this.latestRequestSequence = sequence;
      this.openCount += 1;
      this.activeOwner = `owner-${this.openCount}`;
      this.activeRequest = {
        requestId: args?.requestId as string,
        requestSequence: args?.requestSequence as string,
      };
      return { ownerId: this.activeOwner };
    }
    if (command === "close_workspace_owner") {
      const sequence = BigInt(args?.requestSequence as string);
      if (sequence > this.latestRequestSequence) this.latestRequestSequence = sequence;
      if (this.activeRequest?.requestId === args?.requestId &&
        this.activeRequest?.requestSequence === args?.requestSequence &&
        (args?.ownerId === undefined || this.activeOwner === args.ownerId)) {
        this.activeOwner = null;
        this.activeRequest = null;
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
  let requestStorage: Map<string, string>;

  beforeEach(() => {
    requestStorage = new Map();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => requestStorage.get(key) ?? null,
      setItem: (key: string, value: string) => { requestStorage.set(key, value); },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

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
    expect(bridge.calls).toContainEqual({
      command: "close_workspace_owner", args: bridge.calls[0].args,
    });
    const currentSession = createDesktopWorkspaceSession(bridge, missingLegacy);
    await currentSession.persistence.load();
    expect(bridge.activeOwner).toBe("owner-2");

    firstOpen.resolve({ ownerId: "owner-1" });
    await oldRejected;
    expect(bridge.activeOwner).toBe("owner-2");
    expect(bridge.calls.filter((call) => call.command === "read_workspace_file"))
      .toEqual([{ command: "read_workspace_file", args: { ownerId: "owner-2", slot: "primary" } }]);
    await expect(oldSession.persistence.load()).rejects.toThrow("workspace_session_disposed");
    expect(bridge.openCount).toBe(2);
  });

  it("cancels before a delayed native admission and never replaces the next owner", async () => {
    const bridge = new MemorySessionBridge();
    const releaseOldOpen = deferred<void>();
    let first = true;
    bridge.handler = async (command, args) => {
      if (command === "open_workspace_owner" && first) {
        first = false;
        await releaseOldOpen.promise;
      }
      return bridge.dispatch(command, args);
    };
    const old = createDesktopWorkspaceSession(bridge, missingLegacy);
    const oldRead = expect(old.persistence.load()).rejects.toThrow("workspace_owner_request_expired");
    old.dispose();
    const current = createDesktopWorkspaceSession(bridge, missingLegacy);
    await current.persistence.load();
    const currentOwner = bridge.activeOwner;
    releaseOldOpen.resolve();
    await oldRead;
    expect(bridge.activeOwner).toBe(currentOwner);
    await expect(current.persistence.save(workspace("Current"))).resolves.toBeUndefined();
    expect(bridge.openCount).toBe(1);
  });

  it("keeps only a monotonic non-secret request sequence across a module reload", async () => {
    const bridge = new MemorySessionBridge();
    const first = createDesktopWorkspaceSession(bridge, missingLegacy);
    await first.persistence.load();
    first.dispose();
    const firstRequest = bridge.calls.find((call) => call.command === "open_workspace_owner")!.args!;
    vi.resetModules();
    const reloadedModule = await import("./desktopWorkspaceSession");
    const second = reloadedModule.createDesktopWorkspaceSession(bridge, missingLegacy);
    await second.persistence.load();
    const requests = bridge.calls.filter((call) => call.command === "open_workspace_owner");
    const secondRequest = requests[1].args!;
    expect(BigInt(secondRequest.requestSequence as string))
      .toBeGreaterThan(BigInt(firstRequest.requestSequence as string));
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
    expect([...requestStorage]).toEqual([["linked-info.owner-request-sequence.v1", "2"]]);
  });

  it("fails closed instead of resetting an unavailable or invalid request counter", async () => {
    const bridge = new MemorySessionBridge();
    for (const invalid of ["not-a-sequence", "00", "18446744073709551615"]) {
      requestStorage.set("linked-info.owner-request-sequence.v1", invalid);
      await expect(createDesktopWorkspaceSession(bridge, missingLegacy).persistence.load())
        .rejects.toThrow("workspace_owner_request_state_unavailable");
    }
    vi.stubGlobal("sessionStorage", {
      getItem() { throw new Error("synthetic storage failure"); },
    });
    await expect(createDesktopWorkspaceSession(bridge, missingLegacy).persistence.load())
      .rejects.toThrow("workspace_owner_request_state_unavailable");
    expect(bridge.openCount).toBe(0);
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

  it("admits a lock snapshot immediately without waiting for an in-flight disk write", async () => {
    const bridge = new MemorySessionBridge();
    const session = createDesktopWorkspaceSession(bridge, missingLegacy);
    await session.persistence.load();
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const lockResult = deferred<{
      encrypted: boolean;
      locked: boolean;
      systemUnlockAvailable: boolean;
      systemUnlockEnabled: boolean;
      idleTimeoutMinutes: number;
    }>();
    bridge.handler = async (command, args) => {
      if (command === "write_workspace_file") {
        writeStarted.resolve();
        return releaseWrite.promise;
      }
      if (command === "lock_workspace_with_snapshot") return lockResult.promise;
      return bridge.dispatch(command, args);
    };
    const staleWrite = expect(session.persistence.save(workspace("Queued earlier")))
      .rejects.toThrow("workspace_session_disposed");
    await writeStarted.promise;
    const contents = serializeStoredWorkspace(workspace("Latest lock snapshot"));
    const locking = session.lockWithSnapshot(contents);
    expect(bridge.calls[bridge.calls.length - 1]).toEqual({
      command: "lock_workspace_with_snapshot", args: { ownerId: "owner-1", contents },
    });
    session.dispose();
    const locked = {
      encrypted: true,
      locked: true,
      systemUnlockAvailable: false,
      systemUnlockEnabled: false,
      idleTimeoutMinutes: 15,
    };
    lockResult.resolve(locked);
    await expect(locking).resolves.toEqual(locked);
    releaseWrite.resolve();
    await staleWrite;
    await expect(session.lockWithSnapshot(contents)).rejects.toThrow("workspace_session_disposed");
    expect(bridge.calls.filter((call) => call.command === "lock_workspace_with_snapshot")).toHaveLength(1);
    expect(bridge.openCount).toBe(1);
  });
});
