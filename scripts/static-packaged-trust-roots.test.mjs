import assert from "node:assert/strict";
import test from "node:test";
import { inspectPackagedTrustRoots } from "./static-packaged-trust-roots.mjs";

test("reads packaged trust roots as literals without executing candidate code", () => {
  assert.deepEqual(
    inspectPackagedTrustRoots(
      'throw new Error("EXECUTED"); export const productionComponentTrustRoots = new Map([["key", `pem`]]);'
    ),
    { key: "pem" }
  );
});
test("rejects executable initializers and mutated trust roots", () => {
  for (const source of [
    'export const productionComponentTrustRoots = (() => { throw new Error("EXECUTED"); })();',
    'export const productionComponentTrustRoots = new Map([["key", "pem"]]); productionComponentTrustRoots.set("key", "other");',
    'export let productionComponentTrustRoots = new Map([["key", "pem"]]);',
    'export const productionComponentTrustRoots = new Map([["key", "pem"], ["key", "other"]]);'
  ])
    assert.throws(() => inspectPackagedTrustRoots(source), /Packaged/);
});
