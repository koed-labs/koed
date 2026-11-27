import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server/build-server.js";
import { createManagedIpcCoordinator } from "./managed-ipc-coordinator.js";

vi.mock("../server/build-server.js", () => ({ buildServer: vi.fn() }));

describe("managed coordinator construction failures", () => {
  const close = vi.fn(async () => {});
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(["missing", "null"])(
    "closes the built app before rejecting %s repository observation",
    async (mode) => {
      vi.mocked(buildServer).mockImplementation(async (options) => {
        if (mode === "null") options?.onRepositoryReady?.(null);
        return { close } as Awaited<ReturnType<typeof buildServer>>;
      });
      const endpoint = Object.assign(new EventEmitter(), {
        connected: true,
        send: vi.fn(),
        disconnect: vi.fn()
      });
      await expect(createManagedIpcCoordinator({ endpoint })).rejects.toThrow(
        "repository"
      );
      expect(close).toHaveBeenCalledOnce();
      expect(endpoint.send).not.toHaveBeenCalled();
      expect(endpoint.listenerCount("message")).toBe(0);
    }
  );
});
