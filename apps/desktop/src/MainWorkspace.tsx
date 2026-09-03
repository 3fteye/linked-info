import { useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import WorkspaceSecurityGate from "./WorkspaceSecurityGate";
import "./i18n";
import { localWorkspacePersistence } from "./workspaceStore";
import {
  createDesktopWorkspaceSession,
  type DesktopWorkspaceSession,
} from "./desktopWorkspaceSession";
import { unavailableCapsuleHost } from "./capsuleHost";
import {
  browserWorkspaceLifecycle,
  createTauriWorkspaceLifecycle,
} from "./workspaceLifecycle";
import {
  tauriEmbeddingGateway,
  tauriEmbeddingVectorCache,
  tauriLocalEmbeddingRuntime,
  unavailableEmbeddingGateway,
  unavailableLocalEmbeddingRuntime,
} from "./embeddingBridge";
import { unavailableEmbeddingVectorCache } from "./embeddingCache";
import { localEmbeddingSettingsStore } from "./embeddingSettings";
import {
  tauriDocumentImportLlmGateway,
  tauriLlmGateway,
  tauriLocalLlmRuntime,
  unavailableDocumentImportLlmGateway,
  unavailableLlmGateway,
  unavailableLocalLlmRuntime,
} from "./llmBridge";
import { localLlmSettingsStore } from "./llmSettings";
import {
  type WorkspaceSecurityStatus,
  type WorkspaceSecurity,
  tauriWorkspaceSecurity,
  unavailableWorkspaceSecurity,
} from "./workspaceSecurity";
import {
  tauriWorkspaceBackupHistory,
  unavailableWorkspaceBackupHistory,
} from "./workspaceBackupHistory";
import {
  tauriSecretClipboard,
  unavailableSecretClipboard,
} from "./secretClipboard";
import {
  tauriOffsiteBackupService,
  unavailableOffsiteBackupService,
} from "./offsiteBackup";
import {
  memoryOnlySmartReferenceResultCache,
  tauriSmartReferenceResultCache,
} from "./smartReferenceCache";

const runningInTauri = isTauri();
const lifecycle = runningInTauri
  ? createTauriWorkspaceLifecycle({
      exit() {
        return invoke<void>("exit_application");
      },
      restart() {
        return invoke<void>("restart_application");
      },
      onCloseRequested(handler) {
        return getCurrentWindow().onCloseRequested(handler);
      },
    })
  : browserWorkspaceLifecycle;
const embeddingGateway = runningInTauri
  ? tauriEmbeddingGateway
  : unavailableEmbeddingGateway;
const embeddingVectorCache = runningInTauri
  ? tauriEmbeddingVectorCache
  : unavailableEmbeddingVectorCache;
const localEmbeddingRuntime = runningInTauri
  ? tauriLocalEmbeddingRuntime
  : unavailableLocalEmbeddingRuntime;
const llmGateway = runningInTauri ? tauriLlmGateway : unavailableLlmGateway;
const documentImportLlmGateway = runningInTauri
  ? tauriDocumentImportLlmGateway
  : unavailableDocumentImportLlmGateway;
const localLlmRuntime = runningInTauri
  ? tauriLocalLlmRuntime
  : unavailableLocalLlmRuntime;
const workspaceSecurity = runningInTauri
  ? tauriWorkspaceSecurity
  : unavailableWorkspaceSecurity;
const workspaceBackupHistory = runningInTauri
  ? tauriWorkspaceBackupHistory
  : unavailableWorkspaceBackupHistory;
const secretClipboard = runningInTauri
  ? tauriSecretClipboard
  : unavailableSecretClipboard;
const offsiteBackup = runningInTauri
  ? tauriOffsiteBackupService
  : unavailableOffsiteBackupService;
const smartReferenceResultCache = runningInTauri
  ? tauriSmartReferenceResultCache
  : memoryOnlySmartReferenceResultCache;
function UnlockedWorkspace({
  workspaceSecurityStatus,
  updateWorkspaceSecurityStatus,
}: {
  workspaceSecurityStatus: WorkspaceSecurityStatus;
  updateWorkspaceSecurityStatus: (status: WorkspaceSecurityStatus) => void;
}) {
  const [session, setSession] = useState<DesktopWorkspaceSession | null>(null);
  useEffect(() => {
    const current = runningInTauri
      ? createDesktopWorkspaceSession()
      : {
          persistence: localWorkspacePersistence,
          capsuleHost: unavailableCapsuleHost,
          lockWithSnapshot() {
            return workspaceSecurity.lock();
          },
          dispose() {},
        };
    setSession(current);
    return () => current.dispose();
  }, []);
  const ownerSecurity = useMemo<WorkspaceSecurity>(() => ({
    ...workspaceSecurity,
    lock(contents) {
      if (contents === undefined) {
        return workspaceSecurity.lock();
      }
      if (session === null) {
        return Promise.reject(new Error("workspace_session_unavailable"));
      }
      return session.lockWithSnapshot(contents);
    },
  }), [session]);
  if (session === null) {
    return null;
  }
  return (
    <App
      capsuleHost={session.capsuleHost}
      documentImportLlmGateway={documentImportLlmGateway}
      embeddingGateway={embeddingGateway}
      embeddingVectorCache={embeddingVectorCache}
      embeddingSettingsStore={localEmbeddingSettingsStore}
      llmGateway={llmGateway}
      llmSettingsStore={localLlmSettingsStore}
      localEmbeddingRuntime={localEmbeddingRuntime}
      localLlmRuntime={localLlmRuntime}
      lifecycle={lifecycle}
      offsiteBackup={offsiteBackup}
      persistence={session.persistence}
      secretClipboard={secretClipboard}
      smartReferenceResultCache={smartReferenceResultCache}
      updateWorkspaceSecurityStatus={updateWorkspaceSecurityStatus}
      workspaceBackupHistory={workspaceBackupHistory}
      workspaceSecurity={ownerSecurity}
      workspaceSecurityStatus={workspaceSecurityStatus}
    />
  );
}

export default function MainWorkspace() {
  return (
    <WorkspaceSecurityGate lifecycle={lifecycle} security={workspaceSecurity}>
      {(workspaceSecurityStatus, updateWorkspaceSecurityStatus) => (
        <UnlockedWorkspace
          workspaceSecurityStatus={workspaceSecurityStatus}
          updateWorkspaceSecurityStatus={updateWorkspaceSecurityStatus}
        />
      )}
    </WorkspaceSecurityGate>
  );
}
