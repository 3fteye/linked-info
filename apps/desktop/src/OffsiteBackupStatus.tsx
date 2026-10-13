import { useTranslation } from "react-i18next";
import type { OffsiteBackupTarget } from "./offsiteBackup";

export type BackupStatusRecord = Pick<
  OffsiteBackupTarget,
  | "lastUploadAtMs"
  | "automaticPending"
  | "automaticEnabled"
  | "lastVerifiedAtMs"
  | "lastRestoreTestAtMs"
  | "retentionEnabled"
  | "lastRetentionCleanupAtMs"
  | "lastRetentionError"
>;

export default function OffsiteBackupStatus({
  target,
  formatDate,
}: {
  target: BackupStatusRecord;
  formatDate: (timestamp: number) => string;
}) {
  const { t } = useTranslation();
  const date = (value: number | null) =>
    value === null ? t("offsiteBackup.never") : formatDate(value);
  const upload = target.lastUploadAtMs === null
    ? "notUploaded"
    : target.automaticPending
      ? "pending"
      : !target.automaticEnabled ? "untracked" : "recorded";
  const cleanup = !target.retentionEnabled
    ? "disabled"
    : target.lastRetentionError !== null
      ? "failed"
      : target.lastRetentionCleanupAtMs === null ? "notRun" : "recorded";

  return (
    <div className="offsite-status-grid">
      <section aria-label={t("offsiteBackup.health.uploadTitle")}>
        <strong>{t("offsiteBackup.health.uploadTitle")}</strong>
        <p>{t(`offsiteBackup.health.upload.${upload}`)}</p>
        <small>{t("offsiteBackup.health.uploadTime", { time: date(target.lastUploadAtMs) })}</small>
      </section>
      <section aria-label={t("offsiteBackup.health.restoreTitle")}>
        <strong>{t("offsiteBackup.health.restoreTitle")}</strong>
        <p>{t(target.lastRestoreTestAtMs === null
          ? "offsiteBackup.health.restoreMissing"
          : "offsiteBackup.health.restoreRecorded")}</p>
        <small>{t("offsiteBackup.health.verifyTime", { time: date(target.lastVerifiedAtMs) })}</small>
        <small>{t("offsiteBackup.health.restoreTime", { time: date(target.lastRestoreTestAtMs) })}</small>
        <small>{t("offsiteBackup.health.restoreScope")}</small>
      </section>
      <section aria-label={t("offsiteBackup.health.cleanupTitle")}>
        <strong>{t("offsiteBackup.health.cleanupTitle")}</strong>
        <p>{t(`offsiteBackup.health.cleanup.${cleanup}`)}</p>
        <small>{t("offsiteBackup.health.cleanupTime", { time: date(target.lastRetentionCleanupAtMs) })}</small>
      </section>
    </div>
  );
}
