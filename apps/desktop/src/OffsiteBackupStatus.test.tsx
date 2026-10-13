// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "./i18n";
import OffsiteBackupStatus, { type BackupStatusRecord } from "./OffsiteBackupStatus";

const empty: BackupStatusRecord = {
  lastUploadAtMs: null,
  automaticPending: false,
  automaticEnabled: true,
  lastVerifiedAtMs: null,
  lastRestoreTestAtMs: null,
  retentionEnabled: false,
  lastRetentionCleanupAtMs: null,
  lastRetentionError: null,
};

function render(changes: Partial<BackupStatusRecord> = {}) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <OffsiteBackupStatus target={{ ...empty, ...changes }} formatDate={(time) => `time-${time}`} />,
  );
  return container;
}

describe("OffsiteBackupStatus", () => {
  beforeEach(async () => { await i18n.changeLanguage("en-US"); });

  it("does not label an unused target as backed up when pending is false", () => {
    expect(render().textContent).toContain("No successful upload recorded");
    expect(render().textContent).toContain("No successful recovery drill recorded");
  });

  it("shows pending changes independently of automatic scheduling", () => {
    expect(render({ lastUploadAtMs: 10, automaticPending: true }).textContent)
      .toContain("Local changes are waiting for upload");
  });

  it("qualifies current status as a local record, not a new remote verification", () => {
    expect(render({ lastUploadAtMs: 10 }).textContent)
      .toContain("No pending changes according to local records");
  });

  it("does not report a manually uploaded target as current while tracking is disabled", () => {
    const text = render({ lastUploadAtMs: 10, automaticEnabled: false }).textContent;
    expect(text).toContain("Automatic backup is off; later changes are not continuously tracked");
    expect(text).not.toContain("No pending changes");
    expect(text).toContain("Last successful upload: time-10");
  });

  it("retains known pending changes even after automatic backup is disabled", () => {
    expect(render({ lastUploadAtMs: 10, automaticEnabled: false, automaticPending: true }).textContent)
      .toContain("Local changes are waiting for upload");
  });

  it("does not mistake hash verification for a recovery drill", () => {
    const text = render({ lastUploadAtMs: 10, lastVerifiedAtMs: 20 }).textContent;
    expect(text).toContain("Last full verification: time-20");
    expect(text).toContain("No successful recovery drill recorded");
  });

  it.each([5, 30])("does not infer snapshot identity from drill time %s", (time) => {
    const text = render({ lastUploadAtMs: 10, lastRestoreTestAtMs: time }).textContent;
    expect(text).toContain("A snapshot has passed a recovery drill");
    expect(text).toContain("not necessarily the latest snapshot or all current edits");
    expect(text).toContain(`Last recovery drill: time-${time}`);
  });

  it("keeps a cleanup failure distinct after upload and recovery succeed", () => {
    const text = render({
      lastUploadAtMs: 10, lastRestoreTestAtMs: 20,
      retentionEnabled: true, lastRetentionCleanupAtMs: 5,
      lastRetentionError: "synthetic-private-diagnostic",
    }).textContent;
    expect(text).toContain("Last cleanup failed; this is not an upload failure");
    expect(text).not.toContain("synthetic-private-diagnostic");
  });

  it("distinguishes disabled cleanup from enabled but untested cleanup", () => {
    expect(render().textContent).toContain("Automatic cleanup is disabled");
    expect(render({ retentionEnabled: true }).textContent)
      .toContain("Enabled, with no successful cleanup recorded");
    expect(render({ retentionEnabled: true, lastRetentionCleanupAtMs: 30 }).textContent)
      .toContain("Last successful cleanup: time-30");
  });

  it("renders all three sections in Chinese without untranslated keys", async () => {
    await i18n.changeLanguage("zh-CN");
    const container = render();
    expect(container.querySelectorAll("section")).toHaveLength(3);
    expect(container.textContent).toContain("上传状态");
    expect(container.textContent).toContain("恢复验证");
    expect(container.textContent).toContain("旧快照清理");
    expect(container.textContent).not.toContain("offsiteBackup.");
  });
});
