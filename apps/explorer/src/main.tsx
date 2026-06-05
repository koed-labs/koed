import React from "react";
import ReactDOM from "react-dom/client";

import "./index.css";

import { KoedHistoryApp } from "./koed/KoedHistoryApp";

document.title = "Koed History";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <KoedHistoryApp />
  </React.StrictMode>
);
