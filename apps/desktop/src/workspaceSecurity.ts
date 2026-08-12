import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface WorkspaceSecurityStatus {
  encrypted: boolean;
  locked: boolean;
  systemUnlockAvailable: boolean;
  systemUnlockEnabled: boolean;
  idleTimeoutMinutes: number | null;
}

export type SensitiveOperation =
  | "backupTargetChange"
  | "changePassword"
  | "clearRecoveryData"
  | "destroyWorkspace"
  | "exportWorkspace"
  | "rotateDataKey"
  | "systemUnlockChange";

export type SensitiveAuthentication =
  | { method: "password"; password: string }
  | { method: "system"; message: string };

export interface WorkspaceSecurity {
  readonly available: boolean;
  inspect(): Promise<WorkspaceSecurityStatus>;
  unlock(password: string): Promise<WorkspaceSecurityStatus>;
  unlockWithSystem(message: string): Promise<WorkspaceSecurityStatus>;
  enable(password: string): Promise<WorkspaceSecurityStatus>;
  enableSystemUnlock(message: string): Promise<WorkspaceSecurityStatus>;
  disableSystemUnlock(authorization: string): Promise<WorkspaceSecurityStatus>;
  authorizeSensitiveOperation(
    operation: SensitiveOperation,
    authentication: SensitiveAuthentication,
  ): Promise<string>;
  changePassword(password: string, authorization: string): Promise<void>;
  rotateDataKey(password: string, authorization: string): Promise<void>;
  clearRecoveryData(authorization: string): Promise<void>;
  destroyWorkspace(authorization: string): Promise<void>;
  lock(): Promise<WorkspaceSecurityStatus>;
  setIdleTimeout(minutes: number | null): Promise<WorkspaceSecurityStatus>;
  recordActivity(): Promise<void>;
  subscribeLocked(listener: (reason: string) => void): Promise<() => void>;
  encryptExport(contents: string, authorization: string): Promise<string>;
  decryptExport(contents: string, password: string): Promise<string>;
}

const plaintextStatus: WorkspaceSecurityStatus = {
  encrypted: false,
  locked: false,
  systemUnlockAvailable: false,
  systemUnlockEnabled: false,
  idleTimeoutMinutes: null,
};

export const tauriWorkspaceSecurity: WorkspaceSecurity = {
  available: true,
  inspect() {
    return invoke<WorkspaceSecurityStatus>("inspect_workspace_security");
  },
  unlock(password) {
    return invoke<WorkspaceSecurityStatus>("unlock_workspace", { password });
  },
  unlockWithSystem(message) {
    return invoke<WorkspaceSecurityStatus>("unlock_workspace_with_system", {
      message,
    });
  },
  enable(password) {
    return invoke<WorkspaceSecurityStatus>("enable_workspace_encryption", {
      password,
    });
  },
  enableSystemUnlock(message) {
    return invoke<WorkspaceSecurityStatus>("enable_system_unlock", { message });
  },
  disableSystemUnlock(authorization) {
    return invoke<WorkspaceSecurityStatus>("disable_system_unlock", {
      authorization,
    });
  },
  authorizeSensitiveOperation(operation, authentication) {
    return invoke<string>("authorize_sensitive_operation", {
      operation,
      authentication,
    });
  },
  changePassword(password, authorization) {
    return invoke<void>("change_workspace_password", {
      password,
      authorization,
    });
  },
  rotateDataKey(password, authorization) {
    return invoke<void>("rotate_workspace_data_key", {
      password,
      authorization,
    });
  },
  clearRecoveryData(authorization) {
    return invoke<void>("clear_workspace_recovery_data", { authorization });
  },
  destroyWorkspace(authorization) {
    return invoke<void>("destroy_workspace", { authorization });
  },
  lock() {
    return invoke<WorkspaceSecurityStatus>("lock_workspace");
  },
  setIdleTimeout(minutes) {
    return invoke<WorkspaceSecurityStatus>("set_workspace_idle_timeout", {
      minutes,
    });
  },
  recordActivity() {
    return invoke<void>("record_workspace_activity");
  },
  subscribeLocked(listener) {
    return listen<string>("workspace-security-locked", (event) => {
      listener(event.payload);
    });
  },
  encryptExport(contents, authorization) {
    return invoke<string>("encrypt_workspace_export", {
      contents,
      authorization,
    });
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
  async unlockWithSystem() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async enable() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async enableSystemUnlock() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async disableSystemUnlock() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async authorizeSensitiveOperation() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async changePassword() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async rotateDataKey() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async clearRecoveryData() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async destroyWorkspace() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async lock() {
    throw new Error("workspace encryption is unavailable outside the desktop app");
  },
  async setIdleTimeout() {
    return plaintextStatus;
  },
  async recordActivity() {},
  async subscribeLocked() {
    return () => {};
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
