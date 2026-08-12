import { invoke } from "@tauri-apps/api/core";

export interface OffsiteBackupTarget {
  id: string;
  name: string;
  provider: "cloudflareWorkerR2" | "s3Compatible";
  endpoint: string;
  s3Provider: S3ProviderTemplate | null;
  region: string | null;
  bucket: string | null;
  prefix: string | null;
  createdAtMs: number;
  lastUploadAtMs: number | null;
  lastVerifiedAtMs: number | null;
  lastRestoreTestAtMs: number | null;
  maximumUploadBytes: number | null;
  automaticEnabled: boolean;
  automaticIntervalHours: number;
  automaticPending: boolean;
  lastAutomaticAttemptAtMs: number | null;
  lastAutomaticError: string | null;
}

export type S3ProviderTemplate =
  | "backblazeB2"
  | "tigris"
  | "oracleOci"
  | "custom";

export interface S3BackupConnection {
  provider: "s3Compatible";
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
}

export interface CloudflareBackupConnection {
  provider: "cloudflareWorkerR2";
  endpoint: string;
  token: string;
}

export type TemporaryBackupConnection =
  | CloudflareBackupConnection
  | S3BackupConnection;

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

export interface AutomaticBackupOutcome {
  targetId: string;
  uploaded: boolean;
  error: string | null;
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
  configureS3Target(input: Omit<S3BackupConnection, "provider"> & {
    name: string;
    s3Provider: S3ProviderTemplate;
    authorization: string;
  }): Promise<OffsiteBackupTarget>;
  removeTarget(targetId: string, authorization: string): Promise<void>;
  updateAutomaticSettings(
    targetId: string,
    enabled: boolean,
    intervalHours: number,
  ): Promise<OffsiteBackupTarget>;
  markAutomaticPending(): Promise<OffsiteBackupTarget[]>;
  runDueAutomatic(contents: string): Promise<AutomaticBackupOutcome[]>;
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
  testRestore(
    targetId: string,
    snapshotId: string,
    password: string,
  ): Promise<OffsiteBackupTarget>;
  listRecovery(input: TemporaryBackupConnection & {
    cursor?: string | null;
    limit?: number;
  }): Promise<OffsiteBackupPage>;
  downloadRecovery(input: TemporaryBackupConnection & {
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
  configureS3Target(input) {
    return invoke<OffsiteBackupTarget>("configure_s3_backup_target", input);
  },
  removeTarget(targetId, authorization) {
    return invoke<void>("remove_offsite_backup_target", {
      targetId,
      authorization,
    });
  },
  updateAutomaticSettings(targetId, enabled, intervalHours) {
    return invoke<OffsiteBackupTarget>(
      "update_offsite_backup_automatic_settings",
      { targetId, enabled, intervalHours },
    );
  },
  markAutomaticPending() {
    return invoke<OffsiteBackupTarget[]>(
      "mark_automatic_offsite_backup_pending",
    );
  },
  runDueAutomatic(contents) {
    return invoke<AutomaticBackupOutcome[]>(
      "run_due_automatic_offsite_backups",
      { contents },
    );
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
  testRestore(targetId, snapshotId, password) {
    return invoke<OffsiteBackupTarget>("test_offsite_backup_restore", {
      targetId,
      snapshotId,
      password,
    });
  },
  listRecovery(input) {
    const { cursor = null, limit = 50 } = input;
    if (input.provider === "cloudflareWorkerR2") {
      return invoke<OffsiteBackupPage>("list_cloudflare_recovery_backups", {
        endpoint: input.endpoint,
        token: input.token,
        cursor,
        limit,
      });
    }
    return invoke<OffsiteBackupPage>("list_s3_recovery_backups", {
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      prefix: input.prefix,
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      sessionToken: input.sessionToken ?? null,
      cursor,
      limit,
    });
  },
  downloadRecovery(input) {
    if (input.provider === "cloudflareWorkerR2") {
      return invoke<DownloadedOffsiteBackup>(
        "download_cloudflare_recovery_backup",
        {
          endpoint: input.endpoint,
          token: input.token,
          snapshotId: input.snapshotId,
        },
      );
    }
    return invoke<DownloadedOffsiteBackup>("download_s3_recovery_backup", {
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      prefix: input.prefix,
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      sessionToken: input.sessionToken ?? null,
      snapshotId: input.snapshotId,
    });
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
  async configureS3Target() {
    return unavailable();
  },
  async removeTarget() {
    return unavailable();
  },
  async updateAutomaticSettings() {
    return unavailable();
  },
  async markAutomaticPending() {
    return unavailable();
  },
  async runDueAutomatic() {
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
  async testRestore() {
    return unavailable();
  },
  async listRecovery() {
    return unavailable();
  },
  async downloadRecovery() {
    return unavailable();
  },
};
