import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { writeControlPlaneLauncher } from "./control-plane-bundle.mjs";

test("generated launcher accepts Node 24 through 26 only", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-node-guard-"));
  try {
    const launcher = resolve(root, "cli.js");
    writeControlPlaneLauncher(launcher, "./unused.js");
    const guard = readFileSync(launcher, "utf8").split("\n")[1];
    for (const [version, accepted] of [
      ["23.99.99", false],
      ["24.0.0", true],
      ["25.0.0", true],
      ["26.99.99", true],
      ["27.0.0", false]
    ]) {
      let exitCode;
      let message = "";
      runInNewContext(guard, {
        process: {
          versions: { node: version },
          exit: (code) => {
            exitCode = code;
          }
        },
        console: {
          error: (value) => {
            message = value;
          }
        }
      });
      assert.equal(exitCode, accepted ? undefined : 1, version);
      if (!accepted) assert.match(message, /requires Node\.js >=24 <27/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
