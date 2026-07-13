import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectLocalPostgresRuntimeStatus,
  localPostgresEnv,
  resolveBundledPostgresMode,
  resolveLocalPostgresRuntimePaths,
  startLocalPostgresRuntime
} from "./local-postgres-runtime.js";
import type { KoedServerPaths } from "./paths.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-local-postgres-"));
  temps.push(path);
  return path;
};

const paths = (root: string): KoedServerPaths => ({
  koedHome: root,
  configDir: resolve(root, "config"),
  logsDir: resolve(root, "logs"),
  runDir: resolve(root, "run"),
  dataDir: resolve(root, "data"),
  modelsDir: resolve(root, "models"),
  cacheDir: resolve(root, "cache"),
  postgresDataDir: resolve(root, "data", "postgres"),
  postgresRunDir: resolve(root, "run", "postgres"),
  postgresLogPath: resolve(root, "logs", "postgres.log"),
  runtimeStatePath: resolve(root, "run", "koed-server.json"),
  lastVerificationPath: resolve(root, "run", "last-verification.json"),
  serverConfigPath: resolve(root, "config", "server.json"),
  localPortsPath: resolve(root, "config", "local-ports.json"),
  explorerTokenPath: resolve(root, "config", "explorer-token.json"),
  upstreamBackendsPath: resolve(root, "config", "upstream-backends.json"),
  projectMetadataPath: resolve(root, "config", "projects.json"),
  projectTeamWorkspaceLinksPath: resolve(
    root,
    "config",
    "project-team-workspaces.json"
  ),
  upstreamEnrollmentsPath: resolve(root, "run", "upstream-enrollments.json"),
  repoRoot: root
});

const spawnResult = (status = 0, stderr = "") =>
  ({ stdout: "", stderr, status, signal: null, pid: 1, output: [] }) as never;

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("local Postgres runtime", () => {
  it("resolves bundled paths and local DATABASE_URL", () => {
    const root = tempDir();
    const runtime = resolveLocalPostgresRuntimePaths(paths(root), {
      KOED_POSTGRES_BIN_DIR: resolve(root, "bin"),
      POSTGRES_HOST_PORT: "15433",
      POSTGRES_PASSWORD: "secret"
    });

    expect(runtime.pgCtlBin).toBe(resolve(root, "bin", "pg_ctl"));
    expect(runtime.dataDir).toBe(resolve(root, "data", "postgres"));
    expect(localPostgresEnv(runtime).DATABASE_URL).toBe(
      "postgres://koed:secret@127.0.0.1:15433/koed"
    );
  });

  it("resolves bundled-local Postgres to native-only mode", () => {
    const root = tempDir();
    expect(resolveBundledPostgresMode(paths(root), {}, () => false)).toBe(
      "native"
    );
    expect(
      resolveBundledPostgresMode(
        paths(root),
        { KOED_BUNDLED_POSTGRES_MODE: "compose" },
        () => false
      )
    ).toBe("native");
  });

  it("prefers packaged Postgres resources over source checkout in packaged mode", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "koed-runtime", "postgres", "bin"), {
      recursive: true
    });
    mkdirSync(resolve(root, "vendor", "postgres", "bin"), {
      recursive: true
    });
    for (const entry of ["initdb", "pg_ctl", "psql"]) {
      writeFileSync(
        resolve(root, "koed-runtime", "postgres", "bin", entry),
        ""
      );
      writeFileSync(resolve(root, "vendor", "postgres", "bin", entry), "");
    }

    const runtime = resolveLocalPostgresRuntimePaths(paths(root), {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(runtime.artifactSource).toBe("packaged-resource");
    expect(runtime.pgCtlBin).toBe(
      resolve(root, "koed-runtime", "postgres", "bin", "pg_ctl")
    );
  });

  it("rejects source checkout Postgres fallback in packaged mode", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "vendor", "postgres", "bin"), {
      recursive: true
    });
    for (const entry of ["initdb", "pg_ctl", "psql"]) {
      writeFileSync(resolve(root, "vendor", "postgres", "bin", entry), "");
    }

    const runtime = resolveLocalPostgresRuntimePaths(paths(root), {
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root
    });

    expect(runtime.artifactSource).toBe("koed-home-runtime");
    expect(runtime.pgCtlBin).toBe(
      resolve(root, "runtime", "postgres", "bin", "pg_ctl")
    );
  });

  it("reports missing native binaries with an actionable status", () => {
    const root = tempDir();
    const status = collectLocalPostgresRuntimeStatus(
      paths(root),
      { KOED_POSTGRES_BIN_DIR: resolve(root, "bin") },
      { existsSync: () => false }
    );

    expect(status.state).toBe("not_configured");
    expect(status.message).toContain("initdb");
    expect(status.action).toContain("WSL");
    expect(status.action).toContain("KOED_POSTGRES_BIN_DIR");
  });

  it("initializes, starts, creates database, and enables pgvector", () => {
    const root = tempDir();
    const bin = resolve(root, "bin");
    mkdirSync(bin, { recursive: true });
    const commands: Array<{ command: string; args: string[] }> = [];

    const result = startLocalPostgresRuntime(
      paths(root),
      { KOED_POSTGRES_BIN_DIR: bin, POSTGRES_PASSWORD: "secret" },
      {
        existsSync: (filePath) => !String(filePath).endsWith("PG_VERSION"),
        spawnSync: (command, args) => {
          commands.push({ command, args });
          if (command.endsWith("pg_ctl") && args.includes("status")) {
            return spawnResult(1, "not running");
          }
          return spawnResult();
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.env.DATABASE_URL).toBe(
      "postgres://koed:secret@127.0.0.1:15432/koed"
    );
    expect(commands.map((entry) => entry.command)).toEqual([
      resolve(bin, "initdb"),
      resolve(bin, "initdb"),
      resolve(bin, "pg_ctl"),
      resolve(bin, "pg_ctl"),
      resolve(bin, "psql"),
      resolve(bin, "psql"),
      resolve(bin, "psql")
    ]);
    const startArgs = commands.find(
      (entry) =>
        entry.command.endsWith("pg_ctl") && entry.args.includes("start")
    )?.args;
    expect(startArgs?.join(" ")).toContain("-h 127.0.0.1 -p 15432");
    expect(startArgs?.join(" ")).not.toContain(" -k ");
    expect(existsSync(resolve(root, "logs"))).toBe(true);
    expect(commands.at(-2)?.args.join(" ")).toContain("CREATE DATABASE");
    expect(commands.at(-1)?.args.join(" ")).toContain(
      "CREATE EXTENSION IF NOT EXISTS vector"
    );
    expect(result.status.paths).not.toHaveProperty("password");
  });

  it("reports running status when pg_ctl status succeeds", () => {
    const root = tempDir();
    const bin = resolve(root, "bin");
    mkdirSync(resolve(root, "data", "postgres"), { recursive: true });
    writeFileSync(resolve(root, "data", "postgres", "PG_VERSION"), "16");
    const status = collectLocalPostgresRuntimeStatus(
      paths(root),
      { KOED_POSTGRES_BIN_DIR: bin },
      { existsSync: () => true, spawnSync: () => spawnResult() }
    );

    expect(status.state).toBe("healthy");
    expect(status.runtime).toBe("native-postgres");
    expect(status.paths).not.toHaveProperty("password");
  });
});
