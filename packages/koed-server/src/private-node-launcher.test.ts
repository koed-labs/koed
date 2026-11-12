import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { privateNodeLauncher } from "./private-node-launcher.js";

const installer = resolve(
  import.meta.dirname,
  "../../../scripts/install-server.sh"
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "koed private-node "));
  roots.push(root);
  return root;
};

// Stands in for node.bin on a host without system libatomic: it starts only
// when the loader path names the private library directory.
const fakeNode = (root: string): string => {
  mkdirSync(join(root, "bin"), { recursive: true });
  const node = join(root, "bin", "node");
  writeFileSync(
    node,
    `#!/bin/sh\n[ "$LD_LIBRARY_PATH" = '${join(root, "lib", "koed")}' ] || exit 127\necho ok\n`
  );
  chmodSync(node, 0o700);
  return node;
};

// Writes bin/node with the installer's own wrapper generator.
const installWrapper = (root: string): void => {
  const script = readFileSync(installer, "utf8");
  const generator = /<<'PYNODEWRAPPER'\n([\s\S]*?)\nPYNODEWRAPPER\n/.exec(
    script
  )?.[1];
  expect(generator).toBeDefined();
  const result = spawnSync("python3", ["-I", "-", root], {
    input: generator,
    encoding: "utf8"
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
};

const installedRoot = (): { root: string; binary: string; wrapper: string } => {
  const root = tempRoot();
  fakeNode(root);
  installWrapper(root);
  return {
    root,
    binary: join(root, "bin", "node.bin"),
    wrapper: join(root, "bin", "node")
  };
};

describe("private Node launcher", () => {
  it("returns other Node executables unchanged", () => {
    expect(privateNodeLauncher("/usr/bin/node")).toBe("/usr/bin/node");
    expect(privateNodeLauncher(process.execPath)).toBe(process.execPath);
  });

  it("starts the installer's private Node with a restricted environment", () => {
    const { binary, wrapper } = installedRoot();
    const restricted = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };

    // Launching node.bin directly drops the private library path.
    expect(spawnSync(binary, [], { env: restricted }).status).toBe(127);
    expect(privateNodeLauncher(binary)).toBe(wrapper);
    const launched = spawnSync(privateNodeLauncher(binary), [], {
      env: restricted,
      encoding: "utf8"
    });
    expect(launched.status).toBe(0);
    expect(launched.stdout).toBe("ok\n");
  });

  it("matches the wrapper through a symlinked install path", () => {
    const { root, wrapper } = installedRoot();
    const alias = join(tempRoot(), "alias");
    symlinkSync(root, alias);
    expect(privateNodeLauncher(join(alias, "bin", "node.bin"))).toBe(
      join(alias, "bin", "node")
    );
    expect(privateNodeLauncher(join(root, "bin", "node.bin"))).toBe(wrapper);
  });

  it("ignores a symlinked wrapper", () => {
    const { root, binary, wrapper } = installedRoot();
    const elsewhere = join(root, "wrapper-copy");
    copyFileSync(wrapper, elsewhere);
    rmSync(wrapper);
    symlinkSync(elsewhere, wrapper);
    expect(privateNodeLauncher(binary)).toBe(binary);
  });

  it("ignores a wrapper that runs a different binary", () => {
    const { binary, wrapper } = installedRoot();
    const other = installedRoot();
    copyFileSync(other.wrapper, wrapper);
    expect(privateNodeLauncher(binary)).toBe(binary);
  });

  it("ignores a sibling node file that is not the private wrapper", () => {
    const { binary, wrapper } = installedRoot();
    writeFileSync(wrapper, `#!/bin/sh\nexec '${binary}' "$@"\n`);
    expect(privateNodeLauncher(binary)).toBe(binary);
  });

  it("falls back when the wrapper is missing", () => {
    const { binary, wrapper } = installedRoot();
    rmSync(wrapper);
    expect(privateNodeLauncher(binary)).toBe(binary);
  });
});
