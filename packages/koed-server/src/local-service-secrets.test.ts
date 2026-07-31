import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { KoedServerPaths } from "./paths.js";
import {
  ensurePackagedLocalServiceSecrets,
  readLocalServiceSecrets
} from "./local-service-secrets.js";

const paths = (): KoedServerPaths => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-local-secrets-"));
  const configDir = resolve(root, "config");
  mkdirSync(configDir, { recursive: true });
  return {
    koedHome: root,
    configDir,
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
    localAppCredentialPath: resolve(
      root,
      "config",
      "local-app-credential.json"
    ),
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
  };
};

describe("packaged local service secrets", () => {
  it("generates and persists an independent local collaboration broker secret", () => {
    const target = paths();
    let sequence = 0;
    const environment = ensurePackagedLocalServiceSecrets(
      target,
      true,
      {},
      { randomBytes: (size) => Buffer.alloc(size, ++sequence) }
    );

    expect(environment.COLLABORATION_LOCAL_BROKER_SECRET).toBeTruthy();
    expect(environment.KOED_OPS_METRICS_TOKEN).toBeTruthy();
    expect(environment.OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY).toBeTruthy();
    expect(environment.OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY).not.toBe(
      environment.API_DATA_ENCRYPTION_KEY
    );
    expect(environment.COLLABORATION_LOCAL_BROKER_SECRET).not.toBe(
      environment.COLLABORATION_REALTIME_CURSOR_SECRET
    );
    expect(readLocalServiceSecrets(target)).toMatchObject({
      state: "valid",
      secrets: {
        OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY:
          environment.OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY,
        COLLABORATION_LOCAL_BROKER_SECRET:
          environment.COLLABORATION_LOCAL_BROKER_SECRET,
        KOED_OPS_METRICS_TOKEN: environment.KOED_OPS_METRICS_TOKEN
      }
    });
    expect(
      JSON.parse(
        readFileSync(
          resolve(target.configDir, "local-service-secrets.json"),
          "utf8"
        )
      )
    ).toMatchObject({
      OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY:
        environment.OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY,
      COLLABORATION_LOCAL_BROKER_SECRET:
        environment.COLLABORATION_LOCAL_BROKER_SECRET,
      KOED_OPS_METRICS_TOKEN: environment.KOED_OPS_METRICS_TOKEN
    });
  });

  it("does not materialize secrets outside packaged runtime", () => {
    const target = paths();
    expect(ensurePackagedLocalServiceSecrets(target, false, {})).toEqual({});
    expect(readLocalServiceSecrets(target).state).toBe("absent");
  });
});
