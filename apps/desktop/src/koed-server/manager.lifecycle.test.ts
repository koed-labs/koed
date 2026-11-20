import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({
  current: {} as Record<string, unknown>
}));
vi.mock("@koed-labs/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@koed-labs/server")>()),
  observeRuntimeLifecycle: () => observed.current
}));

import { createKoedServerManager } from "./manager.js";

const stopped = {
  state: "stopped",
  epoch: "stopped",
  message: "Koed is not running."
};
const live = (pid: number) => ({
  state: "running",
  epoch: `${pid}:live`,
  message: "Koed is running.",
  pid
});
const lifecycleReply = (
  observation: Record<string, unknown>,
  owned: boolean
) => ({
  ...observation,
  owner: { kind: "desktop", installationId: "a".repeat(32) },
  owned
});

const hostSnapshot = (state: string, error?: string) => ({
  instanceId: "host",
  revision: 1,
  stopIntent: false,
  state,
  ...(error ? { error } : {})
});

const homes: string[] = [];
const verifiedHome = () => {
  const home = mkdtempSync(resolve(tmpdir(), "koed-lifecycle-"));
  homes.push(home);
  mkdirSync(resolve(home, "run"), { recursive: true });
  writeFileSync(resolve(home, "run", "last-verification.json"), "{}");
  return home;
};
afterEach(() =>
  homes
    .splice(0)
    .forEach((home) => rmSync(home, { recursive: true, force: true }))
);
beforeEach(() => {
  observed.current = { ...stopped };
});

// Each spawned child is a private management or supervisor session.
const harness = (
  home: string,
  lifecycleResult: () =>
    | Record<string, unknown>
    | Promise<Record<string, unknown>>,
  options: {
    failSupervisorStart?: boolean;
    startupFailure?: string;
    managementStderr?: string;
    invalidManagementHandshake?: boolean;
    sharedControl?: boolean;
    holdControlStart?: boolean;
    holdControlResume?: boolean;
    freshInstall?: boolean;
  } = {}
) => {
  const spawned: EventEmitter[] = [];
  const actions: string[] = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      stderr: new EventEmitter(),
      pid: 4000 + spawned.length,
      kill: vi.fn(() => true),
      send(message: Record<string, unknown>) {
        if (message.type === "koed.desktop.supervisor.init") {
          if (
            message.mode === "privacy-management" &&
            options.managementStderr
          ) {
            queueMicrotask(() => {
              if (options.invalidManagementHandshake) child.emit("message", {});
              else child.emit("disconnect");
              setTimeout(() => {
                child.stderr.emit("data", options.managementStderr);
                child.stderr.emit("close");
              }, 0);
            });
            return;
          }
          if (message.mode === undefined && options.startupFailure) {
            queueMicrotask(() => {
              observed.current = {
                state: "starting",
                epoch: `${child.pid}:starting`,
                pid: child.pid
              };
              void manager.lifecycle.refresh();
              observed.current = { ...stopped };
              void manager.lifecycle.refresh();
              child.emit("message", {
                type: "koed.desktop.supervisor.start-failed",
                nonce: message.nonce,
                childPid: child.pid,
                bundleDigest: "a".repeat(64),
                mode: "runtime",
                error: options.startupFailure
              });
            });
            return;
          }
          if (message.mode === undefined && options.failSupervisorStart) {
            queueMicrotask(() => child.emit("exit", 0, null));
            return;
          }
          queueMicrotask(() =>
            child.emit("message", {
              type: "koed.desktop.supervisor.ready",
              nonce: message.nonce,
              childPid: child.pid,
              bundleDigest: "a".repeat(64),
              mode: message.mode
            })
          );
        } else if (message.type === "koed.desktop.status.request") {
          actions.push(String(message.action));
          const result =
            message.action === "lifecycle"
              ? lifecycleResult()
              : { ok: true, api: { state: "healthy" } };
          void Promise.resolve(result).then((resolvedResult) =>
            queueMicrotask(() =>
              child.emit("message", {
                ...message,
                type: "koed.desktop.status.response",
                result: resolvedResult
              })
            )
          );
        } else if (message.type === "koed.desktop.supervisor.stop") {
          queueMicrotask(() => child.emit("exit", 0, null));
        }
      }
    });
    spawned.push(child);
    return child;
  });
  let releaseControlStart: (() => void) | undefined;
  let releaseControlResume: (() => void) | undefined;
  let disconnectControlSession = () => {};
  const openControlSession = vi.fn(async () => {
    let connected = true;
    return {
      isConnected: () => connected,
      onClose: (listener: () => void) => {
        disconnectControlSession = () => {
          connected = false;
          listener();
        };
      },
      detach: async () => ({ ok: true })
    };
  });
  const execFile = vi.fn((_command, _args, _options, callback) => {
    const reply = () =>
      callback(null, JSON.stringify({ ok: true, state: "stopped" }), "");
    if (
      options.holdControlStart &&
      _command === "/installed-control" &&
      _args[0] === "__control-plane-start-desktop"
    )
      releaseControlStart = reply;
    else if (
      options.holdControlResume &&
      _args[0] === "__control-plane-start-automatic"
    )
      releaseControlResume = reply;
    else reply();
  });
  const manager = createKoedServerManager({
    repoRoot: "/repo",
    cliPath: "/repo/cli.js",
    environment: { KOED_HOME: home },
    createCliInvocation: (args) => ({ command: "/node", args, env: {} }),
    ...(options.sharedControl
      ? {
          createControlCliInvocation: (args: string[]) => ({
            command: "/installed-control",
            args,
            env: {}
          }),
          openControlSession
        }
      : {}),
    createSupervisorInvocation: () => ({
      command: "/electron",
      args: ["private-entry.js"],
      env: {}
    }),
    packagedResourcesPath: "/app/Contents/Resources",
    existsSync: (path) =>
      !options.freshInstall || !String(path).endsWith("last-verification.json"),
    execFile,
    spawn: spawn as never,
    openExternal: async () => undefined
  });
  return {
    manager,
    spawn,
    spawned,
    actions,
    execFile,
    openControlSession,
    disconnectControlSession: () => disconnectControlSession(),
    releaseStart: () => releaseControlStart?.(),
    releaseResume: () => releaseControlResume?.()
  };
};

