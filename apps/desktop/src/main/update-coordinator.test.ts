import { describe, expect, it, vi } from "vitest";
import {
  type DesktopUpdateAdapter,
  type DesktopUpdateEventPayload,
  type DesktopUpdateState,
  DesktopUpdateCoordinator
} from "./update-coordinator.js";

type TimerTask = {
  readonly id: number;
  readonly delay: number;
  readonly handler: () => void;
};

class FakeTimers {
  private nextId = 1;
  readonly tasks: TimerTask[] = [];

  readonly api = {
    setTimeout: (handler: () => void, delay: number): number => {
      const task = { id: this.nextId++, delay, handler };
      this.tasks.push(task);
      return task.id;
    },
    clearTimeout: (handle: unknown): void => {
      const index = this.tasks.findIndex((task) => task.id === handle);
      if (index >= 0) this.tasks.splice(index, 1);
    }
  };

  runNext(): void {
    const task = this.tasks.shift();
    if (!task) throw new Error("No timer scheduled");
    task.handler();
  }
}

class FakeUpdater implements DesktopUpdateAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  channel = "stable";
  allowPrerelease = false;
  checkForUpdates = vi.fn<() => Promise<unknown>>(async () => ({
    isUpdateAvailable: false
  }));
  downloadUpdate = vi.fn<() => Promise<unknown>>(async () => undefined);
  quitAndInstall = vi.fn();
  private listeners = new Map<
    keyof DesktopUpdateEventPayload,
    Set<(...args: never[]) => void>
  >();

  on<Event extends keyof DesktopUpdateEventPayload>(
    event: Event,
    listener: (...args: DesktopUpdateEventPayload[Event]) => void
  ): void {
    const current = this.listeners.get(event) ?? new Set();
    current.add(listener as (...args: never[]) => void);
    this.listeners.set(event, current);
  }

  removeListener<Event extends keyof DesktopUpdateEventPayload>(
    event: Event,
    listener: (...args: DesktopUpdateEventPayload[Event]) => void
  ): void {
    this.listeners.get(event)?.delete(listener as (...args: never[]) => void);
  }

  emit<Event extends keyof DesktopUpdateEventPayload>(
    event: Event,
    ...args: DesktopUpdateEventPayload[Event]
  ): void {
    for (const listener of this.listeners.get(event) ?? [])
      listener(...(args as never[]));
  }

  listenerCount(event: keyof DesktopUpdateEventPayload): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

const availableInfo = {
  version: "0.5.0",
  channel: "stable",
  releaseName: "A useful release",
  releaseNotes: "Fixes startup and improves reliability.",
  releaseDate: "2026-08-09T10:00:00.000Z",
  files: [{ url: "https://updates.koed.ai/Koed.zip" }]
};

