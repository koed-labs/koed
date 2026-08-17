import { spawnSync as nodeSpawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveKoedServerPaths } from "./paths.js";

export interface KoedServerSetupPiResult {
  ok: boolean;
  state: "healthy" | "needs_attention";
  command: string;
  koedHome: string;
  checkedAt: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  action?: string;
}

export const setupPi = (
  environment: NodeJS.ProcessEnv = process.env,
  spawnSync: typeof nodeSpawnSync = nodeSpawnSync
): KoedServerSetupPiResult => {
  const paths = resolveKoedServerPaths(environment);
  const sourceCandidates = [
    resolve(paths.repoRoot, "packages/mcp-server/integrations/pi"),
    resolve(paths.repoRoot, "koed-runtime/mcp-server/integrations/pi"),
    resolve(paths.repoRoot, "mcp-server/integrations/pi")
  ];
  const source = sourceCandidates.find(existsSync);
  const target = resolve(paths.koedHome, "integrations/pi");
  const executable = environment.KOED_PI_EXECUTABLE?.trim() || "pi";
  const checkedAt = new Date().toISOString();
  if (!source) {
    return {
      ok: false,
      state: "needs_attention",
      command: `${executable} install ${target}`,
      koedHome: paths.koedHome,
      checkedAt,
      error: "Koed Pi integration package is missing from this installation.",
      action:
        "Repair Koed installation, then rerun koed-server setup pi --json."
    };
  }
  try {
    const version = spawnSync(executable, ["--version"], {
      env: environment,
      encoding: "utf8"
    });
    const parsed = version.stdout
      ?.trim()
      .match(/^(\d+)\.(\d+)\.(\d+)/)
      ?.slice(1)
      .map(Number);
    if (
      version.status !== 0 ||
      !parsed ||
      parsed[0]! < 0 ||
      (parsed[0] === 0 &&
        (parsed[1]! < 84 || (parsed[1] === 84 && parsed[2]! < 2)))
    ) {
      throw new Error(
        `Pi ${version.stdout?.trim() || "version"} is unsupported. Koed requires Pi 0.84.2 or newer.`
      );
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
    const result = spawnSync(executable, ["install", target], {
      env: { ...environment, KOED_HOME: paths.koedHome },
      encoding: "utf8"
    });
    const ok = !result.error && result.status === 0;
    return {
      ok,
      state: ok ? "healthy" : "needs_attention",
      command: `${executable} install ${target}`,
      koedHome: paths.koedHome,
      checkedAt,
      ...(result.stdout ? { stdout: result.stdout.trim() } : {}),
      ...(result.stderr ? { stderr: result.stderr.trim() } : {}),
      ...(!ok
        ? {
            error:
              result.error?.message ??
              result.stderr?.trim() ??
              `Pi setup failed with exit code ${result.status ?? 1}.`,
            action:
              "Install and authenticate supported Pi, then rerun koed-server setup pi --json."
          }
        : {})
    };
  } catch (error) {
    return {
      ok: false,
      state: "needs_attention",
      command: `${executable} install ${target}`,
      koedHome: paths.koedHome,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
      action:
        "Fix Koed Pi package permissions, then rerun koed-server setup pi --json."
    };
  }
};
