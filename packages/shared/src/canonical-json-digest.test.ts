import { describe, expect, it } from "vitest";
import {
  crossIdentitySyncDigest,
  crossIdentitySyncDeterministicUuid
} from "./cross-identity-sync.js";
import {
  canonicalJsonDigest,
  canonicalJsonDeterministicUuid
} from "./canonical-json-digest.js";

describe("browser canonical identities", () => {
  it.each([
    null,
    { kind: "pending_share", mutationId: "trial-mutation" },
    { z: [true, false, 0, -0, 1e30], a: "Privacy café 🔒" },
    { nested: { b: 2, a: 1 }, text: "trial".repeat(1000) }
  ])("retains the server digest and UUID for %j", (value) => {
    expect(canonicalJsonDigest(value)).toBe(crossIdentitySyncDigest(value));
    expect(canonicalJsonDeterministicUuid(value)).toBe(
      crossIdentitySyncDeterministicUuid(value)
    );
  });
});
