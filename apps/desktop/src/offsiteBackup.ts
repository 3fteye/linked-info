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
  retentionEnabled: boolean;
  retentionMaxSnapshots: number;
  retentionMaxAgeDays: number;
  lastRetentionCleanupAtMs: number | null;
  lastRetentionError: string | null;
}

export type S3ProviderTemplate =
  | "cloudflareR2"
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

export type TemporaryBackupConnection = S3BackupConnection;

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

export interface DeleteAllOffsiteBackupsOutcome {
  deletedCount: number;
  targetRemoved: boolean;
  error: string | null;
}

export interface LegacyBackupMigrationOutcome {
  copiedCount: number;
  deletedCount: number;
  destination: OffsiteBackupTarget;
}

export interface OffsiteBackupService {
  readonly available: boolean;
  inspectTargets(): Promise<OffsiteBackupTarget[]>;
  configureS3Target(input: Omit<S3BackupConnection, "provider"> & {
    name: string;
    s3Provider: S3ProviderTemplate;
    authorization: string;
  }): Promise<OffsiteBackupTarget>;
  removeTarget(targetId: string, authorization: string): Promise<void>;
  deleteSnapshot(
    targetId: string,
    snapshotId: string,
    authorization: string,
  ): Promise<void>;
  deleteAllAndRemoveTarget(
    targetId: string,
    confirmationName: string,
    authorization: string,
  ): Promise<DeleteAllOffsiteBackupsOutcome>;
  migrateLegacyTarget(
    sourceTargetId: string,
    destinationTargetId: string,
    confirmationName: string,
    authorization: string,
  ): Promise<LegacyBackupMigrationOutcome>;
  updateAutomaticSettings(
    targetId: string,
    enabled: boolean,
    intervalHours: number,
  ): Promise<OffsiteBackupTarget>;
  updateRetentionSettings(
    targetId: string,
    enabled: boolean,
    maxSnapshots: number,
    maxAgeDays: number,
    authorization: string,
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
  configureS3Target(input) {
    return invoke<OffsiteBackupTarget>("configure_s3_backup_target", input);
  },
  removeTarget(targetId, authorization) {
    return invoke<void>("remove_offsite_backup_target", {
      targetId,
      authorization,
    });
  },
  deleteSnapshot(targetId, snapshotId, authorization) {
    return invoke<void>("delete_offsite_backup", {
      targetId,
      snapshotId,
      authorization,
    });
  },
  deleteAllAndRemoveTarget(targetId, confirmationName, authorization) {
    return invoke<DeleteAllOffsiteBackupsOutcome>(
      "delete_all_offsite_backups_and_remove_target",
      { targetId, confirmationName, authorization },
    );
  },
  migrateLegacyTarget(
    sourceTargetId,
    destinationTargetId,
    confirmationName,
    authorization,
  ) {
    return invoke<LegacyBackupMigrationOutcome>("migrate_legacy_offsite_backup_target", {
      sourceTargetId,
      destinationTargetId,
      confirmationName,
      authorization,
    });
  },
  updateAutomaticSettings(targetId, enabled, intervalHours) {
    return invoke<OffsiteBackupTarget>(
      "update_offsite_backup_automatic_settings",
      { targetId, enabled, intervalHours },
    );
  },
  updateRetentionSettings(
    targetId,
    enabled,
    maxSnapshots,
    maxAgeDays,
    authorization,
  ) {
    return invoke<OffsiteBackupTarget>(
      "update_offsite_backup_retention_settings",
      { targetId, enabled, maxSnapshots, maxAgeDays, authorization },
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
  async configureS3Target() {
    return unavailable();
  },
  async removeTarget() {
    return unavailable();
  },
  async deleteSnapshot() {
    return unavailable();
  },
  async deleteAllAndRemoveTarget() {
    return unavailable();
  },
  async migrateLegacyTarget() {
    return unavailable();
  },
  async updateAutomaticSettings() {
    return unavailable();
  },
  async updateRetentionSettings() {
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
