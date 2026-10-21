import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJsonStringify } from "./canonical-json.js";

/** The same canonical SHA-256 identity used by the server, without Node APIs.
 * Shared Desktop schemas run inside Electron's sandboxed preload as well. */
export const canonicalJsonDigest = (value: unknown): string =>
  bytesToHex(sha256(utf8ToBytes(canonicalJsonStringify(value))));

export const canonicalJsonDeterministicUuid = (value: unknown): string => {
  const digest = canonicalJsonDigest(value).slice(0, 32);
  const variant = ((Number.parseInt(digest[16]!, 16) & 3) | 8).toString(16);
  const hex = `${digest.slice(0, 12)}5${digest.slice(13, 16)}${variant}${digest.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
