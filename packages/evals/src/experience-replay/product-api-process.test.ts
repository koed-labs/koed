import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowlistedProductApiEnvironment,
  startProductApiProcess
} from "./product-api-process.js";

class FakeChild extends EventEmitter {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;

  constructor(
    pid: number,
    private readonly becomeReady: boolean,
    private readonly ignoreGracefulClose = false
  ) {
    super();
    this.pid = pid;
    queueMicrotask(() => {
      if (this.becomeReady) {
        this.emit("message", {
          type: "listening",
          url: `http://127.0.0.1:${40_000 + pid}`
        });
      }
    });
  }

  send(message: unknown): boolean {
    if (
      (message as { type?: string }).type === "close" &&
      !this.ignoreGracefulClose
    ) {
      this.finish(0, null);
    }
    return true;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.finish(null, signal);
    return true;
  }

  private finish(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = exitCode;
    this.signalCode = signal;
    this.connected = false;
    queueMicrotask(() => {
      this.emit("exit", exitCode, signal);
      this.emit("close", exitCode, signal);
    });
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("isolated Product API process", () => {
  it("starts concurrent trials with distinct allowlisted environments without mutating the parent", async () => {
    const spawns: Array<{ child: FakeChild; options: SpawnOptions }> = [];
    const spawnChild = vi.fn(
      (_file: string, _args: readonly string[], options: SpawnOptions) => {
        const child = new FakeChild(spawns.length + 1, true);
        spawns.push({ child, options });
        return child as unknown as ChildProcess;
      }
    ) as unknown as typeof import("node:child_process").spawn;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "ready" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      )
    );
    const parentDatabaseUrl = process.env.DATABASE_URL;

    const [first, second] = await Promise.all([
      startProductApiProcess({
        environment: {
          DATABASE_URL: "postgres://trial-one",
          API_TOKEN_PEPPER: "first-secret",
          UNTRUSTED_TRIAL_VALUE: "must-not-cross"
        },
        spawnChild
      }),
      startProductApiProcess({
        environment: {
          DATABASE_URL: "postgres://trial-two",
          API_TOKEN_PEPPER: "second-secret"
        },
        spawnChild
      })
    ]);

    expect(spawns[0]?.options.env).toMatchObject({
      DATABASE_URL: "postgres://trial-one",
      API_TOKEN_PEPPER: "first-secret",
      API_HOST: "127.0.0.1",
      API_PORT: "0"
    });
    expect(spawns[1]?.options.env).toMatchObject({
      DATABASE_URL: "postgres://trial-two",
      API_TOKEN_PEPPER: "second-secret"
    });
    expect(spawns[0]?.options.env).not.toHaveProperty("UNTRUSTED_TRIAL_VALUE");
    expect(process.env.DATABASE_URL).toBe(parentDatabaseUrl);
    expect(spawnChild).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining("product-api-child.js")],
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", "ignore", "ignore", "ipc"]
      })
    );

    await expect(first.close()).resolves.toMatchObject({
      pid: 1,
      graceful: true,
      forced: false,
      exitCode: 0
    });
    await expect(second.close()).resolves.toMatchObject({
      pid: 2,
      graceful: true
    });
  });

  it("terminates and attests a child that fails before readiness", async () => {
    const child = new FakeChild(9, false);
    const spawnChild = vi.fn(
      () => child as unknown as ChildProcess
    ) as unknown as typeof import("node:child_process").spawn;
    queueMicrotask(() => child.emit("message", { type: "startup-error" }));

    await expect(
      startProductApiProcess({
        environment: {},
        spawnChild,
        startupTimeoutMs: 100,
        closeTimeoutMs: 10
      })
    ).rejects.toThrow("exited before readiness");
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("force-kills an unresponsive child and reports that cleanup fact", async () => {
    const child = new FakeChild(10, true, true);
    const spawnChild = vi.fn(
      () => child as unknown as ChildProcess
    ) as unknown as typeof import("node:child_process").spawn;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ready: true }), { status: 200 })
      )
    );
    const api = await startProductApiProcess({
      environment: {},
      spawnChild,
      closeTimeoutMs: 5
    });

    await expect(api.close()).resolves.toMatchObject({
      graceful: false,
      forced: true,
      signal: "SIGKILL"
    });
  });

  it("terminates the isolated process when its trial is cancelled", async () => {
    const child = new FakeChild(11, true);
    const spawnChild = vi.fn(
      () => child as unknown as ChildProcess
    ) as unknown as typeof import("node:child_process").spawn;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ready: true }), { status: 200 })
      )
    );
    const cancellation = new AbortController();
    const api = await startProductApiProcess({
      environment: {},
      signal: cancellation.signal,
      spawnChild
    });

    cancellation.abort("trial-cancelled");
    await expect(api.close()).resolves.toMatchObject({
      graceful: false,
      forced: false,
      signal: "SIGTERM"
    });
  });

  it("rejects an oversized JSON response at the HTTP boundary", async () => {
    const child = new FakeChild(12, true);
    const spawnChild = vi.fn(
      () => child as unknown as ChildProcess
    ) as unknown as typeof import("node:child_process").spawn;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ready: true }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: "x".repeat(100) }), {
          status: 200
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = await startProductApiProcess({
      environment: {},
      spawnChild,
      maxResponseBytes: 32
    });

    await expect(
      api.request({ method: "GET", path: "/bounded" })
    ).rejects.toThrow("size limit");
    await api.close();
  });

  it("selects only declared API configuration", () => {
    expect(
      allowlistedProductApiEnvironment({
        DATABASE_URL: "postgres://trial",
        MEMORY_API_TOKEN: "runtime-only-secret",
        PATH: "/untrusted/bin"
      })
    ).toEqual({
      DATABASE_URL: "postgres://trial",
      API_HOST: "127.0.0.1",
      API_PORT: "0",
      LOG_LEVEL: "silent"
    });
  });
});
