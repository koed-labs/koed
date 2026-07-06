import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KoedServerPaths } from "./paths.js";
import {
  collectPackagedRuntimeStatus,
  installPackagedRuntime,
  sha256PackagedRuntimeFiles,
  type PackagedRuntimeAssetManifest
} from "./runtime-packaged.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-runtime-packaged-"));
  temps.push(path);
  return path;
};

const paths = (root: string): KoedServerPaths => ({
  koedHome: resolve(root, "home"),
  configDir: resolve(root, "home", "config"),
  logsDir: resolve(root, "home", "logs"),
  runDir: resolve(root, "home", "run"),
  dataDir: resolve(root, "home", "data"),
  modelsDir: resolve(root, "home", "models"),
  cacheDir: resolve(root, "home", "cache"),
  postgresDataDir: resolve(root, "home", "data", "postgres"),
  postgresRunDir: resolve(root, "home", "run", "postgres"),
  postgresLogPath: resolve(root, "home", "logs", "postgres.log"),
  runtimeStatePath: resolve(root, "home", "run", "koed-server.json"),
  lastVerificationPath: resolve(root, "home", "run", "last-verification.json"),
  serverConfigPath: resolve(root, "home", "config", "server.json"),
  localPortsPath: resolve(root, "home", "config", "local-ports.json"),
  explorerTokenPath: resolve(root, "home", "config", "explorer-token.json"),
  repoRoot: root
});

const createPackagedPostgres = (root: string) => {
  const source = resolve(root, "koed-runtime", "postgres");
  mkdirSync(resolve(source, "bin"), { recursive: true });
  writeFileSync(resolve(source, "bin", "initdb"), "initdb");
  writeFileSync(resolve(source, "bin", "pg_ctl"), "pg_ctl");
  writeFileSync(resolve(source, "bin", "psql"), "psql");
  chmodSync(resolve(source, "bin", "initdb"), 0o755);
  chmodSync(resolve(source, "bin", "pg_ctl"), 0o755);
  chmodSync(resolve(source, "bin", "psql"), 0o755);
  return source;
};

