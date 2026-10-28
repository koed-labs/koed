#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const decideAssetAction = ({ expectedSha256, actualSha256 }) => {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? ""))
    throw new Error("Expected asset SHA-256 is invalid.");
  if (actualSha256 === null) return { action: "upload" };
  return { action: actualSha256 === expectedSha256 ? "skip" : "block" };
};

const gh = (args, options = {}) => {
  const result = spawnSync("gh", args, {
    encoding: options.binary ? null : "utf8",
    maxBuffer: 1024 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `gh ${args[0]} failed: ${result.stderr?.trim() ?? result.status}`
    );
  return result.stdout;
};
const hashStream = async (stream) => {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
};

const hashRemoteAsset = async (repository, assetId) => {
  const child = spawn(
    "gh",
    [
      "api",
      "--header",
      "Accept: application/octet-stream",
      `repos/${repository}/releases/assets/${assetId}`
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  const exit = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolveExit();
      else reject(new Error(`gh asset download failed: ${signal ?? code}`));
    });
  });
  try {
    const [digest] = await Promise.all([hashStream(child.stdout), exit]);
    return digest;
  } catch (error) {
    child.kill();
    throw error;
  }
};

const main = async () => {
  const [tag, ...paths] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  if (!tag || !repository || paths.length === 0)
    throw new Error(
      "Usage: ensure-release-assets <tag> <file...> (requires GITHUB_REPOSITORY)."
    );
  // The releases/tags/{tag} endpoint only resolves published releases, so
  // drafts must be found by listing releases and matching tag_name.
  const matches = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/releases?per_page=100`
    ])
  )
    .flat()
    .filter((candidate) => candidate.tag_name === tag);
  if (matches.length > 1)
    throw new Error(`Release ${tag} is ambiguous: ${matches.length} matches.`);
  const [release] = matches;
  if (release?.draft !== true)
    throw new Error(`Release ${tag} must exist as matching draft.`);
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const input of paths) {
    const path = resolve(input);
    const name = basename(path);
    const expectedSha256 = await hashStream(createReadStream(path));
    const existing = assets.get(name);
    if (existing) {
      const actualSha256 = await hashRemoteAsset(repository, existing.id);
      const action = decideAssetAction({ expectedSha256, actualSha256 });
      if (action.action === "block")
        throw new Error(
          `Existing release asset differs from expected bytes: ${name}`
        );
      console.log(`Verified existing asset ${name}`);
      continue;
    }
    gh(["release", "upload", tag, path, "--repo", repository]);
    console.log(`Uploaded missing asset ${name}`);
  }
};

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
