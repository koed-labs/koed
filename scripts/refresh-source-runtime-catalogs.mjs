import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "oxfmt";
import { compareNativeVersions } from "../packages/koed-server/dist/native-runtime-catalog.js";
import { createCandidateReaders } from "./release-candidate-readers.mjs";
import { verifyDraftNativePins } from "./native-runtime-pins.mjs";
import {
  NativeCompatibilityError,
  releaseRoot,
  releaseVersion,
  sourceCatalogPath,
  sourceNativeCatalog
} from "./source-native-catalog.mjs";

const repository = "koed-labs/koed";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stable = (release) =>
  release.draft === false &&
  release.prerelease === false &&
  typeof release.published_at === "string" &&
  Number.isSafeInteger(release.id) &&
  release.id > 0 &&
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name ?? "");

const releaseIdentity = (release) => ({
  id: release.id,
  tag: release.tag_name,
  draft: release.draft,
  prerelease: release.prerelease,
  publishedAt: release.published_at,
  assets: release.assets
    .map(({ id, name, state, size, digest, browser_download_url }) => ({
      id,
      name,
      state,
      size,
      digest,
      browser_download_url
    }))
    .sort((a, b) => a.id - b.id)
});

function assetFor(release, name, maximum) {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1)
    throw new Error(`Missing or duplicate published asset: ${name}`);
  const asset = matches[0];
  if (
    asset.state !== "uploaded" ||
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > maximum ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") ||
    asset.browser_download_url !== `${releaseRoot}${release.tag_name}/${name}`
  )
    throw new Error(`Invalid published asset identity or digest: ${name}`);
  return asset;
}

async function download(readers, asset, path) {
  const digest = createHash("sha256");
  let size = 0;
  const stream = await readers.getAsset(repository, asset.id);
  const fd = openSync(path, "wx", 0o600);
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > asset.size)
        throw new Error(`Asset exceeds published size: ${asset.name}`);
      digest.update(chunk);
      writeFileSync(fd, chunk);
    }
  } finally {
    closeSync(fd);
  }
  if (size !== asset.size || `sha256:${digest.digest("hex")}` !== asset.digest)
    throw new Error(`Published asset checksum/size mismatch: ${asset.name}`);
}

