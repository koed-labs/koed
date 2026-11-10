import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAiClientConnected,
  readAiClientConnections
} from "@koed/shared/ai-client-connections";
const setup = vi.hoisted(() => ({
  home: "",
  verified: true,
  doctorOk: true,
  claude: vi.fn(async () => ({ ok: true, koedHome: setup.home })),
  pi: vi.fn(async () => ({ ok: true, koedHome: setup.home }))
}));
vi.mock("./claude-setup.js", () => ({ setupClaude: setup.claude }));
vi.mock("./pi-setup.js", () => ({ setupPi: setup.pi }));
vi.mock("./status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status.js")>()),
  collectKoedServerDoctor: async () => ({
    ok: setup.doctorOk,
    generatedAt: "2026-11-09T12:00:00.000Z",
    summary: setup.doctorOk
      ? "Core setup verified."
      : "Core setup needs attention.",
    checks: []
  }),
  collectKoedServerStatus: async () => ({
    koedHome: setup.home,
    claudeCode: { configured: setup.verified },
    pi: { configured: setup.verified }
  })
}));
import { createDesktopStatusRpcHandler } from "./desktop-status-rpc.js";

afterEach(() => {
  if (setup.home) rmSync(setup.home, { recursive: true, force: true });
  setup.home = "";
  setup.verified = true;
  setup.doctorOk = true;
});

const runSetup = async (action: string) => {
  setup.home = mkdtempSync(join(tmpdir(), "koed-desktop-rpc-"));
  const capability = {} as never;
  const environment = {
    KOED_HOME: setup.home,
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
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  return { send, capability, environment };
};

describe("private Desktop AI Client setup", () => {
  it.each([true, false])(
    "persists the core doctor result for subsequent onboarding readiness checks (ok=%s)",
    async (ok) => {
      setup.doctorOk = ok;
      await runSetup("doctor");
      expect(
        JSON.parse(
          readFileSync(join(setup.home, "run/last-verification.json"), "utf8")
        )
      ).toEqual({
        ok,
        checkedAt: "2026-11-09T12:00:00.000Z",
        message: ok ? "Core setup verified." : "Core setup needs attention."
      });
    }
  );
  it.each(["setup-claude", "repair-claude", "setup-pi", "repair-pi"])(
    "passes supervisor environment and authority for %s and connects it",
    async (action) => {
      const { send, capability, environment } = await runSetup(action);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          result: { ok: true, koedHome: setup.home }
        })
      );
      expect(
        action.endsWith("claude") ? setup.claude : setup.pi
      ).toHaveBeenLastCalledWith(environment, undefined, {
        desktopRuntimeCapability: capability
      });
      expect(
        isAiClientConnected(
          readAiClientConnections(setup.home),
          action.endsWith("claude") ? "claude" : "pi"
        )
      ).toBe(true);
    }
  );

  it.each(["setup-claude", "setup-pi"])(
    "leaves capture off when %s cannot be verified",
    async (action) => {
      setup.verified = false;
      const { send } = await runSetup(action);
      const [message] = send.mock.calls[0] as [
        { action: string; result: { ok: boolean } }
      ];
      expect(message.action).toBe(action);
      expect(message.result.ok).toBe(false);
      expect(
        isAiClientConnected(
          readAiClientConnections(setup.home),
          action.endsWith("claude") ? "claude" : "pi"
        )
      ).toBe(false);
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
