import { createHash, createPublicKey, verify } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";

export const standalonePackageSchemaVersion = 1;
export const standalonePackageId = "koed-server";
export const standalonePackageKind = "app-runtime";
export const packageProvenanceSchemaVersion = 1;

export const requiredPackageRuntimeFiles = [
  "api/dist/index.js",
  "worker/dist/index.js",
  "embedding-service/dist/index.js",
  "mcp-server/dist/cli.js",
  "mcp-server/dist/capture-hook.js",
  "explorer-dist/index.html",
  "api/node_modules/@koed/db/dist/index.js",
  "api/node_modules/@koed/db/drizzle/meta/_journal.json"
];

const excludedPackagePatterns = [
  /^koed-runtime\/postgres(?:\/|$)/,
  /^koed-runtime\/llama\.cpp(?:\/|$)/,
  /^koed-runtime\/runtime-asset-manifest\.json$/,
  /^koed-runtime\/.*\.gguf$/,
  /^koed-runtime\/.*\.safetensors$/,
  /^koed-runtime\/.*\.onnx$/,
  /^koed-runtime\/embedding-service\/\.venv(?:\/|$)/,
  /^koed-runtime\/embedding-service\/.*\.py$/,
  /^koed-runtime\/embedding-service\/requirements\.txt$/,
  /^koed-runtime\/embedding-service\/pyproject\.toml$/
];

const pnpmWorkspaceSelfSymlinkPattern =
  /^(?<root>koed-server|koed-runtime\/api|koed-runtime\/worker|koed-runtime\/embedding-service|koed-runtime\/mcp-server)\/node_modules\/\.pnpm\/node_modules\/@koed\/(?<name>[^/]+)$/;

const packageSelfNames: Record<string, string> = {
  "koed-server": "koed-server",
  "koed-runtime/api": "api",
  "koed-runtime/worker": "worker",
  "koed-runtime/embedding-service": "embedding-service",
  "koed-runtime/mcp-server": "mcp-server"
};

export type ServerPackageState =
  | "missing"
  | "installed"
  | "partial"
  | "incompatible"
  | "failed"
  | "activated"
  | "cleaned";

export interface KoedServerPackageManifest {
  schemaVersion: 1;
  id: "koed-server";
  version: string;
  platform: string;
  architecture: string;
  packageKind: "app-runtime";
  createdAt: string;
  minimumDesktopVersion?: string;
  maximumDesktopMajor?: number;
  nodeRuntime?: {
    mode?: string;
    minimumNodeMajor?: number;
  };
  koedRuntime?: {
    path?: string;
    requiredFiles?: string[];
  };
  database?: {
    migrationSet?: {
      latestMigrationTimestamp?: number;
      journalSha256?: string;
    };
    allowsRollback?: boolean;
  };
  provenance?: {
    sourceRepository?: string | null;
    sourceCommit?: string | null;
    sourceRef?: string | null;
    buildWorkflow?: string | null;
    buildRunId?: string | null;
  };
  sha256?: string;
  files?: Array<{ path: string; sha256: string }>;
}

export interface KoedServerPackageProvenance {
  statement?: {
    schemaVersion?: number;
    subject?: {
      packageKind?: string;
      id?: string;
      version?: string;
      platform?: string;
      architecture?: string;
      archiveName?: string;
      archiveSha256?: string;
      manifestName?: string;
      manifestSha256?: string;
      packageSha256?: string;
    };
    source?: {
      repository?: string | null;
      commit?: string | null;
      ref?: string | null;
    };
    build?: {
      workflow?: string | null;
      runId?: string | null;
      createdAt?: string;
    };
    integrity?: {
      archiveAlgorithm?: string;
      manifestAlgorithm?: string;
      signatureAlgorithm?: string;
    };
  };
  signature?: {
    status?: "signed" | "unsigned-placeholder";
    algorithm?: "ed25519";
    value?: string | null;
    reason?: string;
  };
}

export interface PackageRootValidation {
  ok: boolean;
  packageRoot: string;
  manifestPath: string;
  manifest: KoedServerPackageManifest | null;
  version?: string;
  errors: string[];
}

