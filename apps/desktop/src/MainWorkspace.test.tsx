// @vitest-environment happy-dom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapsuleHost } from "./capsuleHost";
import type { DesktopWorkspaceSession } from "./desktopWorkspaceSession";
import type { WorkspacePersistence } from "./workspaceStore";
import type { WorkspaceSecurity, WorkspaceSecurityStatus } from "./workspaceSecurity";

interface SessionRecord {
  id: number;
  disposed: boolean;
  disposeCount: number;
  lockSnapshots: string[];
  session: DesktopWorkspaceSession;
}

const harness = vi.hoisted(() => ({
  createSession: vi.fn<() => DesktopWorkspaceSession>(),
  sessions: [] as SessionRecord[],
  appMounts: [] as number[],
  invalidMounts: [] as number[],
  loadErrors: [] as string[],
  restartCalls: 0,
  nativeLockCalls: 0,
  snapshotLockGate: null as Promise<void> | null,
  appSecurity: null as WorkspaceSecurity | null,
  loadGate: null as Promise<void> | null,
  lockListeners: new Set<(event: { payload: string }) => void>(),
  updateSecurity: null as ((status: WorkspaceSecurityStatus) => void) | null,
  status: {
    encrypted: true,
    locked: false,
    systemUnlockAvailable: true,
    systemUnlockEnabled: true,
    idleTimeoutMinutes: 15,
  } as WorkspaceSecurityStatus,
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async (command: string) => {
    if (command === "inspect_workspace_security") {
      return { ...harness.status };
    }
    if (command === "unlock_workspace_with_system") {
      harness.status = { ...harness.status, locked: false };
      return { ...harness.status };
    }
    if (command === "record_workspace_activity") {
      return undefined;
    }
    if (command === "lock_workspace") {
      harness.nativeLockCalls += 1;
      return { ...harness.status, locked: true };
    }
    if (command === "restart_application") {
      harness.restartCalls += 1;
      return undefined;
    }
    throw new Error(`unexpected synthetic native command: ${command}`);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (
    event: string,
    listener: (event: { payload: string }) => void,
  ) => {
    if (event !== "workspace-security-locked") {
      throw new Error(`unexpected synthetic native event: ${event}`);
    }
    harness.lockListeners.add(listener);
    return () => { harness.lockListeners.delete(listener); };
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
  }),
}));

vi.mock("./desktopWorkspaceSession", () => ({
  createDesktopWorkspaceSession: harness.createSession,
}));

vi.mock("./App", () => ({
  default: function AppProbe({
    capsuleHost,
    persistence,
    updateWorkspaceSecurityStatus,
    workspaceSecurity,
  }: {
    capsuleHost: CapsuleHost;
    persistence: WorkspacePersistence;
    updateWorkspaceSecurityStatus: (status: WorkspaceSecurityStatus) => void;
    workspaceSecurity: WorkspaceSecurity;
  }) {
    const record = harness.sessions.find(
      (candidate) => candidate.session.persistence === persistence,
    );
    if (record === undefined || record.session.capsuleHost !== capsuleHost) {
      throw new Error("App received mismatched session services");
    }
    if (record.disposed) {
      harness.invalidMounts.push(record.id);
    }
    harness.updateSecurity = updateWorkspaceSecurityStatus;
    harness.appSecurity = workspaceSecurity;
    useEffect(() => {
      harness.appMounts.push(record.id);
      if (record.disposed) {
        harness.invalidMounts.push(record.id);
      }
      void persistence.load().catch((error: Error) => {
        harness.loadErrors.push(error.message);
      });
    }, [persistence, record]);
    return <div data-testid="session-app" data-session-id={record.id} />;
  },
}));

import MainWorkspace from "./MainWorkspace";
import { unavailableCapsuleHost } from "./capsuleHost";
import { tauriWorkspaceSecurity } from "./workspaceSecurity";

