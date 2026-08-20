import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateKoedOwnedCodexRegistration,
  migrateKoedOwnedCodexRegistrationBestEffort,
  registerExplicitAiClient,
  resolveExecutablePath
} from "./ai-client-registry.js";

const homes: string[] = [];
const home = () => {
  const value = mkdtempSync(resolve(tmpdir(), "koed-registry-"));
  homes.push(value);
  return value;
};

afterEach(() => {
  for (const value of homes.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("AI Client instance registry", () => {
  it("registers resolved PATH executable and preserves existing entries", () => {
    const koedHome = home();
    const registry = resolve(koedHome, "config/ai-client-instances.json");
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      registry,
      JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "other.default",
            driverId: "other",
            displayName: "Other",
            executablePath: "/bin/other"
          }
        ]
      })
    );

    expect(
      registerExplicitAiClient({
        environment: { KOED_HOME: koedHome, PATH: "/bin" },
        driverId: "codex",
        executablePath: "sh",
        displayName: "Codex"
      })
    ).toBe(true);
    const result = JSON.parse(readFileSync(registry, "utf8")) as {
      instances: Array<{ instanceId: string; executablePath: string }>;
    };
    expect(result.instances).toHaveLength(2);
    expect(
      result.instances.find(
        (entry: { instanceId: string }) => entry.instanceId === "codex.default"
      )
    ).toMatchObject({
      executablePath: "/bin/sh"
    });
  });

  it("validates absolute and PATH executable candidates identically", () => {
    const koedHome = home();
    const bin = resolve(koedHome, "bin");
    const executable = resolve(bin, "client");
    const nonExecutable = resolve(bin, "not-executable");
    mkdirSync(bin, { recursive: true });
    writeFileSync(executable, "#!/bin/sh\n");
    writeFileSync(nonExecutable, "not executable\n");
    chmodSync(executable, 0o755);
    chmodSync(nonExecutable, 0o644);

    expect(resolveExecutablePath(executable, { PATH: "" })).toBe(executable);
    expect(resolveExecutablePath("client", { PATH: bin })).toBe(executable);
    expect(() => resolveExecutablePath(nonExecutable, { PATH: "" })).toThrow(
      /not executable/
    );
    expect(() =>
      resolveExecutablePath("not-executable", { PATH: bin })
    ).toThrow(/not executable/);
  });

  it("does not register unrelated detected Codex without Koed marker", () => {
    const koedHome = home();
    const codexHome = resolve(koedHome, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(resolve(codexHome, "config.toml"), "[mcp_servers.other]\n");

    expect(
      migrateKoedOwnedCodexRegistration({
        environment: {
          KOED_HOME: koedHome,
          CODEX_HOME: codexHome,
          MEMORY_CODEX_APP_SERVER_BINARY: "/bin/sh",
          PATH: "/bin"
        }
      })
    ).toBe(false);
    expect(() =>
      readFileSync(resolve(koedHome, "config/ai-client-instances.json"), "utf8")
    ).toThrow();
  });

  it("migrates only Koed-owned Codex marker configuration", () => {
    const koedHome = home();
    const codexHome = resolve(koedHome, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      resolve(codexHome, "config.toml"),
      "# >>> koed\n# <<< koed\n"
    );
    expect(
      migrateKoedOwnedCodexRegistration({
        environment: {
          KOED_HOME: koedHome,
          CODEX_HOME: codexHome,
          MEMORY_CODEX_APP_SERVER_BINARY: "/bin/sh",
          PATH: "/bin"
        }
      })
    ).toBe(true);
    expect(
      readFileSync(resolve(koedHome, "config/ai-client-instances.json"), "utf8")
    ).toContain("codex.default");
  });

  it("adds Codex to mixed registry without changing profile bytes", () => {
    const koedHome = home();
    const codexHome = resolve(koedHome, "codex");
    const registryPath = resolve(koedHome, "config/ai-client-instances.json");
    const profile = '# >>> koed\n# <<< koed\nprofile = "operator"\n';
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      registryPath,
      `${JSON.stringify({
        version: 1,
        instances: [
          {
            instanceId: "claude.default",
            driverId: "claude",
            displayName: "Claude Code",
            executablePath: "/bin/sh",
            configHome: "/tmp/claude"
          }
        ]
      })}\n`
    );
    writeFileSync(resolve(codexHome, "config.toml"), profile);

    expect(
      migrateKoedOwnedCodexRegistration({
        environment: {
          KOED_HOME: koedHome,
          CODEX_HOME: codexHome,
          MEMORY_CODEX_APP_SERVER_BINARY: "/bin/sh",
          PATH: "/bin"
        }
      })
    ).toBe(true);
    expect(readFileSync(resolve(codexHome, "config.toml"), "utf8")).toBe(
      profile
    );
    expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual({
      version: 1,
      instances: [
        {
          instanceId: "claude.default",
          driverId: "claude",
          displayName: "Claude Code",
          executablePath: "/bin/sh",
          configHome: "/tmp/claude"
        },
        {
          instanceId: "codex.default",
          driverId: "codex",
          displayName: "Codex",
          executablePath: "/bin/sh",
          configHome: codexHome
        }
      ]
    });
    expect(
      migrateKoedOwnedCodexRegistration({
        environment: {
          KOED_HOME: koedHome,
          CODEX_HOME: codexHome,
          MEMORY_CODEX_APP_SERVER_BINARY: "/bin/sh",
          PATH: "/bin"
        }
      })
    ).toBe(false);
  });

  it("reports malformed legacy registry without blocking migration caller", () => {
    const koedHome = home();
    const codexHome = resolve(koedHome, "codex");
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(resolve(koedHome, "config/ai-client-instances.json"), "{");
    writeFileSync(
      resolve(codexHome, "config.toml"),
      "# >>> koed\n# <<< koed\n"
    );

    const result = migrateKoedOwnedCodexRegistrationBestEffort({
      environment: {
        KOED_HOME: koedHome,
        CODEX_HOME: codexHome,
        MEMORY_CODEX_APP_SERVER_BINARY: "/bin/sh",
        PATH: "/bin"
      }
    });

    expect(result.migrated).toBe(false);
    expect(result.diagnostic).toContain(
      "AI Client instance registry is malformed"
    );
  });

  it("refuses to overwrite malformed registry", () => {
    const koedHome = home();
    const registry = resolve(koedHome, "config/ai-client-instances.json");
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(registry, "{");
    expect(() =>
      registerExplicitAiClient({
        environment: { KOED_HOME: koedHome, PATH: "/bin" },
        driverId: "codex",
        executablePath: "sh",
        displayName: "Codex"
      })
    ).toThrow(/malformed/);
    expect(readFileSync(registry, "utf8")).toBe("{");
  });
});