export interface KoedServerPackageManifestSummary {
  schemaVersion?: number;
  id?: string;
  version?: string;
  platform?: string;
  architecture?: string;
  packageKind?: string;
  createdAt?: string;
  minimumDesktopVersion?: string;
  maximumDesktopMajor?: number;
  nodeRuntime?: KoedServerPackageManifest["nodeRuntime"];
  koedRuntime?: KoedServerPackageManifest["koedRuntime"];
  database?: KoedServerPackageManifest["database"];
  provenance?: KoedServerPackageManifest["provenance"];
  sha256?: string;
  fileCount: number;
}

export interface InstalledServerPackage {
  version: string;
  path: string;
  ok: boolean;
  active: boolean;
  manifest: KoedServerPackageManifestSummary | null;
  errors: string[];
}

export interface ServerPackageStatus {
  ok: boolean;
  state: ServerPackageState;
  koedHome: string;
  packageRoot: string;
  versionsDir: string;
  cacheDir: string;
  currentPath: string;
  currentVersion?: string;
  currentTarget?: string;
  installed: InstalledServerPackage[];
  message: string;
  action?: string;
  errors?: string[];
}

export interface ServerPackageInstallOptions {
  source: string;
  sha256?: string;
  sha256File?: string;
  activate?: boolean;
  provenanceFile?: string;
  signatureFile?: string;
  trustedPublicKey?: string;
  trustedPublicKeyFile?: string;
  trustPolicy?: "sha256-only" | "require-provenance" | "require-signature";
  allowDowngrade?: boolean;
}

export interface ServerPackageInstallResult extends ServerPackageStatus {
  archivePath?: string;
  archiveSha256?: string;
  installedPath?: string;
  provenance?: {
    status: "not_checked" | "verified" | "unsigned-placeholder";
    policy: NonNullable<ServerPackageInstallOptions["trustPolicy"]>;
    source?: string;
  };
}

export interface ServerPackageActivateResult extends ServerPackageStatus {
  activatedVersion?: string;
}

export interface ServerPackageCleanupResult extends ServerPackageStatus {
  removedVersions: string[];
  removedCacheEntries: string[];
}

const platformKey = (platform = process.platform): string => {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
};

const normalizeSha256 = (value: string): string => {
  const normalized = value.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Package SHA-256 must be 64 hex characters.");
  }
  return normalized;
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const validatePackageVersion = (version: string): string => {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new Error(
      "Package version must be a safe filename segment containing only letters, numbers, dots, underscores, plus signs, or hyphens."
    );
  }
  if (version === "." || version === ".." || version.includes("..")) {
    throw new Error("Package version must not contain path traversal.");
  }
  return version;
};

const isInside = (base: string, child: string): boolean => {
  const rel = relative(resolve(base), resolve(child));
  return rel === "" || (!rel.startsWith("..") && rel !== "..");
};

const safeResolve = (base: string, path: string): string => {
  if (path.includes("\0")) {
    throw new Error(`Package path contains NUL byte: ${path}`);
  }
  const resolved = resolve(base, path);
  if (!isInside(base, resolved)) {
    throw new Error(`Package path escapes base directory: ${path}`);
  }
  return resolved;
};

const packageRoot = (paths: KoedServerPaths): string =>
  resolve(paths.koedHome, "runtime", "koed-server");

const packageVersionsDir = (paths: KoedServerPaths): string =>
  resolve(packageRoot(paths), "versions");

const packageCacheDir = (paths: KoedServerPaths): string =>
  resolve(paths.cacheDir, "koed-server-packages");

const packageCurrentPath = (paths: KoedServerPaths): string =>
  resolve(packageRoot(paths), "current");

const isPnpmWorkspaceSelfSymlink = (path: string): boolean => {
  const match = path.match(pnpmWorkspaceSelfSymlinkPattern);
  if (!match?.groups) return false;
  const { name, root } = match.groups;
  return Boolean(root && name && name === packageSelfNames[root]);
};

const listFiles = (root: string, dir = root): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (isPnpmWorkspaceSelfSymlink(relativePath)) return [];
    if (entry.isDirectory()) return listFiles(root, path);
    return [relativePath];
  });

