import { describe, expect, it } from "vitest";

import {
  renderTeamBackendSettings,
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
});
