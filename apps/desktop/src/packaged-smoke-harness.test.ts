import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachPackagedSmokeHarness } from "./packaged-smoke-harness.js";

const fixture = (packaged = true, connected = true) => {
  const channel = Object.assign(new EventEmitter(), { connected });
  const messages: unknown[] = [];
  const calls: string[] = [];
  const attach = () =>
    attachPackagedSmokeHarness({
      packaged,
      argv: ["--koed-private-smoke"],
      channel,
      send: (value) => messages.push(value),
      invoke: async (command) => {
        calls.push(command);
        return {
          ok: true,
          state: command,
          token: "secret",
          apiToken: { configured: true }
        };
      },
      stop: async () => {
        calls.push("cleanup");
      },
      quit: () => {
        calls.push("quit");
      }
    });
  const request = (command: string, id = "request-1") =>
    channel.emit("message", {
      type: "koed.desktop.smoke.request",
      version: 1,
      id,
      command
    });
  return { channel, messages, calls, attach, request };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("private packaged smoke harness", () => {
  it("requires packaged main and inherited connected IPC, not flag alone", () => {
    for (const [packaged, connected] of [
      [false, true],
      [true, false]
    ]) {
      const f = fixture(packaged, connected);
      expect(f.attach()).toBe(false);
      f.request("start_daemon");
      expect(f.calls).toEqual([]);
      expect(f.messages).toEqual([]);
    }
  });
  it("rejects arbitrary commands and malformed envelopes without manager effects", async () => {
    const f = fixture();
    f.attach();
    f.request("connect_team_backend");
    f.channel.emit("message", {
      type: "koed.desktop.smoke.request",
      version: 1,
      id: "bad",
      command: "start_daemon",
      args: { unsafe: true }
    });
    await tick();
    expect(f.calls).toEqual([]);
    expect(f.messages).toHaveLength(3);
    expect(f.messages.slice(1)).toEqual([
      {
        type: "koed.desktop.smoke.response",
        version: 1,
        id: "request-1",
        error: "Invalid smoke request."
      },
      {
        type: "koed.desktop.smoke.response",
        version: 1,
        id: "bad",
        error: "Invalid smoke request."
      }
    ]);
  });
  it("serializes manager lifecycle calls, correlates results, redacts credentials", async () => {
    const f = fixture();
    f.attach();
    f.request("start_daemon", "start");
    f.request("stop", "stop");
    await tick();
    expect(f.calls).toEqual(["start_daemon", "stop"]);
    expect(f.messages).toContainEqual({
      type: "koed.desktop.smoke.response",
      version: 1,
      id: "start",
      result: {
        ok: true,
        state: "start_daemon",
        token: "[redacted]",
        apiToken: { configured: true }
      }
    });
  });
  it("requires explicit smoke argument even with packaged IPC", () => {
    const f = fixture();
    const invoke = vi.fn();
    expect(
      attachPackagedSmokeHarness({
        packaged: true,
        argv: [],
        channel: f.channel,
        send: vi.fn(),
        invoke,
        stop: vi.fn(),
        quit: vi.fn()
      })
    ).toBe(false);
    f.request("start_daemon");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("keeps manager errors fail-closed and processes later status", async () => {
    const f = fixture();
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("verified Privacy assets missing"))
      .mockResolvedValue({ ok: false, state: "needs_attention" });
    attachPackagedSmokeHarness({
      packaged: true,
      argv: ["--koed-private-smoke"],
      channel: f.channel,
      send: (value) => f.messages.push(value),
      invoke,
      stop: vi.fn(),
      quit: vi.fn()
    });
    f.request("start_daemon", "start");
    f.request("status", "status");
    await tick();
    expect(f.messages).toContainEqual({
      type: "koed.desktop.smoke.response",
      version: 1,
      id: "start",
      error: "verified Privacy assets missing"
    });
    expect(f.messages).toContainEqual({
      type: "koed.desktop.smoke.response",
      version: 1,
      id: "status",
      result: { ok: false, state: "needs_attention" }
    });
  });
  it("stops runtime and quits on parent disconnect", async () => {
    const f = fixture();
    f.attach();
    f.channel.emit("disconnect");
    f.request("start_daemon");
    await tick();
    expect(f.calls).toEqual(["cleanup", "quit"]);
  });
});
