import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyDisabledDesktopUpdateNotice } from "./desktop-update-notice-smoke.mjs";

test("private packaged smoke verifies disabled notice without network or updater authority", async () => {
  const result = await verifyDisabledDesktopUpdateNotice(async () => ({
    installedVersion: "0.10.0",
    status: "disabled",
    release: null,
    checkedAt: null
  }));
  assert.equal(result.status, "disabled");
});
