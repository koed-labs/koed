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
  localAppCredentialPath: resolve(root, "config", "local-app-credential.json"),
  upstreamBackendsPath: resolve(root, "config", "upstream-backends.json"),
  projectMetadataPath: resolve(root, "config", "projects.json"),
  projectTeamWorkspaceLinksPath: resolve(
    root,
    "config",
    "project-team-workspaces.json"
  ),
  upstreamEnrollmentsPath: resolve(root, "run", "upstream-enrollments.json"),
  upstreamDisconnectCleanupPath: resolve(
    root,
    "run",
    "upstream-disconnect-cleanup.json"
  ),
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
        existsSync: () => false,
        spawnSync: (_command, args) => {
          calls.push(args);
          return spawnResult("", 1, "brew missing");
        }
      }
    );

    expect(status.state).toBe("missing");
    expect(status.message).toContain("Homebrew is required");
    expect(status.action).toContain("Linuxbrew");
    expect(calls).toEqual([["--prefix"]]);
  });

  it("uses the documented macOS Homebrew executable without loading a shell", () => {
    const commands: string[] = [];
    const status = collectHomebrewRuntimeStatus(
      paths(tempDir()),
      { PATH: "/usr/bin:/bin", SHELL: "/untrusted/login-shell" },
      {
        platform: "darwin",
        existsSync: (path) => path === "/opt/homebrew/bin/brew",
        spawnSync: (command, args) => {
          commands.push(command);
          if (args.join(" ") === "--prefix") {
            return spawnResult("/opt/homebrew\n");
          }
          return spawnResult("", 1, "not installed");
        }
      }
    );

    expect(status.homebrew).toEqual({
      installed: true,
      prefix: "/opt/homebrew"
    });
    expect(commands).not.toContain("brew");
    expect(commands).not.toContain("/untrusted/login-shell");
    expect(commands).toContain("/opt/homebrew/bin/brew");
  });

  it("honors an absolute Homebrew prefix before platform defaults", () => {
    const commands: string[] = [];
    collectHomebrewRuntimeStatus(
      paths(tempDir()),
      { HOMEBREW_PREFIX: "/operator/homebrew" },
      {
        platform: "darwin",
        existsSync: (path) =>
          path === "/operator/homebrew/bin/brew" ||
          path === "/opt/homebrew/bin/brew",
        spawnSync: (command, args) => {
          commands.push(command);
          if (
            command === "/operator/homebrew/bin/brew" &&
            args.join(" ") === "--prefix"
          ) {
            return spawnResult("/operator/homebrew\n");
          }
          return spawnResult("", 1, "not installed");
        }
      }
    );

    expect(commands.length).toBeGreaterThan(1);
    expect(
      commands.every((command) => command === "/operator/homebrew/bin/brew")
    ).toBe(true);
  });

  it("falls back when an existing platform Homebrew executable cannot run", () => {
    const commands: string[] = [];
    const status = collectHomebrewRuntimeStatus(
      paths(tempDir()),
      {},
      {
        platform: "darwin",
        existsSync: (path) =>
          path === "/opt/homebrew/bin/brew" || path === "/usr/local/bin/brew",
        spawnSync: (command, args) => {
          commands.push(command);
          if (command === "/opt/homebrew/bin/brew") {
            return spawnResult("", 1, "cannot execute");
          }
          if (args.join(" ") === "--prefix") {
            return spawnResult("/usr/local\n");
          }
          return spawnResult("", 1, "not installed");
        }
      }
    );

    expect(status.homebrew).toEqual({
      installed: true,
      prefix: "/usr/local"
    });
    expect(commands.slice(0, 2)).toEqual([
      "/opt/homebrew/bin/brew",
      "/usr/local/bin/brew"
    ]);
    expect(commands).not.toContain("brew");
  });

  it("detects packages, binaries, pgvector files, and KOED_HOME links without installing", () => {
    const root = tempDir();
    const existing = new Set([
      "/opt/homebrew/opt/postgresql@17/bin/initdb",
      "/opt/homebrew/opt/postgresql@17/bin/pg_ctl",
      "/opt/homebrew/opt/postgresql@17/bin/psql",
      "/opt/homebrew/opt/postgresql@17/bin/pg_dump",
      "/opt/homebrew/opt/postgresql@17/bin/pg_restore",
      "/opt/homebrew/opt/postgresql@17/bin/pg_config",
      "/opt/homebrew/opt/llama.cpp/bin/llama-server",
      "/opt/homebrew/share/postgresql@17/extension/vector.control",
      resolve(root, "runtime", "postgres", "bin", "initdb"),
      resolve(root, "runtime", "postgres", "bin", "pg_ctl"),
      resolve(root, "runtime", "postgres", "bin", "psql"),
      resolve(root, "runtime", "postgres", "bin", "pg_dump"),
      resolve(root, "runtime", "postgres", "bin", "pg_restore"),
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
      "/opt/homebrew/bin/brew",
      "/opt/homebrew/opt/postgresql@17/bin/initdb",
      "/opt/homebrew/opt/postgresql@17/bin/pg_ctl",
      "/opt/homebrew/opt/postgresql@17/bin/psql",
      "/opt/homebrew/opt/postgresql@17/bin/pg_dump",
      "/opt/homebrew/opt/postgresql@17/bin/pg_restore",
      "/opt/homebrew/opt/postgresql@17/bin/pg_config",
      "/opt/homebrew/opt/llama.cpp/bin/llama-server",
      "/opt/homebrew/share/postgresql@17/extension/vector.control"
    ]);
    const calls: string[][] = [];
    const commands: Array<[string, ...string[]]> = [];
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
        spawnSync: (command, args) => {
          calls.push(args);
          commands.push([command, ...args]);
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
    expect(commands).toContainEqual([
      "/opt/homebrew/bin/brew",
      "install",
      "pgvector",
      "llama.cpp"
    ]);
    expect(result.ok).toBe(true);
    expect(result.installedPackages).toEqual(["pgvector", "llama.cpp"]);
    expect(linked).toEqual(
      expect.arrayContaining([
        [
          "/opt/homebrew/opt/postgresql@17/bin/initdb",
          resolve(root, "runtime", "postgres", "bin", "initdb")
        ],
        [
          "/opt/homebrew/opt/postgresql@17/bin/pg_dump",
          resolve(root, "runtime", "postgres", "bin", "pg_dump")
        ],
        [
          "/opt/homebrew/opt/postgresql@17/bin/pg_restore",
          resolve(root, "runtime", "postgres", "bin", "pg_restore")
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
