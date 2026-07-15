import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  pdsFinalizedStatementHash,
  validatePdsGroupStatement,
  validatePdsKeyBundle
} from "./personal-device-sync.js";
import { parseCanonicalPdsJson } from "./personal-device-sync-jcs.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/personal-device-sync-v1.json", import.meta.url),
    "utf8"
  )
) as {
  signedRecords: Record<
    string,
    {
      canonicalPayloadUtf8: string;
      recordHash: string;
      plans: Array<{ publicKeyHex: string }>;
    }
  >;
};
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

describe("PDS group authority verification", () => {
  const groupFixture = fixture.signedRecords.groupStatement!;
  const keyBundleFixture = fixture.signedRecords.keyBundle!;

  it("accepts fixed group vector and rejects legacy unbound key-bundle envelopes", () => {
    const statement = parseCanonicalPdsJson(groupFixture.canonicalPayloadUtf8);
    const group = validatePdsGroupStatement(statement, {
      authorizationPublicKey: b64(groupFixture.plans[0]!.publicKeyHex),
      authorityPublicKey: b64(groupFixture.plans[1]!.publicKeyHex),
      expectedGroupId: "group-fixture-01",
      expectedPreviousHash: null,
      expectedSequence: "1"
    });
    expect(pdsFinalizedStatementHash(group)).toBe(groupFixture.recordHash);
    expect(() =>
      validatePdsKeyBundle(
        parseCanonicalPdsJson(keyBundleFixture.canonicalPayloadUtf8),
        {
          authorizationPublicKey: b64(keyBundleFixture.plans[0]!.publicKeyHex),
          authorityPublicKey: b64(keyBundleFixture.plans[1]!.publicKeyHex)
        }
      )
    ).toThrow("envelope");
  });

  it("rejects wrong domain key, same-sequence fork bytes, malformed base64url, and incomplete envelope snapshot", () => {
    const group = JSON.parse(groupFixture.canonicalPayloadUtf8) as Record<
      string,
      unknown
    >;
    expect(() =>
      validatePdsGroupStatement(group, {
        authorizationPublicKey: b64(groupFixture.plans[1]!.publicKeyHex),
        authorityPublicKey: b64(groupFixture.plans[1]!.publicKeyHex)
      })
    ).toThrow("authorization signature");
    expect(() =>
      validatePdsGroupStatement(group, {
        authorizationPublicKey: b64(groupFixture.plans[0]!.publicKeyHex),
        authorityPublicKey: b64(groupFixture.plans[1]!.publicKeyHex),
        expectedSequence: "2"
      })
    ).toThrow("sequence");
    const bundle = JSON.parse(keyBundleFixture.canonicalPayloadUtf8) as {
      draft: { recipientSnapshot: string[]; envelopes: unknown[] };
    };
    bundle.draft.envelopes.pop();
    expect(() =>
      validatePdsKeyBundle(bundle, {
        authorizationPublicKey: b64(keyBundleFixture.plans[0]!.publicKeyHex)
      })
    ).toThrow("recipients");
    (group.draft as { body: Record<string, unknown> }).body.authorityPublicKey =
      "not+base64url";
    expect(() =>
      validatePdsGroupStatement(group, {
        authorizationPublicKey: b64(groupFixture.plans[0]!.publicKeyHex)
      })
    ).toThrow("base64url");
  });
});
