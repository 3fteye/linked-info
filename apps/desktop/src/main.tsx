import React from "react";
import ReactDOM from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App
      embeddingGateway={embeddingGateway}
      embeddingVectorCache={embeddingVectorCache}
      embeddingSettingsStore={localEmbeddingSettingsStore}
      localEmbeddingRuntime={localEmbeddingRuntime}
      lifecycle={lifecycle}
      persistence={persistence}
    />
  </React.StrictMode>,
);
