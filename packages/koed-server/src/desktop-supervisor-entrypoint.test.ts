import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopSupervisorEnvironment,
  sendDesktopSupervisorStatus
} from "./desktop-supervisor-entrypoint.js";

afterEach(() => vi.unstubAllGlobals());

describe("Desktop supervisor environment", () => {
  it("drops late status responses after disconnect", () => {
    const send = vi.fn();
    vi.stubGlobal("process", { connected: false, send });
    sendDesktopSupervisorStatus({ result: {} });
    expect(send).not.toHaveBeenCalled();
  });

  it("handles a channel closing while a status response is being sent", () => {
    const write = vi.fn();
    const send = vi.fn(
      (_response: unknown, callback: (error: Error) => void) => {
        callback(new Error("channel closed"));
      }
    );
    vi.stubGlobal("process", { connected: true, send, stderr: { write } });
    sendDesktopSupervisorStatus({ result: {} });
    expect(send).toHaveBeenCalledWith({ result: {} }, expect.any(Function));
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("channel closed")
    );
  });
  it("removes inherited resource-path authority", () => {
    const environment = createDesktopSupervisorEnvironment({
      KOED_PACKAGED_RESOURCES_PATH: "/untrusted/resources",
      KOED_HOME: "/operator/home"
    });
    expect(environment.KOED_PACKAGED_RESOURCES_PATH).toBeUndefined();
    expect(environment.KOED_PACKAGED_DESKTOP).toBe("1");
    expect(environment.KOED_HOME).toBe("/operator/home");
  });
});
