const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[character] ?? character
  );

export type PersonalSyncSettingsView = {
  busy: boolean;
  detail: string;
  status: "not_configured" | "disabled" | "enabled" | "paused" | "unavailable";
  devices: Array<{ id: string; label: string; state: string }>;
  freshness: string;
};

export const personalSyncStatusLabel = (
  status: PersonalSyncSettingsView["status"]
): string =>
  ({
    not_configured: "Not configured",
    disabled: "Ready for recovery verification",
    enabled: "Syncing future Sessions",
    paused: "Paused",
    unavailable: "Secure provider unavailable"
  })[status];

export const renderPersonalSyncSettings = (
  view: PersonalSyncSettingsView
): string => `
  <details class="personal-sync-settings" data-personal-sync-settings>
    <summary>
      <span><strong>Personal Device Sync</strong><small>Opt-in Personal Memory replication</small></span>
      <span class="personal-sync-settings-state ${escapeHtml(view.status)}">${escapeHtml(personalSyncStatusLabel(view.status))}</span>
    </summary>
    <div class="personal-sync-settings-body">
      <p><strong>Every selected device receives decryptable Personal Memory.</strong> Revoking a device stops future delivery; it cannot erase plaintext already downloaded.</p>
      <p>Only eligible future closed Sessions replicate. Association and Remote Account Links alone sync nothing. Team Workspaces, API Tokens, MCP Server, and Capture Hook remain separate and local.</p>
      <div class="personal-sync-actions" role="group" aria-label="Personal Device Sync controls">
        <button type="button" data-personal-sync-action="setup" ${view.busy ? "disabled" : ""}>Set up device group</button>
        <button type="button" data-personal-sync-action="pair" ${view.busy ? "disabled" : ""}>Pair device</button>
        <button type="button" data-personal-sync-action="resume" ${view.busy || view.status !== "paused" ? "disabled" : ""}>Resume</button>
        <button type="button" class="secondary" data-personal-sync-action="pause" ${view.busy || view.status !== "enabled" ? "disabled" : ""}>Pause</button>
        <button type="button" class="secondary" data-personal-sync-action="retry" ${view.busy ? "disabled" : ""}>Retry</button>
      </div>
      <p class="personal-sync-freshness"><strong>Freshness:</strong> ${escapeHtml(view.freshness)}</p>
      <h3>Devices</h3>
      <ul class="personal-sync-device-list">${view.devices.length ? view.devices.map((device) => `<li><span>${escapeHtml(device.label)}</span><small>${escapeHtml(device.state)}</small><button type="button" class="secondary" data-personal-sync-revoke="${escapeHtml(device.id)}" ${view.busy || device.state !== "active" ? "disabled" : ""}>Revoke</button></li>`).join("") : "<li><span>No devices enrolled</span></li>"}</ul>
      <p class="personal-sync-note">Recovery kit password and private material never enter Desktop IPC, renderer state, localStorage, config, status, or logs. Use shown headless command for encrypted kit create/verify; Desktop then refreshes status.</p>
      <pre class="personal-sync-detail" aria-live="polite">${escapeHtml(view.detail)}</pre>
    </div>
  </details>
`;
