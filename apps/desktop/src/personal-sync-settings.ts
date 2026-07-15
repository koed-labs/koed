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

export const personalSyncSettingsViewFrom = (
  value: unknown,
  previous: PersonalSyncSettingsView
): PersonalSyncSettingsView => {
  if (!value || typeof value !== "object") {
    return {
      ...previous,
      busy: false,
      status: "unavailable",
      detail: "Personal Sync status is unavailable."
    };
  }
  const payload = value as Record<string, unknown>;
  const devices = Array.isArray(payload.devices)
    ? payload.devices.flatMap((device) => {
        if (!device || typeof device !== "object") return [];
        const item = device as Record<string, unknown>;
        return typeof item.id === "string" && typeof item.state === "string"
          ? [
              {
                id: item.id,
                label: typeof item.label === "string" ? item.label : "Device",
                state: item.state
              }
            ]
          : [];
      })
    : [];
  const replica = payload.replica;
  const freshness =
    replica && typeof replica === "object" && "lastSuccessfulSyncAt" in replica
      ? String(
          (replica as { lastSuccessfulSyncAt?: unknown })
            .lastSuccessfulSyncAt ?? "No synchronized replica yet"
        )
      : "No synchronized replica yet";
  return {
    busy: previous.busy,
    detail:
      typeof payload.message === "string"
        ? payload.message
        : "No Personal Sync details available.",
    status:
      payload.state === "disabled" ||
      payload.state === "enabled" ||
      payload.state === "paused"
        ? payload.state
        : payload.state === "not_configured"
          ? "not_configured"
          : "unavailable",
    devices,
    freshness
  };
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
        <button type="button" data-personal-sync-action="setup" ${view.busy || view.status !== "not_configured" ? "disabled" : ""}>Show setup guidance</button>
        <button type="button" data-personal-sync-action="pair" ${view.busy || (view.status !== "disabled" && view.status !== "enabled" && view.status !== "paused") ? "disabled" : ""}>Pair device</button>
        <button type="button" data-personal-sync-action="resume" ${view.busy || view.status !== "paused" ? "disabled" : ""}>Resume</button>
        <button type="button" class="secondary" data-personal-sync-action="pause" ${view.busy || view.status !== "enabled" ? "disabled" : ""}>Pause</button>
        <button type="button" class="secondary" data-personal-sync-action="retry" ${view.busy ? "disabled" : ""}>Retry</button>
        <button type="button" class="secondary" data-personal-sync-action="restart" ${view.busy ? "disabled" : ""}>Restart local sync</button>
      </div>
      <p class="personal-sync-freshness"><strong>Freshness:</strong> ${escapeHtml(view.freshness)}</p>
      <h3>Devices</h3>
      <ul class="personal-sync-device-list">${view.devices.length ? view.devices.map((device) => `<li><span>${escapeHtml(device.label)}</span><small>${escapeHtml(device.state)}</small><button type="button" class="secondary" aria-label="Revoke ${escapeHtml(device.label)}" data-personal-sync-revoke="${escapeHtml(device.id)}" ${view.busy || device.state !== "active" ? "disabled" : ""}>Revoke</button></li>`).join("") : "<li><span>No devices enrolled</span></li>"}</ul>
      <p class="personal-sync-note">Recovery kit password and private material never enter Desktop IPC, renderer state, localStorage, config, status, or logs. Follow headless setup guidance for encrypted kit create/verify, then refresh Desktop status.</p>
      <pre class="personal-sync-detail" aria-live="polite">${escapeHtml(view.detail)}</pre>
    </div>
  </details>
`;
