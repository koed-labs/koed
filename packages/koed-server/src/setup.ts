import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { writeFileSync as nodeWriteFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveLocalApiToken,
  writeExplorerCredential
} from "./credentials.js";
import { loadRepoEnv, resolveApiUrl, resolveExplorerUrl } from "./env-file.js";
import { ensureKoedHome, resolveKoedServerPaths } from "./paths.js";

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

export const setupCodex = ({
  environment = process.env,
  spawnSync = nodeSpawnSync as SpawnSyncLike,
  writeFileSync = nodeWriteFileSync,
  now = () => new Date()
}: KoedServerSetupOptions = {}): KoedServerSetupCodexResult => {
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
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
