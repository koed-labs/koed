import { describe, expect, it, vi } from "vitest";
import {
  createPrivacyInstallBridge,
  privacyInstallStatus
} from "./privacy-install.js";
const ready = {
  activeGeneration: "old",
  required: ["privacy"],
  components: { privacy: "active" },
  model: { ok: true },
  service: { state: "healthy", details: { activeProvider: "cpu" } },
  running: true
};
const fixture = (
  options: {
    startFails?: boolean;
    rollbackFails?: boolean;
    readinessFails?: boolean;
    serviceFails?: boolean;
    coreReady?: boolean;
    running?: boolean;
    onInstall?: () => Promise<void>;
    target?: string;
    activationConflict?: boolean;
    fresh?: boolean;
    rollbackConflict?: boolean;
  } = {}
) => {
  const events: string[] = [];
  let selected: string | null = options.fresh ? null : "old";
  const rpc = vi.fn(
    async <T>(action: string, args?: Record<string, unknown>) => {
      if (action === "status")
        return {
          ...ready,
          activeGeneration: selected,
          running: options.running ?? true,
          ...(options.serviceFails ? { service: { state: "starting" } } : {})
        } as T;
      if (action === "prepare")
        return (
          options.target === "linux"
            ? { target: "linux-x64", variant: "cpu" }
            : { target: "macos-arm64", recoveryGenerationId: "old" }
        ) as T;
      if (action === "cancel") return { cancelled: true } as T;
      events.push(
        `install:${String((args?.source as Record<string, unknown>)?.archiveUrl)}`
      );
      await options.onInstall?.();
      return { state: "staged", generationId: "new" } as T;
    }
  );
  const start = vi.fn(async () => {
    events.push("start");
    return { ok: !options.startFails || start.mock.calls.length > 1 };
  });
  const bridge = createPrivacyInstallBridge({
    productVersion: "0.8.1",
    requestPrivacyRpc: async <T>(
      action: string,
      args?: Record<string, unknown>
    ) => (await rpc(action, args)) as T,
    stop: async () => {
      events.push("stop");
      return { ok: true };
    },
    requestDaemonStart: start,
    pollUntilReady: async () => {
      events.push("ready");
      return { ok: !options.readinessFails };
    },
    canStartServices: async () => options.coreReady ?? true,
    activatePrivacyGeneration: async (id, expected) => {
      events.push(`activate:${id}`);
      expect(expected).toBe(
        id === "new" ? (options.fresh ? null : "old") : "new"
      );
      if (
        (id === "new" && options.activationConflict) ||
        (id === "old" && options.rollbackConflict)
      ) {
        selected = "concurrent";
        throw new Error("Runtime selection changed");
      }
      if (id === "old" && options.rollbackFails)
        throw new Error("rollback failed");
      selected = id;
    }
  });
  return { bridge, events, start, rpc };
};
const install = (bridge: ReturnType<typeof fixture>["bridge"]) =>
  bridge.installPrivacy({ consent: true, onProgress: vi.fn() });
