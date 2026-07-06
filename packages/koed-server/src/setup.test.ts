import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repairCodexIntegration, setupCodex } from "./setup.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-server-setup-"));
  temps.push(path);
  return path;
};

const spawnResult = (status = 0, stdout = "ok", stderr = "") =>
  ({ stdout, stderr, status, signal: null, pid: 1, output: [] }) as never;

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Codex setup wrapper", () => {
  it("passes repo env and requested environment to bootstrap", () => {
    const root = tempDir();
    const calls: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];

    const result = setupCodex({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        MEMORY_API_URL: "http://localhost:3999"
      },
      spawnSync: (command, args, options) => {
        calls.push({ command, args, env: options?.env });
        return spawnResult();
      },
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    expect(result.ok).toBe(true);
    expect(result.apiUrl).toBe("http://localhost:3999");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call!.command).toBe(process.execPath);
    expect(call!.args[0]).toBe(resolve(root, "scripts/clients-bootstrap.mjs"));
    expect(call!.env?.KOED_HOME).toBe(root);
    expect(call!.env?.KOED_SERVER_MANAGED).toBe("1");
  });

  it("uses active runtime URLs when setup is run without auto-port environment", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({
        pid: 123,
        startedAt: "2026-01-01T00:00:00.000Z",
        repoRoot: root,
        apiUrl: "http://localhost:43300",
        explorerUrl: "http://localhost:45174",
        services: []
      })
    );
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    const result = setupCodex({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      spawnSync: (_command, _args, options) => {
        calls.push({ env: options?.env });
        return spawnResult();
      },
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    expect(result.ok).toBe(true);
    expect(result.apiUrl).toBe("http://localhost:43300");
    expect(result.explorerUrl).toBe("http://localhost:45174");
    expect(calls[0]?.env?.MEMORY_API_URL).toBe("http://localhost:43300");
  });

  it("returns actionable failure JSON on bootstrap error", () => {
    const root = tempDir();
    const result = setupCodex({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      spawnSync: () => spawnResult(2, "", "bad"),
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    expect(result.ok).toBe(false);
    expect(result.state).toBe("needs_attention");
    expect(result.stderr).toBe("bad");
    expect(result.action).toContain("rerun koed-server setup codex --json");
  });

  it("repairs Codex using the active Desktop API Token", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/explorer-token.json"),
      JSON.stringify({ apiToken: "desktop_token" })
    );
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/package.json"), "{}");
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(root, "packages/mcp-server/dist/capture-hook.js"),
      ""
    );
    const codexConfigPath = resolve(root, "codex.toml");
    const hookConfigPath = resolve(root, "hook.json");

    const result = repairCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_AUTO_PORTS: "1",
        API_HOST_PORT: "43300",
        CODEX_CONFIG_PATH: codexConfigPath,
        MEMORY_HOOK_CONFIG: hookConfigPath
      },
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    expect(result.ok).toBe(true);
    expect(result.apiUrl).toBe("http://localhost:43300");
    expect(result.command).toBe(`write Codex config using ${root}`);
    expect(result.stdout).toContain("Codex integration configured.");
    expect(result.stdout).toContain(
      `Wrote Codex MCP config: ${codexConfigPath}`
    );
    expect(result.stdout).toContain(
      `Wrote Capture Hook config: ${hookConfigPath}`
    );
  });
});
