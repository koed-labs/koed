import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createKoedEnvironment, createKoedServerManager } from "./manager.js";

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

  it("defaults packaged Desktop managed local server to bundled-local", () => {
    const packagedEnvironment = createKoedEnvironment(
      "/repo",
      {},
      { desktopManagedLocal: true, packagedResourcesPath: "/resources" }
    );
    expect(packagedEnvironment).toMatchObject({
      KOED_RUNTIME_MODE: "local-personal",
      KOED_DEPENDENCY_MODE: "bundled-local",
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
          WORK_QUEUE_BACKEND: "bullmq"
        },
        { desktopManagedLocal: true }
      )
    ).toMatchObject({
      KOED_RUNTIME_MODE: "external",
      KOED_DEPENDENCY_MODE: "external",
      WORK_QUEUE_BACKEND: "bullmq"
    });
  });

  it("runs JSON koed-server commands", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/packages/koed-server/dist/cli.js",
      environment: {},
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
      state: "healthy"
    });
    expect(calls[0]).toEqual({
      command: "/node",
      args: ["/repo/packages/koed-server/dist/cli.js", "status", "--json"]
    });

    await expect(manager.handlers.project_list!()).resolves.toMatchObject({
      ok: true
    });
    expect(calls[1]).toEqual({
      command: "/node",
      args: [
        "/repo/packages/koed-server/dist/cli.js",
        "project",
        "list",
        "--json"
      ]
    });
  });

  it("replaces an existing Explorer credential when forced after a 401", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-manager-"));
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(
      resolve(koedHome, "config/explorer-token.json"),
      JSON.stringify({ apiToken: "stale_token" })
    );
    const calls: string[][] = [];
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
        callback(null, "Created Koed API token.\nToken: fresh_token\n", "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(
      manager.handlers.explorer_credential!({ force: true })
    ).resolves.toMatchObject({ ok: true, apiToken: "fresh_token" });
    expect(calls[0]).toContain("api-token:create");
    expect(
      JSON.parse(
        readFileSync(resolve(koedHome, "config/explorer-token.json"), "utf8")
      )
    ).toMatchObject({ apiToken: "fresh_token" });
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
      [
        "/repo/cli.js",
        "upstream",
        "enroll",
        "status",
        "--id",
        "team-vps",
        "--json"
      ],
      ["/repo/cli.js", "status", "--json"]
    ]);
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

    await expect(manager.handlers.models_status!()).resolves.toMatchObject({
      ok: true,
      state: "installed"
    });
    await expect(manager.handlers.models_install!()).resolves.toMatchObject({
      ok: true,
      state: "installed"
    });
    expect(calls[0]).toEqual([
      "/repo/cli.js",
      "models",
      "status",
      "--kind",
      "embedding",
      "--json"
    ]);
    expect(calls[1]).toEqual([
      "/repo/cli.js",
      "models",
      "install",
      "--kind",
      "embedding",
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

  it("disconnects the first registered Team Backend when no explicit id is supplied", async () => {
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
        if (args.includes("status")) {
          callback(
            null,
            JSON.stringify({
              ok: true,
              upstreamBackends: {
                details: { backends: [{ id: "team-vps" }] }
              }
            }),
            ""
          );
          return;
        }
        callback(null, JSON.stringify({ ok: true, state: "revoked" }), "");
      },
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(
      manager.handlers.upstream_disconnect!()
    ).resolves.toMatchObject({
      ok: true,
      state: "revoked"
    });
    expect(calls).toEqual([
      ["/repo/cli.js", "status", "--json"],
      ["/repo/cli.js", "upstream", "disconnect", "--id", "team-vps", "--json"]
    ]);
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
                  api: { state: "needs_attention" }
                }
              : { ok: true, state: "healthy", api: { state: "healthy" } }
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

    await expect(manager.handlers.doctor!()).resolves.toMatchObject({
      ok: false,
      state: "not_configured",
      api: { state: "not_configured" },
      database: { state: "not_configured" },
      embeddingService: { state: "not_configured" },
      details: { repoRoot: "/repo", cliPath: "/missing" }
    });
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

    await expect(manager.handlers.status!()).resolves.toMatchObject({
      ok: false,
      state: "not_configured",
      database: { action: "Install runtime assets" },
      embeddingService: { action: "Install runtime assets" },
      details: {
        repoRoot: "/Applications/Koed.app/Contents/Resources",
        cliPath:
          "/Applications/Koed.app/Contents/Resources/app.asar/node_modules/@koed/koed-server/dist/cli.js"
      }
    });
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

    await expect(manager.handlers.status!()).resolves.toMatchObject({
      ok: false,
      state: "needs_attention",
      error: "status failed",
      api: { state: "needs_attention" },
      workerQueues: { state: "needs_attention" },
      explorer: { state: "needs_attention" },
      details: { stderr: "boom" }
    });
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
                  api: { state: "needs_attention" }
                }
              : { ok: true, state: "healthy", api: { state: "healthy" } }
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
