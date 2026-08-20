import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  closeSync,
  openSync,
  mkdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";
import { resolvePackagedKoedRuntimeRoot } from "./runtime-artifact-source.js";
import type { RuntimeInstallState } from "./runtime-homebrew.js";

export interface PackagedRuntimeAssetManifestEntry {
  id: string;
  platform: string;
  architecture: string;
  version: string;
  url?: string;
  packagedResourcePath?: string;
  sha256: string;
  expectedFiles: string[];
  executablePaths: Record<string, string>;
  installPath?: string;
  variants?: Array<{
    backend: "cpu" | "metal" | "cuda";
    executablePath: string;
    requirements: {
      platform: string;
      architecture: string;
      minimumCudaToolkit?: string;
      minimumDriverLinux?: string;
      discovery?: string;
    };
  }>;
}

export interface PackagedRuntimeAssetManifest {
  schemaVersion: 1;
  assets: PackagedRuntimeAssetManifestEntry[];
}

export interface PackagedRuntimeAssetValidation {
  ok: boolean;
  executablePermissions: Array<{
    name: string;
    path: string;
    ok: boolean;
  }>;
  commands: Array<{
    name: string;
    command: string;
    ok: boolean;
    message?: string;
  }>;
  loader: Array<{
    command: string;
    ok: boolean;
    skipped?: boolean;
    message?: string;
  }>;
  errors: string[];
}

export interface PackagedRuntimeAssetStatus {
  id: string;
  platform: string;
  architecture: string;
  version: string;
  source: {
    type: "packaged-resource" | "url";
    path?: string;
    url?: string;
  };
  sha256: string;
  expectedFiles: string[];
  executablePaths: Record<string, string>;
  installPath: string;
  state: RuntimeInstallState;
  installed: boolean;
  sourceAvailable: boolean;
  sourceSha256?: string;
  installedSha256?: string;
  validation?: PackagedRuntimeAssetValidation;
  missing?: string[];
}

export interface PackagedRuntimeStatus {
  ok: boolean;
  state: RuntimeInstallState;
  provider: "packaged";
  platform: string;
  architecture: string;
  koedHome: string;
  manifestPath: string;
  packagedRuntimeRoot?: string;
  assets: PackagedRuntimeAssetStatus[];
  message: string;
  action?: string;
}

export interface PackagedRuntimeInstallResult extends PackagedRuntimeStatus {
  copiedPaths: string[];
}

type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawnSync>[2]
) => SpawnSyncReturns<string>;

export interface PackagedRuntimeDependencies {
  platform?: NodeJS.Platform;
  architecture?: NodeJS.Architecture;
  now?: () => Date;
  spawnSync?: SpawnSyncLike;
}

const MANIFEST_FILENAME = "runtime-asset-manifest.json";
const METADATA_FILENAME = "runtime-packaged.json";

const platformKey = (platform: string): string => {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
};

const trim = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeSha256 = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Packaged runtime SHA-256 must be 64 hex characters.");
  }
  return normalized;
};

const isInside = (base: string, child: string): boolean => {
  const rel = relative(resolve(base), resolve(child));
  return rel === "" || (!rel.startsWith("..") && rel !== "..");
};

const safeResolve = (base: string, path: string): string => {
  if (path.includes("\0")) {
    throw new Error(`Packaged runtime path contains NUL byte: ${path}`);
  }
  const resolved = resolve(base, path);
  if (!isInside(base, resolved)) {
    throw new Error(`Packaged runtime path escapes base directory: ${path}`);
  }
  return resolved;
};

const assetFiles = (entry: PackagedRuntimeAssetManifestEntry): string[] =>
  [
    ...new Set([
      ...entry.expectedFiles,
      ...Object.values(entry.executablePaths)
    ])
  ].sort();

const executableModeOk = (path: string): boolean =>
  (statSync(path).mode & 0o111) !== 0;

const updateHashFromFile = (
  hash: ReturnType<typeof createHash>,
  path: string
): void => {
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

const run = (
  command: string,
  args: string[],
  spawnSync: SpawnSyncLike
): SpawnSyncReturns<string> =>
  spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

const commandOutput = (result: SpawnSyncReturns<string>): string =>
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

const postgres17Ok = (output: string): boolean =>
  /PostgreSQL\)?\s+17(?:\.|\s|$)/i.test(output) ||
  /\(PostgreSQL\)\s+17(?:\.|\s|$)/i.test(output);

