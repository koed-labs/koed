import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerConfig } from "./config.js";
import type { KoedServerPaths } from "./paths.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-server-config-"));
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
  postgresDataDir: resolve(root, "data/postgres"),
  postgresRunDir: resolve(root, "run/postgres"),
  postgresLogPath: resolve(root, "logs/postgres.log"),
  runtimeStatePath: resolve(root, "run/koed-server.json"),
  lastVerificationPath: resolve(root, "run/last-verification.json"),
  serverConfigPath: resolve(root, "config/server.json"),
  localPortsPath: resolve(root, "config/local-ports.json"),
  localAppCredentialPath: resolve(root, "config/local-app-credential.json"),
  upstreamBackendsPath: resolve(root, "config/upstream-backends.json"),
  projectMetadataPath: resolve(root, "config/projects.json"),
  projectTeamWorkspaceLinksPath: resolve(
    root,
    "config/project-team-workspaces.json"
  ),
  upstreamEnrollmentsPath: resolve(root, "run/upstream-enrollments.json"),
  upstreamDisconnectCleanupPath: resolve(
    root,
    "run/upstream-disconnect-cleanup.json"
  ),
  repoRoot: root
});

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("koed-server config", () => {
  it("defaults source checkout control plane to external dependencies", () => {
    const root = tempDir();

    expect(resolveKoedServerConfig(paths(root), {})).toMatchObject({
      runtimeMode: "developer",
      dependencyMode: "external"
    });
  });

  it("accepts bundled-local dependency mode from file and environment", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/server.json"),
      JSON.stringify({ dependencyMode: "bundled-local" })
    );

    expect(resolveKoedServerConfig(paths(root), {})).toMatchObject({
      dependencyMode: "bundled-local"
    });
    expect(
      resolveKoedServerConfig(paths(root), {
        KOED_DEPENDENCY_MODE: "external"
      })
    ).toMatchObject({ dependencyMode: "external" });
  });

  it("resolves Transcript Watcher defaults and file/environment precedence", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/server.json"),
      JSON.stringify({
        runtimeMode: "local-personal",
        codexTranscriptWatcherEnabled: false
      })
    );

    expect(resolveKoedServerConfig(paths(root), {})).toMatchObject({
      codexTranscriptWatcherEnabled: false
    });
    expect(
      resolveKoedServerConfig(paths(root), {
        MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: ""
      })
    ).toMatchObject({ codexTranscriptWatcherEnabled: false });
    expect(
      resolveKoedServerConfig(paths(root), {
        MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: "true"
      })
    ).toMatchObject({ codexTranscriptWatcherEnabled: true });
    expect(
      resolveKoedServerConfig(paths(root), { KOED_RUNTIME_MODE: "external" })
    ).toMatchObject({ codexTranscriptWatcherEnabled: false });
  });

  it("rejects Transcript Watcher ownership in external runtime mode", () => {
    const root = tempDir();

    expect(() =>
      resolveKoedServerConfig(paths(root), {
        KOED_RUNTIME_MODE: "external",
        MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: "true"
      })
    ).toThrow("Codex Transcript Watcher cannot run in external runtime mode");
  });

  it("loads server config and lets environment override it", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/server.json"),
      JSON.stringify({
        runtimeMode: "external",
        dependencyMode: "external",
        external: {
          databaseUrl: "postgres://file/db",
          redisUrl: "redis://file:6379",
          embeddingServiceUrl: "http://file:3800"
        }
      })
    );

    expect(
      resolveKoedServerConfig(paths(root), {
        KOED_EXTERNAL_REDIS_URL: "redis://env:6379"
      })
    ).toMatchObject({
      runtimeMode: "external",
      dependencyMode: "external",
      external: {
        databaseUrl: "postgres://file/db",
        redisUrl: "redis://env:6379",
        embeddingServiceUrl: "http://file:3800"
      }
    });
  });
});
