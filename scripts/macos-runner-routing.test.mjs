import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseMacosRunner } from "./macos-runner-routing.mjs";

const runner = (busy = false) => ({
  name: "koed-shf-macos-arm64",
  os: "macOS",
  status: "online",
  busy,
  labels: ["self-hosted", "macOS", "ARM64", "koed-shf-macos-arm64"].map(
    (name) => ({ name })
  )
});

const response = (runners) => ({ ok: true, json: async () => ({ runners }) });

test("routes to the Mac after a busy runner becomes idle", async () => {
  let attempts = 0;
  let waits = 0;
  const result = await chooseMacosRunner({
    token: "test",
    fetchRunners: async () => response([runner(attempts++ === 0)]),
    wait: async () => {
      waits++;
    },
    attempts: 3,
    intervalMs: 1
  });
  assert.deepEqual(result, [
    "self-hosted",
    "macOS",
    "ARM64",
    "koed-shf-macos-arm64"
  ]);
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
});

test("routes to the second Mac when the first is busy", async () => {
  const second = {
    ...runner(),
    name: "koed-zom-macos-arm64",
    labels: ["self-hosted", "macOS", "ARM64", "koed-zom-macos-arm64"].map(
      (name) => ({ name })
    )
  };
  const result = await chooseMacosRunner({
    token: "test",
    fetchRunners: async () => response([runner(true), second]),
    wait: async () => {},
    attempts: 1
  });
  assert.deepEqual(result, [
    "self-hosted",
    "macOS",
    "ARM64",
    "koed-zom-macos-arm64"
  ]);
});

test("falls back after the bounded wait when the Mac remains unavailable", async () => {
  let attempts = 0;
  const result = await chooseMacosRunner({
    token: "test",
    fetchRunners: async () => {
      attempts++;
      return response([runner(true)]);
    },
    wait: async () => {},
    attempts: 3,
    intervalMs: 1
  });
  assert.equal(result, "xcode-27");
  assert.equal(attempts, 3);
});

test("falls back safely on missing credentials, API errors or wrong labels", async () => {
  for (const options of [
    {
      token: "",
      fetchRunners: async () => {
        throw new Error("must not call");
      }
    },
    { token: "test", fetchRunners: async () => ({ ok: false, status: 403 }) },
    {
      token: "test",
      fetchRunners: async () => {
        throw new Error("network");
      }
    },
    {
      token: "test",
      fetchRunners: async () => response([{ ...runner(), labels: [] }])
    }
  ]) {
    assert.equal(
      await chooseMacosRunner({
        ...options,
        wait: async () => {},
        attempts: 1,
        intervalMs: 1
      }),
      "xcode-27"
    );
  }
});
