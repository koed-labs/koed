import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { signAndPackageCandidate } from "./sign-candidate-macos.mjs";

const fixture = (t) => {
  const base = resolve("scratch", "candidate-sign-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const inputs = (root) => ({
  bundle: { appPath: join(root, "Koed.app") },
  outputDir: join(root, "output"),
  workspace: root,
  expectedTeamId: "ABCDEFGHIJ",
  p12Base64: Buffer.from("test certificate").toString("base64"),
  p12Password: "private-password",
  apiKeyBase64: Buffer.from("test private key").toString("base64"),
  apiKeyId: "ABC123DEFG",
  issuerId: "01234567-89ab-cdef-0123-456789abcdef"
});
const fakeTools = (commands, failAt) => ({
  run: async (command, args) => {
    commands.push({ command, args });
    if (commands.length === failAt)
      throw new Error("private-password must never escape");
    if (command === "security" && args[0] === "find-identity")
      return `  1) ${"A".repeat(40)} "Developer ID Application: Example (ABCDEFGHIJ)"`;
    if (command === "xcrun" && args[0] === "notarytool")
      return JSON.stringify({ status: "Accepted" });
    return "";
  },
  sign: async (_bundle, options) => {
    commands.push({ command: "SIGN", args: options });
  }
});

test("signs only using the trusted interface before notarization and always deletes keychain", async (t) => {
  const root = fixture(t);
  const commands = [];
  await signAndPackageCandidate(inputs(root), fakeTools(commands));
  const names = commands.map(
    ({ command, args }) => `${command}:${Array.isArray(args) ? args[0] : ""}`
  );
  assert.ok(names.indexOf("SIGN:") < names.indexOf("xcrun:notarytool"));
  assert.equal(names.at(-1), "security:delete-keychain");
  const sign = commands.find((item) => item.command === "SIGN");
  assert.equal(sign.args.identity, "A".repeat(40));
  assert.ok(sign.args.keychain.startsWith(root));
});

test("rejects wrong or ambiguous signing identity", async (t) => {
  const root = fixture(t);
  const commands = [];
  const tools = fakeTools(commands);
  const run = tools.run;
  tools.run = async (cmd, args) =>
    cmd === "security" && args[0] === "find-identity"
      ? `1) ${"A".repeat(40)} "Developer ID Application: Wrong (ZZZZZZZZZZ)"`
      : run(cmd, args);
  await assert.rejects(
    signAndPackageCandidate(inputs(root), tools),
    /identity/i
  );
  assert.equal(commands.at(-1).args[0], "delete-keychain");
});

test("does not publish partial output if final notarization fails", async (t) => {
  const root = fixture(t);
  const commands = [];
  await assert.rejects(
    signAndPackageCandidate(inputs(root), fakeTools(commands, 12))
  );
  assert.equal(existsSync(join(root, "output")), false);
});

test("rejects output through a symlinked parent", async (t) => {
  const root = fixture(t);
  symlinkSync(root, join(root, "link"));
  const input = inputs(root);
  input.outputDir = join(root, "link", "output");
  await assert.rejects(
    signAndPackageCandidate(input, fakeTools([])),
    /output directory/i
  );
});

test("cleans the keychain and redacts tool errors on failure", async (t) => {
  const root = fixture(t);
  const commands = [];
  await assert.rejects(
    signAndPackageCandidate(inputs(root), fakeTools(commands, 3)),
    (error) => !String(error).includes("private-password")
  );
  assert.equal(commands.at(-1).args[0], "delete-keychain");
});
