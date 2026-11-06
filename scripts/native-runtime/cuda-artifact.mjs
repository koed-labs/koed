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

export const cudaManifestPath = "llama.cpp/cuda/native-cuda-manifest.json";
export const cudaRecipeId = (recipe) =>
  createHash("sha256").update(canonicalArtifactJson(recipe)).digest("hex");
const policy = JSON.parse(
  readFileSync(
    new URL("../../config/release-artifact-size-policy.json", import.meta.url),
    "utf8"
  )
);
const inside = (root, path) => {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

export const cudaInventory = (runtimeRoot) => {
  const root = realpathSync(runtimeRoot);
  const payload = resolve(root, "llama.cpp/cuda");
  return deterministicArchiveEntries(root)
    .filter((entry) => entry.relativePath !== cudaManifestPath)
    .map((entry) => {
      const path = entry.relativePath.replace(/\/$/, "");
      if (
        !(
          path === "llama.cpp" ||
          path === "llama.cpp/cuda" ||
          path.startsWith("llama.cpp/cuda/")
        ) ||
        /(?:^|\/)libcuda\.so(?:\.\d+)*$/.test(path)
      )
        throw new Error(
          `CUDA candidate contains an unexpected payload or host driver: ${path}`
        );
      if ((entry.stat.mode & 0o7000) !== 0)
        throw new Error(
          `Native special permission bits are not supported: ${path}`
        );
      const mode = entry.type === "symlink" ? 0o777 : entry.stat.mode & 0o777;
      if (entry.type === "directory") {
        if (mode !== 0o755)
          throw new Error(`Native directory mode must be 0755: ${path}`);
        return { path, type: "directory", mode };
      }
      // Parent paths may only be directories. All payload and metadata bytes
      // must stay below llama.cpp/cuda, including resolved library links.
      if (!path.startsWith("llama.cpp/cuda/"))
        throw new Error(`Invalid CUDA payload parent: ${path}`);
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
        throw new Error(`Unsupported CUDA entry: ${path}`);
      const target = readlinkSync(entry.path);
      const destination = resolve(dirname(entry.path), target);
      if (
        isAbsolute(target) ||
        !inside(payload, destination) ||
        !inside(payload, realpathSync(destination)) ||
        !lstatSync(destination).isFile()
      )
        throw new Error(
          `CUDA links must point directly to regular files inside the CUDA payload: ${path}`
        );
      return { path, type: "symlink", mode, target };
    });
};

const assertMetadata = (manifest) => {
  const config = manifest?.recipe?.configuration;
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.kind !== "cuda" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      manifest.runtimeVersion ?? ""
    ) ||
    manifest.target?.platform !== "linux" ||
    manifest.target.architecture !== "x64" ||
    manifest.target.libc?.family !== "glibc" ||
    manifest.target.libc.minimumVersion !== "2.35" ||
    manifest.contracts?.layout !== 1 ||
    manifest.contracts.embedding !== 1 ||
    !/^[a-f0-9]{40}$/.test(manifest.llamaCpp?.revision ?? "") ||
    !/^b\d+$/.test(manifest.llamaCpp?.version ?? "") ||
    manifest.cuda?.toolkitVersion !== "12.4" ||
    manifest.cuda.minimumDriverLinux !== "550.54.14" ||
    !Array.isArray(manifest.cuda.architectures) ||
    manifest.cuda.architectures.length === 0 ||
    !manifest.cuda.architectures.every((value) =>
      [75, 80, 86, 89, 90].includes(value)
    ) ||
    new Set(manifest.cuda.architectures).size !==
      manifest.cuda.architectures.length ||
    manifest.recipe?.schemaVersion !== 1 ||
    manifest.recipe.kind !== "cuda" ||
    config?.runtimeVersion !== manifest.runtimeVersion ||
    config.schemaVersion !== 1 ||
    Object.keys(config).sort().join(",") !==
      "contracts,cuda,llamaCpp,runtimeVersion,schemaVersion,target" ||
    canonicalArtifactJson(config.target) !==
      canonicalArtifactJson(manifest.target) ||
    canonicalArtifactJson(config.contracts) !==
      canonicalArtifactJson(manifest.contracts) ||
    canonicalArtifactJson(config.cuda) !==
      canonicalArtifactJson(manifest.cuda) ||
    config.llamaCpp?.revision !== manifest.llamaCpp.revision ||
    config.llamaCpp.version !== manifest.llamaCpp.version ||
    !/^https:\/\//.test(config.llamaCpp.url ?? "") ||
    !/^[a-f0-9]{64}$/.test(config.llamaCpp.sha256 ?? "")
  )
    throw new Error(
      "Invalid independent CUDA recipe, target, or compatibility metadata."
    );
};

