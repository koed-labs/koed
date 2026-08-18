#!/usr/bin/env node
import { gzipSync } from "node:zlib";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { prunePythonEmbeddingRuntimeFiles } from "./native-runtime/manifest-lib.mjs";
import { removeClaudeAgentSdkPlatformRuntimes } from "./provider-runtime-package-policy.mjs";
import {
  buildPackageManifest,
  buildPackageProvenance,
  isPnpmWorkspaceSelfSymlink,
  normalizeDeployedWorkspaceDependencies,
  platformKey,
  pruneStandalonePackageMetadata,
  prunePnpmWorkspaceVirtualStorePaths,
  readPackageVersion,
  sha256File,
  validatePackageRoot,
  writePackageManifest,
  writePackageProvenance
} from "./koed-server-package-lib.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

const usage = () => `Usage: pnpm koed-server:package -- [options]

Builds a standalone koed-server JS/service runtime package artifact.

Options:
  --platform <platform>      Package platform key. Defaults to current host.
  --arch <arch>              Package architecture. Defaults to current host.
  --version <version>        Package version. Defaults to @koed/koed-server.
  --out-dir <dir>            Output directory. Defaults to dist/koed-server-package/<platform>-<arch>.
  --json                     Print JSON result.
  --skip-restore-install     Do not restore workspace dependencies after pnpm deploy.
  -h, --help                 Show help.
`;

const parseArgs = (argv) => {
  const options = { json: false, restoreInstall: true };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--") continue;
    if (value === "--platform") options.platform = argv[++i];
    else if (value === "--arch") options.architecture = argv[++i];
    else if (value === "--version") options.version = argv[++i];
    else if (value === "--out-dir") options.outDir = argv[++i];
    else if (value === "--json") options.json = true;
    else if (value === "--skip-restore-install") options.restoreInstall = false;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown option: ${value}\n\n${usage()}`);
  }
  options.platform ||=
    process.env.KOED_SERVER_PACKAGE_PLATFORM ?? platformKey();
  options.architecture ||=
    process.env.KOED_SERVER_PACKAGE_ARCHITECTURE ?? process.arch;
  options.version ||=
    process.env.KOED_SERVER_PACKAGE_VERSION ??
    readPackageVersion(repoRoot, "packages/koed-server/package.json");
  options.outDir ||=
    process.env.KOED_SERVER_PACKAGE_OUT_DIR ??
    resolve(
      repoRoot,
      "dist",
      "koed-server-package",
      `${options.platform}-${options.architecture}`
    );
  return options;
};

const run = (label, command, args, options = {}) => {
  console.error(`> ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with ${result.status ?? 1}`);
  }
  return result;
};

const deploy = (filter, runtimeRoot, to) =>
  run(`Deploy ${filter}`, "pnpm", [
    ...(filter === "@koed/koed-server" ? ["--config.node-linker=hoisted"] : []),
    "--config.inject-workspace-packages=true",
    "--filter",
    filter,
    "deploy",
    "--frozen-lockfile",
    "--prod",
    resolve(runtimeRoot, to)
  ]);

const writeLauncher = (packageRoot) => {
  const launcher = resolve(packageRoot, "bin", "koed-server");
  mkdirSync(resolve(packageRoot, "bin"), { recursive: true });
  writeFileSync(
    launcher,
    [
      "#!/usr/bin/env sh",
      "set -eu",
      'ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"',
      'export KOED_SERVER_PACKAGE_ROOT="${KOED_SERVER_PACKAGE_ROOT:-$ROOT}"',
      'export KOED_JS_RUNTIME_ROOT="${KOED_JS_RUNTIME_ROOT:-$ROOT/koed-runtime}"',
      'exec node "$ROOT/koed-server/dist/cli.js" "$@"',
      ""
    ].join("\n")
  );
  chmodSync(launcher, 0o755);
};

const validatePackagedCli = (packageRoot) =>
  run(
    "Validate packaged koed-server CLI",
    process.execPath,
    [resolve(packageRoot, "koed-server", "dist", "cli.js"), "--help"],
    { cwd: packageRoot, stdio: "pipe" }
  );

const writeReadme = (packageRoot) => {
  writeFileSync(
    resolve(packageRoot, "README.txt"),
    [
      "Standalone koed-server package",
      "",
      "This artifact contains the Koed JS/service app runtime only.",
      "It excludes the retired Explorer service, native runtime assets, model files, and Python embedding runtime files.",
      "",
      "Contents:",
      "- bin/koed-server",
      "- koed-runtime/api",
      "- koed-runtime/worker",
      "- koed-runtime/embedding-service",
      "- koed-runtime/mcp-server",
      "",
      "Native runtime assets and models are installed separately under KOED_HOME.",
      ""
    ].join("\n")
  );
};

const dereferencePackageSymlinks = (root, dir = root) => {
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    const relativePath = path.slice(root.length + 1).replaceAll("\\", "/");
    if (isPnpmWorkspaceSelfSymlink(relativePath)) continue;
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      dereferencePackageSymlinks(root, path);
      continue;
    }
    if (!stat.isSymbolicLink()) continue;

    const targetStat = statSync(path);
    const tempPath = `${path}.dereferenced-${process.pid}`;
    rmSync(tempPath, { recursive: true, force: true });
    if (targetStat.isDirectory()) {
      cpSync(path, tempPath, { recursive: true, dereference: true });
    } else {
      copyFileSync(path, tempPath);
    }
    rmSync(path, { recursive: true, force: true });
    renameSync(tempPath, path);
    if (targetStat.isDirectory()) {
      dereferencePackageSymlinks(root, path);
    }
  }
};

const assertArchiveHasNoSymlinks = (sourceDir) => {
  const symlinks = archiveEntries(sourceDir).filter(
    (entry) => entry.type === "symlink"
  );
  if (symlinks.length > 0) {
    throw new Error(
      `Standalone koed-server package archive still contains symlinks:\n${symlinks
        .map((entry) => entry.relativePath)
        .slice(0, 20)
        .join("\n")}`
    );
  }
};

const tarString = (buffer, offset, length, value) => {
  if (Buffer.byteLength(value) > length) {
    throw new Error(`Tar header value is too long: ${value}`);
  }
  buffer.write(value, offset, length, "utf8");
};

const tarOctal = (buffer, offset, length, value) => {
  const text = value.toString(8).padStart(length - 1, "0");
  tarString(buffer, offset, length, `${text.slice(-(length - 1))}\0`);
};

const splitTarPath = (path) => {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Path is too long for deterministic ustar archive: ${path}`);
};