const collectCommandValidation = (
  installPath: string,
  executablePaths: Record<string, string>,
  spawnSync: SpawnSyncLike
): PackagedRuntimeAssetValidation["commands"] => {
  const commands: PackagedRuntimeAssetValidation["commands"] = [];
  const postgresVersionExecutable =
    executablePaths.pg_config ?? executablePaths.initdb;
  if (postgresVersionExecutable) {
    const command = safeResolve(installPath, postgresVersionExecutable);
    const result = run(command, ["--version"], spawnSync);
    const output = commandOutput(result);
    const ok = result.status === 0 && postgres17Ok(output);
    commands.push({
      name: "postgres-17",
      command,
      ok,
      ...(ok
        ? {}
        : {
            message:
              output || `Postgres version check exited ${result.status ?? 1}`
          })
    });
  }

  const llamaServerExecutable = executablePaths.llama_server;
  if (llamaServerExecutable) {
    const command = safeResolve(installPath, llamaServerExecutable);
    const version = run(command, ["--version"], spawnSync);
    const help =
      version.status === 0 ? version : run(command, ["--help"], spawnSync);
    const output = commandOutput(help);
    const ok = help.status === 0 && /llama|version:|built with/i.test(output);
    commands.push({
      name: "llama-server",
      command,
      ok,
      ...(ok
        ? {}
        : {
            message:
              output || `llama-server validation exited ${help.status ?? 1}`
          })
    });
  }
  return commands;
};

const isShellScript = (path: string): boolean => {
  try {
    return readFileSync(path, "utf8").startsWith("#!");
  } catch {
    return false;
  }
};

const collectLoaderValidation = (
  platform: string,
  executablePaths: Record<string, string>,
  installPath: string,
  spawnSync: SpawnSyncLike
): PackagedRuntimeAssetValidation["loader"] => {
  const tool =
    platform === "darwin" ? "otool" : platform === "linux" ? "ldd" : undefined;
  if (!tool) return [];
  return Object.values(executablePaths).map((relativePath) => {
    const command = safeResolve(installPath, relativePath);
    if (isShellScript(command)) {
      return {
        command,
        ok: true,
        skipped: true,
        message: "loader validation skipped for shell launcher script."
      };
    }
    const result = run(
      tool,
      platform === "darwin" ? ["-L", command] : [command],
      spawnSync
    );
    const output = commandOutput(result);
    if (result.error && result.error.message.includes("ENOENT")) {
      return {
        command,
        ok: true,
        skipped: true,
        message: `${tool} is not available; loader validation skipped.`
      };
    }
    const missing = /not found/i.test(output);
    const ok = result.status === 0 && !missing;
    return {
      command,
      ok,
      ...(ok
        ? {}
        : {
            message: output || `${tool} validation exited ${result.status ?? 1}`
          })
    };
  });
};

const validateInstalledAsset = (
  platform: string,
  installPath: string,
  executablePaths: Record<string, string>,
  spawnSync: SpawnSyncLike
): PackagedRuntimeAssetValidation => {
  const executablePermissions = Object.entries(executablePaths).map(
    ([name, relativePath]) => {
      const path = safeResolve(installPath, relativePath);
      return { name, path, ok: executableModeOk(path) };
    }
  );
  const commands = collectCommandValidation(
    installPath,
    executablePaths,
    spawnSync
  );
  const loader = collectLoaderValidation(
    platform,
    executablePaths,
    installPath,
    spawnSync
  );
  const errors = [
    ...executablePermissions.flatMap((entry) =>
      entry.ok ? [] : [`${entry.name} is not executable (${entry.path})`]
    ),
    ...commands.flatMap((entry) =>
      entry.ok ? [] : [`${entry.name} validation failed: ${entry.message}`]
    ),
    ...loader.flatMap((entry) =>
      entry.ok
        ? []
        : [`loader validation failed for ${entry.command}: ${entry.message}`]
    )
  ];
  return {
    ok: errors.length === 0,
    executablePermissions,
    commands,
    loader,
    errors
  };
};

