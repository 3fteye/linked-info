import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  RotateCcw,
} from "lucide-react";
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
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const lockLatchedRef = useRef(false);
  const statusProbeGenerationRef = useRef(0);
  const updateStatusFromWorkspace = useCallback(
    (next: WorkspaceSecurityStatus) => {
      if (next.locked) {
        lockLatchedRef.current = true;
      }
      setStatus((current) => {
        if (lockLatchedRef.current && !next.locked) {
          return current ?? { ...next, locked: true };
        }
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    let active = true;
    const probeGeneration = statusProbeGenerationRef.current;
    setError(null);
    void security
      .inspect()
      .then((next) => {
        if (
          active &&
          statusProbeGenerationRef.current === probeGeneration
        ) {
          updateStatusFromWorkspace(next);
        }
      })
      .catch((reason) => {
        if (
          active &&
          statusProbeGenerationRef.current === probeGeneration
        ) {
          setError(errorReason(reason));
        }
      });
    return () => {
      active = false;
    };
  }, [retryGeneration, security, updateStatusFromWorkspace]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void security
      .subscribeLocked((reason) => {
        if (!active) {
          return;
        }
        lockLatchedRef.current = true;
        const probeGeneration = statusProbeGenerationRef.current + 1;
        statusProbeGenerationRef.current = probeGeneration;
        if (
          reason === "workspace_password_change_recovery_required" ||
          reason === "workspace_restore_recovery_required" ||
          reason === "workspace_recovery_swap_pending"
        ) {
          setRecoveryRequired(true);
        }
        setStatus((current) =>
          current === null ? current : { ...current, locked: true },
        );
        setPassword("");
        setNotice(
          reason === "workspace_data_key_rotated_cleanup_pending"
            ? t("security.rotateSuccessCleanupPending")
            : reason === "workspace_data_key_rotated_cleanup_skipped"
              ? t("security.rotateSuccessCleanupSkipped")
            : reason === "workspace_data_key_rotated"
            ? t("security.rotateSuccessLocked")
            : reason === "workspace_password_changed_locked"
              ? t("security.changeSuccessLocked")
              : null,
        );
        setError(
          reason === "workspace_destroy_failed" ||
            reason === "workspace_data_key_rotation_failed"
            ? reason
            : null,
        );
        void security
          .inspect()
          .then((next) => {
            if (
              active &&
              statusProbeGenerationRef.current === probeGeneration
            ) {
              updateStatusFromWorkspace(next);
            }
          })
          .catch((error) => {
            if (
              active &&
              statusProbeGenerationRef.current === probeGeneration
            ) {
              setError(errorReason(error));
            }
          });
      })
      .then((dispose) => {
        if (active) {
          unsubscribe = dispose;
        } else {
          dispose();
        }
      })
      .catch((reason) => {
        if (active) {
          setError(errorReason(reason));
        }
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [security, t, updateStatusFromWorkspace]);

  useEffect(() => {
    if (status?.encrypted !== true || status.locked) {
      return;
    }
    let lastReportedAt = 0;
    const recordActivity = () => {
      const now = Date.now();
      if (now - lastReportedAt < 30_000) {
        return;
      }
      lastReportedAt = now;
      void security.recordActivity().catch(() => {
        // The Rust idle timer remains authoritative if an activity report fails.
      });
    };
    const eventTypes = ["pointerdown", "keydown", "input", "wheel"] as const;
    for (const eventType of eventTypes) {
      window.addEventListener(eventType, recordActivity, { capture: true });
    }
    return () => {
      for (const eventType of eventTypes) {
        window.removeEventListener(eventType, recordActivity, { capture: true });
      }
    };
  }, [security, status?.encrypted, status?.locked]);

  async function performUnlock(
    request: () => Promise<WorkspaceSecurityStatus>,
    clearPassword: boolean,
  ) {
    const attemptGeneration = statusProbeGenerationRef.current + 1;
    statusProbeGenerationRef.current = attemptGeneration;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await request();
      if (statusProbeGenerationRef.current !== attemptGeneration) {
        return;
      }
      if (clearPassword) {
        setPassword("");
      }
      lockLatchedRef.current = next.locked;
      setStatus(next);
    } catch (reason) {
      if (statusProbeGenerationRef.current === attemptGeneration) {
        setError(errorReason(reason));
      }
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    if (busy || password.length === 0) {
      return;
    }
    await performUnlock(() => security.unlock(password), true);
  }

  async function unlockWithSystem() {
    if (busy) {
      return;
    }
    await performUnlock(
      () => security.unlockWithSystem(t("security.systemUnlockPrompt")),
      false,
    );
  }

  if (recoveryRequired) {
    return (
      <main className="security-gate" data-testid="workspace-security-recovery-required">
        <AlertTriangle aria-hidden="true" size={34} />
        <h1>{t("storageProblem.recoveryRequiredTitle")}</h1>
        <p>{t("storageProblem.recoveryRequiredDescription")}</p>
        <button
          className="primary-button"
          onClick={() => window.location.reload()}
          type="button"
        >
          <RotateCcw aria-hidden="true" size={16} />
          {t("storageProblem.restart")}
        </button>
      </main>
    );
  }

  if (status !== null && !status.locked) {
    return <>{children(status, updateStatusFromWorkspace)}</>;
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
      {notice !== null && (
        <p className="security-notice" role="status">
          {notice}
        </p>
      )}
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
            {error === "workspace_destroy_failed"
              ? t("security.destroyFailedLocked")
              : error === "workspace_data_key_rotation_failed"
                ? t("security.rotateFailedLocked")
              : error === "workspace_vault_invalid_password"
              ? t("security.invalidPassword")
              : error === "workspace_vault_password_rate_limited"
                ? t("security.passwordRateLimited")
              : error === "system_unlock_verification_cancelled"
                ? t("security.systemUnlockCancelled")
                : error === "system_unlock_verification_not_configured"
                  ? t("security.systemUnlockNotConfigured")
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
