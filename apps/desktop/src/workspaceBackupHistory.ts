import { invoke } from "@tauri-apps/api/core";

export type WorkspaceBackupState = "ready" | "invalid";

export interface WorkspaceBackupEntry {
  id: string;
  createdAtMs: number;
  sizeBytes: number;
  state: WorkspaceBackupState;
}

export interface WorkspaceBackupHistoryStatus {
  entries: WorkspaceBackupEntry[];
  totalBytes: number;
  maximumCount: number;
  maximumBytes: number;
  intervalMs: number;
}

export interface WorkspaceBackupCaptureResult {
  created: boolean;
  status: WorkspaceBackupHistoryStatus;
}

export interface WorkspaceBackupHistory {
  available: boolean;
  inspect(): Promise<WorkspaceBackupHistoryStatus>;
  captureIfDue(): Promise<WorkspaceBackupCaptureResult>;
  read(id: string): Promise<string>;
}

export const tauriWorkspaceBackupHistory: WorkspaceBackupHistory = {
  available: true,
  inspect() {
    return invoke<WorkspaceBackupHistoryStatus>("inspect_workspace_backup_history");
  },
  captureIfDue() {
    return invoke<WorkspaceBackupCaptureResult>("capture_workspace_backup");
  },
  read(id) {
    return invoke<string>("read_workspace_backup", { id });
  },
};

const unavailableStatus: WorkspaceBackupHistoryStatus = {
  entries: [],
  totalBytes: 0,
  maximumCount: 0,
  maximumBytes: 0,
  intervalMs: 0,
};

export const unavailableWorkspaceBackupHistory: WorkspaceBackupHistory = {
  available: false,
  async inspect() {
    return unavailableStatus;
  },
  async captureIfDue() {
    return { created: false, status: unavailableStatus };
  },
  async read() {
    throw new Error("workspace_backup_history_unavailable");
  },
};