export const sha256PackagedRuntimeFiles = (
  root: string,
  files: string[]
): string => {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    const absolute = safeResolve(root, file);
    const stat = statSync(absolute);
    if (stat.isDirectory()) continue;
    hash.update(file.replaceAll("\\", "/"));
    hash.update("\0");
    updateHashFromFile(hash, absolute);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const manifestPath = (paths: KoedServerPaths, root?: string): string =>
  root
    ? resolve(root, MANIFEST_FILENAME)
    : resolve(paths.cacheDir, MANIFEST_FILENAME);

const metadataPath = (paths: KoedServerPaths): string =>
  resolve(paths.cacheDir, METADATA_FILENAME);

const readManifest = (
  paths: KoedServerPaths,
  packagedRuntimeRoot?: string
): {
  manifest?: PackagedRuntimeAssetManifest;
  path: string;
  error?: string;
} => {
  const candidates = (
    packagedRuntimeRoot
      ? [manifestPath(paths, packagedRuntimeRoot)]
      : [manifestPath(paths)]
  ).filter((value): value is string => Boolean(value));
  const path = candidates[0] ?? manifestPath(paths);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return {
        manifest: validateManifest(JSON.parse(readFileSync(candidate, "utf8"))),
        path: candidate
      };
    } catch (error) {
      return {
        path: candidate,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return { path, error: "manifest not found" };
};

const validateManifest = (value: unknown): PackagedRuntimeAssetManifest => {
  if (!value || typeof value !== "object") {
    throw new Error("Packaged runtime manifest must be an object.");
  }
  const manifest = value as PackagedRuntimeAssetManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error(
      "Packaged runtime manifest schemaVersion 1 with assets is required."
    );
  }
  for (const asset of manifest.assets) {
    if (!asset.id || !asset.platform || !asset.architecture || !asset.version) {
      throw new Error(
        "Packaged runtime asset requires id, platform, architecture, and version."
      );
    }
    if (!trim(asset.url) && !trim(asset.packagedResourcePath)) {
      throw new Error(
        "Packaged runtime asset requires url or packagedResourcePath."
      );
    }
    normalizeSha256(asset.sha256);
    if (!Array.isArray(asset.expectedFiles)) {
      throw new Error("Packaged runtime asset expectedFiles must be an array.");
    }
    if (!asset.executablePaths || typeof asset.executablePaths !== "object") {
      throw new Error(
        "Packaged runtime asset executablePaths must be an object."
      );
    }
    for (const variant of asset.variants ?? []) {
      if (!["cpu", "metal", "cuda"].includes(variant.backend)) {
        throw new Error("Packaged runtime variant backend is invalid.");
      }
      safeResolve("/runtime", variant.executablePath);
      if (
        !asset.expectedFiles.includes(variant.executablePath) ||
        !variant.requirements?.platform ||
        !variant.requirements.architecture
      ) {
        throw new Error(
          "Packaged runtime variant must reference an expected executable and host requirements."
        );
      }
    }
  }
  return manifest;
};

const linuxCompatibility = (
  platform: string,
  spawnSync: SpawnSyncLike
): { ok: true } | { ok: false; message: string; action: string } => {
  if (platform !== "linux") return { ok: true };
  const result = run("ldd", ["--version"], spawnSync);
  const output = commandOutput(result);
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      message:
        "Linux packaged native runtime requires glibc 2.35+; ldd is unavailable or failed.",
      action:
        "Use Ubuntu 22.04+/Debian 12+ or a WSL Linux distro with glibc 2.35+, or use external dependency mode."
    };
  }
  if (/musl/i.test(output)) {
    return {
      ok: false,
      message:
        "Linux packaged native runtime requires glibc 2.35+ and does not support musl/Alpine hosts.",
      action:
        "Use Ubuntu 22.04+/Debian 12+ or a WSL Linux distro with glibc 2.35+, or use external dependency mode."
    };
  }
  const match = output.match(/(?:glibc|GNU libc|ldd)\D+(\d+)\.(\d+)/i);
  const major = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
  const minor = match ? Number.parseInt(match[2] ?? "", 10) : Number.NaN;
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return {
      ok: false,
      message:
        "Linux packaged native runtime requires glibc 2.35+; could not determine glibc version from ldd.",
      action:
        "Use Ubuntu 22.04+/Debian 12+ or a WSL Linux distro with glibc 2.35+, or use external dependency mode."
    };
  }
  if (major < 2 || (major === 2 && minor < 35)) {
    return {
      ok: false,
      message: `Linux packaged native runtime requires glibc 2.35+; host reports glibc ${major}.${minor}.`,
      action:
        "Use Ubuntu 22.04+/Debian 12+ or a WSL Linux distro with glibc 2.35+, or use external dependency mode."
    };
  }
  return { ok: true };
};

const matchesHost = (
  asset: PackagedRuntimeAssetManifestEntry,
  platform: string,
  architecture: string
): boolean => {
  const hostPlatform = platformKey(platform);
  return (
    (asset.platform === platform || asset.platform === hostPlatform) &&
    asset.architecture === architecture
  );
};

const installRoot = (paths: KoedServerPaths): string =>
  resolve(paths.koedHome, "runtime");

