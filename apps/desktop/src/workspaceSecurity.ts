import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceSecurityStatus {
  encrypted: boolean;
  locked: boolean;
}

export interface WorkspaceSecurity {
  readonly available: boolean;
  inspect(): Promise<WorkspaceSecurityStatus>;
  unlock(password: string): Promise<WorkspaceSecurityStatus>;
  enable(password: string): Promise<WorkspaceSecurityStatus>;
  changePassword(password: string): Promise<void>;
  lock(): Promise<WorkspaceSecurityStatus>;
  encryptExport(contents: string): Promise<string>;
  decryptExport(contents: string, password: string): Promise<string>;
}

const plaintextStatus: WorkspaceSecurityStatus = {
  encrypted: false,
  locked: false,
};

export const tauriWorkspaceSecurity: WorkspaceSecurity = {
  available: true,
  inspect() {
    return invoke<WorkspaceSecurityStatus>("inspect_workspace_security");
  },
  unlock(password) {
    return invoke<WorkspaceSecurityStatus>("unlock_workspace", { password });
  },
  enable(password) {
    return invoke<WorkspaceSecurityStatus>("enable_workspace_encryption", {
      password,
    });
  },
  changePassword(password) {
    return invoke<void>("change_workspace_password", { password });
  },
  lock() {
    return invoke<WorkspaceSecurityStatus>("lock_workspace");
  },
  encryptExport(contents) {
    return invoke<string>("encrypt_workspace_export", { contents });
  },
  decryptExport(contents, password) {
    return invoke<string>("decrypt_workspace_export", {
      contents,
      password,
    });
  },
};

export const unavailableWorkspaceSecurity: WorkspaceSecurity = {
  available: false,
  async inspect() {
    return plaintextStatus;
  },
  async unlock() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async enable() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async changePassword() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async lock() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async encryptExport() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async decryptExport() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
};

export function isEncryptedWorkspaceExport(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return (
      typeof value === "object" &&
      value !== null &&
      "format" in value &&
      value.format === "linked-info-encrypted-workspace-export" &&
      "version" in value &&
      value.version === 1
    );
  } catch {
    return false;
  }
}
