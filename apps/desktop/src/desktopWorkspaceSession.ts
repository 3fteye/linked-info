import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CapsuleCommitResult, CapsuleHost } from "./capsuleHost";
import type { TimelineNoteInput } from "./timelineWorkspace";
import type { WorkspaceSecurityStatus } from "./workspaceSecurity";
import {
  loadLegacyBrowserWorkspace,
  removeLegacyBrowserWorkspace,
  type WorkspacePersistence,
} from "./workspaceStore";
import {
  createTauriWorkspacePersistence,
  type LegacyWorkspaceSource,
  type WorkspaceFileBridge,
  type WorkspaceFileSwapResult,
} from "./workspaceTauriPersistence";

export interface DesktopWorkspaceSession {
  persistence: WorkspacePersistence;
  capsuleHost: CapsuleHost;
  lockWithSnapshot(contents: string): Promise<WorkspaceSecurityStatus>;
  dispose(): void;
}

export interface DesktopWorkspaceSessionBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  subscribePending(listener: () => void): Promise<() => void>;
}

interface OwnerLease {
  epoch: number;
  requestId: string;
  requestSequence: string;
  ownerId: string | null;
  owner: Promise<string>;
}

const ownerRequestSequenceKey = "linked-info.owner-request-sequence.v1";

function nextOwnerRequest() {
  try {
    const previous = sessionStorage.getItem(ownerRequestSequenceKey) ?? "0";
    if (previous.length > 20 || !/^(0|[1-9][0-9]*)$/.test(previous)) {
      throw new Error("invalid sequence");
    }
    const next = BigInt(previous) + 1n;
    if (next > 18_446_744_073_709_551_615n) {
      throw new Error("sequence exhausted");
    }
    const requestSequence = next.toString();
    const requestId = crypto.randomUUID();
    // This non-secret counter survives a main WebView reload. Owner tokens,
    // request identities, workspace contents, and keys never enter storage.
    sessionStorage.setItem(ownerRequestSequenceKey, requestSequence);
    return { requestId, requestSequence };
  } catch {
    throw new Error("workspace_owner_request_state_unavailable");
  }
}

function commitStatus(result: unknown): unknown {
  return typeof result === "object" && result !== null && "status" in result
    ? result.status
    : undefined;
}

const tauriSessionBridge: DesktopWorkspaceSessionBridge = {
  invoke,
  subscribePending(listener) {
    return listen("capsule-note-pending", listener);
  },
};

const browserLegacySource: LegacyWorkspaceSource = {
  load: loadLegacyBrowserWorkspace,
  remove: removeLegacyBrowserWorkspace,
};

