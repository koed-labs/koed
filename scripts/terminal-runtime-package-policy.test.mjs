import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  nodePtyVersion,
  pruneTerminalRuntimeForTarget
} from "./terminal-runtime-package-policy.mjs";

const temps = [];
const writeFile = (path, content = "native fixture\n") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const elf = (machine) => {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(machine, 18);
  return header;
};

const windowsFiles = [
  "conpty.node",
  "conpty.pdb",
  "conpty/OpenConsole.exe",
  "conpty/conpty.dll",
  "conpty_console_list.node",
  "conpty_console_list.pdb",
  "pty.node",
  "pty.pdb",
  "winpty-agent.exe",
  "winpty-agent.pdb",
  "winpty.dll",
  "winpty.pdb"
];

const fixture = () => {
  const runtimeRoot = mkdtempSync(resolve(tmpdir(), "koed-terminal-policy-"));
  temps.push(runtimeRoot);
  const packageRoot = resolve(runtimeRoot, "node_modules", "node-pty");
  writeFile(
    resolve(packageRoot, "package.json"),
    `${JSON.stringify({ name: "node-pty", version: nodePtyVersion, license: "MIT" })}\n`
  );
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    for (const file of ["pty.node", "spawn-helper"]) {
      writeFile(resolve(packageRoot, "prebuilds", target, file));
    }
  }
  for (const target of ["win32-arm64", "win32-x64"]) {
    for (const file of windowsFiles) {
      writeFile(resolve(packageRoot, "prebuilds", target, file));
    }
  }
  for (const target of ["win10-arm64", "win10-x64"]) {
    for (const file of ["OpenConsole.exe", "conpty.dll"]) {
      writeFile(
        resolve(
          packageRoot,
          "third_party",
          "conpty",
          "1.23.251008001",
          target,
          file
        )
      );
    }
  }
  writeFile(resolve(packageRoot, "build", "Release", "pty.node"), elf(62));
  return { runtimeRoot, packageRoot };
};

test.afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("keeps the Linux native build and removes every foreign prebuild", () => {
  const { runtimeRoot, packageRoot } = fixture();

  const result = pruneTerminalRuntimeForTarget({
    runtimeRoot,
    platform: "linux",
    architecture: "x64"
  });

  assert.deepEqual(result, {
    platform: "linux",
    architecture: "x64",
    runtime: "native-build"
  });
  assert.equal(
    existsSync(resolve(packageRoot, "build", "Release", "pty.node")),
    true
  );
  assert.equal(existsSync(resolve(packageRoot, "prebuilds")), false);
  assert.equal(existsSync(resolve(packageRoot, "third_party")), false);
});

test("keeps only the selected macOS prebuild", () => {
  const { runtimeRoot, packageRoot } = fixture();

  const result = pruneTerminalRuntimeForTarget({
    runtimeRoot,
    platform: "macos",
    architecture: "arm64"
  });

  assert.equal(result.runtime, "prebuild");
  assert.equal(
    existsSync(resolve(packageRoot, "prebuilds", "darwin-arm64", "pty.node")),
    true
  );
  assert.equal(
    existsSync(resolve(packageRoot, "prebuilds", "darwin-x64")),
    false
  );
  assert.equal(
    existsSync(resolve(packageRoot, "prebuilds", "win32-arm64")),
    false
  );
  assert.equal(existsSync(resolve(packageRoot, "build")), false);
  assert.equal(existsSync(resolve(packageRoot, "third_party")), false);
});

test("keeps only the selected Windows prebuild", () => {
  const { runtimeRoot, packageRoot } = fixture();

  pruneTerminalRuntimeForTarget({
    runtimeRoot,
    platform: "windows",
    architecture: "x64"
  });

  assert.equal(
    existsSync(resolve(packageRoot, "prebuilds", "win32-x64", "conpty.node")),
    true
  );
  assert.equal(
    existsSync(resolve(packageRoot, "prebuilds", "win32-arm64")),
    false
  );
  assert.equal(existsSync(resolve(packageRoot, "build")), false);
});

test("fails closed before pruning when the dependency shape changes", () => {
  const { runtimeRoot, packageRoot } = fixture();
  writeFile(resolve(packageRoot, "prebuilds", "plan9-x64", "pty.node"));

  assert.throws(
    () =>
      pruneTerminalRuntimeForTarget({
        runtimeRoot,
        platform: "linux",
        architecture: "x64"
      }),
    /Unknown node-pty prebuild target/
  );
  assert.equal(
    existsSync(resolve(packageRoot, "prebuilds", "darwin-arm64")),
    true
  );
  assert.equal(existsSync(resolve(packageRoot, "third_party")), true);
});

test("rejects an unsupported target before pruning", () => {
  const { runtimeRoot, packageRoot } = fixture();

  assert.throws(
    () =>
      pruneTerminalRuntimeForTarget({
        runtimeRoot,
        platform: "linux",
        architecture: "arm64"
      }),
    /does not contain a usable linux-arm64 runtime/
  );
  assert.equal(
    existsSync(resolve(packageRoot, "prebuilds", "darwin-arm64")),
    true
  );
});
