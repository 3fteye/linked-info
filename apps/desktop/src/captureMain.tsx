import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import i18n from "./i18n";
import { loadAppearanceTheme } from "./appearancePreferences";
import CaptureApp from "./CaptureApp";
import { tauriCaptureBridge } from "./captureBridge";

document.documentElement.dataset.window = "capture";
document.documentElement.dataset.theme = loadAppearanceTheme(localStorage);
document.title = i18n.t("capture.title");
document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isTauri() && getCurrentWindow().label === "capture"
      ? <CaptureApp bridge={tauriCaptureBridge} />
      : <p role="alert">{i18n.t("capture.independentOnly")}</p>}
  </React.StrictMode>,
);
