import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import {
  classifyAsarEntries,
  evaluateDesktopArtifactPolicy
} from "./desktop-artifact-report-lib.mjs";

test("distinguishes Electron main, preload, and metadata bytes", () => {
  assert.deepEqual(
    classifyAsarEntries([
      { path: "/dist-electron/main.js", size: 10 },
      { path: "/dist-electron/preload.cjs", size: 20 },
      { path: "/node_modules/@koed-labs/server/dist/cli.js", size: 30 },
      { path: "/package.json", size: 5 }
    ]),
    { main: 40, preload: 20, metadata: 5 }
  );
});

test("enforces Desktop distribution reduction against the fixed baseline", () => {
  const result = evaluateDesktopArtifactPolicy(
    { distributions: { dmgBytes: 90, zipBytes: 70 } },
    { desktopReductionMinimum: 0.2 },
    {
      artifacts: {
        "Koed-0.6.2-arm64.dmg": 100,
        "Koed-0.6.2-arm64.zip": 100
      }
    }
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /dmgBytes/);
});

test("keeps renderer-only packages out of Electron production dependencies", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    "@koed-labs/server",
    "@koed/mcp-server",
    "@koed/shared",
    "ws",
    "zod"
  ]);
  for (const dependency of [
    "@koed/memory-ui",
    "@koed/ui",
    "@xterm/addon-fit",
    "@xterm/xterm",
    "lucide-react",
    "qrcode",
    "react",
    "react-dom"
  ]) {
    assert.equal(typeof manifest.devDependencies[dependency], "string");
  }
  const builder = readFileSync(
    new URL("../electron-builder.yml", import.meta.url),
    "utf8"
  );
  assert.match(builder, /from: \.koed-runtime\/node_modules/);
  assert.match(builder, /to: koed-runtime\/node_modules/);
});
