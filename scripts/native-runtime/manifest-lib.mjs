import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  readSync,
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
  updateHashFromFile(hash, path);
  return hash.digest("hex");
};

const updateHashFromFile = (hash, path) => {
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
};

export const sha256Files = (root, files) => {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    const path = resolve(root, file);
    if (statSync(path).isDirectory()) continue;
    hash.update(file.replaceAll("\\", "/"));
    hash.update("\0");
    updateHashFromFile(hash, path);
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
  variants,
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
    ...(variants?.length ? { variants } : {}),
    installPath: id
  });
};

export const prunePythonEmbeddingRuntimeFiles = (runtimeRoot) => {
  const target = resolve(runtimeRoot, "embedding-service");
  rmSync(resolve(target, ".venv"), { recursive: true, force: true });
  for (const entry of [
    "app.py",
    "auth.py",
    "env_config.py",
    "logging_config.py",
    "priority_scheduler.py",
    "runtime.py",
    "schemas.py",
    "settings.py",
    "vectors.py",
    "requirements.txt",
    "pyproject.toml"
  ]) {
    rmSync(resolve(target, entry), { force: true });
  }
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
    variants: [
      ...(existsSync(resolve(runtimeRoot, "llama.cpp", "cpu", "llama-server"))
        ? [
            {
              backend: "cpu",
              executablePath: "cpu/llama-server",
              requirements: { platform, architecture }
            }
          ]
        : []),
      ...(existsSync(resolve(runtimeRoot, "llama.cpp", "metal", "llama-server"))
        ? [
            {
              backend: "metal",
              executablePath: "metal/llama-server",
              requirements: {
                platform: "macos",
                architecture: "arm64"
              }
            }
          ]
        : []),
      ...(existsSync(resolve(runtimeRoot, "llama.cpp", "cuda", "llama-server"))
        ? [
            {
              backend: "cuda",
              executablePath: "cuda/llama-server",
              requirements: {
                platform: "linux",
                architecture: "x64",
                minimumCudaToolkit: "12.4",
                minimumDriverLinux: "550.54.14",
                discovery: "llama-server --list-devices"
              }
            }
          ]
        : [])
    ],
    platform,
    architecture
  });
  if (assets.length === 0) return [];
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    resolve(runtimeRoot, "runtime-asset-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`
  );
  return assets.map((asset) => asset.id);
};