const writeManifest = (
  root: string,
  overrides: Partial<PackagedRuntimeAssetManifest["assets"][number]> = {}
) => {
  const files = ["bin/initdb", "bin/pg_ctl", "bin/psql"];
  const source = resolve(root, "koed-runtime", "postgres");
  const manifest: PackagedRuntimeAssetManifest = {
    schemaVersion: 1,
    assets: [
      {
        id: "postgres",
        platform: "macos",
        architecture: "arm64",
        version: "17.0-pgvector-test",
        packagedResourcePath: "postgres",
        sha256: sha256PackagedRuntimeFiles(source, files),
        expectedFiles: files,
        executablePaths: {
          initdb: "bin/initdb",
          pg_ctl: "bin/pg_ctl",
          psql: "bin/psql"
        },
        installPath: "postgres",
        ...overrides
      }
    ]
  };
  mkdirSync(resolve(root, "koed-runtime"), { recursive: true });
  writeFileSync(
    resolve(root, "koed-runtime", "runtime-asset-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
};

const env = (root: string): NodeJS.ProcessEnv => ({
  KOED_PACKAGED_DESKTOP: "1",
  KOED_PACKAGED_RESOURCES_PATH: root
});

const host = { platform: "darwin" as const, architecture: "arm64" as const };
const linuxHost = { platform: "linux" as const, architecture: "x64" as const };

const spawnResult = (stdout = "", status = 0, stderr = "") =>
  ({ stdout, stderr, status, signal: null, pid: 1, output: [] }) as never;

const validationHost = {
  ...host,
  spawnSync: (command: string, args: string[]) => {
    if (args.includes("--version")) {
      if (command.endsWith("initdb"))
        return spawnResult("initdb (PostgreSQL) 17.6\n");
      if (command.endsWith("llama-server"))
        return spawnResult("llama-server 1.0\n");
    }
    if (args[0] === "-L")
      return spawnResult(`${args[1]}:\n\t/usr/lib/libSystem.B.dylib\n`);
    return spawnResult();
  }
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("packaged runtime provisioning", () => {
  it("reports missing packaged asset manifest", () => {
    const root = tempDir();
    const status = collectPackagedRuntimeStatus(paths(root), env(root), host);

    expect(status.ok).toBe(false);
    expect(status.state).toBe("missing");
    expect(status.message).toContain("manifest");
  });

  it("reports incompatible manifests for other platform or architecture", () => {
    const root = tempDir();
    createPackagedPostgres(root);
    writeManifest(root, { platform: "linux", architecture: "x64" });

    const status = collectPackagedRuntimeStatus(paths(root), env(root), host);

    expect(status.ok).toBe(false);
    expect(status.state).toBe("incompatible");
    expect(status.message).toContain("no assets for macos/arm64");
  });

  it("reports packaged assets available but not installed under KOED_HOME", () => {
    const root = tempDir();
    createPackagedPostgres(root);
    writeManifest(root);

    const status = collectPackagedRuntimeStatus(paths(root), env(root), host);

    expect(status.ok).toBe(false);
    expect(status.state).toBe("missing");
    expect(status.assets[0]).toMatchObject({
      id: "postgres",
      state: "missing",
      sourceAvailable: true,
      installed: false
    });
    expect(status.assets[0]?.source.path).toBe(
      resolve(root, "koed-runtime", "postgres")
    );
  });

  it("verifies SHA-256 then installs packaged assets idempotently into KOED_HOME/runtime", () => {
    const root = tempDir();
    createPackagedPostgres(root);
    writeManifest(root);
    const koedPaths = paths(root);

    const first = installPackagedRuntime(koedPaths, env(root), validationHost);
    const second = installPackagedRuntime(koedPaths, env(root), validationHost);

    expect(first.ok).toBe(true);
    expect(first.state).toBe("installed");
    expect(first.copiedPaths).toEqual([
      resolve(root, "home", "runtime", "postgres")
    ]);
    expect(second.ok).toBe(true);
    expect(second.copiedPaths).toEqual([]);
    expect(
      readFileSync(
        resolve(root, "home", "runtime", "postgres", "bin", "psql"),
        "utf8"
      )
    ).toBe("psql");
    expect(
      statSync(resolve(root, "home", "runtime", "postgres", "bin", "psql"))
        .mode & 0o111
    ).not.toBe(0);
    expect(
      existsSync(resolve(root, "koed-runtime", "postgres", "bin", "psql"))
    ).toBe(true);
  });

  it("marks installed packaged assets incompatible when validation fails", () => {
    const root = tempDir();
    createPackagedPostgres(root);
    writeManifest(root);
    const koedPaths = paths(root);
    const first = installPackagedRuntime(koedPaths, env(root), validationHost);

    const status = collectPackagedRuntimeStatus(koedPaths, env(root), {
      ...host,
      spawnSync: (command, args) => {
        if (args.includes("--version") && command.endsWith("initdb")) {
          return spawnResult("initdb (PostgreSQL) 16.9\n");
        }
        if (args[0] === "-L") return spawnResult(`${args[1]}:\n`);
        return spawnResult();
      }
    });

    expect(first.ok).toBe(true);
    expect(status.ok).toBe(false);
    expect(status.state).toBe("incompatible");
    expect(status.assets[0]?.validation?.errors.join("\n")).toContain(
      "postgres-17"
    );
  });

  it("validates linux packaged runtime paths and loader checks", () => {
    const root = tempDir();
    createPackagedPostgres(root);
    writeManifest(root, { platform: "linux", architecture: "x64" });
    const koedPaths = paths(root);
    const linuxSpawn = (command: string, args: string[]) => {
      if (args.includes("--version") && command.endsWith("initdb")) {
        return spawnResult("initdb (PostgreSQL) 17.4\n");
      }
      if (command === "ldd" && args[0] === "--version") {
        return spawnResult("ldd (Ubuntu GLIBC 2.35-0ubuntu3) 2.35\n");
      }
      if (command === "ldd") {
        return spawnResult(
          `${args[0]}:\n\tlinux-vdso.so.1 (0x00007fffd3dfe000)\n`
        );
      }
      return spawnResult();
    };

    const installed = installPackagedRuntime(koedPaths, env(root), {
      ...linuxHost,
      spawnSync: linuxSpawn
    });
    const status = collectPackagedRuntimeStatus(koedPaths, env(root), {
      ...linuxHost,
      spawnSync: linuxSpawn
    });

    expect(installed.ok).toBe(true);
    expect(status.ok).toBe(true);
    expect(status.state).toBe("installed");
    expect(status.platform).toBe("linux");
    expect(status.architecture).toBe("x64");
    expect(status.assets[0]?.validation?.loader[0]?.ok).toBe(true);
  });

  it("skips loader validation for shell launcher scripts", () => {
    const root = tempDir();
    createPackagedPostgres(root);
    writeFileSync(
      resolve(root, "koed-runtime", "postgres", "bin", "psql"),
      "#!/bin/sh\nexit 0\n"
    );
    writeManifest(root, { platform: "linux", architecture: "x64" });
    const koedPaths = paths(root);
    const linuxSpawn = (command: string, args: string[]) => {
      if (args.includes("--version") && command.endsWith("initdb")) {
        return spawnResult("initdb (PostgreSQL) 17.4\n");
      }
      if (command === "ldd" && args[0] === "--version") {
        return spawnResult("ldd (Ubuntu GLIBC 2.35-0ubuntu3) 2.35\n");
      }
      return spawnResult("not a dynamic executable", 1);
    };

    installPackagedRuntime(koedPaths, env(root), {
      ...linuxHost,
      spawnSync: linuxSpawn
    });
    const status = collectPackagedRuntimeStatus(koedPaths, env(root), {
      ...linuxHost,
      spawnSync: linuxSpawn
    });

    const psqlLoader = status.assets[0]?.validation?.loader.find((entry) =>
      entry.command.endsWith("psql")
    );
    expect(psqlLoader).toMatchObject({ ok: true, skipped: true });
  });

  it("rejects linux packaged runtime on old glibc hosts", () => {
    const root = tempDir();
    createPackagedPostgres(root);
    writeManifest(root, { platform: "linux", architecture: "x64" });

    const status = collectPackagedRuntimeStatus(paths(root), env(root), {
      ...linuxHost,
      spawnSync: (command, args) => {
        if (command === "ldd" && args[0] === "--version") {
          return spawnResult("ldd (GNU libc) 2.31\n");
        }
        return spawnResult();
      }
    });

    expect(status.ok).toBe(false);
    expect(status.state).toBe("not_supported");
    expect(status.message).toContain("glibc 2.35+");
    expect(status.action).toContain("Ubuntu 22.04+");
  });

  it("rejects linux packaged runtime on musl hosts", () => {
    const root = tempDir();
    createPackagedPostgres(root);
    writeManifest(root, { platform: "linux", architecture: "x64" });

    const status = collectPackagedRuntimeStatus(paths(root), env(root), {
      ...linuxHost,
      spawnSync: (command, args) => {
        if (command === "ldd" && args[0] === "--version") {
          return spawnResult("musl libc (x86_64)\nVersion 1.2.4\n");
        }
        return spawnResult();
      }
    });

    expect(status.ok).toBe(false);
    expect(status.state).toBe("not_supported");
    expect(status.message).toContain("musl");
  });

  it("reports missing ldd on linux packaged runtime with host guidance", () => {
    const root = tempDir();
    createPackagedPostgres(root);
    writeManifest(root, { platform: "linux", architecture: "x64" });

    const status = collectPackagedRuntimeStatus(paths(root), env(root), {
      ...linuxHost,
      spawnSync: (command, args) => {
        if (command === "ldd" && args[0] === "--version") {
          return Object.assign(spawnResult("", 1, "ldd missing"), {
            error: new Error("ENOENT")
          }) as never;
        }
        return spawnResult();
      }
    });

    expect(status.ok).toBe(false);
    expect(status.state).toBe("not_supported");
    expect(status.message).toContain("ldd");
  });

  it("reports checksum mismatch as incompatible and does not install", () => {
    const root = tempDir();
    createPackagedPostgres(root);
    writeManifest(root, {
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    const result = installPackagedRuntime(paths(root), env(root), host);

    expect(result.ok).toBe(false);
    expect(result.state).toBe("incompatible");
    expect(result.copiedPaths).toEqual([]);
    expect(existsSync(resolve(root, "home", "runtime", "postgres"))).toBe(
      false
    );
  });
});
