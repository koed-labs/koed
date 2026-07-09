import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { isCurrentEntrypoint } from "./node-entrypoint-runner.js";

describe("node entrypoint runner", () => {
  it("recognizes argv paths containing spaces", () => {
    const runnerPath =
      "/Volumes/Koed 0.1.1-arm64/Koed.app/Contents/Resources/app.asar.unpacked/dist-electron/koed-server/node-entrypoint-runner.js";

    expect(
      isCurrentEntrypoint(pathToFileURL(runnerPath).href, runnerPath)
    ).toBe(true);
  });
});
