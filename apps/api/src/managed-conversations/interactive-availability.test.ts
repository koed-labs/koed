import { describe, expect, it, vi } from "vitest";
import { managedInteractiveHandlers } from "./interactive-availability.js";

describe("managed interactive availability", () => {
  it("does not expose or construct a managed terminal handler", () => {
    const createHandler = vi.fn(() => async () => {});
    const handlers = managedInteractiveHandlers(createHandler);
    expect(handlers.has("managed_terminal")).toBe(false);
    expect(createHandler).not.toHaveBeenCalled();
  });
});
