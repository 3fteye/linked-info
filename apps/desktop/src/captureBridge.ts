import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type CaptureState = "draft" | "pending" | "claimed" | "failed" | "uncertain" | "archived";
export type CaptureFailure = "duplicateName" | "empty" | "invalid" | "saveFailed";

export interface CaptureSummary {
  id: string;
  revision: number;
  state: CaptureState;
  name: string;
  capturedAtMs: number | null;
  utcOffsetMinutes: number | null;
  failure: CaptureFailure | null;
}

export interface CaptureRecord extends CaptureSummary {
  content: string;
}

/** Only bounded plaintext inbox records cross this port, never a workspace. */
export interface CaptureBridge {
  list(): Promise<CaptureSummary[]>;
  get(id: string): Promise<CaptureRecord | null>;
  create(): Promise<CaptureRecord>;
  save(id: string, expectedRevision: number, name: string, content: string): Promise<CaptureRecord>;
  submit(id: string, expectedRevision: number, capturedAtMs: number, utcOffsetMinutes: number): Promise<CaptureRecord>;
  subscribeCloseRequested(listener: () => void): Promise<() => void>;
  setExpanded(expanded: boolean): Promise<void>;
  drag(): Promise<void>;
  exit(): Promise<void>;
}

export const tauriCaptureBridge: CaptureBridge = {
  list: () => invoke("capture_list"),
  get: (id) => invoke("capture_get", { id }),
  create: () => invoke("capture_create"),
  save: (id, expectedRevision, name, content) => invoke("capture_save", {
    id, expectedRevision, name, content,
  }),
  submit: (id, expectedRevision, capturedAtMs, utcOffsetMinutes) => invoke("capture_submit", {
    id, expectedRevision, capturedAtMs, utcOffsetMinutes,
  }),
  subscribeCloseRequested: (listener) => listen("capture-close-requested", listener),
  setExpanded: (expanded) => invoke("capture_set_expanded", { expanded }),
  drag: () => invoke("capture_drag"),
  exit: () => invoke("capture_exit"),
};
