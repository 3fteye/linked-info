import React from "react";
import ReactDOM from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import WorkspaceSecurityGate from "./WorkspaceSecurityGate";
import "./i18n";
import { localWorkspacePersistence } from "./workspaceStore";
import { tauriWorkspacePersistence } from "./workspaceTauriPersistence";
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

document.addEventListener(
  "contextmenu",
  (event) => event.preventDefault(),
  { capture: true },
);

const runningInTauri = isTauri();
const persistence = runningInTauri
  ? tauriWorkspacePersistence
  : localWorkspacePersistence;
const lifecycle = runningInTauri
  ? createTauriWorkspaceLifecycle({
      exit() {
        return invoke<void>("exit_application");
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WorkspaceSecurityGate security={workspaceSecurity}>
      {(workspaceSecurityStatus, updateWorkspaceSecurityStatus) => (
        <App
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
          persistence={persistence}
          secretClipboard={secretClipboard}
          smartReferenceResultCache={smartReferenceResultCache}
          updateWorkspaceSecurityStatus={updateWorkspaceSecurityStatus}
          workspaceBackupHistory={workspaceBackupHistory}
          workspaceSecurity={workspaceSecurity}
          workspaceSecurityStatus={workspaceSecurityStatus}
        />
      )}
    </WorkspaceSecurityGate>
  </React.StrictMode>,
);
