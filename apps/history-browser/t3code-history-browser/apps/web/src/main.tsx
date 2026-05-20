import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { KoedHistoryApp } from "./koed/KoedHistoryApp";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

const isKoedHistoryBrowser = import.meta.env.VITE_KOED_HISTORY_BROWSER === "1";

document.title = isKoedHistoryBrowser ? "Koed History" : APP_DISPLAY_NAME;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isKoedHistoryBrowser ? <KoedHistoryApp /> : <RouterProvider router={getRouter(history)} />}
  </React.StrictMode>,
);