export async function refreshSourceRuntimeCatalogs({
  repoRoot,
  tag,
  readers = createCandidateReaders()
}) {
  if (tag) releaseVersion(tag);
  const version = readJson(resolve(repoRoot, "package.json")).version;
  const policy = readJson(
    resolve(
      repoRoot,
      "scripts/native-runtime/core-compatibility.linux-x64.json"
    )
  );
  if (policy.schemaVersion !== 1)
    throw new Error("Invalid native compatibility policy.");
  const destination = resolve(repoRoot, sourceCatalogPath);
  const previous = existsSync(destination) ? readJson(destination) : null;
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await readers.listReleases(repository, page);
    if (!Array.isArray(batch))
      throw new Error("Invalid GitHub release listing.");
    releases.push(...batch.filter(stable));
    if (batch.length < 100) break;
    if (page === 10)
      throw new Error("Release listing exceeded the refresh limit.");
  }
  const candidates = releases
    .filter(
      (release) =>
        (!tag || release.tag_name === tag) &&
        compareNativeVersions(releaseVersion(release.tag_name), version) <= 0
    )
    .sort((a, b) =>
      compareNativeVersions(
        releaseVersion(b.tag_name),
        releaseVersion(a.tag_name)
      )
    );
  mkdirSync(resolve(repoRoot, "scratch"), { recursive: true });
  const temporary = mkdtempSync(
    resolve(repoRoot, "scratch/source-catalog-refresh-")
  );
  try {
    for (const listed of candidates) {
      const release = await readers.getRelease(repository, listed.id);
      if (
        !stable(release) ||
        release.id !== listed.id ||
        release.tag_name !== listed.tag_name ||
        !Array.isArray(release.assets)
      )
        throw new Error("Published release identity changed during refresh.");
      // Older releases predate separate native archives. They cannot supply pins.
      if (
        !release.assets.some(
          (asset) => asset.name === "native-runtime-catalog.json"
        )
      )
        continue;
      const catalogAsset = assetFor(
        release,
        "native-runtime-catalog.json",
        1024 * 1024
      );
      const root = resolve(temporary, String(release.id));
      mkdirSync(root);
      const catalogPath = resolve(root, catalogAsset.name);
      await download(readers, catalogAsset, catalogPath);
      const document = {
        schemaVersion: 2,
        sourceRelease: release.tag_name,
        provenance: {
          releaseId: release.id,
          nativeCatalogAssetId: catalogAsset.id,
          nativeCatalogUrl: catalogAsset.browser_download_url,
          nativeCatalogSha256: catalogAsset.digest.slice(7)
        },
        native: readJson(catalogPath)
      };
      try {
        sourceNativeCatalog(document, policy.minimumCoreVersion);
      } catch (error) {
        if (!tag && error instanceof NativeCompatibilityError) continue;
        throw error;
      }
      const assets = [];
      for (const kind of ["core", "cuda"]) {
        const pin = document.native[kind];
        const archive = assetFor(
          release,
          `koed-native-${kind}-${pin.recipeId}-linux-x64.tar.gz`,
          kind === "core" ? 50_000_000 : 750_000_000
        );
        const manifest = assetFor(
          release,
          `native-${kind}-manifest.json`,
          8 * 1024 * 1024
        );
        if (
          archive.digest !== `sha256:${pin.sha256}` ||
          archive.size !== pin.archiveBytes ||
          manifest.digest !== `sha256:${pin.manifestSha256}`
        )
          throw new Error(
            `Published ${kind} assets disagree with their catalog pins.`
          );
        assets.push(archive, manifest);
      }
      if (previous?.sourceRelease === document.sourceRelease) {
        assert.deepEqual(
          document,
          previous,
          "An already-reviewed release changed; refusing to replace its pins."
        );
        return { state: "current", sourceRelease: document.sourceRelease };
      }
      if (
        previous &&
        compareNativeVersions(
          releaseVersion(document.sourceRelease),
          releaseVersion(previous.sourceRelease)
        ) < 0
      )
        throw new Error(
          "Refusing to downgrade the reviewed source runtime release."
        );
      for (const asset of assets)
        await download(readers, asset, resolve(root, asset.name));
      verifyDraftNativePins(document.native, {
        root,
        version: releaseVersion(document.sourceRelease),
        assets: assets.map((asset) => ({
          name: asset.name,
          sha256: asset.digest.slice(7)
        }))
      });
      // Re-read metadata so a release edited during the transfer cannot commit
      // a mixture of observations. No downloaded executable is ever evaluated.
      const current = await readers.getRelease(repository, release.id);
      assert.deepEqual(
        releaseIdentity(current),
        releaseIdentity(release),
        "Published release changed while downloading assets."
      );
      const formatted = await format(
        sourceCatalogPath,
        JSON.stringify(document, null, 2),
        { printWidth: 80 }
      );
      if (formatted.errors.length)
        throw new Error("Cannot format refreshed source pins.");
      assert.deepEqual(
        existsSync(destination) ? readJson(destination) : null,
        previous,
        "Source pins changed during refresh."
      );
      const output = `${destination}.${process.pid}.tmp`;
      try {
        writeFileSync(output, formatted.code);
        renameSync(output, destination);
      } finally {
        rmSync(output, { force: true });
      }
      return {
        state: "updated",
        sourceRelease: document.sourceRelease,
        catalogSha256: hash(readFileSync(catalogPath))
      };
    }
    throw new Error(
      "No published native CPU/CUDA catalog satisfies the checkout's compatibility policy."
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length && (args.length !== 2 || args[0] !== "--release"))
    throw new Error(
      "Usage: refresh-source-runtime-catalogs.mjs [--release vX.Y.Z]"
    );
  console.log(
    JSON.stringify(
      await refreshSourceRuntimeCatalogs({
        repoRoot: resolve(import.meta.dirname, ".."),
        tag: args[1]
      })
    )
  );
}
