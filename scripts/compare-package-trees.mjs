#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
  readdirSync
} from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const sha256File = (path) => {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
};

export const packageTreeEntries = (root, directory = root) =>
  readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = resolve(directory, name);
      const relativePath = relative(root, path).replaceAll("\\", "/");
      const stat = lstatSync(path);
      const mode = stat.mode & 0o777;
      if (stat.isDirectory()) {
        return [
          { path: `${relativePath}/`, type: "directory", mode },
          ...packageTreeEntries(root, path)
        ];
      }
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        return [
          {
            path: relativePath,
            type: "symlink",
            mode,
            target,
            sha256: sha256(`symlink\0${target}`)
          }
        ];
      }
      if (stat.isFile()) {
        return [
          {
            path: relativePath,
            type: "file",
            mode,
            bytes: stat.size,
            sha256: sha256File(path)
          }
        ];
      }
      throw new Error(`Unsupported package tree entry: ${relativePath}`);
    });

export const packageTreeDigest = (root) => {
  const entries = packageTreeEntries(resolve(root));
  return {
    root: resolve(root),
    entries,
    sha256: sha256(JSON.stringify(entries))
  };
};

export const comparePackageTrees = (first, second) => {
  const firstTree = packageTreeDigest(first);
  const secondTree = packageTreeDigest(second);
  const firstByPath = new Map(
    firstTree.entries.map((entry) => [entry.path, entry])
  );
  const secondByPath = new Map(
    secondTree.entries.map((entry) => [entry.path, entry])
  );
  const paths = [
    ...new Set([...firstByPath.keys(), ...secondByPath.keys()])
  ].sort();
  const differences = paths.flatMap((path) => {
    const left = firstByPath.get(path);
    const right = secondByPath.get(path);
    return JSON.stringify(left) === JSON.stringify(right)
      ? []
      : [{ path, first: left ?? null, second: right ?? null }];
  });
  return {
    ok: differences.length === 0,
    first: {
      root: firstTree.root,
      entries: firstTree.entries.length,
      sha256: firstTree.sha256
    },
    second: {
      root: secondTree.root,
      entries: secondTree.entries.length,
      sha256: secondTree.sha256
    },
    differences
  };
};

const parseArgs = (argv) => {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--first") options.first = argv[++index];
    else if (value === "--second") options.second = argv[++index];
    else if (value === "--json") options.json = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: compare-package-trees --first <path> --second <path> [--json]"
    );
    return;
  }
  if (!options.first || !options.second) {
    throw new Error("--first and --second are required.");
  }
  const result = comparePackageTrees(options.first, options.second);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      result.ok
        ? `Package trees match: ${result.first.sha256}`
        : `Package trees differ at ${result.differences.length} path(s).`
    );
  }
  if (!result.ok) {
    console.error(JSON.stringify(result.differences.slice(0, 20), null, 2));
    process.exitCode = 1;
  }
};

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main();
}
