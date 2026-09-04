#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateReleaseArtifactMetadata } from "./write-koed-release-artifact-metadata.mjs";

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--metadata") options.metadata = argv[++index];
    else if (value === "--release") options.release = argv[++index];
    else if (value === "--json") options.json = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!options.help && (!options.metadata || !options.release)) {
    throw new Error("Provide --metadata and --release.");
  }
  return options;
};

const referencedAssets = (metadata) =>
  [
    ...(metadata.artifacts?.koedServerAppRuntime?.targets ?? []),
    ...(metadata.artifacts?.nativeRuntime?.targets ?? [])
  ].flatMap((target) =>
    [
      target.archive,
      target.checksum,
      target.manifest,
      target.provenance,
      target.provenance?.signature?.name
        ? target.provenance.signature
        : undefined
    ].filter(Boolean)
  );

const canonicalPublishedUrl = ({ draftUrl, tag, name }) => {
  let url;
  try {
    url = new URL(draftUrl);
  } catch {
    return undefined;
  }
  const segments = url.pathname.split("/");
  const releasesIndex = segments.findIndex(
    (segment, index) =>
      segment === "releases" && segments[index + 1] === "download"
  );
  const releaseSegmentIndex = releasesIndex + 2;
  const assetSegmentIndex = releasesIndex + 3;
  if (
    releasesIndex < 2 ||
    assetSegmentIndex !== segments.length - 1 ||
    decodeURIComponent(segments[assetSegmentIndex]) !== name
  ) {
    return undefined;
  }
  const releaseSegment = decodeURIComponent(segments[releaseSegmentIndex]);
  // GitHub uses a temporary untagged-* target until a draft is published.
  if (releaseSegment !== tag && !/^untagged-[0-9a-f]+$/.test(releaseSegment)) {
    return undefined;
  }
  segments[releaseSegmentIndex] = encodeURIComponent(tag);
  url.pathname = segments.join("/");
  url.search = "";
  url.hash = "";
  return url.href;
};

export const validatePublishedReleaseAssets = ({ metadata, release }) => {
  validateReleaseArtifactMetadata(metadata, {
    version: metadata.release?.version,
    tag: metadata.release?.tag
  });
  if (release.tag_name !== metadata.release.tag || release.draft !== true) {
    throw new Error("Published draft release identity is inconsistent.");
  }
  if (!Array.isArray(release.assets)) {
    throw new Error("Published draft release assets are missing.");
  }
  const assets = new Map();
  for (const asset of release.assets) {
    if (typeof asset?.name !== "string" || assets.has(asset.name)) {
      throw new Error(`Duplicate or invalid published asset: ${asset?.name}`);
    }
    assets.set(asset.name, asset);
  }
  const verified = [];
  for (const reference of referencedAssets(metadata)) {
    const asset = assets.get(reference.name);
    if (!asset)
      throw new Error(`Published asset is missing: ${reference.name}`);
    if (
      asset.state !== "uploaded" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    ) {
      throw new Error(`Published asset is incomplete: ${reference.name}`);
    }
    if (
      canonicalPublishedUrl({
        draftUrl: asset.browser_download_url,
        tag: metadata.release.tag,
        name: reference.name
      }) !== reference.url
    ) {
      throw new Error(`Published asset URL mismatch: ${reference.name}`);
    }
    verified.push({
      name: reference.name,
      size: asset.size,
      url: reference.url
    });
  }
  return { ok: true, tag: release.tag_name, verified };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: validate-published-release-assets --metadata <metadata.json> --release <github-release.json> [--json]"
    );
    return;
  }
  const result = validatePublishedReleaseAssets({
    metadata: JSON.parse(readFileSync(resolve(options.metadata), "utf8")),
    release: JSON.parse(readFileSync(resolve(options.release), "utf8"))
  });
  console.log(
    options.json
      ? JSON.stringify(result)
      : `Verified ${result.verified.length} published release assets.`
  );
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
