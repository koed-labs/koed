import { describe, expect, it, vi } from "vitest";
const setup = vi.hoisted(() => ({
  claude: vi.fn(async () => ({ ok: true })),
  pi: vi.fn(async () => ({ ok: true }))
}));
vi.mock("./claude-setup.js", () => ({ setupClaude: setup.claude }));
vi.mock("./pi-setup.js", () => ({ setupPi: setup.pi }));
import { createDesktopStatusRpcHandler } from "./desktop-status-rpc.js";
describe("private Desktop AI Client setup", () => {
  it.each(["setup-claude", "repair-claude", "setup-pi", "repair-pi"])(
    "passes supervisor environment and authority for %s",
    async (action) => {
      const capability = {} as never;
      const environment = {
        KOED_HOME: "/isolated",
        KOED_TEAM_COLLABORATION_ENABLED: "true"
      };
      const send = vi.fn();
      const handler = createDesktopStatusRpcHandler({
        nonce: "a".repeat(64),
        capability,
        environment,
        send
      });
      const request = {
        type: "koed.desktop.status.request",
        nonce: "a".repeat(64),
        requestId: "11111111-1111-4111-8111-111111111111",
        action,
        startup: false
      };
      expect(handler({ ...request, nonce: "foreign" })).toBe(false);
      expect(handler(request)).toBe(true);
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ action, result: { ok: true } })
        )
      );
      expect(
        action.endsWith("claude") ? setup.claude : setup.pi
      ).toHaveBeenLastCalledWith(environment, undefined, {
        desktopRuntimeCapability: capability
      });
    }
  );
});
