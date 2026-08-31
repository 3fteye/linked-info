import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { tauriOffsiteBackupService } from "./offsiteBackup";

describe("tauriOffsiteBackupService", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("updates an existing target without changing its identity", async () => {
    const updated = { id: "target-1", name: "Backblaze B2" };
    const outcome = { status: "committed", target: updated, warning: null };
    invokeMock.mockResolvedValue(outcome);
    const input = {
      targetId: "target-1",
      name: "Backblaze B2",
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      s3Provider: "backblazeB2" as const,
      region: "us-west-004",
      bucket: "linked-info-backup",
      prefix: "linked-info/v1",
      replaceCredentials: true,
      accessKeyId: "replacement-key-id",
      secretAccessKey: "replacement-secret-key",
      sessionToken: null,
      authorization: "one-time-authorization",
    };

    await expect(tauriOffsiteBackupService.updateS3Target(input)).resolves.toBe(
      outcome,
    );
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("update_s3_backup_target", input);
  });

  it("returns a committed target-creation warning without rejecting", async () => {
    const outcome = {
      status: "committed",
      target: { id: "target-1", name: "Cloudflare R2" },
      warning: "offsite_backup_config_transaction_cleanup_pending",
    };
    invokeMock.mockResolvedValue(outcome);
    const input = {
      name: "Cloudflare R2",
      endpoint: "https://example.r2.cloudflarestorage.com",
      s3Provider: "cloudflareR2" as const,
      region: "auto",
      bucket: "linked-info-backup",
      prefix: "linked-info/v1",
      accessKeyId: "access-key-id",
      secretAccessKey: "secret-access-key",
      sessionToken: null,
      authorization: "one-time-authorization",
    };

    await expect(
      tauriOffsiteBackupService.configureS3Target(input),
    ).resolves.toBe(outcome);
    expect(invokeMock).toHaveBeenCalledWith(
      "configure_s3_backup_target",
      input,
    );
  });

  it("can update non-secret settings while retaining stored credentials", async () => {
    invokeMock.mockResolvedValue({
      status: "committed",
      target: { id: "target-1" },
      warning: null,
    });
    const input = {
      targetId: "target-1",
      name: "Renamed target",
      endpoint: "https://example.invalid",
      s3Provider: "custom" as const,
      region: "auto",
      bucket: "linked-info-backup",
      prefix: "linked-info/v2",
      replaceCredentials: false,
      accessKeyId: "",
      secretAccessKey: "",
      sessionToken: null,
      authorization: "one-time-authorization",
    };

    await expect(
      tauriOffsiteBackupService.updateS3Target(input),
    ).resolves.toEqual({
      status: "committed",
      target: { id: "target-1" },
      warning: null,
    });

    expect(invokeMock).toHaveBeenCalledWith("update_s3_backup_target", input);
  });

  it("returns a committed target-removal warning without rejecting", async () => {
    const outcome = {
      status: "committed",
      targetRemoved: true,
      warning: "offsite_backup_credential_cleanup_pending",
    };
    invokeMock.mockResolvedValue(outcome);

    await expect(
      tauriOffsiteBackupService.removeTarget(
        "target-1",
        "one-time-authorization",
      ),
    ).resolves.toEqual(outcome);
    expect(invokeMock).toHaveBeenCalledWith("remove_offsite_backup_target", {
      targetId: "target-1",
      authorization: "one-time-authorization",
    });
  });

  it("returns a committed transaction-cleanup warning without rejecting", async () => {
    const outcome = {
      status: "committed",
      targetRemoved: true,
      warning: "offsite_backup_config_transaction_cleanup_pending",
    };
    invokeMock.mockResolvedValue(outcome);

    await expect(
      tauriOffsiteBackupService.removeTarget(
        "target-1",
        "one-time-authorization",
      ),
    ).resolves.toEqual(outcome);
  });

  it("preserves a target mutation that requires disk recovery", async () => {
    const outcome = { status: "recoveryRequired" as const };
    invokeMock.mockResolvedValue(outcome);

    await expect(
      tauriOffsiteBackupService.removeTarget(
        "target-1",
        "one-time-authorization",
      ),
    ).resolves.toBe(outcome);
  });

  it("preserves the remote deletion count while local removal needs recovery", async () => {
    const outcome = {
      status: "recoveryRequired" as const,
      deletedVersionCount: 7,
    };
    invokeMock.mockResolvedValue(outcome);

    await expect(
      tauriOffsiteBackupService.deleteAllAndRemoveTarget(
        "target-1",
        "Backblaze B2",
        "one-time-authorization",
      ),
    ).resolves.toBe(outcome);
  });

  it("returns committed snapshot deletion with a local proof warning", async () => {
    const outcome = {
      status: "committed" as const,
      snapshotDeleted: true as const,
      restoreDrillProofInvalidated: false,
      warning: "offsite_backup_snapshot_deleted_proof_update_failed" as const,
    };
    invokeMock.mockResolvedValue(outcome);

    await expect(
      tauriOffsiteBackupService.deleteSnapshot(
        "target-1",
        "snapshot-1",
        "one-time-authorization",
      ),
    ).resolves.toBe(outcome);
    expect(invokeMock).toHaveBeenCalledWith("delete_offsite_backup", {
      targetId: "target-1",
      snapshotId: "snapshot-1",
      authorization: "one-time-authorization",
    });
  });
});
