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

test("Continue on the last initial attempt still waits for fresh Native verification and the HQ shell", async () => {
  let reads = 0;
  let clicks = 0;
  const result = await waitForPackagedHqSurface({
    readState: async () => {
      reads += 1;
      if (reads < 300) return checking;
      return reads < 599 ? complete : shell;
    },
    continueSetup: async () => {
      clicks += 1;
    },
    delayImpl: async () => undefined
  });
  assert.equal(result, shell);
  assert.equal(reads, 599);
  assert.equal(clicks, 1);
});

test("each setup phase stays bounded and completed stages never stand in for the HQ shell", async () => {
  for (const state of [checking, complete]) {
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
      delayImpl: async () => undefined
    });
    assert.equal(result.shell, false);
    assert.equal(reads, state === checking ? 300 : 301);
    assert.equal(clicks, state === checking ? 0 : 1);
  }
});
