import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.chdir(originalCwd);
  });

  it("applies defaults, global config, project config, then env overrides", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-config-"));
    const homeDir = path.join(tempRoot, "home");
    const projectDir = path.join(tempRoot, "project");
    fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });

    fs.writeFileSync(
      path.join(homeDir, ".pi", "agent", "koed.json"),
      JSON.stringify(
        {
          apiUrl: "http://global.example",
          apiToken: "global-token",
          captureEnabled: false,
          captureToolEvents: true,
          defaultRetrievalScope: "personal+team",
          exposeLowLevelTools: true,
          lcmSummaryEnabled: false
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(projectDir, ".pi", "koed.json"),
      JSON.stringify(
        {
          apiUrl: "http://project.example",
          apiToken: "project-token",
          captureEnabled: true,
          exposeLowLevelTools: false,
          lcmSummaryEnabled: true
        },
        null,
        2
      )
    );

    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("KOED_API_TOKEN", "env-token");
    vi.stubEnv("KOED_CAPTURE_TOOL_EVENTS", "false");
    vi.stubEnv("KOED_EXPOSE_LOW_LEVEL_TOOLS", "true");
    process.chdir(projectDir);

    const config = loadConfig();

    expect(config).toEqual({
      apiUrl: "http://project.example",
      apiToken: "env-token",
      captureEnabled: true,
      captureToolEvents: false,
      defaultRetrievalScope: "personal+team",
      exposeLowLevelTools: true,
      lcmSummaryEnabled: true
    });
  });
});
