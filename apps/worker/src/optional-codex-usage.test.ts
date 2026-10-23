import { describe, expect, it, vi } from "vitest";
import { scheduleOptionalCodexUsage } from "./optional-codex-usage.js";

describe("optional completed-turn Codex usage", () => {
  it("preserves provider completion when the configured instance disappears", async () => {
    const onError = vi.fn();
    const completedTurn = async () => {
      scheduleOptionalCodexUsage({
        resolveInstance: () => {
          throw new Error("instance removed");
        },
        publish: async () => {
          throw new Error("must not publish");
        },
        onError
      });
      return "completed";
    };
    await expect(completedTurn()).resolves.toBe("completed");
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "instance removed" })
      )
    );
  });

  it("preserves provider completion when the instance changes before publication", async () => {
    const onError = vi.fn();
    const completedTurn = async () => {
      scheduleOptionalCodexUsage({
        resolveInstance: () => ({ driverId: "changed" }),
        publish: async () => {
          throw new Error("instance changed");
        },
        onError
      });
      return "completed";
    };
    await expect(completedTurn()).resolves.toBe("completed");
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "instance changed" })
      )
    );
  });
});
