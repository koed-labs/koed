import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { relative, resolve } from "node:path";

export const platformKey = (platform = process.platform) => {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
};

export const listFiles = (root, dir = root) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return listFiles(root, path);
    return [relative(root, path).replaceAll("\\", "/")];
  });

export const sha256File = (path) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
};

export const sha256Files = (root, files) => {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    const path = resolve(root, file);
    if (statSync(path).isDirectory()) continue;
    hash.update(file.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
};

export const makeExecutableIfPresent = (path) => {
  if (existsSync(path)) chmodSync(path, 0o755);
};

export const addAsset = ({
  assets,
  id,
  root,
  version,
  executablePaths,
  platform = platformKey(),
  architecture = process.arch
}) => {
  if (!existsSync(root)) return;
  const expectedFiles = listFiles(root);
  if (expectedFiles.length === 0) return;
  for (const path of Object.values(executablePaths)) {
    makeExecutableIfPresent(resolve(root, path));
  }
  assets.push({
    id,
    platform,
    architecture,
    version,
    packagedResourcePath: id,
    sha256: sha256Files(root, expectedFiles),
    expectedFiles,
    executablePaths,
    installPath: id
  });
};

export const writeRuntimeAssetManifest = ({
  runtimeRoot,
  platform = platformKey(),
  architecture = process.arch,
  versions = {}
}) => {
  const assets = [];
  addAsset({
    assets,
    id: "postgres",
    root: resolve(runtimeRoot, "postgres"),
    version: versions.postgres ?? "postgresql-17-pgvector-packaged",
    executablePaths: {
      initdb: "bin/initdb",
      pg_ctl: "bin/pg_ctl",
      psql: "bin/psql",
      pg_config: "bin/pg_config"
    },
    platform,
    architecture
  });
  addAsset({
    assets,
    id: "llama.cpp",
    root: resolve(runtimeRoot, "llama.cpp"),
    version: versions.llamaCpp ?? "llama-server-packaged",
    executablePaths: { llama_server: "llama-server" },
    platform,
    architecture
  });
  if (
    existsSync(
      resolve(runtimeRoot, "embedding-service", ".venv", "bin", "python")
    )
  ) {
    addAsset({
      assets,
      id: "embedding-service",
      root: resolve(runtimeRoot, "embedding-service"),
      version: versions.embeddingService ?? "embedding-service-python-packaged",
      executablePaths: { python: ".venv/bin/python" },
      platform,
      architecture
    });
  }
  if (assets.length === 0) return [];
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    resolve(runtimeRoot, "runtime-asset-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`
  );
  return assets.map((asset) => asset.id);
};
