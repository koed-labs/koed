import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { writeFileSync as nodeWriteFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveActiveIntegrationApiToken,
  resolveLocalApiToken,
  writeExplorerCredential
} from "./credentials.js";
import { loadRepoEnv, resolveApiUrl, resolveExplorerUrl } from "./env-file.js";
import { ensureKoedHome, resolveKoedServerPaths } from "./paths.js";
import { applyPersistedLocalPorts } from "./ports.js";

export interface KoedServerSetupCodexResult {
  ok: boolean;
  state: "healthy" | "needs_attention";
  koedHome: string;
  apiUrl: string;
  explorerUrl: string;
  checkedAt: string;
  command: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  action?: string;
}

type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawnSync>[2]
) => SpawnSyncReturns<string>;

export interface KoedServerSetupOptions {
  environment?: NodeJS.ProcessEnv;
  spawnSync?: SpawnSyncLike;
  writeFileSync?: typeof nodeWriteFileSync;
  now?: () => Date;
}

export interface KoedServerRepairCodexResult {
  ok: boolean;
  state: "healthy" | "needs_attention";
  koedHome: string;
  apiUrl: string;
  checkedAt: string;
  command: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  action?: string;
}

export const repairCodexIntegration = ({
  environment = process.env,
  spawnSync = nodeSpawnSync as SpawnSyncLike,
  now = () => new Date()
}: Omit<
  KoedServerSetupOptions,
  "writeFileSync"
> = {}): KoedServerRepairCodexResult => {
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
  environment = applyPersistedLocalPorts(paths, environment);
  const repoEnv = loadRepoEnv(paths.repoRoot);
  const apiUrl = resolveApiUrl(environment, repoEnv);
  const checkedAt = now().toISOString();
  const apiToken = resolveActiveIntegrationApiToken(
    paths,
    environment,
    repoEnv
  );
  const scriptPath = resolve(paths.repoRoot, "scripts/configure-codex.mjs");
  const command = `node ${scriptPath}`;

  if (!apiToken) {
    return {
      ok: false,
      state: "needs_attention",
      koedHome: paths.koedHome,
      apiUrl,
      checkedAt,
      command,
      error: "No Koed API Token is available for the Codex integration.",
      action:
        "Start Koed Desktop first so it can provision a local Explorer/API Token, then run Fix Codex integration again."
    };
  }

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: paths.repoRoot,
    env: {
      ...process.env,
      ...repoEnv,
      ...environment,
      MEMORY_API_URL: apiUrl,
      MEMORY_API_TOKEN: apiToken.token,
      MEMORY_NODE_COMMAND: environment.MEMORY_NODE_COMMAND ?? "node",
      MEMORY_CODEX_APP_SERVER_BINARY:
        environment.MEMORY_CODEX_APP_SERVER_BINARY ?? "codex"
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    return {
      ok: false,
      state: "needs_attention",
      koedHome: paths.koedHome,
      apiUrl,
      checkedAt,
      command,
      error: result.error.message,
      action:
        "Fix the reported setup failure, then run Fix Codex integration again."
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      state: "needs_attention",
      koedHome: paths.koedHome,
      apiUrl,
      checkedAt,
      command,
      stdout: result.stdout.trim() || undefined,
      stderr: result.stderr.trim() || undefined,
      error: `Codex integration repair failed with exit code ${result.status ?? 1}.`,
      action:
        "Review stdout/stderr, fix the reported failure, then run Fix Codex integration again."
    };
  }

  return {
    ok: true,
    state: "healthy",
    koedHome: paths.koedHome,
    apiUrl,
    checkedAt,
    command,
    stdout: result.stdout.trim() || undefined,
    stderr: result.stderr.trim() || undefined,
    action:
      "Restart Codex and trust updated hooks if prompted. New sessions will be captured after Codex reloads this config."
  };
};

export const setupCodex = ({
  environment = process.env,
  spawnSync = nodeSpawnSync as SpawnSyncLike,
  writeFileSync = nodeWriteFileSync,
  now = () => new Date()
}: KoedServerSetupOptions = {}): KoedServerSetupCodexResult => {
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
  environment = applyPersistedLocalPorts(paths, environment);
  const repoEnv = loadRepoEnv(paths.repoRoot);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...repoEnv,
    ...environment,
    KOED_SERVER_MANAGED: "1"
  };
  const apiUrl = resolveApiUrl(environment, repoEnv);
  const explorerUrl = resolveExplorerUrl(environment, repoEnv);
  const checkedAt = now().toISOString();
  const apiToken = resolveLocalApiToken(environment, repoEnv);
  if (apiToken) {
    writeExplorerCredential(paths, {
      apiToken: apiToken.token,
      provisionedAt: checkedAt,
      source: apiToken.source
    });
  }
  const scriptPath = resolve(paths.repoRoot, "scripts/clients-bootstrap.mjs");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: paths.repoRoot,
    env: childEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const payload: KoedServerSetupCodexResult = result.error
    ? {
        ok: false,
        state: "needs_attention",
        koedHome: paths.koedHome,
        apiUrl,
        explorerUrl,
        checkedAt,
        command: `node ${scriptPath}`,
        error: result.error.message,
        action:
          "Fix the reported setup failure, then rerun koed-server setup codex --json."
      }
    : result.status === 0
      ? {
          ok: true,
          state: "healthy",
          koedHome: paths.koedHome,
          apiUrl,
          explorerUrl,
          checkedAt,
          command: `node ${scriptPath}`,
          stdout: result.stdout.trim() || undefined,
          stderr: result.stderr.trim() || undefined
        }
      : {
          ok: false,
          state: "needs_attention",
          koedHome: paths.koedHome,
          apiUrl,
          explorerUrl,
          checkedAt,
          command: `node ${scriptPath}`,
          stdout: result.stdout.trim() || undefined,
          stderr: result.stderr.trim() || undefined,
          error: `Codex setup failed with exit code ${result.status ?? 1}.`,
          action:
            "Review stdout/stderr, fix the reported setup failure, then rerun koed-server setup codex --json."
        };

  if (payload.ok) {
    const refreshedApiToken = resolveLocalApiToken(
      environment,
      loadRepoEnv(paths.repoRoot)
    );
    if (refreshedApiToken) {
      writeExplorerCredential(paths, {
        apiToken: refreshedApiToken.token,
        provisionedAt: checkedAt,
        source: refreshedApiToken.source
      });
    }
  }

  writeFileSync(
    paths.lastVerificationPath,
    `${JSON.stringify(
      {
        ok: payload.ok,
        checkedAt,
        message: payload.ok ? "Codex setup completed." : payload.error
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  return payload;
};
