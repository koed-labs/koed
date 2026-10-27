import { createHash } from "node:crypto";
import { canonicalComponentManifestBytes } from "./koed-server-package-lib.mjs";

// Self-pinned synthetic fixture only: not a production pin or publisher trust.
// Build once from the original bytes; never re-pin tampered input.
export function createSyntheticManifestCatalog(manifestBytes) {
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!canonicalComponentManifestBytes(manifest).equals(manifestBytes))
    throw new Error("Synthetic fixture manifest must be canonical");
  return {
    schemaVersion: 1,
    productVersion: manifest.productVersion,
    entries: [
      {
        component: manifest.component,
        target: manifest.target,
        manifestSha256: createHash("sha256").update(manifestBytes).digest("hex")
      }
    ]
  };
}
