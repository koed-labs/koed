import { describe, expect, it, vi } from "vitest";
import { runControlPlaneCli } from "./cli.js";
import { ControlOwnerGoneError } from "./connect-or-launch.js";
import type { ControlClient } from "./client.js";
import type { ControlSnapshot } from "@koed-labs/shared/local-control-protocol";
const snapshot: ControlSnapshot = {
  instanceId: "i",
  revision: 2,
  state: "stopped",
  stopIntent: false
};
describe("packaged control-plane CLI", () => {
  it("routes daemon start through status and the authenticated host", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ requestId: "1", ok: true, snapshot })
      .mockResolvedValueOnce({
        requestId: "2",
        ok: true,
        snapshot: { ...snapshot, state: "starting", revision: 3 }
      });
    const close = vi.fn();
    const stdout = { write: vi.fn() };
    const code = await runControlPlaneCli(["start", "--daemon", "--json"], {
      connect: async () => ({ request, close }) as ControlClient,
      stdout,
      stderr: { write: vi.fn() }
    });
    expect(code).toBe(0);
    expect(request).toHaveBeenNthCalledWith(1, { action: "status" }, 0);
    expect(request).toHaveBeenNthCalledWith(
      2,
      { action: "start", explicit: true },
      2
    );
    expect(close).toHaveBeenCalledOnce();
  });
  it("records persistent CLI demand before starting when requested", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ requestId: "1", ok: true, snapshot })
      .mockResolvedValueOnce({
        requestId: "2",
        ok: true,
        snapshot: { ...snapshot, revision: 3 }
      })
      .mockResolvedValueOnce({
        requestId: "3",
        ok: true,
        snapshot: { ...snapshot, revision: 4, state: "starting" }
      });
    const code = await runControlPlaneCli(["start", "--daemon"], {
      connect: async () => ({ request, close: vi.fn() }) as ControlClient,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      persistentStart: true
    });
    expect(code).toBe(0);
    expect(request).toHaveBeenNthCalledWith(
      2,
      { action: "start", explicit: true, persistentCli: true },
      2
    );
  });
  it("records offline Stop after a rejected response if the owner has exited", async () => {
    const offlineStop = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ clean: true });
    const request = vi.fn().mockResolvedValue({
      requestId: "1",
      ok: false,
      code: "blocked",
      snapshot
    });
    const code = await runControlPlaneCli(["stop"], {
      connect: async () => ({ request, close: vi.fn() }) as ControlClient,
      offlineStop,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() }
    });
    expect(code).toBe(0);
    expect(offlineStop).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledOnce();
  });
  it("reports an unconfirmed Stop when live-owner admission is unavailable", async () => {
    const stderr = { write: vi.fn() };
    const code = await runControlPlaneCli(["stop"], {
      connect: async () => {
        throw new Error("connection refused");
      },
      offlineStop: () => undefined,
      stdout: { write: vi.fn() },
      stderr
    });
    expect(code).toBe(1);
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining(
        "Stop could not be confirmed and may not have been recorded"
      )
    );
  });
  it("records offline Stop when connection fails after the host dies", async () => {
    const offlineStop = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ clean: true });
    const code = await runControlPlaneCli(["stop"], {
      connect: async () => {
        throw new Error("connection refused");
      },
      offlineStop,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() }
    });
    expect(code).toBe(0);
    expect(offlineStop).toHaveBeenCalledTimes(2);
  });
  it.each(["status", "stop"])(
    "records offline Stop if the host dies during %s",
    async (phase) => {
      const request = vi.fn();
      if (phase === "stop")
        request.mockResolvedValueOnce({ requestId: "1", ok: true, snapshot });
      request.mockRejectedValueOnce(new Error("connection lost"));
      const offlineStop = vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({ clean: true });
      const close = vi.fn();
      const code = await runControlPlaneCli(["stop"], {
        connect: async () => ({ request, close }) as ControlClient,
        offlineStop,
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() }
      });
      expect(code).toBe(0);
      expect(offlineStop).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledTimes(phase === "stop" ? 2 : 1);
      expect(close).toHaveBeenCalledOnce();
    }
  );
  it("bounds an unresponsive status request during Stop", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ requestId: "1", ok: true, snapshot })
      .mockResolvedValueOnce({
        requestId: "2",
        ok: true,
        snapshot: { ...snapshot, state: "stopping" }
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    const close = vi.fn();
    const code = await runControlPlaneCli(["stop"], {
      connect: async () => ({ request, close }) as ControlClient,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      sleep: async () => {},
      stopTimeoutMs: 5
    });
    expect(code).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });
  it("only allows an internal non-explicit stop when explicitly enabled", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ requestId: "1", ok: true, snapshot });
    const connect = vi.fn(
      async () => ({ request, close: vi.fn() }) as ControlClient
    );
    const output = { write: vi.fn() };
    expect(
      await runControlPlaneCli(["stop", "--non-explicit"], {
        connect,
        stdout: output,
        stderr: output
      })
    ).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(
      await runControlPlaneCli(["stop", "--non-explicit"], {
        connect,
        stdout: output,
        stderr: output,
        allowImplicitStop: true
      })
    ).toBe(0);
    expect(request).toHaveBeenNthCalledWith(
      2,
      { action: "stop", explicit: false },
      2
    );
  });
  it("reports the central Agent availability and Stop intent", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      requestId: "1",
      snapshot: { ...snapshot, backgroundEnabled: true, stopIntent: true }
    });
    const stdout = { write: vi.fn() };
    const result = await runControlPlaneCli(["agent-status", "--json"], {
      connect: async () => ({ request, close: vi.fn() }) as ControlClient,
      stdout,
      stderr: { write: vi.fn() },
      allowAgentAvailability: true
    });
    expect(result).toBe(0);
    const output = JSON.parse(String(stdout.write.mock.calls[0]![0])) as {
      snapshot: { backgroundEnabled: boolean; stopIntent: boolean };
    };
    expect(output.snapshot).toMatchObject({
      backgroundEnabled: true,
      stopIntent: true
    });
  });
  it("allows only an authorized Agent availability command", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ requestId: "1", ok: true, snapshot });
    const connect = vi.fn(
      async () => ({ request, close: vi.fn() }) as ControlClient
    );
    const output = { write: vi.fn() };
    expect(
      await runControlPlaneCli(["agent-enable"], {
        connect,
        stdout: output,
        stderr: output
      })
    ).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(
      await runControlPlaneCli(["agent-enable"], {
        connect,
        stdout: output,
        stderr: output,
        allowAgentAvailability: true
      })
    ).toBe(0);
    expect(request).toHaveBeenNthCalledWith(
      2,
      { action: "attach", reason: "background-agent" },
      2
    );
  });
  it("records Stop if a transient owner exits before publishing", async () => {
    const offlineStop = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ clean: true });
    const stdout = { write: vi.fn() };
    expect(
      await runControlPlaneCli(["stop", "--json"], {
        connect: async () => {
          throw new ControlOwnerGoneError("gone");
        },
        offlineStop,
        stdout,
        stderr: { write: vi.fn() }
      })
    ).toBe(0);
    expect(offlineStop).toHaveBeenCalledTimes(2);
  });
  it("records Stop offline without connecting, but does not claim unclean cleanup", async () => {
    const connect = vi.fn();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = await runControlPlaneCli(["stop", "--json"], {
      connect,
      stdout,
      stderr,
      offlineStop: () => ({ clean: false })
    });
    expect(code).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    const result = JSON.parse(String(stdout.write.mock.calls[0]![0])) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/recorded.*cleanup/i);
  });
  it("retries an explicitly rejected stale Stop with the returned revision", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ requestId: "1", ok: true, snapshot })
      .mockResolvedValueOnce({
        requestId: "2",
        ok: false,
        code: "stale_revision",
        snapshot: { ...snapshot, revision: 3 }
      })
      .mockResolvedValueOnce({
        requestId: "3",
        ok: true,
        snapshot: { ...snapshot, revision: 4 }
      });
    const output = { write: vi.fn() };
    expect(
      await runControlPlaneCli(["stop"], {
        connect: async () => ({ request, close: vi.fn() }) as ControlClient,
        stdout: output,
        stderr: output
      })
    ).toBe(0);
    expect(request).toHaveBeenNthCalledWith(
      3,
      { action: "stop", explicit: true },
      3
    );
  });
  it("retries an explicitly rejected stale Start when Stop is not active", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ requestId: "1", ok: true, snapshot })
      .mockResolvedValueOnce({
        requestId: "2",
        ok: false,
        code: "stale_revision",
        snapshot: { ...snapshot, revision: 3 }
      })
      .mockResolvedValueOnce({
        requestId: "3",
        ok: true,
        snapshot: { ...snapshot, revision: 4, state: "starting" }
      });
    const output = { write: vi.fn() };
    expect(
      await runControlPlaneCli(["start", "--daemon"], {
        connect: async () => ({ request, close: vi.fn() }) as ControlClient,
        stdout: output,
        stderr: output
      })
    ).toBe(0);
    expect(request).toHaveBeenNthCalledWith(
      3,
      { action: "start", explicit: true },
      3
    );
  });
  it("does not retry stale Start if Stop became active", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ requestId: "1", ok: true, snapshot })
      .mockResolvedValueOnce({
        requestId: "2",
        ok: false,
        code: "stale_revision",
        snapshot: { ...snapshot, revision: 3, stopIntent: true }
      });
    const output = { write: vi.fn() };
    expect(
      await runControlPlaneCli(["start", "--daemon"], {
        connect: async () => ({ request, close: vi.fn() }) as ControlClient,
        stdout: output,
        stderr: output
      })
    ).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("restarts by confirming Stop before sending explicit Start", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ requestId: "1", ok: true, snapshot });
    const stdout = { write: vi.fn() };
    expect(
      await runControlPlaneCli(["restart", "--json"], {
        connect: async () => ({ request, close: vi.fn() }) as ControlClient,
        stdout,
        stderr: { write: vi.fn() }
      })
    ).toBe(0);
    expect(request).toHaveBeenNthCalledWith(1, { action: "status" }, 0);
    expect(request).toHaveBeenNthCalledWith(
      2,
      { action: "stop", explicit: true },
      2
    );
    expect(request).toHaveBeenNthCalledWith(3, { action: "status" }, 0);
    expect(request).toHaveBeenNthCalledWith(
      4,
      { action: "start", explicit: true },
      2
    );
    expect(stdout.write).toHaveBeenCalledTimes(1);
  });
  it("does not retry a blocked mutation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ requestId: "1", ok: true, snapshot })
      .mockResolvedValueOnce({
        requestId: "2",
        ok: false,
        code: "blocked",
        snapshot
      });
    const close = vi.fn();
    const code = await runControlPlaneCli(["stop"], {
      connect: async () => ({ request, close }) as ControlClient,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() }
    });
    expect(code).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
});
