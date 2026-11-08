import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalArtifactJson } from "../../packages/koed-server/src/artifact-canonical-json.mjs";
import {
  deterministicArchiveEntries,
  writeDeterministicTarGz
} from "../deterministic-tar-gzip.mjs";
import { sha256File } from "./manifest-lib.mjs";

export const coreManifestName = "native-core-manifest.json";
const sizePolicy = JSON.parse(
  readFileSync(
    new URL("../../config/release-artifact-size-policy.json", import.meta.url),
    "utf8"
  )
);
export const coreRecipeId = (recipe) =>
  createHash("sha256").update(canonicalArtifactJson(recipe)).digest("hex");
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

export const coreInventory = (runtimeRoot) => {
  const root = realpathSync(runtimeRoot);
  return deterministicArchiveEntries(root)
    .filter((entry) => entry.relativePath !== coreManifestName)
    .map((entry) => {
      const path = entry.relativePath.replace(/\/$/, "");
      if (
        !(
          path === "postgres" ||
          path.startsWith("postgres/") ||
          path === "llama.cpp" ||
          path === "llama.cpp/llama-server" ||
          path === "llama.cpp/cpu" ||
          path.startsWith("llama.cpp/cpu/") ||
          path === "runtime-asset-manifest.json"
        )
      )
        throw new Error(
          `CPU core contains an unexpected payload or legacy provenance: ${path}`
        );
      if ((entry.stat.mode & 0o7000) !== 0)
        throw new Error(
          `Native special permission bits are not supported: ${path}`
        );
      // Linux ignores symlink permissions. Record the archive's fixed mode,
      // including when a frozen tree is inspected on macOS.
      const mode = entry.type === "symlink" ? 0o777 : entry.stat.mode & 0o777;
      if (entry.type === "directory") {
        if (mode !== 0o755)
          throw new Error(`Native directory mode must be 0755: ${path}`);
        return { path, type: "directory", mode };
      }
      if (entry.type === "file") {
        if (entry.stat.nlink !== 1)
          throw new Error(`Native hard links are not supported: ${path}`);
        return {
          path,
          type: "file",
          mode,
          bytes: entry.stat.size,
          sha256: sha256File(entry.path)
        };
      }
      if (entry.type !== "symlink")
        throw new Error(`Unsupported native entry: ${path}`);
      const target = readlinkSync(entry.path);
      const destination = resolve(dirname(entry.path), target);
      if (
        isAbsolute(target) ||
        !inside(root, destination) ||
        !inside(root, realpathSync(destination)) ||
        !lstatSync(destination).isFile()
      )
        throw new Error(
          `Native link must point directly to a contained regular file: ${path}`
        );
      return { path, type: "symlink", mode, target };
    });
};

const assertCoreMetadata = (metadata) => {
  if (
    metadata?.schemaVersion !== 1 ||
    metadata.kind !== "core" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      metadata.runtimeVersion ?? ""
    ) ||
    metadata.target?.platform !== "linux" ||
    metadata.target.architecture !== "x64" ||
    metadata.target.libc?.family !== "glibc" ||
    metadata.target.libc.minimumVersion !== "2.35" ||
    metadata.contracts?.layout !== 1 ||
    metadata.contracts.postgres !== 1 ||
    metadata.contracts.embedding !== 1 ||
    !/^[a-f0-9]{40}$/.test(metadata.components?.llamaCpp?.revision ?? "") ||
    !/^17\.\d+$/.test(metadata.components?.postgres?.version ?? "") ||
    !/^\d+\.\d+\.\d+$/.test(metadata.components?.pgvector?.version ?? "")
  )
    throw new Error(
      "Invalid Linux CPU core version, target, or contract metadata."
    );
  const recipe = metadata.recipe;
  if (
    recipe?.schemaVersion !== 1 ||
    recipe.kind !== "core" ||
    recipe.configuration?.runtimeVersion !== metadata.runtimeVersion ||
    canonicalArtifactJson(recipe.configuration.target) !==
      canonicalArtifactJson(metadata.target) ||
    canonicalArtifactJson(recipe.configuration.contracts) !==
      canonicalArtifactJson(metadata.contracts) ||
    recipe.configuration.llamaCppRevision !==
      metadata.components.llamaCpp.revision ||
    recipe.sources?.postgres?.version !==
      metadata.components.postgres.version ||
    metadata.components.postgres.major !== 17 ||
    recipe.sources?.pgvector?.version !==
      metadata.components.pgvector.version ||
    recipe.sources?.llamaCpp?.version !==
      metadata.components.llamaCpp.version ||
    Object.keys(recipe.sources).sort().join(",") !==
      "llamaCpp,pgvector,postgres"
  )
    throw new Error("Native core metadata does not match its recipe.");
  for (const source of Object.values(recipe.sources)) {
    if (
      !/^https:\/\//.test(source.url ?? "") ||
      !/^[a-f0-9]{64}$/.test(source.sha256 ?? "")
    )
      throw new Error("Native core source is not pinned by URL and digest.");
  }
};

