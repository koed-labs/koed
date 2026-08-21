import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createNotificationDrainController,
  type NotificationDrainClient
} from "./notification-drain-controller.js";

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const wakeClient = (): NotificationDrainClient & {
  queries: string[];
  release: ReturnType<typeof vi.fn>;
  emit(event: string, value?: unknown): boolean;
} => {
  const emitter = new EventEmitter();
  const queries: string[] = [];
  return Object.assign(emitter, {
    queries,
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
    }),
    release: vi.fn(),
    removeAllListeners(event?: "notification" | "error") {
      EventEmitter.prototype.removeAllListeners.call(emitter, event);
    }
  });
};

describe("notification drain controller", () => {
  it("rejects unsafe or empty notification channel lists", () => {
    const create = (channels: string[]) =>
      createNotificationDrainController({
        channels,
        wakePool: { connect: vi.fn() },
        processOnce: vi.fn(async () => undefined),
        onProcessError: vi.fn()
      });

    expect(() => create([])).toThrow(TypeError);
    expect(() => create(["valid; select pg_sleep(1)"])).toThrow(TypeError);
  });

  it("listens on multiple channels and coalesces notifications into serialized drains", async () => {
    const client = wakeClient();
    let resolveFirst!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const processOnce = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (processOnce.mock.calls.length === 1) await firstRun;
      active -= 1;
      return { full: false };
    });
    const controller = createNotificationDrainController({
      channels: ["first_channel", "second_channel"],
      wakePool: { connect: vi.fn(async () => client) },
      processOnce,
      onProcessError: vi.fn()
    });

    controller.start();
    await flush();
    client.emit("notification", { channel: "first_channel" });
    client.emit("notification", { channel: "second_channel" });
    client.emit("notification", { channel: "unrelated_channel" });
    resolveFirst();
    await flush();

    expect(processOnce).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(client.queries).toEqual([
      "listen first_channel",
      "listen second_channel"
    ]);

    await controller.stop();
    expect(client.queries).toEqual([
      "listen first_channel",
      "listen second_channel",
      "unlisten first_channel",
      "unlisten second_channel"
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("reconnects with backoff and drains after reconnecting", async () => {
    vi.useFakeTimers();
    const client = wakeClient();
    const connect = vi
      .fn<() => Promise<NotificationDrainClient>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(client);
    const processOnce = vi.fn(async () => undefined);
    const controller = createNotificationDrainController({
      channels: ["wake_channel"],
      wakePool: { connect },
      processOnce,
      onProcessError: vi.fn(),
      reconnectBaseMs: 25
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(24);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(processOnce).toHaveBeenCalledTimes(1);

    await controller.stop();
    vi.useRealTimers();
  });

  it("unlistens partial subscriptions before reconnecting", async () => {
    vi.useFakeTimers();
    const first = wakeClient();
    const originalQuery = first.query;
    first.query = vi.fn(async (sql: string) => {
      await originalQuery(sql);
      if (sql === "listen second_channel") throw new Error("offline");
    });
    const second = wakeClient();
    const connect = vi
      .fn<() => Promise<NotificationDrainClient>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    const controller = createNotificationDrainController({
      channels: ["first_channel", "second_channel"],
      wakePool: { connect },
      processOnce: vi.fn(async () => undefined),
      onProcessError: vi.fn(),
      reconnectBaseMs: 25
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.queries).toEqual([
      "listen first_channel",
      "listen second_channel",
      "unlisten first_channel"
    ]);
    expect(first.release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(connect).toHaveBeenCalledTimes(2);

    await controller.stop();
    vi.useRealTimers();
  });

  it("wakes at the scheduled retry time and replaces later retry timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    const client = wakeClient();
    const processOnce = vi.fn(async () => undefined);
    const controller = createNotificationDrainController({
      channels: ["wake_channel"],
      wakePool: { connect: vi.fn(async () => client) },
      processOnce,
      onProcessError: vi.fn()
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(processOnce).toHaveBeenCalledTimes(1);
    controller.scheduleRetry("2026-08-21T00:00:10.000Z");
    controller.scheduleRetry("2026-08-21T00:00:05.000Z");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(processOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processOnce).toHaveBeenCalledTimes(2);

    await controller.stop();
    vi.useRealTimers();
  });

  it("waits for an in-flight connection and releases it once when stopped", async () => {
    const client = wakeClient();
    let resolveConnect!: (client: NotificationDrainClient) => void;
    const connecting = new Promise<NotificationDrainClient>((resolve) => {
      resolveConnect = resolve;
    });
    const controller = createNotificationDrainController({
      channels: ["wake_channel"],
      wakePool: { connect: vi.fn(() => connecting) },
      processOnce: vi.fn(async () => undefined),
      onProcessError: vi.fn()
    });

    controller.start();
    const stopped = controller.stop();
    const stoppedAgain = controller.stop();
    expect(stoppedAgain).toBe(stopped);
    resolveConnect(client);
    await Promise.all([stopped, stoppedAgain]);

    expect(client.queries).toEqual([]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
