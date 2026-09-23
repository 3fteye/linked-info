import { describe, expect, it, vi } from "vitest";
import { swapWorkspaceRecovery, type WorkspaceRecoveryOperation } from "./workspaceRecoveryOperation";
import { emptyWorkspace, type WorkspaceSwapResult } from "./workspaceStore";

function fixture() {
  const workspace = emptyWorkspace();
  const operation: WorkspaceRecoveryOperation = {
    persistence: {
      swapWithRecovery: vi.fn(async (): Promise<WorkspaceSwapResult> => ({ status: "committed", workspace })),
    },
    isOwnerAlive: vi.fn(() => true),
    publish: vi.fn(),
  };
  return { workspace, operation };
}

describe("recovery swap coordination", () => {
  it("publishes the authoritative workspace exactly once after commit", async () => {
    const { operation, workspace } = fixture();
    expect(await swapWorkspaceRecovery(operation)).toBe("committed");
    expect(operation.persistence.swapWithRecovery).toHaveBeenCalledTimes(1);
    expect(operation.publish).toHaveBeenCalledExactlyOnceWith(workspace);
  });

  it("does not publish or allow retry when the persistence result requires recovery", async () => {
    const { operation } = fixture();
    vi.mocked(operation.persistence.swapWithRecovery).mockResolvedValue({ status: "reloadRequired" });
    expect(await swapWorkspaceRecovery(operation)).toBe("recoveryRequired");
    expect(operation.publish).not.toHaveBeenCalled();
  });

  it("retains the retryable result for a pre-commit rejection", async () => {
    const { operation } = fixture();
    vi.mocked(operation.persistence.swapWithRecovery).mockRejectedValue(new Error("synthetic pre-commit failure"));
    expect(await swapWorkspaceRecovery(operation)).toBe("notCommitted");
    expect(operation.publish).not.toHaveBeenCalled();
  });

  it("quarantines UI publication failure after disk commit instead of reopening writes", async () => {
    const { operation } = fixture();
    vi.mocked(operation.publish).mockImplementation(() => { throw new Error("synthetic publication failure"); });
    expect(await swapWorkspaceRecovery(operation)).toBe("recoveryRequired");
    expect(operation.persistence.swapWithRecovery).toHaveBeenCalledTimes(1);
  });

  it("does not start storage work for an expired owner", async () => {
    const { operation } = fixture();
    vi.mocked(operation.isOwnerAlive).mockReturnValue(false);
    expect(await swapWorkspaceRecovery(operation)).toBe("ownerExpired");
    expect(operation.persistence.swapWithRecovery).not.toHaveBeenCalled();
  });

  for (const result of ["committed", "reloadRequired", "rejected"] as const) {
    it(`ignores a late ${result} result after the owner expires`, async () => {
      const { operation, workspace } = fixture();
      let resolve!: (result: WorkspaceSwapResult) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<WorkspaceSwapResult>((yes, no) => { resolve = yes; reject = no; });
      vi.mocked(operation.persistence.swapWithRecovery).mockReturnValue(pending);
      const running = swapWorkspaceRecovery(operation);
      vi.mocked(operation.isOwnerAlive).mockReturnValue(false);
      if (result === "rejected") reject(new Error("synthetic late failure"));
      else resolve(result === "committed" ? { status: result, workspace } : { status: result });
      expect(await running).toBe("ownerExpired");
      expect(operation.publish).not.toHaveBeenCalled();
    });
  }

  it("does not authorize editing if publishing synchronously expires the owner", async () => {
    const { operation } = fixture();
    vi.mocked(operation.publish).mockImplementation(() => {
      vi.mocked(operation.isOwnerAlive).mockReturnValue(false);
    });
    expect(await swapWorkspaceRecovery(operation)).toBe("ownerExpired");
  });
});
