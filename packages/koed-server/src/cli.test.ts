import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveKoedServerPaths } from "./paths.js";
import {
  isKoedServerCliEntrypoint,
  runKoedServerCli,
  shouldExitPackagedSupervisor,
  startKoedServerDaemon
} from "./cli.js";
import type { KoedServerDoctorResult, KoedServerStatus } from "./types.js";

const writer = () => {
  let text = "";
  return {
    stream: { write: (chunk: string) => (text += chunk) } as never,
    text: () => text
  };
};

const status: KoedServerStatus = {
  ok: true,
  state: "healthy",
  koedHome: "/tmp/koed",
  generatedAt: "2026-01-01T00:00:00.000Z",
  runtimeMode: "developer",
  dependencyMode: "external",
  api: { state: "healthy", url: "http://localhost:3300" },
  database: { state: "healthy" },
  redis: { state: "healthy" },
  workerQueues: { state: "healthy" },
  embeddingService: { state: "healthy" },
  privacyService: { state: "healthy" },
  localAiRuntime: { state: "healthy" },
  apiToken: { state: "healthy", configured: true },
  mcpServer: { state: "healthy" },
  captureHook: { state: "healthy" },
  codexTranscriptWatcher: { state: "healthy" },
  claudeTranscriptWatcher: { state: "healthy" },
  codex: { state: "healthy", configured: true },
  claudeCode: { state: "healthy", configured: true, detected: true },
  pi: { state: "healthy", configured: true, detected: true },
  aiClients: {},
  aiClientInstances: {},
  aiClientFlowReadiness: {} as KoedServerStatus["aiClientFlowReadiness"],
  lcmSummaryService: { state: "healthy" },
  deviceIdentity: {
    state: "healthy",
    health: "healthy",
    deploymentId: "11111111-1111-4111-8111-111111111111",
    deviceInstanceId: "22222222-2222-4222-8222-222222222222",
    remoteOperationsAllowed: true,
    platformProtection: "verified"
  },
  upstreamBackends: {
    state: "healthy",
    registered: 0,
    validated: 0,
    stale: 0,
    failed: 0,
    notChecked: 0
  },
  lastVerification: { state: "healthy", checkedAt: "2026-01-01T00:00:00.000Z" },
  core: { state: "healthy", components: {} }
};

const doctor: KoedServerDoctorResult = {
  ok: false,
  state: "needs_attention",
  summary: "API is not ready",
  koedHome: "/tmp/koed",
  generatedAt: "2026-01-01T00:00:00.000Z",
  runtimeMode: "developer",
  dependencyMode: "external",
  checks: [{ id: "api", label: "API", state: "needs_attention" }]
};

const runtimeBinaries = () => ({
  initdb: { path: "/opt/homebrew/opt/postgresql@17/bin/initdb", exists: true },
  pg_ctl: { path: "/opt/homebrew/opt/postgresql@17/bin/pg_ctl", exists: true },
  psql: { path: "/opt/homebrew/opt/postgresql@17/bin/psql", exists: true },
  pg_dump: {
    path: "/opt/homebrew/opt/postgresql@17/bin/pg_dump",
    exists: true
  },
  pg_restore: {
    path: "/opt/homebrew/opt/postgresql@17/bin/pg_restore",
    exists: true
  },
  pg_config: {
    path: "/opt/homebrew/opt/postgresql@17/bin/pg_config",
    exists: true
  },
  llama_server: {
    path: "/opt/homebrew/opt/llama.cpp/bin/llama-server",
    exists: true
  }
});

describe("koed-server CLI entrypoint detection", () => {
  it("recognizes argv paths containing spaces", () => {
    const cliPath =
      "/Volumes/Koed 0.1.1-arm64/Koed.app/Contents/Resources/app.asar/node_modules/@koed/koed-server/dist/cli.js";

    expect(
      isKoedServerCliEntrypoint(pathToFileURL(cliPath).href, cliPath)
    ).toBe(true);
  });

  it("explicitly exits only the packaged long-running supervisor", () => {
    const environment = { KOED_PACKAGED_DESKTOP: "1" };

    expect(shouldExitPackagedSupervisor(["start"], environment)).toBe(true);
    expect(
      shouldExitPackagedSupervisor(["start", "--daemon"], environment)
    ).toBe(false);
    expect(
      shouldExitPackagedSupervisor(["status", "--json"], environment)
    ).toBe(false);
    expect(shouldExitPackagedSupervisor(["start"], {})).toBe(false);
  });
});

