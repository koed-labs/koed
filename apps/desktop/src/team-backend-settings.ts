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

export type TeamBackendSettingsView = {
  busy: boolean;
  canDisconnect: boolean;
  connected: boolean;
  detail: string;
  status: string;
  urlValue: string;
};

export type TeamBackendDisclosureState = {
  connectionDetailsOpen: boolean;
  settingsOpen: boolean;
};

export const readTeamBackendDisclosureState = (
  root: ParentNode
): TeamBackendDisclosureState => ({
  connectionDetailsOpen:
    root.querySelector<HTMLDetailsElement>(".team-backend-connection-details")
      ?.open ?? false,
  settingsOpen:
    root.querySelector<HTMLDetailsElement>(".team-backend-settings")?.open ??
    false
});

export const restoreTeamBackendDisclosureState = (
  root: ParentNode,
  state: TeamBackendDisclosureState,
  revealFailure = false
): void => {
  const settings = root.querySelector<HTMLDetailsElement>(
    ".team-backend-settings"
  );
  const connectionDetails = root.querySelector<HTMLDetailsElement>(
    ".team-backend-connection-details"
  );
  if (settings) settings.open = state.settingsOpen || revealFailure;
  if (connectionDetails) {
    connectionDetails.open = state.connectionDetailsOpen || revealFailure;
  }
};

export const teamBackendStatusCue = ({
  healthy,
  registered,
  validated
}: {
  healthy: boolean;
  registered: number;
  validated: number;
}): string | null => {
  if (registered === 0) return "Not connected (optional)";
  if (validated < registered) return "Enrollment incomplete";
  return healthy ? "Connected" : null;
};

export const renderTeamBackendSettings = (
  view: TeamBackendSettingsView
): string => `
  <details class="team-backend-settings" data-team-backend-settings>
    <summary>
      <span><strong>Team Backend</strong><small>Optional connection</small></span>
      <span class="team-backend-settings-state ${view.connected ? "connected" : "disconnected"}">${escapeHtml(view.status)}</span>
    </summary>
    <div class="team-backend-settings-body">
      <p>Connect this device to a Team Backend for Team Workspace recall. Personal Memory continues to work locally when no backend is connected.</p>
      <form class="team-backend-form" data-team-backend-form>
        <label for="team-backend-url">Team Backend URL</label>
        <div class="team-backend-form-controls">
          <input
            id="team-backend-url"
            type="url"
            data-team-backend-url
            placeholder="https://team.example.com"
            value="${escapeHtml(view.urlValue)}"
            autocomplete="url"
            ${view.busy ? "disabled" : ""}
          />
          <button type="submit" class="primary" ${view.busy ? "disabled" : ""}>Connect</button>
          <button
            type="button"
            class="secondary"
            data-team-backend-disconnect
            ${view.busy || !view.canDisconnect ? "disabled" : ""}
          >Disconnect</button>
        </div>
      </form>
      <details class="team-backend-connection-details">
        <summary>Connection details</summary>
        <pre>${escapeHtml(view.detail)}</pre>
      </details>
    </div>
  </details>
`;
