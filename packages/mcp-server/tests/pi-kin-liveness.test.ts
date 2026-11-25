import type { FloatingKinActivity } from "@koed-labs/shared";
import { afterEach, expect, it, vi } from "vitest";
import { PiKinLiveness } from "../src/pi-kin-liveness.js";

const observedAt = Date.parse("2026-01-01T00:00:00Z");
const sessionId = "a01acd69-24e2-4b2c-8cf7-b4f2a4ec780c";
const activity: FloatingKinActivity = {
  conversations: [
    {
      sessionId,
      projectId: null,
      client: "pi",
      lastActivityAt: new Date(observedAt).toISOString()
    }
  ],
  overflowCount: 0
};
const working = {
  publisherId: "03eb10bc-ecce-4a4d-a241-42268600db56",
  sequence: 1,
  externalSessionId: "pi-native",
  observedAt,
  working: true
};
const signal = new AbortController().signal;

function pendingSession() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

it("keeps a verified lease during refresh, then expires if the publisher vanishes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(observedAt);
  const second = pendingSession();
  const resolveSession = vi
    .fn()
    .mockResolvedValueOnce(sessionId)
    .mockReturnValueOnce(second.promise);
  const kin = new PiKinLiveness({
    connectionRevision: () => 1,
    resolveSession,
    allowsPersonalStatus: async () => true
  });
  await kin.update(working, signal);
  vi.setSystemTime(observedAt + 5_000);
  const renewal = kin.update(
    { ...working, sequence: 2, observedAt: Date.now() },
    signal
  );
  expect(
    (await kin.decorate(activity, signal)).conversations[0]?.workingUntil
  ).toBe(new Date(observedAt + 15_000).toISOString());
  second.resolve(sessionId);
  await renewal;
  expect(
    (await kin.decorate(activity, signal)).conversations[0]?.workingUntil
  ).toBe(new Date(observedAt + 20_000).toISOString());
  vi.setSystemTime(observedAt + 20_000);
  expect(await kin.decorate(activity, signal)).toEqual(activity);
});

it("does not resurrect late asynchronous lookups across settlement or reconnection", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(observedAt);
  let revision = 1;
  const lookup = pendingSession();
  const kin = new PiKinLiveness({
    connectionRevision: () => revision,
    resolveSession: () => lookup.promise,
    allowsPersonalStatus: async () => true
  });
  const first = kin.update(working, signal);
  await kin.update({ ...working, working: false, sequence: 2 }, signal);
  lookup.resolve(sessionId);
  await first;
  expect(await kin.decorate(activity, signal)).toEqual(activity);
  await kin.update({ ...working, sequence: 3 }, signal);
  expect(
    (await kin.decorate(activity, signal)).conversations[0]?.workingUntil
  ).toBeDefined();
  revision += 2;
  expect(await kin.decorate(activity, signal)).toEqual(activity);
});