const assetInstallPath = (
  paths: KoedServerPaths,
  asset: PackagedRuntimeAssetManifestEntry
): string => safeResolve(installRoot(paths), asset.installPath ?? asset.id);

const assetSourceRoot = (
  root: string | undefined,
  asset: PackagedRuntimeAssetManifestEntry
): string | undefined =>
  root && asset.packagedResourcePath
    ? safeResolve(root, asset.packagedResourcePath)
    : undefined;

const assetStatus = (
  paths: KoedServerPaths,
  root: string | undefined,
  asset: PackagedRuntimeAssetManifestEntry,
  platform: string,
  spawnSync: SpawnSyncLike,
  knownSourceSha256?: string
): PackagedRuntimeAssetStatus => {
  const expectedSha = normalizeSha256(asset.sha256);
  const sourceRoot = assetSourceRoot(root, asset);
  const targetRoot = assetInstallPath(paths, asset);
  const files = assetFiles(asset);
  const missingSource = sourceRoot
    ? files.filter((file) => !existsSync(safeResolve(sourceRoot, file)))
    : ["packagedResourcePath"];
  const missingInstalled = files.filter(
    (file) => !existsSync(safeResolve(targetRoot, file))
  );
  const sourceSha256 =
    sourceRoot && missingSource.length === 0
      ? (knownSourceSha256 ?? sha256PackagedRuntimeFiles(sourceRoot, files))
      : undefined;
  const installedSha256 =
    missingInstalled.length === 0
      ? sha256PackagedRuntimeFiles(targetRoot, files)
      : undefined;
  const installed = installedSha256 === expectedSha;
  const validation = installed
    ? validateInstalledAsset(
        platform,
        targetRoot,
        asset.executablePaths,
        spawnSync
      )
    : undefined;
  const mismatch =
    (sourceSha256 !== undefined && sourceSha256 !== expectedSha) ||
    (installedSha256 !== undefined && installedSha256 !== expectedSha) ||
    validation?.ok === false;
  return {
    id: asset.id,
    platform: asset.platform,
    architecture: asset.architecture,
    version: asset.version,
    source: asset.packagedResourcePath
      ? { type: "packaged-resource", path: sourceRoot }
      : { type: "url", url: asset.url },
    sha256: expectedSha,
    expectedFiles: asset.expectedFiles,
    executablePaths: asset.executablePaths,
    installPath: targetRoot,
    state:
      installed && validation?.ok !== false
        ? "installed"
        : mismatch
          ? "incompatible"
          : "missing",
    installed: installed && validation?.ok !== false,
    sourceAvailable: missingSource.length === 0,
    sourceSha256,
    installedSha256,
    validation,
    missing: [
      ...missingSource,
      ...missingInstalled,
      ...(validation?.errors ?? [])
    ]
  };
};

const statusFromAssets = (
  paths: KoedServerPaths,
  platform: string,
  architecture: string,
  manifestFile: string,
  root: string | undefined,
  assets: PackagedRuntimeAssetStatus[]
): PackagedRuntimeStatus => {
  const incompatible = assets.some((asset) => asset.state === "incompatible");
  const ok = assets.length > 0 && assets.every((asset) => asset.installed);
  const state: RuntimeInstallState = ok
    ? "installed"
    : incompatible
      ? "incompatible"
      : "missing";
  return {
    ok,
    state,
    provider: "packaged",
    platform: platformKey(platform),
    architecture,
    koedHome: paths.koedHome,
    manifestPath: manifestFile,
    packagedRuntimeRoot: root,
    assets,
    message: ok
      ? "Packaged bundled-local runtime is installed under KOED_HOME."
      : state === "incompatible"
        ? "Packaged bundled-local runtime manifest or installed assets are incompatible."
        : "Packaged bundled-local runtime assets are missing from KOED_HOME/runtime.",
    action: ok
      ? undefined
      : "Run koed-server runtime install --provider packaged --dependency-mode bundled-local --json."
  };
};

