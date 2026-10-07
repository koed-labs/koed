import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultKoedServerConfig } from "./config.js";
import {
  calculateRuntimeRequirements,
  resolveEffectiveRuntimeConfig
} from "./effective-runtime-config.js";
import type { EffectiveRuntimeConfig } from "./effective-runtime-config.js";

const temporaryDirectories: string[] = [];
const makePaths = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-effective-config-"));
  temporaryDirectories.push(root);
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
    componentsDir: resolve(root, "runtime", "components"),
    generationsDir: resolve(root, "runtime", "generations"),
    postgresDataDir: resolve(root, "data/postgres"),
    postgresRunDir: resolve(root, "run/postgres"),
    postgresLogPath: resolve(root, "logs/postgres.log"),
    runtimeStatePath: resolve(root, "run/server.json"),
    lastVerificationPath: resolve(root, "run/verify.json"),
    serverConfigPath: resolve(configDir, "server.json"),
    localPortsPath: resolve(configDir, "ports.json"),
    localAppCredentialPath: resolve(configDir, "credential.json"),
    upstreamBackendsPath: resolve(configDir, "backends.json"),
    projectMetadataPath: resolve(configDir, "projects.json"),
    projectTeamWorkspaceLinksPath: resolve(configDir, "links.json"),
    upstreamEnrollmentsPath: resolve(root, "run/enrollments.json"),
    upstreamDisconnectCleanupPath: resolve(root, "run/cleanup.json"),
    repoRoot: root
  };
};
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const effective = (
  runtimeMode: "local-personal" | "developer" | "external",
  dependencyMode: "external" | "bundled-local",
  teamEnabled: boolean,
  environment: NodeJS.ProcessEnv = {}
): EffectiveRuntimeConfig => ({
  config: { ...defaultKoedServerConfig, runtimeMode, dependencyMode },
  environment,
  teamEnabled
});

