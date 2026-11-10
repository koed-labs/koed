import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { sha256File } from "./koed-server-package-lib.mjs";
import { extractVerifiedPackageArchive } from "../packages/koed-server/dist/package-runtime.js";

export const extractFrozenComponents = async (
  releaseDir,
  components,
  privacyIdentity,
  destination
) => {
  if (!["privacy", "privacy-cpu", "privacy-cuda"].includes(privacyIdentity))
    throw new Error(`Invalid privacy component: ${privacyIdentity}`);
  for (const identity of ["base", privacyIdentity]) {
    const artifact = components[identity];
    if (
      !artifact ||
      typeof artifact.archive !== "string" ||
      basename(artifact.archive) !== artifact.archive
    )
      throw new Error(`Invalid component archive for ${identity}`);
    const archive = resolve(releaseDir, artifact.archive);
    if (sha256File(archive) !== artifact.archiveSha256)
      throw new Error(`Component archive checksum mismatch: ${identity}`);
    const target = resolve(
      destination,
      "components",
      identity === "base" ? "base" : "privacy"
    );
    mkdirSync(target, { recursive: true });
    await extractVerifiedPackageArchive(archive, target);
  }
};
