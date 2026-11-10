import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
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

const macPostgresExecutables = new Set([
  "clusterdb",
  "createdb",
  "createuser",
  "dropdb",
  "dropuser",
  "ecpg",
  "initdb",
  "oid2name",
  "pg_amcheck",
  "pg_archivecleanup",
  "pg_basebackup",
  "pg_checksums",
  "pg_combinebackup",
  "pg_config",
  "pg_controldata",
  "pg_createsubscriber",
  "pg_ctl",
  "pg_dump",
  "pg_dumpall",
  "pg_isready",
  "pg_receivewal",
  "pg_recvlogical",
  "pg_resetwal",
  "pg_restore",
  "pg_rewind",
  "pg_test_fsync",
  "pg_test_timing",
  "pg_upgrade",
  "pg_verifybackup",
  "pg_waldump",
  "pg_walsummary",
  "pgbench",
  "postgres",
  "postmaster",
  "psql",
  "reindexdb",
  "vacuumdb",
  "vacuumlo"
]);
const macBinaryLocation = (path) =>
  (path.startsWith("postgres/bin/") &&
    macPostgresExecutables.has(path.slice("postgres/bin/".length))) ||
  (path.startsWith("postgres/lib/") && /\.(?:so|dylib)$/i.test(path)) ||
  (path.startsWith("llama.cpp/metal/") &&
    (path === "llama.cpp/metal/llama-server" || /\.dylib$/i.test(path)));

