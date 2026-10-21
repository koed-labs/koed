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
  } = {}
) => {
  const spawned: EventEmitter[] = [];
  const actions: string[] = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      pid: 4000 + spawned.length,
      kill: vi.fn(() => true),
      send(message: Record<string, unknown>) {
        if (message.type === "koed.desktop.supervisor.init") {
          if (message.mode === undefined && options.startupFailure) {
            queueMicrotask(() => {
              observed.current = {
                state: "starting",
                epoch: `${child.pid}:starting`,
                pid: child.pid
              };
              manager.lifecycle.refresh();
              observed.current = { ...stopped };
              manager.lifecycle.refresh();
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
  const execFile = vi.fn((_command, _args, _options, callback) =>
    callback(null, JSON.stringify({ ok: true, state: "stopped" }), "")
  );
  const manager = createKoedServerManager({
    repoRoot: "/repo",
    cliPath: "/repo/cli.js",
    environment: { KOED_HOME: home },
    createCliInvocation: (args) => ({ command: "/node", args, env: {} }),
    createSupervisorInvocation: () => ({
      command: "/electron",
      args: ["private-entry.js"],
      env: {}
    }),
    packagedResourcesPath: "/app/Contents/Resources",
    existsSync: () => true,
    execFile,
    spawn: spawn as never,
    openExternal: async () => undefined
  });
  return { manager, spawn, spawned, actions, execFile };
};

describe("Desktop manager shared lifecycle", () => {
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
    manager.lifecycle.refresh();
    observed.current = { ...stopped };
    const starting = manager.handlers.start_daemon();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));

    manager.lifecycle.refresh();
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
    manager.lifecycle.refresh();
    observed.current = live(81);
    await expect(manager.handlers.status()).resolves.toMatchObject({
      lifecycle: { state: "stopped" }
    });
    expect(changes).toContain("stopped");
  });
});
