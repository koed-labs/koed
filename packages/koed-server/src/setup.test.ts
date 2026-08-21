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
import {
  removeCodexIntegration,
  repairCodexIntegration,
  setupCodex,
  setupCore
} from "./setup.js";

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
  pid = process.pid,
  automaticPorts = false
): void => {
  mkdirSync(resolve(root, "run"), { recursive: true });
  writeFileSync(
    resolve(root, "run/koed-server.json"),
    JSON.stringify({
      pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      repoRoot: root,
      apiUrl: "http://localhost:43300",
      dependencyMode,
      automaticPorts,
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

const runSetupCodex = (
  options: Parameters<typeof setupCodex>[0]
): ReturnType<typeof setupCodex> =>
  setupCodex({
    resolveRuntime: (paths) =>
      ({
        kind: "source",
        artifactSource: "source-checkout",
        root: paths.repoRoot,
        apiEntry: resolve(paths.repoRoot, "api.js"),
        workerEntry: resolve(paths.repoRoot, "worker.js"),
        embeddingServiceEntry: resolve(paths.repoRoot, "embedding.js"),
        mcpCli: resolve(paths.repoRoot, "mcp.js"),
        localAiRuntime: resolve(paths.repoRoot, "local-ai.js"),
        captureHook: resolve(paths.repoRoot, "capture.js"),
        dbPackageRoot: resolve(paths.repoRoot, "db"),
        missing: []
      }) as never,
    provisionLocalApiToken: async () => ({
      token: "core-token",
      reused: true,
      ownerUserId: "personal-owner"
    }),
    registerAiClient: () => true,
    ...options
  });

const writeMcpRuntimeArtifacts = (
  root: string,
  includeGuidance = true
): void => {
  const dist = resolve(root, "packages/mcp-server/dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(resolve(root, "packages/mcp-server/package.json"), "{}");
  writeFileSync(resolve(dist, "cli.js"), "");
  writeFileSync(resolve(dist, "capture-hook.js"), "");
  if (includeGuidance) {
    mkdirSync(resolve(dist, "prompts"), { recursive: true });
    writeFileSync(
      resolve(dist, "prompts/codex-global-agent-guidance.md"),
      "# Koed Memory\n\nConsult Koed before substantive work.\n"
    );
  }
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Codex setup wrapper", () => {
  it("removes only valid Koed-owned Codex block and preserves unrelated profile", () => {
    const root = tempDir();
    const runtimeRoot = resolve(root, "runtime");
    const codexHome = resolve(root, "codex");
    const mcpCli = resolve(runtimeRoot, "mcp-server/dist/cli.js");
    const captureHook = resolve(runtimeRoot, "mcp-server/dist/capture-hook.js");
    mkdirSync(resolve(runtimeRoot, "mcp-server/dist"), { recursive: true });
    writeFileSync(mcpCli, "");
    writeFileSync(captureHook, "");
    const configPath = resolve(root, "codex/config.toml");
    mkdirSync(codexHome, { recursive: true });
    const hooks = [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
      "SubagentStart",
      "SubagentStop"
    ]
      .map(
        (eventName) => `[[hooks.${eventName}]]\ncommand = "node ${captureHook}"`
      )
      .join("\n");
    const original = `profile = "operator"\n# >>> koed\n[mcp_servers.koed]\ncommand = "node"\nargs = ["${mcpCli}"]\n[mcp_servers.koed.env]\nKOED_HOME = "${root}"\n${hooks}\n# <<< koed\nother = true\n`;
    writeFileSync(configPath, original);
    const userInstructions =
      "# User rules  \nKeep this indentation:\n    exact\n";
    writeFileSync(
      resolve(codexHome, "AGENTS.md"),
      `${userInstructions}\n\n<!-- >>> koed-memory-guidance -->\nmanaged\n<!-- <<< koed-memory-guidance -->\n`,
      { mode: 0o640 }
    );

    const result = removeCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_JS_RUNTIME_ROOT: runtimeRoot,
        CODEX_HOME: codexHome,
        CODEX_CONFIG_PATH: configPath,
        MEMORY_NODE_COMMAND: "node"
      }
    });

    expect(result).toMatchObject({ ok: true, state: "healthy" });
    expect(readFileSync(configPath, "utf8")).toBe(
      'profile = "operator"\nother = true\n'
    );
    expect(readFileSync(resolve(codexHome, "AGENTS.md"), "utf8")).toBe(
      userInstructions
    );
  });

  it("fails Codex removal without mutating malformed or unexpected ownership block", () => {
    const root = tempDir();
    const configPath = resolve(root, "codex/config.toml");
    mkdirSync(resolve(root, "codex"), { recursive: true });
    const original =
      'profile = "operator"\n# >>> koed\n[mcp_servers.other]\n# <<< koed\n';
    writeFileSync(configPath, original);

    const result = removeCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        CODEX_CONFIG_PATH: configPath
      }
    });

    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("provisions core through injectable packaged runtime seam before Codex bootstrap", async () => {
    const root = tempDir();
    const order: string[] = [];
    const result = await setupCodex({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "external",
        DATABASE_URL: "postgres://operator/db",
        API_TOKEN_PEPPER: "pepper"
      },
      resolveRuntime: (paths) => {
        order.push("runtime");
        return {
          kind: "packaged",
          artifactSource: "explicit-override",
          root: paths.repoRoot,
          apiEntry: "api",
          workerEntry: "worker",
          embeddingServiceEntry: "embedding",
          mcpCli: "mcp",
          localAiRuntime: "local-ai",
          captureHook: "capture",
          dbPackageRoot: "db",
          missing: []
        } as never;
      },
      provisionLocalApiToken: async () => {
        order.push("provision");
        return { token: "core", reused: false, ownerUserId: "owner" };
      },
      migrateCodex: () => ({ migrated: false }),
      spawnSync: () => {
        order.push("bootstrap");
        return spawnResult();
      },
      registerAiClient: () => true
    });

    expect(result.ok).toBe(true);
    expect(order).toEqual(["runtime", "provision", "bootstrap"]);
  });

  it("keeps core healthy when legacy Codex migration lacks optional executable", async () => {
    const root = tempDir();
    const codexConfig = resolve(root, "codex/config.toml");
    mkdirSync(resolve(root, "codex"), { recursive: true });
    writeFileSync(codexConfig, "# >>> koed\n# <<< koed\n");
    const result = await setupCore({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "external",
        DATABASE_URL: "postgres://operator/db",
        API_TOKEN_PEPPER: "pepper",
        CODEX_CONFIG_PATH: codexConfig,
        PATH: resolve(root, "missing-bin")
      },
      resolveRuntime: (paths) => ({
        kind: "packaged",
        artifactSource: "explicit-override",
        root: paths.repoRoot,
        apiEntry: "api",
        workerEntry: "worker",
        embeddingServiceEntry: "embedding",
        mcpCli: "mcp",
        localAiRuntime: "local-ai",
        captureHook: "capture",
        dbPackageRoot: "db",
        missing: []
      }),
      provisionLocalApiToken: async () => ({
        token: "core",
        reused: false,
        ownerUserId: "owner"
      })
    });

    expect(result.ok).toBe(true);
    expect(result.stderr).toContain(
      "Skipped legacy Codex registration migration"
    );
  });

  it("migrates existing Koed marker without changing Codex profile bytes", async () => {
    const root = tempDir();
    const codexConfig = resolve(root, "codex/config.toml");
    mkdirSync(resolve(root, "codex"), { recursive: true });
    const profile = '# >>> koed\n# <<< koed\nprofile = "operator"\n';
    writeFileSync(codexConfig, profile);
    const result = await setupCore({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "external",
        DATABASE_URL: "postgres://operator/db",
        API_TOKEN_PEPPER: "pepper",
        CODEX_CONFIG_PATH: codexConfig,
        MEMORY_CODEX_APP_SERVER_BINARY: "/bin/sh",
        PATH: "/bin"
      },
      resolveRuntime: (paths) => ({
        kind: "packaged",
        artifactSource: "explicit-override",
        root: paths.repoRoot,
        apiEntry: "api",
        workerEntry: "worker",
        embeddingServiceEntry: "embedding",
        mcpCli: "mcp",
        localAiRuntime: "local-ai",
        captureHook: "capture",
        dbPackageRoot: "db",
        missing: []
      }),
      provisionLocalApiToken: async () => ({
        token: "core",
        reused: false,
        ownerUserId: "owner"
      })
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(codexConfig, "utf8")).toBe(profile);
    expect(
      readFileSync(resolve(root, "config/ai-client-instances.json"), "utf8")
    ).toContain("codex.default");
  });
  it("passes repo env and requested environment to bootstrap", async () => {
    const root = tempDir();
    const calls: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];

    const result = await runSetupCodex({
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
    expect(call!.env?.KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED).toBe("true");
  });

  it("persists an explicit global memory guidance opt-out", async () => {
    const root = tempDir();
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];

    const result = await runSetupCodex({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED: "false"
      },
      spawnSync: (_command, _args, options) => {
        calls.push(options?.env);
        return spawnResult();
      }
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED).toBe("false");
    expect(
      JSON.parse(readFileSync(resolve(root, "config/server.json"), "utf8"))
    ).toMatchObject({ codexGlobalMemoryGuidanceEnabled: false });
  });

  it("persists the token created by bootstrap and redacts it from JSON output", async () => {
    const root = tempDir();
    writeFileSync(resolve(root, ".env"), "MEMORY_API_TOKEN=old_token\n");

    const result = await runSetupCodex({
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
        readFileSync(resolve(root, "config/local-app-credential.json"), "utf8")
      )
    ).toMatchObject({ apiToken: "new_token", source: "repo-env" });
  });

  it("uses active runtime URLs when setup is run without auto-port environment", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
        repoRoot: root,
        apiUrl: "http://localhost:43300",
        services: []
      })
    );
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    const result = await runSetupCodex({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      spawnSync: (_command, _args, options) => {
        calls.push({ env: options?.env });
        return spawnResult();
      },
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    expect(result.ok).toBe(true);
    expect(result.apiUrl).toBe("http://localhost:43300");
    expect(calls[0]?.env?.MEMORY_API_URL).toBe("http://localhost:43300");
  });

  it("inherits active bundled-local mode and ports without repeated flags", async () => {
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

    await runSetupCodex({
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

  it("uses persisted packaged Postgres password with URL encoding", async () => {
    const root = tempDir();
    writeRuntimeState(root);
    writeLocalPorts(root);
    writeLocalSecrets(root, { POSTGRES_PASSWORD: "pa:ss/@ word%?" });
    writeFileSync(
      resolve(root, ".env"),
      "DATABASE_URL=postgres://stale/stale\nPOSTGRES_PASSWORD=stale-password\n"
    );
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    await runSetupCodex({
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

  it("prefers explicit bundled-local database overrides", async () => {
    const root = tempDir();
    writeRuntimeState(root);
    writeLocalPorts(root);
    writeLocalSecrets(root, { API_TOKEN_PEPPER: "unrelated-pepper" });
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    await runSetupCodex({
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

  it("preserves an explicit DATABASE_URL without reading persisted secrets", async () => {
    const root = tempDir();
    writeRuntimeState(root);
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(resolve(root, "config/local-service-secrets.json"), "{");
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    const result = await runSetupCodex({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "external",
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

  it("keeps explicit external setup isolated from bundled-local state", async () => {
    const root = tempDir();
    writeRuntimeState(root);
    writeLocalPorts(root);
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(resolve(root, "config/local-service-secrets.json"), "{");
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    const result = await runSetupCodex({
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
  ])(
    "fails before bootstrap for persisted secrets with %s",
    async (_case, value) => {
      const root = tempDir();
      writeRuntimeState(root);
      mkdirSync(resolve(root, "config"), { recursive: true });
      writeFileSync(resolve(root, "config/local-service-secrets.json"), value);
      let spawnCalls = 0;

      const result = await runSetupCodex({
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
    }
  );

  it("fails before bootstrap when persisted Postgres password is missing", async () => {
    const root = tempDir();
    writeRuntimeState(root);
    writeLocalSecrets(root, { API_TOKEN_PEPPER: "unrelated-pepper" });
    let spawnCalls = 0;

    const result = await runSetupCodex({
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

  it("does not propagate unrelated persisted service secrets", async () => {
    const root = tempDir();
    writeRuntimeState(root);
    writeLocalSecrets(root, {
      POSTGRES_PASSWORD: "persisted-password",
      API_DATA_ENCRYPTION_KEY: "persisted-encryption-key",
      API_TOKEN_PEPPER: "persisted-token-pepper",
      EMBEDDING_SERVICE_TOKEN: "persisted-embedding-token"
    });
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    await runSetupCodex({
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

  it("ignores structurally invalid persisted runtime state", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({ dependencyMode: "bundled-local" })
    );
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];

    const result = await runSetupCodex({
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

  it("ignores valid bundled-local runtime state when its PID is dead", async () => {
    const root = tempDir();
    writeRuntimeState(root, "bundled-local", 424_242);
    writeLocalPorts(root);
    writeLocalSecrets(root, { POSTGRES_PASSWORD: "old-bundled-password" });
    writeFileSync(
      resolve(root, ".env"),
      [
        "MEMORY_API_URL=https://repo-api.example.test",
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

    const result = await runSetupCodex({
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
    expect(checkedPids).toEqual([424_242, 424_242]);
    expect(result.apiUrl).toBe("https://repo-api.example.test");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env?.DATABASE_URL).toBe("postgres://repository/external");
    expect(calls[0]?.env?.POSTGRES_HOST_PORT).toBe("15432");
    expect(calls[0]?.env?.POSTGRES_PASSWORD).toBe("repository-password");
    expect(calls[0]?.env?.MEMORY_API_URL).toBe("https://repo-api.example.test");
    expect(readFileSync(runtimeStatePath, "utf8")).toBe(staleRuntimeState);
  });

  it("returns actionable failure JSON on bootstrap error", async () => {
    const root = tempDir();
    const result = await runSetupCodex({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      spawnSync: () => spawnResult(2, "", "bad"),
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    expect(result.ok).toBe(false);
    expect(result.state).toBe("needs_attention");
    expect(result.stderr).toBe("bad");
    expect(result.action).toContain("rerun koed-server setup codex --json");
  });

  it("repairs Codex using the active Desktop API Token", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "desktop_token" })
    );
    writeMcpRuntimeArtifacts(root);
    const codexConfigPath = resolve(root, "codex.toml");

    const result = repairCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_AUTO_PORTS: "1",
        API_HOST_PORT: "43300",
        CODEX_CONFIG_PATH: codexConfigPath,
        MEMORY_CODEX_APP_SERVER_BINARY: process.execPath
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
    expect(readFileSync(codexConfigPath, "utf8")).not.toContain("--config");
    expect(readFileSync(codexConfigPath, "utf8")).toContain(
      `\\"--koed-home\\" \\"${root}\\"`
    );
    expect(readFileSync(resolve(root, "AGENTS.md"), "utf8")).toContain(
      "Consult Koed before substantive work."
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

  it("leaves Codex profile untouched when executable is missing", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "desktop_token" })
    );
    writeMcpRuntimeArtifacts(root);
    const codexConfigPath = resolve(root, "codex.toml");
    const profile = '[mcp_servers.other]\ncommand = "other"\n';
    writeFileSync(codexConfigPath, profile);

    const result = repairCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        CODEX_CONFIG_PATH: codexConfigPath,
        MEMORY_CODEX_APP_SERVER_BINARY: resolve(root, "missing-codex"),
        PATH: ""
      },
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("AI Client executable was not found");
    expect(readFileSync(codexConfigPath, "utf8")).toBe(profile);
    expect(() =>
      readFileSync(resolve(root, "config/ai-client-instances.json"), "utf8")
    ).toThrow();
  });

  it("rolls back Codex profile when registry registration fails", () => {
    const root = tempDir();
    const codexHome = resolve(root, "isolated-codex");
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "desktop_token" })
    );
    writeMcpRuntimeArtifacts(root);
    const codexConfigPath = resolve(root, "codex.toml");
    const profile = '[mcp_servers.other]\ncommand = "other"\n';
    writeFileSync(codexConfigPath, profile, { mode: 0o640 });
    mkdirSync(codexHome, { recursive: true });
    const userInstructions = "# Existing User instructions  \n    exact\n";
    writeFileSync(resolve(codexHome, "AGENTS.md"), userInstructions, {
      mode: 0o640
    });

    const result = repairCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        CODEX_HOME: codexHome,
        CODEX_CONFIG_PATH: codexConfigPath,
        MEMORY_CODEX_APP_SERVER_BINARY: "/bin/sh"
      },
      registerAiClient: () => false
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("registration failed");
    expect(readFileSync(codexConfigPath, "utf8")).toBe(profile);
    expect(readFileSync(resolve(codexHome, "AGENTS.md"), "utf8")).toBe(
      userInstructions
    );
  });

  it("writes isolated device configuration beneath CODEX_HOME", async () => {
    const root = tempDir();
    const codexHome = resolve(root, "isolated-codex");
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "desktop_token" })
    );
    writeMcpRuntimeArtifacts(root);

    const result = repairCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_AUTO_PORTS: "1",
        API_HOST_PORT: "43300",
        CODEX_HOME: codexHome,
        MEMORY_CODEX_APP_SERVER_BINARY: process.execPath
      },
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    expect(result.ok).toBe(true);
    expect(
      readFileSync(resolve(codexHome, "config.toml"), "utf8")
    ).not.toContain("MEMORY_API_URL");
    expect(
      readFileSync(resolve(codexHome, "config.toml"), "utf8")
    ).not.toContain("MEMORY_API_TOKEN");
    expect(readFileSync(resolve(codexHome, "config.toml"), "utf8")).toContain(
      `\\"--koed-home\\" \\"${root}\\"`
    );
    expect(readFileSync(resolve(codexHome, "AGENTS.md"), "utf8")).toContain(
      "Consult Koed before substantive work."
    );
  });

  it("repair honors the persisted global memory guidance opt-out", () => {
    const root = tempDir();
    const codexHome = resolve(root, "isolated-codex");
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "desktop_token" })
    );
    writeFileSync(
      resolve(root, "config/server.json"),
      JSON.stringify({ codexGlobalMemoryGuidanceEnabled: false })
    );
    writeMcpRuntimeArtifacts(root, false);
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      resolve(codexHome, "AGENTS.md"),
      "# User rules\n\n<!-- >>> koed-memory-guidance -->\nold\n<!-- <<< koed-memory-guidance -->\n"
    );

    const result = repairCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        CODEX_HOME: codexHome,
        MEMORY_CODEX_APP_SERVER_BINARY: process.execPath
      }
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(resolve(codexHome, "AGENTS.md"), "utf8")).toBe(
      "# User rules"
    );
  });

  it("fails closed without rewriting malformed global instructions", () => {
    const root = tempDir();
    const codexHome = resolve(root, "isolated-codex");
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "desktop_token" })
    );
    writeMcpRuntimeArtifacts(root);
    mkdirSync(codexHome, { recursive: true });
    const malformed =
      "# User rules\n\n<!-- >>> koed-memory-guidance -->\nbroken\n";
    writeFileSync(resolve(codexHome, "AGENTS.md"), malformed);

    const result = repairCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        CODEX_HOME: codexHome,
        MEMORY_CODEX_APP_SERVER_BINARY: process.execPath
      }
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("malformed Koed guidance markers");
    expect(readFileSync(resolve(codexHome, "AGENTS.md"), "utf8")).toBe(
      malformed
    );
    expect(() => readFileSync(resolve(codexHome, "config.toml"))).toThrow();
  });

  it("uses the supervisor credential for an active automatic-port runtime", async () => {
    const root = tempDir();
    const codexHome = resolve(root, "isolated-codex");
    writeRuntimeState(root, "bundled-local", process.pid, true);
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "desktop_token" })
    );
    writeFileSync(resolve(root, ".env"), "MEMORY_API_TOKEN=repo_token\n");
    writeMcpRuntimeArtifacts(root);

    const result = repairCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        CODEX_HOME: codexHome,
        MEMORY_API_URL: "http://localhost:3300",
        KOED_AUTO_PORTS: "0",
        MEMORY_CODEX_APP_SERVER_BINARY: process.execPath
      },
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    expect(result.ok).toBe(true);
    expect(
      readFileSync(resolve(codexHome, "config.toml"), "utf8")
    ).not.toContain("MEMORY_API_TOKEN");
    expect(
      readFileSync(resolve(codexHome, "config.toml"), "utf8")
    ).not.toContain("MEMORY_API_URL");
    expect(
      readFileSync(resolve(codexHome, "config.toml"), "utf8")
    ).not.toContain("repo_token");
  });

  it("repairs Codex using current configuration when runtime state is stale", async () => {
    const root = tempDir();
    writeRuntimeState(root, "bundled-local", 424_242);
    writeFileSync(
      resolve(root, ".env"),
      "MEMORY_API_URL=https://external.example.test\n"
    );
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "desktop_token" })
    );
    writeMcpRuntimeArtifacts(root);
    const codexConfigPath = resolve(root, "codex.toml");
    const checkedPids: number[] = [];

    const result = repairCodexIntegration({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        CODEX_CONFIG_PATH: codexConfigPath,
        MEMORY_CODEX_APP_SERVER_BINARY: process.execPath
      },
      checkPid: (pid) => {
        checkedPids.push(pid);
        return false;
      }
    });

    expect(result.ok).toBe(true);
    expect(checkedPids).toEqual([424_242]);
    expect(result.apiUrl).toBe("https://external.example.test");
    expect(readFileSync(codexConfigPath, "utf8")).not.toContain(
      "MEMORY_API_URL"
    );
    expect(readFileSync(codexConfigPath, "utf8")).not.toContain(
      "http://localhost:43300"
    );
  });
});
