import { describe, expect, it, vi } from "vitest";
import { replaceWorkspace, type WorkspaceReplacementOperation } from "./workspaceReplacementOperation";
import { emptyWorkspace, type WorkspaceLoadResult } from "./workspaceStore";
import type { WorkspaceSecurityTransactionResult } from "./workspaceSecurity";

function fixture(bootstrap = false) {
  const before = emptyWorkspace();
  const target = emptyWorkspace();
  const authoritative = emptyWorkspace();
  before.view.canvases[0].name = "Synthetic before";
  target.view.canvases[0].name = "Synthetic target";
  authoritative.view.canvases[0].name = "Synthetic authoritative";
  const events: string[] = [];
  const status = { encrypted: true, locked: false, systemUnlockAvailable: false,
    systemUnlockEnabled: false, idleTimeoutMinutes: 15 };
  const operation: WorkspaceReplacementOperation = {
    before,
    request: bootstrap ? { kind: "bootstrap", restoreId: "synthetic-restore" }
      : { kind: "snapshot", workspace: target },
    persistence: {
      load: vi.fn(async (): Promise<WorkspaceLoadResult> => {
        events.push("load"); return { status: "ready", workspace: authoritative };
      }),
      async loadRecovery() { return { status: "missing" }; },
      preserveForRecovery: vi.fn(async () => { events.push("preserve"); }),
      save: vi.fn(async () => { events.push("save"); }),
      async runExclusiveTransaction(transaction) { events.push("exclusive"); return transaction(); },
      async swapWithRecovery() { throw new Error("not used"); },
    },
    security: {
      commitRestore: vi.fn(async (): Promise<WorkspaceSecurityTransactionResult> => {
        events.push("commit"); return { status: "committed", securityStatus: status };
      }),
    },
    suspendCapture: vi.fn(async () => { events.push("suspend"); }),
    isOwnerAlive: vi.fn(() => true),
    updateSecurity: vi.fn(() => { events.push("security"); }),
    publish: vi.fn(() => { events.push("publish"); }),
  };
  return { operation, before, target, authoritative, status, events };
}

describe("workspace replacement operation", () => {
  it("preserves the current snapshot before saving and publishing the selected replacement", async () => {
    const { operation, before, target, events } = fixture();
    expect(await replaceWorkspace(operation)).toBe("committed");
    expect(events).toEqual(["suspend", "preserve", "save", "publish"]);
    expect(operation.persistence.preserveForRecovery).toHaveBeenCalledExactlyOnceWith(before);
    expect(operation.persistence.save).toHaveBeenCalledExactlyOnceWith(target);
    expect(operation.publish).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("uses native bootstrap commit and authoritative reload rather than the preview", async () => {
    const { operation, before, authoritative, events } = fixture(true);
    expect(await replaceWorkspace(operation)).toBe("committed");
    expect(events).toEqual(["suspend", "save", "exclusive", "commit", "security", "load", "publish"]);
    expect(operation.persistence.save).toHaveBeenCalledExactlyOnceWith(before);
    expect(operation.security.commitRestore).toHaveBeenCalledExactlyOnceWith("synthetic-restore");
    expect(operation.publish).toHaveBeenCalledExactlyOnceWith(authoritative);
    expect(operation.persistence.preserveForRecovery).not.toHaveBeenCalled();
  });

  it("does not replace data if preserving the current snapshot fails", async () => {
    const { operation } = fixture();
    vi.mocked(operation.persistence.preserveForRecovery).mockRejectedValue(new Error("synthetic preserve failure"));
    expect(await replaceWorkspace(operation)).toBe("notCommitted");
    expect(operation.persistence.save).not.toHaveBeenCalled();
  });

  it("quarantines a failed ordinary save because its void port cannot prove no commit", async () => {
    const { operation } = fixture();
    vi.mocked(operation.persistence.save).mockRejectedValue(new Error("synthetic post-write failure"));
    expect(await replaceWorkspace(operation)).toBe("recoveryRequired");
    expect(operation.publish).not.toHaveBeenCalled();
  });

  for (const bootstrap of [false, true]) {
    it(`quarantines post-commit publication failure (bootstrap=${bootstrap})`, async () => {
      const { operation } = fixture(bootstrap);
      vi.mocked(operation.publish).mockImplementation(() => { throw new Error("synthetic publish failure"); });
      expect(await replaceWorkspace(operation)).toBe("recoveryRequired");
    });
  }

  it("retains a retryable rejection before native bootstrap commit", async () => {
    const { operation } = fixture(true);
    vi.mocked(operation.security.commitRestore).mockRejectedValue(new Error("synthetic native rejection"));
    expect(await replaceWorkspace(operation)).toBe("notCommitted");
    expect(operation.publish).not.toHaveBeenCalled();
  });

  for (const result of ["committedLocked", "recoveryRequired"] as const) {
    it(`does not load or publish for bootstrap ${result}`, async () => {
      const { operation, status } = fixture(true);
      vi.mocked(operation.security.commitRestore).mockResolvedValue(result === "committedLocked"
        ? { status: result, securityStatus: { ...status, locked: true } } : { status: result });
      expect(await replaceWorkspace(operation)).toBe(result);
      expect(operation.persistence.load).not.toHaveBeenCalled();
      expect(operation.publish).not.toHaveBeenCalled();
      expect(operation.updateSecurity).toHaveBeenCalledTimes(result === "committedLocked" ? 1 : 0);
    });
  }

  for (const failedRead of [false, true]) {
    it(`quarantines missing or failed bootstrap reload (reject=${failedRead})`, async () => {
      const { operation } = fixture(true);
      if (failedRead) vi.mocked(operation.persistence.load).mockRejectedValue(new Error("synthetic read failure"));
      else vi.mocked(operation.persistence.load).mockResolvedValue({ status: "missing" });
      expect(await replaceWorkspace(operation)).toBe("recoveryRequired");
      expect(operation.publish).not.toHaveBeenCalled();
    });
  }

  it("rejects a bootstrap request without a prepared identity before any write", async () => {
    const { operation } = fixture(true);
    operation.request = { kind: "bootstrap", restoreId: "" };
    expect(await replaceWorkspace(operation)).toBe("notCommitted");
    expect(operation.persistence.save).not.toHaveBeenCalled();
  });

  for (const boundary of ["suspend", "preserve", "save", "commit", "load"] as const) {
    it(`stops late work if the owner expires during ${boundary}`, async () => {
      const { operation, status, authoritative } = fixture(boundary === "commit" || boundary === "load");
      const expire = () => vi.mocked(operation.isOwnerAlive).mockReturnValue(false);
      if (boundary === "suspend") vi.mocked(operation.suspendCapture).mockImplementation(async () => { expire(); });
      if (boundary === "preserve") vi.mocked(operation.persistence.preserveForRecovery).mockImplementation(async () => { expire(); });
      if (boundary === "save") vi.mocked(operation.persistence.save).mockImplementation(async () => { expire(); });
      if (boundary === "commit") vi.mocked(operation.security.commitRestore).mockImplementation(async () => {
        expire(); return { status: "committed", securityStatus: status };
      });
      if (boundary === "load") vi.mocked(operation.persistence.load).mockImplementation(async () => {
        expire(); return { status: "ready", workspace: authoritative };
      });
      expect(await replaceWorkspace(operation)).toBe("ownerExpired");
      expect(operation.publish).not.toHaveBeenCalled();
      if (boundary === "preserve") expect(operation.persistence.save).not.toHaveBeenCalled();
    });
  }
});
