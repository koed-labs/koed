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

  it("runs JSON koed-server commands", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/packages/koed-server/dist/cli.js",
      execPath: "/node",
      environment: {},
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

  it("reports missing koed-server CLI as not_configured", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/missing",
      execPath: "/node",
      environment: {},
      existsSync: () => false,
      execFile: () => undefined,
      spawn: () => childProcess() as never,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.doctor!()).resolves.toMatchObject({
      ok: false,
      state: "not_configured"
    });
    expect(manager.handlers.start!()).toMatchObject({
      ok: false,
      state: "not_configured"
    });
  });

  it("starts one koed-server process and stops it on quit", () => {
    const spawned = childProcess();
    const spawnCalls: string[][] = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      execPath: "/node",
      environment: {},
      existsSync: () => true,
      execFile: () => undefined,
      spawn: (_command, args) => {
        spawnCalls.push(args);
        return spawned as never;
      },
      openExternal: async () => undefined
    });

    expect(manager.handlers.start!()).toMatchObject({ state: "starting" });
    expect(manager.handlers.start!()).toMatchObject({
      message: "koed-server already started."
    });
    expect(spawnCalls).toEqual([["/repo/cli.js", "start"]]);

    manager.stop();
    expect(spawned.killed).toBe(true);
  });
});
