import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForPackagedHqSurface } from "../apps/desktop/scripts/smoke-packaged-hq.mjs";

const checking = {
  hqEnabled: true,
  hqSetup: true,
  shell: false,
  setup: false,
  setupState: "checking"
};
const complete = { ...checking, setupState: "complete" };
const shell = { ...complete, hqSetup: false, shell: true };

const fakeClock = () => {
  let elapsed = 0;
  return {
    now: () => elapsed,
    delay: async (ms) => {
      elapsed += ms;
    }
  };
};

test("fresh HQ opens conversational onboarding before local preparation", async () => {
  const clock = fakeClock();
  const firstRun = {
    hqEnabled: true,
    hqSetup: false,
    shell: true,
    setup: false,
    onboarding: true
  };
  const result = await waitForPackagedHqSurface({
    expectedSurface: "setup",
    readState: async () => firstRun,
    continueSetup: async () =>
      assert.fail("No service checklist or Continue action"),
    delayImpl: clock.delay,
    nowImpl: clock.now
  });
  assert.equal(result, firstRun);
  assert.equal(clock.now(), 0);
});

test("initial inspection can reach the HQ shell at its 180-second deadline", async () => {
  const clock = fakeClock();
  let reads = 0;
  const result = await waitForPackagedHqSurface({
    readState: async () => (++reads === 1801 ? shell : checking),
    continueSetup: async () => assert.fail("Continue must not run"),
    delayImpl: clock.delay,
    nowImpl: clock.now
  });
  assert.equal(result, shell);
  assert.equal(reads, 1801);
  assert.equal(clock.now(), 180_000);
});

test("Continue at the initial deadline gets a fresh 180-second Native verification phase", async () => {
  const clock = fakeClock();
  let reads = 0;
  let clicks = 0;
  const result = await waitForPackagedHqSurface({
    readState: async () => {
      reads += 1;
      if (reads < 1801) return checking;
      return reads < 3602 ? complete : shell;
    },
    continueSetup: async () => {
      clicks += 1;
    },
    delayImpl: clock.delay,
    nowImpl: clock.now
  });
  assert.equal(result, shell);
  assert.equal(reads, 3602);
  assert.equal(clicks, 1);
  assert.equal(clock.now(), 360_000);
});

test("each setup phase stays bounded and completed stages never stand in for the HQ shell", async () => {
  for (const state of [checking, complete]) {
    const clock = fakeClock();
    let reads = 0;
    let clicks = 0;
    const result = await waitForPackagedHqSurface({
      readState: async () => {
        reads += 1;
        return state;
      },
      continueSetup: async () => {
        clicks += 1;
      },
      delayImpl: clock.delay,
      nowImpl: clock.now
    });
    assert.equal(result.shell, false);
    assert.equal(reads, state === checking ? 1801 : 1802);
    assert.equal(clicks, state === checking ? 0 : 1);
    assert.equal(clock.now(), 180_000);
  }
});

test("polling stops at the phase deadline even when the clock advances between reads", async () => {
  let elapsed = 0;
  let reads = 0;
  const result = await waitForPackagedHqSurface({
    readState: async () => {
      reads += 1;
      return checking;
    },
    continueSetup: async () => assert.fail("Continue must not run"),
    delayImpl: async (ms) => {
      elapsed += ms + 60_000;
    },
    nowImpl: () => elapsed
  });
  assert.equal(result, checking);
  assert.equal(reads, 4);
});

test("a shell returned by a slow read after the deadline cannot pass the smoke", async () => {
  let elapsed = 0;
  let reads = 0;
  const result = await waitForPackagedHqSurface({
    readState: async () => {
      reads += 1;
      if (reads === 1) return checking;
      elapsed = 180_001;
      return shell;
    },
    continueSetup: async () => assert.fail("Continue must not run"),
    delayImpl: async () => undefined,
    nowImpl: () => elapsed
  });
  assert.equal(result, checking);
  assert.equal(reads, 2);
});

test("a completed setup returned after the deadline cannot trigger Continue", async () => {
  let elapsed = 0;
  let reads = 0;
  let clicks = 0;
  const result = await waitForPackagedHqSurface({
    readState: async () => {
      reads += 1;
      if (reads === 1) return checking;
      elapsed = 180_001;
      return complete;
    },
    continueSetup: async () => {
      clicks += 1;
    },
    delayImpl: async () => undefined,
    nowImpl: () => elapsed
  });
  assert.equal(result, checking);
  assert.equal(reads, 2);
  assert.equal(clicks, 0);
});
