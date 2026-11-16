import { describe, expect, it } from "vitest";
import { createBackgroundAgentControl } from "./control-client.js";

describe("Background Agent control client", () => {
  it("keeps registration when an attach outcome is uncertain", async () => {
    const actions: string[] = [];
    const control = createBackgroundAgentControl({
      ensureStopped: async () => undefined,
      registration: {
        get: async () => ({
          supported: true,
          enabled: false,
          status: "disabled"
        }),
        set: async (value) => {
          actions.push(value ? "register" : "unregister");
          return {
            supported: true,
            enabled: value,
            status: value ? "enabled" : "disabled"
          };
        }
      },
      command: async () => {
        actions.push("attach");
        return { ok: false, error: "refused" };
      }
    });
    await expect(control.enable()).rejects.toThrow("refused");
    expect(actions).toEqual(["register", "attach"]);
  });
  it("does not register while Koed is running", async () => {
    let registered = false;
    const control = createBackgroundAgentControl({
      ensureStopped: async () => {
        throw new Error("Koed is running");
      },
      registration: {
        get: async () => ({
          supported: true,
          enabled: false,
          status: "disabled"
        }),
        set: async () => {
          registered = true;
          return { supported: true, enabled: true, status: "enabled" };
        }
      },
      command: async () => ({ ok: true })
    });
    await expect(control.enable()).rejects.toThrow("Koed is running");
    expect(registered).toBe(false);
  });
  it("serializes concurrent enable requests", async () => {
    let enabled = false;
    let active = 0;
    let maximum = 0;
    const control = createBackgroundAgentControl({
      ensureStopped: async () => undefined,
      registration: {
        get: async () => ({
          supported: true,
          enabled,
          status: enabled ? "enabled" : "disabled"
        }),
        set: async (value) => {
          enabled = value;
          return {
            supported: true,
            enabled,
            status: enabled ? "enabled" : "disabled"
          };
        }
      },
      command: async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { ok: true };
      }
    });
    await Promise.all([control.enable(), control.enable()]);
    expect(maximum).toBe(1);
  });
  it("does not unregister if Stop fails", async () => {
    const actions: string[] = [];
    const control = createBackgroundAgentControl({
      ensureStopped: async () => undefined,
      registration: {
        get: async () => ({
          supported: true,
          enabled: true,
          status: "enabled"
        }),
        set: async () => {
          actions.push("unregister");
          return { supported: true, enabled: false, status: "disabled" };
        }
      },
      command: async () => {
        actions.push("stop");
        return { ok: false, error: "uncertain cleanup" };
      }
    });
    await expect(control.disable()).rejects.toThrow("uncertain cleanup");
    expect(actions).toEqual(["stop"]);
  });
  it("never automatically starts when the Agent is disabled or explicit Stop is set", async () => {
    const commands: string[] = [];
    const control = createBackgroundAgentControl({
      ensureStopped: async () => undefined,
      registration: {
        get: async () => ({
          supported: true,
          enabled: true,
          status: "enabled"
        }),
        set: async () => ({ supported: true, enabled: true, status: "enabled" })
      },
      command: async (value) => {
        commands.push(value);
        return {
          ok: true,
          snapshot: { backgroundEnabled: true, stopIntent: true }
        };
      }
    });
    await control.resume();
    expect(commands).toEqual(["agent-status"]);
  });
  it("stops, detaches availability and then unregisters", async () => {
    const actions: string[] = [];
    const control = createBackgroundAgentControl({
      ensureStopped: async () => undefined,
      registration: {
        get: async () => ({
          supported: true,
          enabled: true,
          status: "enabled"
        }),
        set: async () => {
          actions.push("unregister");
          return { supported: true, enabled: false, status: "disabled" };
        }
      },
      command: async (command) => {
        actions.push(command);
        return { ok: true };
      }
    });
    await control.disable();
    expect(actions).toEqual(["stop", "agent-disable", "unregister"]);
  });
});
