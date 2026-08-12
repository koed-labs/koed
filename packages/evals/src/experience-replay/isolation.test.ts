import { Redis } from "ioredis";
import { stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertEvalDatabaseUrl,
  assertLoopbackUrl,
  startTrialRedis
} from "./isolation.js";

describe("experience replay isolation", () => {
  it("rejects non-loopback services and non-eval databases", () => {
    expect(() => assertLoopbackUrl("redis://10.0.0.2:6379", "Redis")).toThrow(
      "loopback"
    );
    expect(() =>
      assertEvalDatabaseUrl("postgres://127.0.0.1:5432/production")
    ).toThrow("koed_eval_");
    expect(
      assertEvalDatabaseUrl("postgres://127.0.0.1:5432/koed_eval_trial_a")
        .pathname
    ).toBe("/koed_eval_trial_a");
  });

  it("starts authenticated, socket-only Redis processes with separated trial data", async () => {
    const first = await startTrialRedis();
    const second = await startTrialRedis();
    try {
      expect(first.url).not.toBe(second.url);
      expect(first.pid).not.toBe(second.pid);
      expect(first.socketPath).not.toBe(second.socketPath);
      expect(first.password).not.toBe(second.password);
      expect((await stat(path.dirname(first.socketPath))).mode & 0o777).toBe(
        0o700
      );
      const firstClient = new Redis(first.url, { retryStrategy: () => null });
      const secondClient = new Redis(second.url, { retryStrategy: () => null });
      await firstClient.set("trial", "first");
      expect(await secondClient.get("trial")).toBeNull();
      expect(await firstClient.config("GET", "port")).toEqual(["port", "0"]);

      const unauthenticated = new Redis({
        path: first.socketPath,
        lazyConnect: true,
        enableReadyCheck: false,
        retryStrategy: () => null
      });
      unauthenticated.on("error", () => {
        // The rejected PING below is the authentication assertion.
      });
      await unauthenticated.connect();
      await expect(unauthenticated.ping()).rejects.toThrow("NOAUTH");
      unauthenticated.disconnect();

      await firstClient.quit();
      await secondClient.quit();
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("bounds cleanup and makes it safe to call repeatedly", async () => {
    const redis = await startTrialRedis({ shutdownTimeoutMs: 100 });
    const directory = path.dirname(redis.socketPath);
    process.kill(redis.pid, "SIGSTOP");
    const startedAt = Date.now();

    await Promise.all([redis.close(), redis.close(), redis.close()]);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => process.kill(redis.pid, 0)).toThrow();
  });
});
