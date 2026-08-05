import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const listRuntimeFiles = (root) =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return listRuntimeFiles(path);
    return [path];
  });

const machoMagic = new Set([
  "bebafeca",
  "bfbafeca",
  "cafebabe",
  "cafebabf",
  "cefaedfe",
  "cffaedfe",
  "feedface",
  "feedfacf"
]);

const platformBinary = (file, platform) => {
  let descriptor;
  try {
    descriptor = openSync(file, "r");
    const magic = Buffer.alloc(4);
    if (readSync(descriptor, magic, 0, magic.length, 0) !== magic.length)
      return false;
    const hex = magic.toString("hex");
    return platform === "darwin" ? machoMagic.has(hex) : hex === "7f454c46";
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

export const collectPlatformBinaries = ({ runtimeRoot, platform }) => [
  ...new Set(
    listRuntimeFiles(runtimeRoot)
      .filter((file) => platformBinary(file, platform))
      .map((file) => realpathSync(file))
  )
];

export const boundedMap = async (values, concurrency, map) => {
  const results = new Array(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker)
  );
  return results;
};

const parseMacDependencies = (output) =>
  output
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(/^(\S+)\s+\(compatibility version/);
      return match ? [match[1]] : [];
    });

const isSystemMacDependency = (dependency) =>
  dependency.startsWith("/usr/lib/") ||
  dependency.startsWith("/System/Library/");

const canonicalPath = (path) =>
  existsSync(path) ? realpathSync(path) : resolve(path);

export const macLoaderIssues = ({
  file,
  output,
  runtimeFiles,
  runtimeRoot
}) => {
  const issues = [];
  const files = new Set(runtimeFiles.map((path) => resolve(path)));
  const basenames = new Set(runtimeFiles.map((path) => basename(path)));
  if (/not found/i.test(output))
    issues.push("loader reported a missing library");

  for (const dependency of parseMacDependencies(output)) {
    if (isSystemMacDependency(dependency)) continue;
    if (dependency.startsWith("@loader_path/")) {
      const resolved = resolve(
        dirname(file),
        dependency.slice("@loader_path/".length)
      );
      if (!files.has(resolved) && !existsSync(resolved)) {
        issues.push(`unresolved loader-relative dependency: ${dependency}`);
      }
      continue;
    }
    if (
      dependency.startsWith("@rpath/") ||
      dependency.startsWith("@executable_path/")
    ) {
      if (!basenames.has(basename(dependency))) {
        issues.push(`unresolved runtime-relative dependency: ${dependency}`);
      }
      continue;
    }
    if (dependency.startsWith("/")) {
      issues.push(`external absolute dependency: ${dependency}`);
      continue;
    }
    issues.push(`unsupported loader dependency: ${dependency}`);
  }

  const normalizedRoot = canonicalPath(runtimeRoot);
  if (!resolve(file).startsWith(`${normalizedRoot}/`)) {
    issues.push(`loader file escaped runtime root: ${file}`);
  }
  return issues;
};
