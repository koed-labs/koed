import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { stageLocalControl } from "./stage-local-control.mjs";

test("stages the native addon inside the runtime inventory on macOS only", () => {
  const scratch = resolve(import.meta.dirname, "../../../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "local-control-stage-"));
  try {
    const source = resolve(root, "addon.node");
    const runtime = resolve(root, "runtime");
    writeFileSync(source, "test-addon");
    assert.equal(
      stageLocalControl({ platform: "linux", source, runtime }),
      undefined
    );
    const destination = stageLocalControl({
      platform: "darwin",
      source,
      runtime
    });
    assert.equal(
      destination,
      resolve(runtime, "control/koed_background_xpc.node")
    );
    assert.equal(readFileSync(destination, "utf8"), "test-addon");
    assert.throws(() =>
      stageLocalControl({
        platform: "darwin",
        source: resolve(root, "missing"),
        runtime
      })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
