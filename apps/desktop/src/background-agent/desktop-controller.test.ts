import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundAgentXpcClient } from "./xpc-transport.js";
import { createBackgroundAgentStateStore } from "./state.js";
import { createBackgroundAgentRuntimeLifecycle } from "./runtime-lifecycle.js";
import { createDesktopBackgroundAgentController } from "./desktop-controller.js";

const temporaryRoots: string[] = [];

const createFixture = (
  input: {
    enabled?: boolean;
    lifecycleState?: "stopped" | "starting" | "running" | "unavailable";
    missingState?: boolean;
    stopError?: Error;
    stopResult?: { ok: boolean; state: string; message?: string };
    launchStatus?: "enabled" | "requires-approval";
    launchSetError?: Error;
  } = {}
) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "koed-agent-desktop-"));
  temporaryRoots.push(root);
  const installation = {
    installationId: randomUUID(),
    bundlePath: join(root, "Koed.app"),
    koedHome: join(root, "koed-home")
  };
  mkdirSync(installation.bundlePath, { recursive: true });
  mkdirSync(installation.koedHome, { mode: 0o700 });
  const store = createBackgroundAgentStateStore({ installation });
  if (!input.missingState) store.initialize();
  const launchState = (enabled: boolean) => ({
    enabled,
    status: enabled ? (input.launchStatus ?? "enabled") : ("disabled" as const),
    supported: true
  });
  const sequence: string[] = [];
  const launchConfiguration = {
    write: vi.fn(() => sequence.push("configuration")),
    clear: vi.fn(() => sequence.push("clear-configuration"))
  };
  const launchService = {
    get: vi.fn(async () => launchState(input.enabled ?? false)),
    set: vi.fn(async (enabled: boolean) => {
      sequence.push(enabled ? "register" : "unregister");
      if (input.launchSetError) throw input.launchSetError;
      return launchState(enabled);
    }),
    wasOpenedAtLogin: vi.fn(() => false)
  };
  const stop = vi.fn(async () => {
    sequence.push("stop");
    if (input.stopError) throw input.stopError;
    return input.stopResult ?? { ok: true, state: "stopped" };
  });
  const client = {
    close: vi.fn(),
    status: vi.fn(async () => ({
      protocolVersion: 1,
      requestId: randomUUID(),
      installationId: "00000000-0000-4000-8000-000000000000",
      homeIdentity: "a".repeat(64),
      kind: "status",
      generation: 0,
      state: "ready",
      ok: true
    })),
    start: vi.fn(async () => ({ ok: true, state: "starting" })),
    stop
  } as unknown as BackgroundAgentXpcClient;
  const runtimeLifecycle = createBackgroundAgentRuntimeLifecycle();
  const manager = {
    lifecycle: {
      refresh: vi.fn(() => ({
        state: input.lifecycleState ?? "stopped",
        epoch: input.lifecycleState ?? "stopped",
        message: "Koed is not running."
      }))
    }
  };
  const controller = createDesktopBackgroundAgentController({
    launchService,
    store,
    launchConfiguration,
    manager,
    runtimeLifecycle,
    createClient: vi.fn(() => client)
  });
  return {
    client,
    controller,
    installation,
    launchConfiguration,
    launchService,
    manager,
    runtimeLifecycle,
    store,
    stop,
    sequence
  };
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Desktop Background Agent controller", () => {
  it("keeps the runtime adapter active when a registered Agent has invalid state", async () => {
    const { controller, runtimeLifecycle } = createFixture({
      enabled: true,
      missingState: true
    });

    await controller.initialize();

    expect(runtimeLifecycle.isActive()).toBe(true);
    expect(() => runtimeLifecycle.status()).toThrow(
      "Background Agent state is missing."
    );
  });

  it("refuses to register the Agent while the Desktop owns a live runtime", async () => {
    const { controller, launchService, runtimeLifecycle } = createFixture({
      lifecycleState: "running"
    });

    await expect(controller.set(true)).rejects.toThrow(
      "Stop Koed before enabling the Background Agent."
    );

    expect(launchService.set).not.toHaveBeenCalled();
    expect(runtimeLifecycle.isActive()).toBe(false);
  });

  it("binds state and routes to the Agent before registering its LaunchAgent", async () => {
    const {
      client,
      controller,
      installation,
      launchConfiguration,
      launchService,
      runtimeLifecycle,
      sequence,
      store
    } = createFixture({ missingState: true });

    await expect(controller.set(true)).resolves.toMatchObject({
      enabled: true,
      status: "enabled",
      supported: true
    });

    expect(store.read()).toMatchObject({ kind: "valid" });
    expect(launchConfiguration.write).toHaveBeenCalledWith(
      expect.objectContaining({ bundlePath: installation.bundlePath })
    );
    expect(sequence).toEqual(["configuration", "register"]);
    expect(runtimeLifecycle.isActive()).toBe(true);
    expect(client.status).not.toHaveBeenCalled();
    expect(launchService.set).toHaveBeenCalledWith(true);
  });

  it("persists explicit Stop before unregistering the LaunchAgent", async () => {
    const {
      controller,
      launchService,
      runtimeLifecycle,
      store,
      stop,
      sequence
    } = createFixture({ enabled: true });
    await controller.initialize();

    await expect(controller.set(false)).resolves.toMatchObject({
      enabled: false,
      status: "disabled"
    });

    expect(stop).toHaveBeenCalledWith(true);
    expect(launchService.set).toHaveBeenCalledWith(false);
    expect(sequence).toEqual(["stop", "unregister"]);
    expect(store.read()).toMatchObject({ kind: "valid" });
    expect(runtimeLifecycle.isActive()).toBe(false);
  });

  it("stops an active owner before clearing an already-disabled registration", async () => {
    const { client, controller, launchService, runtimeLifecycle, sequence } =
      createFixture({ enabled: false });
    runtimeLifecycle.activate(client);

    await controller.set(false);

    expect(sequence).toEqual(["stop", "unregister"]);
    expect(runtimeLifecycle.isActive()).toBe(false);
    expect(launchService.set).toHaveBeenCalledWith(false);
  });

  it("retains the saved KOED_HOME when disabling the Background Agent", async () => {
    const { controller, launchConfiguration, sequence } = createFixture();

    await controller.set(true);
    await controller.set(false);

    expect(sequence).toEqual([
      "configuration",
      "register",
      "stop",
      "unregister"
    ]);
    expect(launchConfiguration.write).toHaveBeenCalledOnce();
    expect(launchConfiguration.clear).not.toHaveBeenCalled();
  });

  it("unregisters a LaunchAgent that is still awaiting approval without XPC", async () => {
    const { controller, launchService, stop, runtimeLifecycle } = createFixture(
      {
        enabled: true,
        launchStatus: "requires-approval"
      }
    );
    await controller.initialize();

    await expect(controller.set(false)).resolves.toMatchObject({
      enabled: false,
      status: "disabled"
    });

    expect(stop).not.toHaveBeenCalled();
    expect(launchService.set).toHaveBeenCalledWith(false);
    expect(runtimeLifecycle.isActive()).toBe(false);
  });

  it("keeps the remote owner active if LaunchAgent unregister fails", async () => {
    const { controller, launchService, runtimeLifecycle } = createFixture({
      enabled: true,
      launchSetError: new Error("Service registration could not be changed.")
    });
    await controller.initialize();

    await expect(controller.set(false)).rejects.toThrow(
      "Service registration could not be changed."
    );

    expect(launchService.set).toHaveBeenCalledWith(false);
    expect(runtimeLifecycle.isActive()).toBe(true);
  });

  it("keeps registration if the Agent returns a structured Stop failure", async () => {
    const { controller, launchService, runtimeLifecycle } = createFixture({
      enabled: true,
      stopResult: {
        ok: false,
        state: "needs_attention",
        message: "Koed is still running."
      }
    });
    await controller.initialize();

    await expect(controller.set(false)).rejects.toThrow(
      "Koed is still running."
    );

    expect(launchService.set).not.toHaveBeenCalled();
    expect(runtimeLifecycle.isActive()).toBe(true);
  });

  it("keeps registration and remote ownership if Agent Stop fails", async () => {
    const { controller, launchService, runtimeLifecycle } = createFixture({
      enabled: true,
      stopError: new Error("Agent is unreachable.")
    });
    await controller.initialize();

    await expect(controller.set(false)).rejects.toThrow(
      "Agent is unreachable."
    );

    expect(launchService.set).not.toHaveBeenCalled();
    expect(runtimeLifecycle.isActive()).toBe(true);
  });
});
