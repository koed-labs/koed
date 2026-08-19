import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeLocalAppCredential } from "./credentials.js";
import {
  provisionLocalApiToken,
  type LocalApiTokenRepository
} from "./local-api-token.js";
import type { KoedServerPaths } from "./paths.js";

const homes: string[] = [];
const makePaths = (): KoedServerPaths => {
  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-token-test-"));
  homes.push(koedHome);
  return {
    koedHome,
    configDir: resolve(koedHome, "config"),
    logsDir: resolve(koedHome, "logs"),
    runDir: resolve(koedHome, "run"),
    dataDir: resolve(koedHome, "data"),
    modelsDir: resolve(koedHome, "models"),
    cacheDir: resolve(koedHome, "cache"),
    postgresDataDir: resolve(koedHome, "data/postgres"),
    postgresRunDir: resolve(koedHome, "run/postgres"),
    postgresLogPath: resolve(koedHome, "logs/postgres.log"),
    runtimeStatePath: resolve(koedHome, "run/koed-server.json"),
    lastVerificationPath: resolve(koedHome, "run/last-verification.json"),
    serverConfigPath: resolve(koedHome, "config/server.json"),
    localPortsPath: resolve(koedHome, "config/local-ports.json"),
    localAppCredentialPath: resolve(
      koedHome,
      "config/local-app-credential.json"
    ),
    upstreamBackendsPath: resolve(koedHome, "config/upstream-backends.json"),
    projectMetadataPath: resolve(koedHome, "config/projects.json"),
    projectTeamWorkspaceLinksPath: resolve(
      koedHome,
      "config/project-team-workspaces.json"
    ),
    upstreamEnrollmentsPath: resolve(koedHome, "run/upstream-enrollments.json"),
    upstreamDisconnectCleanupPath: resolve(
      koedHome,
      "run/upstream-disconnect-cleanup.json"
    ),
    repoRoot: koedHome
  };
};

const repository = (
  tokenOwner: { id: string } | null,
  createdOwner = { id: "personal-owner" }
): LocalApiTokenRepository => ({
  findUserByEmail: async () => ({ id: "personal-owner" }),
  createUser: async () => createdOwner,
  createApiToken: async () => undefined,
  getApiTokenUser: async () => tokenOwner
});

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("local API Token provisioning", () => {
  it("rotates revoked stale core credential", async () => {
    const paths = makePaths();
    writeLocalAppCredential(paths, {
      apiToken: "revoked-token",
      provisionedAt: "2026-01-01T00:00:00.000Z",
      source: "environment"
    });

    const result = await provisionLocalApiToken(
      paths,
      {} as never,
      { API_TOKEN_PEPPER: "pepper" },
      {},
      () => new Date("2026-01-02T00:00:00.000Z"),
      repository(null)
    );

    expect(result.reused).toBe(false);
    expect(result.token).not.toBe("revoked-token");
    const credential = JSON.parse(
      readFileSync(paths.localAppCredentialPath, "utf8")
    ) as { apiToken?: unknown };
    expect(credential.apiToken).toBe(result.token);
  });

  it("rejects core credential owned by different Personal owner", async () => {
    const paths = makePaths();
    writeLocalAppCredential(paths, {
      apiToken: "foreign-token",
      provisionedAt: "2026-01-01T00:00:00.000Z",
      source: "environment"
    });

    await expect(
      provisionLocalApiToken(
        paths,
        {} as never,
        { API_TOKEN_PEPPER: "pepper" },
        {},
        () => new Date("2026-01-02T00:00:00.000Z"),
        repository({ id: "foreign-owner" })
      )
    ).rejects.toThrow("different Personal owner");
  });
});
