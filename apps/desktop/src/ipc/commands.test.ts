import { describe, expect, it } from "vitest";
import { invokeChannel, registerDesktopCommandHandlers } from "./commands.js";

describe("desktop IPC command registry", () => {
  it("registers generic invoke handler", async () => {
    let registered!: (
      event: unknown,
      command: string,
      args?: Record<string, unknown>
    ) => Promise<unknown>;

    registerDesktopCommandHandlers(
      {
        handle: (channel, handler) => {
          expect(channel).toBe(invokeChannel);
          registered = handler as typeof registered;
        }
      },
      {
        ping: (args) => ({ ok: true, value: args?.value })
      }
    );

    await expect(registered({}, "ping", { value: 42 })).resolves.toEqual({
      ok: true,
      value: 42
    });
    await expect(registered({}, "missing", {})).rejects.toThrow(
      "Unknown desktop command: missing"
    );
  });
});
