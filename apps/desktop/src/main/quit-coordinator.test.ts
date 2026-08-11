import { describe, expect, it, vi } from "vitest";
import {
  createDesktopQuitCoordinator,
  DesktopQuitCoordinator
} from "./quit-coordinator.js";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("DesktopQuitCoordinator", () => {
  it("stops server then bridge exactly once for concurrent updater preparation", async () => {
    const order: string[] = [];
    let resolveStop!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push("server:start");
          resolveStop = () => {
            order.push("server:stop");
            resolve();
          };
        })
    );
    const close = vi.fn(async () => {
      order.push("bridge:close");
    });
    const coordinator = createDesktopQuitCoordinator({
      getKoedServer: () => ({ stop }),
      getPdsSecretBridge: () => ({ close })
    });

    const first = coordinator.prepareForInstall();
    const second = coordinator.prepareForInstall();
    await Promise.resolve();
    resolveStop();
    await Promise.all([first, second]);

    expect(order).toEqual(["server:start", "server:stop", "bridge:close"]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(coordinator.isUpdaterQuitAllowed).toBe(true);
  });

  it("attempts bridge close after a server failure and fails closed for updater install", async () => {
    const stop = vi.fn(async () => {
      throw new Error("server stop failed");
    });
    const close = vi.fn(async () => undefined);
    const coordinator = new DesktopQuitCoordinator({
      getKoedServer: () => ({ stop }),
      getPdsSecretBridge: () => ({ close })
    });

    await expect(coordinator.prepareForInstall()).rejects.toThrow(
      "server stop failed"
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(coordinator.isUpdaterQuitAllowed).toBe(false);
  });

  it("allows a normal quit to complete once even when shutdown fails", async () => {
    const stop = vi.fn(async () => {
      throw new Error("server stop failed");
    });
    const close = vi.fn(async () => {
      throw new Error("bridge close failed");
    });
    const preventDefault = vi.fn();
    const requestQuit = vi.fn();
    const onNormalQuitError = vi.fn();
    const coordinator = createDesktopQuitCoordinator({
      getKoedServer: () => ({ stop }),
      getPdsSecretBridge: () => ({ close }),
      onNormalQuitError
    });

    coordinator.handleBeforeQuit(preventDefault, requestQuit);
    coordinator.handleBeforeQuit(preventDefault, requestQuit);
    await flush();
    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledTimes(1));

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(requestQuit).toHaveBeenCalledTimes(1);
    expect(onNormalQuitError).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    coordinator.handleBeforeQuit(preventDefault, requestQuit);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(requestQuit).toHaveBeenCalledTimes(1);
  });

  it("supports absent services without touching data or configuration paths", async () => {
    const koedHome = "/private/koed-home";
    const configPath = `${koedHome}/config.json`;
    const coordinator = createDesktopQuitCoordinator({
      getKoedServer: () => null,
      getPdsSecretBridge: () => null
    });

    await expect(coordinator.prepareForInstall()).resolves.toBeUndefined();
    expect({ koedHome, configPath }).toEqual({
      koedHome: "/private/koed-home",
      configPath: "/private/koed-home/config.json"
    });
    expect(coordinator.isUpdaterQuitAllowed).toBe(true);
  });

  it("waits for a pending startup task before stopping a service assigned by bootstrap", async () => {
    let server: { stop: () => Promise<void> } | null = null;
    let bridge: { close: () => Promise<void> } | null = null;
    const startup = deferred<void>();
    const stop = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const coordinator = createDesktopQuitCoordinator({
      getKoedServer: () => server,
      getPdsSecretBridge: () => bridge
    });
    const startupTask = coordinator.trackStartupTask(startup.promise);
    const preparing = coordinator.prepareForInstall();
    expect(stop).not.toHaveBeenCalled();

    startup.resolve();
    await startupTask;
    server = { stop };
    bridge = { close };
    await preparing;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(coordinator.isUpdaterQuitAllowed).toBe(true);
  });

  it("cancels startup before service assignment when quit wins the race", async () => {
    let server: { stop: () => Promise<void> } | null = null;
    const stop = vi.fn(async () => undefined);
    const coordinator = createDesktopQuitCoordinator({
      getKoedServer: () => server,
      getPdsSecretBridge: () => null
    });

    await coordinator.prepareForInstall();
    if (coordinator.canStartStartup) server = { stop };

    expect(coordinator.canStartStartup).toBe(false);
    expect(server).toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });

  it("waits for deferred runtime resume before allowing updater installation", async () => {
    const resume = deferred<void>();
    const stop = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const coordinator = createDesktopQuitCoordinator({
      getKoedServer: () => ({ stop }),
      getPdsSecretBridge: () => ({ close })
    });
    const releaseResume = coordinator.beginRuntimeResume(resume.promise);
    const preparing = coordinator.prepareForInstall();
    expect(stop).toHaveBeenCalledTimes(1);

    resume.resolve();
    releaseResume();
    await preparing;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("initiates server stop before an unresolved resume and bounds quit preparation", async () => {
    const resume = deferred<void>();
    const stop = vi.fn(async () => undefined);
    const coordinator = createDesktopQuitCoordinator({
      getKoedServer: () => ({ stop }),
      getPdsSecretBridge: () => null,
      shutdownTimeoutMs: 5
    });
    coordinator.beginRuntimeResume(resume.promise);
    await expect(coordinator.prepareForInstall()).rejects.toThrow(
      "did not settle"
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(coordinator.isUpdaterQuitAllowed).toBe(false);

    const normalResume = deferred<void>();
    const requestQuit = vi.fn();
    const normal = createDesktopQuitCoordinator({
      getKoedServer: () => ({ stop: vi.fn(async () => undefined) }),
      getPdsSecretBridge: () => null,
      shutdownTimeoutMs: 5
    });
    normal.beginRuntimeResume(normalResume.promise);
    normal.handleBeforeQuit(vi.fn(), requestQuit);
    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledTimes(1));
  });

  it("retries only rejected cleanup steps and never repeats successful steps", async () => {
    const stop = vi.fn(async () => undefined);
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("bridge close failed"))
      .mockResolvedValueOnce(undefined);
    const coordinator = createDesktopQuitCoordinator({
      getKoedServer: () => ({ stop }),
      getPdsSecretBridge: () => ({ close })
    });

    await expect(coordinator.prepareForInstall()).rejects.toThrow(
      "bridge close failed"
    );
    await expect(coordinator.prepareForInstall()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
    expect(coordinator.isUpdaterQuitAllowed).toBe(true);
  });

  it("makes disposal deterministic and prevents later quit handling", async () => {
    const coordinator = createDesktopQuitCoordinator({
      getKoedServer: () => ({ stop: vi.fn(async () => undefined) }),
      getPdsSecretBridge: () => ({ close: vi.fn(async () => undefined) })
    });
    coordinator.dispose();
    await expect(coordinator.shutdownServices()).rejects.toThrow("disposed");

    const preventDefault = vi.fn();
    const requestQuit = vi.fn();
    coordinator.handleBeforeQuit(preventDefault, requestQuit);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(requestQuit).not.toHaveBeenCalled();
  });
});
