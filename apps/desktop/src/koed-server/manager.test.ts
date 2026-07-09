import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
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