export const sha256File = (path: string): string => {
  const hash = createHash("sha256");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    hash.update("symlink");
    hash.update("\0");
    hash.update(readlinkSync(path));
  } else {
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
};

const sha256Files = (root: string, files: string[]): string => {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    const path = resolve(root, file);
    const stat = lstatSync(path);
    if (stat.isDirectory()) continue;
    hash.update(file.replaceAll("\\", "/"));
    hash.update("\0");
    if (stat.isSymbolicLink()) {
      hash.update("symlink");
      hash.update("\0");
      hash.update(readlinkSync(path));
    } else {
      hash.update(readFileSync(path));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
};

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

const compareVersions = (a: string, b: string): number => {
  const numberPart = (part: string): number =>
    /^\d+$/.test(part) ? Number.parseInt(part, 10) : 0;
  const left = a.split(/[.-]/).map(numberPart);
  const right = b.split(/[.-]/).map(numberPart);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return a.localeCompare(b);
};

const validateManifestShape = (
  manifest: KoedServerPackageManifest | null
): string[] => {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") {
    return ["Package manifest must be an object."];
  }
  if (manifest.schemaVersion !== standalonePackageSchemaVersion) {
    errors.push("Package manifest schemaVersion must be 1.");
  }
  if (manifest.id !== standalonePackageId) {
    errors.push("Package manifest id must be koed-server.");
  }
  if (manifest.packageKind !== standalonePackageKind) {
    errors.push("Package manifest packageKind must be app-runtime.");
  }
  for (const key of [
    "version",
    "platform",
    "architecture",
    "createdAt"
  ] as const) {
    const value = manifest[key];
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`Package manifest ${key} must be a non-empty string.`);
    }
  }
  if (typeof manifest.version === "string" && manifest.version.length > 0) {
    try {
      validatePackageVersion(manifest.version);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (manifest.koedRuntime?.path !== "koed-runtime") {
    errors.push("Package manifest koedRuntime.path must be koed-runtime.");
  }
  if (!Array.isArray(manifest.koedRuntime?.requiredFiles)) {
    errors.push("Package manifest koedRuntime.requiredFiles must be an array.");
  }
  if (!Array.isArray(manifest.files)) {
    errors.push("Package manifest files must be an array.");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256 ?? "")) {
    errors.push("Package manifest sha256 must be 64 hex characters.");
  }
  if (!manifest.database || typeof manifest.database !== "object") {
    errors.push("Package manifest database must be an object.");
  }
  if (!manifest.provenance || typeof manifest.provenance !== "object") {
    errors.push("Package manifest provenance must be an object.");
  }
  return errors;
};

const validateCompatibility = (
  manifest: KoedServerPackageManifest | null,
  platform = platformKey(),
  architecture = process.arch,
  nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10)
): string[] => {
  if (!manifest) return [];
  const errors: string[] = [];
  if (manifest.platform !== platform) {
    errors.push(
      `Package platform ${manifest.platform} is incompatible with ${platform}.`
    );
  }
  if (manifest.architecture !== architecture) {
    errors.push(
      `Package architecture ${manifest.architecture} is incompatible with ${architecture}.`
    );
  }
  const minimumNodeMajor = manifest.nodeRuntime?.minimumNodeMajor;
  if (
    typeof minimumNodeMajor === "number" &&
    Number.isFinite(minimumNodeMajor) &&
    nodeMajor < minimumNodeMajor
  ) {
    errors.push(
      `Package requires Node ${minimumNodeMajor} or newer; current Node major is ${nodeMajor}.`
    );
  }
  return errors;
};

