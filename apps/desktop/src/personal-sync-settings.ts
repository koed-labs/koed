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
  groupId: string | null;
  pairing: { challengeId: string; shortCode: string; url?: string } | null;
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
      detail: "Personal Sync status is unavailable.",
      groupId: previous.groupId,
      pairing: previous.pairing
    };
  }
  const payload = value as Record<string, unknown>;
  const group = Array.isArray(payload.groups)
    ? payload.groups.find((value): value is Record<string, unknown> =>
        Boolean(value && typeof value === "object" && !Array.isArray(value))
      )
    : null;
  const groupId =
    group && typeof group.group_id === "string"
      ? group.group_id
      : previous.groupId;
  const deviceValues = Array.isArray(payload.devices)
    ? payload.devices
    : Array.isArray(group?.members)
      ? group.members
      : [];
  const devices = deviceValues.flatMap((device) => {
    if (!device || typeof device !== "object") return [];
    const item = device as Record<string, unknown>;
    const id =
      typeof item.id === "string"
        ? item.id
        : typeof item.device_id === "string"
          ? item.device_id
          : null;
    return id && typeof item.state === "string"
      ? [
          {
            id,
            label: typeof item.label === "string" ? item.label : "Device",
            state: item.state
          }
        ]
      : [];
  });
  const pairingValue = payload.pairing;
  const pairing =
    pairingValue &&
    typeof pairingValue === "object" &&
    typeof (pairingValue as Record<string, unknown>).challengeId === "string" &&
    typeof (pairingValue as Record<string, unknown>).shortCode === "string"
      ? {
          challengeId: (pairingValue as Record<string, unknown>)
            .challengeId as string,
          shortCode: (pairingValue as Record<string, unknown>)
            .shortCode as string,
          ...(typeof (pairingValue as Record<string, unknown>).url === "string"
            ? {
                url: (pairingValue as Record<string, unknown>).url as string
              }
            : {})
        }
      : previous.pairing;
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
        : payload.state === "backend" &&
            group?.policy &&
            typeof group.policy === "object"
          ? (group.policy as Record<string, unknown>).enabled === true
            ? "enabled"
            : "disabled"
          : payload.state === "not_configured"
            ? "not_configured"
            : "unavailable",
    devices,
    freshness,
    groupId,
    pairing
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
        <button type="button" data-personal-sync-action="pair" ${view.busy || !view.groupId || (view.status !== "disabled" && view.status !== "enabled" && view.status !== "paused") ? "disabled" : ""}>Pair device</button>
        <button type="button" data-personal-sync-action="resume" ${view.busy || view.status !== "paused" ? "disabled" : ""}>Resume</button>
        <button type="button" class="secondary" data-personal-sync-action="pause" ${view.busy || view.status !== "enabled" ? "disabled" : ""}>Pause</button>
        <button type="button" class="secondary" data-personal-sync-action="retry" ${view.busy ? "disabled" : ""}>Retry</button>
        <button type="button" class="secondary" data-personal-sync-action="restart" ${view.busy ? "disabled" : ""}>Restart local sync</button>
      </div>
      <p class="personal-sync-freshness"><strong>Freshness:</strong> ${escapeHtml(view.freshness)}</p>
      ${view.pairing ? `<p class="personal-sync-pairing"><strong>Pairing pending:</strong> ${escapeHtml(view.pairing.shortCode)} (${escapeHtml(view.pairing.challengeId)})${view.pairing.url ? ` <a href="${escapeHtml(view.pairing.url)}" rel="noreferrer">Open approval</a>` : ""}</p>` : ""}
      <h3>Devices</h3>
      <ul class="personal-sync-device-list">${view.devices.length ? view.devices.map((device) => `<li><span>${escapeHtml(device.label)}</span><small>${escapeHtml(device.state)}</small><button type="button" class="secondary" aria-label="Revoke ${escapeHtml(device.label)}" data-personal-sync-revoke="${escapeHtml(device.id)}" ${view.busy || device.state !== "active" ? "disabled" : ""}>Revoke</button></li>`).join("") : "<li><span>No devices enrolled</span></li>"}</ul>
      <p class="personal-sync-note">Recovery kit password and private material never enter Desktop IPC, renderer state, localStorage, config, status, or logs. Follow headless setup guidance for encrypted kit create/verify, then refresh Desktop status.</p>
      <pre class="personal-sync-detail" aria-live="polite">${escapeHtml(view.detail)}</pre>
    </div>
  </details>
`;