describe("Desktop manager shared lifecycle", () => {
  it("projects an external stop without reporting starting while the host lock lives", async () => {
    vi.useFakeTimers();
    const { manager, execFile } = harness(verifiedHome(), () => ({}), {
      sharedControl: true
    });
    let state = "ready";
    let revision = 1;
    let stopIntent = false;
    execFile.mockImplementation((_command, args, _options, callback) => {
      expect(args).toEqual(["__control-plane-startup-status", "--json"]);
      callback(
        null,
        JSON.stringify({
          ok: true,
          snapshot: { instanceId: "host", revision, state, stopIntent }
        }),
        ""
      );
    });
    const states: string[] = [];
    manager.lifecycle.subscribe((next) => states.push(next.state));
    try {
      observed.current = live(999);
      manager.lifecycle.start();
      await vi.advanceTimersByTimeAsync(0);
      state = "stopped";
      revision += 1;
      stopIntent = true;
      observed.current = { ...live(999), state: "starting" };
      await vi.advanceTimersByTimeAsync(2_000);
      expect(states).toEqual(["running", "stopped"]);
      expect(await manager.handlers.status()).toMatchObject({
        lifecycle: { state: "stopped" }
      });
      expect(execFile).toHaveBeenCalledTimes(3);
    } finally {
      manager.lifecycle.stop();
      vi.useRealTimers();
    }
  });

  it("reports unavailable instead of stopped when detached status fails", async () => {
    const { manager, execFile } = harness(verifiedHome(), () => ({}), {
      sharedControl: true
    });
    execFile.mockImplementation((_command, args, _options, callback) => {
      expect(args).toEqual(["__control-plane-startup-status", "--json"]);
      callback(
        new Error("Host status command timed out"),
        JSON.stringify({ ok: true, snapshot: hostSnapshot("stopped") }),
        ""
      );
    });
    expect(await manager.lifecycle.refresh()).toMatchObject({
      state: "unavailable"
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });
  it("uses one host read per routine running status and fences a same-host restart", async () => {
    const { manager, execFile } = harness(verifiedHome(), () => ({}), {
      sharedControl: true
    });
    let revision = 1;
    execFile.mockImplementation((_command, args, _options, callback) => {
      const result =
        args[0] === "__control-plane-startup-status"
          ? { ok: true, snapshot: { ...hostSnapshot("ready"), revision } }
          : { ok: false };
      callback(null, JSON.stringify(result), "");
    });
    await manager.lifecycle.refresh();
    const hostReads = () =>
      execFile.mock.calls.filter(
        (call) => call[1][0] === "__control-plane-startup-status"
      );
    expect(await manager.handlers.status()).toMatchObject({
      lifecycle: { state: "running", epoch: "host:1" }
    });
    expect(hostReads()).toHaveLength(2);
    revision = 2;
    expect(await manager.handlers.status()).toMatchObject({
      lifecycle: { state: "running", epoch: "host:2" }
    });
    expect(hostReads()).toHaveLength(4);
  });

  it("keeps fresh setup diagnostics when no detached host is available", async () => {
    const { manager, execFile, openControlSession } = harness(
      verifiedHome(),
      () => ({}),
      {
        sharedControl: true,
        freshInstall: true
      }
    );
    await expect(manager.resume()).resolves.toMatchObject({ skipped: true });
    await expect(manager.handlers.status()).resolves.toMatchObject({
      lifecycle: { state: "unavailable" }
    });
    expect(execFile.mock.calls.map((call) => call[1][0])).toContain("status");
    expect(openControlSession).not.toHaveBeenCalled();
  });

  it("fences an in-flight detached start after an external stop", async () => {
    const { manager, execFile } = harness(verifiedHome(), () => ({}), {
      sharedControl: true
    });
    let snapshot = hostSnapshot("ready");
    let finishStart: (() => void) | undefined;
    execFile.mockImplementation((_command, args, _options, callback) => {
      if (args[0] === "__control-plane-start-desktop") {
        finishStart = () => callback(null, JSON.stringify({ ok: true }), "");
      } else {
        expect(args[0]).toBe("__control-plane-startup-status");
        callback(null, JSON.stringify({ ok: true, snapshot }), "");
      }
    });
    observed.current = live(999);
    await manager.lifecycle.refresh();
    const starting = manager.handlers.start_daemon();
    await vi.waitFor(() => expect(finishStart).toBeDefined());
    snapshot = { ...hostSnapshot("stopped"), revision: 2, stopIntent: true };
    observed.current = { ...live(999), state: "starting" };
    await manager.lifecycle.refresh();
    finishStart?.();
    await expect(starting).resolves.toMatchObject({
      ok: false,
      state: "stopped"
    });
  });

  it("does not send Start if its preflight observes a new external Stop", async () => {
    const { manager, execFile } = harness(verifiedHome(), () => ({}), {
      sharedControl: true
    });
    let snapshot = hostSnapshot("ready");
    execFile.mockImplementation((_command, args, _options, callback) => {
      expect(args[0]).toBe("__control-plane-startup-status");
      callback(null, JSON.stringify({ ok: true, snapshot }), "");
    });
    await manager.lifecycle.refresh();
    snapshot = { ...hostSnapshot("stopped"), revision: 2, stopIntent: true };
    await expect(manager.handlers.start_daemon()).resolves.toMatchObject({
      ok: false,
      state: "stopped"
    });
    expect(execFile.mock.calls.map((call) => call[1][0])).toEqual([
      "__control-plane-startup-status",
      "__control-plane-startup-status"
    ]);
  });

  it("surfaces a terminal control-plane startup error without waiting for health polling", async () => {
    vi.useFakeTimers();
    try {
      const { manager, execFile } = harness(
        verifiedHome(),
        () => lifecycleReply(stopped, true),
        { sharedControl: true }
      );
      execFile.mockImplementation((_command, args, _options, callback) => {
        const result =
          args[0] === "__control-plane-startup-status"
            ? {
                ok: true,
                snapshot: hostSnapshot(
                  "needs_attention",
                  "API startup sentinel"
                )
              }
            : { ok: true, state: "starting" };
        callback(null, JSON.stringify(result), "");
      });
      let settled: unknown;
      void Promise.resolve(manager.handlers.start()).then((result: unknown) => {
        settled = result;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toMatchObject({
        ok: false,
        state: "needs_attention",
        error: "API startup sentinel"
      });
      expect(execFile.mock.calls.map((call) => call[1][0])).toEqual([
        "__control-plane-start-desktop",
        "__control-plane-startup-status"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("checks for terminal failure when the health probe stalls", async () => {
    vi.useFakeTimers();
    try {
      const { manager, execFile } = harness(
        verifiedHome(),
        () => lifecycleReply(stopped, true),
        { sharedControl: true }
      );
      let probes = 0;
      execFile.mockImplementation((_command, args, opts, callback) => {
        if (args[0] === "status") {
          setTimeout(
            () => callback(new Error("timed out"), "", ""),
            opts.timeout
          );
        } else {
          const result =
            args[0] === "__control-plane-startup-status" && ++probes > 1
              ? {
                  ok: true,
                  snapshot: hostSnapshot(
                    "needs_attention",
                    "API failed during health probe"
                  )
                }
              : { ok: true, snapshot: hostSnapshot("starting") };
          callback(null, JSON.stringify(result), "");
        }
      });
      let settled: unknown;
      void Promise.resolve(manager.handlers.start()).then((result: unknown) => {
        settled = result;
      });
      await vi.advanceTimersByTimeAsync(6_100);
      expect(settled).toMatchObject({
        ok: false,
        error: "API failed during health probe"
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports a timeout rather than success when services never become ready", async () => {
    vi.useFakeTimers();
    try {
      const { manager, execFile } = harness(
        verifiedHome(),
        () => lifecycleReply(stopped, true),
        { sharedControl: true }
      );
      const component = { state: "starting" };
      execFile.mockImplementation((_command, args, _opts, callback) => {
        const result =
          args[0] === "status"
            ? {
                ok: true,
                state: "starting",
                koedHome: "/test",
                generatedAt: new Date().toISOString(),
                runtimeMode: "local-personal",
                dependencyMode: "external",
                api: { ...component, url: "http://localhost" },
                database: component,
                redis: component,
                workerQueues: component,
                embeddingService: component,
                privacyService: component,
                localAiRuntime: component,
                apiToken: { ...component, configured: false }
              }
            : { ok: true, snapshot: hostSnapshot("starting") };
        callback(null, JSON.stringify(result), "");
      });
      const pending = Promise.resolve(manager.handlers.start());
      await vi.advanceTimersByTimeAsync(91_000);
      expect(await pending).toMatchObject({
        ok: false,
        state: "needs_attention"
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds the total startup wait even when status commands stall", async () => {
    vi.useFakeTimers();
    try {
      const { manager, execFile } = harness(
        verifiedHome(),
        () => lifecycleReply(stopped, true),
        { sharedControl: true }
      );
      execFile.mockImplementation((_command, args, opts, callback) => {
        if (
          args[0] === "status" ||
          args[0] === "__control-plane-startup-status"
        ) {
          setTimeout(
            () => callback(new Error("timeout"), "", ""),
            opts.timeout
          );
        } else
          callback(null, JSON.stringify({ ok: true, state: "starting" }), "");
      });
      let settled: unknown;
      void Promise.resolve(manager.handlers.start()).then((result: unknown) => {
        settled = result;
      });
      await vi.advanceTimersByTimeAsync(91_000);
      expect(settled).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not treat a transient or malformed startup probe as a terminal failure", async () => {
    vi.useFakeTimers();
    try {
      const { manager, execFile } = harness(
        verifiedHome(),
        () => lifecycleReply(stopped, true),
        { sharedControl: true }
      );
      let probes = 0;
      execFile.mockImplementation((_command, args, _options, callback) => {
        const result =
          args[0] === "__control-plane-startup-status"
            ? ++probes === 1
              ? { ok: true, snapshot: { state: "needs_attention" } }
              : {
                  ok: true,
                  snapshot: hostSnapshot("needs_attention", "actual failure")
                }
            : { ok: true, state: "starting" };
        callback(null, JSON.stringify(result), "");
      });
      let settled: unknown;
      void Promise.resolve(manager.handlers.start()).then((result: unknown) => {
        settled = result;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toMatchObject({ ok: false, error: "actual failure" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("preserves control attachment failure when an observed lifecycle stops", async () => {
    const home = verifiedHome();
    const { manager, openControlSession, execFile } = harness(
      home,
      () => lifecycleReply(stopped, true),
      { sharedControl: true }
    );
    let snapshot = hostSnapshot("starting");
    execFile.mockImplementation((_command, args, _options, callback) => {
      expect(args[0]).toBe("__control-plane-startup-status");
      callback(null, JSON.stringify({ ok: true, snapshot }), "");
    });
    openControlSession.mockImplementationOnce(async () => {
      await manager.lifecycle.refresh();
      snapshot = { ...hostSnapshot("stopped"), revision: 2 };
      await manager.lifecycle.refresh();
      throw new Error("control attachment sentinel");
    });
    await expect(manager.handlers.start_daemon()).resolves.toMatchObject({
      ok: false,
      state: "needs_attention",
      error: "control attachment sentinel"
    });
  });
  it("reconnects a lost Desktop session and stops retrying on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const home = verifiedHome();
      const {
        manager,
        openControlSession,
        disconnectControlSession,
        execFile
      } = harness(home, () => lifecycleReply(stopped, true), {
        sharedControl: true
      });
      await manager.handlers.start_daemon();
      disconnectControlSession();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(openControlSession).toHaveBeenCalledTimes(2);
      expect(
        execFile.mock.calls.some(
          (call) => call[1]?.[0] === "__control-plane-start-automatic"
        )
      ).toBe(true);
      await manager.shutdown();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(openControlSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("waits for an in-flight reconnect resume before explicit Stop", async () => {
    vi.useFakeTimers();
    try {
      const home = verifiedHome();
      const f = harness(home, () => lifecycleReply(stopped, true), {
        sharedControl: true,
        holdControlResume: true
      });
      await f.manager.handlers.start_daemon();
      f.disconnectControlSession();
      await vi.advanceTimersByTimeAsync(5_000);
      const stopping = f.manager.handlers.stop();
      await Promise.resolve();
      expect(
        f.execFile.mock.calls.some((call) => call[1]?.[0] === "stop")
      ).toBe(false);
      f.releaseResume();
      await stopping;
      expect(
        f.execFile.mock.calls.some((call) => call[1]?.[0] === "stop")
      ).toBe(true);
      await f.manager.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports uncertainty when shutdown follows a lost Desktop session", async () => {
    const home = verifiedHome();
    const { manager, disconnectControlSession } = harness(
      home,
      () => lifecycleReply(stopped, true),
      { sharedControl: true }
    );
    await manager.handlers.start_daemon();
    disconnectControlSession();
    await expect(manager.shutdown()).resolves.toMatchObject({
      ok: false,
      state: "needs_attention"
    });
  });
  it("routes selected packaged starts and stops through the installed control CLI", async () => {
    const home = verifiedHome();
    const { manager, spawn, execFile } = harness(
      home,
      () => lifecycleReply(stopped, true),
      { sharedControl: true }
    );
    await expect(manager.handlers.start_daemon()).resolves.toMatchObject({
      ok: true
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(
      execFile.mock.calls.some(
        (call) =>
          call[0] === "/installed-control" &&
          call[1]?.[0] === "__control-plane-start-desktop"
      )
    ).toBe(true);
    await manager.handlers.stop();
    expect(
      execFile.mock.calls.some(
        (call) => call[0] === "/installed-control" && call[1]?.[0] === "stop"
      )
    ).toBe(true);
  });
  it("uses automatic intent for Desktop resume", async () => {
    const home = verifiedHome();
    const { manager, execFile } = harness(
      home,
      () => lifecycleReply(stopped, true),
      { sharedControl: true }
    );
    execFile.mockImplementation((_command, _args, _options, callback) =>
      callback(
        null,
        JSON.stringify({ ok: false, error: "explicit stop remains" }),
        ""
      )
    );
    await manager.resume();
    expect(
      execFile.mock.calls.some(
        (call) => call[1]?.[0] === "__control-plane-start-automatic"
      )
    ).toBe(true);
  });
  it("waits for control-plane activation before an explicit stop", async () => {
    const home = verifiedHome();
    const { manager, execFile, releaseStart } = harness(
      home,
      () => lifecycleReply(stopped, true),
      { sharedControl: true, holdControlStart: true }
    );
    const start = manager.handlers.start_daemon();
    await vi.waitFor(() =>
      expect(
        execFile.mock.calls.some(
          (call) => call[1]?.[0] === "__control-plane-start-desktop"
        )
      ).toBe(true)
    );
    const queuedStart = manager.handlers.start_daemon();
    const stop = manager.handlers.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(execFile.mock.calls.some((call) => call[1]?.[0] === "stop")).toBe(
      false
    );
    releaseStart();
    await Promise.all([start, queuedStart, stop]);
    expect(
      execFile.mock.calls.filter(
        (call) => call[1]?.[0] === "__control-plane-start-desktop"
      )
    ).toHaveLength(1);
    expect(execFile.mock.calls.some((call) => call[1]?.[0] === "stop")).toBe(
      true
    );
  });
  it("adopts a Desktop-owned supervisor started by the installed CLI without spawning another", async () => {
    const home = verifiedHome();
    observed.current = live(77);
    const { manager, spawn, spawned } = harness(home, () =>
      lifecycleReply(live(77), true)
    );
    await expect(manager.handlers.start_daemon()).resolves.toMatchObject({
      ok: true,
      state: "starting",
      adoptedPid: 77
    });
    // Only the short-lived management session exists, and it is closed.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawned[0]!.listenerCount("exit")).toBe(0);
    expect(
      (spawned[0] as unknown as { kill: ReturnType<typeof vi.fn> }).kill
    ).toHaveBeenCalledWith("SIGTERM");
  });

  it("refuses a live supervisor owned by another installation or still unpinned", async () => {
    const home = verifiedHome();
    observed.current = live(78);
    const foreign = harness(home, () => lifecycleReply(live(78), false));
    await expect(
      foreign.manager.handlers.start_daemon()
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/not owned by this Desktop installation/)
    });
    const unpinned = harness(home, () => ({
      ...live(78),
      owner: null,
      owned: false
    }));
    await expect(
      unpinned.manager.handlers.start_daemon()
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/still starting/)
    });
    expect(unpinned.spawn).toHaveBeenCalledTimes(1);
  });

  it("reconnects to the single winner when a simultaneous start loses the supervisor lock", async () => {
    const home = verifiedHome();
    let winner = false;
    const { manager, spawn } = harness(
      home,
      () =>
        winner ? lifecycleReply(live(79), true) : { ...stopped, owned: false },
      { failSupervisorStart: true }
    );
    spawn.mockImplementationOnce(spawn.getMockImplementation() as never);
    const started = manager.handlers.start_daemon();
    winner = true;
    observed.current = live(79);
    await expect(started).resolves.toMatchObject({ ok: true, adoptedPid: 79 });
  });

  it("includes bounded management stderr when its handshake fails", async () => {
    const { manager } = harness(verifiedHome(), () => ({ ...stopped }), {
      managementStderr: `${"x".repeat(5000)}\nError: runtime lifecycle is locked`
    });
    const result = await manager.handlers.start_daemon();
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("runtime lifecycle is locked")
    });
    expect(String((result as { error: string }).error).length).toBeLessThan(
      4200
    );
  });

  it("retains stderr for invalid management handshakes without reclassifying failure", async () => {
    const { manager } = harness(verifiedHome(), () => ({ ...stopped }), {
      managementStderr: "Error: malformed initialization",
      invalidManagementHandshake: true
    });
    await expect(manager.handlers.start_daemon()).rejects.toThrow(
      /handshake response is invalid[\s\S]*malformed initialization/
    );
  });

  it("preserves supervisor startup failure when lifecycle stops during failed start", async () => {
    const home = verifiedHome();
    const { manager } = harness(home, () => ({ ...stopped, owned: false }), {
      startupFailure: "Team collaboration requires verified Privacy assets."
    });
    await expect(manager.handlers.start_daemon()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Privacy")
    });
  });

  it("does not start when stop lands while the start is inspecting the instance", async () => {
    const home = verifiedHome();
    const { manager, spawn } = harness(home, () => {
      void manager.stop();
      return { ...stopped, owned: false };
    });
    await expect(manager.handlers.start_daemon()).resolves.toMatchObject({
      ok: false,
      state: "stopped"
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("refreshes a completed external stop before capturing the next start generation", async () => {
    const home = verifiedHome();
    observed.current = live(82);
    let resolveLifecycle!: (value: Record<string, unknown>) => void;
    const pendingLifecycle = new Promise<Record<string, unknown>>((resolve) => {
      resolveLifecycle = resolve;
    });
    const { manager, spawn } = harness(home, () => pendingLifecycle);
    await manager.lifecycle.refresh();
    observed.current = { ...stopped };
    const starting = manager.handlers.start_daemon();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));

    await manager.lifecycle.refresh();
    resolveLifecycle({ ...stopped, owned: false });

    await expect(starting).resolves.toMatchObject({
      ok: true,
      state: "starting",
      startedPid: 4001
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not start after shutdown while CLI ownership inspection is pending", async () => {
    const home = verifiedHome();
    let resolveLifecycle!: (value: Record<string, unknown>) => void;
    const pendingLifecycle = new Promise<Record<string, unknown>>((resolve) => {
      resolveLifecycle = resolve;
    });
    const { manager, spawn } = harness(home, () => pendingLifecycle);
    const starting = manager.handlers.start_daemon();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));

    await expect(manager.shutdown()).resolves.toMatchObject({
      state: "detached"
    });
    resolveLifecycle({ ...stopped, owned: false });

    await expect(starting).resolves.toMatchObject({
      ok: false,
      state: "stopped"
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("leaves an adopted instance running on quit but stops the one Desktop started", async () => {
    const home = verifiedHome();
    observed.current = live(80);
    const adopted = harness(home, () => lifecycleReply(live(80), true));
    await adopted.manager.handlers.start_daemon();
    await expect(adopted.manager.shutdown()).resolves.toMatchObject({
      state: "detached"
    });
    expect(
      adopted.execFile.mock.calls.some(([, args]) =>
        (args as string[]).includes("stop")
      )
    ).toBe(false);

    observed.current = { ...stopped };
    const owned = harness(home, () => ({ ...stopped, owned: false }));
    await owned.manager.handlers.start_daemon();
    await expect(owned.manager.shutdown()).resolves.toMatchObject({
      ok: true,
      state: "stopped"
    });
  });

  it("reports an externally stopped verified instance as Stopped without running diagnostics", async () => {
    const home = verifiedHome();
    const { manager, spawn, execFile } = harness(home, () => stopped as never);
    observed.current = { ...stopped };
    await expect(manager.handlers.status()).resolves.toMatchObject({
      lifecycle: { state: "stopped", message: "Koed is not running." },
      api: { state: "needs_attention" }
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fences a status collected for an older supervisor epoch and notifies on external stop", async () => {
    const home = verifiedHome();
    observed.current = live(81);
    const { manager, execFile } = harness(home, () => stopped as never);
    execFile.mockImplementation(((
      _c: unknown,
      _a: unknown,
      _o: unknown,
      callback: (e: null, o: string, s: string) => void
    ) => {
      // The instance is stopped while the old full response is being collected.
      observed.current = { ...stopped };
      callback(
        null,
        JSON.stringify({
          ok: true,
          state: "healthy",
          api: { state: "healthy" }
        }),
        ""
      );
    }) as never);
    const changes: string[] = [];
    manager.lifecycle.subscribe((next) => changes.push(next.state));
    await manager.lifecycle.refresh();
    observed.current = live(81);
    await expect(manager.handlers.status()).resolves.toMatchObject({
      lifecycle: { state: "stopped" }
    });
    expect(changes).toContain("stopped");
  });
});
