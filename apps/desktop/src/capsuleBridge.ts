import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TimelineNoteInput } from "./timelineWorkspace";

export interface CapsuleContext {
  ownerId: string;
  contextId: string;
}

export interface CapsuleState {
  ownerId: string | null;
  contextId: string | null;
  ready: boolean;
  encrypted: boolean;
}

export interface CapsuleSubmission extends CapsuleContext {
  input: TimelineNoteInput;
}

export interface CapsuleSubmissionIdentity extends CapsuleContext {
  nodeId: string;
}

export interface CapsuleSubmissionResult {
  status: "queued" | "processing" | "saved" | "failed" | "unknown";
  reason?: string;
}

export interface CapsuleBridge {
  inspect(): Promise<CapsuleState>;
  submit(request: CapsuleSubmission): Promise<CapsuleSubmissionResult>;
  inspectSubmission(identity: CapsuleSubmissionIdentity): Promise<CapsuleSubmissionResult>;
  subscribeStateChanged(listener: () => void): Promise<() => void>;
  subscribeLocked(listener: () => void): Promise<() => void>;
  recordActivity(context: CapsuleContext): Promise<void>;
  setExpanded(expanded: boolean): Promise<void>;
  hide(): Promise<void>;
  focusMain(): Promise<void>;
  drag(): Promise<void>;
}

// The capsule never receives a workspace snapshot or a general persistence port.
export const tauriCapsuleBridge: CapsuleBridge = {
  inspect() {
    return invoke<CapsuleState>("inspect_capsule");
  },
  submit(request) {
    return invoke<CapsuleSubmissionResult>("submit_capsule_note", { ...request });
  },
  inspectSubmission(identity) {
    return invoke<CapsuleSubmissionResult>("inspect_capsule_submission", { ...identity });
  },
  subscribeStateChanged(listener) {
    return listen("capsule-state-changed", () => listener());
  },
  subscribeLocked(listener) {
    return listen("workspace-security-locked", () => listener());
  },
  recordActivity(context) {
    return invoke<void>("capsule_record_activity", { ...context });
  },
  setExpanded(expanded) {
    return invoke<void>("set_capsule_expanded", { expanded });
  },
  hide() {
    return invoke<void>("hide_capsule_window");
  },
  focusMain() {
    return invoke<void>("focus_main_window");
  },
  drag() {
    return invoke<void>("drag_capsule_window");
  },
};
