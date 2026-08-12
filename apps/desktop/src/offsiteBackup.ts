import { invoke } from "@tauri-apps/api/core";

export interface OffsiteBackupTarget {
  id: string;
  name: string;
  provider: "cloudflareWorkerR2";
  endpoint: string;
  createdAtMs: number;
  lastUploadAtMs: number | null;
  lastVerifiedAtMs: number | null;
  lastRestoreTestAtMs: number | null;
  maximumUploadBytes: number | null;
}

export interface OffsiteBackupSnapshot {
  id: string;
  createdAtMs: number;
  sizeBytes: number;
  sha256: string;
}

export interface OffsiteBackupPage {
  items: OffsiteBackupSnapshot[];
  nextCursor: string | null;
}

export interface DownloadedOffsiteBackup {
  metadata: OffsiteBackupSnapshot;
  encryptedExport: string;
}

export interface OffsiteBackupVerification {
  metadata: OffsiteBackupSnapshot;
  downloadedBytes: number;
}

export interface OffsiteBackupService {
  readonly available: boolean;
  inspectTargets(): Promise<OffsiteBackupTarget[]>;
  configureCloudflareTarget(input: {
    name: string;
    endpoint: string;
    token: string;
    authorization: string;
  }): Promise<OffsiteBackupTarget>;
  removeTarget(targetId: string, authorization: string): Promise<void>;
  create(targetId: string, contents: string): Promise<OffsiteBackupSnapshot>;
  list(
    targetId: string,
    cursor?: string | null,
    limit?: number,
  ): Promise<OffsiteBackupPage>;
  download(
    targetId: string,
    snapshotId: string,
  ): Promise<DownloadedOffsiteBackup>;
  verify(
    targetId: string,
    snapshotId: string,
  ): Promise<OffsiteBackupVerification>;
  listRecovery(input: {
    endpoint: string;
    token: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<OffsiteBackupPage>;
  downloadRecovery(input: {
    endpoint: string;
    token: string;
    snapshotId: string;
  }): Promise<DownloadedOffsiteBackup>;
}

export const tauriOffsiteBackupService: OffsiteBackupService = {
  available: true,
  inspectTargets() {
    return invoke<OffsiteBackupTarget[]>("inspect_offsite_backup_targets");
  },
  configureCloudflareTarget(input) {
    return invoke<OffsiteBackupTarget>("configure_cloudflare_backup_target", input);
  },
  removeTarget(targetId, authorization) {
    return invoke<void>("remove_offsite_backup_target", {
      targetId,
      authorization,
    });
  },
  create(targetId, contents) {
    return invoke<OffsiteBackupSnapshot>("create_offsite_backup", {
      targetId,
      contents,
    });
  },
  list(targetId, cursor = null, limit = 50) {
    return invoke<OffsiteBackupPage>("list_offsite_backups", {
      targetId,
      cursor,
      limit,
    });
  },
  download(targetId, snapshotId) {
    return invoke<DownloadedOffsiteBackup>("download_offsite_backup", {
      targetId,
      snapshotId,
    });
  },
  verify(targetId, snapshotId) {
    return invoke<OffsiteBackupVerification>("verify_offsite_backup", {
      targetId,
      snapshotId,
    });
  },
  listRecovery({ endpoint, token, cursor = null, limit = 50 }) {
    return invoke<OffsiteBackupPage>("list_cloudflare_recovery_backups", {
      endpoint,
      token,
      cursor,
      limit,
    });
  },
  downloadRecovery({ endpoint, token, snapshotId }) {
    return invoke<DownloadedOffsiteBackup>(
      "download_cloudflare_recovery_backup",
      { endpoint, token, snapshotId },
    );
  },
};

function unavailable(): never {
  throw new Error("offsite backups are unavailable outside the desktop app");
}

export const unavailableOffsiteBackupService: OffsiteBackupService = {
  available: false,
  async inspectTargets() {
    return [];
  },
  async configureCloudflareTarget() {
    return unavailable();
  },
  async removeTarget() {
    return unavailable();
  },
  async create() {
    return unavailable();
  },
  async list() {
    return unavailable();
  },
  async download() {
    return unavailable();
  },
  async verify() {
    return unavailable();
  },
  async listRecovery() {
    return unavailable();
  },
  async downloadRecovery() {
    return unavailable();
  },
};
