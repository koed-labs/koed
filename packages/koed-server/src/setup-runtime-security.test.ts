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

vi.mock("./app-runtime.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./app-runtime.js")>();
  return {
    ...original,
    resolveKoedAppRuntimeExecution: () => "packaged"
  };
});

import { setupClaude } from "./claude-setup.js";
import { setupPi } from "./pi-setup.js";
import { repairCodexIntegration } from "./setup.js";
import { inspectCodex } from "./status.js";
import { ensureKoedHome, resolveKoedServerPaths } from "./paths.js";

const roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(resolve(process.cwd(), ".koed-setup-auth-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("packaged AI Client setup authentication", () => {
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
