#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage =
  () => `Usage: node scripts/write-koed-release-artifact-metadata.mjs -- [options]

Writes GitHub Release artifact metadata for Koed release assets.

Options:
  --version <version>        Product/package version, without leading v.
  --tag <tag>                GitHub Release tag, for example v0.4.0.
  --repository <owner/repo>  GitHub repository. Defaults to GITHUB_REPOSITORY.
  --artifact-root <dir>      Directory containing Koed release assets.
  --out <path>               Metadata JSON output path.
  --json                     Print JSON result.
  -h, --help                 Show help.
`;

const parseArgs = (argv) => {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--version") options.version = argv[++index];
    else if (value === "--tag") options.tag = argv[++index];
    else if (value === "--repository") options.repository = argv[++index];
    else if (value === "--artifact-root") options.artifactRoot = argv[++index];
    else if (value === "--out") options.out = argv[++index];
    else if (value === "--json") options.json = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown option: ${value}\n\n${usage()}`);
  }
  options.repository ??= process.env.GITHUB_REPOSITORY;
  if (options.help) return options;
  for (const key of ["version", "tag", "repository", "artifactRoot", "out"]) {
    if (!options[key]) throw new Error(`Missing required option: --${key}`);
  }
  return options;
};

const listFiles = (root, dir = root) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return listFiles(root, path);
    return [path];
  });

const releaseUrl = ({ repository, tag, file }) =>
  `https://github.com/${repository}/releases/download/${tag}/${basename(file)}`;

const readSha256Sidecar = (path) => {
  const text = readFileSync(path, "utf8").trim();
  const sha256 = text.split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Invalid SHA-256 sidecar: ${path}`);
  }
  return sha256;
};

const sha256File = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const findUniqueNamedFile = (files, expected, description) => {
  const matches = files.filter((file) => basename(file) === expected);
  if (matches.length !== 1) {
    throw new Error(
      `${matches.length === 0 ? "Missing" : "Duplicate"} ${description}: ${expected}`
    );
  }
  return matches[0];
};

const parseServerArchiveName = (archive) => {
  const match = basename(archive).match(
    /^koed-server-(.+)-(linux|macos)-(x64|arm64)\.tar\.gz$/
  );
  if (!match) throw new Error(`Invalid app-runtime archive name: ${archive}`);
  return { version: match[1], platform: match[2], architecture: match[3] };
};

const parseNativeArchiveName = (archive) => {
  const match = basename(archive).match(
    /^koed-native-runtime-(linux|macos)-(x64|arm64)-(.+)\.tar\.gz$/
  );
  if (!match)
    throw new Error(`Invalid native-runtime archive name: ${archive}`);
  return { version: match[3], platform: match[1], architecture: match[2] };
};

const assertTarget = (label, actual, expected) => {
  for (const key of ["version", "platform", "architecture"]) {
    if (actual?.[key] !== expected[key]) {
      throw new Error(
        `${label} ${key} mismatch: expected ${expected[key]}, received ${actual?.[key] ?? "missing"}`
      );
    }
  }
};

const collectServerPackageTargets = ({
  artifactRoot,
  repository,
  tag,
  version
}) => {
  const files = listFiles(resolve(artifactRoot));
  const archives = files
    .filter((file) => basename(file).match(/^koed-server-.+\.tar\.gz$/))
    .sort();
  return archives.map((archive) => {
    const target = parseServerArchiveName(archive);
    if (target.version !== version) {
      throw new Error(
        `App-runtime archive version mismatch: expected ${version}, received ${target.version}`
      );
    }
    const checksum = `${archive}.sha256`;
    if (!files.includes(checksum)) {
      throw new Error(`Missing SHA-256 sidecar for ${archive}`);
    }
    const sha256 = readSha256Sidecar(checksum);
    const manifestFile = findUniqueNamedFile(
      files,
      `koed-server-app-runtime-${target.version}-${target.platform}-${target.architecture}.manifest.json`,
      "app-runtime manifest"
    );
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    assertTarget("App-runtime manifest", manifest, target);
    if (
      manifest.id !== "koed-server" ||
      manifest.packageKind !== "app-runtime"
    ) {
      throw new Error(`Invalid app-runtime manifest identity: ${manifestFile}`);
    }
    const provenanceFile = findUniqueNamedFile(
      files,
      `koed-server-app-runtime-${target.version}-${target.platform}-${target.architecture}.provenance.json`,
      "app-runtime provenance"
    );
    const provenance = JSON.parse(readFileSync(provenanceFile, "utf8"));
    if (provenance.statement?.schemaVersion !== 1) {
      throw new Error(`Invalid app-runtime provenance: ${provenanceFile}`);
    }
    assertTarget(
      "App-runtime provenance subject",
      provenance.statement.subject,
      target
    );
    if (
      provenance.statement.subject?.id !== manifest.id ||
      provenance.statement.subject?.packageKind !== manifest.packageKind ||
      provenance.statement.subject?.archiveName !== basename(archive) ||
      provenance.statement.subject?.archiveSha256 !== sha256
    ) {
      throw new Error(
        `App-runtime provenance subject mismatch: ${provenanceFile}`
      );
    }
    if (
      provenance.statement.subject?.manifestName !==
        "koed-server-package-manifest.json" ||
      provenance.statement.subject?.manifestSha256 !== sha256File(manifestFile)
    ) {
      throw new Error(
        `App-runtime provenance manifest mismatch: ${provenanceFile}`
      );
    }
    const signatureName = `${basename(provenanceFile)}.sig`;
    const signatureMatches = files.filter(
      (file) => basename(file) === signatureName
    );
    if (signatureMatches.length > 1) {
      throw new Error(
        `Duplicate app-runtime provenance signature: ${signatureName}`
      );
    }
    const signatureFile = signatureMatches[0];
    const signatureStatus = provenance.signature?.status;
    if (signatureStatus === "signed" && !signatureFile) {
      throw new Error(
        `Missing app-runtime provenance signature: ${signatureName}`
      );
    }
    if (
      signatureStatus !== "signed" &&
      signatureStatus !== "unsigned-placeholder"
    ) {
      throw new Error(
        `Invalid app-runtime provenance signature state: ${provenanceFile}`
      );
    }
    return {
      packageKind: manifest.packageKind,
      id: manifest.id,
      version: manifest.version,
      platform: manifest.platform,
      architecture: manifest.architecture,
      archive: {
        name: basename(archive),
        url: releaseUrl({ repository, tag, file: archive }),
        sha256
      },
      checksum: {
        name: basename(checksum),
        url: releaseUrl({ repository, tag, file: checksum }),
        algorithm: "sha256"
      },
      manifest: {
        name: basename(manifestFile),
        url: releaseUrl({ repository, tag, file: manifestFile }),
        schemaVersion: manifest.schemaVersion
      },
      provenance: {
        name: basename(provenanceFile),
        url: releaseUrl({ repository, tag, file: provenanceFile }),
        schemaVersion: provenance.statement.schemaVersion,
        signature: signatureFile
          ? {
              name: basename(signatureFile),
              url: releaseUrl({ repository, tag, file: signatureFile }),
              algorithm: "ed25519"
            }
          : { status: "unsigned-placeholder", algorithm: "ed25519" }
      }
    };
  });
};

const collectNativeRuntimeTargets = ({
  artifactRoot,
  repository,
  tag,
  version
}) => {
  const files = listFiles(resolve(artifactRoot));
  return files
    .filter((file) => basename(file).match(/^koed-native-runtime-.+\.tar\.gz$/))
    .sort()
    .map((archive) => {
      const target = parseNativeArchiveName(archive);
      if (target.version !== version) {
        throw new Error(
          `Native-runtime archive version mismatch: expected ${version}, received ${target.version}`
        );
      }
      const checksum = `${archive}.sha256`;
      if (!files.includes(checksum)) {
        throw new Error(`Missing SHA-256 sidecar for ${archive}`);
      }
      const provenanceFile = findUniqueNamedFile(
        files,
        `koed-native-runtime-${target.platform}-${target.architecture}-${target.version}.provenance.json`,
        "native-runtime provenance"
      );
      const provenance = JSON.parse(readFileSync(provenanceFile, "utf8"));
      if (
        provenance.schemaVersion !== 1 ||
        typeof provenance.artifact?.version !== "string" ||
        typeof provenance.artifact?.platform !== "string" ||
        typeof provenance.artifact?.architecture !== "string"
      ) {
        throw new Error(`Invalid native-runtime provenance: ${provenanceFile}`);
      }
      assertTarget(
        "Native-runtime provenance artifact",
        provenance.artifact,
        target
      );
      return {
        version: provenance.artifact?.version,
        platform: provenance.artifact?.platform,
        architecture: provenance.artifact?.architecture,
        archive: {
          name: basename(archive),
          url: releaseUrl({ repository, tag, file: archive }),
          sha256: readSha256Sidecar(checksum)
        },
        checksum: {
          name: basename(checksum),
          url: releaseUrl({ repository, tag, file: checksum }),
          algorithm: "sha256"
        },
        provenance: {
          name: basename(provenanceFile),
          url: releaseUrl({ repository, tag, file: provenanceFile }),
          schemaVersion: provenance.schemaVersion
        }
      };
    });
};

export const buildReleaseArtifactMetadata = (options) => {
  const targets = collectServerPackageTargets(options);
  const nativeRuntimeTargets = collectNativeRuntimeTargets(options);
  const metadata = {
    schemaVersion: 1,
    release: {
      version: options.version,
      tag: options.tag
    },
    artifacts: {
      desktop: {
        kind: "desktop",
        packageName: "koed",
        description: "Koed Desktop control-plane package assets."
      },
      koedServerAppRuntime: {
        kind: "app-runtime",
        packageName: "koed-server",
        description:
          "Standalone koed-server JS/service app-runtime packages. These archives exclude native runtime assets, model files, and Python runtime files.",
        targets
      },
      nativeRuntime: {
        kind: "native-runtime",
        packageName: "koed-native-runtime",
        description:
          "Checksum-pinned Postgres, pgvector, and llama-server runtime assets published separately from koed-server app-runtime packages and model files.",
        targets: nativeRuntimeTargets
      },
      models: {
        kind: "models",
        description:
          "Embedding and reranker model assets remain separate and install under KOED_HOME/models."
      }
    }
  };
  validateReleaseArtifactMetadata(metadata, options);
  return metadata;
};

export const validateReleaseArtifactMetadata = (metadata, options) => {
  if (
    metadata.schemaVersion !== 1 ||
    metadata.release?.version !== options.version ||
    metadata.release?.tag !== options.tag
  ) {
    throw new Error("Release metadata identity is inconsistent.");
  }
  const groups = [
    metadata.artifacts?.koedServerAppRuntime?.targets ?? [],
    metadata.artifacts?.nativeRuntime?.targets ?? []
  ];
  for (const targets of groups) {
    const identities = new Set();
    for (const target of targets) {
      assertTarget("Release metadata target", target, {
        version: options.version,
        platform: target.platform,
        architecture: target.architecture
      });
      const identity = `${target.version}/${target.platform}/${target.architecture}`;
      if (identities.has(identity)) {
        throw new Error(`Duplicate release metadata target: ${identity}`);
      }
      identities.add(identity);
      for (const sidecar of [
        target.archive,
        target.checksum,
        target.manifest,
        target.provenance,
        target.provenance?.signature?.name
          ? target.provenance.signature
          : undefined
      ].filter(Boolean)) {
        if (!sidecar.name || !sidecar.url?.endsWith(`/${sidecar.name}`)) {
          throw new Error(`Release metadata URL mismatch for ${identity}.`);
        }
      }
    }
  }
  return metadata;
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const metadata = buildReleaseArtifactMetadata(options);
  writeFileSync(resolve(options.out), `${JSON.stringify(metadata, null, 2)}\n`);
  if (options.json) {
    console.log(JSON.stringify({ ok: true, out: resolve(options.out) }));
  } else {
    console.log(`Wrote ${resolve(options.out)}`);
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
