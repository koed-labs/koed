import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("App Desktop IPC wiring", () => {
  it("passes Local AI Client settings from the trusted preload bridge to Preferences", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(source).toContain(
      "localAiClients={window.koedDesktop?.localAiClients}"
    );
  });
});
