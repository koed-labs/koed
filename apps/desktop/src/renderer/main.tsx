import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./index.css";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing app root.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
