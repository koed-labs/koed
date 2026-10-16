import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareMacosSigning } from "./prepare-macos-signing.mjs";

const required = [
  "DESKTOP_MACOS_CSC_LINK",
  "DESKTOP_MACOS_CSC_KEY_PASSWORD",
  "DESKTOP_MACOS_APPLE_API_KEY_P8_BASE64",
  "DESKTOP_MACOS_APPLE_API_KEY_ID",
  "DESKTOP_MACOS_APPLE_API_ISSUER",
  "DESKTOP_MACOS_APPLE_TEAM_ID"
];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "koed-signing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(required.map((key) => [key, "private-value"]));
  env.DESKTOP_MACOS_APPLE_API_KEY_P8_BASE64 =
    Buffer.from("private-key-bytes").toString("base64");
  return {
    root,
    env: { ...env, RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, "output") }
  };
}
for (const key of [...required, "RUNNER_TEMP", "GITHUB_OUTPUT"]) {
  test(`rejects missing ${key} before writing`, (t) => {
    const { root, env } = fixture(t);
    delete env[key];
    assert.throws(() => prepareMacosSigning(env), /Missing/);
    assert.deepEqual(readdirSync(root), []);
  });
}
test("writes exact key bytes with owner-only permissions and path-only output", (t) => {
  const { root, env } = fixture(t);
  const { appleApiKeyPath } = prepareMacosSigning(env);
  assert.equal(appleApiKeyPath.startsWith(root + "/"), true);
  assert.equal(readFileSync(appleApiKeyPath, "utf8"), "private-key-bytes");
  assert.equal(statSync(appleApiKeyPath).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(env.GITHUB_OUTPUT, "utf8"),
    `apple-api-key-path=${appleApiKeyPath}\n`
  );
  assert.throws(() => prepareMacosSigning(env), /EEXIST/);
});
test("rejects malformed base64 without exposing secret", (t) => {
  const { root, env } = fixture(t);
  env.DESKTOP_MACOS_APPLE_API_KEY_P8_BASE64 = "sensitive-invalid!";
  assert.throws(
    () => prepareMacosSigning(env),
    (error) =>
      !error.message.includes("sensitive-invalid!") &&
      /base64/.test(error.message)
  );
  assert.deepEqual(readdirSync(root), []);
});
