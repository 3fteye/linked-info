import type { CapsuleHost, CapsuleRejectReason } from "./capsuleHost";
import {
  captureTimelineNote, TimelineCaptureError, type TimelineCaptureLabels,
} from "./timelineWorkspace";
import {
  serializeStoredWorkspace, type WorkspacePersistence, type WorkspaceSnapshot,
} from "./workspaceStore";

export type ArchiveCompletion = "released" | "recoveryRequired" | "ownerExpired";

/** A synchronous admission decision made by the current workspace owner. */
export interface WorkspaceArchiveLease {
  before: WorkspaceSnapshot;
  prepare(workspace: WorkspaceSnapshot): void;
  publish(workspace: WorkspaceSnapshot, duplicate: boolean): void;
  finish(completion: ArchiveCompletion): void;
}

export interface WorkspaceArchiveOperation {
  host: Pick<CapsuleHost, "take" | "commit" | "reject">;
  persistence: Pick<WorkspacePersistence, "save" | "load">;
  canStart(): boolean;
  isOwnerAlive(): boolean;
  acquire(): WorkspaceArchiveLease | null;
  labels: TimelineCaptureLabels;
  newId(): string;
  notifyFailure(): void;
}

function rejectionReason(error: unknown): CapsuleRejectReason {
  if (!(error instanceof TimelineCaptureError)) return "saveFailed";
  if (error.reason === "duplicate-name") return "duplicateName";
  return error.reason === "empty-note" ? "empty" : "invalid";
}

/**
 * Coordinate one archive without React or Tauri dependencies. The caller keeps
 * queue scheduling and the shared mutation gate; Rust remains the commit authority.
 */
export async function archiveWorkspaceNote(operation: WorkspaceArchiveOperation): Promise<void> {
  let nodeId: string | null = null;
  let lease: WorkspaceArchiveLease | null = null;
  let phase: "preparing" | "committing" | "committed" = "preparing";
  let recoveryRequired = false;
  try {
    if (!operation.isOwnerAlive() || !operation.canStart()) return;
    const request = await operation.host.take();
    if (request === null || !operation.isOwnerAlive()) return;
    nodeId = request.nodeId;
    // Recheck after the asynchronous claim, then acquire without an await gap.
    lease = operation.canStart() ? operation.acquire() : null;
    if (lease === null) {
      await operation.host.reject(nodeId, "busy");
      return;
    }
    const prepared = captureTimelineNote(lease.before, request, operation.labels, operation.newId);
    // Make the validated candidate available to immediate lock before draining saves.
    lease.prepare(prepared.workspace);
    await operation.persistence.save(lease.before);
    if (!operation.isOwnerAlive()) return;
    // Serialization failure is known to precede invocation of the commit port.
    const contents = serializeStoredWorkspace(prepared.workspace);
    phase = "committing";
    const result = await operation.host.commit(nodeId, contents);
    phase = "committed";
    if (!operation.isOwnerAlive()) return;
    if (result.status !== "committed") {
      recoveryRequired = true;
      return;
    }
    const authoritative = await operation.persistence.load();
    if (!operation.isOwnerAlive()) return;
    if (authoritative.status !== "ready") {
      recoveryRequired = true;
      return;
    }
    lease.publish(authoritative.workspace, prepared.duplicate);
  } catch (error) {
    if (!operation.isOwnerAlive()) return;
    if (phase === "committed" || (phase === "committing" && error !== "capsule_commit_not_saved")) {
      // An uncertain/committed write must never be overwritten by the old UI snapshot.
      recoveryRequired = true;
    } else if (nodeId !== null) {
      await operation.host.reject(nodeId, rejectionReason(error)).catch(() => {});
      if (operation.isOwnerAlive()) operation.notifyFailure();
    }
  } finally {
    lease?.finish(!operation.isOwnerAlive() ? "ownerExpired"
      : recoveryRequired ? "recoveryRequired" : "released");
  }
}