describe("koed-server detached supervisor", () => {
  it("redirects detached supervisor output to the Koed log directory", () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-daemon-log-test-"));
    const logsDir = resolve(koedHome, "logs");
    let unrefCalled = false;
    try {
      const result = startKoedServerDaemon({
        environment: { KOED_HOME: koedHome },
        startCommand: "/repo/dist/cli.js",
        resolvePaths: () => ({ koedHome, logsDir, repoRoot: "/repo" }) as never,
        spawn: ((
          _command: string,
          _args: readonly string[],
          options: { stdio?: unknown; env?: NodeJS.ProcessEnv }
        ) => {
          const stdio = options?.stdio as [string, number, number];
          expect(options.env?.KOED_SERVER_SUPERVISOR_LOG_PATH).toBe(
            resolve(logsDir, "supervisor.log")
          );
          writeSync(stdio[1], "supervisor stdout\n");
          writeSync(stdio[2], "supervisor stderr\n");
          return {
            pid: 42,
            unref: () => {
              unrefCalled = true;
            }
          } as never;
        }) as never
      });

      expect(result).toMatchObject({
        ok: true,
        startedPid: 42,
        logPath: resolve(logsDir, "supervisor.log")
      });
      expect(unrefCalled).toBe(true);
      expect(existsSync(result.logPath!)).toBe(true);
      expect(readFileSync(result.logPath!, "utf8")).toContain(
        "supervisor stdout\nsupervisor stderr"
      );
    } finally {
      rmSync(koedHome, { recursive: true, force: true });
    }
  });
});