const unsafeInfo = {
  ...availableInfo,
  releaseName: "Visit https://updates.koed.ai/private",
  releaseNotes: "Authorization: Bearer secret-token"
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

const stateStatuses = (states: DesktopUpdateState[]): string[] =>
  states.map((state) => state.status);

describe("DesktopUpdateCoordinator", () => {
  it("disables unpackaged and unsupported builds without scheduling or checking", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const unpackaged = new DesktopUpdateCoordinator({
      appIsPackaged: false,
      supported: true,
      updater,
      timers: timers.api
    });
    unpackaged.start();
    expect(unpackaged.getState()).toEqual({
      status: "disabled",
      reason: "unpackaged"
    });
    expect(timers.tasks).toHaveLength(0);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();

    const unsupported = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: false,
      updater,
      timers: timers.api
    });
    await unsupported.requestCheck();
    expect(unsupported.getState()).toEqual({
      status: "disabled",
      reason: "unsupported"
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("configures user-controlled updater behavior and performs startup plus jittered checks", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api,
      startupDelayMs: 25,
      intervalMs: 1_000,
      jitterRatio: 0.2,
      random: () => 1
    });
    coordinator.start();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(timers.tasks[0]?.delay).toBe(25);
    timers.runNext();
    await vi.waitFor(() =>
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    );
    await vi.waitFor(() => expect(timers.tasks[0]?.delay).toBe(1_200));
    timers.runNext();
    await vi.waitFor(() =>
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    );
  });

  it("treats a real up-to-date check result with updateInfo as not available", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: false,
      updateInfo: availableInfo
    });
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater
    });
    await coordinator.requestCheck("manual");
    expect(coordinator.getState()).toEqual({ status: "idle" });
  });

  it("keeps malformed background metadata non-blocking", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const check = deferred<unknown>();
    updater.checkForUpdates.mockReturnValueOnce(check.promise);
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api,
      startupDelayMs: 0
    });
    coordinator.start();
    timers.runNext();
    await vi.waitFor(() =>
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    );
    updater.emit("update-available", { releaseName: "missing version" });
    expect(coordinator.getState()).toEqual({ status: "idle" });
    check.resolve({ isUpdateAvailable: false });
    await vi.waitFor(() => expect(timers.tasks).toHaveLength(1));
    expect(coordinator.getState()).toEqual({ status: "idle" });
  });

  it("keeps background failures usable but exposes manual failures safely", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockRejectedValueOnce(
      new Error(
        "https://token:secret@private.example/update failed at /tmp/secret"
      )
    );
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api,
      startupDelayMs: 0
    });
    coordinator.start();
    timers.runNext();
    await vi.waitFor(() =>
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    );
    expect(coordinator.getState()).toEqual({ status: "idle" });

    updater.checkForUpdates.mockRejectedValueOnce(
      new Error("private path /tmp/secret")
    );
    await coordinator.requestCheck("manual");
    expect(coordinator.getState()).toEqual({
      status: "error",
      message: "Koed could not check for updates."
    });
    expect(JSON.stringify(coordinator.getState())).not.toContain("secret");
  });

  it("normalizes available metadata without exposing URLs or paths", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api
    });
    coordinator.start();
    updater.emit("update-available", availableInfo);
    expect(coordinator.getState()).toEqual({
      status: "available",
      release: {
        version: "0.5.0",
        channel: "stable",
        releaseName: "A useful release",
        releaseNotes: "Fixes startup and improves reliability.",
        publishedAt: "2026-08-09T10:00:00.000Z"
      }
    });

    const unsafeUpdater = new FakeUpdater();
    const secondUnsafeCoordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater: unsafeUpdater,
      timers: timers.api
    });
    secondUnsafeCoordinator.start();
    unsafeUpdater.emit("update-available", unsafeInfo);
    expect(secondUnsafeCoordinator.getState()).toMatchObject({
      status: "available",
      release: { version: "0.5.0", channel: "stable" }
    });
    expect(secondUnsafeCoordinator.getState()).not.toHaveProperty(
      "release.releaseName"
    );
    expect(secondUnsafeCoordinator.getState()).not.toHaveProperty(
      "release.releaseNotes"
    );

    for (const unsafeValue of [
      "/tmp",
      "/var",
      "token=abc",
      "token: abc",
      "key=abc",
      "api_key=abc",
      "custom://private",
      "//private.example/update",
      "C:\\Users\\secret",
      "\\\\server\\share\\secret"
    ]) {
      const strictUpdater = new FakeUpdater();
      const strictCoordinator = new DesktopUpdateCoordinator({
        appIsPackaged: true,
        supported: true,
        updater: strictUpdater,
        timers: timers.api
      });
      strictCoordinator.start();
      strictUpdater.emit("update-available", {
        ...availableInfo,
        releaseName: unsafeValue
      });
      expect(strictCoordinator.getState()).not.toHaveProperty(
        "release.releaseName"
      );
    }

    const benignUpdater = new FakeUpdater();
    const benignCoordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater: benignUpdater,
      timers: timers.api
    });
    benignCoordinator.start();
    benignUpdater.emit("update-available", {
      ...availableInfo,
      releaseName: "Tokenized key release"
    });
    expect(benignCoordinator.getState()).toHaveProperty(
      "release.releaseName",
      "Tokenized key release"
    );

    const boundedUpdater = new FakeUpdater();
    const boundedCoordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater: boundedUpdater,
      timers: timers.api
    });
    boundedCoordinator.start();
    boundedUpdater.emit("update-available", {
      ...availableInfo,
      releaseNotes: Array.from({ length: 10_000 }, (_, index) =>
        index === 2 ? "custom://private" : `Safe note ${index}`
      )
    });
    const boundedNotes = boundedCoordinator.getState();
    expect(boundedNotes).toHaveProperty("release.releaseNotes");
    expect(
      (boundedNotes as Extract<DesktopUpdateState, { status: "available" }>)
        .release.releaseNotes?.length
    ).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(boundedNotes)).not.toContain("custom://");
  });

  it("drives download progress and ready transitions, then awaits install preparation", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    let prepare: (() => void) | undefined;
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api,
      prepareForInstall: () =>
        new Promise<void>((resolve) => {
          prepare = resolve;
        })
    });
    coordinator.start();
    updater.emit("update-available", availableInfo);
    const downloading = coordinator.downloadUpdate();
    expect(coordinator.getState()).toMatchObject({
      status: "downloading",
      progress: 0
    });
    updater.emit("download-progress", {
      percent: 43.4,
      transferred: 1,
      total: 2
    });
    expect(coordinator.getState()).toMatchObject({
      status: "downloading",
      progress: 43.4
    });
    updater.emit("update-downloaded", availableInfo);
    await downloading;
    expect(coordinator.getState()).toMatchObject({
      status: "ready",
      release: { version: "0.5.0" }
    });

    const installing = coordinator.installUpdate();
    expect(coordinator.getState()).toMatchObject({ status: "installing" });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    prepare?.();
    await installing;
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("reports install preparation failures and never invokes updater installation", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api,
      prepareForInstall: async () => {
        throw new Error("server path and token");
      }
    });
    coordinator.start();
    updater.emit("update-downloaded", availableInfo);
    updater.emit("update-available", availableInfo);
    const download = coordinator.downloadUpdate();
    updater.emit("update-downloaded", availableInfo);
    await download;
    await coordinator.installUpdate();
    expect(coordinator.getState()).toEqual({
      status: "error",
      message: "Koed could not prepare this update for installation.",
      release: expect.objectContaining({ version: "0.5.0" }),
      recoverable: true
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    const retry = coordinator.installUpdate();
    expect(coordinator.getState()).toMatchObject({ status: "installing" });
    await retry;
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("ignores reordered and stale events while stronger operations are active", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const check = deferred<unknown>();
    updater.checkForUpdates.mockReturnValueOnce(check.promise);
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api
    });
    coordinator.start();
    const checking = coordinator.requestCheck("manual");
    updater.emit("update-available", availableInfo);
    check.resolve({ isUpdateAvailable: false, updateInfo: availableInfo });
    await checking;
    expect(coordinator.getState()).toMatchObject({ status: "available" });

    const download = deferred<unknown>();
    updater.downloadUpdate.mockReturnValueOnce(download.promise);
    const downloading = coordinator.downloadUpdate();
    updater.emit("checking-for-update");
    updater.emit("update-not-available", availableInfo);
    expect(coordinator.getState()).toMatchObject({ status: "downloading" });
    updater.emit("download-progress", { percent: 50 });
    updater.emit("update-downloaded", availableInfo);
    expect(coordinator.getState()).toMatchObject({ status: "ready" });
    updater.emit("download-progress", { percent: 10 });
    updater.emit("update-available", { ...availableInfo, version: "0.6.0" });
    updater.emit("error", new Error("stale"));
    expect(coordinator.getState()).toMatchObject({
      status: "ready",
      release: { version: "0.5.0" }
    });
    download.resolve(undefined);
    await downloading;

    const install = coordinator.installUpdate();
    const secondInstall = coordinator.installUpdate();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({ status: "installing" });
    updater.emit("error", new Error("stale install error"));
    expect(coordinator.getState()).toMatchObject({
      status: "error",
      recoverable: true
    });
    await Promise.all([install, secondInstall]);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("schedules one continuing periodic loop only after started checks", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api,
      startupDelayMs: 0,
      intervalMs: 1_000,
      jitterRatio: 0,
      random: () => 0.5
    });
    await coordinator.requestCheck("manual");
    expect(timers.tasks).toHaveLength(0);

    coordinator.start();
    timers.runNext();
    await vi.waitFor(() =>
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    );
    expect(timers.tasks).toHaveLength(1);
    timers.runNext();
    await vi.waitFor(() =>
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(3)
    );
    expect(timers.tasks).toHaveLength(1);
    await coordinator.requestCheck("manual");
    expect(timers.tasks).toHaveLength(1);
    timers.runNext();
    await vi.waitFor(() =>
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(5)
    );
    expect(timers.tasks).toHaveLength(1);
    coordinator.dispose();
    expect(timers.tasks).toHaveLength(0);
  });

  it("keeps one periodic check after a check is superseded by download", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const check = deferred<unknown>();
    updater.checkForUpdates.mockReturnValueOnce(check.promise);
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api,
      startupDelayMs: 0,
      intervalMs: 1_000,
      jitterRatio: 0
    });
    coordinator.start();
    timers.runNext();
    await vi.waitFor(() =>
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    );
    updater.emit("update-available", availableInfo);
    const download = deferred<unknown>();
    updater.downloadUpdate.mockReturnValueOnce(download.promise);
    const downloading = coordinator.downloadUpdate();
    check.resolve({ isUpdateAvailable: true, updateInfo: availableInfo });
    await vi.waitFor(() => expect(timers.tasks).toHaveLength(1));
    expect(coordinator.getState()).toMatchObject({ status: "downloading" });
    download.resolve(undefined);
    await downloading;
    expect(coordinator.getState()).toMatchObject({ status: "ready" });
    expect(timers.tasks).toHaveLength(1);
    coordinator.dispose();
  });

  it("does not add a periodic timer while the startup timer is pending", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api,
      startupDelayMs: 500,
      intervalMs: 1_000,
      jitterRatio: 0
    });
    coordinator.start();
    expect(timers.tasks).toHaveLength(1);
    updater.emit("update-available", availableInfo);
    await coordinator.requestCheck("background");
    expect(timers.tasks).toHaveLength(1);
    expect(timers.tasks[0]?.delay).toBe(500);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    coordinator.dispose();
    expect(timers.tasks).toHaveLength(0);
  });

  it("invalidates in-flight download and install operations on dispose", async () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api
    });
    coordinator.start();
    updater.emit("update-available", availableInfo);
    const download = deferred<unknown>();
    updater.downloadUpdate.mockReturnValueOnce(download.promise);
    const downloading = coordinator.downloadUpdate();
    coordinator.dispose();
    download.resolve(undefined);
    await downloading;
    expect(coordinator.getState()).toMatchObject({ status: "downloading" });

    const updater2 = new FakeUpdater();
    const prepare = deferred<void>();
    const coordinator2 = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater: updater2,
      timers: timers.api,
      prepareForInstall: () => prepare.promise
    });
    coordinator2.start();
    updater2.emit("update-available", availableInfo);
    const download2 = coordinator2.downloadUpdate();
    updater2.emit("update-downloaded", availableInfo);
    await download2;
    const installing = coordinator2.installUpdate();
    coordinator2.dispose();
    prepare.resolve();
    await installing;
    expect(updater2.quitAndInstall).not.toHaveBeenCalled();
  });

  it("cleans up updater listeners and timers", () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api
    });
    coordinator.start();
    expect(updater.listenerCount("update-available")).toBe(1);
    expect(timers.tasks).toHaveLength(1);
    coordinator.dispose();
    expect(updater.listenerCount("update-available")).toBe(0);
    expect(timers.tasks).toHaveLength(0);
    updater.emit("update-available", availableInfo);
    expect(coordinator.getState()).toEqual({ status: "idle" });
  });

  it("does not emit state after subscription cleanup", () => {
    const timers = new FakeTimers();
    const updater = new FakeUpdater();
    const coordinator = new DesktopUpdateCoordinator({
      appIsPackaged: true,
      supported: true,
      updater,
      timers: timers.api
    });
    const states: DesktopUpdateState[] = [];
    const unsubscribe = coordinator.subscribe((state) => states.push(state));
    unsubscribe();
    coordinator.start();
    updater.emit("update-available", availableInfo);
    expect(stateStatuses(states)).toEqual(["idle"]);
  });
});
