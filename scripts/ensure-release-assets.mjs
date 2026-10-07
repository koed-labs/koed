#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

const main = () => {
  const [tag, ...paths] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  if (!tag || !repository || paths.length === 0)
    throw new Error(
      "Usage: ensure-release-assets <tag> <file...> (requires GITHUB_REPOSITORY)."
    );
  const release = JSON.parse(
    gh(["api", `repos/${repository}/releases/tags/${tag}`])
  );
  if (release.tag_name !== tag || release.draft !== true)
    throw new Error(`Release ${tag} must exist as matching draft.`);
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const input of paths) {
    const path = resolve(input);
    const name = basename(path);
    const expectedSha256 = hash(readFileSync(path));
    const existing = assets.get(name);
    if (existing) {
      const bytes = gh(
        [
          "api",
          "--header",
          "Accept: application/octet-stream",
          `repos/${repository}/releases/assets/${existing.id}`
        ],
        { binary: true }
      );
      const action = decideAssetAction({
        expectedSha256,
        actualSha256: hash(bytes)
      });
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
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
