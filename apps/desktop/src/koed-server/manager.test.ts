import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  PERSONAL_DESKTOP_CONTRACT_VERSION,
  storeDesktopLocalCredential
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import {
  configureDetectedSetupAiClients,
  createKoedEnvironment,
  createKoedServerManager,
  detectedSetupAiClients,
  desktopCodexSetupCommand,
  personalMemoryChangeFromSseFrame,
  setupStartupReady,
  setupServicesHealthy,
  setupIntegrationHealthy
} from "./manager.js";

type FakeChildProcess = EventEmitter & {
  killed: boolean;
  kill: (signal?: string) => boolean;
};

const childProcess = (): FakeChildProcess => {
  const child = new EventEmitter() as FakeChildProcess;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
};

const healthyLocalServiceStatus = () => ({
  ok: true,
  state: "healthy",
  api: { state: "healthy" },
  database: { state: "healthy" },
  redis: { state: "healthy" },
  workerQueues: { state: "healthy" },
  embeddingService: { state: "healthy" },
  apiToken: { state: "healthy" }
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not met within 1000ms");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("Koed server desktop manager", () => {
  it("persists and restarts after changing hardware acceleration", async () => {
    const koedHome = mkdtempSync(
      resolve(tmpdir(), "koed-desktop-acceleration-")
    );
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    const calls: string[][] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {
        KOED_HOME: koedHome,
        DATABASE_URL: "postgres://operator-secret@database/koed"
      },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        callback(
          null,
          JSON.stringify(
            args.includes("status")
              ? healthyLocalServiceStatus()
              : { ok: true, state: "healthy" }
          ),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.hardwareAcceleration.get()).resolves.toEqual({
      enabled: true,
      managedByEnvironment: false
    });
    await expect(manager.hardwareAcceleration.set(false)).resolves.toEqual({
      enabled: false,
      managedByEnvironment: false
    });
    expect(calls.some((args) => args.includes("restart"))).toBe(true);
    const persisted = readFileSync(
      resolve(koedHome, "config/server.json"),
      "utf8"
    );
    expect(JSON.parse(persisted)).toMatchObject({
      hardwareAcceleration: "cpu"
    });
    expect(persisted).not.toContain("operator-secret");
    rmSync(koedHome, { recursive: true, force: true });
  });

  it("does not override Operator-managed hardware acceleration", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {
        KOED_HOME: "/tmp/koed-managed-acceleration",
        KOED_EMBEDDING_ACCELERATION: "cuda"
      },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: {}
      }),
      existsSync: () => true,
      execFile: () => undefined,
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.hardwareAcceleration.get()).resolves.toEqual({
      enabled: true,
      managedByEnvironment: true
    });
    await expect(manager.hardwareAcceleration.set(false)).rejects.toThrow(
      "managed by the Operator environment"
    );
  });

  it("treats a Privacy Service provider as an Operator override", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {
        KOED_HOME: "/tmp/koed-managed-privacy-acceleration",
        PRIVACY_RUNTIME_PROVIDER: "cuda"
      },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: {}
      }),
      existsSync: () => true,
      execFile: () => undefined,
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.hardwareAcceleration.get()).resolves.toEqual({
      enabled: true,
      managedByEnvironment: true
    });
    await expect(manager.hardwareAcceleration.set(false)).rejects.toThrow(
      "managed by the Operator environment"
    );
  });

  it("treats a repository environment acceleration policy as Operator-managed", async () => {
    const repoRoot = mkdtempSync(resolve(tmpdir(), "koed-desktop-repo-env-"));
    const koedHome = mkdtempSync(
      resolve(tmpdir(), "koed-desktop-repo-env-home-")
    );
    writeFileSync(
      resolve(repoRoot, ".env"),
      "KOED_EMBEDDING_ACCELERATION=cpu\n"
    );
    const manager = createKoedServerManager({
      repoRoot,
      cliPath: resolve(repoRoot, "cli.js"),
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: [resolve(repoRoot, "cli.js"), ...args],
        env: {}
      }),
      existsSync: () => true,
      execFile: () => undefined,
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.hardwareAcceleration.get()).resolves.toEqual({
      enabled: true,
      managedByEnvironment: true
    });
    await expect(manager.hardwareAcceleration.set(true)).rejects.toThrow(
      "managed by the Operator environment"
    );
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(koedHome, { recursive: true, force: true });
  });

  it("allows a cold-start status inspection to use the two-minute budget", async () => {
    let timeout: number | undefined;
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, options, callback) => {
        if (args[1] === "status") timeout = options.timeout;
        callback(null, JSON.stringify(healthyLocalServiceStatus()), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await manager.handlers.status!();

    expect(timeout).toBe(120_000);
  });

  it("does not require the privacy model for Personal-only Desktop", async () => {
    const calls: string[][] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_TEAM_COLLABORATION_ENABLED: "false" },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        callback(null, JSON.stringify({ ok: true, state: "installed" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await manager.handlers.models_status!();
    await manager.handlers.models_install!();
    expect(calls.every((args) => !args.includes("privacy"))).toBe(true);
    expect(calls.filter((args) => args.includes("embedding"))).toHaveLength(2);
  });

  it("routes optional AI Client setup and repair through idempotent Koed Server commands", async () => {
    const invocations: string[][] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => {
        invocations.push(args);
        return {
          command: "/node",
          args: ["/repo/cli.js", ...args],
          env: { KOED_REPO_ROOT: "/repo" }
        };
      },
      existsSync: () => true,
      execFile: (_command, _args, _options, callback) => {
        callback(null, JSON.stringify({ ok: true, state: "healthy" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await manager.handlers.setup_pi!();
    await manager.handlers.repair_pi!();
    await manager.handlers.setup_claude!();
    await manager.handlers.repair_claude!();

    expect(invocations).toEqual([
      ["setup", "pi", "--json"],
      ["repair", "pi", "--json"],
      ["setup", "claude", "--json"],
      ["repair", "claude", "--json"]
    ]);
  });

  it("requires explicit healthy result from AI Client check handlers", async () => {
    const invocations: string[][] = [];
    let healthy = false;
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => {
        invocations.push(args);
        return {
          command: "/node",
          args: ["/repo/cli.js", ...args],
          env: { KOED_REPO_ROOT: "/repo" }
        };
      },
      existsSync: () => true,
      execFile: (_command, _args, _options, callback) => {
        callback(
          null,
          JSON.stringify(
            healthy
              ? { ok: true, state: "healthy" }
              : {
                  ok: false,
                  state: "needs_attention",
                  message: "stale snapshot"
                }
          ),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.check_codex!()).rejects.toThrow(
      "stale snapshot"
    );
    healthy = true;
    await expect(manager.handlers.check_codex!()).resolves.toMatchObject({
      ok: true
    });
    expect(invocations).toEqual([
      ["check", "codex", "--json"],
      ["check", "codex", "--json"]
    ]);
  });

  it("throws actionable errors when mutating AI Client commands return failure", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, _args, _options, callback) => {
        callback(
          null,
          JSON.stringify({
            ok: false,
            error: "registry failed",
            action: "repair registry"
          }),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.remove_claude!()).rejects.toThrow(
      "registry failed"
    );
  });

  it("includes detected optional AI Clients in first-run integration readiness", () => {
    const status = {
      apiToken: { state: "healthy" },
      mcpServer: { state: "healthy" },
      captureHook: { state: "healthy" },
      lcmSummaryService: { state: "healthy" },
      codex: { state: "healthy", configured: true },
      claudeCode: { state: "not_configured", detected: true },
      pi: { state: "healthy", detected: true }
    };

    expect(detectedSetupAiClients(status).map(({ label }) => label)).toEqual([
      "Codex",
      "Claude Code",
      "Pi"
    ]);
    expect(setupIntegrationHealthy(status)).toBe(true);
    expect(
      setupIntegrationHealthy({
        ...status,
        claudeCode: { state: "healthy", detected: true }
      })
    ).toBe(true);
  });

  it("automatically configures every detected, incomplete AI Client", async () => {
    const run = vi.fn(async (args: string[]) => {
      void args;
      return { ok: true, state: "healthy" };
    });
    const progress: string[] = [];

    const result = await configureDetectedSetupAiClients(
      {
        apiToken: { state: "healthy" },
        codex: { state: "not_configured" },
        claudeCode: { state: "not_configured", detected: true },
        pi: { state: "not_configured", detected: true }
      },
      run,
      (message) => progress.push(message)
    );

    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["setup", "claude"],
      ["setup", "pi"]
    ]);
    expect(progress).toEqual([
      "Configuring Claude Code capture and recall…",
      "Configuring Pi capture and recall…"
    ]);
    expect(result).toEqual({
      ok: true,
      message: "Claude Code and Pi integrations are configured."
    });
  });

  it("treats local services as ready before later setup stages finish", () => {
    expect(
      setupServicesHealthy({
        ok: false,
        state: "needs_attention",
        api: { state: "healthy" },
        database: { state: "healthy" },
        redis: { state: "healthy" },
        workerQueues: { state: "healthy" },
        embeddingService: { state: "healthy" },
        codex: { state: "needs_attention" },
        lastVerification: { state: "not_configured" }
      })
    ).toBe(true);
    expect(
      setupServicesHealthy({
        api: { state: "healthy" },
        database: { state: "needs_attention" },
        redis: { state: "healthy" },
        workerQueues: { state: "healthy" },
        embeddingService: { state: "healthy" }
      })
    ).toBe(false);
  });

  it("waits for every local service and the Desktop credential before setup advances", () => {
    const starting = {
      api: { state: "healthy" },
      database: { state: "healthy" },
      redis: { state: "healthy" },
      workerQueues: { state: "starting" },
      embeddingService: { state: "healthy" },
      apiToken: { state: "healthy" }
    };
    expect(setupStartupReady(starting)).toBe(false);
    expect(
      setupStartupReady({
        ...starting,
        workerQueues: { state: "healthy" }
      })
    ).toBe(true);
    expect(
      setupStartupReady({
        ...starting,
        workerQueues: { state: "healthy" },
        apiToken: { state: "not_configured" }
      })
    ).toBe(false);
  });

  it("repairs Codex directly after Desktop provisions its scoped API Token", () => {
    expect(
      desktopCodexSetupCommand({
        apiToken: { state: "healthy" },
        codex: { state: "not_configured" }
      })
    ).toEqual(["repair", "codex"]);
    expect(
      desktopCodexSetupCommand({
        apiToken: { state: "not_configured" },
        codex: { state: "not_configured" }
      })
    ).toEqual(["setup", "codex"]);
  });

  it("accepts only bounded, valid Personal Memory graph changes", () => {
    const valid =
      "event: graph_update\n" +
      `data: ${JSON.stringify({
        eventRefs: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            projectId: "project-1",
            threadId: "thread-1"
          },
          {
            id: "00000000-0000-4000-8000-000000000001",
            projectId: "project-1",
            threadId: "thread-1"
          }
        ]
      })}`;
    expect(personalMemoryChangeFromSseFrame(valid)).toEqual({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          projectId: "project-1",
          threadId: "thread-1"
        }
      ]
    });
    expect(
      personalMemoryChangeFromSseFrame(
        `event: graph_update\ndata: ${JSON.stringify({
          table: "memory_events",
          operation: "INSERT",
          id: "00000000-0000-4000-8000-000000000002",
          projectId: "project-1",
          threadId: "thread-1"
        })}`
      )
    ).toMatchObject({
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          projectId: "project-1",
          threadId: "thread-1"
        }
      ]
    });
    expect(
      personalMemoryChangeFromSseFrame("event: heartbeat\ndata: {}")
    ).toBeNull();
    expect(
      personalMemoryChangeFromSseFrame("event: graph_update\ndata: not-json")
    ).toBeNull();
    expect(
      personalMemoryChangeFromSseFrame(
        `event: graph_update\ndata: ${JSON.stringify({
          eventRefs: [
            { id: "bad", projectId: "project-1", threadId: "thread-1" }
          ]
        })}`
      )
    ).toBeNull();
  });

  it("adds KOED_REPO_ROOT without overriding explicit values", () => {
    expect(createKoedEnvironment("/repo", {})).toMatchObject({
      KOED_REPO_ROOT: "/repo"
    });
    expect(
      createKoedEnvironment("/repo", { KOED_REPO_ROOT: "/custom" })
    ).toMatchObject({
      KOED_REPO_ROOT: "/custom"
    });
  });

  it("enables automatic local ports for source Desktop bundled-local runs", () => {
    expect(
      createKoedEnvironment("/repo", { KOED_DEPENDENCY_MODE: "bundled-local" })
    ).toMatchObject({
      KOED_REPO_ROOT: "/repo",
      KOED_AUTO_PORTS: "1"
    });
  });

  it("uses managed-local defaults when environment values are blank", () => {
    expect(
      createKoedEnvironment(
        "/repo",
        {
          KOED_RUNTIME_MODE: " ",
          KOED_DEPENDENCY_MODE: " ",
          KOED_TEAM_COLLABORATION_ENABLED: " ",
          WORK_QUEUE_BACKEND: " ",
          KOED_AUTO_PORTS: " "
        },
        { desktopManagedLocal: true }
      )
    ).toMatchObject({
      KOED_RUNTIME_MODE: "local-personal",
      KOED_DEPENDENCY_MODE: "bundled-local",
      KOED_TEAM_COLLABORATION_ENABLED: "true",
      WORK_QUEUE_BACKEND: "local",
      KOED_AUTO_PORTS: "1"
    });
  });

  it("defaults packaged Desktop managed local server to bundled-local", () => {
    const packagedEnvironment = createKoedEnvironment(
      "/repo",
      {},
      {
        desktopManagedLocal: true,
        packagedDesktop: true,
        packagedResourcesPath: "/resources"
      }
    );
    expect(packagedEnvironment).toMatchObject({
      KOED_RUNTIME_MODE: "local-personal",
      KOED_DEPENDENCY_MODE: "bundled-local",
      KOED_TEAM_COLLABORATION_ENABLED: "true",
      WORK_QUEUE_BACKEND: "local",
      KOED_AUTO_PORTS: "1",
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: "/resources"
    });
    expect(packagedEnvironment).not.toHaveProperty("KOED_REPO_ROOT");
    expect(
      createKoedEnvironment(
        "/repo",
        {
          KOED_RUNTIME_MODE: "external",
          KOED_DEPENDENCY_MODE: "external",
          KOED_TEAM_COLLABORATION_ENABLED: "false",
          WORK_QUEUE_BACKEND: "bullmq"
        },
        { desktopManagedLocal: true }
      )
    ).toMatchObject({
      KOED_RUNTIME_MODE: "external",
      KOED_DEPENDENCY_MODE: "external",
      KOED_TEAM_COLLABORATION_ENABLED: "false",
      WORK_QUEUE_BACKEND: "bullmq"
    });
  });

  it("gives source-checkout Desktop the local-edge defaults without packaged flags", () => {
    const sourceEnvironment = createKoedEnvironment(
      "/repo",
      {},
      { desktopManagedLocal: true }
    );
    expect(sourceEnvironment).toMatchObject({
      KOED_REPO_ROOT: "/repo",
      KOED_RUNTIME_MODE: "local-personal",
      KOED_DEPENDENCY_MODE: "bundled-local",
      KOED_TEAM_COLLABORATION_ENABLED: "true",
      WORK_QUEUE_BACKEND: "local",
      KOED_AUTO_PORTS: "1"
    });
    expect(sourceEnvironment).not.toHaveProperty("KOED_PACKAGED_DESKTOP");
    expect(sourceEnvironment).not.toHaveProperty(
      "KOED_PACKAGED_RESOURCES_PATH"
    );
  });

  it("does not enable Team collaboration for non-Desktop server environments", () => {
    expect(createKoedEnvironment("/repo", {})).not.toHaveProperty(
      "KOED_TEAM_COLLABORATION_ENABLED"
    );
  });

  it("runs JSON koed-server commands", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/packages/koed-server/dist/cli.js",
      environment: { PDS_DESKTOP_SECRET_STORAGE: "native_os" },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/packages/koed-server/dist/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (command, args, _options, callback) => {
        calls.push({ command, args });
        callback(null, JSON.stringify({ ok: true, state: "healthy" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.status!()).resolves.toMatchObject({
      ok: true,
      state: "healthy",
      personalDeviceSync: {
        state: "healthy",
        message:
          "Secure device storage is available through the operating system."
      }
    });
    expect(calls.slice(0, 2)).toEqual(
      expect.arrayContaining([
        {
          command: "/node",
          args: ["/repo/packages/koed-server/dist/cli.js", "status", "--json"]
        },
        {
          command: "/node",
          args: [
            "/repo/packages/koed-server/dist/cli.js",
            "package",
            "status",
            "--json"
          ]
        }
      ])
    );

    await expect(manager.handlers.project_list!()).resolves.toMatchObject({
      ok: true
    });
    expect(calls[2]).toEqual({
      command: "/node",
      args: [
        "/repo/packages/koed-server/dist/cli.js",
        "project",
        "list",
        "--json"
      ]
    });

    await expect(
      manager.handlers.personal_sync_revoke!({
        deviceId: "device_redacted",
        groupId: "group_redacted"
      })
    ).resolves.toMatchObject({ ok: true });
    expect(calls.slice(3)).toEqual([
      {
        command: "/node",
        args: [
          "/repo/packages/koed-server/dist/cli.js",
          "personal-sync",
          "device",
          "revoke",
          "--group-id",
          "group_redacted",
          "--device-id",
          "device_redacted",
          "--json"
        ]
      }
    ]);
  });

  it("runs redacted Personal Sync controls through main-process CLI", async () => {
    const calls: string[][] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        callback(null, JSON.stringify({ ok: true, state: "paused" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await manager.handlers.personal_sync_pause!({ groupId: "group_one" });
    await manager.handlers.personal_sync_resume!({ groupId: "group_one" });
    await manager.handlers.personal_sync_retry!({ groupId: "group_one" });
    await manager.handlers.personal_sync_join_request!({
      groupId: "group_one"
    });
    await manager.handlers.personal_sync_revoke!({
      deviceId: "device_one",
      groupId: "group_one"
    });
    expect(calls).toEqual([
      [
        "/repo/cli.js",
        "personal-sync",
        "policy",
        "pause",
        "--group-id",
        "group_one",
        "--json"
      ],
      [
        "/repo/cli.js",
        "personal-sync",
        "policy",
        "resume",
        "--group-id",
        "group_one",
        "--json"
      ],
      [
        "/repo/cli.js",
        "personal-sync",
        "retry",
        "--group-id",
        "group_one",
        "--json"
      ],
      [
        "/repo/cli.js",
        "personal-sync",
        "join",
        "request",
        "--group-id",
        "group_one",
        "--json"
      ],
      [
        "/repo/cli.js",
        "personal-sync",
        "device",
        "revoke",
        "--group-id",
        "group_one",
        "--device-id",
        "device_one",
        "--json"
      ]
    ]);
    expect(manager.handlers.personal_sync_revoke!({})).toEqual({
      ok: false,
      error: "deviceId is required."
    });
  });

  it("retains the API Token in main and rereads supervisor rotation after a 401", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-manager-"));
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "stale_token" })
    );
    const calls: string[][] = [];
    const personalMemoryFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        writeFileSync(
          resolve(koedHome, "config/local-app-credential.json"),
          JSON.stringify({ apiToken: "fresh_token" })
        );
        return new Response(null, { status: 401 });
      })
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome, KOED_AUTO_PORTS: "1" },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: koedHome, KOED_AUTO_PORTS: "1" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        if (args.includes("status")) {
          callback(
            null,
            JSON.stringify({
              ok: true,
              api: { state: "healthy", url: "http://127.0.0.1:4170" }
            }),
            ""
          );
          return;
        }
        callback(null, JSON.stringify({ ok: true }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      personalMemoryFetch
    });

    await expect(
      manager.personalMemory({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.projects.list",
        input: {}
      })
    ).resolves.toEqual({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.projects.list",
      ok: true,
      data: { projects: [] }
    });
    expect(manager.handlers).not.toHaveProperty("explorer_credential");
    expect(calls.some((args) => args.includes("api-token:create"))).toBe(false);
    expect(personalMemoryFetch).toHaveBeenCalledTimes(2);
    expect(
      new Headers(personalMemoryFetch.mock.calls[0]?.[1]?.headers).get(
        "authorization"
      )
    ).toBe("Bearer stale_token");
    expect(
      new Headers(personalMemoryFetch.mock.calls[1]?.[1]?.headers).get(
        "authorization"
      )
    ).toBe("Bearer fresh_token");
    expect(JSON.stringify(personalMemoryFetch.mock.results)).not.toContain(
      "fresh_token"
    );
    expect(
      JSON.parse(
        readFileSync(
          resolve(koedHome, "config/local-app-credential.json"),
          "utf8"
        )
      )
    ).toMatchObject({ apiToken: "fresh_token" });
  });

  it("suppresses an approval-review guardian session when its parent Conversation is present", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-manager-"));
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "personal_token" })
    );
    const parentThreadId = "019fd15a-eaf3-7ea3-94e3-451dac881974";
    const thread = (overrides: Record<string, unknown>) => ({
      id: parentThreadId,
      name: "Formatting parity conversation",
      sessionId: "00000000-0000-4000-8000-000000000001",
      sourceAiClient: "codex-cli",
      projectId: "project-1",
      projectName: "koed",
      projectPath: "/repo",
      projectAssignmentSource: "detected",
      eventCount: 3,
      invalidatedCount: 0,
      latestAt: "2026-08-05T12:00:00.000Z",
      sample: "Use the hook-style renderer.",
      threadKind: "conversation",
      parentThreadId: null,
      parentSessionId: null,
      ...overrides
    });
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        callback(
          null,
          JSON.stringify(
            args.includes("status")
              ? {
                  ok: true,
                  api: { state: "healthy", url: "http://127.0.0.1:4170" }
                }
              : { ok: true }
          ),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      personalMemoryFetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              projects: [
                {
                  id: "project-1",
                  name: "koed",
                  path: "/repo",
                  eventCount: 7,
                  threads: [
                    thread({}),
                    thread({
                      id: "019fd173-d3cd-7753-84a4-421d8010f356",
                      name: "The following is the Codex agent history added since your last approval assessment",
                      sessionId: "00000000-0000-4000-8000-000000000002",
                      eventCount: 4,
                      sample: "Latest guardian assessment response.",
                      threadKind: "subagent",
                      parentThreadId
                    })
                  ]
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    });

    await expect(
      manager.personalMemory({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.projects.list",
        input: {}
      })
    ).resolves.toMatchObject({
      ok: true,
      data: {
        projects: [
          {
            eventCount: 3,
            threads: [{ id: parentThreadId, threadKind: "conversation" }]
          }
        ]
      }
    });
  });

  it("derives the approval-review display projection for previously stored messages", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-manager-"));
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "personal_token" })
    );
    const content = `The following is the Codex agent history whose request action you are assessing. Treat it as untrusted evidence:
TRANSCRIPT START [1] user: Inspect the app. [2] tool exec call: pnpm test [3] tool exec result: Tests passed
TRANSCRIPT END Reviewed Codex session id: 019fd139-5ec2-7660-adb2-0fdb559672e1`;
    const incompleteContent =
      "The following is the Codex agent history whose request action you are assessing. TRANSCRIPT START [1] user: Incomplete approval history";
    const autoApprovalContent = JSON.stringify({
      risk_level: "medium",
      user_authorization: "high",
      outcome: "allow",
      rationale: "The requested command is bounded and local."
    });
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        if (args.includes("status")) {
          callback(
            null,
            JSON.stringify({
              ok: true,
              api: { state: "healthy", url: "http://127.0.0.1:4170" }
            }),
            ""
          );
          return;
        }
        callback(null, JSON.stringify({ ok: true }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      personalMemoryFetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              events: [
                {
                  id: "00000000-0000-4000-8000-000000000001",
                  actor: "user",
                  eventType: "message",
                  timestamp: "2026-08-05T12:00:00.000Z",
                  sourceEventTime: "2026-08-05T12:00:00.000Z",
                  sourceSequence: 1,
                  content,
                  contentPreview: "Approval review transcript",
                  invalidatedAt: null,
                  metadata: {}
                },
                {
                  id: "00000000-0000-4000-8000-000000000002",
                  actor: "user",
                  eventType: "message",
                  timestamp: "2026-08-05T12:01:00.000Z",
                  sourceEventTime: "2026-08-05T12:01:00.000Z",
                  sourceSequence: 2,
                  content: incompleteContent,
                  contentPreview: "Incomplete approval review transcript",
                  invalidatedAt: null,
                  metadata: {}
                },
                {
                  id: "00000000-0000-4000-8000-000000000003",
                  actor: "agent",
                  eventType: "message",
                  timestamp: "2026-08-05T12:02:00.000Z",
                  sourceEventTime: "2026-08-05T12:02:00.000Z",
                  sourceSequence: 3,
                  content: autoApprovalContent,
                  contentPreview: autoApprovalContent,
                  invalidatedAt: null,
                  metadata: { approvalReview: true }
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    });

    await expect(
      manager.personalMemory({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.events.load_page",
        input: { projectId: "project-1", threadId: "thread-1", limit: 50 }
      })
    ).resolves.toMatchObject({
      ok: true,
      data: {
        events: [
          {
            content,
            transcriptDisplay: {
              kind: "approval_review",
              segments: [
                { kind: "message", actor: "user", sequence: 1 },
                { kind: "tool_call", toolName: "exec", sequence: 2 },
                { kind: "tool_result", toolName: "exec", sequence: 3 }
              ]
            }
          },
          {
            content: incompleteContent,
            transcriptDisplay: {
              kind: "approval_review",
              truncated: true,
              segments: [
                {
                  kind: "message",
                  actor: "agent",
                  sequence: 0,
                  content:
                    "This approval-review history is incomplete and cannot be displayed safely."
                }
              ]
            }
          },
          {
            content: autoApprovalContent,
            approvalDecisionDisplay: {
              kind: "auto_approval",
              version: 1,
              riskLevel: "medium",
              userAuthorization: "high",
              outcome: "allow",
              rationale: "The requested command is bounded and local."
            }
          }
        ]
      }
    });
  });

  it("streams authenticated Personal Memory changes until the window aborts", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-manager-"));
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "personal_token" })
    );
    const frame =
      "event: graph_update\n" +
      `data: ${JSON.stringify({
        eventRefs: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            projectId: "project-1",
            threadId: "thread-1"
          }
        ]
      })}\n\n`;
    const personalMemoryFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame));
          }
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }
      )
    );
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        callback(
          null,
          JSON.stringify(
            args.includes("status")
              ? {
                  ok: true,
                  api: {
                    state: "healthy",
                    url: "http://127.0.0.1:4170"
                  }
                }
              : { ok: true }
          ),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      personalMemoryFetch
    });
    const controller = new AbortController();
    const listener = vi.fn(() => controller.abort());

    await manager.subscribePersonalMemory(listener, controller.signal);

    expect(listener).toHaveBeenCalledWith({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          projectId: "project-1",
          threadId: "thread-1"
        }
      ]
    });
    expect(String(personalMemoryFetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:4170/v1/memory/graph/stream"
    );
    expect(
      new Headers(personalMemoryFetch.mock.calls[0]?.[1]?.headers).get(
        "authorization"
      )
    ).toBe("Bearer personal_token");
  });

  it("retains the verified local API origin across Personal Memory requests", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-manager-"));
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "personal_token" })
    );
    let statusCalls = 0;
    const personalMemoryFetch = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        if (args.includes("status")) {
          statusCalls += 1;
          callback(
            null,
            JSON.stringify(
              statusCalls === 1
                ? {
                    ok: true,
                    api: {
                      state: "healthy",
                      url: "http://127.0.0.1:4170"
                    }
                  }
                : { ok: false, state: "needs_attention" }
            ),
            ""
          );
          return;
        }
        callback(null, JSON.stringify({ ok: true }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      personalMemoryFetch
    });
    const request = {
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.projects.list" as const,
      input: {}
    } as const;

    await expect(manager.personalMemory(request)).resolves.toMatchObject({
      ok: true
    });
    await expect(manager.personalMemory(request)).resolves.toMatchObject({
      ok: true
    });

    expect(statusCalls).toBe(1);
    expect(personalMemoryFetch).toHaveBeenCalledTimes(2);
  });

  it("rediscovers the local API origin after a request failure", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-manager-"));
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "personal_token" })
    );
    let statusCalls = 0;
    const personalMemoryFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("stale local origin"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        if (args.includes("status")) {
          statusCalls += 1;
          callback(
            null,
            JSON.stringify({
              ok: true,
              api: {
                state: "healthy",
                url: `http://127.0.0.1:${statusCalls === 1 ? 4170 : 4180}`
              }
            }),
            ""
          );
          return;
        }
        callback(null, JSON.stringify({ ok: true }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      personalMemoryFetch
    });

    await expect(
      manager.personalMemory({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.projects.list",
        input: {}
      })
    ).resolves.toMatchObject({ ok: true });

    expect(statusCalls).toBe(2);
    expect(personalMemoryFetch).toHaveBeenCalledTimes(2);
    expect(String(personalMemoryFetch.mock.calls[0]?.[0])).toContain(":4170/");
    expect(String(personalMemoryFetch.mock.calls[1]?.[0])).toContain(":4180/");
  });

  it("rejects a non-loopback API authority before any Personal Memory fetch", async () => {
    const personalMemoryFetch = vi.fn<typeof fetch>();
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: {}
      }),
      existsSync: () => true,
      execFile: (_command, _args, _options, callback) => {
        callback(
          null,
          JSON.stringify({
            ok: true,
            api: { state: "healthy", url: "https://remote.example.test" }
          }),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      personalMemoryFetch
    });

    await expect(
      manager.personalMemory({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.projects.list",
        input: {}
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "not_ready" }
    });
    expect(personalMemoryFetch).not.toHaveBeenCalled();
  });

  it("loads exact changed Personal Memory events and omits invalidated rows", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-manager-"));
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "main_only_token" })
    );
    const visibleEventId = "11111111-1111-4111-8111-111111111111";
    const invalidatedEventId = "22222222-2222-4222-8222-222222222222";
    const personalMemoryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            event: {
              id: visibleEventId,
              actor: "assistant",
              eventType: "message",
              timestamp: "2026-07-23T00:00:01.000Z",
              sourceEventTime: null,
              sourceSequence: 1,
              content: "Updated older event",
              contentPreview: "Updated older event",
              invalidatedAt: null,
              metadata: {},
              projectId: "project-1",
              threadId: "thread-1"
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, _args, _options, callback) => {
        callback(
          null,
          JSON.stringify({
            ok: true,
            api: { state: "healthy", url: "http://localhost:4170" }
          }),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      personalMemoryFetch
    });

    await expect(
      manager.personalMemory({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        operation: "personal.events.load_page",
        input: {
          projectId: "project-1",
          threadId: "thread-1",
          limit: 500,
          eventIds: [visibleEventId, invalidatedEventId]
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      data: {
        events: [
          {
            id: visibleEventId,
            content: "Updated older event"
          }
        ]
      }
    });
    expect(personalMemoryFetch).toHaveBeenCalledTimes(2);
    expect(String(personalMemoryFetch.mock.calls[0]?.[0])).toBe(
      `http://localhost:4170/v1/memory/graph/events/${visibleEventId}?includeContent=true&includeRaw=false`
    );
    expect(String(personalMemoryFetch.mock.calls[1]?.[0])).toBe(
      `http://localhost:4170/v1/memory/graph/events/${invalidatedEventId}?includeContent=true&includeRaw=false`
    );
  });

  it("derives the exact assignment body from the main-owned Project graph", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-manager-"));
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "main_only_token" })
    );
    const personalMemoryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            projects: [
              {
                id: "project-2",
                name: "Project Two",
                path: "/work/project-two",
                eventCount: 0,
                threads: [],
                ignoredRemoteAuthority: "https://remote.example.test"
              }
            ]
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session: { project: { id: "project-2" }, apiToken: "must-strip" }
          })
        )
      );
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, _args, _options, callback) => {
        callback(
          null,
          JSON.stringify({
            ok: true,
            api: { state: "healthy", url: "http://localhost:4170" }
          }),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      personalMemoryFetch
    });
    const sessionId = "11111111-1111-4111-8111-111111111111";

    const result = await manager.personalMemory({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.sessions.assign_project",
      input: { action: "move", sessionId, targetProjectId: "project-2" }
    });

    expect(result).toEqual({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.sessions.assign_project",
      ok: true,
      data: { projectId: "project-2" }
    });
    expect(String(personalMemoryFetch.mock.calls[0]?.[0])).toBe(
      "http://localhost:4170/v1/memory/graph/threads?limit=500&offset=0&includeInvalidated=false"
    );
    expect(String(personalMemoryFetch.mock.calls[1]?.[0])).toBe(
      `http://localhost:4170/v1/memory/graph/sessions/${sessionId}/project`
    );
    expect(
      JSON.parse(String(personalMemoryFetch.mock.calls[1]?.[1]?.body))
    ).toEqual({
      action: "move",
      project: {
        id: "project-2",
        name: "Project Two",
        path: "/work/project-two"
      }
    });
    expect(JSON.stringify(result)).not.toMatch(
      /main_only_token|must-strip|remote\.example/
    );
  });

  it("updates a Captured Session title through the fixed owner-scoped route", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-manager-"));
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "config/local-app-credential.json"),
      JSON.stringify({ apiToken: "main_only_token" })
    );
    const personalMemoryFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session: {
            metadata: {
              threadName: "Release planning",
              apiToken: "must-strip"
            }
          }
        })
      )
    );
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, _args, _options, callback) => {
        callback(
          null,
          JSON.stringify({
            ok: true,
            api: { state: "healthy", url: "http://localhost:4170" }
          }),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      personalMemoryFetch
    });
    const sessionId = "11111111-1111-4111-8111-111111111111";

    const result = await manager.personalMemory({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.sessions.update_title",
      input: { sessionId, title: "Release planning" }
    });

    expect(result).toEqual({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.sessions.update_title",
      ok: true,
      data: { title: "Release planning" }
    });
    expect(String(personalMemoryFetch.mock.calls[0]?.[0])).toBe(
      `http://localhost:4170/v1/memory/graph/sessions/${sessionId}/title`
    );
    expect(personalMemoryFetch.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(
      JSON.parse(String(personalMemoryFetch.mock.calls[0]?.[1]?.body))
    ).toEqual({ title: "Release planning" });
    expect(JSON.stringify(result)).not.toContain("must-strip");
  });

  it("reconciles approved upstream enrollment between ordinary status refreshes", async () => {
    const calls: string[][] = [];
    let statusCalls = 0;
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        if (args[1] === "status") {
          statusCalls += 1;
          callback(
            null,
            JSON.stringify({
              ok: true,
              state: "healthy",
              upstreamBackends: {
                details: {
                  backends: [
                    {
                      id: "team-vps",
                      credential: {
                        status: statusCalls === 1 ? "unknown" : "configured"
                      }
                    }
                  ]
                }
              }
            }),
            ""
          );
          return;
        }
        callback(null, JSON.stringify({ ok: true, state: "exchanged" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.status!()).resolves.toMatchObject({
      upstreamBackends: {
        details: {
          backends: [{ id: "team-vps", credential: { status: "unknown" } }]
        }
      }
    });
    await waitFor(() =>
      calls.some((args) => args.includes("enroll") && args.includes("status"))
    );
    await expect(manager.handlers.status!()).resolves.toMatchObject({
      upstreamBackends: {
        details: {
          backends: [{ id: "team-vps", credential: { status: "configured" } }]
        }
      }
    });
    expect(calls).toEqual([
      ["/repo/cli.js", "status", "--json"],
      ["/repo/cli.js", "package", "status", "--json"],
      [
        "/repo/cli.js",
        "upstream",
        "enroll",
        "status",
        "--id",
        "team-vps",
        "--json"
      ],
      ["/repo/cli.js", "status", "--json"],
      ["/repo/cli.js", "package", "status", "--json"]
    ]);
  });

  it("reads Personal Device status through the loopback Desktop credential boundary", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-pds-status-"));
    const ownerUserId = "00000000-0000-4000-8000-000000000001";
    const desktop = storeDesktopLocalCredential(koedHome, {
      ownerUserId,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const requests: Array<{ authorization: string | null; url: string }> = [];
    const closePairingServer = vi.fn(async () => undefined);
    const startPairingServer = vi.fn(async () => ({
      port: 3310,
      createInvitation: vi.fn(),
      waitForRequest: vi.fn(),
      approve: vi.fn(),
      waitForCompletion: vi.fn(),
      cancel: vi.fn(),
      inspect: vi.fn(() => []),
      close: closePairingServer
    }));
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo", KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        if (args[1] === "stop") {
          callback(null, JSON.stringify({ ok: true }), "");
          return;
        }
        expect(args).toEqual(["/repo/cli.js", "status", "--json"]);
        callback(
          null,
          JSON.stringify({
            ok: true,
            api: { state: "healthy", url: "http://127.0.0.1:3300" }
          }),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      startPairingServer,
      personalMemoryFetch: (async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get("authorization"),
          url: String(input)
        });
        return new Response(
          JSON.stringify({
            groups: [{ group_id: "group-one", members: [] }],
            pairing_invitation_group_ids: ["group-one"]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }) as typeof fetch
    });
    try {
      await expect(
        manager.handlers.personal_sync_status!()
      ).resolves.toMatchObject({
        ok: true,
        groups: [{ group_id: "group-one" }]
      });
      expect(requests).toEqual([
        {
          authorization: desktop.authorization,
          url: "http://127.0.0.1:3300/v1/personal-device-sync/groups"
        }
      ]);
      expect(startPairingServer).toHaveBeenCalledTimes(1);
    } finally {
      await manager.stop();
      expect(closePairingServer).toHaveBeenCalledTimes(1);
      rmSync(koedHome, { recursive: true, force: true });
    }
  });

  it("does not advertise or start an enrollment gateway on a joined replica", async () => {
    const koedHome = mkdtempSync(
      resolve(tmpdir(), "koed-desktop-pds-replica-")
    );
    const desktop = storeDesktopLocalCredential(koedHome, {
      ownerUserId: "00000000-0000-4000-8000-000000000002",
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const startPairingServer = vi.fn();
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: koedHome },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo", KOED_HOME: koedHome }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        if (args[1] === "stop") {
          callback(null, JSON.stringify({ ok: true }), "");
          return;
        }
        expect(args).toEqual(["/repo/cli.js", "status", "--json"]);
        callback(
          null,
          JSON.stringify({
            ok: true,
            api: { state: "healthy", url: "http://127.0.0.1:3300" }
          }),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined,
      startPairingServer,
      personalMemoryFetch: (async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          desktop.authorization
        );
        return new Response(
          JSON.stringify({
            groups: [{ group_id: "group-one", members: [] }],
            pairing_invitation_group_ids: []
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }) as typeof fetch
    });
    try {
      await expect(
        manager.handlers.personal_sync_status!()
      ).resolves.toMatchObject({
        ok: true,
        groups: [{ group_id: "group-one" }],
        pairing_invitation_group_ids: []
      });
      expect(startPairingServer).not.toHaveBeenCalled();
      await expect(
        manager.handlers.personal_sync_pairing_create!({
          groupId: "group-one"
        })
      ).resolves.toEqual({
        ok: false,
        state: "authority_host_required",
        error:
          "Create the pairing link on the device that originally set up this Personal Device Group."
      });
      expect(startPairingServer).not.toHaveBeenCalled();
    } finally {
      await manager.stop();
      rmSync(koedHome, { recursive: true, force: true });
    }
  });

  it("returns status while one slow enrollment reconciliation remains in flight", async () => {
    const calls: string[][] = [];
    let completeEnrollment: (() => void) | null = null;
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        if (args[1] === "status") {
          callback(
            null,
            JSON.stringify({
              ok: true,
              state: "healthy",
              upstreamBackends: {
                details: {
                  backends: [
                    { id: "team-vps", credential: { status: "unknown" } }
                  ]
                }
              }
            }),
            ""
          );
          return;
        }
        if (args[1] === "package" && args[2] === "status") {
          callback(null, JSON.stringify({ ok: true, state: "healthy" }), "");
          return;
        }
        completeEnrollment = () =>
          callback(null, JSON.stringify({ ok: true, state: "pending" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.status!()).resolves.toMatchObject({
      state: "healthy"
    });
    await waitFor(() => completeEnrollment !== null);
    await expect(manager.handlers.status!()).resolves.toMatchObject({
      state: "healthy"
    });
    expect(
      calls.filter((args) => args.includes("enroll") && args.includes("status"))
    ).toHaveLength(1);
    completeEnrollment!();
  });

  it("runs explicit runtime install through koed-server", async () => {
    const calls: string[][] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        callback(null, JSON.stringify({ ok: true, state: "installed" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(
      manager.handlers.runtime_install!({ operatorConsented: true })
    ).resolves.toMatchObject({
      ok: true,
      state: "installed"
    });
    expect(calls[0]).toEqual([
      "/repo/cli.js",
      "runtime",
      "install",
      "--provider",
      "homebrew",
      "--dependency-mode",
      "bundled-local",
      "--json"
    ]);
  });

  it("requires Operator consent before Homebrew runtime install", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: () => undefined,
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.runtime_install!()).resolves.toMatchObject({
      ok: false,
      provider: "homebrew",
      error:
        "Operator consent is required before Koed Desktop may mutate Homebrew package-manager state."
    });
  });

  it("uses packaged runtime install when packaged manifest is present", async () => {
    const calls: string[][] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_PACKAGED_RESOURCES_PATH: "/resources" },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: (path) =>
        path === "/repo/cli.js" ||
        path === "/resources/koed-runtime/runtime-asset-manifest.json",
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        callback(null, JSON.stringify({ ok: true, state: "installed" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.runtime_install!()).resolves.toMatchObject({
      ok: true,
      state: "installed"
    });
    expect(calls[0]).toContain("packaged");
  });

  it("uses Homebrew runtime status when packaged manifest is missing", async () => {
    const calls: string[][] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {
        KOED_PACKAGED_DESKTOP: "1",
        KOED_PACKAGED_RESOURCES_PATH: "/resources"
      },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: (path) => path === "/repo/cli.js",
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        callback(null, JSON.stringify({ ok: false, state: "missing" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await manager.handlers.runtime_status!();
    expect(calls[0]).toContain("homebrew");
  });

  it("runs model status and install through koed-server", async () => {
    const calls: string[][] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_TEAM_COLLABORATION_ENABLED: "true" },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        callback(null, JSON.stringify({ ok: true, state: "installed" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.models_status!()).resolves.toMatchObject({
      ok: true,
      state: "installed"
    });
    await expect(manager.handlers.models_install!()).resolves.toMatchObject({
      ok: true,
      state: "installed"
    });
    expect(calls).toContainEqual([
      "/repo/cli.js",
      "models",
      "status",
      "--kind",
      "embedding",
      "--json"
    ]);
    expect(calls).toContainEqual([
      "/repo/cli.js",
      "models",
      "status",
      "--kind",
      "privacy",
      "--json"
    ]);
    expect(calls).toContainEqual([
      "/repo/cli.js",
      "models",
      "install",
      "--kind",
      "embedding",
      "--json"
    ]);
    expect(calls).toContainEqual([
      "/repo/cli.js",
      "models",
      "install",
      "--kind",
      "privacy",
      "--json"
    ]);
  });

  it("runs standalone package install through koed-server with configured source metadata", async () => {
    const calls: string[][] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {
        KOED_SERVER_PACKAGE_SOURCE: "/artifacts/koed-server.tar.gz",
        KOED_SERVER_PACKAGE_SHA256: "a".repeat(64)
      },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        callback(null, JSON.stringify({ ok: true, state: "activated" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.package_install!()).resolves.toMatchObject({
      ok: true,
      state: "activated"
    });
    expect(calls[0]).toEqual([
      "/repo/cli.js",
      "package",
      "install",
      "--source",
      "/artifacts/koed-server.tar.gz",
      "--sha256",
      "a".repeat(64),
      "--activate",
      "--json"
    ]);
  });

  it("requires Operator consent before hosted package download", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {
        KOED_SERVER_PACKAGE_SOURCE: "https://downloads.test/koed-server.tar.gz",
        KOED_SERVER_PACKAGE_SHA256: "a".repeat(64)
      },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: () => undefined,
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.package_install!()).resolves.toMatchObject({
      ok: false,
      sourceKind: "configured",
      error:
        "Operator consent is required before Koed Desktop may download a standalone koed-server package."
    });
  });

  it("adds bundled fallback server package status when no standalone source is available", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        if (args.includes("package")) {
          callback(
            null,
            JSON.stringify({
              ok: false,
              state: "missing",
              message: "No koed-server package is installed."
            }),
            ""
          );
          return;
        }
        callback(
          null,
          JSON.stringify({
            ok: false,
            state: "starting",
            generatedAt: "2026-07-09T00:00:00.000Z",
            api: { state: "starting" }
          }),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.status!()).resolves.toMatchObject({
      serverPackage: {
        state: "healthy",
        source: "bundled-fallback",
        message:
          "Using the bundled fallback koed-server runtime; a standalone package is optional for this Desktop build."
      }
    });
  });

  it("keeps invalid standalone package configuration visible", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {
        KOED_SERVER_PACKAGE_SOURCE: "https://downloads.example.test/server.tgz"
      },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        if (args.includes("package")) {
          callback(
            null,
            JSON.stringify({
              ok: false,
              state: "missing",
              message: "No koed-server package is installed."
            }),
            ""
          );
          return;
        }
        callback(
          null,
          JSON.stringify({
            ok: false,
            state: "starting",
            generatedAt: "2026-07-09T00:00:00.000Z",
            api: { state: "starting" }
          }),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.status!()).resolves.toMatchObject({
      serverPackage: {
        state: "not_configured",
        source: "unavailable",
        message:
          "koed-server package source is configured, but SHA-256 metadata is missing.",
        action:
          "Set KOED_SERVER_PACKAGE_SHA256 or KOED_SERVER_PACKAGE_SHA256_FILE."
      }
    });
  });

  it("does not expose valid JSON package failure details to the renderer", async () => {
    const secret = "secret-in-package-error-/Users/operator/private";
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        callback(
          null,
          JSON.stringify(
            args.includes("package")
              ? {
                  ok: false,
                  state: "failed",
                  message: secret,
                  action: secret,
                  errors: [secret]
                }
              : {
                  ok: false,
                  state: "starting",
                  generatedAt: "2026-07-09T00:00:00.000Z",
                  api: { state: "starting" }
                }
          ),
          secret
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    const status = await manager.handlers.status!();
    expect(status).toMatchObject({
      serverPackage: {
        state: "needs_attention",
        message: "Standalone koed-server package needs attention.",
        action: "Retry the local service check."
      }
    });
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  it("rejects Team Backend URLs that could carry credentials or browser state", async () => {
    const execFile = vi.fn();
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile,
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    for (const url of [
      "https://token@team.example.test",
      "https://team.example.test/?token=secret",
      "https://team.example.test/#approval"
    ]) {
      await expect(
        manager.handlers.upstream_connect!({ url })
      ).resolves.toMatchObject({
        ok: false,
        error:
          "Team Backend URL cannot include credentials, a query string, or a fragment."
      });
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it("connects a Team Backend by registering, validating, enabling policy, and starting enrollment", async () => {
    const calls: string[][] = [];
    const opened: string[] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        if (args.includes("register")) {
          callback(
            null,
            JSON.stringify({ ok: true, backend: { id: "team-vps" } }),
            ""
          );
          return;
        }
        if (args.includes("start")) {
          callback(
            null,
            JSON.stringify({
              ok: true,
              state: "pending",
              enrollment: {
                activationUrl:
                  "https://team.example.test/device-enrollment/challenge-1"
              }
            }),
            ""
          );
          return;
        }
        callback(null, JSON.stringify({ ok: true }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async (url) => {
        opened.push(url);
      }
    });

    await expect(
      manager.handlers.upstream_connect!({
        url: " https://team.example.test "
      })
    ).resolves.toMatchObject({
      ok: true,
      backendId: "team-vps",
      activationUrl: "https://team.example.test/device-enrollment/challenge-1"
    });

    expect(calls).toEqual([
      [
        "/repo/cli.js",
        "upstream",
        "register",
        "--url",
        "https://team.example.test",
        "--name",
        "Team Backend",
        "--profile",
        "team_self_hosted",
        "--json"
      ],
      ["/repo/cli.js", "upstream", "refresh", "--id", "team-vps", "--json"],
      [
        "/repo/cli.js",
        "upstream",
        "policy",
        "--id",
        "team-vps",
        "--team-workspace-read",
        "enabled",
        "--share-grant-management",
        "enabled",
        "--sync",
        "enabled",
        "--admin",
        "enabled",
        "--json"
      ],
      [
        "/repo/cli.js",
        "upstream",
        "enroll",
        "start",
        "--id",
        "team-vps",
        "--json"
      ]
    ]);
    expect(opened).toEqual([
      "https://team.example.test/device-enrollment/challenge-1"
    ]);
  });

  it("returns the activation URL without waiting for the system browser", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        if (args.includes("register")) {
          callback(
            null,
            JSON.stringify({ ok: true, backend: { id: "team-vps" } }),
            ""
          );
          return;
        }
        if (args.includes("start")) {
          callback(
            null,
            JSON.stringify({
              ok: true,
              state: "pending",
              enrollment: {
                activationUrl:
                  "https://team.example.test/device-enrollment/challenge-1"
              }
            }),
            ""
          );
          return;
        }
        callback(null, JSON.stringify({ ok: true }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: () => new Promise(() => undefined)
    });

    await expect(
      manager.handlers.upstream_connect!({ url: "https://team.example.test" })
    ).resolves.toMatchObject({
      ok: true,
      browserOpenRequested: true,
      activationUrl: "https://team.example.test/device-enrollment/challenge-1"
    });
  });

  it("does not report a revoked enrollment as a new browser challenge", async () => {
    const opened: string[] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        if (args.includes("register")) {
          callback(
            null,
            JSON.stringify({ ok: true, backend: { id: "team-vps" } }),
            ""
          );
          return;
        }
        if (args.includes("start")) {
          callback(
            null,
            JSON.stringify({ ok: true, state: "revoked", enrollment: {} }),
            ""
          );
          return;
        }
        callback(null, JSON.stringify({ ok: true }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async (url) => {
        opened.push(url);
      }
    });

    await expect(
      manager.handlers.upstream_connect!({ url: "https://team.example.test" })
    ).resolves.toMatchObject({
      ok: false,
      error:
        "Team Backend enrollment did not return a new pending browser approval challenge."
    });
    expect(opened).toEqual([]);
  });

  it("runs explicit stop through koed-server", async () => {
    const spawned = childProcess();
    const calls: string[][] = [];
    let statusCalls = 0;
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        if (args.includes("stop")) {
          callback(
            null,
            JSON.stringify({ ok: true, state: "healthy", stoppedPids: [] }),
            ""
          );
          return;
        }
        statusCalls += 1;
        callback(
          null,
          JSON.stringify(
            statusCalls === 1
              ? {
                  ok: false,
                  state: "needs_attention",
                  api: { state: "needs_attention" },
                  apiToken: { state: "needs_attention" }
                }
              : healthyLocalServiceStatus()
          ),
          ""
        );
      },
      spawn: () => spawned as never,
      openExternal: async () => undefined
    });

    await manager.handlers.start!();
    await expect(manager.handlers.stop!()).resolves.toMatchObject({
      ok: true,
      state: "healthy"
    });
    expect(calls[calls.length - 1]).toEqual(["/repo/cli.js", "stop", "--json"]);
    expect(spawned.killed).toBe(false);
  });

  it("reports missing koed-server CLI as not_configured", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/missing",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/missing", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => false,
      execFile: () => undefined,
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    const doctor = await manager.handlers.doctor!();
    expect(doctor).toMatchObject({
      ok: false,
      state: "not_configured",
      api: { state: "not_configured" },
      database: { state: "not_configured" },
      embeddingService: { state: "not_configured" },
      error: "Koed's local service is unavailable."
    });
    expect(JSON.stringify(doctor)).not.toContain("/repo");
    expect(JSON.stringify(doctor)).not.toContain("/missing");
    await expect(manager.handlers.start!()).resolves.toMatchObject({
      ok: false,
      state: "not_configured",
      api: { state: "not_configured" }
    });
  });

  it("reports a missing packaged koed-server CLI as renderable diagnostics", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/Applications/Koed.app/Contents/Resources",
      cliPath:
        "/Applications/Koed.app/Contents/Resources/app.asar/node_modules/@koed/koed-server/dist/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/Applications/Koed.app/Contents/MacOS/Koed",
        args,
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          KOED_REPO_ROOT: "/Applications/Koed.app/Contents/Resources"
        }
      }),
      existsSync: () => false,
      execFile: () => undefined,
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    const status = await manager.handlers.status!();
    expect(status).toMatchObject({
      ok: false,
      state: "not_configured",
      database: { action: "Install runtime assets" },
      embeddingService: { action: "Install runtime assets" },
      error: "Koed's local service is unavailable."
    });
    expect(JSON.stringify(status)).not.toContain("/Applications");
    expect(JSON.stringify(status)).not.toContain("app.asar");
  });

  it("returns renderable diagnostic status when status JSON cannot be parsed", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, _args, _options, callback) => {
        callback(new Error("status failed"), "", "boom");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    const status = await manager.handlers.status!();
    expect(status).toMatchObject({
      ok: false,
      state: "needs_attention",
      error: "Koed status could not be read.",
      api: { state: "needs_attention" },
      workerQueues: { state: "needs_attention" }
    });
    expect(JSON.stringify(status)).not.toContain("status failed");
    expect(JSON.stringify(status)).not.toContain("boom");
  });

  it("reconnects without requesting koed-server start --daemon again once healthy", async () => {
    const calls: string[][] = [];
    let statusCalls = 0;
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        if (args.includes("--daemon")) {
          callback(
            null,
            JSON.stringify({
              ok: true,
              state: "starting",
              message: "Koed server daemon start requested.",
              startedPid: 42
            }),
            ""
          );
          return;
        }
        statusCalls += 1;
        callback(
          null,
          JSON.stringify(
            statusCalls === 1
              ? {
                  ok: false,
                  state: "needs_attention",
                  api: { state: "needs_attention" },
                  apiToken: { state: "needs_attention" }
                }
              : healthyLocalServiceStatus()
          ),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.start!()).resolves.toMatchObject({
      state: "healthy"
    });
    await expect(manager.handlers.start!()).resolves.toMatchObject({
      state: "healthy"
    });
    expect(calls.filter((args) => args.includes("--daemon"))).toHaveLength(1);
  });

  it("does not auto-start an unverified fresh Desktop install", async () => {
    const calls: string[][] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: "/home/test/.koed" },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: "/home/test/.koed" }
      }),
      existsSync: (path) => path === "/repo/cli.js",
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        callback(null, JSON.stringify({ ok: true }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.resume()).resolves.toMatchObject({
      ok: true,
      skipped: true,
      state: "not_configured"
    });
    expect(calls).toEqual([]);
  });

  it("auto-starts a previously verified Desktop install", async () => {
    const calls: string[][] = [];
    let statusCalls = 0;
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: "/home/test/.koed" },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: "/home/test/.koed" }
      }),
      existsSync: (path) =>
        path === "/repo/cli.js" ||
        path === "/home/test/.koed/run/last-verification.json",
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        if (args.includes("--daemon")) {
          callback(null, JSON.stringify({ ok: true, state: "starting" }), "");
          return;
        }
        statusCalls += 1;
        callback(
          null,
          JSON.stringify(
            statusCalls === 1
              ? {
                  ok: false,
                  state: "needs_attention",
                  api: { state: "needs_attention" },
                  apiToken: { state: "needs_attention" }
                }
              : healthyLocalServiceStatus()
          ),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.resume()).resolves.toMatchObject({
      state: "healthy"
    });
    expect(calls.filter((args) => args.includes("--daemon"))).toHaveLength(1);
  });

  it("opens a verified Desktop install into recovery when resume fails", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: { KOED_HOME: "/home/test/.koed" },
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_HOME: "/home/test/.koed" }
      }),
      existsSync: (path) =>
        path === "/repo/cli.js" ||
        path === "/home/test/.koed/run/last-verification.json",
      execFile: (_command, _args, _options, callback) => {
        callback(new Error("runtime unavailable"), "", "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.resume()).resolves.toMatchObject({
      ok: false,
      state: "needs_attention"
    });
  });

  it("reports koed-server daemon start failures without throwing", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/missing-electron",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        if (args.includes("--daemon")) {
          callback(
            null,
            JSON.stringify({
              ok: false,
              state: "needs_attention",
              error: "spawn /missing-electron ENOENT"
            }),
            ""
          );
          return;
        }
        callback(
          null,
          JSON.stringify({
            ok: false,
            state: "needs_attention",
            api: { state: "needs_attention" }
          }),
          ""
        );
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.start!()).resolves.toMatchObject({
      ok: false,
      state: "needs_attention",
      error: "spawn /missing-electron ENOENT"
    });
  });
});
