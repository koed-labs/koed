import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("App Desktop IPC wiring", () => {
  it("passes Local AI Client settings from the trusted preload bridge to Preferences", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(source).toContain(
      "localAiClients={window.koedDesktop?.localAiClients}"
    );
  });

  it("reads the Team collaboration flag from the trusted preload bridge", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

    expect(source).toContain(
      "window.koedDesktop?.featureFlags?.teamCollaborationEnabled ?? false"
    );
  });
});
