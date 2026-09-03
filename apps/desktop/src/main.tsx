import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./i18n";
import { loadAppearanceTheme } from "./appearancePreferences";
import { tauriCapsuleBridge } from "./capsuleBridge";

const MainWorkspace = lazy(() => import("./MainWorkspace"));
const CapsuleNote = lazy(() => import("./CapsuleNote"));
const label = isTauri() ? getCurrentWindow().label : "main";
document.documentElement.dataset.window = label;
document.documentElement.dataset.theme = loadAppearanceTheme(
  typeof localStorage === "undefined" ? null : localStorage,
);
document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      {label === "main" ? <MainWorkspace /> :
        label === "capsule" ? <CapsuleNote bridge={tauriCapsuleBridge} /> : null}
    </Suspense>
  </React.StrictMode>,
);