/** One instance belongs to one mounted plaintext App, including StrictMode. */
export function createDesktopWorkspaceSession(
  bridge: DesktopWorkspaceSessionBridge = tauriSessionBridge,
  legacy: LegacyWorkspaceSource = browserLegacySource,
): DesktopWorkspaceSession {
  let disposed = false;
  let epoch = 0;
  let ownerLease: OwnerLease | null = null;
  let renewalBlocked = false;
  const subscriptions = new Set<() => void>();

  function assertActive() {
    if (disposed) {
      throw new Error("workspace_session_disposed");
    }
  }

  function assertCurrent(lease: OwnerLease) {
    assertActive();
    if (lease.epoch !== epoch || lease !== ownerLease || renewalBlocked) {
      throw new Error("workspace_owner_stale");
    }
  }

  function isCurrent(lease: OwnerLease): boolean {
    return !disposed && lease.epoch === epoch && lease === ownerLease && !renewalBlocked;
  }

  function captureOwner(): OwnerLease {
    assertActive();
    if (renewalBlocked) {
      throw new Error("workspace_session_reload_required");
    }
    if (ownerLease === null) {
      throw new Error("workspace_owner_not_initialized");
    }
    return ownerLease;
  }

  function initializeOwner() {
    assertActive();
    if (renewalBlocked) {
      throw new Error("workspace_session_reload_required");
    }
    if (ownerLease === null) {
      const request = nextOwnerRequest();
      const lease: OwnerLease = {
        epoch,
        ...request,
        ownerId: null,
        owner: bridge
          .invoke<{ ownerId: string }>("open_workspace_owner", request)
          .then(({ ownerId }) => {
            if (typeof ownerId !== "string" || ownerId.length === 0) {
              throw new Error("workspace_owner_invalid");
            }
            lease.ownerId = ownerId;
            return ownerId;
          }),
      };
      ownerLease = lease;
    }
  }

  function closeOwner(lease: OwnerLease) {
    // Cancel admission immediately, including an open whose blocking worker
    // or receipt has not completed. Never wait for that open to mint an owner.
    void bridge.invoke<void>("close_workspace_owner", {
      requestId: lease.requestId,
      requestSequence: lease.requestSequence,
      ...(lease.ownerId === null ? {} : { ownerId: lease.ownerId }),
    })
      .catch(() => undefined);
  }

  function retireOwner(lease: OwnerLease, allowRenewal: boolean) {
    assertCurrent(lease);
    epoch += 1;
    ownerLease = null;
    renewalBlocked = !allowRenewal;
    closeOwner(lease);
  }

  async function invokeOwned<T>(
    lease: OwnerLease,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    const ownerId = await lease.owner;
    assertCurrent(lease);
    const result = await bridge.invoke<T>(command, { ...args, ownerId });
    // A late read/take must never return plaintext to an unmounted owner.
    assertCurrent(lease);
    return result;
  }

  async function invokeDurable<T extends CapsuleCommitResult | WorkspaceFileSwapResult>(
    lease: OwnerLease,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T | { status: "committedLocked" }> {
    const ownerId = await lease.owner;
    assertCurrent(lease);
    const result = await bridge.invoke<T>(command, { ...args, ownerId });
    if (!isCurrent(lease) && result.status !== "recoveryRequired") {
      // Keep the durable outcome without disclosing a late swap's contents.
      return { status: "committedLocked" };
    }
    return result;
  }

  const fileBridge: WorkspaceFileBridge = {
    captureWrite() {
      const owner = captureOwner();
      return (slot, contents) =>
        invokeOwned<void>(owner, "write_workspace_file", { slot, contents });
    },
    captureSwap() {
      const owner = captureOwner();
      return () => invokeDurable<WorkspaceFileSwapResult>(owner, "swap_workspace_recovery_files");
    },
    read(slot) {
      if (slot === "primary") {
        initializeOwner();
      }
      return invokeOwned<string | null>(captureOwner(), "read_workspace_file", {
        slot,
      });
    },
    swap() {
      return invokeDurable<WorkspaceFileSwapResult>(
        captureOwner(),
        "swap_workspace_recovery_files",
      );
    },
    write(slot, contents) {
      return invokeOwned<void>(captureOwner(), "write_workspace_file", {
        slot,
        contents,
      });
    },
  };
  const queuedPersistence = createTauriWorkspacePersistence(fileBridge, {
    load(slot) {
      assertActive();
      return legacy.load(slot);
    },
    remove(slot) {
      assertActive();
      legacy.remove(slot);
    },
  });

  const capsuleHost: CapsuleHost = {
    available: true,
    async setReady(ready) {
      const lease = captureOwner();
      await invokeOwned<void>(lease, "set_workspace_owner_ready", {
        ready,
      });
      assertCurrent(lease);
    },
    async take() {
      const lease = captureOwner();
      const result = await invokeOwned<TimelineNoteInput | null>(lease, "take_capsule_note");
      assertCurrent(lease);
      return result;
    },
    async commit(nodeId, contents) {
      const lease = captureOwner();
      const result = await invokeDurable<CapsuleCommitResult>(
        lease,
        "commit_capsule_note",
        { nodeId, contents },
      );
      if (!isCurrent(lease)) {
        return result.status === "recoveryRequired"
          ? result
          : { status: "committedLocked" };
      }
      if (result.status !== "committed") {
        retireOwner(lease, false);
      }
      return result;
    },
    async reject(nodeId, reason) {
      const lease = captureOwner();
      await invokeOwned<void>(lease, "reject_capsule_note", {
        nodeId,
        reason,
      });
      assertCurrent(lease);
    },
    async subscribePending(listener) {
      assertActive();
      const unsubscribe = await bridge.subscribePending(() => {
        if (!disposed) {
          listener();
        }
      });
      if (disposed) {
        unsubscribe();
        assertActive();
      }
      let subscribed = true;
      const remove = () => {
        if (subscribed) {
          subscribed = false;
          subscriptions.delete(remove);
          unsubscribe();
        }
      };
      subscriptions.add(remove);
      return remove;
    },
    async open() {
      assertActive();
      await bridge.invoke<void>("open_capsule_window");
      assertActive();
    },
  };

  return {
    async lockWithSnapshot(contents) {
      const lease = captureOwner();
      const ownerId = lease.ownerId ?? await lease.owner;
      assertCurrent(lease);
      // A loaded owner reaches native admission synchronously, even when a
      // persistence write is blocked. The returned status contains no plaintext
      // and remains valid after the native lock disposes this session.
      return bridge.invoke<WorkspaceSecurityStatus>("lock_workspace_with_snapshot", {
        ownerId,
        contents,
      });
    },
    persistence: {
      load: () => queuedPersistence.load(),
      loadRecovery: () => queuedPersistence.loadRecovery(),
      preserveForRecovery: (workspace) => queuedPersistence.preserveForRecovery(workspace),
      save: (workspace) => queuedPersistence.save(workspace),
      async runExclusiveTransaction(transaction) {
        const lease = captureOwner();
        return queuedPersistence.runExclusiveTransaction(async () => {
          assertCurrent(lease);
          await capsuleHost.setReady(false);
          assertCurrent(lease);
          const result = await transaction();
          const status = commitStatus(result);
          if (!isCurrent(lease)) {
            if (status === "committed" || status === "committedLocked" || status === "recoveryRequired") {
              return result;
            }
            assertCurrent(lease);
          }
          if (status === "committed") {
            retireOwner(lease, true);
          } else if (status === "committedLocked" || status === "recoveryRequired") {
            retireOwner(lease, false);
          }
          return result;
        });
      },
      async swapWithRecovery() {
        const lease = captureOwner();
        await capsuleHost.setReady(false);
        assertCurrent(lease);
        const result = await queuedPersistence.swapWithRecovery();
        if (!isCurrent(lease)) {
          return { status: "reloadRequired" };
        }
        if (result.status !== "committed") {
          retireOwner(lease, false);
          return result;
        }
        retireOwner(lease, true);
        // Swap advances native ownership. Only its confirmed commit may open
        // a replacement owner, and its returned workspace is re-read there.
        try {
          const loading = queuedPersistence.load();
          const reloadLease = ownerLease;
          const reloaded = await loading;
          if (reloaded.status === "ready" && reloadLease !== null && isCurrent(reloadLease)) {
            return { status: "committed", workspace: reloaded.workspace };
          }
        } catch {
          // The swap already committed; failure to reopen/read is recovery
          // required, not evidence that the files were left unchanged.
        }
        const current = ownerLease;
        if (current !== null && isCurrent(current)) {
          retireOwner(current, false);
        }
        return { status: "reloadRequired" };
      },
    },
    capsuleHost,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      queuedPersistence.dispose();
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      const lease = ownerLease;
      if (lease !== null) {
        closeOwner(lease);
      }
    },
  };
}
