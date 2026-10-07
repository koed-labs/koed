import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRepoEnv, parseEnvFile, resolveApiUrl } from "./env-file.js";

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
  it("rejects malformed explicitly supplied environment syntax with source context", () => {
    expect(() =>
      parseEnvFile("TEAM_ENABLED='unterminated", {
        strict: true,
        source: "explicit.env"
      })
    ).toThrow("explicit.env:1: unterminated quoted value for TEAM_ENABLED");
  });

  it("preserves a trailing backslash in strict single-quoted values", () => {
    expect(parseEnvFile("VALUE='C:\\data\\'", { strict: true })).toEqual({
      VALUE: "C:\\data\\"
    });
  });

  it("preserves legacy lenient parsing for unmatched quotes", () => {
    expect(parseEnvFile("VALUE='unfinished")).toEqual({ VALUE: "'unfinished" });
  });

  it("keeps quoted, commented, CRLF, empty and unquoted values", () => {
    expect(
      parseEnvFile(
        "# comment\r\nA=\"quoted value\" # comment\r\nB='also quoted' # comment\r\nEMPTY=\r\nPLAIN=value # tail\r\n",
        {
          strict: true,
          source: "valid.env"
        }
      )
    ).toEqual({
      A: "quoted value",
      B: "also quoted",
      EMPTY: "",
      PLAIN: "value # tail"
    });
  });

  it("rejects non-comment text after a closing quote", () => {
    expect(() =>
      parseEnvFile('VALUE="one" garbage "two"', {
        strict: true,
        source: "broken.env"
      })
    ).toThrow("broken.env:1: unexpected text after quoted value for VALUE");
  });
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

  it("uses the supervisor-owned automatic API port instead of a stale generated URL", () => {
    expect(
      resolveApiUrl(
        {
          KOED_AUTO_PORTS: "1",
          API_HOST_PORT: "3301",
          MEMORY_API_URL: "http://localhost:3300"
        },
        {}
      )
    ).toBe("http://localhost:3301");
  });
});
