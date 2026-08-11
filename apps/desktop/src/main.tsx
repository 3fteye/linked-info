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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App lifecycle={lifecycle} persistence={persistence} />
  </React.StrictMode>,
);
