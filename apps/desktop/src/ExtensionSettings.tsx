import { AlertTriangle, PackagePlus, Puzzle, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExtensionCapability } from "./builtinExtensionHost";
import {
  chooseExtensionInstall,
  commitExtensionInstall,
  inspectInstalledExtensions,
  setExtensionEnabled,
  uninstallExtension,
  extensionManagerAvailable,
  type ExtensionInstallPreview,
  type InstalledExtension,
} from "./extensionManager";

const capabilityKeys: Record<ExtensionCapability, string> = {
  "node.read.name": "extensions.manager.capabilities.nodeReadName",
  "node.read.content": "extensions.manager.capabilities.nodeReadContent",
  "graph.read.direct": "extensions.manager.capabilities.graphReadDirect",
  "metadata.node.read": "extensions.manager.capabilities.metadataNodeRead",
  "metadata.node.write": "extensions.manager.capabilities.metadataNodeWrite",
  "metadata.workspace.read": "extensions.manager.capabilities.metadataWorkspaceRead",
  "metadata.workspace.write": "extensions.manager.capabilities.metadataWorkspaceWrite",
  "workspace.propose": "extensions.manager.capabilities.workspacePropose",
  "clock.monotonic": "extensions.manager.capabilities.clockMonotonic",
};

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ExtensionSettings() {
  const { t } = useTranslation();
  const [installed, setInstalled] = useState<InstalledExtension[]>([]);
  const [preview, setPreview] = useState<ExtensionInstallPreview | null>(null);
  const [approved, setApproved] = useState<Set<ExtensionCapability>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null);

  useEffect(() => {
    if (!extensionManagerAvailable) return;
    let active = true;
    void inspectInstalledExtensions()
      .then((items) => active && setInstalled(items))
      .catch((reason) => active && setError(errorReason(reason)));
    return () => {
      active = false;
    };
  }, []);

  const allApproved = useMemo(
    () =>
      preview !== null &&
      preview.capabilities.every((capability) => approved.has(capability)),
    [approved, preview],
  );

  async function choose(allowUnsignedDevelopment: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const selected = await chooseExtensionInstall(allowUnsignedDevelopment);
      setPreview(selected);
      setApproved(new Set());
    } catch (reason) {
      setError(errorReason(reason));
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    if (preview === null || !allApproved || preview.metadataMigrationRequired) return;
    setBusy(true);
    setError(null);
    try {
      setInstalled(await commitExtensionInstall(preview, true));
      setPreview(null);
      setApproved(new Set());
    } catch (reason) {
      setError(errorReason(reason));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: InstalledExtension) {
    setBusy(true);
    setError(null);
    try {
      setInstalled(await setExtensionEnabled(item.id, !item.enabled));
    } catch (reason) {
      setError(errorReason(reason));
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: InstalledExtension) {
    if (confirmUninstallId !== item.id) {
      setConfirmUninstallId(item.id);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setInstalled(await uninstallExtension(item.id));
      setConfirmUninstallId(null);
    } catch (reason) {
      setError(errorReason(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="extension-manager">
      <header className="settings-group-heading">
        <h2>{t("extensions.manager.title")}</h2>
        <p>{t("extensions.manager.description")}</p>
      </header>
      <div className="extension-manager-actions">
        <button className="secondary-button" disabled={busy || !extensionManagerAvailable} onClick={() => void choose(false)} type="button">
          <PackagePlus aria-hidden="true" size={15} />
          {t("extensions.manager.installSigned")}
        </button>
        <button className="secondary-button" disabled={busy || !extensionManagerAvailable} onClick={() => void choose(true)} type="button">
          <AlertTriangle aria-hidden="true" size={15} />
          {t("extensions.manager.installDevelopment")}
        </button>
      </div>
      <p className="extension-manager-boundary">{t("extensions.manager.boundary")}</p>
      {!extensionManagerAvailable && <p className="extension-manager-empty">{t("extensions.manager.desktopOnly")}</p>}
      {error !== null && <p className="extension-manager-error" role="alert">{t("extensions.manager.error", { reason: error })}</p>}
      {extensionManagerAvailable && (installed.length === 0 ? (
        <p className="extension-manager-empty">{t("extensions.manager.empty")}</p>
      ) : (
        <div className="extension-manager-list">
          {installed.map((item) => (
            <article data-valid={item.valid} key={item.id}>
              <div>
                <strong>{item.id}</strong>
                <span>{t("extensions.manager.versionPublisher", { version: item.version, publisher: item.publisherName })}</span>
                {!item.valid && <small>{t("extensions.manager.invalid", { reason: item.errorCode })}</small>}
              </div>
              <div className="extension-manager-item-actions">
                <label className="switch-setting">
                  <input checked={item.enabled && item.valid} disabled={busy || !item.valid} onChange={() => void toggle(item)} type="checkbox" />
                  <span>{item.enabled ? t("extensions.manager.enabled") : t("extensions.manager.disabled")}</span>
                </label>
                <button className="danger-button" disabled={busy} onClick={() => void remove(item)} type="button">
                  <Trash2 aria-hidden="true" size={14} />
                  {confirmUninstallId === item.id ? t("extensions.manager.confirmUninstall") : t("extensions.manager.uninstall")}
                </button>
              </div>
            </article>
          ))}
        </div>
      ))}
      {preview !== null && (
        <div className="modal-backdrop" role="presentation">
          <section aria-modal="true" className="confirmation-dialog extension-install-dialog" role="dialog">
            <Puzzle aria-hidden="true" size={22} />
            <h2>{preview.update ? t("extensions.manager.updateTitle") : t("extensions.manager.installTitle")}</h2>
            <p>{t("extensions.manager.packageIdentity", { id: preview.id, version: preview.version, publisher: preview.publisherName })}</p>
            <code>{preview.publisherFingerprint ?? t("extensions.manager.unsigned")}</code>
            {!preview.signed && <p className="extension-manager-warning">{t("extensions.manager.unsignedWarning")}</p>}
            {preview.metadataMigrationRequired && <p className="extension-manager-warning">{t("extensions.manager.migrationPending")}</p>}
            <fieldset>
              <legend>{t("extensions.manager.approveCapabilities")}</legend>
              {preview.capabilities.map((capability) => (
                <label key={capability}>
                  <input checked={approved.has(capability)} disabled={busy} onChange={(event) => setApproved((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(capability); else next.delete(capability);
                    return next;
                  })} type="checkbox" />
                  <span>{t(capabilityKeys[capability])}</span>
                </label>
              ))}
            </fieldset>
            <div className="dialog-actions">
              <button className="secondary-button" disabled={busy} onClick={() => setPreview(null)} type="button">{t("actions.cancel")}</button>
              <button className="primary-button" disabled={busy || !allApproved || preview.metadataMigrationRequired} onClick={() => void install()} type="button">{t("extensions.manager.installAndEnable")}</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
