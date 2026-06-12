import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

export const setupCodex = (
  environment: NodeJS.ProcessEnv = process.env
): KoedServerSetupCodexResult => {
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
  const repoEnv = loadRepoEnv(paths.repoRoot);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...repoEnv,
    ...environment
  };
  const apiUrl = resolveApiUrl(environment, repoEnv);
  const explorerUrl = resolveExplorerUrl(environment, repoEnv);
  const checkedAt = new Date().toISOString();
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
