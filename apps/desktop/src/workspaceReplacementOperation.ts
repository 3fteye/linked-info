import type { WorkspacePersistence, WorkspaceSnapshot } from "./workspaceStore";
import type { WorkspaceSecurity, WorkspaceSecurityStatus } from "./workspaceSecurity";

export type WorkspaceReplacementRequest =
  | { kind: "snapshot"; workspace: WorkspaceSnapshot }
  | { kind: "bootstrap"; restoreId: string };

export type WorkspaceReplacementOutcome =
  | "committed" | "notCommitted" | "recoveryRequired" | "committedLocked" | "ownerExpired";

export interface WorkspaceReplacementOperation {
  request: WorkspaceReplacementRequest;
  before: WorkspaceSnapshot;
  persistence: WorkspacePersistence;
  security: Pick<WorkspaceSecurity, "commitRestore">;
  suspendCapture(): Promise<void>;
  isOwnerAlive(): boolean;
  updateSecurity(status: WorkspaceSecurityStatus): void;
  publish(workspace: WorkspaceSnapshot): void;
}

/** Coordinate an admitted replacement, not its UI confirmation or native authorization. */
export async function replaceWorkspace(
  operation: WorkspaceReplacementOperation,
): Promise<WorkspaceReplacementOutcome> {
  let phase: "preparing" | "writingSnapshot" | "committed" = "preparing";
  try {
    if (!operation.isOwnerAlive()) return "ownerExpired";
    await operation.suspendCapture();
    if (!operation.isOwnerAlive()) return "ownerExpired";
    let next: WorkspaceSnapshot;
    if (operation.request.kind === "bootstrap") {
      const restoreId = operation.request.restoreId;
      if (!restoreId) return "notCommitted";
      await operation.persistence.save(operation.before);
      if (!operation.isOwnerAlive()) return "ownerExpired";
      // The security port rejects only before commit and returns tagged results
      // for committed/uncertain outcomes. Do not reinterpret them as rejection.
      const result = await operation.persistence.runExclusiveTransaction(() =>
        operation.security.commitRestore(restoreId),
      );
      phase = "committed";
      if (!operation.isOwnerAlive()) return "ownerExpired";
      if (result.status === "recoveryRequired") return "recoveryRequired";
      operation.updateSecurity(result.securityStatus);
      if (!operation.isOwnerAlive()) return "ownerExpired";
      if (result.status === "committedLocked") return "committedLocked";
      const loaded = await operation.persistence.load();
      if (!operation.isOwnerAlive()) return "ownerExpired";
      if (loaded.status !== "ready") return "recoveryRequired";
      next = loaded.workspace;
    } else {
      await operation.persistence.preserveForRecovery(operation.before);
      if (!operation.isOwnerAlive()) return "ownerExpired";
      // save() has no tagged commit result: an exception after invocation may
      // come from post-write cleanup. Conservatively prohibit a stale rewrite.
      phase = "writingSnapshot";
      await operation.persistence.save(operation.request.workspace);
      phase = "committed";
      if (!operation.isOwnerAlive()) return "ownerExpired";
      next = operation.request.workspace;
    }
    operation.publish(next);
    return operation.isOwnerAlive() ? "committed" : "ownerExpired";
  } catch {
    if (!operation.isOwnerAlive()) return "ownerExpired";
    return phase === "preparing" ? "notCommitted" : "recoveryRequired";
  }
}
