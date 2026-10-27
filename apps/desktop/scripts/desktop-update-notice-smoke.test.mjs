import assert from "node:assert/strict";
import test from "node:test";
import { assertPackagedNoticeState } from "./desktop-update-notice-smoke.mjs";

test("packaged private smoke proves notice state without public network/updater authority", () => {
  const state = {
    installedVersion: "0.8.1",
    status: "disabled",
    release: null,
    checkedAt: null
  };
  assert.deepEqual(assertPackagedNoticeState(state), state);
  for (const patch of [
    { status: "available" },
    { status: "checking" },
    { installedVersion: "" },
    { install: true },
    { checkedAt: "2026-10-26T00:00:00Z" }
  ]) {
    assert.throws(() => assertPackagedNoticeState({ ...state, ...patch }));
  }
});
