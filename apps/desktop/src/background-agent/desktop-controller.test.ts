import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundAgentXpcClient } from "./xpc-transport.js";
import { createBackgroundAgentStateStore } from "./state.js";
import { createBackgroundAgentRuntimeLifecycle } from "./runtime-lifecycle.js";
import {
  createDesktopBackgroundAgentController,
  readLaunchStateOrBlockRuntime
} from "./desktop-controller.js";

const temporaryRoots: string[] = [];

const createFixture = (
  input: {
    enabled?: boolean;
    lifecycleState?: "stopped" | "starting" | "running" | "unavailable";
    missingState?: boolean;
    stopError?: Error;
    stopResult?: { ok: boolean; state: string; message?: string };
    launchStatus?: "enabled" | "requires-approval";
    pendingDisabled?: boolean;
    launchSetError?: Error;
    initialRegistrationUnavailable?: boolean;
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
    get: vi.fn(async () =>
      input.pendingDisabled
        ? {
            enabled: false,
            status: "requires-approval" as const,
            supported: true
          }
        : launchState(input.enabled ?? false)
    ),
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
  if (input.initialRegistrationUnavailable)
    runtimeLifecycle.activateUnavailable(
      "Background Agent registration status is unavailable."
    );
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
    initialRegistrationUnavailable: input.initialRegistrationUnavailable,
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
  it("reconnects to a registered Agent after a transient bootstrap status failure", async () => {
    const fixture = createFixture({
      enabled: true,
      initialRegistrationUnavailable: true
    });
    await fixture.controller.initialize();
    await expect(fixture.runtimeLifecycle.status()).resolves.toMatchObject({
      ok: true
    });
  });

  it("keeps runtime unavailable if registration resolves disabled after bootstrap uncertainty", async () => {
    const fixture = createFixture({ initialRegistrationUnavailable: true });
    const state = await fixture.controller.initialize();
    expect(state.runtimeState).toBe("needs_attention");
    expect(fixture.runtimeLifecycle.isActive()).toBe(true);
  });
  it("blocks local runtime but permits Desktop bootstrap if registration status is unavailable", async () => {
    const fixture = createFixture();
    fixture.launchService.get.mockRejectedValue(
      new Error("status unavailable")
    );
    await expect(
      readLaunchStateOrBlockRuntime(
        fixture.launchService,
        fixture.runtimeLifecycle
      )
    ).resolves.toBeNull();
    expect(fixture.runtimeLifecycle.isActive()).toBe(true);
    expect(() => fixture.runtimeLifecycle.status()).toThrow(
      /registration status is unavailable/i
    );
  });
  it("reports unconfirmed ownership when an Agent unregisters outside Desktop", async () => {
    const fixture = createFixture({ enabled: true });
    await fixture.controller.initialize();
    fixture.launchService.get.mockResolvedValue({
      enabled: false,
      status: "disabled",
      supported: true
    });

    const status = await fixture.controller.get();

    expect(status).toMatchObject({
      enabled: false,
      status: "disabled",
      runtimeState: "needs_attention"
    });
    expect(status.message).toMatch(/shutdown.*not confirmed/i);
    expect(fixture.runtimeLifecycle.isActive()).toBe(true);
  });
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

  it.each(["initialize", "get"] as const)(
    "retains ownership immediately after %s sees pending approval",
    async (method) => {
      const { controller, runtimeLifecycle } = createFixture({
        pendingDisabled: true
      });

      await controller[method]();

      expect(runtimeLifecycle.isActive()).toBe(true);
    }
  );

  it("retains ownership when enabling an already pending registration", async () => {
    const { controller, launchService, runtimeLifecycle } = createFixture({
      pendingDisabled: true
    });

    await controller.set(true);

    expect(runtimeLifecycle.isActive()).toBe(true);
    expect(launchService.set).not.toHaveBeenCalled();
  });

  it.each(["initialize", "get", "set"] as const)(
    "fails closed when %s cannot read registration status",
    async (method) => {
      const { controller, launchService, runtimeLifecycle } = createFixture();
      launchService.get.mockRejectedValueOnce(new Error("Status unavailable."));

      await expect(
        method === "set" ? controller.set(true) : controller[method]()
      ).rejects.toThrow("Status unavailable.");
      expect(runtimeLifecycle.isActive()).toBe(true);
    }
  );

  it("serializes concurrent enables through a failed registration", async () => {
    const { controller, launchService, runtimeLifecycle } = createFixture();
    let rejectRegistration!: (error: Error) => void;
    const pending = new Promise<never>((_, reject) => {
      rejectRegistration = reject;
    });
    let started!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    launchService.set.mockImplementationOnce(async () => {
      started();
      return pending;
    });
    const first = controller.set(true);
    const firstFailure = expect(first).rejects.toThrow("Registration failed.");
    await registrationStarted;
    const second = controller.set(true);
    rejectRegistration(new Error("Registration failed."));
    await firstFailure;
    await second;
    expect(runtimeLifecycle.isActive()).toBe(true);
    expect(launchService.set).toHaveBeenCalledTimes(2);
  });

  it("reconnects after transient registration status failure", async () => {
    const { controller, launchService, runtimeLifecycle, client } =
      createFixture({ enabled: true });
    launchService.get.mockRejectedValueOnce(new Error("Status unavailable."));
    await expect(controller.get()).rejects.toThrow("Status unavailable.");
    await controller.get();
    await runtimeLifecycle.status();
    expect(client.status).toHaveBeenCalled();
  });

  it("stops an Agent before recovering from unavailable status to disabled", async () => {
    const { controller, launchService, runtimeLifecycle, stop } =
      createFixture();
    launchService.get.mockRejectedValueOnce(new Error("Status unavailable."));
    await expect(controller.get()).rejects.toThrow("Status unavailable.");
    await controller.set(false);
    expect(stop).toHaveBeenCalledWith(true);
    expect(runtimeLifecycle.isActive()).toBe(false);
  });

  it.each(["missing", "invalid", "unavailable"] as const)(
    "fails closed when %s state follows a transient status failure",
    async (kind) => {
      const { controller, launchService, runtimeLifecycle, store } =
        createFixture({ missingState: true });
      if (kind === "invalid")
        vi.spyOn(store, "read").mockReturnValue({
          kind: "invalid",
          reason: "Invalid state"
        });
      if (kind === "unavailable")
        vi.spyOn(store, "read").mockImplementation(() => {
          throw new Error("Configuration unavailable");
        });
      launchService.get.mockRejectedValueOnce(new Error("Status unavailable."));

      await expect(controller.get()).rejects.toThrow("Status unavailable.");
      await controller.get();
      for (const enabled of [true, false]) {
        await expect(controller.set(enabled)).rejects.toThrow(
          /Restore.*before changing registration/
        );
        expect(runtimeLifecycle.isActive()).toBe(true);
        expect(() => runtimeLifecycle.status()).toThrow(
          /Restore.*before changing registration/
        );
      }
      expect(launchService.set).not.toHaveBeenCalled();
    }
  );

  it("retains ownership if recovery Stop fails", async () => {
    const { controller, launchService, runtimeLifecycle } = createFixture({
      stopError: new Error("Agent is unreachable.")
    });
    launchService.get.mockRejectedValueOnce(new Error("Status unavailable."));
    await expect(controller.get()).rejects.toThrow("Status unavailable.");
    await expect(controller.set(false)).rejects.toThrow(
      "Agent is unreachable."
    );
    expect(runtimeLifecycle.isActive()).toBe(true);
  });

  it("retains ownership when registration returns pending approval", async () => {
    const { controller, launchService, runtimeLifecycle } = createFixture();
    launchService.set.mockResolvedValueOnce({
      enabled: false,
      status: "requires-approval",
      supported: true
    });

    await controller.set(true);

    expect(runtimeLifecycle.isActive()).toBe(true);
  });

  it.each(["pending", "unavailable"] as const)(
    "retains ownership when registration fails and status is %s",
    async (status) => {
      const { controller, launchService, runtimeLifecycle } = createFixture({
        launchSetError: new Error("Registration failed.")
      });
      if (status === "pending") {
        launchService.get
          .mockResolvedValueOnce({
            enabled: false,
            status: "disabled",
            supported: true
          })
          .mockResolvedValueOnce({
            enabled: false,
            status: "requires-approval",
            supported: true
          });
      } else {
        launchService.get
          .mockResolvedValueOnce({
            enabled: false,
            status: "disabled",
            supported: true
          })
          .mockRejectedValueOnce(new Error("Status unavailable."));
      }

      await expect(controller.set(true)).rejects.toThrow(
        "Registration failed."
      );
      expect(runtimeLifecycle.isActive()).toBe(true);
    }
  );

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

  it("stops the Agent before unregistering when approval is pending", async () => {
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

    expect(stop).toHaveBeenCalledWith(true);
    expect(launchService.set).toHaveBeenCalledWith(false);
    expect(runtimeLifecycle.isActive()).toBe(false);
  });

  it("does not release ownership if pending approval cannot be stopped", async () => {
    const { controller, launchService, runtimeLifecycle } = createFixture({
      pendingDisabled: true,
      stopError: new Error("Agent is unreachable.")
    });

    await expect(controller.set(false)).rejects.toThrow(
      "Agent is unreachable."
    );
    expect(launchService.set).not.toHaveBeenCalled();
    expect(runtimeLifecycle.isActive()).toBe(true);
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
