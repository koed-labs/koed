// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import {
  readTeamBackendDisclosureState,
  renderTeamBackendSettings,
  restoreTeamBackendDisclosureState,
  teamBackendStatusCue
} from "./team-backend-settings.js";

describe("Team Backend Settings", () => {
  it("does not describe an optional disconnected backend as reachable", () => {
    expect(
      teamBackendStatusCue({ healthy: true, registered: 0, validated: 0 })
    ).toBe("Not connected (optional)");
    expect(
      teamBackendStatusCue({ healthy: true, registered: 1, validated: 1 })
    ).toBe("Connected");
  });

  it("renders a reachable optional enrollment flow when disconnected", () => {
    const html = renderTeamBackendSettings({
      busy: false,
      canDisconnect: false,
      connected: false,
      detail: "No Team Backend connected",
      status: "Not connected",
      urlValue: ""
    });

    expect(html).toContain("data-team-backend-settings");
    expect(html).toContain("data-team-backend-form");
    expect(html).toContain("data-team-backend-url");
    expect(html).toContain("Not connected");
    expect(html).toMatch(/data-team-backend-disconnect\s+disabled/);
  });

  it("enables disconnect and escapes preserved User input", () => {
    const html = renderTeamBackendSettings({
      busy: false,
      canDisconnect: true,
      connected: true,
      detail: "1 registered · 1 validated",
      status: "Connected",
      urlValue: 'https://team.example.com/" onfocus="alert(1)'
    });

    expect(html).toContain("Connected");
    expect(html).not.toMatch(/data-team-backend-disconnect\s+disabled/);
    expect(html).toContain("&quot; onfocus=&quot;");
    expect(html).not.toContain('value="https://team.example.com/" onfocus=');
  });

  it("restores disclosure state and reveals actionable failures", () => {
    const root = document.createElement("div");
    root.innerHTML = renderTeamBackendSettings({
      busy: false,
      canDisconnect: false,
      connected: false,
      detail: "failed: Team Backend URL must not include credentials",
      status: "Not connected (optional)",
      urlValue: "https://user@example.com"
    });
    const settings = root.querySelector<HTMLDetailsElement>(
      ".team-backend-settings"
    )!;
    const connectionDetails = root.querySelector<HTMLDetailsElement>(
      ".team-backend-connection-details"
    )!;
    settings.open = true;
    connectionDetails.open = true;

    const openState = readTeamBackendDisclosureState(root);
    root.innerHTML = renderTeamBackendSettings({
      busy: true,
      canDisconnect: false,
      connected: false,
      detail: "failed: Team Backend URL must not include credentials",
      status: "Not connected (optional)",
      urlValue: "https://user@example.com"
    });
    restoreTeamBackendDisclosureState(root, openState);

    expect(
      root.querySelector<HTMLDetailsElement>(".team-backend-settings")?.open
    ).toBe(true);
    expect(
      root.querySelector<HTMLDetailsElement>(".team-backend-connection-details")
        ?.open
    ).toBe(true);

    root.innerHTML = renderTeamBackendSettings({
      busy: false,
      canDisconnect: false,
      connected: false,
      detail: "failed: Team Backend URL must not include credentials",
      status: "Not connected (optional)",
      urlValue: "https://user@example.com"
    });
    restoreTeamBackendDisclosureState(
      root,
      { connectionDetailsOpen: false, settingsOpen: false },
      true
    );

    expect(
      root.querySelector<HTMLDetailsElement>(".team-backend-settings")?.open
    ).toBe(true);
    expect(
      root.querySelector<HTMLDetailsElement>(".team-backend-connection-details")
        ?.open
    ).toBe(true);
    expect(root.textContent).toContain(
      "failed: Team Backend URL must not include credentials"
    );
  });
});
