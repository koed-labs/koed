import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const fixtureTrust = vi.hoisted(() => ({
  runtime: null,
  keys: new Map<string, string>()
}));

vi.mock("./component-runtime-identity.js", () => ({
  discoverActualRuntimeIdentity: () => {
    if (!fixtureTrust.runtime) throw new Error("fixture runtime missing");
    return fixtureTrust.runtime;
  }
}));
vi.mock("./component-trust-roots.js", () => ({
  productionComponentTrustRoots: fixtureTrust.keys
}));
vi.mock("./app-runtime.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./app-runtime.js")>();
  return {
    ...original,
    resolveKoedAppRuntimeExecution: () => "packaged"
  };
});

import { setupClaude } from "./claude-setup.js";
import { setupPi } from "./pi-setup.js";
import { repairCodexIntegration, setupCodex } from "./setup.js";
import { resolveKoedControlPlaneVersion } from "./app-runtime.js";
import { stageSignedSetupRuntime } from "./setup-runtime-test-fixtures.js";
import { inspectCodex } from "./status.js";
import { ensureKoedHome, resolveKoedServerPaths } from "./paths.js";

const roots: string[] = [];
const fixtureDisposers: (() => void)[] = [];
const initialCwd = process.cwd();
const makeRoot = () => {
  const root = mkdtempSync(resolve(process.cwd(), ".koed-setup-auth-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  process.chdir(initialCwd);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  for (const dispose of fixtureDisposers.splice(0)) dispose();
  fixtureTrust.runtime = null;
  fixtureTrust.keys.clear();
  vi.restoreAllMocks();
});

describe("packaged AI Client setup authentication", () => {
  const activateFixture = async (root: string) => {
    const paths = resolveKoedServerPaths({ KOED_HOME: root });
    const fixture = await stageSignedSetupRuntime(
      paths,
      resolveKoedControlPlaneVersion(),
      (trustedFixture) => {
        fixtureTrust.runtime = trustedFixture.input.runtime;
        for (const [keyId, key] of trustedFixture.input.trustedKeys)
          fixtureTrust.keys.set(keyId, key);
      }
    );
    fixtureDisposers.push(fixture.dispose);
    return paths;
  };

  it("repairs Codex using signed-selected MCP artifacts instead of CWD decoys", async () => {
    const root = makeRoot();
    const home = resolve(root, "home");
    const paths = await activateFixture(home);
    ensureKoedHome(paths);
    const decoy = resolve(root, "packages/mcp-server/dist/cli.js");
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(decoy, "untrusted");
    process.chdir(root);
    const configPath = resolve(home, "codex.toml");
    const result = await repairCodexIntegration({
      environment: {
        HOME: home,
        KOED_HOME: home,
        CODEX_CONFIG_PATH: configPath,
        MEMORY_API_TOKEN: "fixture-token"
      },
      resolveCodexExecutable: () => "codex",
      registerAiClient: () => ({ ok: true, state: "healthy" })
    });

    expect(result).toMatchObject({ ok: true });
    expect(readFileSync(configPath, "utf8")).toContain(
      resolve(paths.koedHome, "runtime/components/base")
    );
    expect(readFileSync(configPath, "utf8")).not.toContain(decoy);
  });

  it("runs Codex setup and diagnostics against signed-selected paths, not CWD decoys", async () => {
    const root = makeRoot();
    const home = resolve(root, "home");
    const paths = await activateFixture(home);
    const decoy = resolve(root, "packages/mcp-server/dist/cli.js");
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(decoy, "untrusted");
    process.chdir(root);
    const environment = {
      HOME: home,
      KOED_HOME: home,
      CODEX_CONFIG_PATH: resolve(home, "codex.toml"),
      MEMORY_API_TOKEN: "fixture-token",
      API_TOKEN_PEPPER: "fixture-pepper"
    };
    const result = await setupCodex({
      environment,
      provisionLocalApiToken: async () => ({
        token: "fixture-token",
        reused: true,
        ownerUserId: "fixture-owner"
      }),
      migrateCodex: () => ({}),
      registerAiClient: () => true,
      resolveCodexExecutable: () => "codex"
    });
    expect(result.ok).toBe(true);

    const diagnostic = await inspectCodex(
      environment,
      paths,
      {
        fetch: globalThis.fetch.bind(globalThis),
        spawnSync: () => ({ stdout: "codex-cli 1.0", stderr: "", status: 0 }),
        existsSync,
        readFileSync,
        resolvePiExecutable: () => process.execPath,
        resolveClaudeExecutable: () => process.execPath,
        resolveCodexExecutable: () => process.execPath,
        checkPid: () => true,
        now: () => new Date()
      },
      true
    );

    expect(diagnostic.configured).toBe(true);
    expect(diagnostic.message).toContain("integration is configured");
    expect(diagnostic.details?.mcpAdapter).toContain(
      resolve(paths.koedHome, "runtime/components/base")
    );
    expect(diagnostic.details?.mcpAdapter).not.toBe(decoy);
  });

  it("sets up Claude from signed-selected integration artifacts despite CWD decoys", async () => {
    const root = makeRoot();
    const home = resolve(root, "home");
    const paths = await activateFixture(home);
    const decoy = resolve(root, "packages/mcp-server/dist/cli.js");
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(decoy, "untrusted");
    process.chdir(root);
    const spawn = vi.fn((_command: string, args: string[]) => ({
      status: args[0] === "mcp" && args[1] === "get" ? 1 : 0,
      stdout: args[0] === "--version" ? "2.1.227" : "{}",
      stderr: ""
    }));

    const result = await setupClaude({ HOME: home, KOED_HOME: home }, spawn);

    expect(result).toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalled();
    expect(
      readFileSync(resolve(home, ".claude/settings.json"), "utf8")
    ).toContain(resolve(paths.koedHome, "runtime/components/base"));
    expect(
      readFileSync(resolve(home, ".claude/settings.json"), "utf8")
    ).not.toContain(decoy);
  });

  it("installs Pi integration from signed-selected runtime despite CWD decoys", async () => {
    const root = makeRoot();
    const home = resolve(root, "home");
    const paths = await activateFixture(home);
    const decoy = resolve(root, "packages/mcp-server/integrations/pi");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(resolve(decoy, "untrusted.mjs"), "untrusted");
    process.chdir(root);
    let installedTarget = "";
    const spawn = vi.fn((_command: string, args: string[]) => {
      const action = args.find((argument) =>
        ["--version", "--list-models", "install", "list"].includes(argument)
      );
      if (action === "install")
        installedTarget = args[args.indexOf(action) + 1] ?? "";
      return {
        status: 0,
        stdout:
          action === "--version"
            ? "0.84.2"
            : action === "--list-models"
              ? "[]"
              : action === "list"
                ? installedTarget
                : "installed",
        stderr: ""
      };
    });

    const result = await setupPi({ HOME: home, KOED_HOME: home }, spawn);

    expect(result).toMatchObject({ ok: true });
    expect(
      readFileSync(resolve(home, "integrations/pi/package.json"), "utf8")
    ).toContain("@koed/pi-integration");
    expect(existsSync(resolve(home, "integrations/pi/untrusted.mjs"))).toBe(
      false
    );
    expect(
      existsSync(resolve(home, "integrations/pi/extensions/koed.mjs"))
    ).toBe(true);
    expect(spawn).toHaveBeenCalled();
    expect(paths.koedHome).toBe(home);
  });
  it("rejects Claude setup before executable spawn or MCP registration without signed selection", async () => {
    const root = makeRoot();
    ensureKoedHome(resolveKoedServerPaths({ KOED_HOME: root }));
    const decoy = resolve(root, "mcp-server/dist");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(resolve(decoy, "cli.js"), "untrusted");
    writeFileSync(resolve(decoy, "capture-hook.js"), "untrusted");
    const spawn = vi.fn(() => ({ status: 0, stdout: "2.1.227", stderr: "" }));

    await expect(
      setupClaude(
        {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          KOED_PACKAGED_RESOURCES_PATH: root,
          HOME: root
        },
        spawn as never
      )
    ).rejects.toThrow(/authenticated|generation/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects direct Codex repair before configuration writes without signed selection", async () => {
    const root = makeRoot();
    ensureKoedHome(resolveKoedServerPaths({ KOED_HOME: root }));
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "test-token" })
    );
    const configPath = resolve(root, "config.toml");
    await expect(
      repairCodexIntegration({
        environment: {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          KOED_PACKAGED_RESOURCES_PATH: root,
          CODEX_CONFIG_PATH: configPath
        }
      })
    ).rejects.toThrow(/authenticated|generation/i);
    expect(existsSync(configPath)).toBe(false);
  });

  it("reports missing authenticated generation instead of trusting CWD Codex paths", async () => {
    const root = makeRoot();
    const paths = resolveKoedServerPaths({ KOED_HOME: root, HOME: root });
    const decoyCli = resolve(root, "mcp-server/dist/cli.js");
    mkdirSync(resolve(root, "mcp-server/dist"), { recursive: true });
    writeFileSync(decoyCli, "untrusted");
    const codexConfig = resolve(root, "codex.toml");
    writeFileSync(
      codexConfig,
      `# >>> koed\n[mcp_servers.koed]\ncommand = "node"\nargs = ["${decoyCli}"]\n[mcp_servers.koed.env]\nKOED_HOME = "${root}"\n# <<< koed\n`
    );
    const status = await inspectCodex(
      { HOME: root, KOED_HOME: root, CODEX_CONFIG_PATH: codexConfig },
      paths,
      {
        fetch: globalThis.fetch.bind(globalThis),
        spawnSync: (() => ({
          stdout: "codex-cli 1.0",
          stderr: "",
          status: 0
        })) as never,
        existsSync,
        readFileSync,
        resolvePiExecutable: () => process.execPath,
        resolveClaudeExecutable: () => process.execPath,
        resolveCodexExecutable: () => process.execPath,
        checkPid: () => true,
        now: () => new Date()
      },
      true
    );

    expect(status.state).toBe("not_configured");
    expect(status.message).toContain(
      "authenticated Koed app-runtime generation"
    );
    expect(status.action).toContain("signed Koed app-runtime generation");
  });

  it("rejects Pi setup before CWD candidate copy, install, or spawn without signed selection", async () => {
    const root = makeRoot();
    ensureKoedHome(
      resolveKoedServerPaths({ KOED_HOME: resolve(root, "koed") })
    );
    const decoy = resolve(root, "packages/mcp-server/integrations/pi");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(resolve(decoy, "untrusted.mjs"), "untrusted");
    const spawn = vi.fn();

    await expect(
      setupPi(
        {
          KOED_HOME: resolve(root, "koed"),
          KOED_REPO_ROOT: root,
          KOED_PACKAGED_RESOURCES_PATH: root,
          HOME: root
        },
        spawn as never
      )
    ).rejects.toThrow(/authenticated|generation/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(
      existsSync(resolve(root, "koed/integrations/pi/untrusted.mjs"))
    ).toBe(false);
  });
});
