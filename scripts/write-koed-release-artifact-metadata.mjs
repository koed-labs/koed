#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage =
  () => `Usage: node scripts/write-koed-release-artifact-metadata.mjs -- [options]

Writes GitHub Release artifact metadata for Koed release assets.

Options:
  --version <version>        Product/package version, without leading v.
  --tag <tag>                GitHub Release tag, for example v0.4.0.
  --repository <owner/repo>  GitHub repository. Defaults to GITHUB_REPOSITORY.
  --artifact-root <dir>      Directory containing koed-server package assets.
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

const findManifest = (files, archive, manifest) => {
  const expected = `koed-server-app-runtime-${manifest.version}-${manifest.platform}-${manifest.architecture}.manifest.json`;
  const explicit = files.find((file) => basename(file) === expected);
  if (explicit) return explicit;
  const archiveDir = dirname(archive);
  return files.find(
    (file) =>
      dirname(file) === archiveDir && basename(file).endsWith(".manifest.json")
  );
};

const collectServerPackageTargets = ({ artifactRoot, repository, tag }) => {
  const files = listFiles(resolve(artifactRoot));
  const archives = files
    .filter((file) => basename(file).match(/^koed-server-.+\.tar\.gz$/))
    .sort();
  return archives.map((archive) => {
    const checksum = `${archive}.sha256`;
    if (!files.includes(checksum)) {
      throw new Error(`Missing SHA-256 sidecar for ${archive}`);
    }
    const sha256 = readSha256Sidecar(checksum);
    const manifestFile = files.find(
      (file) =>
        dirname(file) === dirname(archive) &&
        basename(file).endsWith(".manifest.json")
    );
    if (!manifestFile) {
      throw new Error(`Missing app-runtime manifest sidecar for ${archive}`);
    }
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const canonicalManifestFile = findManifest(files, archive, manifest);
    const provenanceFile = files.find(
      (file) =>
        dirname(file) === dirname(archive) &&
        basename(file).endsWith(".provenance.json")
    );
    const signatureFile = provenanceFile
      ? files.find((file) => file === `${provenanceFile}.sig`)
      : undefined;
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
        name: basename(canonicalManifestFile),
        url: releaseUrl({ repository, tag, file: canonicalManifestFile }),
        schemaVersion: manifest.schemaVersion
      },
      ...(provenanceFile
        ? {
            provenance: {
              name: basename(provenanceFile),
              url: releaseUrl({ repository, tag, file: provenanceFile }),
              schemaVersion: 1,
              signature:
                signatureFile !== undefined
                  ? {
                      name: basename(signatureFile),
                      url: releaseUrl({
                        repository,
                        tag,
                        file: signatureFile
                      }),
                      algorithm: "ed25519"
                    }
                  : {
                      status: "unsigned-placeholder",
                      algorithm: "ed25519"
                    }
            }
          }
        : {})
    };
  });
};

export const buildReleaseArtifactMetadata = (options) => {
  const targets = collectServerPackageTargets(options);
  return {
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
          "Postgres, pgvector, and llama-server runtime assets are separate from koed-server app-runtime packages and are currently bundled/provisioned through Desktop/native-runtime install flows. Standalone native runtime release assets are not published by this metadata yet."
      },
      models: {
        kind: "models",
        description:
          "Embedding and reranker model assets remain separate and install under KOED_HOME/models."
      }
    }
  };
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