function createSession(): DesktopWorkspaceSession {
  const loadGate = harness.loadGate;
  const record: SessionRecord = {
    id: harness.sessions.length + 1,
    disposed: false,
    disposeCount: 0,
    lockSnapshots: [],
    session: {
      capsuleHost: { ...unavailableCapsuleHost, available: true },
      async lockWithSnapshot(contents) {
        assertActive();
        record.lockSnapshots.push(contents);
        await harness.snapshotLockGate;
        return { ...harness.status, locked: true };
      },
      persistence: {
        async load() {
          assertActive();
          await loadGate;
          assertActive();
          return { status: "missing" };
        },
        async loadRecovery() {
          assertActive();
          return { status: "missing" };
        },
        async save() {
          assertActive();
        },
        async preserveForRecovery() {
          assertActive();
        },
        async runExclusiveTransaction(transaction) {
          assertActive();
          return transaction();
        },
        async swapWithRecovery() {
          assertActive();
          return { status: "reloadRequired" };
        },
      },
      dispose() {
        record.disposeCount += 1;
        record.disposed = true;
      },
    },
  };
  function assertActive() {
    if (record.disposed) {
      throw new Error("workspace_session_disposed");
    }
  }
  harness.sessions.push(record);
  return record.session;
}

describe("MainWorkspace session composition", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    harness.sessions = [];
    harness.appMounts = [];
    harness.invalidMounts = [];
    harness.loadErrors = [];
    harness.restartCalls = 0;
    harness.nativeLockCalls = 0;
    harness.snapshotLockGate = null;
    harness.appSecurity = null;
    harness.loadGate = null;
    harness.lockListeners.clear();
    harness.updateSecurity = null;
    harness.status = {
      encrypted: true,
      locked: false,
      systemUnlockAvailable: true,
      systemUnlockEnabled: true,
      idleTimeoutMinutes: 15,
    };
    harness.createSession.mockReset();
    harness.createSession.mockImplementation(createSession);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  async function render() {
    await act(async () => {
      root?.render(<StrictMode><MainWorkspace /></StrictMode>);
    });
  }

  async function lock() {
    await act(async () => {
      harness.status = { ...harness.status, locked: true };
      for (const listener of harness.lockListeners) {
        listener({ payload: "windows_session_locked" });
      }
    });
  }

  it("mounts App only with the live setup's services during StrictMode effect replay", async () => {
    await render();

    expect(harness.createSession).toHaveBeenCalledTimes(2);
    expect(harness.sessions[0].disposeCount).toBe(1);
    expect(harness.sessions[1].disposeCount).toBe(0);
    expect(harness.appMounts.length).toBeGreaterThan(0);
    expect(new Set(harness.appMounts)).toEqual(new Set([2]));
    expect(harness.invalidMounts).toEqual([]);
    expect(harness.loadErrors).toEqual([]);
    expect(container.querySelector('[data-testid="session-app"]')?.getAttribute("data-session-id"))
      .toBe("2");
  });

  it("does not replace a live owner when its security status is updated", async () => {
    await render();
    const current = harness.sessions[1];
    const ownerSecurity = harness.appSecurity;
    await act(async () => {
      harness.updateSecurity?.({ ...harness.status, idleTimeoutMinutes: 30 });
    });

    expect(harness.createSession).toHaveBeenCalledTimes(2);
    expect(current.disposeCount).toBe(0);
    expect(harness.appSecurity).toBe(ownerSecurity);
    expect(harness.invalidMounts).toEqual([]);
    expect(container.querySelector('[data-testid="session-app"]')?.getAttribute("data-session-id"))
      .toBe(String(current.id));
  });

  it("routes lock snapshots only to the mounted session and rejects the previous owner's wrapper", async () => {
    await render();
    const originalSecurity = harness.appSecurity;
    if (originalSecurity === null) throw new Error("missing synthetic owner security");
    await originalSecurity.lock("synthetic snapshot for owner two");
    expect(harness.sessions[0].lockSnapshots).toEqual([]);
    expect(harness.sessions[1].lockSnapshots).toEqual(["synthetic snapshot for owner two"]);
    expect(harness.nativeLockCalls).toBe(0);

    await lock();
    const unlock = container.querySelector<HTMLButtonElement>(".security-system-unlock button");
    if (unlock === null) throw new Error("missing synthetic unlock button");
    await act(async () => { unlock.click(); });
    const currentSecurity = harness.appSecurity;
    if (currentSecurity === null) throw new Error("missing replacement owner security");
    await currentSecurity.lock("synthetic snapshot for owner four");
    await expect(originalSecurity.lock("stale owner's snapshot")).rejects.toThrow("workspace_session_disposed");
    expect(harness.sessions[1].lockSnapshots).toEqual(["synthetic snapshot for owner two"]);
    expect(harness.sessions[3].lockSnapshots).toEqual(["synthetic snapshot for owner four"]);
    expect(harness.nativeLockCalls).toBe(0);
  });

  it("keeps snapshot-free lock calls on the existing native security adapter", async () => {
    await render();
    await harness.appSecurity?.lock();
    expect(harness.nativeLockCalls).toBe(1);
    expect(harness.sessions.every((record) => record.lockSnapshots.length === 0)).toBe(true);
  });

  it("does not silently discard a snapshot passed to the unscoped native adapter", async () => {
    await expect(tauriWorkspaceSecurity.lock("unowned synthetic snapshot"))
      .rejects.toThrow("workspace_lock_snapshot_owner_required");
    expect(harness.nativeLockCalls).toBe(0);
  });

  it("keeps the accepted snapshot result valid after the start event disposes its owner", async () => {
    let releaseLock: () => void = () => {};
    harness.snapshotLockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    await render();
    const ownerSecurity = harness.appSecurity;
    if (ownerSecurity === null) throw new Error("missing synthetic owner security");
    const locking = ownerSecurity.lock("accepted synthetic snapshot");
    await act(async () => {
      harness.status = { ...harness.status, locked: true };
      for (const listener of harness.lockListeners) {
        listener({ payload: "workspace_lock_save_started" });
      }
    });
    expect(harness.sessions[1].disposed).toBe(true);
    expect(container.querySelector('[data-testid="session-app"]')).toBeNull();
    await act(async () => { releaseLock(); });
    await expect(locking).resolves.toMatchObject({ locked: true });
    expect(harness.sessions[1].lockSnapshots).toEqual(["accepted synthetic snapshot"]);
    expect(container.querySelector('[data-testid="session-app"]')).toBeNull();
  });

  it("disposes the old owner on lock and creates different services only after explicit unlock", async () => {
    await render();
    await lock();
    expect(container.querySelector('[data-testid="session-app"]')).toBeNull();
    expect(harness.sessions.map((record) => record.disposeCount)).toEqual([1, 1]);

    const unlock = container.querySelector<HTMLButtonElement>(".security-system-unlock button");
    if (unlock === null) {
      throw new Error("missing synthetic system unlock button");
    }
    await act(async () => {
      unlock.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(harness.createSession).toHaveBeenCalledTimes(4);
    expect(harness.sessions.map((record) => record.disposeCount)).toEqual([1, 1, 1, 0]);
    expect(harness.invalidMounts).toEqual([]);
    expect(new Set(harness.appMounts)).toEqual(new Set([2, 4]));
    expect(container.querySelector('[data-testid="session-app"]')?.getAttribute("data-session-id"))
      .toBe("4");
  });

  it("unmounts and disposes without waiting for an in-flight plaintext load", async () => {
    let releaseLoad: () => void = () => {};
    harness.loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    await render();
    expect(harness.loadErrors).toEqual([]);

    await lock();
    expect(harness.sessions[1].disposed).toBe(true);
    expect(container.querySelector('[data-testid="session-app"]')).toBeNull();
    expect(harness.loadErrors).toEqual([]);

    await act(async () => { releaseLoad(); });
    expect(harness.loadErrors.length).toBeGreaterThan(0);
    expect(new Set(harness.loadErrors)).toEqual(new Set(["workspace_session_disposed"]));
    expect(harness.invalidMounts).toEqual([]);
  });

  it("wires recovery restart through the native lifecycle after disposing the owner", async () => {
    await render();
    await act(async () => {
      for (const listener of harness.lockListeners) {
        listener({ payload: "capsule_recovery_required" });
      }
    });
    expect(harness.sessions[1].disposed).toBe(true);
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-security-recovery-required"] button',
    );
    if (button === null) throw new Error("missing synthetic native restart button");

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(harness.restartCalls).toBe(1);
    expect(container.querySelector('[data-testid="session-app"]')).toBeNull();
  });
});
