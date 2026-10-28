import { describe, expect, it, vi } from "vitest";
import type { RuntimeLifecycleObservation } from "@koed-labs/server";
import {
  cachedProcessIdentity,
  createLifecycleObserver
} from "./lifecycle-observer.js";

const running = (pid: number): RuntimeLifecycleObservation => ({
  state: "running",
  epoch: `${pid}:live`,
  message: "Koed is running.",
  pid
});
const stopped: RuntimeLifecycleObservation = {
  state: "stopped",
  epoch: "stopped",
  message: "Koed is not running."
};

describe("Desktop lifecycle observer", () => {
  it("notifies once per lifecycle transition from cheap periodic observations", () => {
    const observations = [running(7), running(7), stopped, stopped, running(8)];
    const observe = vi.fn(() => observations.shift() ?? running(8));
    let tick: (() => void) | undefined;
    const observer = createLifecycleObserver({
      observe,
      intervalMs: 1_000,
      setInterval: ((callback: () => void) => {
        tick = callback;
        return { unref: () => undefined };
      }) as never,
      clearInterval: () => undefined
    });
    const changes: string[] = [];
    observer.subscribe((next, previous) =>
      changes.push(`${previous?.epoch ?? "none"}->${next.epoch}`)
    );
    observer.start();
    for (let index = 0; index < 4; index += 1) tick?.();
    expect(changes).toEqual([
      "none->7:live",
      "7:live->stopped",
      "stopped->8:live"
    ]);
    expect(observer.current()).toEqual(running(8));
    observer.stop();
  });

  it("keeps notifying listeners when one throws and contains observation failures", () => {
    const observer = createLifecycleObserver({
      observe: () => {
        throw new Error("unreadable");
      }
    });
    observer.subscribe(() => {
      throw new Error("listener");
    });
    expect(observer.refresh()).toMatchObject({ state: "unavailable" });
  });

  it("reuses a verified identity only while the same PID stays alive", () => {
    const resolve = vi.fn((pid: number) => `identity-${pid}`);
    let alive = true;
    let now = 0;
    const identity = cachedProcessIdentity({
      resolve,
      isAlive: () => alive,
      now: () => now,
      maxAgeMs: 10_000
    });
    expect(identity(5)).toBe("identity-5");
    expect(identity(5)).toBe("identity-5");
    expect(resolve).toHaveBeenCalledTimes(1);
    now = 10_001;
    identity(5);
    expect(resolve).toHaveBeenCalledTimes(2);
    alive = false;
    identity(5);
    expect(resolve).toHaveBeenCalledTimes(3);
  });
});
