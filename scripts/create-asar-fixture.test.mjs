import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { createAsarFixture } from "./test-utils/create-asar-fixture.mjs";

test("ASAR fixture waits for stream completion, not only package API resolution", async () => {
  let completed = false;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
    final(callback) {
      setImmediate(() => {
        completed = true;
        callback();
      });
    }
  });
  await createAsarFixture(async () => output.end(), "source", "destination");
  assert.equal(completed, true);
});
