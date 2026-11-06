import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("App Desktop IPC wiring", () => {
  it("passes Local AI Client settings from the trusted preload bridge to Preferences", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(source).toContain(
      "localAiClients={window.koedDesktop?.localAiClients}"
    );
  });

  it("wires update notice only through the preload bridge", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    expect(source).toContain("useDesktopUpdate(window.koedDesktop?.updates)");
    expect(source).toContain("<DesktopUpdateIndicator");
    expect(source).toContain('onOpen={() => openPreferences("about")}');
  });

  it("starts the solo interface without enabling the hidden Team interface", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

    expect(source).toContain('import { V1App as App } from "./v1/App.js"');
    expect(source).not.toContain("teamCollaborationEnabled=");
  });
});
