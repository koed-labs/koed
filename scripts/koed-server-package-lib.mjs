import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { assertNoClaudeAgentSdkPlatformRuntimes } from "./provider-runtime-package-policy.mjs";

export const standalonePackageSchemaVersion = 2;
export const standalonePackageId = "koed-server";
export const standalonePackageKind = "app-runtime";
export const packageProvenanceSchemaVersion = 1;

export const requiredRuntimeFiles = [
  "api/dist/index.js",
  "node_modules/@koed/api/dist/browser-approval/index.html",
  "worker/dist/index.js",
  "embedding-service/dist/index.js",
  "privacy-service/dist/index.js",
  "mcp-server/dist/cli.js",
  "mcp-server/dist/capture-hook.js",
  "mcp-server/dist/prompts/codex-global-agent-guidance.md",
  "node_modules/@koed/db/dist/index.js",
  "node_modules/@koed/db/dist/connection.js",
  "node_modules/@koed/db/dist/user-api-token-repository.js",
  "node_modules/@koed/db/drizzle/meta/_journal.json"
];

export const excludedPackagePatterns = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)node_modules\/\.pnpm\/lock\.yaml$/,
  /(^|\/)node_modules\/\.pnpm\/@koed\+[^/]*@file\+[^/]*(?:\/|$)/,
  /(^|\/)\.claude(?:\/|$)/,
  /^koed-runtime\/explorer-dist(?:\/|$)/,
  /^koed-server\/dist\/explorer-static-(?:proxy|server)(?:\.|$)/,
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

export const pruneStandalonePackageMetadata = (root, directory = root) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name === ".claude") {
      rmSync(path, { recursive: true, force: false });
      continue;
    }
    if (entry.isDirectory()) {
      pruneStandalonePackageMetadata(root, path);
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name === "pnpm-lock.yaml" ||
        (entry.name === "lock.yaml" && directory.endsWith("/.pnpm")))
    ) {
      rmSync(path, { force: false });
    }
  }
};

export const prunePnpmWorkspaceVirtualStorePaths = (root, directory = root) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (
      entry.isDirectory() &&
      directory.endsWith("/.pnpm") &&
      /^@koed\+[^/]*@file\+/.test(entry.name)
    ) {
      rmSync(path, { recursive: true, force: false });
      continue;
    }
    if (entry.isDirectory()) {
      prunePnpmWorkspaceVirtualStorePaths(root, path);
    }
  }
};

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];

export const normalizeDeployedWorkspaceDependencies = (manifestPath) => {
  const manifest = readJson(manifestPath);
  let changed = false;
  for (const section of dependencySections) {
    const dependencies = manifest[section];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const [name, version] of Object.entries(dependencies)) {
      if (!name.startsWith("@koed/") || !String(version).includes("@file:")) {
        continue;
      }
      const dependencyManifest = readJson(
        resolve(dirname(manifestPath), "node_modules", name, "package.json")
      );
      if (
        dependencyManifest.name !== name ||
        typeof dependencyManifest.version !== "string" ||
        dependencyManifest.version.length === 0
      ) {
        throw new Error(
          `Deployed workspace dependency metadata is invalid for ${name} in ${manifestPath}.`
        );
      }
      dependencies[name] = dependencyManifest.version;
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return changed;
};

const deployedManifestPaths = [
  "koed-server/package.json",
  "koed-runtime/api/package.json",
  "koed-runtime/worker/package.json",
  "koed-runtime/embedding-service/package.json",
  "koed-runtime/mcp-server/package.json"
];

const deployedManifestFileDependencyErrors = (root) =>
  deployedManifestPaths.flatMap((relativePath) => {
    const path = resolve(root, relativePath);
    if (!existsSync(path)) return [];
    const manifest = readJson(path);
    return dependencySections.flatMap((section) =>
      Object.entries(manifest[section] ?? {}).flatMap(([name, version]) =>
        String(version).includes("file:")
          ? [
              `Deployed package dependency uses a file reference: ${relativePath} ${section}.${name}`
            ]
          : []
      )
    );
  });

const pnpmWorkspaceSelfSymlinkPattern =
  /^(?<root>koed-server|koed-runtime\/api|koed-runtime\/worker|koed-runtime\/embedding-service|koed-runtime\/privacy-service|koed-runtime\/mcp-server)\/node_modules\/\.pnpm\/node_modules\/@koed\/(?<name>[^/]+)$/;

const packageSelfNames = {
  "koed-server": "koed-server",
  "koed-runtime/api": "api",
  "koed-runtime/worker": "worker",
  "koed-runtime/embedding-service": "embedding-service",
  "koed-runtime/privacy-service": "privacy-service",
  "koed-runtime/mcp-server": "mcp-server"
};

export const isPnpmWorkspaceSelfSymlink = (path) => {
  const match = path.match(pnpmWorkspaceSelfSymlinkPattern);
  if (!match?.groups) return false;
  return match.groups.name === packageSelfNames[match.groups.root];
};

export const platformKey = (platform = process.platform) => {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
};

export const listFiles = (root, dir = root) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (isPnpmWorkspaceSelfSymlink(relativePath)) return [];
    if (entry.isDirectory()) return listFiles(root, path);
    return [relativePath];
  });