const tarHeader = ({ path, mode, size, type, linkname = "" }) => {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarPath(path);
  tarString(header, 0, 100, name);
  tarOctal(header, 100, 8, mode);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, size);
  tarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  tarString(header, 156, 1, type);
  tarString(header, 157, 100, linkname);
  tarString(header, 257, 6, "ustar");
  tarString(header, 263, 2, "00");
  tarString(header, 265, 32, "root");
  tarString(header, 297, 32, "root");
  tarString(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  tarOctal(header, 148, 8, checksum);
  return header;
};

const paxRecord = (key, value) => {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  for (;;) {
    const candidate = `${length}${body}`;
    const actual = Buffer.byteLength(candidate);
    if (actual === length) return candidate;
    length = actual;
  }
};

const paxContent = (records) =>
  Buffer.from(
    Object.entries(records)
      .map(([key, value]) => paxRecord(key, value))
      .join(""),
    "utf8"
  );

const padded = (buffer) => {
  const remainder = buffer.length % 512;
  return remainder === 0
    ? buffer
    : Buffer.concat([buffer, Buffer.alloc(512 - remainder, 0)]);
};

const archiveEntries = (root, relativeRoot = "") =>
  readdirSync(root)
    .sort()
    .flatMap((name) => {
      const path = resolve(root, name);
      const relativePath = relativeRoot ? `${relativeRoot}/${name}` : name;
      if (isPnpmWorkspaceSelfSymlink(relativePath)) return [];
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        return [
          { path, relativePath: `${relativePath}/`, stat, type: "directory" },
          ...archiveEntries(path, relativePath)
        ];
      }
      if (stat.isSymbolicLink()) {
        return [{ path, relativePath, stat, type: "symlink" }];
      }
      if (stat.isFile()) {
        return [{ path, relativePath, stat, type: "file" }];
      }
      throw new Error(`Unsupported package archive entry: ${relativePath}`);
    });

