import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("App Desktop IPC wiring", () => {
  it("passes Local AI Client settings from the trusted preload bridge to Preferences", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(source).toContain(
      "localAiClients={window.koedDesktop?.localAiClients}"
    );
  });

  it("wires update notice into the active V1 Home shell and About settings", () => {
    const app = readFileSync(new URL("./v1/App.tsx", import.meta.url), "utf8");
    const shell = readFileSync(
      new URL("./v1/NavigationShell.tsx", import.meta.url),
      "utf8"
    );
    const settings = readFileSync(
      new URL("./v1/settings.tsx", import.meta.url),
      "utf8"
    );
    expect(app).toContain("useDesktopUpdate(window.koedDesktop?.updates)");
    expect(app).toContain("<V1Settings");
    expect(app).toContain("update={update}");
    expect(shell).toContain("DesktopUpdateIndicator");
    expect(settings).toContain("DesktopUpdatePanel");
  });

  it("starts the solo interface without enabling the hidden Team interface", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

    expect(source).toContain('import { V1App as App } from "./v1/App.js"');
    expect(source).not.toContain("teamCollaborationEnabled=");
  });
});