export const sha256File = (path) => {
  const hash = createHash("sha256");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    hash.update("symlink");
    hash.update("\0");
    hash.update(readlinkSync(path));
    return hash.digest("hex");
  }
  hash.update(readFileSync(path));
  return hash.digest("hex");
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const sha256Files = (root, files) => {
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

export const fileEntries = (root, files) =>
  [...new Set(files)].sort().map((path) => ({
    path,
    sha256: sha256File(resolve(root, path))
  }));

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export const readPackageVersion = (repoRoot, packagePath) =>
  readJson(resolve(repoRoot, packagePath)).version;

export const readMigrationSet = (runtimeRoot) => {
  const legacyJournalPath = resolve(
    runtimeRoot,
    "api",
    "node_modules",
    "@koed",
    "db",
    "drizzle",
    "meta",
    "_journal.json"
  );
  const sharedJournalPath = resolve(
    runtimeRoot,
    "node_modules",
    "@koed",
    "db",
    "drizzle",
    "meta",
    "_journal.json"
  );
  const journalPath = existsSync(legacyJournalPath)
    ? legacyJournalPath
    : sharedJournalPath;
  const text = readFileSync(journalPath, "utf8");
  const hash = createHash("sha256").update(text).digest("hex");
  const journal = JSON.parse(text);
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const latest = Math.max(
    0,
    ...entries.map((entry) =>
      typeof entry?.when === "number" ? entry.when : 0
    )
  );
  return { latestMigrationTimestamp: latest, journalSha256: hash };
};

export const buildPackageManifest = ({
  packageRoot,
  repoRoot,
  platform = platformKey(),
  architecture = process.arch,
  version,
  createdAt = "1970-01-01T00:00:00.000Z"
}) => {
  const runtimeRoot = resolve(packageRoot, "koed-runtime");
  const packageFiles = listFiles(packageRoot).filter(
    (file) => file !== "koed-server-package-manifest.json"
  );
  const requiredFiles = [...requiredRuntimeFiles];
  const migrationSet = readMigrationSet(runtimeRoot);
  const packageVersion =
    version ??
    readPackageVersion(repoRoot, "packages/koed-server/package.json");
  const desktopVersion = readPackageVersion(
    repoRoot,
    "apps/desktop/package.json"
  );
  return {
    schemaVersion: standalonePackageSchemaVersion,
    id: standalonePackageId,
    version: packageVersion,
    platform,
    architecture,
    packageKind: standalonePackageKind,
    createdAt,
    minimumDesktopVersion: desktopVersion,
    maximumDesktopMajor: Number.parseInt(desktopVersion.split(".")[0] ?? "0"),
    nodeRuntime: {
      mode: "desktop-electron-node",
      minimumNodeMajor: 22
    },
    koedRuntime: {
      path: "koed-runtime",
      requiredFiles
    },
    database: {
      migrationSet,
      allowsRollback: false
    },
    nativeRuntime: {
      compatibleManifestSchema: 1,
      requires: ["postgresql@17", "pgvector", "llama-server"]
    },
    models: {
      embedding: "qwen3-0.6b",
      reranker: "qwen3-reranker-0.6b"
    },
    provenance: {
      sourceRepository:
        process.env.GITHUB_REPOSITORY ??
        process.env.KOED_SERVER_PACKAGE_SOURCE_REPOSITORY ??
        null,
      sourceCommit:
        process.env.GITHUB_SHA ??
        process.env.KOED_SERVER_PACKAGE_SOURCE_COMMIT ??
        null,
      sourceRef:
        process.env.GITHUB_REF_NAME ??
        process.env.GITHUB_REF ??
        process.env.KOED_SERVER_PACKAGE_SOURCE_REF ??
        null,
      buildWorkflow:
        process.env.GITHUB_WORKFLOW ??
        process.env.KOED_SERVER_PACKAGE_BUILD_WORKFLOW ??
        null,
      buildRunId:
        process.env.GITHUB_RUN_ID ??
        process.env.KOED_SERVER_PACKAGE_BUILD_RUN_ID ??
        null
    },
    sha256: sha256Files(packageRoot, packageFiles),
    files: fileEntries(packageRoot, packageFiles)
  };
};

const signingPrivateKey = () => {
  const pem = process.env.KOED_SERVER_PACKAGE_SIGNING_PRIVATE_KEY_PEM;
  const path = process.env.KOED_SERVER_PACKAGE_SIGNING_PRIVATE_KEY_FILE;
  if (!pem && !path) return null;
  return createPrivateKey(pem ?? readFileSync(path, "utf8"));
};

export const buildPackageProvenance = ({
  archivePath,
  manifestPath,
  manifest,
  createdAt = new Date(0).toISOString()
}) => {
  const statement = {
    schemaVersion: packageProvenanceSchemaVersion,
    subject: {
      packageKind: manifest.packageKind,
      id: manifest.id,
      version: manifest.version,
      platform: manifest.platform,
      architecture: manifest.architecture,
      archiveName: archivePath.split("/").at(-1),
      archiveSha256: sha256File(archivePath),
      manifestName: manifestPath.split("/").at(-1),
      manifestSha256: sha256File(manifestPath),
      packageSha256: manifest.sha256
    },
    source: {
      repository: manifest.provenance?.sourceRepository ?? null,
      commit: manifest.provenance?.sourceCommit ?? null,
      ref: manifest.provenance?.sourceRef ?? null
    },
    build: {
      workflow: manifest.provenance?.buildWorkflow ?? null,
      runId: manifest.provenance?.buildRunId ?? null,
      createdAt
    },
    integrity: {
      archiveAlgorithm: "sha256",
      manifestAlgorithm: "sha256",
      signatureAlgorithm: "ed25519"
    }
  };
  const key = signingPrivateKey();
  const payload = Buffer.from(canonicalJson(statement), "utf8");
  const signature = key ? sign(null, payload, key).toString("base64") : null;
  return {
    statement,
    signature: signature
      ? {
          status: "signed",
          algorithm: "ed25519",
          value: signature
        }
      : {
          status: "unsigned-placeholder",
          algorithm: "ed25519",
          value: null,
          reason:
            "KOED_SERVER_PACKAGE_SIGNING_PRIVATE_KEY_PEM or KOED_SERVER_PACKAGE_SIGNING_PRIVATE_KEY_FILE was not set."
        }
  };
};

export const writePackageProvenance = (path, provenance) => {
  writeFileSync(path, `${JSON.stringify(provenance, null, 2)}\n`);
  const value = provenance.signature?.value;
  if (provenance.signature?.status === "signed" && value) {
    writeFileSync(`${path}.sig`, `${value}\n`);
  }
};

export const writePackageManifest = (packageRoot, manifest) => {
  writeFileSync(
    resolve(packageRoot, "koed-server-package-manifest.json"),
    `${JSON.stringify(manifest)}\n`
  );
};

export const validatePackageManifestShape = (manifest) => {
  const errors = [];
  if (!manifest || typeof manifest !== "object") {
    return ["Package manifest must be an object."];
  }
  if (manifest.schemaVersion !== standalonePackageSchemaVersion) {
    errors.push("Package manifest schemaVersion must be 2 for shared staging.");
  }
  if (manifest.id !== standalonePackageId) {
    errors.push("Package manifest id must be koed-server.");
  }
  if (manifest.packageKind !== standalonePackageKind) {
    errors.push("Package manifest packageKind must be app-runtime.");
  }
  for (const key of ["version", "platform", "architecture", "createdAt"]) {
    if (typeof manifest[key] !== "string" || manifest[key].length === 0) {
      errors.push(`Package manifest ${key} must be a non-empty string.`);
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

export const validatePackageRoot = (packageRoot) => {
  const root = resolve(packageRoot);
  const manifestPath = resolve(root, "koed-server-package-manifest.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null;
  const manifestErrors = validatePackageManifestShape(manifest);
  const runtimePath = manifest?.koedRuntime?.path ?? "koed-runtime";
  const runtimeRoot = resolve(root, runtimePath);
  const requiredFiles = Array.isArray(manifest?.koedRuntime?.requiredFiles)
    ? manifest.koedRuntime.requiredFiles
    : requiredRuntimeFiles;
  const missing = [
    !existsSync(manifestPath) ? "koed-server-package-manifest.json" : null,
    !existsSync(resolve(root, "README.txt")) ? "README.txt" : null,
    !existsSync(resolve(root, "bin", "koed-server")) ? "bin/koed-server" : null,
    !existsSync(resolve(runtimeRoot, "koed-server", "dist", "cli.js"))
      ? "koed-runtime/koed-server/dist/cli.js"
      : null,
    ...requiredFiles.map((file) =>
      existsSync(resolve(runtimeRoot, file)) ? null : `${runtimePath}/${file}`
    )
  ].filter(Boolean);
  const browserAssetRoot = resolve(
    runtimeRoot,
    "node_modules",
    "@koed",
    "api",
    "dist",
    "browser-approval",
    "assets"
  );
  const browserAssets = existsSync(browserAssetRoot)
    ? listFiles(browserAssetRoot)
    : [];
  const browserApprovalErrors = [
    browserAssets.some((file) => /-[A-Za-z0-9_-]{6,}\.js$/.test(file))
      ? null
      : "koed-runtime/node_modules/@koed/api/dist/browser-approval/assets/<fingerprinted>.js",
    browserAssets.some((file) => /-[A-Za-z0-9_-]{6,}\.css$/.test(file))
      ? null
      : "koed-runtime/node_modules/@koed/api/dist/browser-approval/assets/<fingerprinted>.css"
  ].filter(Boolean);
  const files = existsSync(root) ? listFiles(root) : [];
  const excluded = files.filter((file) =>
    excludedPackagePatterns.some((pattern) => pattern.test(file))
  );
  const actualFiles = files.filter(
    (file) => file !== "koed-server-package-manifest.json"
  );
  const actualSha256 =
    existsSync(root) && actualFiles.length > 0
      ? sha256Files(root, actualFiles)
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
        const path = resolve(root, entry.path);
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
  const providerRuntimeErrors = [];
  try {
    assertNoClaudeAgentSdkPlatformRuntimes(root);
  } catch (error) {
    providerRuntimeErrors.push(error.message);
  }
  const errors = [
    ...manifestErrors,
    ...missing.map((file) => `Missing required package file: ${file}`),
    ...browserApprovalErrors.map(
      (file) => `Missing required package file: ${file}`
    ),
    ...excluded.map((file) => `Excluded file is present: ${file}`),
    ...providerRuntimeErrors,
    ...deployedManifestFileDependencyErrors(root),
    ...manifestFileErrors,
    ...shaErrors
  ];
  return {
    ok: errors.length === 0,
    packageRoot: root,
    manifestPath,
    requiredFiles,
    files,
    excluded,
    errors
  };
};