export const validateServerPackageRoot = (
  root: string
): PackageRootValidation => {
  const resolvedRoot = resolve(root);
  const manifestPath = resolve(
    resolvedRoot,
    "koed-server-package-manifest.json"
  );
  const manifest = existsSync(manifestPath)
    ? readJson<KoedServerPackageManifest>(manifestPath)
    : null;
  const manifestErrors = validateManifestShape(manifest);
  const runtimePath = manifest?.koedRuntime?.path ?? "koed-runtime";
  const runtimeRoot = resolve(resolvedRoot, runtimePath);
  const requiredFiles = Array.isArray(manifest?.koedRuntime?.requiredFiles)
    ? manifest.koedRuntime.requiredFiles
    : requiredPackageRuntimeFiles;
  const missing = [
    !existsSync(manifestPath) ? "koed-server-package-manifest.json" : null,
    !existsSync(resolve(resolvedRoot, "README.txt")) ? "README.txt" : null,
    !existsSync(resolve(resolvedRoot, "bin", "koed-server"))
      ? "bin/koed-server"
      : null,
    !existsSync(resolve(resolvedRoot, "koed-server", "dist", "cli.js"))
      ? "koed-server/dist/cli.js"
      : null,
    ...requiredFiles.map((file) =>
      existsSync(resolve(runtimeRoot, file)) ? null : `${runtimePath}/${file}`
    )
  ].filter((file): file is string => Boolean(file));
  const files = existsSync(resolvedRoot) ? listFiles(resolvedRoot) : [];
  const excluded = files.filter((file) =>
    excludedPackagePatterns.some((pattern) => pattern.test(file))
  );
  const actualFiles = files.filter(
    (file) => file !== "koed-server-package-manifest.json"
  );
  const actualSha256 =
    existsSync(resolvedRoot) && actualFiles.length > 0
      ? sha256Files(resolvedRoot, actualFiles)
      : undefined;
  const manifestFileErrors = Array.isArray(manifest?.files)
    ? manifest.files.flatMap((entry) => {
        if (
          !entry ||
          typeof entry.path !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
        ) {
          return ["Package manifest files entries require path and sha256."];
        }
        const path = safeResolve(resolvedRoot, entry.path);
        if (!existsSync(path))
          return [`Manifest file is missing: ${entry.path}`];
        const actual = sha256File(path);
        return actual === entry.sha256
          ? []
          : [`Manifest file SHA-256 mismatch: ${entry.path}`];
      })
    : [];
  const shaErrors =
    manifest?.sha256 && actualSha256 && manifest.sha256 !== actualSha256
      ? ["Package manifest sha256 does not match package files."]
      : [];
  const compatibilityErrors = validateCompatibility(manifest);
  const errors = [
    ...manifestErrors,
    ...missing.map((file) => `Missing required package file: ${file}`),
    ...excluded.map((file) => `Excluded file is present: ${file}`),
    ...manifestFileErrors,
    ...shaErrors,
    ...compatibilityErrors
  ];
  return {
    ok: errors.length === 0,
    packageRoot: resolvedRoot,
    manifestPath,
    manifest,
    version: manifest?.version,
    errors
  };
};

const summarizeManifest = (
  manifest: KoedServerPackageManifest | null
): KoedServerPackageManifestSummary | null => {
  if (!manifest) return null;
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    platform: manifest.platform,
    architecture: manifest.architecture,
    packageKind: manifest.packageKind,
    createdAt: manifest.createdAt,
    ...(manifest.minimumDesktopVersion
      ? { minimumDesktopVersion: manifest.minimumDesktopVersion }
      : {}),
    ...(manifest.maximumDesktopMajor !== undefined
      ? { maximumDesktopMajor: manifest.maximumDesktopMajor }
      : {}),
    ...(manifest.nodeRuntime ? { nodeRuntime: manifest.nodeRuntime } : {}),
    ...(manifest.koedRuntime ? { koedRuntime: manifest.koedRuntime } : {}),
    ...(manifest.database ? { database: manifest.database } : {}),
    ...(manifest.provenance ? { provenance: manifest.provenance } : {}),
    ...(manifest.sha256 ? { sha256: manifest.sha256 } : {}),
    fileCount: manifest.files?.length ?? 0
  };
};

const readCurrentTarget = (paths: KoedServerPaths): string | undefined => {
  const current = packageCurrentPath(paths);
  if (!existsSync(current)) return undefined;
  const stat = lstatSync(current);
  return stat.isSymbolicLink()
    ? resolve(dirname(current), readlinkSync(current))
    : current;
};