const collectPackagedRuntimeStatusInternal = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: PackagedRuntimeDependencies = {},
  knownSourceSha256: ReadonlyMap<string, string> = new Map()
): PackagedRuntimeStatus => {
  const root = resolvePackagedKoedRuntimeRoot(environment);
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  const spawnSync = dependencies.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  const linux = linuxCompatibility(platform, spawnSync);
  if (!linux.ok) {
    return {
      ok: false,
      state: "not_supported",
      provider: "packaged",
      platform: platformKey(platform),
      architecture,
      koedHome: paths.koedHome,
      manifestPath: manifestPath(paths, root),
      packagedRuntimeRoot: root,
      assets: [],
      message: linux.message,
      action: linux.action
    };
  }
  const loaded = readManifest(paths, root);
  if (!loaded.manifest) {
    return {
      ok: false,
      state: "missing",
      provider: "packaged",
      platform: platformKey(platform),
      architecture,
      koedHome: paths.koedHome,
      manifestPath: loaded.path,
      packagedRuntimeRoot: root,
      assets: [],
      message: `Packaged runtime asset manifest is missing or invalid: ${loaded.error ?? "unknown error"}.`,
      action:
        "Ship runtime-asset-manifest.json with packaged runtime resources."
    };
  }
  const matching = loaded.manifest.assets.filter((asset) =>
    matchesHost(asset, platform, architecture)
  );
  if (matching.length === 0) {
    return {
      ok: false,
      state: "incompatible",
      provider: "packaged",
      platform: platformKey(platform),
      architecture,
      koedHome: paths.koedHome,
      manifestPath: loaded.path,
      packagedRuntimeRoot: root,
      assets: [],
      message: `Packaged runtime asset manifest has no assets for ${platformKey(platform)}/${architecture}.`,
      action:
        platform === "linux"
          ? "Ship matching linux/x64 or linux/arm64 packaged assets for a glibc 2.35+ host, or use external dependency mode."
          : "Install Homebrew-backed runtime assets or ship matching packaged assets."
    };
  }
  return statusFromAssets(
    paths,
    platform,
    architecture,
    loaded.path,
    root,
    matching.map((asset) =>
      assetStatus(
        paths,
        root,
        asset,
        platform,
        spawnSync,
        knownSourceSha256.get(asset.id)
      )
    )
  );
};

export const collectPackagedRuntimeStatus = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: PackagedRuntimeDependencies = {}
): PackagedRuntimeStatus =>
  collectPackagedRuntimeStatusInternal(paths, environment, dependencies);

const copyAsset = (
  paths: KoedServerPaths,
  root: string,
  asset: PackagedRuntimeAssetManifestEntry
): string => {
  const source = assetSourceRoot(root, asset);
  if (!source) {
    throw new Error(
      `Packaged runtime asset ${asset.id} has no packagedResourcePath.`
    );
  }
  const target = assetInstallPath(paths, asset);
  const tmpName = `.install-${asset.id.replace(/[^a-zA-Z0-9._-]/g, "_")}-${process.pid}`;
  const tmp = resolve(dirname(target), tmpName);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  rmSync(tmp, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(source, tmp, { recursive: true, preserveTimestamps: true });
  for (const executable of Object.values(asset.executablePaths)) {
    chmodSync(safeResolve(tmp, executable), 0o755);
  }
  renameSync(tmp, target);
  return target;
};

export const installPackagedRuntime = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: PackagedRuntimeDependencies = {}
): PackagedRuntimeInstallResult => {
  const root = resolvePackagedKoedRuntimeRoot(environment);
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  const before = collectPackagedRuntimeStatus(paths, environment, dependencies);
  const sourceChecksumMismatch = before.assets.some(
    (asset) =>
      asset.sourceSha256 !== undefined && asset.sourceSha256 !== asset.sha256
  );
  if (!root || before.assets.length === 0 || sourceChecksumMismatch) {
    return { ...before, copiedPaths: [] };
  }
  const copiedPaths: string[] = [];
  for (const asset of before.assets) {
    if (asset.installed) continue;
    if (!asset.sourceAvailable || asset.sourceSha256 !== asset.sha256) {
      return { ...before, copiedPaths };
    }
    const loaded = readManifest(paths, root);
    const manifestAsset = loaded.manifest?.assets.find(
      (entry) =>
        entry.id === asset.id && matchesHost(entry, platform, architecture)
    );
    if (!manifestAsset) continue;
    copiedPaths.push(copyAsset(paths, root, manifestAsset));
  }
  mkdirSync(paths.cacheDir, { recursive: true, mode: 0o700 });
  cpSync(manifestPath(paths, root), manifestPath(paths));
  writeFileSync(
    metadataPath(paths),
    `${JSON.stringify(
      {
        provider: "packaged",
        installedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        manifestPath: manifestPath(paths),
        packagedRuntimeRoot: root,
        copiedPaths
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  const verifiedSourceSha256 = new Map(
    before.assets.flatMap((asset) =>
      asset.sourceSha256 ? [[asset.id, asset.sourceSha256] as const] : []
    )
  );
  return {
    ...collectPackagedRuntimeStatusInternal(
      paths,
      environment,
      dependencies,
      verifiedSourceSha256
    ),
    copiedPaths
  };
};
