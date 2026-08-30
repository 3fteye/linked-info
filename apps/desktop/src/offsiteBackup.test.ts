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
    const outcome = { target: updated, error: null };
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
      target: { id: "target-1", name: "Cloudflare R2" },
      error: "offsite_backup_config_transaction_cleanup_pending",
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
      target: { id: "target-1" },
      error: null,
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
      target: { id: "target-1" },
      error: null,
    });

    expect(invokeMock).toHaveBeenCalledWith("update_s3_backup_target", input);
  });

  it("returns a committed target-removal warning without rejecting", async () => {
    const outcome = {
      targetRemoved: true,
      error: "offsite_backup_credential_cleanup_pending",
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
      targetRemoved: true,
      error: "offsite_backup_config_transaction_cleanup_pending",
    };
    invokeMock.mockResolvedValue(outcome);

    await expect(
      tauriOffsiteBackupService.removeTarget(
        "target-1",
        "one-time-authorization",
      ),
    ).resolves.toEqual(outcome);
  });
});