export const assertCudaCoreCompatibility = (core, cuda) => {
  if (
    core.kind !== "core" ||
    cuda.kind !== "cuda" ||
    core.components?.llamaCpp?.revision !== cuda.llamaCpp?.revision ||
    core.contracts?.layout !== cuda.contracts?.layout ||
    core.contracts?.embedding !== cuda.contracts?.embedding ||
    canonicalArtifactJson(core.target) !== canonicalArtifactJson(cuda.target)
  )
    throw new Error(
      "CUDA candidate requires the exact core llama.cpp revision, target, and supported composition contracts."
    );
};

export const freezeCuda = ({ runtimeRoot, configuration, recipe }) => {
  const manifest = {
    schemaVersion: 1,
    kind: "cuda",
    runtimeVersion: configuration.runtimeVersion,
    target: configuration.target,
    contracts: configuration.contracts,
    llamaCpp: {
      version: configuration.llamaCpp.version,
      revision: configuration.llamaCpp.revision
    },
    cuda: configuration.cuda,
    recipeId: cudaRecipeId(recipe),
    recipe,
    inventory: cudaInventory(runtimeRoot)
  };
  assertMetadata(manifest);
  const bytes = `${canonicalArtifactJson(manifest)}\n`;
  if (Buffer.byteLength(bytes) > policy.maxManifestBytes)
    throw new Error("CUDA manifest exceeds its size budget.");
  writeFileSync(resolve(runtimeRoot, cudaManifestPath), bytes, {
    flag: "wx",
    mode: 0o644
  });
  return manifest;
};

export const verifyFrozenCuda = (runtimeRoot) => {
  const path = resolve(runtimeRoot, cudaManifestPath);
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o7777) !== 0o644 ||
    stat.size > 8 * 1024 * 1024
  )
    throw new Error("Invalid CUDA manifest file.");
  const bytes = readFileSync(path, "utf8");
  const manifest = JSON.parse(bytes);
  assertMetadata(manifest);
  if (
    bytes !== `${canonicalArtifactJson(manifest)}\n` ||
    manifest.recipeId !== cudaRecipeId(manifest.recipe) ||
    canonicalArtifactJson(manifest.inventory) !==
      canonicalArtifactJson(cudaInventory(runtimeRoot))
  )
    throw new Error(
      "CUDA recipe, canonical manifest, or frozen inventory changed."
    );
  const executable = manifest.inventory.find(
    (entry) => entry.path === "llama.cpp/cuda/llama-server"
  );
  if (executable?.type !== "file" || (executable.mode & 0o111) === 0)
    throw new Error("CUDA candidate is missing its executable llama-server.");
  for (const library of [
    "libggml-cuda",
    "libcudart",
    "libcublas",
    "libcublasLt"
  ])
    if (
      !manifest.inventory.some(
        (entry) =>
          entry.type === "file" &&
          new RegExp(`^llama\\.cpp/cuda/${library}\\.so(?:\\.\\d+)*$`).test(
            entry.path
          )
      )
    )
      throw new Error(
        `CUDA candidate is missing required runtime library: ${library}`
      );
  return manifest;
};

export const packageFrozenCuda = ({ runtimeRoot, outDir }) => {
  const manifest = verifyFrozenCuda(runtimeRoot);
  const expandedBytes =
    manifest.inventory
      .filter((entry) => entry.type === "file")
      .reduce((total, entry) => total + entry.bytes, 0) +
    lstatSync(resolve(runtimeRoot, cudaManifestPath)).size;
  for (const maximum of [
    policy.nativeCudaArchiveMaximum,
    policy.nativeCudaExpandedMaximum
  ])
    if (!Number.isSafeInteger(maximum) || maximum <= 0)
      throw new Error("CUDA size budget is missing or invalid.");
  if (expandedBytes > policy.nativeCudaExpandedMaximum)
    throw new Error("CUDA candidate exceeds its expanded-size budget.");
  const name = `koed-native-cuda-${manifest.recipeId}-linux-x64.tar.gz`;
  const path = resolve(outDir, name);
  try {
    lstatSync(path);
    throw new Error(
      "Refusing to overwrite an existing CUDA candidate archive."
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writeDeterministicTarGz({
    sourceDir: runtimeRoot,
    rootName: "koed-runtime",
    tarPath: path,
    streaming: true
  });
  const archiveBytes = lstatSync(path).size;
  if (archiveBytes > policy.nativeCudaArchiveMaximum)
    throw new Error("CUDA candidate exceeds its archive-size budget.");
  const report = {
    schemaVersion: 1,
    kind: "cuda",
    recipeId: manifest.recipeId,
    runtimeVersion: manifest.runtimeVersion,
    target: manifest.target,
    contracts: manifest.contracts,
    llamaCpp: manifest.llamaCpp,
    cuda: manifest.cuda,
    archive: name,
    sha256: sha256File(path),
    archiveBytes,
    expandedBytes,
    manifestSha256: sha256File(resolve(runtimeRoot, cudaManifestPath))
  };
  writeFileSync(`${path}.sha256`, `${report.sha256}  ${name}\n`, {
    flag: "wx"
  });
  writeFileSync(
    resolve(outDir, "cuda-candidate.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" }
  );
  return report;
};
