import type { TimelineNoteInput } from "./timelineWorkspace";

export type CapsuleCommitResult =
  | { status: "committed" }
  | { status: "committedLocked" }
  | { status: "recoveryRequired" };

export type CapsuleRejectReason =
  | "busy"
  | "duplicateName"
  | "empty"
  | "invalid"
  | "saveFailed";

/** Only the main workspace owner can consume and durably acknowledge notes. */
export interface CapsuleHost {
  available: boolean;
  setReady(ready: boolean): Promise<void>;
  take(): Promise<TimelineNoteInput | null>;
  commit(nodeId: string, contents: string): Promise<CapsuleCommitResult>;
  reject(nodeId: string, reason: CapsuleRejectReason): Promise<void>;
  subscribePending(listener: () => void): Promise<() => void>;
  open(): Promise<void>;
}

export const unavailableCapsuleHost: CapsuleHost = {
  available: false,
  async setReady() {},
  async take() {
    return null;
  },
  async commit() {
    throw new Error("capsule_unavailable");
  },
  async reject() {
    throw new Error("capsule_unavailable");
  },
  async subscribePending() {
    return () => {};
  },
  async open() {
    throw new Error("capsule_unavailable");
  },
};
