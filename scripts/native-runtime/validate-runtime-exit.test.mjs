import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("native runtime validation flushes reports before exiting", () => {
  const source = readFileSync(
    new URL("./validate-runtime.mjs", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /\bprocess\.exit\(/);
  assert.match(source, /process\.exitCode\s*=/);
});