export const collectServerPackageStatus = (
  paths: KoedServerPaths
): ServerPackageStatus => {
  const root = packageRoot(paths);
  const versionsDir = packageVersionsDir(paths);
  const cacheDir = packageCacheDir(paths);
  const currentPath = packageCurrentPath(paths);
  const currentTarget = readCurrentTarget(paths);
  const versionNames = existsSync(versionsDir)
    ? readdirSync(versionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  const installed = versionNames.map((version) => {
    const path = resolve(versionsDir, version);
    const validation = validateServerPackageRoot(path);
    return {
      version,
      path,
      ok: validation.ok,
      active: currentTarget === path,
      manifest: summarizeManifest(validation.manifest),
      errors: validation.errors
    };
  });
  const active = installed.find((entry) => entry.active);
  const invalid = installed.filter((entry) => !entry.ok);
  const currentVersion = active?.version;
  const state: ServerPackageState =
    installed.length === 0
      ? "missing"
      : active && active.ok && invalid.length === 0
        ? "installed"
        : active && !active.ok
          ? "incompatible"
          : "partial";
  return {
    ok: state === "installed",
    state,
    koedHome: paths.koedHome,
    packageRoot: root,
    versionsDir,
    cacheDir,
    currentPath,
    ...(currentVersion ? { currentVersion } : {}),
    ...(currentTarget ? { currentTarget } : {}),
    installed,
    message:
      state === "installed"
        ? `koed-server package ${currentVersion} is active.`
        : state === "missing"
          ? "No koed-server package is installed."
          : "koed-server package installation needs attention.",
    ...(state === "missing"
      ? {
          action:
            "Run koed-server package install --source <artifact> --sha256 <sha256>."
        }
      : {}),
    ...(invalid.length > 0
      ? { errors: invalid.flatMap((entry) => entry.errors) }
      : {})
  };
};

const readExpectedSha256 = (options: ServerPackageInstallOptions): string => {
  if (options.sha256) return normalizeSha256(options.sha256);
  if (options.sha256File) {
    return normalizeSha256(readFileSync(options.sha256File, "utf8"));
  }
  throw new Error("--sha256 or --sha256-file is required.");
};

const adjacentProvenancePath = (archivePath: string): string | undefined => {
  const archiveName = basename(archivePath);
  const releaseName = archiveName
    .replace(/^koed-server-/, "koed-server-app-runtime-")
    .replace(/\.tar\.gz$/, ".provenance.json");
  const candidates = [
    `${archivePath}.provenance.json`,
    archivePath.replace(/\.tar\.gz$/, ".provenance.json"),
    resolve(dirname(archivePath), releaseName)
  ];
  return candidates.find((candidate) => existsSync(candidate));
};

const readTrustedPublicKey = (
  options: ServerPackageInstallOptions
): string | undefined => {
  if (options.trustedPublicKey) return options.trustedPublicKey;
  if (options.trustedPublicKeyFile) {
    return readFileSync(options.trustedPublicKeyFile, "utf8");
  }
  return process.env.KOED_SERVER_PACKAGE_TRUSTED_PUBLIC_KEY_PEM;
};

const verifyProvenanceSignature = ({
  provenance,
  signature,
  publicKey
}: {
  provenance: KoedServerPackageProvenance;
  signature: string;
  publicKey: string;
}): void => {
  if (provenance.signature?.algorithm !== "ed25519") {
    throw new Error("Package provenance signature algorithm must be ed25519.");
  }
  const key = createPublicKey(publicKey);
  const payload = Buffer.from(canonicalJson(provenance.statement), "utf8");
  const ok = verify(null, payload, key, Buffer.from(signature, "base64"));
  if (!ok) {
    throw new Error("Package provenance signature verification failed.");
  }
};

const validatePackageProvenance = ({
  options,
  archivePath,
  archiveSha256,
  manifest
}: {
  options: ServerPackageInstallOptions;
  archivePath: string;
  archiveSha256: string;
  manifest: KoedServerPackageManifest;
}): ServerPackageInstallResult["provenance"] => {
  const policy = options.trustPolicy ?? "sha256-only";
  const provenancePath =
    options.provenanceFile ?? adjacentProvenancePath(archivePath);
  const publicKey = readTrustedPublicKey(options);
  if (!provenancePath) {
    if (policy === "sha256-only" && !publicKey) {
      return { status: "not_checked", policy };
    }
    throw new Error("Package provenance metadata is required.");
  }
  const provenance = readJson<KoedServerPackageProvenance>(provenancePath);
  const statement = provenance.statement;
  if (statement?.schemaVersion !== packageProvenanceSchemaVersion) {
    throw new Error("Package provenance schemaVersion must be 1.");
  }
  const subject = statement.subject;
  if (
    subject?.id !== manifest.id ||
    subject.packageKind !== manifest.packageKind
  ) {
    throw new Error("Package provenance subject does not match manifest.");
  }
  if (
    subject.version !== manifest.version ||
    subject.platform !== manifest.platform ||
    subject.architecture !== manifest.architecture
  ) {
    throw new Error(
      "Package provenance version target does not match manifest."
    );
  }
  if (subject.archiveSha256 !== archiveSha256) {
    throw new Error("Package provenance archive SHA-256 does not match.");
  }
  if (subject.packageSha256 !== manifest.sha256) {
    throw new Error("Package provenance package SHA-256 does not match.");
  }
  const inlineSignature = provenance.signature?.value ?? undefined;
  const signaturePath =
    options.signatureFile ??
    (existsSync(`${provenancePath}.sig`) ? `${provenancePath}.sig` : undefined);
  const signature = signaturePath
    ? readFileSync(signaturePath, "utf8").trim()
    : inlineSignature;
  if (publicKey) {
    if (!signature) {
      throw new Error("Package provenance signature is required.");
    }
    verifyProvenanceSignature({ provenance, signature, publicKey });
    return { status: "verified", policy, source: provenancePath };
  }
  if (policy === "require-signature") {
    throw new Error("Package signature trust root is required.");
  }
  if (provenance.signature?.status === "unsigned-placeholder") {
    return { status: "unsigned-placeholder", policy, source: provenancePath };
  }
  return { status: "not_checked", policy, source: provenancePath };
};

const activePackageManifest = (
  paths: KoedServerPaths
): KoedServerPackageManifest | null => {
  const target = readCurrentTarget(paths);
  if (!target) return null;
  const validation = validateServerPackageRoot(target);
  return validation.ok ? validation.manifest : null;
};

const migrationTimestamp = (
  manifest: KoedServerPackageManifest | null
): number | undefined => {
  const value = manifest?.database?.migrationSet?.latestMigrationTimestamp;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const assertUpgradeCompatible = ({
  paths,
  nextManifest,
  allowDowngrade = false
}: {
  paths: KoedServerPaths;
  nextManifest: KoedServerPackageManifest;
  allowDowngrade?: boolean;
}): void => {
  const currentManifest = activePackageManifest(paths);
  if (!currentManifest?.version) return;
  if (compareVersions(nextManifest.version, currentManifest.version) < 0) {
    if (!allowDowngrade) {
      throw new Error(
        `Installing koed-server ${nextManifest.version} over active ${currentManifest.version} is a downgrade and requires --allow-downgrade.`
      );
    }
    const currentMigration = migrationTimestamp(currentManifest);
    const nextMigration = migrationTimestamp(nextManifest);
    if (
      currentMigration !== undefined &&
      nextMigration !== undefined &&
      nextMigration < currentMigration &&
      nextManifest.database?.allowsRollback !== true
    ) {
      throw new Error(
        "Downgrade would roll back the package migration set, and the target package does not allow rollback."
      );
    }
  }
};

const copyAdjacentProvenanceSidecars = (
  sourcePath: string,
  targetPath: string
): void => {
  const provenancePath = adjacentProvenancePath(sourcePath);
  if (!provenancePath) return;
  const targetProvenancePath = resolve(
    dirname(targetPath),
    basename(provenancePath)
  );
  if (provenancePath !== targetProvenancePath) {
    cpSync(provenancePath, targetProvenancePath);
  }
  const signaturePath = `${provenancePath}.sig`;
  if (!existsSync(signaturePath)) return;
  const targetSignaturePath = `${targetProvenancePath}.sig`;
  if (signaturePath !== targetSignaturePath) {
    cpSync(signaturePath, targetSignaturePath);
  }
};

const copyOrDownloadArchive = async (
  source: string,
  cacheDir: string
): Promise<string> => {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Package download failed with HTTP ${response.status}.`);
    }
    const target = resolve(cacheDir, basename(new URL(source).pathname));
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    return target;
  }
  const sourcePath = resolve(source);
  const target = resolve(cacheDir, basename(sourcePath));
  if (sourcePath !== target) {
    cpSync(sourcePath, target);
  }
  copyAdjacentProvenanceSidecars(sourcePath, target);
  return target;
};

const tarString = (buffer: Buffer, start: number, length: number): string =>
  buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "");

const tarNumber = (buffer: Buffer, start: number, length: number): number => {
  const value = tarString(buffer, start, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
};

const extractTarGz = (archivePath: string, destination: string): void => {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const buffer = gunzipSync(readFileSync(archivePath));
  let offset = 0;
  let pax: Record<string, string> = {};
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const type = tarString(header, 156, 1) || "0";
    const size = tarNumber(header, 124, 12);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const rawPath = pax.path ?? (prefix ? `${prefix}/${name}` : name);
    const linkPath = pax.linkpath ?? tarString(header, 157, 100);
    const content = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = Object.fromEntries(
        content
          .toString("utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const body = line.replace(/^\d+\s/, "");
            const index = body.indexOf("=");
            return [body.slice(0, index), body.slice(index + 1)];
          })
      );
      continue;
    }
    const target = safeResolve(destination, rawPath);
    if (type === "5") {
      mkdirSync(target, { recursive: true, mode: 0o755 });
    } else if (type === "2") {
      void linkPath;
      throw new Error("Package archives must not contain symbolic links.");
    } else if (type === "0" || type === "") {
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      writeFileSync(target, content);
      chmodSync(target, tarNumber(header, 100, 8) || 0o644);
    }
    pax = {};
  }
};

const findExtractedPackageRoot = (extractDir: string): string => {
  const entries = readdirSync(extractDir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory()
  );
  if (entries.length !== 1) {
    throw new Error("Package archive must contain exactly one root directory.");
  }
  return resolve(extractDir, entries[0]!.name);
};

const activateVersion = (
  paths: KoedServerPaths,
  version: string,
  options: { allowDowngrade?: boolean } = {}
): ServerPackageActivateResult => {
  const versionsDir = packageVersionsDir(paths);
  const safeVersion = validatePackageVersion(version);
  const target = safeResolve(versionsDir, safeVersion);
  const validation = validateServerPackageRoot(target);
  if (!validation.ok) {
    throw new Error(validation.errors.join(" "));
  }
  if (!validation.manifest) {
    throw new Error("Package manifest is required.");
  }
  assertUpgradeCompatible({
    paths,
    nextManifest: validation.manifest,
    allowDowngrade: options.allowDowngrade
  });
  const current = packageCurrentPath(paths);
  mkdirSync(dirname(current), { recursive: true, mode: 0o700 });
  const tempLink = resolve(
    dirname(current),
    `.current-${process.pid}-${Date.now()}`
  );
  rmSync(tempLink, { force: true, recursive: true });
  symlinkSync(relative(dirname(current), target), tempLink, "dir");
  renameSync(tempLink, current);
  const status = collectServerPackageStatus(paths);
  return {
    ...status,
    ok: true,
    state: "activated",
    activatedVersion: safeVersion,
    message: `koed-server package ${safeVersion} activated.`
  };
};

export const installServerPackage = async (
  paths: KoedServerPaths,
  options: ServerPackageInstallOptions
): Promise<ServerPackageInstallResult> => {
  const expectedSha256 = readExpectedSha256(options);
  const cacheDir = packageCacheDir(paths);
  const archivePath = await copyOrDownloadArchive(options.source, cacheDir);
  const actualSha256 = sha256File(archivePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error("Package archive SHA-256 mismatch.");
  }
  const root = packageRoot(paths);
  const versionsDir = packageVersionsDir(paths);
  mkdirSync(versionsDir, { recursive: true, mode: 0o700 });
  const extractDir = resolve(root, `.install-${process.pid}-${Date.now()}`);
  rmSync(extractDir, { recursive: true, force: true });
  try {
    extractTarGz(archivePath, extractDir);
    const extractedRoot = findExtractedPackageRoot(extractDir);
    const validation = validateServerPackageRoot(extractedRoot);
    if (!validation.ok || !validation.version) {
      throw new Error(validation.errors.join(" "));
    }
    if (!validation.manifest) {
      throw new Error("Package manifest is required.");
    }
    assertUpgradeCompatible({
      paths,
      nextManifest: validation.manifest,
      allowDowngrade: options.allowDowngrade
    });
    const provenanceValidation = validatePackageProvenance({
      options,
      archivePath,
      archiveSha256: actualSha256,
      manifest: validation.manifest
    });
    const safeVersion = validatePackageVersion(validation.version);
    const target = safeResolve(versionsDir, safeVersion);
    const tempTarget = resolve(
      versionsDir,
      `.${safeVersion}-${process.pid}-${Date.now()}`
    );
    rmSync(tempTarget, { recursive: true, force: true });
    renameSync(extractedRoot, tempTarget);
    rmSync(target, { recursive: true, force: true });
    renameSync(tempTarget, target);
    rmSync(extractDir, { recursive: true, force: true });
    const status = options.activate
      ? activateVersion(paths, validation.version, {
          allowDowngrade: options.allowDowngrade
        })
      : collectServerPackageStatus(paths);
    return {
      ...status,
      ok: true,
      state: options.activate ? "activated" : "installed",
      archivePath,
      archiveSha256: actualSha256,
      installedPath: target,
      provenance: provenanceValidation,
      message: options.activate
        ? `koed-server package ${safeVersion} installed and activated.`
        : `koed-server package ${safeVersion} installed.`
    };
  } catch (error) {
    rmSync(extractDir, { recursive: true, force: true });
    throw error;
  }
};

export const activateServerPackage = (
  paths: KoedServerPaths,
  version: string,
  options: { allowDowngrade?: boolean } = {}
): ServerPackageActivateResult => activateVersion(paths, version, options);

const compareVersionsDesc = (a: string, b: string): number => {
  const left = a.split(".").map((part) => Number.parseInt(part, 10));
  const right = b.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] ?? 0) - (left[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
};

export const cleanupServerPackages = (
  paths: KoedServerPaths,
  keep = 1
): ServerPackageCleanupResult => {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error("--keep must be a non-negative integer.");
  }
  const status = collectServerPackageStatus(paths);
  const activeVersion = status.currentVersion;
  const inactive = status.installed
    .filter((entry) => entry.version !== activeVersion)
    .map((entry) => entry.version)
    .sort(compareVersionsDesc);
  const retained = new Set(inactive.slice(0, keep));
  const removedVersions: string[] = [];
  for (const version of inactive) {
    if (retained.has(version)) continue;
    rmSync(
      safeResolve(packageVersionsDir(paths), validatePackageVersion(version)),
      {
        recursive: true,
        force: true
      }
    );
    removedVersions.push(version);
  }

  const removedCacheEntries: string[] = [];
  const cacheDir = packageCacheDir(paths);
  if (existsSync(cacheDir)) {
    for (const entry of readdirSync(cacheDir)) {
      const path = resolve(cacheDir, entry);
      const keepCache =
        activeVersion && entry.includes(activeVersion)
          ? true
          : [...retained].some((version) => entry.includes(version));
      if (!keepCache) {
        rmSync(path, { recursive: true, force: true });
        removedCacheEntries.push(path);
      }
    }
  }
  const next = collectServerPackageStatus(paths);
  return {
    ...next,
    ok: true,
    state: "cleaned",
    removedVersions,
    removedCacheEntries,
    message: `Removed ${removedVersions.length} inactive package version(s) and ${removedCacheEntries.length} cached package artifact(s).`
  };
};
