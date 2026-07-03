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

  it("defaults packaged Desktop managed local server to bundled-local", () => {
    expect(
      createKoedEnvironment("/repo", {}, { desktopManagedLocal: true })
    ).toMatchObject({
      KOED_REPO_ROOT: "/repo",
      KOED_RUNTIME_MODE: "local-personal",
      KOED_DEPENDENCY_MODE: "bundled-local",
      WORK_QUEUE_BACKEND: "local",
      KOED_AUTO_PORTS: "1"
    });
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

    await expect(manager.handlers.runtime_install!()).resolves.toMatchObject({
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

  it("runs explicit stop through koed-server and clears the managed process", async () => {
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
    expect(spawned.killed).toBe(true);
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

  it("starts one koed-server process and stops it on quit", async () => {
    const spawned = childProcess();
    const spawnCalls: string[][] = [];
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
      execFile: (_command, _args, _options, callback) => {
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
      spawn: (_command, args) => {
        spawnCalls.push(args);
        return spawned as never;
      },
      openExternal: async () => undefined
    });

    await expect(manager.handlers.start!()).resolves.toMatchObject({
      state: "healthy"
    });
    await expect(manager.handlers.start!()).resolves.toMatchObject({
      state: "healthy"
    });
    expect(spawnCalls).toEqual([["/repo/cli.js", "start"]]);

    manager.stop();
    expect(spawned.killed).toBe(true);
  });

  it("reports koed-server spawn errors without throwing uncaught exceptions", async () => {
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
      execFile: (_command, _args, _options, callback) => {
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
      spawn: () => {
        const child = childProcess();
        queueMicrotask(() => {
          child.emit("error", new Error("spawn /missing-electron ENOENT"));
        });
        return child as never;
      },
      openExternal: async () => undefined
    });

    await expect(manager.handlers.start!()).resolves.toMatchObject({
      ok: false,
      state: "needs_attention",
      error: "koed-server start failed: spawn /missing-electron ENOENT"
    });
  });
});