const writeDeterministicTarGz = ({ sourceDir, packageDirName, tarPath }) => {
  const blocks = [
    tarHeader({
      path: `${packageDirName}/`,
      mode: 0o755,
      size: 0,
      type: "5"
    })
  ];
  let paxIndex = 0;
  for (const entry of archiveEntries(sourceDir)) {
    const archivePath = `${packageDirName}/${entry.relativePath}`;
    const linkname =
      entry.type === "symlink" ? readlinkSync(entry.path) : undefined;
    const pax = {};
    try {
      splitTarPath(archivePath);
    } catch {
      pax.path = archivePath;
    }
    if (linkname && Buffer.byteLength(linkname) > 100) {
      pax.linkpath = linkname;
    }
    let paxEntryIndex;
    if (Object.keys(pax).length > 0) {
      const content = paxContent(pax);
      paxEntryIndex = String(paxIndex).padStart(6, "0");
      const headerPath = `PaxHeaders/${paxEntryIndex}`;
      paxIndex += 1;
      blocks.push(
        tarHeader({
          path: headerPath,
          mode: 0o644,
          size: content.length,
          type: "x"
        }),
        padded(content)
      );
    }
    const headerPath = pax.path ? `PaxEntries/${paxEntryIndex}` : archivePath;
    if (entry.type === "directory") {
      blocks.push(
        tarHeader({
          path: headerPath,
          mode: 0o755,
          size: 0,
          type: "5"
        })
      );
    } else if (entry.type === "symlink") {
      blocks.push(
        tarHeader({
          path: headerPath,
          mode: 0o777,
          size: 0,
          type: "2",
          linkname: pax.linkpath ? "" : linkname
        })
      );
    } else {
      const content = readFileSync(entry.path);
      blocks.push(
        tarHeader({
          path: headerPath,
          mode: entry.stat.mode & 0o777,
          size: content.length,
          type: "0"
        }),
        padded(content)
      );
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  writeFileSync(tarPath, gzipSync(Buffer.concat(blocks), { mtime: 0 }));
};

const createArchive = ({ outDir, packageDirName }) => {
  const tarName = `${packageDirName}.tar.gz`;
  const tarPath = resolve(outDir, tarName);
  writeDeterministicTarGz({
    sourceDir: resolve(outDir, packageDirName),
    packageDirName,
    tarPath
  });
  const sha256 = sha256File(tarPath);
  const sha256Path = resolve(outDir, `${tarName}.sha256`);
  writeFileSync(sha256Path, `${sha256}  ${basename(tarPath)}\n`);
  return { tarPath, sha256Path, sha256 };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const outDir = resolve(options.outDir);
  const packageDirName = `koed-server-${options.version}-${options.platform}-${options.architecture}`;
  const packageRoot = resolve(outDir, packageDirName);
  const runtimeRoot = resolve(packageRoot, "koed-runtime");
  let result;

  try {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(runtimeRoot, { recursive: true });

    deploy("@koed/koed-server", packageRoot, "koed-server");
    deploy("@koed/api", runtimeRoot, "api");
    deploy("@koed/worker", runtimeRoot, "worker");
    deploy("@koed/embedding-service", runtimeRoot, "embedding-service");
    deploy("@koed/mcp-server", runtimeRoot, "mcp-server");

    for (const manifestPath of [
      resolve(packageRoot, "koed-server", "package.json"),
      resolve(runtimeRoot, "api", "package.json"),
      resolve(runtimeRoot, "worker", "package.json"),
      resolve(runtimeRoot, "embedding-service", "package.json"),
      resolve(runtimeRoot, "mcp-server", "package.json")
    ]) {
      normalizeDeployedWorkspaceDependencies(manifestPath);
    }

    prunePythonEmbeddingRuntimeFiles(runtimeRoot);
    removeClaudeAgentSdkPlatformRuntimes(packageRoot);
    pruneStandalonePackageMetadata(packageRoot);
    dereferencePackageSymlinks(packageRoot);
    prunePnpmWorkspaceVirtualStorePaths(packageRoot);
    validatePackagedCli(packageRoot);
    writeLauncher(packageRoot);
    writeReadme(packageRoot);
    const manifest = buildPackageManifest({
      packageRoot,
      repoRoot,
      platform: options.platform,
      architecture: options.architecture,
      version: options.version,
      createdAt:
        process.env.SOURCE_DATE_EPOCH !== undefined
          ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
          : "1970-01-01T00:00:00.000Z"
    });
    writePackageManifest(packageRoot, manifest);
    const validation = validatePackageRoot(packageRoot);
    if (!validation.ok) {
      throw new Error(
        `Standalone koed-server package validation failed:\n${validation.errors.join("\n")}`
      );
    }

    assertArchiveHasNoSymlinks(packageRoot);
    const artifact = createArchive({ outDir, packageDirName });
    const provenancePath = resolve(
      outDir,
      `koed-server-app-runtime-${options.version}-${options.platform}-${options.architecture}.provenance.json`
    );
    const provenance = buildPackageProvenance({
      archivePath: artifact.tarPath,
      manifestPath: resolve(packageRoot, "koed-server-package-manifest.json"),
      manifest,
      createdAt: manifest.createdAt
    });
    writePackageProvenance(provenancePath, provenance);

    result = {
      ok: true,
      packageRoot,
      runtimeRoot,
      manifestPath: resolve(packageRoot, "koed-server-package-manifest.json"),
      requiredFiles: validation.requiredFiles,
      artifact,
      provenance: {
        path: provenancePath,
        signaturePath:
          provenance.signature.status === "signed"
            ? `${provenancePath}.sig`
            : null,
        signatureStatus: provenance.signature.status
      }
    };
  } finally {
    if (options.restoreInstall) {
      run("Restore workspace dependencies", "pnpm", [
        "install",
        "--config.confirmModulesPurge=false"
      ]);
    }
  }

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Built ${result.artifact.tarPath}`);
};

main();
