import React from "react";
import ReactDOM from "react-dom/client";

import "./index.css";

import { KoedExplorerApp } from "./koed/KoedExplorerApp";

document.title = "Koed Explorer";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <KoedExplorerApp />
  </React.StrictMode>
);
