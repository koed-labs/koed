import "./styles.css";
import type {
  ComponentState,
  ComponentStatus,
  KoedServerStatus
} from "./types.js";

const stateLabels: Record<ComponentState, string> = {
  not_configured: "Not configured",
  starting: "Starting",
  healthy: "Healthy",
  needs_attention: "Needs attention"
};

const components: Array<[keyof KoedServerStatus, string]> = [
  ["api", "API"],
  ["database", "Database"],
  ["redis", "Redis"],
  ["workerQueues", "Redis/queues"],
  ["embeddingService", "Embedding Service"],
  ["apiToken", "Local credential/API Token"],
  ["mcpServer", "MCP Server"],
  ["captureHook", "Supported Capture Hook"],
  ["codex", "Codex configuration"],
  ["lcmSummaryService", "LCM Summary Service"],
  ["lastVerification", "Last verification"],
  ["project", "Project association"],
  ["explorer", "Explorer"]
];

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing app root.");
}

let status: KoedServerStatus | null = null;
let busy = false;
let lastAction = "";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const componentMessage = (component: ComponentStatus): string =>
  component.message ?? component.action ?? "No details.";

const setBusy = async (label: string, action: () => Promise<unknown>) => {
  busy = true;
  lastAction = label;
  render();
  try {
    await action();
    await refreshStatus();
  } catch (error) {
    lastAction = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
    render();
  }
};

const refreshStatus = async () => {
  if (!window.koedDesktop) {
    lastAction = "Koed Desktop bridge unavailable.";
    return;
  }
  status = await window.koedDesktop.invoke<KoedServerStatus>("status");
};

const render = () => {
  const explorerUrl = status?.explorer.url ?? "";
  const safeExplorerUrl = escapeHtml(explorerUrl);
  app.innerHTML = `
    <section class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="mark">K</div>
          <div>
            <h1>Koed Desktop</h1>
            <p>Local control plane</p>
          </div>
        </div>
        <div class="status ${status?.state ?? "starting"}">
          <span>${stateLabels[status?.state ?? "starting"]}</span>
          <small>${escapeHtml(status?.koedHome ?? "Loading KOED_HOME…")}</small>
        </div>
        <div class="actions">
          <button data-action="start" ${busy ? "disabled" : ""}>Start koed-server</button>
          <button data-action="setup" ${busy ? "disabled" : ""}>Setup Codex</button>
          <button data-action="doctor" ${busy ? "disabled" : ""}>Run doctor</button>
          <button data-action="refresh" ${busy ? "disabled" : ""}>Refresh</button>
        </div>
        <p class="hint">${escapeHtml(busy ? lastAction : lastAction || "Polls koed-server status every five seconds.")}</p>
        <div class="components">
          ${components
            .map(([key, label]) => {
              const component = status?.[key] as ComponentStatus | undefined;
              const state = component?.state ?? "starting";
              return `<article class="component ${state}">
                <strong>${label}</strong>
                <span>${stateLabels[state]}</span>
                <p>${escapeHtml(component ? componentMessage(component) : "Waiting for first status.")}</p>
              </article>`;
            })
            .join("")}
        </div>
      </aside>
      <section class="explorer">
        <div class="explorer-bar">
          <strong>Explorer</strong>
          <button data-action="open-explorer" ${explorerUrl ? "" : "disabled"}>Open in browser</button>
        </div>
        ${
          explorerUrl
            ? `<iframe title="Koed Explorer" src="${safeExplorerUrl}"></iframe>`
            : `<div class="empty">Explorer URL unavailable until koed-server status loads.</div>`
        }
      </section>
    </section>
  `;

  app
    .querySelector<HTMLButtonElement>('[data-action="start"]')
    ?.addEventListener(
      "click",
      () =>
        void setBusy("Starting koed-server…", () =>
          window.koedDesktop!.invoke("start")
        )
    );
  app
    .querySelector<HTMLButtonElement>('[data-action="setup"]')
    ?.addEventListener(
      "click",
      () =>
        void setBusy("Running Codex setup…", () =>
          window.koedDesktop!.invoke("setup_codex")
        )
    );
  app
    .querySelector<HTMLButtonElement>('[data-action="doctor"]')
    ?.addEventListener(
      "click",
      () =>
        void setBusy("Running doctor…", () =>
          window.koedDesktop!.invoke("doctor")
        )
    );
  app
    .querySelector<HTMLButtonElement>('[data-action="refresh"]')
    ?.addEventListener(
      "click",
      () => void setBusy("Refreshing status…", refreshStatus)
    );
  app
    .querySelector<HTMLButtonElement>('[data-action="open-explorer"]')
    ?.addEventListener("click", () => {
      if (explorerUrl) {
        void window.koedDesktop?.invoke("open_external", { url: explorerUrl });
      }
    });
};

void refreshStatus().finally(render);
setInterval(() => {
  if (!busy) {
    void refreshStatus().finally(render);
  }
}, 5_000);
