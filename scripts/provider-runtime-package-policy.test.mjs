import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  assertNoClaudeAgentSdkPlatformRuntimes,
  claudeAgentSdkVersion,
  removeClaudeAgentSdkPlatformRuntimes
} from "./provider-runtime-package-policy.mjs";

const temps = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-provider-runtime-policy-"));
  temps.push(path);
  return path;
};

const writeFile = (path, content = "fixture\n", mode) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
};

const writePlatformPackage = (
  root,
  {
    name = "@anthropic-ai/claude-agent-sdk-linux-x64",
    version = claudeAgentSdkVersion,
    extraFile
  } = {}
) => {
  const path = resolve(root, "node_modules", ...name.split("/"));
  mkdirSync(path, { recursive: true });
  const windows = name.includes("-win32-");
  const executable = windows ? "claude.exe" : "claude";
  const suffix = name.slice("@anthropic-ai/claude-agent-sdk-".length);
  const [os, cpu] = suffix.split("-");
  const libc = suffix.endsWith("-musl")
    ? "musl"
    : os === "linux"
      ? "glibc"
      : undefined;
  writeFile(
    resolve(path, "package.json"),
    `${JSON.stringify({
      name,
      version,
      os: [os],
      cpu: [cpu],
      ...(libc ? { libc: [libc] } : {}),
      files: [executable, "README.md", "LICENSE.md"]
    })}\n`
  );
  writeFile(resolve(path, "README.md"));
  writeFile(resolve(path, "LICENSE.md"));
  writeFile(resolve(path, executable), "provider executable\n", 0o755);
  if (extraFile) writeFile(resolve(path, extraFile));
  return path;
};

test.afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("removes a verified pinned platform package and preserves SDK JavaScript", () => {
  const root = tempDir();
  const sdkJavaScript = resolve(
    root,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "sdk.mjs"
  );
  writeFile(sdkJavaScript, "export const query = () => {};\n");
  const platformPackage = writePlatformPackage(root);

  const removed = removeClaudeAgentSdkPlatformRuntimes(root);

  assert.equal(existsSync(platformPackage), false);
  assert.equal(existsSync(sdkJavaScript), true);
  assert.deepEqual(removed, [
    "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"
  ]);
  assert.doesNotThrow(() => assertNoClaudeAgentSdkPlatformRuntimes(root));
});

test("supports the pinned Windows executable shape", () => {
  const root = tempDir();
  const platformPackage = writePlatformPackage(root, {
    name: "@anthropic-ai/claude-agent-sdk-win32-x64"
  });

  removeClaudeAgentSdkPlatformRuntimes(root);

  assert.equal(existsSync(platformPackage), false);
});

test("fails closed on an unknown platform package without deleting it", () => {
  const root = tempDir();
  const platformPackage = writePlatformPackage(root, {
    name: "@anthropic-ai/claude-agent-sdk-plan9-x64"
  });

  assert.throws(
    () => removeClaudeAgentSdkPlatformRuntimes(root),
    /Unknown Claude Agent SDK provider runtime package/
  );
  assert.equal(existsSync(platformPackage), true);
});

test("fails closed on a version or file-shape mismatch without deleting", () => {
  const root = tempDir();
  const wrongVersion = writePlatformPackage(root, { version: "0.3.225" });
  assert.throws(
    () => removeClaudeAgentSdkPlatformRuntimes(root),
    /version mismatch/
  );
  assert.equal(existsSync(wrongVersion), true);

  rmSync(wrongVersion, { recursive: true });
  const altered = writePlatformPackage(root, { extraFile: "unexpected.bin" });
  assert.throws(
    () => removeClaudeAgentSdkPlatformRuntimes(root),
    /unknown file shape/
  );
  assert.equal(existsSync(altered), true);
});

test("validates an external symlink target but removes only the packaged link", () => {
  const root = tempDir();
  const externalRoot = tempDir();
  const externalPackage = writePlatformPackage(externalRoot);
  const packagedLink = resolve(
    root,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk-linux-x64"
  );
  mkdirSync(dirname(packagedLink), { recursive: true });
  symlinkSync(externalPackage, packagedLink, "dir");

  removeClaudeAgentSdkPlatformRuntimes(root);

  assert.equal(existsSync(packagedLink), false);
  assert.equal(existsSync(externalPackage), true);
});

test("assertion rejects a loose provider executable under the Anthropic scope", () => {
  const root = tempDir();
  writeFile(
    resolve(root, "node_modules", "@anthropic-ai", "unexpected", "claude"),
    "provider executable\n",
    0o755
  );

  assert.throws(
    () => assertNoClaudeAgentSdkPlatformRuntimes(root),
    /provider executable\/runtime/
  );
});
