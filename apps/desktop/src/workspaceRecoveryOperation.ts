import type { WorkspacePersistence, WorkspaceSnapshot } from "./workspaceStore";

export type RecoveryOperationOutcome =
  | "committed"
  | "notCommitted"
  | "recoveryRequired"
  | "ownerExpired";

export interface WorkspaceRecoveryOperation {
  persistence: Pick<WorkspacePersistence, "swapWithRecovery">;
  isOwnerAlive(): boolean;
  publish(workspace: WorkspaceSnapshot): void;
}

/**
 * Run an already-admitted recovery swap. The caller keeps its shared mutation
 * gate closed until the outcome is handled. Persistence rejects only before
 * commit; ambiguous or committed-but-unreadable results use reloadRequired.
 */
export async function swapWorkspaceRecovery(
  operation: WorkspaceRecoveryOperation,
): Promise<RecoveryOperationOutcome> {
  if (!operation.isOwnerAlive()) return "ownerExpired";
  let committed = false;
  try {
    const result = await operation.persistence.swapWithRecovery();
    if (!operation.isOwnerAlive()) return "ownerExpired";
    if (result.status === "reloadRequired") return "recoveryRequired";
    committed = true;
    operation.publish(result.workspace);
    return operation.isOwnerAlive() ? "committed" : "ownerExpired";
  } catch {
    if (!operation.isOwnerAlive()) return "ownerExpired";
    // UI application failure cannot turn an already committed disk exchange
    // into a retryable failure and allow the stale snapshot to be saved.
    return committed ? "recoveryRequired" : "notCommitted";
  }
}
