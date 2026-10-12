import { describe, expect, it } from "vitest";
import { withPaseoRelayClientLock } from "./paseo-relay-client-lock.js";

describe("withPaseoRelayClientLock", () => {
  it("serializes requests for one relay route", async () => {
    const active = new Set<string>();
    const events: string[] = [];
    const request = (name: string) =>
      withPaseoRelayClientLock("route-a", async () => {
        expect(active.has("route-a")).toBe(false);
        active.add("route-a");
        events.push(`${name}:start`);
        await Promise.resolve();
        events.push(`${name}:end`);
        active.delete("route-a");
      });

    await Promise.all([request("first"), request("second")]);

    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end"
    ]);
  });

  it("allows different relay routes concurrently", async () => {
    let concurrent = 0;
    let maximumConcurrent = 0;
    const request = (routeId: string) =>
      withPaseoRelayClientLock(routeId, async () => {
        concurrent += 1;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        await Promise.resolve();
        concurrent -= 1;
      });

    await Promise.all([request("route-a"), request("route-b")]);

    expect(maximumConcurrent).toBe(2);
  });

  it("releases route lock after failure", async () => {
    await expect(
      withPaseoRelayClientLock("route-a", async () => {
        throw new Error("failed");
      })
    ).rejects.toThrow("failed");

    await expect(
      withPaseoRelayClientLock("route-a", async () => "retried")
    ).resolves.toBe("retried");
  });
});
