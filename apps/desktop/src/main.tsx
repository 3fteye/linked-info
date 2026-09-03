import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import i18n from "./i18n";
import { loadAppearanceTheme } from "./appearancePreferences";

const MainWorkspace = lazy(() => import("./MainWorkspace"));
const label = isTauri() ? getCurrentWindow().label : "main";
const mainEntry = label === "main" && !new URLSearchParams(location.search).has("capsule");
document.documentElement.dataset.window = label;
document.documentElement.dataset.theme = loadAppearanceTheme(
  typeof localStorage === "undefined" ? null : localStorage,
);
document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      {mainEntry ? <MainWorkspace /> : <p role="alert">{i18n.t("capture.independentOnly")}</p>}
    </Suspense>
  </React.StrictMode>,
);
