import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  certificateIsPdsValid,
  pdsFinalizedStatementHash,
  validatePdsGroupStatement,
  validatePdsKeyBundle
} from "./personal-device-sync.js";
import { parseCanonicalPdsJson } from "./personal-device-sync-jcs.js";

type SignedFixture = {
  canonicalPayloadUtf8: string;
  recordHash: string;
  plans: Array<{ publicKeyHex: string }>;
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/personal-device-sync-v1.json", import.meta.url),
    "utf8"
  )
) as {
  signedRecords: Record<string, SignedFixture> & {
    genesis: SignedFixture;
    addDevice: SignedFixture;
    keyBundle: SignedFixture;
    membershipCertificate: SignedFixture;
  };
};
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

const publicKeys = (record: SignedFixture) => ({
  authorizationPublicKey: b64(record.plans[0]!.publicKeyHex),
  authorityPublicKey: b64(record.plans[1]!.publicKeyHex)
});

describe("PDS group authority verification", () => {
  const genesisFixture = fixture.signedRecords.genesis;
  const addDeviceFixture = fixture.signedRecords.addDevice;
  const keyBundleFixture = fixture.signedRecords.keyBundle;
  const certificateFixture = fixture.signedRecords.membershipCertificate;

  it("accepts the coherent genesis, add-device, and Key Bundle vectors", () => {
    const genesis = validatePdsGroupStatement(
      parseCanonicalPdsJson(genesisFixture.canonicalPayloadUtf8),
      {
        ...publicKeys(genesisFixture),
        expectedGroupId: "group-fixture-01",
        expectedPreviousHash: null,
        expectedSequence: "1",
        expectedAuthorizationKeyId: "device-initial-signing",
        expectedAuthorityKeyId: "authority-fixture"
      }
    );
    expect(pdsFinalizedStatementHash(genesis)).toBe(genesisFixture.recordHash);

    const addDevice = validatePdsGroupStatement(
      parseCanonicalPdsJson(addDeviceFixture.canonicalPayloadUtf8),
      {
        ...publicKeys(addDeviceFixture),
        expectedGroupId: "group-fixture-01",
        expectedPreviousHash: genesisFixture.recordHash,
        expectedSequence: "2",
        expectedAuthorizationKeyId: "device-initial-signing",
        expectedAuthorityKeyId: "authority-fixture"
      }
    );
    expect(pdsFinalizedStatementHash(addDevice)).toBe(
      addDeviceFixture.recordHash
    );

    const rawBundle = parseCanonicalPdsJson(
      keyBundleFixture.canonicalPayloadUtf8
    ) as {
      draft: {
        envelopes: Array<{
          recipientId: string;
          recipientKind: "device" | "recovery";
          recipientKemKeyId: string;
        }>;
      };
    };
    const bundle = validatePdsKeyBundle(rawBundle, {
      ...publicKeys(keyBundleFixture),
      expectedAuthorizationKeyId: "device-initial-signing",
      expectedAuthorityKeyId: "authority-fixture",
      expectedRecipients: rawBundle.draft.envelopes.map((envelope) => ({
        recipientId: envelope.recipientId,
        recipientKind: envelope.recipientKind,
        recipientKemKeyId: envelope.recipientKemKeyId
      }))
    });
    expect(bundle.hash).toBe(keyBundleFixture.recordHash);
    expect(addDevice.draft.body).toMatchObject({ keyBundleHash: bundle.hash });
  });

  it("rejects unestablished genesis keys, fork bytes, malformed base64url, and incomplete envelopes", () => {
    const genesis = JSON.parse(genesisFixture.canonicalPayloadUtf8) as Record<
      string,
      unknown
    >;
    expect(() =>
      validatePdsGroupStatement(genesis, {
        authorizationPublicKey: b64(genesisFixture.plans[1]!.publicKeyHex),
        authorityPublicKey: b64(genesisFixture.plans[1]!.publicKeyHex)
      })
    ).toThrow("genesis authorization signer");
    expect(() =>
      validatePdsGroupStatement(genesis, {
        ...publicKeys(genesisFixture),
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

    (
      genesis.draft as { body: Record<string, unknown> }
    ).body.authorityPublicKey = "not+base64url";
    expect(() =>
      validatePdsGroupStatement(genesis, {
        ...publicKeys(genesisFixture)
      })
    ).toThrow("base64url");
  });

  it("rejects unknown bundles, unverified recovery, and invalid certificate lifetimes", () => {
    const bundle = JSON.parse(keyBundleFixture.canonicalPayloadUtf8) as {
      draft: { version: string };
    };
    bundle.draft.version = "2";
    expect(() =>
      validatePdsKeyBundle(bundle, {
        authorizationPublicKey: b64(keyBundleFixture.plans[0]!.publicKeyHex)
      })
    ).toThrow("metadata");

    const genesis = JSON.parse(genesisFixture.canonicalPayloadUtf8) as {
      draft: { body: { recoveryKitVerified: boolean } };
    };
    genesis.draft.body.recoveryKitVerified = false;
    expect(() =>
      validatePdsGroupStatement(genesis, {
        ...publicKeys(genesisFixture)
      })
    ).toThrow("verified recovery kit");

    const certificate = JSON.parse(
      certificateFixture.canonicalPayloadUtf8
    ) as Record<string, unknown>;
    const authorityPublicKey = b64(certificateFixture.plans[0]!.publicKeyHex);
    expect(
      certificateIsPdsValid(
        certificate,
        authorityPublicKey,
        "authority-fixture",
        new Date("2026-07-15T00:01:00.000Z")
      )
    ).toBe(true);
    expect(
      certificateIsPdsValid(
        certificate,
        authorityPublicKey,
        "authority-fixture",
        new Date("2026-07-15T00:06:00.000Z")
      )
    ).toBe(false);
    expect(
      certificateIsPdsValid(
        {
          ...certificate,
          expiresAt: certificate.issuedAt
        },
        authorityPublicKey,
        "authority-fixture",
        new Date("2026-07-15T00:00:00.000Z")
      )
    ).toBe(false);
    expect(
      certificateIsPdsValid(
        {
          ...certificate,
          issuedAt: "2026-07-15T00:05:00.000Z",
          expiresAt: "2026-07-15T00:04:00.000Z"
        },
        authorityPublicKey,
        "authority-fixture",
        new Date("2026-07-15T00:00:00.000Z")
      )
    ).toBe(false);
    expect(
      certificateIsPdsValid(
        {
          ...certificate,
          authoritySignature: {
            ...(certificate.authoritySignature as Record<string, unknown>),
            keyId: "attacker-key"
          }
        },
        authorityPublicKey,
        "authority-fixture",
        new Date("2026-07-15T00:01:00.000Z")
      )
    ).toBe(false);
  });
});
