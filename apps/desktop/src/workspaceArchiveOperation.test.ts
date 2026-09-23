import { describe, expect, it, vi } from "vitest";
import {
  archiveWorkspaceNote, type WorkspaceArchiveLease, type WorkspaceArchiveOperation,
} from "./workspaceArchiveOperation";
import type { CapsuleCommitResult } from "./capsuleHost";
import { captureTimelineNote, type TimelineNoteInput } from "./timelineWorkspace";
import { emptyWorkspace, type WorkspaceLoadResult, type WorkspaceSnapshot } from "./workspaceStore";

const note: TimelineNoteInput = {
  nodeId: "11111111-1111-4111-8111-111111111111",
  name: "Synthetic note", content: "Synthetic body",
  capturedAtMs: Date.UTC(2026, 8, 23, 12), utcOffsetMinutes: 0,
};
const labels = { canvasName: "Synthetic timeline", dateNodeName: (date: string) => date };

function fixture() {
  let id = 10;
  const newId = () => `22222222-2222-4222-8222-${String(id++).padStart(12, "0")}`;
  const before = emptyWorkspace();
  const authoritative = captureTimelineNote(before, note, labels, newId).workspace;
  const events: string[] = [];
  const lease: WorkspaceArchiveLease = {
    before,
    prepare: vi.fn(() => { events.push("prepare"); }),
    publish: vi.fn(() => { events.push("publish"); }),
    finish: vi.fn(() => { events.push("finish"); }),
  };
  const operation: WorkspaceArchiveOperation = {
    host: {
      take: vi.fn(async () => { events.push("take"); return note; }),
      commit: vi.fn(async (): Promise<CapsuleCommitResult> => {
        events.push("commit"); return { status: "committed" };
      }),
      reject: vi.fn(async () => { events.push("reject"); }),
    },
    persistence: {
      save: vi.fn(async () => { events.push("save"); }),
      load: vi.fn(async (): Promise<WorkspaceLoadResult> => {
        events.push("load"); return { status: "ready", workspace: authoritative };
      }),
    },
    canStart: vi.fn(() => true), isOwnerAlive: vi.fn(() => true),
    acquire: vi.fn(() => { events.push("acquire"); return lease; }),
    labels, newId, notifyFailure: vi.fn(),
  };
  return { operation, lease, events, authoritative };
}

