import { useEffect, useState, type ReactNode } from "react";
import { Fingerprint, KeyRound, LockKeyhole, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  WorkspaceSecurity,
  WorkspaceSecurityStatus,
} from "./workspaceSecurity";

interface WorkspaceSecurityGateProps {
  children: (
    status: WorkspaceSecurityStatus,
    updateStatus: (status: WorkspaceSecurityStatus) => void,
  ) => ReactNode;
  security: WorkspaceSecurity;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function WorkspaceSecurityGate({
  children,
  security,
}: WorkspaceSecurityGateProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WorkspaceSecurityStatus | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    void security
      .inspect()
      .then((next) => {
        if (active) {
          setStatus(next);
        }
      })
      .catch((reason) => {
        if (active) {
          setError(errorReason(reason));
        }
      });
    return () => {
      active = false;
    };
  }, [retryGeneration, security]);

  async function unlock() {
    if (busy || password.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await security.unlock(password);
      setPassword("");
      setStatus(next);
    } catch (reason) {
      setError(errorReason(reason));
    } finally {
      setBusy(false);
    }
  }

  async function unlockWithSystem() {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus(await security.unlockWithSystem());
    } catch (reason) {
      setError(errorReason(reason));
    } finally {
      setBusy(false);
    }
  }

  if (status !== null && !status.locked) {
    return <>{children(status, setStatus)}</>;
  }

  if (status === null && error === null) {
    return (
      <main className="security-gate">
        <LockKeyhole aria-hidden="true" size={34} />
        <p>{t("security.loading")}</p>
      </main>
    );
  }

  if (status === null) {
    return (
      <main className="security-gate">
        <LockKeyhole aria-hidden="true" size={34} />
        <h1>{t("security.startupFailed")}</h1>
        <p className="security-error" role="alert">
          {error}
        </p>
        <button
          className="primary-button"
          onClick={() => setRetryGeneration((current) => current + 1)}
          type="button"
        >
          <RotateCcw aria-hidden="true" size={16} />
          {t("security.retry")}
        </button>
      </main>
    );
  }

  return (
    <main className="security-gate">
      <LockKeyhole aria-hidden="true" size={34} />
      <h1>{t("security.unlockTitle")}</h1>
      <p>{t("security.unlockDescription")}</p>
      {status.systemUnlockAvailable && status.systemUnlockEnabled && (
        <div className="security-system-unlock">
          <button
            autoFocus
            className="primary-button"
            disabled={busy}
            onClick={() => void unlockWithSystem()}
            type="button"
          >
            <Fingerprint aria-hidden="true" size={17} />
            {busy ? t("security.unlocking") : t("security.systemUnlockAction")}
          </button>
          <small>{t("security.systemUnlockDeviceOnly")}</small>
          <div className="security-unlock-divider">
            <span>{t("security.orUsePassword")}</span>
          </div>
        </div>
      )}
      <form
        className="security-unlock-form"
        onSubmit={(event) => {
          event.preventDefault();
          void unlock();
        }}
      >
        <label htmlFor="workspace-unlock-password">{t("security.password")}</label>
        <div className="security-password-input">
          <KeyRound aria-hidden="true" size={16} />
          <input
            autoComplete="current-password"
            autoFocus={!(status.systemUnlockAvailable && status.systemUnlockEnabled)}
            id="workspace-unlock-password"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </div>
        {error !== null && (
          <p className="security-error" role="alert">
            {error === "workspace_vault_invalid_password"
              ? t("security.invalidPassword")
              : t("security.unlockFailed", { reason: error })}
          </p>
        )}
        <button
          className="primary-button"
          disabled={busy || password.length === 0}
          type="submit"
        >
          {busy ? t("security.unlocking") : t("security.unlock")}
        </button>
      </form>
    </main>
  );
}