export const freezeCore = ({ runtimeRoot, configuration, recipe }) => {
  const manifest = {
    schemaVersion: 1,
    kind: "core",
    runtimeVersion: configuration.runtimeVersion,
    target: configuration.target,
    contracts: configuration.contracts,
    components: {
      postgres: { version: recipe.sources.postgres.version, major: 17 },
      pgvector: { version: recipe.sources.pgvector.version },
      llamaCpp: {
        version: recipe.sources.llamaCpp.version,
        revision: configuration.llamaCppRevision
      }
    },
    recipeId: coreRecipeId(recipe),
    recipe,
    inventory: coreInventory(runtimeRoot)
  };
  assertCoreMetadata(manifest);
  writeFileSync(
    resolve(runtimeRoot, coreManifestName),
    `${canonicalArtifactJson(manifest)}\n`,
    { flag: "wx", mode: 0o644 }
  );
  return manifest;
};

export const verifyFrozenCore = (runtimeRoot) => {
  const manifestPath = resolve(runtimeRoot, coreManifestName);
  const stat = lstatSync(manifestPath);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o7777) !== 0o644 ||
    stat.size > 8 * 1024 * 1024
  )
    throw new Error("Invalid native core manifest file.");
  const bytes = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(bytes);
  assertCoreMetadata(manifest);
  if (
    bytes !== `${canonicalArtifactJson(manifest)}\n` ||
    manifest.recipeId !== coreRecipeId(manifest.recipe)
  )
    throw new Error("Native core recipe or canonical manifest changed.");
  if (
    canonicalArtifactJson(manifest.inventory) !==
    canonicalArtifactJson(coreInventory(runtimeRoot))
  )
    throw new Error("Native core inventory changed after freezing.");
  for (const path of [
    "postgres/bin/postgres",
    "postgres/bin/initdb",
    "postgres/bin/pg_ctl",
    "postgres/bin/psql",
    "postgres/bin/pg_dump",
    "postgres/bin/pg_restore",
    "postgres/lib/vector.so",
    "postgres/lib/pgcrypto.so",
    "llama.cpp/llama-server",
    "llama.cpp/cpu/llama-server"
  ]) {
    const entry = manifest.inventory.find((entry) => entry.path === path);
    if (
      entry?.type !== "file" ||
      ((path.includes("/bin/") || path.endsWith("llama-server")) &&
        (entry.mode & 0o111) === 0)
    )
      throw new Error(
        `CPU core is missing required executable or library: ${path}`
      );
  }
  return manifest;
};

export const packageFrozenCore = ({
  runtimeRoot,
  outDir,
  maxArchiveBytes = sizePolicy.nativeCoreArchiveMaximum,
  maxExpandedBytes = sizePolicy.nativeCoreExpandedMaximum
}) => {
  const manifest = verifyFrozenCore(runtimeRoot);
  const expandedBytes =
    manifest.inventory
      .filter((entry) => entry.type === "file")
      .reduce((total, entry) => total + entry.bytes, 0) +
    lstatSync(resolve(runtimeRoot, coreManifestName)).size;
  for (const limit of [maxArchiveBytes, maxExpandedBytes])
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error("CPU core size budget is missing or invalid.");
  if (expandedBytes > maxExpandedBytes)
    throw new Error(
      `CPU core expanded size exceeds its ${maxExpandedBytes}-byte budget: ${expandedBytes}`
    );
  const name = `koed-native-core-${manifest.recipeId}-linux-x64.tar.gz`;
  const archivePath = resolve(outDir, name);
  try {
    lstatSync(archivePath);
    throw new Error(
      "Refusing to overwrite an existing native candidate archive."
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writeDeterministicTarGz({
    sourceDir: runtimeRoot,
    rootName: "koed-runtime",
    tarPath: archivePath,
    streaming: true
  });
  const archiveBytes = lstatSync(archivePath).size;
  if (archiveBytes > maxArchiveBytes)
    throw new Error(
      `CPU core archive exceeds its ${maxArchiveBytes}-byte budget: ${archiveBytes}`
    );
  const report = {
    schemaVersion: 1,
    kind: "core",
    recipeId: manifest.recipeId,
    runtimeVersion: manifest.runtimeVersion,
    target: manifest.target,
    contracts: manifest.contracts,
    components: manifest.components,
    archive: name,
    sha256: sha256File(archivePath),
    archiveBytes,
    expandedBytes,
    manifestSha256: sha256File(resolve(runtimeRoot, coreManifestName))
  };
  writeFileSync(`${archivePath}.sha256`, `${report.sha256}  ${name}\n`, {
    flag: "wx"
  });
  writeFileSync(
    resolve(outDir, "core-candidate.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" }
  );
  return report;
};
