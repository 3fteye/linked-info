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
  tauriLlmGateway,
  tauriLocalLlmRuntime,
  unavailableLlmGateway,
  unavailableLocalLlmRuntime,
} from "./llmBridge";
import { localLlmSettingsStore } from "./llmSettings";
import {
  tauriWorkspaceSecurity,
  unavailableWorkspaceSecurity,
} from "./workspaceSecurity";

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
const localLlmRuntime = runningInTauri
  ? tauriLocalLlmRuntime
  : unavailableLocalLlmRuntime;
const workspaceSecurity = runningInTauri
  ? tauriWorkspaceSecurity
  : unavailableWorkspaceSecurity;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WorkspaceSecurityGate security={workspaceSecurity}>
      {(workspaceSecurityStatus, updateWorkspaceSecurityStatus) => (
        <App
          embeddingGateway={embeddingGateway}
          embeddingVectorCache={embeddingVectorCache}
          embeddingSettingsStore={localEmbeddingSettingsStore}
          llmGateway={llmGateway}
          llmSettingsStore={localLlmSettingsStore}
          localEmbeddingRuntime={localEmbeddingRuntime}
          localLlmRuntime={localLlmRuntime}
          lifecycle={lifecycle}
          persistence={persistence}
          updateWorkspaceSecurityStatus={updateWorkspaceSecurityStatus}
          workspaceSecurity={workspaceSecurity}
          workspaceSecurityStatus={workspaceSecurityStatus}
        />
      )}
    </WorkspaceSecurityGate>
  </React.StrictMode>,
);