const postgresShareFiles = new Set([
  "errcodes.txt",
  "information_schema.sql",
  "pg_hba.conf.sample",
  "pg_ident.conf.sample",
  "pg_service.conf.sample",
  "postgres.bki",
  "postgresql.conf.sample",
  "psqlrc.sample",
  "snowball_create.sql",
  "sql_features.txt",
  "system_constraints.sql",
  "system_functions.sql",
  "system_views.sql"
]);
const macPostgresSharePath = (path, magic) => {
  const shared = path
    .slice("postgres/share/".length)
    .replace(/^postgresql\//, "");
  return (
    postgresShareFiles.has(shared) ||
    /^extension\/[\w.-]+\.(?:sql|control)$/.test(shared) ||
    (/^timezone\/[\w.+/-]+$/.test(shared) && magic === "545a6966") ||
    /^timezonesets\/(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Default|Etc|Europe|India|Indian|Pacific)(?:\.txt)?$/.test(
      shared
    ) ||
    /^tsearch_data\/[\w.-]+\.(?:stop|affix|dict|ths|syn|rules)$/.test(shared) ||
    /^man\/man[1-9]\/[\w.+-]+\.[1-9](?:\.gz)?$/.test(shared) ||
    /^locale\/[\w@.-]+\/LC_MESSAGES\/[\w.+-]+\.mo$/.test(shared) ||
    /^doc\/[\w./+-]+\.(?:html|css|png|svg|txt|pdf|example)$/.test(shared)
  );
};
const macDataPath = (path, magic) => {
  if (
    [
      "runtime-asset-manifest.json",
      "provenance.json",
      "README.koed-native-runtime.txt",
      "llama.cpp/llama-server"
    ].includes(path)
  )
    return true;
  if (path.startsWith("postgres/bin/"))
    return macPostgresExecutables.has(path.slice("postgres/bin/".length));
  if (path.startsWith("postgres/lib/"))
    return (
      /\.(?:so|dylib)$/i.test(path) ||
      /^postgres\/lib\/(?:postgresql\/)?pkgconfig\/[\w.-]+\.pc$/.test(path) ||
      /^postgres\/lib\/(?:postgresql\/)?pgxs\/config\/(?:install-sh|missing)$/.test(
        path
      )
    );
  if (path.startsWith("llama.cpp/metal/"))
    return /^llama\.cpp\/metal\/(?:llama-server|LICENSE|ggml-metal\.metal|[\w.+-]+\.dylib)$/.test(
      path
    );
  if (path.startsWith("third-party-licenses/"))
    return /(?:^|\/|__)(?:LICEN[CS]E|NOTICE|COPYING|COPYRIGHT)(?:[._-][\w.-]+)?$/i.test(
      path
    );
  return (
    path.startsWith("postgres/share/") && macPostgresSharePath(path, magic)
  );
};

const validateMacFile = (entry, path, mode) => {
  const fd = openSync(entry.path, "r");
  const header = Buffer.alloc(16);
  let length;
  try {
    length = readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  const magic = header.subarray(0, 4).toString("hex");
  const arm64 =
    length >= 16 &&
    magic === "cffaedfe" &&
    header.readUInt32LE(4) === 0x0100000c;
  const isLibrary = /\.(?:so|dylib)$/i.test(path);
  const fileTypeValid =
    arm64 &&
    (isLibrary
      ? [6, 8].includes(header.readUInt32LE(12))
      : header.readUInt32LE(12) === 2);
  const macho = [
    "cffaedfe",
    "feedfacf",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
    "cefaedfe",
    "feedface"
  ].includes(magic);
  const foreign =
    magic === "7f454c46" ||
    header.subarray(0, 2).toString() === "MZ" ||
    /\.(?:exe|dll|so\.\d+(?:\.\d+)*)$/i.test(path) ||
    /(?:^|\/)libcu(?:da|blas|dart)/i.test(path);
  const script =
    (path === "llama.cpp/llama-server" ||
      /^postgres\/lib\/(?:postgresql\/)?pgxs\/config\/(?:install-sh|missing)$/.test(
        path
      )) &&
    header.subarray(0, 2).toString() === "#!";
  if (!macDataPath(path, magic))
    throw new Error(`Unexpected macOS payload file: ${path}`);
  if (
    foreign ||
    (macho && (!fileTypeValid || !macBinaryLocation(path))) ||
    (isLibrary && !fileTypeValid) ||
    (path.startsWith("postgres/bin/") && !fileTypeValid) ||
    ((mode & 0o111) !== 0 && !arm64 && !script)
  )
    throw new Error(`Invalid macOS native file or executable: ${path}`);
};

export const coreInventory = (
  runtimeRoot,
  platform = "linux",
  { desktop = false } = {}
) => {
  const root = realpathSync(runtimeRoot);
  const entries = deterministicArchiveEntries(root).filter(
    (entry) => desktop || entry.relativePath !== coreManifestName
  );
  const occupied = new Set();
  if (platform === "macos") {
    for (const entry of entries) {
      if (entry.type === "directory") continue;
      let parent = dirname(entry.relativePath);
      while (parent !== ".") {
        occupied.add(parent);
        parent = dirname(parent);
      }
    }
  }
  return entries.map((entry) => {
    const path = entry.relativePath.replace(/\/$/, "");
    if (
      !(
        path === "postgres" ||
        path.startsWith("postgres/") ||
        path === "llama.cpp" ||
        path === "llama.cpp/llama-server" ||
        path === `llama.cpp/${platform === "macos" ? "metal" : "cpu"}` ||
        path.startsWith(
          `llama.cpp/${platform === "macos" ? "metal" : "cpu"}/`
        ) ||
        (platform === "macos" &&
          (path === "third-party-licenses" ||
            path.startsWith("third-party-licenses/"))) ||
        path === "runtime-asset-manifest.json" ||
        (platform === "macos" &&
          desktop &&
          (path === "provenance.json" ||
            path === "README.koed-native-runtime.txt"))
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
      if (
        platform === "macos" &&
        (path.startsWith("llama.cpp/metal/") || !occupied.has(path))
      )
        throw new Error(`Unexpected macOS native directory: ${path}`);
      if (mode !== 0o755)
        throw new Error(`Native directory mode must be 0755: ${path}`);
      return { path, type: "directory", mode };
    }
    if (entry.type === "file") {
      if (platform === "macos") validateMacFile(entry, path, mode);
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
    if (platform === "macos")
      validateMacFile(
        { path: destination },
        path,
        lstatSync(destination).mode & 0o777
      );
    return { path, type: "symlink", mode, target };
  });
};

export const assertMacLicenses = (runtimeRoot, inventory) => {
  for (const path of [
    "third-party-licenses/openssl/LICENSE.txt",
    "third-party-licenses/postgres/COPYRIGHT",
    "third-party-licenses/pgvector/LICENSE",
    "llama.cpp/metal/LICENSE"
  ]) {
    const entry = inventory.find((item) => item.path === path);
    if (
      entry?.type !== "file" ||
      entry.bytes === 0 ||
      !readFileSync(resolve(runtimeRoot, path), "utf8").trim()
    )
      throw new Error(`Missing or empty macOS license: ${path}`);
  }
};

const assertCoreMetadata = (metadata) => {
  if (
    metadata?.schemaVersion !== 1 ||
    metadata.kind !== "core" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      metadata.runtimeVersion ?? ""
    ) ||
    !(metadata.target?.platform === "linux"
      ? metadata.target.architecture === "x64" &&
        metadata.target.libc?.family === "glibc" &&
        metadata.target.libc.minimumVersion === "2.35"
      : metadata.target?.platform === "macos" &&
        metadata.target.architecture === "arm64" &&
        metadata.target.minimumVersion === "14.0" &&
        !Object.hasOwn(metadata.target, "libc")) ||
    metadata.contracts?.layout !== 1 ||
    metadata.contracts.postgres !== 1 ||
    metadata.contracts.embedding !== 1 ||
    (metadata.target?.platform === "linux" &&
      !/^[a-f0-9]{40}$/.test(metadata.components?.llamaCpp?.revision ?? "")) ||
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
    (metadata.target.platform === "linux" &&
      recipe.configuration.llamaCppRevision !==
        metadata.components.llamaCpp.revision) ||
    recipe.sources?.postgres?.version !==
      metadata.components.postgres.version ||
    metadata.components.postgres.major !== 17 ||
    recipe.sources?.pgvector?.version !==
      metadata.components.pgvector.version ||
    recipe.sources?.llamaCpp?.version !==
      metadata.components.llamaCpp.version ||
    Object.keys(recipe.sources).sort().join(",") !==
      (metadata.target.platform === "macos"
        ? "llamaCpp,openssl,pgvector,postgres"
        : "llamaCpp,pgvector,postgres")
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
        ...(configuration.target.platform === "linux"
          ? { revision: configuration.llamaCppRevision }
          : {})
      }
    },
    recipeId: coreRecipeId(recipe),
    recipe,
    inventory: coreInventory(runtimeRoot, configuration.target.platform)
  };
  assertCoreMetadata(manifest);
  writeFileSync(
    resolve(runtimeRoot, coreManifestName),
    `${canonicalArtifactJson(manifest)}\n`,
    { flag: "wx", mode: 0o644 }
  );
  return manifest;
};

const inventoryMismatchDetails = (expected, actual) => {
  if (
    !Array.isArray(expected) ||
    expected.some(
      (entry) =>
        !entry || typeof entry !== "object" || typeof entry.path !== "string"
    )
  )
    return " Invalid manifest inventory.";
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const paths = [
    ...new Set([...expectedByPath.keys(), ...actualByPath.keys()])
  ].sort();
  const differences = [];
  for (const path of paths) {
    const before = expectedByPath.get(path);
    const after = actualByPath.get(path);
    let detail;
    if (!before) detail = "unexpected";
    else if (!after) detail = "missing";
    else if (canonicalArtifactJson(before) !== canonicalArtifactJson(after)) {
      const fields = ["type", "mode", "bytes", "sha256", "target"];
      const changed = fields.filter((field) => before[field] !== after[field]);
      detail = `changed ${changed.join(", ") || "other fields"}`;
    }
    if (detail) {
      if (differences.length === 10)
        return ` ${differences.join("; ")}; diagnostics truncated`;
      const encodedPath = JSON.stringify(path);
      differences.push(
        `${encodedPath.length > 200 ? `${encodedPath.slice(0, 200)}...` : encodedPath}: ${detail}`
      );
    }
  }
  return differences.length ? ` ${differences.join("; ")}` : "";
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
  const actualInventory = coreInventory(runtimeRoot, manifest.target.platform);
  if (
    canonicalArtifactJson(manifest.inventory) !==
      canonicalArtifactJson(actualInventory) ||
    (manifest.target.platform === "macos" &&
      manifest.recipe.frozenInventorySha256 !==
        coreRecipeId(manifest.inventory))
  )
    throw new Error(
      `Native core inventory changed after freezing.${inventoryMismatchDetails(manifest.inventory, actualInventory)}`
    );
  if (manifest.target.platform === "macos")
    assertMacLicenses(runtimeRoot, manifest.inventory);
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
    `llama.cpp/${manifest.target.platform === "macos" ? "metal" : "cpu"}/llama-server`
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
  const name = `koed-native-core-${manifest.recipeId}-${manifest.target.platform}-${manifest.target.architecture}.tar.gz`;
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