describe("effective runtime requirements", () => {
  it("selects local privacy for external runtime plus bundled-local Team", () => {
    expect(
      calculateRuntimeRequirements({
        config: {
          ...defaultKoedServerConfig,
          runtimeMode: "external",
          dependencyMode: "bundled-local"
        },
        environment: {},
        teamEnabled: true
      })
    ).toEqual({
      components: ["base", "privacy"],
      processes: [
        "api",
        "worker",
        "postgres",
        "embedding-service",
        "privacy-service"
      ],
      queue: "local",
      native: ["postgres", "llama-server"],
      models: ["embedding", "privacy"]
    });
  });

  it.each(
    (["local-personal", "developer", "external"] as const).flatMap((runtime) =>
      (["external", "bundled-local"] as const).flatMap((dependencies) =>
        ([false, true] as const).map(
          (teamEnabled) => [runtime, dependencies, teamEnabled] as const
        )
      )
    )
  )("calculates %s/%s Team=%s requirements", (runtime, dependencies, team) => {
    const result = calculateRuntimeRequirements(
      effective(runtime, dependencies, team)
    );
    const localPrivacy = dependencies === "bundled-local" && team;
    expect(result).toEqual({
      components: localPrivacy ? ["base", "privacy"] : ["base"],
      processes: [
        "api",
        "worker",
        ...(runtime === "external" ? [] : ["local-ai-runtime"]),
        ...(dependencies === "bundled-local"
          ? ["postgres", "embedding-service"]
          : []),
        ...(localPrivacy ? ["privacy-service"] : [])
      ],
      queue: dependencies === "bundled-local" ? "local" : "bullmq",
      native:
        dependencies === "bundled-local" ? ["postgres", "llama-server"] : [],
      models:
        dependencies === "bundled-local"
          ? localPrivacy
            ? ["embedding", "privacy"]
            : ["embedding"]
          : []
    });
  });

  it.each([
    ["bundled-local", undefined, "local"],
    ["external", undefined, "bullmq"],
    ["bundled-local", "bullmq", "bullmq"],
    ["external", "local", "local"]
  ] as const)(
    "resolves queue for %s override=%s",
    (dependencies, override, queue) => {
      expect(
        calculateRuntimeRequirements(
          effective("external", dependencies, false, {
            ...(override ? { WORK_QUEUE_BACKEND: override } : {})
          })
        ).queue
      ).toBe(queue);
    }
  );

  it("resolves environment over explicit env file over server config", () => {
    const paths = makePaths();
    const explicitEnv = resolve(paths.koedHome, "explicit.env");
    writeFileSync(
      explicitEnv,
      "KOED_RUNTIME_MODE=external\nKOED_TEAM_COLLABORATION_ENABLED=true\n"
    );
    writeFileSync(
      paths.serverConfigPath,
      JSON.stringify({
        runtimeMode: "developer",
        dependencyMode: "bundled-local"
      })
    );
    const resolved = resolveEffectiveRuntimeConfig(
      paths,
      {
        KOED_ENV_PATH: explicitEnv,
        KOED_DEPENDENCY_MODE: "external",
        KOED_TEAM_COLLABORATION_ENABLED: "false"
      },
      "packaged"
    );
    expect(resolved.config).toMatchObject({
      runtimeMode: "external",
      dependencyMode: "external"
    });
    expect(resolved.teamEnabled).toBe(false);
  });

  it("discovers .env only in source execution and derives Team from layered environment", () => {
    const paths = makePaths();
    writeFileSync(
      resolve(paths.repoRoot, ".env"),
      "KOED_RUNTIME_MODE=external\nKOED_DEPENDENCY_MODE=bundled-local\nKOED_TEAM_COLLABORATION_ENABLED=true\n"
    );

    const source = resolveEffectiveRuntimeConfig(paths, {}, "source");
    expect(source.teamEnabled).toBe(true);
    expect(calculateRuntimeRequirements(source)).toMatchObject({
      components: ["base", "privacy"],
      processes: [
        "api",
        "worker",
        "postgres",
        "embedding-service",
        "privacy-service"
      ]
    });

    const packaged = resolveEffectiveRuntimeConfig(paths, {}, "packaged");
    expect(packaged.teamEnabled).toBe(false);
    expect(packaged.config.runtimeMode).toBe("local-personal");
  });

  it("rejects malformed explicit environment input with path and line", () => {
    const paths = makePaths();
    const explicitEnv = resolve(paths.repoRoot, "explicit.env");
    writeFileSync(explicitEnv, 'VALUE="one" garbage "two"\n');

    expect(() =>
      resolveEffectiveRuntimeConfig(
        paths,
        { KOED_ENV_PATH: explicitEnv },
        "packaged"
      )
    ).toThrow(`${explicitEnv}:1: unexpected text after quoted value for VALUE`);
  });

  it("rejects invalid queue values without changing external endpoint requirements", () => {
    expect(() =>
      calculateRuntimeRequirements(
        effective("external", "external", false, {
          WORK_QUEUE_BACKEND: "sidekiq"
        })
      )
    ).toThrow('WORK_QUEUE_BACKEND must be "local" or "bullmq"');
  });

  it("preserves external service endpoints from server config", () => {
    const paths = makePaths();
    writeFileSync(
      paths.serverConfigPath,
      JSON.stringify({
        runtimeMode: "external",
        dependencyMode: "external",
        external: {
          databaseUrl: "postgres://db",
          redisUrl: "redis://queue",
          embeddingServiceUrl: "http://embedding",
          privacyServiceUrl: "http://privacy"
        }
      })
    );
    expect(
      resolveEffectiveRuntimeConfig(paths, {}, "packaged").config.external
    ).toEqual({
      databaseUrl: "postgres://db",
      redisUrl: "redis://queue",
      embeddingServiceUrl: "http://embedding",
      privacyServiceUrl: "http://privacy"
    });
  });

  it("fails on missing explicit env and malformed packaged server config", () => {
    const paths = makePaths();
    expect(() =>
      resolveEffectiveRuntimeConfig(
        paths,
        { KOED_ENV_PATH: resolve(paths.koedHome, "missing.env") },
        "packaged"
      )
    ).toThrow("Explicit environment file does not exist");
    writeFileSync(paths.serverConfigPath, "[]");
    expect(() => resolveEffectiveRuntimeConfig(paths, {}, "packaged")).toThrow(
      "expected a JSON object"
    );
  });

  it("retains external service and Team privacy requirements without local services", () => {
    const result = calculateRuntimeRequirements(
      effective("external", "external", true)
    );
    expect(result).toEqual({
      components: ["base"],
      processes: ["api", "worker"],
      queue: "bullmq",
      native: [],
      models: []
    });
  });
});
