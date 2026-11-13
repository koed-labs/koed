import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const addonPath = resolve(
  desktopRoot,
  "dist-electron/background-agent/native/koed_background_xpc.node"
);

test("native XPC addon loads with the Node-API contract", () => {
  const addon = require(addonPath);
  assert.equal(typeof addon.connect, "function");
  assert.equal(typeof addon.listen, "function");
  assert.equal(addon.teamId, process.env.DESKTOP_MACOS_APPLE_TEAM_ID ?? "");
  assert.deepEqual(addon.limits, {
    maxPayloadBytes: 65_536,
    maxPendingRequests: 64,
    maxConnections: 16
  });
});