describe("workspace archive operation", () => {
  it("prepares the lock candidate before saving and publishes only the authoritative reload", async () => {
    const { operation, lease, events, authoritative } = fixture();
    await archiveWorkspaceNote(operation);
    expect(events).toEqual(["take", "acquire", "prepare", "save", "commit", "load", "publish", "finish"]);
    expect(operation.persistence.save).toHaveBeenCalledExactlyOnceWith(lease.before);
    expect(lease.publish).toHaveBeenCalledExactlyOnceWith(authoritative, false);
    expect(lease.finish).toHaveBeenCalledExactlyOnceWith("released");
  });

  it("does not claim or release another operation's boundary when admission is blocked", async () => {
    const { operation, lease } = fixture();
    vi.mocked(operation.canStart).mockReturnValue(false);
    await archiveWorkspaceNote(operation);
    expect(operation.host.take).not.toHaveBeenCalled();
    expect(operation.acquire).not.toHaveBeenCalled();
    expect(lease.finish).not.toHaveBeenCalled();
  });

  it("rechecks admission after take without clearing another operation's pending candidate", async () => {
    const { operation, lease } = fixture();
    vi.mocked(operation.canStart).mockReturnValueOnce(true).mockReturnValue(false);
    await archiveWorkspaceNote(operation);
    expect(operation.host.reject).toHaveBeenCalledExactlyOnceWith(note.nodeId, "busy");
    expect(operation.acquire).not.toHaveBeenCalled();
    expect(lease.finish).not.toHaveBeenCalled();
  });

  it("rejects a claim if the shared gate cannot grant a lease", async () => {
    const { operation, lease } = fixture();
    vi.mocked(operation.acquire).mockReturnValue(null);
    await archiveWorkspaceNote(operation);
    expect(operation.host.reject).toHaveBeenCalledWith(note.nodeId, "busy");
    expect(lease.finish).not.toHaveBeenCalled();
  });

  for (const status of ["committedLocked", "recoveryRequired"] as const) {
    it(`keeps the mutation boundary closed for ${status}`, async () => {
      const { operation, lease } = fixture();
      vi.mocked(operation.host.commit).mockResolvedValue({ status });
      await archiveWorkspaceNote(operation);
      expect(lease.finish).toHaveBeenCalledExactlyOnceWith("recoveryRequired");
      expect(operation.persistence.load).not.toHaveBeenCalled();
      expect(operation.host.reject).not.toHaveBeenCalled();
      expect(lease.publish).not.toHaveBeenCalled();
    });
  }

  for (const failure of ["capsule_commit_not_saved", new Error("unknown commit outcome")]) {
    it(`distinguishes known uncommitted failure from ${String(failure)}`, async () => {
      const { operation, lease } = fixture();
      vi.mocked(operation.host.commit).mockRejectedValue(failure);
      await archiveWorkspaceNote(operation);
      const known = failure === "capsule_commit_not_saved";
      expect(lease.finish).toHaveBeenCalledWith(known ? "released" : "recoveryRequired");
      expect(operation.host.reject).toHaveBeenCalledTimes(known ? 1 : 0);
      expect(operation.notifyFailure).toHaveBeenCalledTimes(known ? 1 : 0);
      expect(lease.publish).not.toHaveBeenCalled();
    });
  }

  it("releases a pre-commit save failure without attempting commit", async () => {
    const { operation, lease } = fixture();
    vi.mocked(operation.persistence.save).mockRejectedValue(new Error("synthetic save failure"));
    await archiveWorkspaceNote(operation);
    expect(operation.host.commit).not.toHaveBeenCalled();
    expect(operation.host.reject).toHaveBeenCalledWith(note.nodeId, "saveFailed");
    expect(lease.finish).toHaveBeenCalledWith("released");
  });

  it("requires recovery when authoritative loading fails after commit", async () => {
    const { operation, lease } = fixture();
    vi.mocked(operation.persistence.load).mockRejectedValue("capsule_commit_not_saved");
    await archiveWorkspaceNote(operation);
    expect(lease.finish).toHaveBeenCalledWith("recoveryRequired");
    expect(operation.host.reject).not.toHaveBeenCalled();
    expect(lease.publish).not.toHaveBeenCalled();
  });

  it("requires recovery for a non-ready authoritative snapshot", async () => {
    const { operation, lease } = fixture();
    vi.mocked(operation.persistence.load).mockResolvedValue({ status: "missing" });
    await archiveWorkspaceNote(operation);
    expect(lease.finish).toHaveBeenCalledWith("recoveryRequired");
    expect(lease.publish).not.toHaveBeenCalled();
  });

  for (const boundary of ["take", "save", "commit", "load"] as const) {
    it(`discards late results after owner expiration during ${boundary}`, async () => {
      const { operation, lease } = fixture();
      let alive = true;
      vi.mocked(operation.isOwnerAlive).mockImplementation(() => alive);
      if (boundary === "take") vi.mocked(operation.host.take).mockImplementation(async () => {
        alive = false; return note;
      });
      if (boundary === "save") vi.mocked(operation.persistence.save).mockImplementation(async () => {
        alive = false;
      });
      if (boundary === "commit") vi.mocked(operation.host.commit).mockImplementation(async () => {
        alive = false; return { status: "committed" };
      });
      if (boundary === "load") vi.mocked(operation.persistence.load).mockImplementation(async () => {
        alive = false; return { status: "ready", workspace: emptyWorkspace() };
      });
      await archiveWorkspaceNote(operation);
      expect(lease.publish).not.toHaveBeenCalled();
      expect(operation.host.reject).not.toHaveBeenCalled();
      if (boundary === "take") expect(lease.finish).not.toHaveBeenCalled();
      else expect(lease.finish).toHaveBeenCalledExactlyOnceWith("ownerExpired");
      if (boundary === "take" || boundary === "save") expect(operation.host.commit).not.toHaveBeenCalled();
    });
  }

  it("retains duplicate semantics so the UI does not create another undo entry", async () => {
    const { operation, lease, authoritative } = fixture();
    lease.before = authoritative;
    await archiveWorkspaceNote(operation);
    expect(lease.publish).toHaveBeenCalledExactlyOnceWith(authoritative, true);
  });

  it("rejects an empty note before writing", async () => {
    const { operation, lease } = fixture();
    vi.mocked(operation.host.take).mockResolvedValue({ ...note, name: "", content: "" });
    await archiveWorkspaceNote(operation);
    expect(operation.host.reject).toHaveBeenCalledWith(note.nodeId, "empty");
    expect(operation.persistence.save).not.toHaveBeenCalled();
    expect(lease.finish).toHaveBeenCalledWith("released");
  });

  it("quarantines publication failure after a durable commit", async () => {
    const { operation, lease } = fixture();
    vi.mocked(lease.publish).mockImplementation((_workspace: WorkspaceSnapshot) => {
      throw new Error("synthetic publication failure");
    });
    await archiveWorkspaceNote(operation);
    expect(lease.finish).toHaveBeenCalledWith("recoveryRequired");
    expect(operation.host.reject).not.toHaveBeenCalled();
  });
});
