import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { createPackageWithOptions } from "@electron/asar";
import {
  assertNoPrivacyPayload,
  inventoryDesktopPayload
} from "./privacy-payload-inventory.mjs";

const write = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};

test("inventories physical files, ASAR/unpacked payload and duplicate copies without following links", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "privacy-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  const app = resolve(root, "Koed.app");
  write(
    resolve(source, "node_modules/renamed/package.json"),
    JSON.stringify({ name: "onnxruntime-node", version: "1.24.3" })
  );
  write(resolve(source, "node_modules/renamed/native.node"), "native fixture");
  write(resolve(source, "main.js"), "application fixture");
  mkdirSync(resolve(app, "Contents/Resources"), { recursive: true });
  await createPackageWithOptions(
    source,
    resolve(app, "Contents/Resources/app.asar"),
    { unpack: "**/*.node" }
  );
  write(
    resolve(app, "Contents/Resources/nested/node_modules/renamed/package.json"),
    JSON.stringify({ name: "onnxruntime-node", version: "1.24.3" })
  );
  write(
    resolve(app, "Contents/Resources/nested/node_modules/renamed/native.node"),
    "native fixture"
  );
  symlinkSync("..", resolve(app, "Contents/cycle"));
  const report = inventoryDesktopPayload(app);
  assert.ok(report.privacyFiles.some((entry) => entry.location === "asar"));
  assert.ok(
    report.privacyFiles.some((entry) =>
      entry.path.includes("app.asar.unpacked/")
    )
  );
  assert.equal(report.links.length, 1);
  const native = report.duplicates.find(
    (entry) => entry.bytesPerCopy === Buffer.byteLength("native fixture")
  );
  assert.equal(native.paths.length, 2);
  assert.throws(() => assertNoPrivacyPayload(app), /Privacy-only payload/);
});

test("classifies reviewed transitive packages and model weights without treating control-plane modules as payload", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "privacy-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    resolve(root, "dist/privacy-service-bootstrap.js"),
    "control-plane fixture"
  );
  assert.doesNotThrow(() => assertNoPrivacyPayload(root));
  write(
    resolve(root, "nested/node_modules/extra/package.json"),
    JSON.stringify({ name: "privacy-transitive", version: "1.0.0" })
  );
  assert.throws(
    () => assertNoPrivacyPayload(root, ["privacy-transitive"]),
    /Privacy-only payload/
  );
  write(resolve(root, "resources/model.onnx"), "model fixture");
  assert.ok(
    inventoryDesktopPayload(root).privacyFiles.some((entry) =>
      entry.path.endsWith("model.onnx")
    )
  );
});
