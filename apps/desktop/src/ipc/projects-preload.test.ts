import { describe, expect, it, vi } from "vitest";
import { createProjectsPreloadApi } from "./projects-preload.js";
import { projectsCommandChannel } from "./projects-protocol.js";

describe("Projects preload", () => {
  it("validates both directions and operation correlation", async () => {
    const invoke = vi.fn(
      async (channel: string, request: unknown): Promise<unknown> => {
        expect(channel).toBe(projectsCommandChannel);
        expect(request).toEqual({ operation: "list" });
        return { operation: "list", projects: [] };
      }
    );
    const api = createProjectsPreloadApi(invoke);
    await expect(api.list()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith(projectsCommandChannel, {
      operation: "list"
    });
    await expect(api.hq("not-a-project-id")).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockResolvedValueOnce({ operation: "hq", value: {} });
    await expect(api.list()).rejects.toThrow();
    invoke.mockResolvedValueOnce({
      operation: "list",
      projects: [],
      extra: true
    });
    await expect(api.list()).rejects.toThrow();
  });
});
