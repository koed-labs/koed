import { createHash } from "node:crypto";

// v2 signs this domain followed by the raw 32-byte digest, never its hex text.
export const componentManifestSigningBytes = (canonicalManifestBytes) =>
  Buffer.concat([
    Buffer.from("koed-component-manifest-sha256-v2\n", "utf8"),
    createHash("sha256").update(canonicalManifestBytes).digest()
  ]);
