import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRepoEnv, resolveApiUrl } from "./env-file.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-env-file-"));
  temps.push(path);
  return path;
};

afterEach(() => {
  delete process.env.KOED_ENV_PATH;
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("repo env loading", () => {
  it("uses KOED_ENV_PATH when set", () => {
    const root = tempDir();
    const envPath = resolve(root, "smoke.env");
    writeFileSync(resolve(root, ".env"), "VALUE=repo\n");
    writeFileSync(envPath, "VALUE=override\n");
    process.env.KOED_ENV_PATH = envPath;

    expect(loadRepoEnv(root)).toEqual({ VALUE: "override" });
  });
});

describe("local URL resolution", () => {
  it("lets one-shot environment port overrides win over repo .env ports and API URLs", () => {
    expect(
      resolveApiUrl(
        { API_HOST_PORT: "4545" },
        { API_HOST_PORT: "3300", MEMORY_API_URL: "http://localhost:3300" }
      )
    ).toBe("http://localhost:4545");
  });
});
