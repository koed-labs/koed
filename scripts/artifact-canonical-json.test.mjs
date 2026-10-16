import assert from "node:assert/strict";
import { test } from "node:test";

const load = () =>
  import("../packages/koed-server/src/artifact-canonical-json.mjs");

test("artifact serializer runs from source and preserves golden UTF-8 bytes", async () => {
  const { canonicalArtifactJson, canonicalArtifactBytes } = await load();
  const value = {
    z: [true, null, -0, 'é\n"'],
    2: { b: 2, a: 1 },
    10: "雪"
  };
  const golden = String.raw`{"10":"雪","2":{"a":1,"b":2},"z":[true,null,0,"é\n\""]}`;
  assert.equal(canonicalArtifactJson(value), golden);
  assert.deepEqual(canonicalArtifactBytes(value), Buffer.from(golden, "utf8"));
  assert.equal(canonicalArtifactJson([2, 1]), "[2,1]");
  assert.equal(
    canonicalArtifactJson(Object.assign(Object.create(null), { b: 2, a: 1 })),
    '{"a":1,"b":2}'
  );
});

test("artifact serializer rejects unsupported top-level and nested values", async () => {
  const { canonicalArtifactJson, canonicalArtifactBytes } = await load();
  const cycle = {};
  cycle.self = cycle;
  const sparse = [1, 2, 3];
  delete sparse[1];
  const values = [
    undefined,
    () => {},
    Symbol("x"),
    1n,
    NaN,
    Infinity,
    -Infinity,
    new Array(1),
    sparse,
    cycle,
    new Date(0),
    new Map(),
    /x/,
    Object.create({ inherited: true })
  ];
  for (const value of values) {
    for (const input of [value, { value }, [value]]) {
      assert.throws(
        () => canonicalArtifactJson(input),
        /unsupported|cyclic|sparse/
      );
      assert.throws(
        () => canonicalArtifactBytes(input),
        /unsupported|cyclic|sparse/
      );
    }
  }
});

test("release promotion uses artifact byte contract and rejects unsupported values", async () => {
  const { canonicalReleaseJson } =
    await import("./release-promotion-adapter.mjs");
  const value = { z: [true, null, -0, 'é\n"'], 2: { b: 2, a: 1 }, 10: "雪" };
  const { canonicalArtifactJson } = await load();
  assert.equal(canonicalReleaseJson(value), canonicalArtifactJson(value));
  assert.throws(
    () => canonicalReleaseJson({ invalid: undefined }),
    /unsupported/
  );
  assert.throws(() => canonicalReleaseJson(NaN), /unsupported/);
});

test("artifact serializer allows repeated references without treating them as cycles", async () => {
  const { canonicalArtifactJson } = await load();
  const shared = { b: 2, a: 1 };
  assert.equal(
    canonicalArtifactJson([shared, shared]),
    '[{"a":1,"b":2},{"a":1,"b":2}]'
  );
});
