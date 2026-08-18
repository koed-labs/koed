// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, KoedServerStatus } from "../../types.js";
import {
  DesktopCommandError,
  DesktopStatusStore,
  invokeDesktop
} from "./desktop-commands.js";

const status = (ok = true) =>
  ({
    ok,
    state: ok ? "healthy" : "needs_attention",
    generatedAt: "2026-07-23T00:00:00.000Z"
  }) as KoedServerStatus;

afterEach(() => {
  delete window.koedDesktop;
  vi.useRealTimers();
});

describe("invokeDesktop", () => {
  it("requires the protected Desktop bridge", async () => {
    await expect(invokeDesktop("status")).rejects.toBeInstanceOf(
      DesktopCommandError
    );
  });

  it("bounds every command with a timeout", async () => {
    vi.useFakeTimers();
    window.koedDesktop = {
      invoke: () => new Promise(() => undefined)
    } as DesktopApi;
    const pending = invokeDesktop("status", undefined, 25);
    const expectation = expect(pending).rejects.toThrow(
      "did not finish within 1 seconds"
    );
    await vi.advanceTimersByTimeAsync(25);
    await expectation;
  });

  it("allows aggregate status to finish after bundled-local warmup", async () => {
    vi.useFakeTimers();
    let resolve!: (value: KoedServerStatus) => void;
    window.koedDesktop = {
      invoke: () =>
        new Promise<KoedServerStatus>((done) => {
          resolve = done;
        })
    } as DesktopApi;

    const pending = invokeDesktop<KoedServerStatus>("status");
    await vi.advanceTimersByTimeAsync(120_001);
    resolve(status());

    await expect(pending).resolves.toEqual(status());
  });
});

describe("DesktopStatusStore", () => {
  it("deduplicates concurrent status refreshes", async () => {
    let resolve!: (value: KoedServerStatus) => void;
    const invoke = vi.fn(
      () =>
        new Promise<KoedServerStatus>((done) => {
          resolve = done;
        })
    );
    window.koedDesktop = { invoke } as DesktopApi;
    const store = new DesktopStatusStore();
    const first = store.refresh();
    const second = store.refresh();
    expect(invoke).toHaveBeenCalledTimes(1);
    resolve(status());
    await expect(first).resolves.toEqual(status());
    await expect(second).resolves.toEqual(status());
    expect(store.current().revision).toBe(1);
  });

  it("refreshes authoritative status after a successful operation", async () => {
    const invoke = vi
      .fn<DesktopApi["invoke"]>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(status());
    window.koedDesktop = { invoke } as DesktopApi;
    const store = new DesktopStatusStore();

    await store.run("repair_codex");

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "repair_codex",
      "status"
    ]);
    expect(store.current()).toMatchObject({
      busyCommand: null,
      error: null,
      revision: 1,
      status: status()
    });
  });

  it.each(["setup_pi", "setup_claude"] as const)(
    "refreshes optional AI Client status after %s",
    async (command) => {
      const invoke = vi
        .fn<DesktopApi["invoke"]>()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce(status());
      window.koedDesktop = { invoke } as DesktopApi;
      const store = new DesktopStatusStore();

      await store.run(command);

      expect(invoke.mock.calls.map(([name]) => name)).toEqual([
        command,
        "status"
      ]);
    }
  );
});
