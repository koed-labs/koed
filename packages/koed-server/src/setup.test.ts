import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
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

const writeRuntimeState = (
  root: string,
  dependencyMode: "bundled-local" | "external" = "bundled-local",
  pid = process.pid
): void => {
  mkdirSync(resolve(root, "run"), { recursive: true });
  writeFileSync(
    resolve(root, "run/koed-server.json"),
    JSON.stringify({
      pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      repoRoot: root,
      apiUrl: "http://localhost:43300",
      explorerUrl: "http://localhost:45174",
      dependencyMode,
      services: []
    })
  );
};

const writeLocalPorts = (root: string, postgres = "45432"): void => {
  mkdirSync(resolve(root, "config"), { recursive: true });
  writeFileSync(
    resolve(root, "config/local-ports.json"),
    JSON.stringify({ postgres })
  );
};

const writeLocalSecrets = (
  root: string,
  secrets: Record<string, unknown>
): void => {
  mkdirSync(resolve(root, "config"), { recursive: true });
  writeFileSync(
    resolve(root, "config/local-service-secrets.json"),
    JSON.stringify(secrets)
  );
};

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

  it("persists the token created by bootstrap and redacts it from JSON output", () => {
    const root = tempDir();
    writeFileSync(resolve(root, ".env"), "MEMORY_API_TOKEN=old_token\n");

    const result = setupCodex({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "external",
        DATABASE_URL: "postgres://operator/db",
        EMBEDDING_SERVICE_URL: "http://operator:8000",
        MEMORY_API_TOKEN: "old_token"
      },
      spawnSync: () => {
        writeFileSync(resolve(root, ".env"), "MEMORY_API_TOKEN=new_token\n");
        return spawnResult(0, "Created token.\nToken: new_token\nDone.");
      }
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Token: <redacted>");
    expect(result.stdout).not.toContain("new_token");
    expect(
      JSON.parse(
        readFileSync(resolve(root, "config/explorer-token.json"), "utf8")
      )
    ).toMatchObject({ apiToken: "new_token", source: "repo-env" });
  });

  it("uses active runtime URLs when setup is run without auto-port environment", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({
        pid: process.pid,
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

  it("inherits active bundled-local mode and ports without repeated flags", () => {
    const root = tempDir();
    writeRuntimeState(root);
    writeLocalPorts(root);
    writeFileSync(
      resolve(root, ".env"),
      [
        "DATABASE_URL=postgres://external:external@localhost:15432/koed",
        "POSTGRES_HOST_PORT=15432",
        "POSTGRES_PASSWORD=developer-password"
      ].join("\n")
    );
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    setupCodex({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      spawnSync: (_command, _args, options) => {
        calls.push({ env: options?.env });
        return spawnResult();
      }
    });

    expect(calls[0]?.env?.KOED_DEPENDENCY_MODE).toBe("bundled-local");
    expect(calls[0]?.env?.POSTGRES_HOST_PORT).toBe("45432");
    expect(calls[0]?.env?.DATABASE_URL).toBe(
      "postgres://koed:developer-password@127.0.0.1:45432/koed"
    );
  });

  it("uses persisted packaged Postgres password with URL encoding", () => {
    const root = tempDir();
    writeRuntimeState(root);
    writeLocalPorts(root);
    writeLocalSecrets(root, { POSTGRES_PASSWORD: "pa:ss/@ word%?" });
    writeFileSync(
      resolve(root, ".env"),
      "DATABASE_URL=postgres://stale/stale\nPOSTGRES_PASSWORD=stale-password\n"
    );
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    setupCodex({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      spawnSync: (_command, _args, options) => {
        calls.push({ env: options?.env });
        return spawnResult();
      }
    });

    expect(calls[0]?.env?.POSTGRES_PASSWORD).toBe("pa:ss/@ word%?");
    expect(calls[0]?.env?.DATABASE_URL).toBe(
      "postgres://koed:pa%3Ass%2F%40%20word%25%3F@127.0.0.1:45432/koed"
    );
  });

  it("prefers explicit bundled-local database overrides", () => {
    const root = tempDir();
    writeRuntimeState(root);
    writeLocalPorts(root);
    writeLocalSecrets(root, { API_TOKEN_PEPPER: "unrelated-pepper" });
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    setupCodex({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        POSTGRES_HOST_PORT: "55432",
        POSTGRES_PASSWORD: "explicit:p@ss"
      },
      spawnSync: (_command, _args, options) => {
        calls.push({ env: options?.env });
        return spawnResult();
      }
    });

    expect(calls[0]?.env?.DATABASE_URL).toBe(
      "postgres://koed:explicit%3Ap%40ss@127.0.0.1:55432/koed"
    );
  });

  it("preserves an explicit DATABASE_URL without reading persisted secrets", () => {
    const root = tempDir();
    writeRuntimeState(root);
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(resolve(root, "config/local-service-secrets.json"), "{");
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    const result = setupCodex({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        DATABASE_URL: "postgres://operator/explicit"
      },
      spawnSync: (_command, _args, options) => {
        calls.push({ env: options?.env });
        return spawnResult();
      }
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.env?.DATABASE_URL).toBe("postgres://operator/explicit");
  });

  it("keeps explicit external setup isolated from bundled-local state", () => {
    const root = tempDir();
    writeRuntimeState(root);
    writeLocalPorts(root);
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(resolve(root, "config/local-service-secrets.json"), "{");
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    const result = setupCodex({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "external",
        DATABASE_URL: "postgres://operator/external"
      },
      spawnSync: (_command, _args, options) => {
        calls.push({ env: options?.env });
        return spawnResult();
      }
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.env?.KOED_DEPENDENCY_MODE).toBe("external");
    expect(calls[0]?.env?.DATABASE_URL).toBe("postgres://operator/external");
    expect(calls[0]?.env?.POSTGRES_HOST_PORT).toBeUndefined();
  });

  it.each([
    ["invalid JSON", "{"],
    ["invalid secret shape", JSON.stringify({ POSTGRES_PASSWORD: 42 })]
  ])("fails before bootstrap for persisted secrets with %s", (_case, value) => {
    const root = tempDir();
    writeRuntimeState(root);
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(resolve(root, "config/local-service-secrets.json"), value);
    let spawnCalls = 0;

    const result = setupCodex({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      spawnSync: () => {
        spawnCalls += 1;
        return spawnResult();
      }
    });

    expect(result.ok).toBe(false);
    expect(result.state).toBe("needs_attention");
    expect(result.error).toContain("local-service-secrets.json");
    expect(result.error).toContain("malformed");
    expect(result.action).toContain("restart packaged Koed Desktop");
    expect(spawnCalls).toBe(0);
  });

  it("fails before bootstrap when persisted Postgres password is missing", () => {
    const root = tempDir();
    writeRuntimeState(root);
    writeLocalSecrets(root, { API_TOKEN_PEPPER: "unrelated-pepper" });
    let spawnCalls = 0;

    const result = setupCodex({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      spawnSync: () => {
        spawnCalls += 1;
        return spawnResult();
      }
    });

    expect(result.ok).toBe(false);
    expect(result.state).toBe("needs_attention");
    expect(result.error).toContain("missing required POSTGRES_PASSWORD");
    expect(result.action).toContain("local-service-secrets.json");
    expect(spawnCalls).toBe(0);
  });

  it("does not propagate unrelated persisted service secrets", () => {
    const root = tempDir();
    writeRuntimeState(root);
    writeLocalSecrets(root, {
      POSTGRES_PASSWORD: "persisted-password",
      API_DATA_ENCRYPTION_KEY: "persisted-encryption-key",
      API_TOKEN_PEPPER: "persisted-token-pepper",
      EMBEDDING_SERVICE_TOKEN: "persisted-embedding-token"
    });
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    setupCodex({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      spawnSync: (_command, _args, options) => {
        calls.push({ env: options?.env });
        return spawnResult();
      }
    });

    expect(calls[0]?.env?.POSTGRES_PASSWORD).toBe("persisted-password");
    expect(calls[0]?.env?.API_DATA_ENCRYPTION_KEY).not.toBe(
      "persisted-encryption-key"
    );
    expect(calls[0]?.env?.API_TOKEN_PEPPER).not.toBe("persisted-token-pepper");
    expect(calls[0]?.env?.EMBEDDING_SERVICE_TOKEN).not.toBe(
      "persisted-embedding-token"
    );
  });

  it("ignores structurally invalid persisted runtime state", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({ dependencyMode: "bundled-local" })
    );
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    const result = setupCodex({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        DATABASE_URL: "postgres://operator/external"
      },
      spawnSync: (_command, _args, options) => {
        calls.push({ env: options?.env });
        return spawnResult();
      }
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.env?.KOED_DEPENDENCY_MODE).toBeUndefined();
    expect(calls[0]?.env?.DATABASE_URL).toBe("postgres://operator/external");
  });

  it("ignores valid bundled-local runtime state when its PID is dead", () => {
    const root = tempDir();
    writeRuntimeState(root, "bundled-local", 424_242);
    writeLocalPorts(root);
    writeLocalSecrets(root, { POSTGRES_PASSWORD: "old-bundled-password" });
    writeFileSync(
      resolve(root, ".env"),
      [
        "MEMORY_API_URL=https://repo-api.example.test",
        "EXPLORER_WEB_HOST_PORT=15174",
        "DATABASE_URL=postgres://repository/external",
        "POSTGRES_HOST_PORT=15432",
        "POSTGRES_PASSWORD=repository-password"
      ].join("\n")
    );
    writeFileSync(
      resolve(root, "config/server.json"),
      JSON.stringify({ runtimeMode: "external", dependencyMode: "external" })
    );
    const runtimeStatePath = resolve(root, "run/koed-server.json");
    const staleRuntimeState = readFileSync(runtimeStatePath, "utf8");
    const checkedPids: number[] = [];
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    const result = setupCodex({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      checkPid: (pid) => {
        checkedPids.push(pid);
        return false;
      },
      spawnSync: (_command, _args, options) => {
        calls.push({ env: options?.env });
        return spawnResult();
      }
    });

    expect(result.ok).toBe(true);
    expect(checkedPids).toEqual([424_242]);
    expect(result.apiUrl).toBe("https://repo-api.example.test");
    expect(result.explorerUrl).toBe("http://localhost:15174");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env?.DATABASE_URL).toBe("postgres://repository/external");
    expect(calls[0]?.env?.POSTGRES_HOST_PORT).toBe("15432");
    expect(calls[0]?.env?.POSTGRES_PASSWORD).toBe("repository-password");
    expect(calls[0]?.env?.MEMORY_API_URL).toBe("https://repo-api.example.test");
    expect(readFileSync(runtimeStatePath, "utf8")).toBe(staleRuntimeState);
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
    expect(
      JSON.parse(
        readFileSync(resolve(root, "run/last-verification.json"), "utf8")
      )
    ).toMatchObject({
      ok: true,
      checkedAt: "2026-01-01T00:00:00.000Z"
    });
  });

  it("repairs Codex using current configuration when runtime state is stale", () => {
    const root = tempDir();
    writeRuntimeState(root, "bundled-local", 424_242);
    writeFileSync(
      resolve(root, ".env"),
      "MEMORY_API_URL=https://external.example.test\n"
    );
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
    const checkedPids: number[] = [];

    const result = repairCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        CODEX_CONFIG_PATH: codexConfigPath,
        MEMORY_HOOK_CONFIG: hookConfigPath
      },
      checkPid: (pid) => {
        checkedPids.push(pid);
        return false;
      }
    });

    expect(result.ok).toBe(true);
    expect(checkedPids).toEqual([424_242]);
    expect(result.apiUrl).toBe("https://external.example.test");
    expect(JSON.parse(readFileSync(hookConfigPath, "utf8"))).toMatchObject({
      apiUrl: "https://external.example.test"
    });
    expect(readFileSync(codexConfigPath, "utf8")).toContain(
      'MEMORY_API_URL = "https://external.example.test"'
    );
    expect(readFileSync(codexConfigPath, "utf8")).not.toContain(
      "http://localhost:43300"
    );
  });
});
