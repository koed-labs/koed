import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectHomebrewRuntimeStatus,
  installHomebrewRuntime
} from "./runtime-homebrew.js";
import type { KoedServerPaths } from "./paths.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-runtime-homebrew-"));
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
  repoRoot: root
});

const spawnResult = (stdout = "", status = 0, stderr = "") =>
  ({ stdout, stderr, status, signal: null, pid: 1, output: [] }) as never;

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Homebrew runtime provisioning", () => {
  it("reports unsupported platforms without invoking Homebrew", () => {
    const calls: string[][] = [];
    const status = collectHomebrewRuntimeStatus(
      paths(tempDir()),
      {},
      {
        platform: "win32",
        spawnSync: (_command, args) => {
          calls.push(args);
          return spawnResult();
        }
      }
    );

    expect(status.state).toBe("not_supported");
    expect(calls).toEqual([]);
  });

  it("supports Linux and WSL Homebrew environments", () => {
    const calls: string[][] = [];
    const status = collectHomebrewRuntimeStatus(
      paths(tempDir()),
      {},
      {
        platform: "linux",
        spawnSync: (_command, args) => {
          calls.push(args);
          return spawnResult("", 1, "brew missing");
        }
      }
    );

    expect(status.state).toBe("missing");
    expect(status.message).toContain("Homebrew is required");
    expect(calls).toEqual([["--prefix"]]);
  });

  it("detects packages, binaries, pgvector files, and KOED_HOME links without installing", () => {
    const root = tempDir();
    const existing = new Set([
      "/opt/homebrew/opt/postgresql@17/bin/initdb",
      "/opt/homebrew/opt/postgresql@17/bin/pg_ctl",
      "/opt/homebrew/opt/postgresql@17/bin/psql",
      "/opt/homebrew/opt/postgresql@17/bin/pg_config",
      "/opt/homebrew/opt/llama.cpp/bin/llama-server",
      "/opt/homebrew/share/postgresql@17/extension/vector.control",
      resolve(root, "runtime", "postgres", "bin", "initdb"),
      resolve(root, "runtime", "postgres", "bin", "pg_ctl"),
      resolve(root, "runtime", "postgres", "bin", "psql"),
      resolve(root, "runtime", "llama.cpp", "llama-server")
    ]);
    const calls: string[][] = [];

    const status = collectHomebrewRuntimeStatus(
      paths(root),
      {},
      {
        platform: "linux",
        existsSync: (path) => existing.has(String(path)),
        spawnSync: (_command, args) => {
          calls.push(args);
          if (args.join(" ") === "--prefix") {
            return spawnResult("/opt/homebrew\n");
          }
          if (args[0] === "list" && args[1] === "--versions") {
            return spawnResult(`${args[2]} 1.0\n`);
          }
          if (args.join(" ") === "--prefix postgresql@17") {
            return spawnResult("/opt/homebrew/opt/postgresql@17\n");
          }
          if (args.join(" ") === "--prefix pgvector") {
            return spawnResult("/opt/homebrew\n");
          }
          if (args.join(" ") === "--prefix llama.cpp") {
            return spawnResult("/opt/homebrew/opt/llama.cpp\n");
          }
          if (args.join(" ") === "--sharedir") {
            return spawnResult("/opt/homebrew/share/postgresql@17\n");
          }
          return spawnResult("", 1, "unexpected");
        }
      }
    );

    expect(status.ok).toBe(true);
    expect(status.pgvector.compatible).toBe(true);
    expect(calls.some((args) => args.includes("install"))).toBe(false);
  });

  it("installs missing Homebrew packages explicitly and links runtime paths under KOED_HOME", () => {
    const root = tempDir();
    const existing = new Set<string>([
      "/opt/homebrew/opt/postgresql@17/bin/initdb",
      "/opt/homebrew/opt/postgresql@17/bin/pg_ctl",
      "/opt/homebrew/opt/postgresql@17/bin/psql",
      "/opt/homebrew/opt/postgresql@17/bin/pg_config",
      "/opt/homebrew/opt/llama.cpp/bin/llama-server",
      "/opt/homebrew/share/postgresql@17/extension/vector.control"
    ]);
    const calls: string[][] = [];
    const linked: Array<[string, string]> = [];
    const installed = new Set(["postgresql@17"]);

    const result = installHomebrewRuntime(
      paths(root),
      {},
      {
        platform: "darwin",
        existsSync: (path) => existing.has(String(path)),
        mkdirSync: () => undefined,
        rmSync: () => undefined,
        symlinkSync: (source, target) => {
          linked.push([String(source), String(target)]);
          existing.add(String(target));
        },
        writeFileSync: (path) => {
          existing.add(String(path));
        },
        spawnSync: (_command, args) => {
          calls.push(args);
          if (args.join(" ") === "--prefix") {
            return spawnResult("/opt/homebrew\n");
          }
          if (args[0] === "list" && args[1] === "--versions") {
            return installed.has(args[2]!)
              ? spawnResult(`${args[2]} 1.0\n`)
              : spawnResult("", 1, "not installed");
          }
          if (args[0] === "--prefix") {
            return installed.has(args[1]!)
              ? spawnResult(`/opt/homebrew/opt/${args[1]}\n`)
              : spawnResult("", 1, "not installed");
          }
          if (args[0] === "install") {
            for (const name of args.slice(1)) installed.add(name);
            return spawnResult("installed\n");
          }
          if (args.join(" ") === "--sharedir") {
            return spawnResult("/opt/homebrew/share/postgresql@17\n");
          }
          return spawnResult("", 1, "unexpected");
        }
      }
    );

    expect(calls).toContainEqual(["install", "pgvector", "llama.cpp"]);
    expect(result.ok).toBe(true);
    expect(result.installedPackages).toEqual(["pgvector", "llama.cpp"]);
    expect(linked).toEqual(
      expect.arrayContaining([
        [
          "/opt/homebrew/opt/postgresql@17/bin/initdb",
          resolve(root, "runtime", "postgres", "bin", "initdb")
        ],
        [
          "/opt/homebrew/opt/llama.cpp/bin/llama-server",
          resolve(root, "runtime", "llama.cpp", "llama-server")
        ]
      ])
    );
  });

  it("does not install when Homebrew itself is missing", () => {
    const calls: string[][] = [];
    const result = installHomebrewRuntime(
      paths(tempDir()),
      {},
      {
        platform: "darwin",
        existsSync: () => false,
        spawnSync: (_command, args) => {
          calls.push(args);
          return spawnResult("", 1, "brew missing");
        }
      }
    );

    expect(result.state).toBe("needs_attention");
    expect(calls.some((args) => args.includes("install"))).toBe(false);
    expect(result.action).toContain("Install Homebrew");
  });
});
