import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createPdsAuthorizedKeyBundle,
  decryptPdsKeyBundleSecretSet,
  pdsFinalizedStatementHash,
  signPdsTwoStageFinal,
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

  it("constructs and decrypts production Key Bundle envelopes", () => {
    const signing = generateKeyPairSync("ed25519");
    const authority = generateKeyPairSync("ed25519");
    const recipient = generateKeyPairSync("x25519");
    const signingJwk = signing.publicKey.export({
      format: "jwk"
    }) as JsonWebKey;
    const authorityJwk = authority.publicKey.export({
      format: "jwk"
    }) as JsonWebKey;
    const recipientPublicJwk = recipient.publicKey.export({
      format: "jwk"
    }) as JsonWebKey;
    const recipientPrivateJwk = recipient.privateKey.export({
      format: "jwk"
    }) as JsonWebKey;
    const secrets = {
      epochSecret: Buffer.alloc(32, 1).toString("base64url"),
      sourceFingerprintKey: Buffer.alloc(32, 2).toString("base64url"),
      tombstoneFloorKey: Buffer.alloc(32, 3).toString("base64url"),
      projectAliasKey: Buffer.alloc(32, 4).toString("base64url")
    };
    const authorized = createPdsAuthorizedKeyBundle({
      groupId: "group-round-trip",
      epoch: "2",
      transitionKind: "add-device",
      recipients: [
        {
          recipientId: "device-round-trip",
          recipientKind: "device",
          recipientKemKeyId: "kem-round-trip",
          recipientKemPublicKey: recipientPublicJwk.x!
        }
      ],
      secrets,
      authorizationKeyId: "signing-round-trip",
      authorizationPrivateKey: signing.privateKey
    });
    const finalized = {
      ...authorized.bundle,
      authority: {
        keyId: "authority-round-trip",
        signature: signPdsTwoStageFinal(
          "key-bundle",
          authorized.bundle,
          authority.privateKey
        )
      }
    };
    expect(
      decryptPdsKeyBundleSecretSet({
        bundle: finalized,
        authorizationPublicKey: signingJwk.x!,
        authorityPublicKey: authorityJwk.x!,
        recipientId: "device-round-trip",
        recipientKemKeyId: "kem-round-trip",
        recipientKemPublicKey: recipientPublicJwk.x!,
        recipientKemPrivateSeed: recipientPrivateJwk.d!
      })
    ).toEqual(secrets);

    const altered: unknown = structuredClone(finalized);
    const alteredRecord = altered as {
      draft: { envelopes: Array<{ tag: string }> };
    };
    alteredRecord.draft.envelopes[0]!.tag = Buffer.alloc(16, 9).toString(
      "base64url"
    );
    expect(() =>
      decryptPdsKeyBundleSecretSet({
        bundle: altered,
        authorizationPublicKey: signingJwk.x!,
        authorityPublicKey: authorityJwk.x!,
        recipientId: "device-round-trip",
        recipientKemKeyId: "kem-round-trip",
        recipientKemPublicKey: recipientPublicJwk.x!,
        recipientKemPrivateSeed: recipientPrivateJwk.d!
      })
    ).toThrow();
  });

  it("uses locale-independent canonical ordering for mixed-case recipient IDs", () => {
    const signing = generateKeyPairSync("ed25519");
    const recipients = ["a-device", "B-device", "Z-device"].map(
      (recipientId) => {
        const key = generateKeyPairSync("x25519");
        const publicJwk = key.publicKey.export({
          format: "jwk"
        }) as JsonWebKey;
        return {
          recipientId,
          recipientKind: "device" as const,
          recipientKemKeyId: `${recipientId}-kem`,
          recipientKemPublicKey: publicJwk.x!
        };
      }
    );
    const authorized = createPdsAuthorizedKeyBundle({
      groupId: "group-mixed-case",
      epoch: "2",
      transitionKind: "add-device",
      recipients,
      secrets: {
        epochSecret: Buffer.alloc(32, 1).toString("base64url"),
        sourceFingerprintKey: Buffer.alloc(32, 2).toString("base64url"),
        tombstoneFloorKey: Buffer.alloc(32, 3).toString("base64url"),
        projectAliasKey: Buffer.alloc(32, 4).toString("base64url")
      },
      authorizationKeyId: "signing-mixed-case",
      authorizationPrivateKey: signing.privateKey
    });

    expect(authorized.bundle.draft.recipientSnapshot).toEqual([
      "B-device",
      "Z-device",
      "a-device"
    ]);
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
    ).toThrow("authorization key");
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
