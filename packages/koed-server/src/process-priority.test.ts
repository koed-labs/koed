import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKGROUND_NICE,
  lowerBackgroundServicePriority,
  resolveManagedPriorityPrefix,
  spawnSyncWithPriority,
  resolveBackgroundNice,
  type ProcessPriorityApi
} from "./process-priority.js";

const priorityApi = (current: number) => {
  const api = {
    getPriority: vi.fn<ProcessPriorityApi["getPriority"]>(() => current),
    setPriority: vi.fn<ProcessPriorityApi["setPriority"]>()
  };
  return api;
};

describe("resolveBackgroundNice", () => {
  it("defaults to nice 10", () => {
    expect(resolveBackgroundNice({})).toBe(DEFAULT_BACKGROUND_NICE);
    expect(resolveBackgroundNice({ KOED_BACKGROUND_NICE: " " })).toBe(10);
  });

  it("accepts 1-19 and treats 0 as off", () => {
    expect(resolveBackgroundNice({ KOED_BACKGROUND_NICE: "15" })).toBe(15);
    expect(resolveBackgroundNice({ KOED_BACKGROUND_NICE: "19" })).toBe(19);
    expect(resolveBackgroundNice({ KOED_BACKGROUND_NICE: "0" })).toBeNull();
  });

  it.each(["-5", "20", "low", "1.5"])(
    "warns and uses the default for %s",
    (value) => {
      const warn = vi.fn();
      expect(resolveBackgroundNice({ KOED_BACKGROUND_NICE: value }, warn)).toBe(
        DEFAULT_BACKGROUND_NICE
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("KOED_BACKGROUND_NICE")
      );
    }
  );
});

describe("resolveManagedPriorityPrefix", () => {
  const options = (current: number) => ({
    platform: "darwin",
    getPriority: () => current,
    canExecute: () => true,
    warn: vi.fn()
  });

  it("resolves the relative priority increment without changing the parent", () => {
    expect(
      resolveManagedPriorityPrefix({ KOED_BACKGROUND_NICE: "10" }, options(3))
    ).toEqual(["/usr/bin/nice", "-n", "7"]);
  });

  it("never raises an already lower priority or adds a wrapper when disabled", () => {
    expect(resolveManagedPriorityPrefix({}, options(15))).toEqual([]);
    expect(
      resolveManagedPriorityPrefix({ KOED_BACKGROUND_NICE: "0" }, options(0))
    ).toEqual([]);
  });

  it("warns and leaves launches direct if the priority cannot be determined", () => {
    const warn = vi.fn();
    expect(
      resolveManagedPriorityPrefix(
        {},
        {
          ...options(0),
          warn,
          getPriority: () => {
            throw new Error("unavailable");
          }
        }
      )
    ).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  });

  it("warns and launches directly if the priority utility is not executable", () => {
    const warn = vi.fn();
    expect(
      resolveManagedPriorityPrefix(
        {},
        { ...options(0), canExecute: () => false, warn }
      )
    ).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  });

  it("does not use the macOS utility on another platform", () => {
    expect(
      resolveManagedPriorityPrefix({}, { ...options(0), platform: "linux" })
    ).toEqual([]);
  });
});

describe("spawnSyncWithPriority", () => {
  const result = (overrides: Record<string, unknown> = {}) =>
    ({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      ...overrides
    }) as never;
  it("retries directly only when the wrapper could not start", () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce(
        result({
          error: Object.assign(new Error("denied"), { code: "EACCES" })
        })
      )
      .mockReturnValueOnce(result({ pid: 42, status: 0 }));
    const warn = vi.fn();
    expect(
      spawnSyncWithPriority(
        spawn,
        ["/usr/bin/nice", "-n", "10"],
        "pg_ctl",
        ["start"],
        undefined,
        warn
      ).status
    ).toBe(0);
    expect(spawn).toHaveBeenNthCalledWith(2, "pg_ctl", ["start"], undefined);
    expect(warn).toHaveBeenCalledOnce();
  });
  it("retries a real target after the OS rejects a nonexistent wrapper", () => {
    const warn = vi.fn();
    const result = spawnSyncWithPriority(
      spawnSync as never,
      ["/nonexistent/koed-priority-wrapper"],
      process.execPath,
      ["-e", "process.exit(0)"],
      { encoding: "utf8" },
      warn
    );
    expect(result.status).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("never retries when a process might have started or the target returned failure", () => {
    for (const first of [
      result({
        pid: 12,
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
      }),
      result({ pid: 13, status: 127 })
    ]) {
      const spawn = vi.fn().mockReturnValue(first);
      expect(
        spawnSyncWithPriority(spawn, ["/usr/bin/nice", "-n", "10"], "pg_ctl", [
          "start"
        ])
      ).toBe(first);
      expect(spawn).toHaveBeenCalledOnce();
    }
  });
});

describe("lowerBackgroundServicePriority", () => {
  it("lowers the current process to the configured nice value", () => {
    const api = priorityApi(0);
    expect(lowerBackgroundServicePriority({}, api)).toEqual({
      applied: true,
      priority: 10
    });
    expect(api.setPriority).toHaveBeenCalledWith(0, 10);
  });

  it("never raises a priority that is already lower", () => {
    const api = priorityApi(15);
    expect(lowerBackgroundServicePriority({}, api)).toEqual({
      applied: false,
      reason: "already_lower",
      priority: 15
    });
    expect(api.setPriority).not.toHaveBeenCalled();
  });

  it("does nothing when turned off", () => {
    const api = priorityApi(0);
    expect(
      lowerBackgroundServicePriority({ KOED_BACKGROUND_NICE: "0" }, api)
    ).toEqual({ applied: false, reason: "disabled" });
    expect(api.getPriority).not.toHaveBeenCalled();
    expect(api.setPriority).not.toHaveBeenCalled();
  });

  it("warns instead of failing startup when the OS refuses", () => {
    const api = priorityApi(0);
    api.setPriority.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const warn = vi.fn();
    expect(lowerBackgroundServicePriority({}, api, warn)).toEqual({
      applied: false,
      reason: "failed"
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });
});
