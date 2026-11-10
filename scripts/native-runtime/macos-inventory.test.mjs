import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalArtifactJson } from "../../packages/koed-server/src/artifact-canonical-json.mjs";
import { verifyApprovedMacosInventory } from "./macos-inventory.mjs";

const file = (path) => ({
  path,
  type: "file",
  mode: 0o644,
  bytes: 1,
  sha256: "a".repeat(64)
});
const inventory = [
  file("README.koed-native-runtime.txt"),
  { path: "postgres", type: "directory", mode: 0o755 },
  file("postgres/README.koed-native-runtime.txt"),
  file("provenance.json")
];
const digest = (value) =>
  createHash("sha256").update(canonicalArtifactJson(value)).digest("hex");

test("approved full inventory projects only exact root metadata", () => {
  assert.deepEqual(verifyApprovedMacosInventory(inventory, digest(inventory)), [
    inventory[1],
    inventory[2]
  ]);
});

test("missing or changed independent approval fails closed", () => {
  assert.throws(() => verifyApprovedMacosInventory(inventory));
  assert.throws(() => verifyApprovedMacosInventory(inventory, "0".repeat(64)));
  const changed = structuredClone(inventory);
  changed[3].bytes = 2;
  assert.throws(() => verifyApprovedMacosInventory(changed, digest(inventory)));
});

test("approved symlinks must directly target a contained inventory file", () => {
  const valid = [
    file("file"),
    { path: "link", type: "symlink", mode: 0o777, target: "file" }
  ];
  assert.deepEqual(verifyApprovedMacosInventory(valid, digest(valid)), valid);
  const indirect = [
    ...valid,
    { path: "other", type: "symlink", mode: 0o777, target: "link" }
  ];
  assert.throws(() => verifyApprovedMacosInventory(indirect, digest(indirect)));
});

test("approval cannot legitimize malformed or noncanonical inventory", () => {
  const cases = [
    [inventory[1], inventory[1]],
    [inventory[1], inventory[0]],
    [file("../escape")],
    [{ ...file("postgres/a"), extra: true }],
    [{ path: "link", type: "symlink", mode: 0o777, target: "../escape" }],
    [{ ...file("x"), mode: 0o4644 }]
  ];
  for (const value of cases)
    assert.throws(() => verifyApprovedMacosInventory(value, digest(value)));
});
