import { describe, expect, it, vi } from "vitest";
import { startBackgroundAgent } from "./runtime.js";

describe("Background Agent runtime", () => {
  it("resumes through the control plane and quits only after confirmed disable", async () => {
    const actions: string[] = [];
    const agent = await startBackgroundAgent({
      control: {
        resume: async () => {
          actions.push("resume");
        },
        disable: async () => {
          actions.push("disable");
        }
      },
      command: async (command) => {
        actions.push(command);
        return { ok: true };
      },
      onError: (error) => {
        throw error;
      },
      quit: () => {
        actions.push("quit");
      }
    });
    await agent.quit();
    expect(actions).toEqual(["resume", "disable", "quit"]);
  });
  it("sends explicit Start from the menu", async () => {
    const calls: string[] = [];
    const agent = await startBackgroundAgent({
      control: {
        resume: async () => undefined,
        disable: async () => undefined
      },
      command: async (command) => {
        calls.push(command);
        return { ok: true };
      },
      onError: (error) => {
        throw error;
      },
      quit: () => undefined
    });
    await agent.start();
    expect(calls).toEqual(["start"]);
  });
  it("retries resume after registration races the central attach", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const agent = await startBackgroundAgent({
        control: {
          resume: async () => {
            attempts++;
          },
          disable: async () => undefined
        },
        command: async () => ({ ok: true }),
        onError: (error) => {
          throw error;
        },
        quit: () => undefined
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toBe(2);
      await agent.quit();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not quit if unregister or Stop is uncertain", async () => {
    let quit = false;
    const errors: Error[] = [];
    const agent = await startBackgroundAgent({
      control: {
        resume: async () => undefined,
        disable: async () => {
          throw new Error("uncertain");
        }
      },
      command: async () => ({ ok: true }),
      onError: (error) => {
        errors.push(error);
      },
      quit: () => {
        quit = true;
      }
    });
    await agent.quit();
    expect(quit).toBe(false);
    expect(errors[0]?.message).toBe("uncertain");
  });
});