describe("JSON command output", () => {
  it("prints models status --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["models", "status", "--json"], {
      stdout: stdout.stream,
      resolvePaths: () => ({ repoRoot: "/repo" }) as never,
      loadEnvironment: () => ({}),
      collectModelStatus: async () => ({
        state: "missing",
        message: "missing",
        action: "install",
        modelPath: "/tmp/model.gguf",
        manifest: {
          kind: "embedding",
          key: "qwen3-0.6b",
          filename: "model.gguf",
          modelPath: "/tmp/model.gguf",
          urlEnv: "KOED_EMBEDDING_MODEL_URL",
          sha256Env: "KOED_EMBEDDING_MODEL_SHA256",
          pathEnv: "KOED_EMBEDDING_MODEL_PATH"
        }
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      state: "missing",
      modelPath: "/tmp/model.gguf"
    });
  });

  it("prints models install --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["models", "install", "--json"], {
      stdout: stdout.stream,
      resolvePaths: () => ({ repoRoot: "/repo" }) as never,
      loadEnvironment: () => ({}),
      installModel: async () => ({
        ok: true,
        state: "installed",
        message: "installed",
        modelPath: "/tmp/model.gguf",
        manifest: {
          kind: "embedding",
          key: "qwen3-0.6b",
          filename: "model.gguf",
          modelPath: "/tmp/model.gguf",
          urlEnv: "KOED_EMBEDDING_MODEL_URL",
          sha256Env: "KOED_EMBEDDING_MODEL_SHA256",
          pathEnv: "KOED_EMBEDDING_MODEL_PATH"
        }
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "installed"
    });
  });

  it("passes repo .env values to model install commands", async () => {
    const stdout = writer();
    const seen: NodeJS.ProcessEnv[] = [];

    const exitCode = await runKoedServerCli(["models", "install", "--json"], {
      stdout: stdout.stream,
      resolvePaths: () => ({ repoRoot: "/repo" }) as never,
      loadEnvironment: () => ({
        KOED_EMBEDDING_MODEL_URL: "https://example.test/model.gguf",
        KOED_EMBEDDING_MODEL_SHA256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }),
      installModel: async (_paths, _kind, environment) => {
        seen.push(environment ?? {});
        return {
          ok: true,
          state: "installed",
          message: "installed",
          modelPath: "/tmp/model.gguf",
          manifest: {
            kind: "embedding",
            key: "qwen3-0.6b",
            filename: "model.gguf",
            modelPath: "/tmp/model.gguf",
            urlEnv: "KOED_EMBEDDING_MODEL_URL",
            sha256Env: "KOED_EMBEDDING_MODEL_SHA256",
            pathEnv: "KOED_EMBEDDING_MODEL_PATH"
          }
        };
      }
    });

    expect(exitCode).toBe(0);
    expect(seen[0]?.KOED_EMBEDDING_MODEL_URL).toBe(
      "https://example.test/model.gguf"
    );
  });

  it("prints runtime status --json without installing", async () => {
    const stdout = writer();
    let installed = false;

    const exitCode = await runKoedServerCli(
      ["runtime", "status", "--provider", "homebrew", "--json"],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        loadEnvironment: () => ({}),
        collectRuntimeStatus: () => ({
          ok: true,
          state: "installed",
          provider: "homebrew",
          platform: "darwin",
          koedHome: "/tmp/koed",
          homebrew: { installed: true, prefix: "/opt/homebrew" },
          packages: [],
          binaries: runtimeBinaries(),
          pgvector: { compatible: true, sqlPaths: [] },
          koedRuntime: {
            postgresBinDir: "/tmp/koed/runtime/postgres/bin",
            llamaServerBin: "/tmp/koed/runtime/llama.cpp/llama-server",
            metadataPath: "/tmp/koed/cache/runtime-homebrew.json",
            linked: true
          },
          message: "installed"
        }),
        installRuntime: () => {
          installed = true;
          throw new Error("must not install");
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(installed).toBe(false);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      provider: "homebrew"
    });
  });

  it("prints runtime install --json only for explicit bundled-local mode", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(
      [
        "runtime",
        "install",
        "--provider",
        "homebrew",
        "--dependency-mode",
        "bundled-local",
        "--json"
      ],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        loadEnvironment: () => ({}),
        installRuntime: () => ({
          ok: true,
          state: "installed",
          provider: "homebrew",
          platform: "darwin",
          koedHome: "/tmp/koed",
          homebrew: { installed: true, prefix: "/opt/homebrew" },
          packages: [],
          binaries: runtimeBinaries(),
          pgvector: { compatible: true, sqlPaths: [] },
          koedRuntime: {
            postgresBinDir: "/tmp/koed/runtime/postgres/bin",
            llamaServerBin: "/tmp/koed/runtime/llama.cpp/llama-server",
            metadataPath: "/tmp/koed/cache/runtime-homebrew.json",
            linked: true
          },
          message: "installed",
          installedPackages: [],
          linkedPaths: []
        })
      }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "installed"
    });
  });

  it("prints packaged runtime status --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(
      ["runtime", "status", "--provider", "packaged", "--json"],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        loadEnvironment: () => ({}),
        collectPackagedRuntimeStatus: () => ({
          ok: false,
          state: "missing",
          provider: "packaged",
          platform: "macos",
          architecture: "arm64",
          koedHome: "/tmp/koed",
          manifestPath: "/resources/koed-runtime/runtime-asset-manifest.json",
          packagedRuntimeRoot: "/resources/koed-runtime",
          assets: [],
          message: "missing"
        })
      }
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      provider: "packaged",
      state: "missing"
    });
  });

  it("prints team workspace link --json", async () => {
    const stdout = writer();
    const calls: Record<string, unknown>[] = [];

    const exitCode = await runKoedServerCli(
      [
        "team",
        "workspace",
        "link",
        "--project-root",
        "/repo/koed",
        "--team-workspace-id",
        "11111111-1111-4111-8111-111111111111",
        "--backend-id",
        "dev_backend",
        "--local-project-id",
        "lp_1111111111111111",
        "--project-display-name",
        "koed",
        "--json"
      ],
      {
        stdout: stdout.stream,
        resolvePaths: () =>
          ({ projectTeamWorkspaceLinksPath: "/tmp/links.json" }) as never,
        linkProjectTeamWorkspace: (_paths, input) => {
          calls.push(input);
          return {
            ok: true,
            state: "linked",
            message: "linked",
            link: {
              id: "ptw_test",
              projectRoot: input.projectRoot,
              teamWorkspaceId: input.teamWorkspaceId,
              backendId: input.backendId ?? null,
              remotePrincipalId: input.remotePrincipalId ?? null,
              deviceCredentialId: input.deviceCredentialId ?? null,
              localProjectId: input.localProjectId ?? null,
              projectDisplayName: input.projectDisplayName ?? null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z"
            }
          };
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(calls[0]).toMatchObject({
      projectRoot: "/repo/koed",
      teamWorkspaceId: "11111111-1111-4111-8111-111111111111",
      backendId: "dev_backend",
      localProjectId: "lp_1111111111111111",
      projectDisplayName: "koed"
    });
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "linked",
      link: { backendId: "dev_backend" }
    });
  });

  it("accepts --upstream-backend-id as a team workspace link alias", async () => {
    const stdout = writer();
    const calls: Record<string, unknown>[] = [];

    const exitCode = await runKoedServerCli(
      [
        "team",
        "workspace",
        "link",
        "--project-root",
        "/repo/koed",
        "--team-workspace-id",
        "11111111-1111-4111-8111-111111111111",
        "--upstream-backend-id",
        "dev_backend",
        "--json"
      ],
      {
        stdout: stdout.stream,
        resolvePaths: () =>
          ({ projectTeamWorkspaceLinksPath: "/tmp/links.json" }) as never,
        linkProjectTeamWorkspace: (_paths, input) => {
          calls.push(input);
          return {
            ok: true,
            state: "linked",
            message: "linked",
            link: {
              id: "ptw_test",
              projectRoot: input.projectRoot,
              teamWorkspaceId: input.teamWorkspaceId,
              backendId: input.backendId ?? null,
              remotePrincipalId: input.remotePrincipalId ?? null,
              deviceCredentialId: input.deviceCredentialId ?? null,
              localProjectId: input.localProjectId ?? null,
              projectDisplayName: input.projectDisplayName ?? null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z"
            }
          };
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(calls[0]).toMatchObject({
      projectRoot: "/repo/koed",
      teamWorkspaceId: "11111111-1111-4111-8111-111111111111",
      backendId: "dev_backend"
    });
  });

  it("does not expose the legacy Captured Session sharing command", async () => {
    const stderr = writer();

    const exitCode = await runKoedServerCli(
      ["team", "capture", "share-latest"],
      { stderr: stderr.stream }
    );

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("Unknown command");
  });

  it("prints packaged runtime install --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(
      [
        "runtime",
        "install",
        "--provider",
        "packaged",
        "--dependency-mode",
        "bundled-local",
        "--json"
      ],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        loadEnvironment: () => ({}),
        installPackagedRuntime: () => ({
          ok: true,
          state: "installed",
          provider: "packaged",
          platform: "macos",
          architecture: "arm64",
          koedHome: "/tmp/koed",
          manifestPath: "/resources/koed-runtime/runtime-asset-manifest.json",
          packagedRuntimeRoot: "/resources/koed-runtime",
          assets: [],
          message: "installed",
          copiedPaths: ["/tmp/koed/runtime/postgres"]
        })
      }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      provider: "packaged",
      state: "installed"
    });
  });

  it("prints package install --json", async () => {
    const stdout = writer();
    const seen: unknown[] = [];

    const exitCode = await runKoedServerCli(
      [
        "package",
        "install",
        "--source",
        "/tmp/koed-server.tar.gz",
        "--sha256",
        "a".repeat(64),
        "--activate",
        "--json"
      ],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ koedHome: "/tmp/koed" }) as never,
        installPackage: async (_paths, options) => {
          seen.push(options);
          return {
            ok: true,
            state: "activated",
            koedHome: "/tmp/koed",
            packageRoot: "/tmp/koed/runtime/koed-server",
            versionsDir: "/tmp/koed/runtime/koed-server/versions",
            cacheDir: "/tmp/koed/cache/koed-server-packages",
            currentPath: "/tmp/koed/runtime/koed-server/current",
            currentVersion: "0.2.0",
            installed: [],
            message: "installed",
            archivePath:
              "/tmp/koed/cache/koed-server-packages/koed-server.tar.gz",
            archiveSha256: "a".repeat(64),
            installedPath: "/tmp/koed/runtime/koed-server/versions/0.2.0"
          };
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(seen[0]).toEqual({
      source: "/tmp/koed-server.tar.gz",
      sha256: "a".repeat(64),
      sha256File: undefined,
      activate: true
    });
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "activated",
      currentVersion: "0.2.0"
    });
  });

  it("rejects runtime install without explicit bundled-local dependency mode", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(
      ["runtime", "install", "--provider", "packaged", "--json"],
      {
        stdout: stdout.stream,
        installPackagedRuntime: () => {
          throw new Error("must not install");
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      error: "runtime install requires --dependency-mode bundled-local."
    });
  });

  it("never installs packaged runtime assets in external dependency mode", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(
      [
        "runtime",
        "install",
        "--provider",
        "packaged",
        "--dependency-mode",
        "external",
        "--json"
      ],
      {
        stdout: stdout.stream,
        installPackagedRuntime: () => {
          throw new Error("must not install");
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      error: "runtime install requires --dependency-mode bundled-local."
    });
  });

  it("prints start --daemon --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["start", "--daemon", "--json"], {
      stdout: stdout.stream,
      startDaemon: () => ({
        ok: true,
        state: "starting",
        koedHome: "/tmp/koed",
        message: "Koed server daemon start requested.",
        startedPid: 42
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "starting",
      startedPid: 42
    });
  });

  it("prints stop --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["stop", "--json"], {
      stdout: stdout.stream,
      stop: () => ({
        ok: true,
        state: "healthy",
        koedHome: "/tmp/koed",
        message: "Koed server stop completed.",
        stoppedPids: [12, 11, 10],
        missingPids: [],
        stoppedServices: ["worker", "api"],
        missingServices: []
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      stoppedPids: [12, 11, 10]
    });
  });

  it("prints restart --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["restart", "--json"], {
      stdout: stdout.stream,
      restart: async () => ({
        ok: true,
        state: "starting",
        koedHome: "/tmp/koed",
        message: "Koed server restarted.",
        stoppedPids: [12, 11, 10],
        missingPids: [],
        stoppedServices: ["worker", "api"],
        missingServices: []
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      stoppedPids: [12, 11, 10]
    });
  });

  it("prints personal-sync status --json through koed-server", async () => {
    const stdout = writer();
    const calls: unknown[] = [];

    const exitCode = await runKoedServerCli(
      ["personal-sync", "status", "--json"],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ configDir: "/tmp/koed/config" }) as never,
        runPersonalSync: async (args, paths) => {
          calls.push({ args, paths });
          return {
            ok: true,
            state: "not_configured",
            message: "Association alone synchronizes nothing."
          };
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { args: ["status"], paths: { configDir: "/tmp/koed/config" } }
    ]);
    expect(JSON.parse(stdout.text())).toMatchObject({
      state: "not_configured",
      message: "Association alone synchronizes nothing."
    });
  });

  it("prints status --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["status", "--json"], {
      stdout: stdout.stream,
      collectStatus: async () => status
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "healthy"
    });
  });

  it("prints upstream list --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["upstream", "list", "--json"], {
      stdout: stdout.stream,
      resolvePaths: () => ({ repoRoot: "/repo" }) as never,
      listUpstreams: () => ({
        ok: true,
        state: "listed",
        message: "1 upstream backend(s) registered.",
        backends: [
          {
            id: "team-vps",
            displayName: "Team VPS",
            baseUrl: "https://team.example.test",
            profile: "private_vps",
            routePolicy: {
              personalCollaboration: "disabled",
              personalMemoryRead: "disabled",
              teamWorkspaceRead: "disabled",
              shareGrantManagement: "disabled",
              captureWrites: "disabled",
              sync: "disabled",
              managedExecution: "disabled",
              admin: "disabled"
            },
            credential: { status: "not_configured" },
            capabilities: {
              state: "not_checked",
              checkedAt: null,
              expiresAt: null,
              schemaVersion: null,
              profile: null,
              releaseVersion: null
            }
          }
        ]
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      backends: [{ id: "team-vps", credential: { status: "not_configured" } }]
    });
  });

  it("prints upstream register --json", async () => {
    const stdout = writer();
    const seen: unknown[] = [];

    const exitCode = await runKoedServerCli(
      [
        "upstream",
        "register",
        "--url",
        "https://team.example.test",
        "--id",
        "team-vps",
        "--name",
        "Team VPS",
        "--profile",
        "private-vps",
        "--json"
      ],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        registerUpstream: (_paths, input) => {
          seen.push(input);
          return {
            ok: true,
            state: "registered",
            message: "registered",
            backend: {
              id: "team-vps",
              displayName: "Team VPS",
              baseUrl: "https://team.example.test",
              profile: "private_vps",
              routePolicy: {
                personalCollaboration: "disabled",
                personalMemoryRead: "disabled",
                teamWorkspaceRead: "disabled",
                shareGrantManagement: "disabled",
                captureWrites: "disabled",
                sync: "disabled",
                managedExecution: "disabled",
                admin: "disabled"
              },
              credential: { status: "not_configured" },
              capabilities: {
                state: "not_checked",
                checkedAt: null,
                expiresAt: null,
                schemaVersion: null,
                profile: null,
                releaseVersion: null
              }
            }
          };
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(seen[0]).toEqual({
      url: "https://team.example.test",
      id: "team-vps",
      displayName: "Team VPS",
      profile: "private-vps"
    });
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "registered"
    });
  });

  it("prints upstream refresh failures as non-zero JSON", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(
      ["upstream", "refresh", "--id", "team-vps", "--json"],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        refreshUpstream: async () => ({
          ok: false,
          state: "failed",
          message: "failed",
          backend: {
            id: "team-vps",
            displayName: "Team VPS",
            baseUrl: "https://team.example.test",
            profile: "private_vps",
            routePolicy: {
              personalCollaboration: "disabled",
              personalMemoryRead: "disabled",
              teamWorkspaceRead: "disabled",
              shareGrantManagement: "disabled",
              captureWrites: "disabled",
              sync: "disabled",
              managedExecution: "disabled",
              admin: "disabled"
            },
            credential: { status: "not_configured" },
            capabilities: {
              state: "failed",
              checkedAt: "2026-01-01T00:00:00.000Z",
              expiresAt: null,
              schemaVersion: null,
              profile: null,
              releaseVersion: null,
              failureCategory: "network"
            }
          }
        })
      }
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      state: "failed",
      backend: {
        capabilities: { failureCategory: "network" }
      }
    });
  });

  it("selects the active upstream explicitly", async () => {
    const stdout = writer();
    const seen: string[] = [];

    const exitCode = await runKoedServerCli(
      ["upstream", "activate", "--id", "team-vps", "--json"],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        activateUpstream: (_paths, id) => {
          seen.push(id ?? "");
          return {
            ok: true,
            state: "updated",
            message: "selected"
          };
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(seen).toEqual(["team-vps"]);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "updated"
    });
  });

  it("prints upstream policy --json", async () => {
    const stdout = writer();
    const seen: unknown[] = [];

    const exitCode = await runKoedServerCli(
      [
        "upstream",
        "policy",
        "--id",
        "team-vps",
        "--team-workspace-read",
        "enabled",
        "--share-grant-management",
        "enabled",
        "--capture-writes",
        "disabled",
        "--json"
      ],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        updateUpstreamPolicy: (_paths, id, update) => {
          seen.push({ id, update });
          return {
            ok: true,
            state: "updated",
            message: "updated",
            backend: {
              id: "team-vps",
              displayName: "Team VPS",
              baseUrl: "https://team.example.test",
              profile: "private_vps",
              routePolicy: {
                personalCollaboration: "disabled",
                personalMemoryRead: "disabled",
                teamWorkspaceRead: "enabled",
                shareGrantManagement: "enabled",
                captureWrites: "disabled",
                sync: "disabled",
                managedExecution: "disabled",
                admin: "disabled"
              },
              credential: { status: "not_configured" },
              capabilities: {
                state: "validated",
                checkedAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2026-01-01T01:00:00.000Z",
                schemaVersion: 3,
                profile: "private_vps",
                releaseVersion: "0.2.0"
              }
            }
          };
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(seen[0]).toEqual({
      id: "team-vps",
      update: {
        teamWorkspaceRead: "enabled",
        shareGrantManagement: "enabled",
        captureWrites: "disabled"
      }
    });
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      backend: {
        routePolicy: {
          teamWorkspaceRead: "enabled",
          shareGrantManagement: "enabled",
          captureWrites: "disabled"
        }
      }
    });
  });

  it("prints upstream remove --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(
      ["upstream", "remove", "--id", "team-vps", "--json"],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        removeUpstream: () => ({
          ok: true,
          state: "removed",
          message: "removed"
        })
      }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "removed"
    });
  });

  it("prints upstream enroll start --json", async () => {
    const stdout = writer();
    const seen: unknown[] = [];

    const exitCode = await runKoedServerCli(
      ["upstream", "enroll", "start", "--id", "team-vps", "--json"],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        startUpstreamEnroll: async (_paths, id) => {
          seen.push(id);
          return {
            ok: true,
            state: "pending",
            message: "started",
            enrollment: {
              backendId: "team-vps",
              requestId: "enroll-1",
              state: "pending",
              activationUrl: null,
              requestedOperationFamilies: ["team_workspace_read"],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              expiresAt: "2026-01-01T00:10:00.000Z",
              credential: { status: "not_configured" }
            }
          };
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(seen).toEqual(["team-vps"]);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "pending",
      enrollment: {
        activationUrl: null
      }
    });
  });

  it("prints upstream enroll status --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(
      ["upstream", "enroll", "status", "--id", "team-vps", "--json"],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        getUpstreamEnrollStatus: async () => ({
          ok: true,
          state: "exchanged",
          message: "exchanged",
          enrollment: {
            backendId: "team-vps",
            requestId: "enroll-1",
            state: "exchanged",
            activationUrl: null,
            requestedOperationFamilies: ["team_workspace_read"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z",
            expiresAt: "2026-01-01T00:10:00.000Z",
            credential: { status: "configured", reference: "keychain://team" }
          }
        })
      }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "exchanged",
      enrollment: {
        credential: { status: "configured", reference: "keychain://team" }
      }
    });
  });

  it("prints upstream enroll cancel --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(
      ["upstream", "enroll", "cancel", "--id", "team-vps", "--json"],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        cancelUpstreamEnroll: async () => ({
          ok: true,
          state: "canceled",
          message: "canceled"
        })
      }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "canceled"
    });
  });

  it("prints project discover --json", async () => {
    const stdout = writer();
    const seen: unknown[] = [];

    const exitCode = await runKoedServerCli(
      ["project", "discover", "--cwd", "/repo/koed", "--codex", "--json"],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        discoverProjectMetadata: async (_paths, input) => {
          seen.push(input);
          return {
            ok: true,
            state: "discovered",
            message: "Project metadata discovered.",
            project: {
              schemaVersion: 1,
              discoveredAt: "2026-01-01T00:00:00.000Z",
              lastSeenAt: "2026-01-01T00:00:00.000Z",
              localProjectId: "lp_1111111111111111",
              displayName: "koed",
              path: {
                cwd: "/repo/koed",
                projectRoot: "/repo/koed",
                basename: "koed",
                localPathHash: "hmac_sha256:abc"
              },
              packages: []
            }
          };
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(seen).toEqual([{ cwd: "/repo/koed", aiClientSource: "codex" }]);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "discovered",
      project: { localProjectId: "lp_1111111111111111" }
    });
  });

  it("prints project list --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["project", "list", "--json"], {
      stdout: stdout.stream,
      resolvePaths: () => ({ repoRoot: "/repo" }) as never,
      listProjectMetadata: () => ({
        ok: true,
        state: "listed",
        message: "listed",
        projects: []
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "listed",
      projects: []
    });
  });

  it("prints upstream disconnect --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(
      ["upstream", "disconnect", "--id", "team-vps", "--json"],
      {
        stdout: stdout.stream,
        resolvePaths: () => ({ repoRoot: "/repo" }) as never,
        disconnectUpstream: async () => ({
          ok: true,
          state: "revoked",
          message: "revoked",
          enrollment: {
            backendId: "team-vps",
            requestId: "enroll-1",
            state: "revoked",
            activationUrl: null,
            requestedOperationFamilies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:02:00.000Z",
            expiresAt: null,
            credential: { status: "revoked" }
          }
        })
      }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      state: "revoked",
      enrollment: { credential: { status: "revoked" } }
    });
  });

  it("persists doctor success and failure metadata under injected temp KOED_HOME", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-cli-doctor-"));
    try {
      const paths = resolveKoedServerPaths({ KOED_HOME: root });
      const success = { ...doctor, ok: true, summary: "All checks passed." };
      expect(
        await runKoedServerCli(["doctor", "--json"], {
          stdout: writer().stream,
          resolvePaths: () => paths,
          collectDoctor: async () => success
        })
      ).toBe(0);
      expect(
        JSON.parse(readFileSync(paths.lastVerificationPath, "utf8"))
      ).toMatchObject({
        ok: true,
        message: "All checks passed."
      });

      expect(
        await runKoedServerCli(["doctor", "--json"], {
          stdout: writer().stream,
          resolvePaths: () => paths,
          collectDoctor: async () => doctor
        })
      ).toBe(1);
      expect(
        JSON.parse(readFileSync(paths.lastVerificationPath, "utf8"))
      ).toMatchObject({
        ok: false,
        message: "API is not ready"
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints doctor --json and returns non-zero for failures", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["doctor", "--json"], {
      stdout: stdout.stream,
      collectDoctor: async () => doctor
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      summary: "API is not ready"
    });
  });

  it("prints redacted device identity JSON", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["identity", "status", "--json"], {
      stdout: stdout.stream,
      resolvePaths: () => ({ koedHome: "/tmp/koed" }) as never,
      inspectDeviceIdentity: async () =>
        ({
          health: "healthy",
          deploymentId: "11111111-1111-4111-8111-111111111111",
          deviceInstanceId: "22222222-2222-4222-8222-222222222222",
          remoteOperationsAllowed: true,
          platformProtection: "verified",
          message: "Device identity proof is verified.",
          initialized: false,
          rotated: false
        }) as never
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain("host-proof://");
    expect(stdout.text()).not.toContain("raw-proof");
    expect(JSON.parse(stdout.text())).toMatchObject({
      health: "healthy",
      remoteOperationsAllowed: true
    });
  });

  it("awaits setup codex before printing JSON result", async () => {
    const stdout = writer();
    let completed = false;
    const exitCode = await runKoedServerCli(["setup", "codex", "--json"], {
      stdout: stdout.stream,
      setupCodex: async () => {
        await Promise.resolve();
        completed = true;
        return {
          ok: true,
          state: "healthy",
          koedHome: "/tmp/koed",
          apiUrl: "http://localhost:3300",
          checkedAt: "2026-01-01T00:00:00.000Z",
          command: "codex setup"
        };
      }
    });

    expect(exitCode).toBe(0);
    expect(completed).toBe(true);
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: true });
  });

  it("prints setup claude --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["setup", "claude", "--json"], {
      stdout: stdout.stream,
      setupClaude: () => ({
        ok: true,
        state: "healthy",
        koedHome: "/tmp/koed",
        checkedAt: "2026-01-01T00:00:00.000Z",
        command: "claude mcp add --scope user koed",
        settingsPath: "/tmp/.claude/settings.json"
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      settingsPath: "/tmp/.claude/settings.json"
    });
  });

  it("dispatches check, repair, and remove for every AI Client with exit status", async () => {
    const capabilityIds = [
      "automatic_capture",
      "mcp_recall",
      "local_synthesis"
    ] as const;
    const readiness = (driverId: "codex" | "claude" | "pi") => ({
      driverId,
      instanceId: `${driverId}.default`,
      displayName: driverId,
      installed: { state: "healthy" as const },
      version: "1.0.0",
      authentication: "authenticated" as const,
      profile: { state: "healthy" as const },
      capabilities: capabilityIds.map((id) => ({
        id,
        support: "supported" as const,
        readiness: "ready" as const,
        diagnostics: []
      })),
      observedAt: "2026-01-01T00:00:00.000Z",
      snapshotState: "current" as const
    });
    const checkStatus = {
      ...status,
      aiClients: {
        codex: readiness("codex"),
        claude: readiness("claude"),
        pi: readiness("pi")
      }
    };
    const result = {
      ok: true,
      state: "healthy" as const,
      koedHome: "/tmp/koed",
      checkedAt: "2026-01-01T00:00:00.000Z",
      command: "client operation"
    };
    for (const client of ["codex", "claude", "pi"] as const) {
      const checkOutput = writer();
      expect(
        await runKoedServerCli(["check", client, "--json"], {
          stdout: checkOutput.stream,
          collectStatus: async () => checkStatus
        })
      ).toBe(0);
      expect((JSON.parse(checkOutput.text()) as { state?: string }).state).toBe(
        "healthy"
      );

      const repairOutput = writer();
      const repairKey = client === "codex" ? "repairCodex" : undefined;
      expect(
        await runKoedServerCli(["repair", client, "--json"], {
          stdout: repairOutput.stream,
          ...(repairKey ? { repairCodex: () => result } : {}),
          ...(client === "claude" ? { setupClaude: () => result } : {}),
          ...(client === "pi" ? { setupPi: () => result } : {})
        } as never)
      ).toBe(0);

      const removeOutput = writer();
      expect(
        await runKoedServerCli(["remove", client, "--json"], {
          stdout: removeOutput.stream,
          ...(client === "codex" ? { removeCodex: () => result } : {}),
          ...(client === "claude" ? { removeClaude: () => result } : {}),
          ...(client === "pi" ? { removePi: () => result } : {})
        } as never)
      ).toBe(0);
    }
  });

  it("returns failed check contract for stale readiness", async () => {
    const stdout = writer();
    const staleStatus = {
      ...status,
      aiClients: {
        codex: {
          driverId: "codex",
          instanceId: "codex.default",
          displayName: "Codex",
          installed: { state: "healthy" },
          version: "1.0.0",
          authentication: "authenticated",
          profile: { state: "healthy" },
          capabilities: [
            "automatic_capture",
            "mcp_recall",
            "local_synthesis"
          ].map((id) => ({
            id,
            support: "supported",
            readiness: "stale",
            diagnostics: []
          })),
          observedAt: "2026-01-01T00:00:00.000Z",
          snapshotState: "stale"
        }
      }
    } as never;

    const exitCode = await runKoedServerCli(["check", "codex", "--json"], {
      stdout: stdout.stream,
      collectStatus: async () => staleStatus
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      client: "codex",
      readiness: { snapshotState: "stale" }
    });
  });

  it("prints repair codex --json", async () => {
    const stdout = writer();

    const exitCode = await runKoedServerCli(["repair", "codex", "--json"], {
      stdout: stdout.stream,
      repairCodex: () => ({
        ok: true,
        state: "healthy",
        koedHome: "/tmp/koed",
        apiUrl: "http://localhost:43300",
        checkedAt: "2026-01-01T00:00:00.000Z",
        command: "node scripts/configure-codex.mjs"
      })
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      apiUrl: "http://localhost:43300"
    });
  });

  it("passes the persistent Codex memory-guidance opt-out to setup", async () => {
    const stdout = writer();
    let configuredValue: string | undefined;

    const exitCode = await runKoedServerCli(
      ["setup", "codex", "--without-memory-guidance", "--json"],
      {
        stdout: stdout.stream,
        setupCodex: async (options = {}) => {
          configuredValue =
            options.environment?.KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED;
          return {
            ok: true,
            state: "healthy",
            koedHome: "/tmp/koed",
            apiUrl: "http://localhost:3300",
            checkedAt: "2026-01-01T00:00:00.000Z",
            command: "node scripts/clients-bootstrap.mjs"
          };
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(configuredValue).toBe("false");
  });
});
