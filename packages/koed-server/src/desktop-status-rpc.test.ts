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

const owners = vi.hoisted(() => ({
  desktop: { kind: "desktop" as const, installationId: "d".repeat(32) }
}));
vi.mock("./desktop-runtime-capability.js", () => ({
  resolveDesktopRuntimeOwner: () => owners.desktop
}));
vi.mock("./runtime-lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./runtime-lifecycle.js")>();
  return {
    ...actual,
    observeRuntimeLifecycle: () => ({
      state: "running",
      epoch: "7:live",
      message: "Koed is running.",
      pid: 7,
      processIdentity: "live",
      owner: lifecycleOwner.value
    })
  };
});
const observedLifecycle = {
  state: "running",
  epoch: "7:live",
  message: "Koed is running.",
  pid: 7,
  processIdentity: "live"
};
const lifecycleOwner = vi.hoisted(() => ({
  value: null as { kind: string; installationId: string } | null
}));

describe("private Desktop lifecycle inspection", () => {
  it.each([
    ["the verified Desktop owner", "d".repeat(32), "desktop", true],
    ["another installation", "e".repeat(32), "desktop", false],
    ["a standalone owner", "d".repeat(32), "standalone", false]
  ])(
    "reports ownership for %s",
    async (_label, installationId, kind, owned) => {
      lifecycleOwner.value = { kind, installationId };
      const send = vi.fn();
      const handler = createDesktopStatusRpcHandler({
        nonce: "b".repeat(64),
        capability: {} as never,
        environment: { KOED_HOME: "/isolated" },
        send
      });
      expect(
        handler({
          type: "koed.desktop.status.request",
          nonce: "b".repeat(64),
          requestId: "22222222-2222-4222-8222-222222222222",
          action: "lifecycle",
          startup: false
        })
      ).toBe(true);
      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "lifecycle",
          result: {
            ...observedLifecycle,
            owner: lifecycleOwner.value,
            owned
          }
        })
      );
    }
  );
});