describe("Privacy installation transaction", () => {
  it("installs before the first service start using a persisted Base recovery record", async () => {
    const { bridge, events } = fixture({ fresh: true, running: false });
    await expect(install(bridge)).resolves.toMatchObject({ state: "ready" });
    expect(events.slice(1)).toEqual(["stop", "activate:new", "start", "ready"]);
  });
  it("does not roll a concurrent activation back after compare-and-swap rejection", async () => {
    const { bridge, events, start } = fixture({ activationConflict: true });
    await expect(install(bridge)).rejects.toThrow("selection changed");
    expect(events.slice(1)).toEqual(["stop", "activate:new"]);
    expect(start).not.toHaveBeenCalled();
  });
  it("does not overwrite a newer selection during failed-start recovery", async () => {
    const { bridge, start } = fixture({
      startFails: true,
      rollbackConflict: true
    });
    await expect(install(bridge)).rejects.toThrow("selection changed");
    expect(start).toHaveBeenCalledOnce();
  });
  it("stops, activates and checks both readiness results before reporting ready", async () => {
    const { bridge, events } = fixture();
    await expect(install(bridge)).resolves.toMatchObject({ state: "ready" });
    expect(events.slice(1)).toEqual(["stop", "activate:new", "start", "ready"]);
    expect(events[0]).toContain("koed-privacy-0.8.1-macos-arm64.tar.gz");
  });
  it("downloads the compatibility-selected CPU variant on Linux", async () => {
    const { bridge, events } = fixture({ target: "linux" });
    await install(bridge);
    expect(events[0]).toContain("koed-privacy-0.8.1-linux-x64-cpu.tar.gz");
  });
  it("restores the previous generation after restart failure and reports the original failure", async () => {
    const { bridge, events } = fixture({ startFails: true });
    await expect(install(bridge)).rejects.toThrow("could not restart");
    expect(events.slice(1)).toEqual([
      "stop",
      "activate:new",
      "start",
      "stop",
      "activate:old",
      "start",
      "ready"
    ]);
  });
  it("keeps services stopped when rollback cannot restore the previous generation", async () => {
    const { bridge, events, start } = fixture({
      startFails: true,
      rollbackFails: true
    });
    await expect(install(bridge)).rejects.toThrow("remains stopped");
    expect(events.at(-1)).toBe("activate:old");
    expect(start).toHaveBeenCalledOnce();
  });
  it.each([{ readinessFails: true }, { serviceFails: true }])(
    "rejects incomplete readiness and recovers the previous selection: %s",
    async (options) => {
      const { bridge, events } = fixture(options);
      await expect(install(bridge)).rejects.toThrow();
      expect(events).toContain("activate:old");
    }
  );
  it("leaves a previously stopped installation stopped after a failed start", async () => {
    const { bridge, events, start } = fixture({
      startFails: true,
      running: false
    });
    await expect(install(bridge)).rejects.toThrow("remains stopped");
    expect(events.at(-1)).toBe("activate:old");
    expect(start).toHaveBeenCalledOnce();
  });
  it("stages assets without claiming readiness when other core setup is incomplete", async () => {
    const { bridge, events, start } = fixture({ coreReady: false });
    await expect(install(bridge)).resolves.toMatchObject({
      state: "not_installed",
      installationState: "staged"
    });
    expect(events).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
  });
  it("activates assets during stopped first-run setup without starting missing core assets", async () => {
    const { bridge, events, start } = fixture({
      coreReady: false,
      running: false
    });
    await expect(install(bridge)).resolves.toMatchObject({
      state: "not_installed",
      installationState: "starting"
    });
    expect(events.slice(1)).toEqual(["stop", "activate:new"]);
    expect(start).not.toHaveBeenCalled();
  });
  it("keeps cancellation outside the install queue and preserves selection", async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { bridge, events, rpc } = fixture({ onInstall: () => blocked });
    const pending = install(bridge);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(await bridge.getStatus()).toMatchObject({ state: "installing" });
    await expect(install(bridge)).rejects.toThrow("already active");
    await bridge.cancel();
    expect(rpc.mock.calls.some(([action]) => action === "cancel")).toBe(true);
    finish();
    await expect(pending).rejects.toThrow("cancelled");
    expect(events).toHaveLength(1);
  });
  it("disables cancellation at activation until completion", async () => {
    const { bridge, rpc } = fixture();
    await bridge.installPrivacy({
      consent: true,
      onProgress: (event) => {
        if (event.stage === "activation") {
          expect(event.cancellable).toBe(false);
          void bridge.cancel();
        }
      }
    });
    expect(rpc.mock.calls.some(([action]) => action === "cancel")).toBe(false);
  });
  it("requires consent before any RPC", async () => {
    const { bridge, rpc } = fixture();
    await expect(
      bridge.installPrivacy({ consent: false as never, onProgress: vi.fn() })
    ).rejects.toThrow("consent");
    expect(rpc).not.toHaveBeenCalled();
  });
});
describe("Privacy readiness", () => {
  it("reports a missing model after interrupted provisioning leaves an authenticated runtime cache", () => {
    expect(
      privacyInstallStatus({
        ...ready,
        components: { privacy: "installed" },
        model: { ok: false }
      })
    ).toMatchObject({
      state: "not_installed",
      installationState: "missing_model"
    });
    expect(
      privacyInstallStatus({ ...ready, components: { privacy: "installed" } })
    ).toMatchObject({ state: "not_installed", installationState: "staged" });
  });
  it("distinguishes missing runtime, missing model, activation and service readiness", () => {
    expect(privacyInstallStatus({ ...ready, components: {} })).toMatchObject({
      state: "not_installed",
      installationState: "missing_runtime"
    });
    expect(
      privacyInstallStatus({ ...ready, components: { privacy: "staged" } })
    ).toMatchObject({ installationState: "staged" });
    expect(
      privacyInstallStatus({ ...ready, model: { ok: false } })
    ).toMatchObject({ installationState: "missing_model" });
    expect(
      privacyInstallStatus({ ...ready, model: { state: "checksum_mismatch" } })
    ).toMatchObject({ state: "failed" });
    expect(
      privacyInstallStatus({ ...ready, service: { state: "stopped" } })
    ).toMatchObject({ installationState: "starting" });
    expect(privacyInstallStatus(ready)).toMatchObject({ state: "ready" });
  });
  it("keeps remote/external configurations unavailable for local provisioning", () => {
    expect(privacyInstallStatus({ required: ["base"] })).toMatchObject({
      state: "unavailable"
    });
    expect(
      privacyInstallStatus({ ...ready, requiredManifestPinsAvailable: false })
    ).toMatchObject({ state: "unavailable" });
  });
});
