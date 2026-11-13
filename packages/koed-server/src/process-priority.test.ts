import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKGROUND_NICE,
  lowerBackgroundServicePriority,
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
