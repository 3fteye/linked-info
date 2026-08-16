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
    invokeMock.mockResolvedValue(updated);
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
      updated,
    );
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("update_s3_backup_target", input);
  });

  it("can update non-secret settings while retaining stored credentials", async () => {
    invokeMock.mockResolvedValue({ id: "target-1" });
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

    await tauriOffsiteBackupService.updateS3Target(input);

    expect(invokeMock).toHaveBeenCalledWith("update_s3_backup_target", input);
  });
});
