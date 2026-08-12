import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createByokEnvelopeEncryptionProvider,
  createCmekEnvelopeEncryptionProvider,
  createEncryptedJsonPackage,
  createEnvelopeEncryptionProviderFromEnvironment,
  createHttpManagedKmsKeyring,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createManagedKmsEnvelopeEncryptionProvider,
  createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment,
  createRecipientPrivateKeyEnvelopeEncryptionProvider,
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  createUnsupportedEnvelopeEncryptionProvider,
  decryptEncryptedJsonPackage,
  decryptEnvelopeToUtf8,
  ENCRYPTED_PAYLOAD_ALGORITHM,
  ENCRYPTED_PAYLOAD_ENVELOPE_VERSION,
  ENCRYPTED_PAYLOAD_KEY_WRAP_ALGORITHM,
  ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM,
  ENCRYPTED_PAYLOAD_MANAGED_KMS_KEY_WRAP_ALGORITHM,
  EnvelopeEncryptionError,
  generateRecipientKeyMaterial,
  InvalidEncryptedPayloadEnvelopeError,
  ManagedKmsProviderError,
  RecipientKeyTransportError,
  redactEnvelopeEncryptionProviderStatus,
  requireApiDataEncryptionKey,
  resolveApiDataEncryptionKeyFromEnv,
  UnsupportedEnvelopeEncryptionProviderError,
  validateEnvelopeEncryptionProviderEnvironment,
  type EncryptedPayloadEnvelope,
  type ManagedKmsKeyring
} from "./index.js";

const generatedRootKey = (): string => randomBytes(32).toString("base64");
const base64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

const createManagedTestKeyring = ({
  currentVersion,
  keys,
  keyId = "managed-kms:fixture-tenant-key",
  fail = false,
  statusDetails = {}
}: {
  currentVersion: number;
  keys: Record<number, Buffer>;
  keyId?: string;
  fail?: boolean;
  statusDetails?: Record<string, string>;
}): ManagedKmsKeyring => ({
  keyId,
  keyVersion: currentVersion,
  wrapDek(input) {
    if (fail) {
      throw new Error("kms unavailable");
    }
    const key = keys[input.keyVersion];
    if (!key) {
      throw new Error("unknown kms key version");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(input.aad);
    const ciphertext = Buffer.concat([
      cipher.update(input.dek),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: base64(ciphertext),
      nonce: base64(nonce),
      tag: base64(tag)
    };
  },
  unwrapDek(input) {
    if (fail) {
      throw new Error("kms unavailable");
    }
    const key = keys[input.keyVersion];
    if (!key) {
      throw new Error("unknown kms key version");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(input.wrappedDek.nonce, "base64")
    );
    decipher.setAAD(input.aad);
    decipher.setAuthTag(Buffer.from(input.wrappedDek.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(input.wrappedDek.ciphertext, "base64")),
      decipher.final()
    ]);
  },
  status() {
    return {
      mode: "managed_kms",
      keyId,
      keyVersion: currentVersion,
      status: fail ? "degraded" : "available",
      details: statusDetails
    };
  }
});

const encryptFixture = async (key = generatedRootKey()) => {
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(key);
  const envelope = await provider.encrypt({
    plaintext: "sensitive memory text",
    scope: {
      tenantId: "tenant-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
      objectClass: "memory_event"
    },
    provenance: {
      rowFamily: "memory_events",
      sourceTable: "memory_events",
      sourceColumn: "text",
      sourceId: "memory-event-1"
    },
    ciphertextLocation: "memory_events.encrypted_text",
    aad: {
      recordVersion: 1,
      nullable: null,
      enabled: true
    },
    now: new Date("2026-07-03T12:00:00.000Z")
  });
  return { provider, envelope };
};

describe("createLocalTestKeyEnvelopeEncryptionProvider", () => {
  it("encrypts and decrypts UTF-8 payloads with explicit envelope metadata", async () => {
    const rootKey = generatedRootKey();
    const { provider, envelope } = await encryptFixture(rootKey);

    expect(envelope).toMatchObject({
      version: ENCRYPTED_PAYLOAD_ENVELOPE_VERSION,
      providerMode: "local_test_key",
      keyId: provider.keyId,
      keyVersion: 1,
      scope: {
        tenantId: "tenant-1",
        teamId: "team-1",
        workspaceId: "workspace-1",
        objectClass: "memory_event"
      },
      provenance: {
        rowFamily: "memory_events",
        sourceTable: "memory_events",
        sourceColumn: "text",
        sourceId: "memory-event-1"
      },
      algorithm: ENCRYPTED_PAYLOAD_ALGORITHM,
      wrappedDek: {
        version: 1,
        algorithm: ENCRYPTED_PAYLOAD_KEY_WRAP_ALGORITHM
      },
      ciphertextLocation: "memory_events.encrypted_text",
      aad: {
        enabled: "true",
        recordVersion: "1"
      },
      createdAt: "2026-07-03T12:00:00.000Z",
      reencryptedAt: null
    });
    expect(envelope.ciphertext).not.toContain("sensitive memory text");
    expect(envelope.wrappedDek.ciphertext).not.toEqual("");
    expect(JSON.stringify(envelope)).not.toContain(rootKey);
    expect(envelope.keyId).toMatch(/^local_test_key:[A-Za-z0-9_-]+$/);
    await expect(decryptEnvelopeToUtf8(provider, envelope)).resolves.toBe(
      "sensitive memory text"
    );
  });

  it("encrypts and decrypts binary payloads", async () => {
    const provider =
      createLocalTestKeyEnvelopeEncryptionProvider(generatedRootKey());
    const plaintext = Uint8Array.from([0, 1, 2, 3, 255]);
    const envelope = await provider.encrypt({
      plaintext,
      scope: { deploymentId: "local" },
      provenance: { rowFamily: "support_bundles" },
      ciphertextLocation: "support_bundle.payload"
    });

    expect([...(await provider.decrypt(envelope))]).toEqual([...plaintext]);
  });

  it("fails closed when decrypting with a different root key", async () => {
    const { envelope } = await encryptFixture();
    const otherProvider =
      createLocalTestKeyEnvelopeEncryptionProvider(generatedRootKey());

    expect(() => otherProvider.decrypt(envelope)).toThrow(
      InvalidEncryptedPayloadEnvelopeError
    );
  });

  it("fails closed when authenticated metadata is changed", async () => {
    const { provider, envelope } = await encryptFixture();
    const tampered: EncryptedPayloadEnvelope = {
      ...envelope,
      scope: {
        ...envelope.scope,
        teamId: "team-2"
      }
    };

    expect(() => provider.decrypt(tampered)).toThrow();
  });

  it("rejects truncated authentication tags and invalid nonce lengths", async () => {
    const { provider, envelope } = await encryptFixture();
    const truncatedTag = Buffer.from(envelope.tag, "base64").subarray(0, 4);
    const truncatedNonce = Buffer.from(envelope.nonce, "base64").subarray(0, 8);

    expect(() =>
      provider.decrypt({ ...envelope, tag: truncatedTag.toString("base64") })
    ).toThrow("authentication tag must be 16 bytes");
    expect(() =>
      provider.decrypt({
        ...envelope,
        nonce: truncatedNonce.toString("base64")
      })
    ).toThrow("nonce must be 12 bytes");
  });

  it("rewraps DEKs without changing payload bytes", async () => {
    const { provider, envelope } = await encryptFixture();
    const rewrapped = await provider.rewrap?.(envelope, {
      now: new Date("2026-07-03T13:00:00.000Z")
    });

    expect(rewrapped).toBeDefined();
    expect(rewrapped?.ciphertext).toBe(envelope.ciphertext);
    expect(rewrapped?.wrappedDek.version).toBe(2);
    expect(rewrapped?.reencryptedAt).toBe("2026-07-03T13:00:00.000Z");
    await expect(decryptEnvelopeToUtf8(provider, rewrapped!)).resolves.toBe(
      "sensitive memory text"
    );
  });

  it("rejects placeholder, missing, and wrongly-sized root keys", () => {
    expect(() => createLocalTestKeyEnvelopeEncryptionProvider("")).toThrow(
      EnvelopeEncryptionError
    );
    expect(() =>
      createLocalTestKeyEnvelopeEncryptionProvider(
        "replace_with_generated_32_byte_base64_key"
      )
    ).toThrow("API_DATA_ENCRYPTION_KEY");
    expect(() =>
      createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(16).toString("base64")
      )
    ).toThrow("32 bytes");
  });
});

describe("createEncryptedJsonPackage", () => {
  it("encrypts package payloads without leaking plaintext into the manifest", async () => {
    const provider =
      createLocalTestKeyEnvelopeEncryptionProvider(generatedRootKey());
    const encryptedPackage = await createEncryptedJsonPackage(provider, {
      objectClass: "memory_export",
      payload: {
        memoryText: "raw memory export text",
        credential: "never-log-this"
      },
      scope: {
        tenantId: "tenant-1",
        teamId: "team-1"
      },
      provenance: {
        rowFamily: "memory_exports"
      },
      metadata: {
        nodeCount: 2,
        eventCount: 3
      },
      now: new Date("2026-07-04T10:00:00.000Z")
    });

    expect(encryptedPackage.manifest).toMatchObject({
      version: 1,
      objectClass: "memory_export",
      payloadFormat: "json",
      scope: {
        tenantId: "tenant-1",
        teamId: "team-1",
        objectClass: "memory_export"
      },
      provenance: {
        rowFamily: "memory_exports"
      },
      metadata: {
        nodeCount: 2,
        eventCount: 3
      }
    });
    const serializedManifest = JSON.stringify(encryptedPackage.manifest);
    expect(serializedManifest).not.toContain("raw memory export text");
    expect(serializedManifest).not.toContain("never-log-this");
    expect(serializedManifest).not.toContain(
      encryptedPackage.envelope.wrappedDek.ciphertext
    );
    await expect(
      decryptEncryptedJsonPackage(provider, encryptedPackage)
    ).resolves.toMatchObject({
      memoryText: "raw memory export text",
      credential: "never-log-this"
    });
  });

  it("fails closed when the package key cannot decrypt the payload", async () => {
    const provider =
      createLocalTestKeyEnvelopeEncryptionProvider(generatedRootKey());
    const wrongProvider =
      createLocalTestKeyEnvelopeEncryptionProvider(generatedRootKey());
    const encryptedPackage = await createEncryptedJsonPackage(provider, {
      objectClass: "support_bundle",
      payload: { text: "sensitive support bundle text" }
    });

    await expect(
      decryptEncryptedJsonPackage(wrongProvider, encryptedPackage)
    ).rejects.toThrow();
  });

  it("rejects raw or secret-looking package metadata", async () => {
    const provider =
      createLocalTestKeyEnvelopeEncryptionProvider(generatedRootKey());
    await expect(
      createEncryptedJsonPackage(provider, {
        objectClass: "memory_export",
        payload: { memoryText: "safe inside ciphertext" },
        metadata: {
          rawMemoryText: "must not enter manifest"
        }
      })
    ).rejects.toThrow("Unsafe encrypted package metadata key");
    await expect(
      createEncryptedJsonPackage(provider, {
        objectClass: "memory_export",
        payload: { memoryText: "safe inside ciphertext" },
        metadata: {
          target: "Bearer secret"
        }
      })
    ).rejects.toThrow("Unsafe encrypted package metadata value");
  });
});

describe("createManagedKmsEnvelopeEncryptionProvider", () => {
  it("encrypts and decrypts through a managed KMS keyring", async () => {
    const keyring = createManagedTestKeyring({
      currentVersion: 1,
      keys: { 1: randomBytes(32) }
    });
    const provider = createManagedKmsEnvelopeEncryptionProvider(keyring);
    const envelope = await provider.encrypt({
      plaintext: "managed kms memory text",
      scope: { tenantId: "tenant-1", objectClass: "memory_event" },
      provenance: { rowFamily: "memory_events" },
      ciphertextLocation: "encrypted_field_payloads"
    });

    expect(envelope).toMatchObject({
      providerMode: "managed_kms",
      keyId: "managed-kms:fixture-tenant-key",
      keyVersion: 1,
      wrappedDek: {
        algorithm: ENCRYPTED_PAYLOAD_MANAGED_KMS_KEY_WRAP_ALGORITHM
      }
    });
    expect(envelope.ciphertext).not.toContain("managed kms memory text");
    await expect(decryptEnvelopeToUtf8(provider, envelope)).resolves.toBe(
      "managed kms memory text"
    );
  });

  it("decrypts old key versions and rewraps to the current KMS version", async () => {
    const keyV1 = randomBytes(32);
    const keyV2 = randomBytes(32);
    const originalProvider = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: { 1: keyV1, 2: keyV2 }
      })
    );
    const rotatedProvider = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 2,
        keys: { 1: keyV1, 2: keyV2 }
      })
    );
    const envelope = await originalProvider.encrypt({
      plaintext: "rotate me",
      scope: { tenantId: "tenant-1" },
      provenance: { rowFamily: "memory_events" },
      ciphertextLocation: "encrypted_field_payloads"
    });
    const rewrapped = await rotatedProvider.rewrap?.(envelope, {
      now: new Date("2026-07-03T14:00:00.000Z")
    });

    expect(rewrapped?.keyVersion).toBe(2);
    expect(rewrapped?.ciphertext).toBe(envelope.ciphertext);
    expect(rewrapped?.wrappedDek.version).toBe(2);
    expect(rewrapped?.reencryptedAt).toBe("2026-07-03T14:00:00.000Z");
    await expect(
      decryptEnvelopeToUtf8(rotatedProvider, rewrapped!)
    ).resolves.toBe("rotate me");
  });

  it("rotates and retires owner-private and Team envelope keys independently", async () => {
    const ownerKeys: Record<number, Buffer> = {
      1: randomBytes(32),
      2: randomBytes(32)
    };
    const teamKeys: Record<number, Buffer> = {
      1: randomBytes(32),
      2: randomBytes(32)
    };
    const ownerV1 = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: ownerKeys,
        keyId: "managed-kms:owner-private"
      })
    );
    const teamV1 = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: teamKeys,
        keyId: "managed-kms:team"
      })
    );
    const ownerEnvelope = await ownerV1.encrypt({
      plaintext: "owner-private replica",
      scope: { tenantId: "owner-1", objectClass: "remote_replica" },
      provenance: { rowFamily: "remote_replicas", sourceId: "replica-1" },
      ciphertextLocation: "encrypted_field_payloads"
    });
    const teamEnvelopes = await Promise.all(
      ["grant-a", "grant-b"].map((grantId) =>
        Promise.resolve(
          teamV1.encrypt({
            plaintext: `Team representation ${grantId}`,
            scope: {
              tenantId: "team-1",
              teamId: "team-1",
              objectClass: "shared_memory_representation"
            },
            provenance: {
              rowFamily: "shared_memory_representations",
              sourceId: grantId
            },
            ciphertextLocation: "encrypted_field_payloads"
          })
        )
      )
    );

    await expect(teamV1.decrypt(ownerEnvelope)).rejects.toThrow(
      "Envelope key id mismatch"
    );
    await expect(ownerV1.decrypt(teamEnvelopes[0]!)).rejects.toThrow(
      "Envelope key id mismatch"
    );

    const ownerV2 = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 2,
        keys: ownerKeys,
        keyId: "managed-kms:owner-private"
      })
    );
    const teamV2 = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 2,
        keys: teamKeys,
        keyId: "managed-kms:team"
      })
    );
    const rewrappedOwner = await ownerV2.rewrap?.(ownerEnvelope, {
      now: new Date("2026-07-03T14:30:00.000Z")
    });
    const rewrappedTeam = await Promise.all(
      teamEnvelopes.map((envelope) =>
        Promise.resolve(
          teamV2.rewrap!(envelope, {
            now: new Date("2026-07-03T14:31:00.000Z")
          })
        )
      )
    );

    expect(rewrappedOwner?.ciphertext).toBe(ownerEnvelope.ciphertext);
    expect(rewrappedTeam.map(({ ciphertext }) => ciphertext)).toEqual(
      teamEnvelopes.map(({ ciphertext }) => ciphertext)
    );

    delete ownerKeys[1];
    await expect(ownerV2.decrypt(ownerEnvelope)).rejects.toThrow();
    await expect(decryptEnvelopeToUtf8(ownerV2, rewrappedOwner!)).resolves.toBe(
      "owner-private replica"
    );
    await expect(
      Promise.all(
        teamEnvelopes.map((envelope) =>
          Promise.resolve(teamV2.decrypt(envelope))
        )
      )
    ).resolves.toHaveLength(2);

    delete teamKeys[1];
    await expect(teamV2.decrypt(teamEnvelopes[0]!)).rejects.toThrow();
    await expect(
      Promise.all(
        rewrappedTeam.map((envelope) => decryptEnvelopeToUtf8(teamV2, envelope))
      )
    ).resolves.toEqual([
      "Team representation grant-a",
      "Team representation grant-b"
    ]);
    await expect(decryptEnvelopeToUtf8(ownerV2, rewrappedOwner!)).resolves.toBe(
      "owner-private replica"
    );
  });

  it("fails closed for wrong KMS key material and provider outages", async () => {
    const provider = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: { 1: randomBytes(32) }
      })
    );
    const envelope = await provider.encrypt({
      plaintext: "do not decrypt with the wrong key",
      scope: { tenantId: "tenant-1" },
      provenance: { rowFamily: "memory_events" },
      ciphertextLocation: "encrypted_field_payloads"
    });
    const wrongKeyProvider = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: { 1: randomBytes(32) }
      })
    );
    const unavailableProvider = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: { 1: randomBytes(32) },
        fail: true
      })
    );

    await expect(wrongKeyProvider.decrypt(envelope)).rejects.toThrow();
    await expect(unavailableProvider.decrypt(envelope)).rejects.toThrow(
      ManagedKmsProviderError
    );
  });

  it("redacts provider status details without hiding safe key references", async () => {
    const provider = createManagedKmsEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 3,
        keys: { 3: randomBytes(32) },
        statusDetails: {
          region: "eu-west-2",
          apiToken: "secret-token",
          credentialPath: "/secret/path",
          latencyMs: "12"
        }
      })
    );
    const status = redactEnvelopeEncryptionProviderStatus(
      (await provider.status?.())!
    );

    expect(status).toEqual({
      mode: "managed_kms",
      keyId: "managed-kms:fixture-tenant-key",
      keyVersion: 3,
      status: "available",
      details: {
        region: "eu-west-2",
        latencyMs: "12"
      }
    });
  });
});

describe("customer controlled KMS providers", () => {
  it("keeps BYOK and CMEK as distinct non-local provider paths", async () => {
    const key = randomBytes(32);
    const byokProvider = createByokEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: { 1: key }
      })
    );
    const cmekProvider = createCmekEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: { 1: key }
      })
    );

    const byokEnvelope = await byokProvider.encrypt({
      plaintext: "customer imported key text",
      scope: { tenantId: "tenant-1" },
      provenance: { rowFamily: "memory_events" },
      ciphertextLocation: "encrypted_field_payloads"
    });
    const cmekEnvelope = await cmekProvider.encrypt({
      plaintext: "customer external key text",
      scope: { tenantId: "tenant-1" },
      provenance: { rowFamily: "memory_events" },
      ciphertextLocation: "encrypted_field_payloads"
    });

    expect(byokEnvelope.providerMode).toBe("byok");
    expect(cmekEnvelope.providerMode).toBe("cmek");
    expect(byokEnvelope.wrappedDek.algorithm).toBe(
      ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM
    );
    await expect(
      decryptEnvelopeToUtf8(byokProvider, byokEnvelope)
    ).resolves.toBe("customer imported key text");
    await expect(
      decryptEnvelopeToUtf8(cmekProvider, cmekEnvelope)
    ).resolves.toBe("customer external key text");
    await expect(cmekProvider.decrypt(byokEnvelope)).rejects.toThrow(
      "Envelope provider mismatch"
    );
  });

  it("rewraps BYOK payloads and fails closed when customer key access is revoked", async () => {
    const keyV1 = randomBytes(32);
    const keyV2 = randomBytes(32);
    const originalProvider = createByokEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: { 1: keyV1, 2: keyV2 }
      })
    );
    const rotatedProvider = createByokEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 2,
        keys: { 1: keyV1, 2: keyV2 }
      })
    );
    const revokedProvider = createByokEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 2,
        keys: { 1: keyV1, 2: keyV2 },
        fail: true
      })
    );
    const envelope = await originalProvider.encrypt({
      plaintext: "customer key rotation",
      scope: { tenantId: "tenant-1" },
      provenance: { rowFamily: "memory_events" },
      ciphertextLocation: "encrypted_field_payloads"
    });
    const rewrapped = await rotatedProvider.rewrap?.(envelope, {
      now: new Date("2026-07-03T15:00:00.000Z")
    });

    expect(rewrapped?.providerMode).toBe("byok");
    expect(rewrapped?.keyVersion).toBe(2);
    await expect(
      decryptEnvelopeToUtf8(rotatedProvider, rewrapped!)
    ).resolves.toBe("customer key rotation");
    await expect(revokedProvider.decrypt(rewrapped!)).rejects.toThrow(
      ManagedKmsProviderError
    );
  });

  it("fails closed when CMEK external key access is unavailable", async () => {
    const key = randomBytes(32);
    const provider = createCmekEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: { 1: key }
      })
    );
    const unavailableProvider = createCmekEnvelopeEncryptionProvider(
      createManagedTestKeyring({
        currentVersion: 1,
        keys: { 1: key },
        fail: true
      })
    );
    const envelope = await provider.encrypt({
      plaintext: "customer managed external key payload",
      scope: { tenantId: "tenant-cmek", objectClass: "memory_event" },
      provenance: { rowFamily: "memory_events" },
      ciphertextLocation: "encrypted_field_payloads"
    });

    expect(envelope.providerMode).toBe("cmek");
    await expect(decryptEnvelopeToUtf8(provider, envelope)).resolves.toBe(
      "customer managed external key payload"
    );
    await expect(unavailableProvider.decrypt(envelope)).rejects.toThrow(
      ManagedKmsProviderError
    );
  });
});

describe("createHttpManagedKmsKeyring", () => {
  it("wraps and unwraps DEKs through HTTPS KMS endpoints", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const dek = randomBytes(32);
    const keyring = createHttpManagedKmsKeyring({
      keyId: "managed-kms:http-key",
      keyVersion: 7,
      endpointUrl: "https://kms.koed.example/v1/",
      authToken: "kms-secret-token",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        if (String(url).endsWith("/wrap")) {
          expect(body).toMatchObject({
            keyId: "managed-kms:http-key",
            keyVersion: 7,
            dek: base64(dek)
          });
          return new Response(
            JSON.stringify({
              ciphertext: "wrapped-dek",
              nonce: "nonce",
              tag: "tag"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        expect(body).toMatchObject({
          keyId: "managed-kms:http-key",
          keyVersion: 7,
          wrappedDek: {
            ciphertext: "wrapped-dek",
            nonce: "nonce",
            tag: "tag"
          }
        });
        return new Response(JSON.stringify({ dek: base64(dek) }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    const wrapped = await keyring.wrapDek({
      keyId: "managed-kms:http-key",
      keyVersion: 7,
      wrappedDekId: "dek-1",
      wrappedDekVersion: 1,
      dek,
      aad: Buffer.from("aad")
    });
    const unwrapped = await keyring.unwrapDek({
      keyId: "managed-kms:http-key",
      keyVersion: 7,
      wrappedDek: {
        id: "dek-1",
        version: 1,
        algorithm: ENCRYPTED_PAYLOAD_MANAGED_KMS_KEY_WRAP_ALGORITHM,
        ...wrapped,
        ciphertext: wrapped.ciphertext,
        nonce: wrapped.nonce!,
        tag: wrapped.tag!
      },
      aad: Buffer.from("aad")
    });
    const status = redactEnvelopeEncryptionProviderStatus(
      (await keyring.status?.())!
    );

    expect([...unwrapped]).toEqual([...dek]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://kms.koed.example/v1/wrap",
      "https://kms.koed.example/v1/unwrap"
    ]);
    expect(
      (requests[0]?.init.headers as Record<string, string>).authorization
    ).toBe("Bearer kms-secret-token");
    expect(JSON.stringify(requests)).not.toContain("apiToken");
    expect(status).toEqual({
      mode: "managed_kms",
      keyId: "managed-kms:http-key",
      keyVersion: 7,
      status: "configured",
      details: {
        endpointOrigin: "https://kms.koed.example"
      }
    });
  });

  it("rejects unsafe non-local HTTP KMS endpoints", () => {
    expect(() =>
      createHttpManagedKmsKeyring({
        keyId: "managed-kms:http-key",
        keyVersion: 1,
        endpointUrl: "http://kms.koed.example",
        authToken: "kms-secret-token"
      })
    ).toThrow("must use HTTPS");
  });
});

describe("createUnsupportedEnvelopeEncryptionProvider", () => {
  it("does not pretend future provider modes are implemented", () => {
    const provider = createUnsupportedEnvelopeEncryptionProvider("managed_kms");

    expect(provider.mode).toBe("managed_kms");
    expect(() =>
      provider.encrypt({
        plaintext: "text",
        scope: {},
        provenance: { rowFamily: "memory_events" },
        ciphertextLocation: "memory_events.encrypted_text"
      })
    ).toThrow(UnsupportedEnvelopeEncryptionProviderError);
  });
});

describe("createEnvelopeEncryptionProviderFromEnvironment", () => {
  it("returns undefined when encryption is not configured and not required", () => {
    expect(
      createEnvelopeEncryptionProviderFromEnvironment({ environment: {} })
    ).toBeUndefined();
  });

  it("creates a local test provider from the documented root key", async () => {
    const provider = createEnvelopeEncryptionProviderFromEnvironment({
      environment: {
        API_DATA_ENCRYPTION_KEY: generatedRootKey()
      }
    });

    expect(provider?.mode).toBe("local_test_key");
    expect(await provider?.status?.()).toMatchObject({
      mode: "local_test_key",
      status: "available"
    });
  });

  it("creates KMS-backed providers from explicit environment mode", async () => {
    const provider = createEnvelopeEncryptionProviderFromEnvironment({
      environment: {
        API_ENVELOPE_ENCRYPTION_PROVIDER: "cmek",
        MANAGED_KMS_KEY_ID: "cmek:customer-key",
        MANAGED_KMS_KEY_VERSION: "3",
        MANAGED_KMS_ENDPOINT_URL: "https://kms.koed.example/v1/",
        MANAGED_KMS_AUTH_TOKEN: "secret-token"
      }
    });

    expect(provider?.mode).toBe("cmek");
    await expect(provider?.status?.()).resolves.toMatchObject({
      mode: "cmek",
      keyId: "cmek:customer-key",
      keyVersion: 3,
      status: "configured"
    });
  });

  it("fails closed for missing required provider config", () => {
    expect(() =>
      createEnvelopeEncryptionProviderFromEnvironment({
        required: true,
        environment: {}
      })
    ).toThrow("Envelope encryption provider is required");
    expect(() =>
      createEnvelopeEncryptionProviderFromEnvironment({
        environment: {
          API_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms"
        }
      })
    ).toThrow("MANAGED_KMS_KEY_ID");
    expect(() =>
      createEnvelopeEncryptionProviderFromEnvironment({
        environment: {
          API_ENVELOPE_ENCRYPTION_PROVIDER: "operator_kms"
        }
      })
    ).toThrow(UnsupportedEnvelopeEncryptionProviderError);
  });

  it("validates paid cloud provider posture from the shared environment contract", () => {
    const base = {
      API_DATA_ENCRYPTION_KEY: generatedRootKey(),
      KOED_DEPLOYMENT_PROFILE: "koed_managed_cloud",
      KOED_MANAGED_CLOUD_RELEASE_STAGE: "paid"
    };

    expect(() =>
      validateEnvelopeEncryptionProviderEnvironment({ environment: base })
    ).toThrow("KMS-backed API_ENVELOPE_ENCRYPTION_PROVIDER");
    expect(() =>
      validateEnvelopeEncryptionProviderEnvironment({
        environment: {
          ...base,
          API_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms"
        }
      })
    ).toThrow("MANAGED_KMS_KEY_ID");
  });
});

describe("createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment", () => {
  it("does not fall back to the Team/general provider family", () => {
    const environment = {
      API_ENVELOPE_ENCRYPTION_PROVIDER: "local_test_key",
      API_DATA_ENCRYPTION_KEY: generatedRootKey(),
      MANAGED_KMS_KEY_ID: "managed-kms:general",
      MANAGED_KMS_KEY_VERSION: "1",
      MANAGED_KMS_ENDPOINT_URL: "https://kms.koed.example/v1/",
      MANAGED_KMS_AUTH_TOKEN: "general-token"
    };

    expect(
      createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
        environment
      })
    ).toBeUndefined();
    expect(() =>
      createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
        environment,
        required: true
      })
    ).toThrow("Owner-private replica envelope encryption provider is required");
  });

  it("creates a distinct local provider from the owner-private key", () => {
    const general = createEnvelopeEncryptionProviderFromEnvironment({
      environment: { API_DATA_ENCRYPTION_KEY: generatedRootKey() }
    });
    const ownerPrivate =
      createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
        environment: {
          OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY: generatedRootKey()
        }
      });

    expect(ownerPrivate?.mode).toBe("local_test_key");
    expect(ownerPrivate?.keyId).not.toBe(general?.keyId);
  });

  it("uses only owner-private KMS fields for KMS, BYOK, and CMEK modes", async () => {
    for (const mode of ["managed_kms", "byok", "cmek"] as const) {
      const provider =
        createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
          environment: {
            OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER: mode,
            OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID: `owner-private:${mode}`,
            OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION: "4",
            OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL:
              "https://owner-private-kms.koed.example/v1/",
            OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN: "owner-token"
          }
        });

      await expect(provider?.status?.()).resolves.toMatchObject({
        mode,
        keyId: `owner-private:${mode}`,
        keyVersion: 4
      });
    }
  });

  it("fails closed when owner-private KMS config is incomplete", () => {
    expect(() =>
      createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
        environment: {
          OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms",
          MANAGED_KMS_KEY_ID: "managed-kms:general",
          MANAGED_KMS_KEY_VERSION: "1",
          MANAGED_KMS_ENDPOINT_URL: "https://kms.koed.example/v1/",
          MANAGED_KMS_AUTH_TOKEN: "general-token"
        }
      })
    ).toThrow("OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID");
  });

  it("rejects an owner-private local key for paid managed cloud", () => {
    expect(() =>
      validateEnvelopeEncryptionProviderEnvironment({
        environment: {
          KOED_DEPLOYMENT_PROFILE: "koed_managed_cloud",
          KOED_MANAGED_CLOUD_RELEASE_STAGE: "paid",
          API_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms",
          MANAGED_KMS_KEY_ID: "managed-kms:general",
          MANAGED_KMS_KEY_VERSION: "1",
          MANAGED_KMS_ENDPOINT_URL: "https://kms.koed.example/v1/",
          MANAGED_KMS_AUTH_TOKEN: "general-token",
          TEAM_MEMORY_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms",
          TEAM_MEMORY_MANAGED_KMS_KEY_ID: "managed-kms:team",
          TEAM_MEMORY_MANAGED_KMS_KEY_VERSION: "1",
          TEAM_MEMORY_MANAGED_KMS_ENDPOINT_URL:
            "https://team-kms.koed.example/v1/",
          TEAM_MEMORY_MANAGED_KMS_AUTH_TOKEN: "team-token",
          OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY: generatedRootKey()
        }
      })
    ).toThrow("KMS-backed OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER");
  });

  it("requires an owner-private provider for paid managed cloud", () => {
    expect(() =>
      validateEnvelopeEncryptionProviderEnvironment({
        environment: {
          KOED_DEPLOYMENT_PROFILE: "koed_managed_cloud",
          KOED_MANAGED_CLOUD_RELEASE_STAGE: "paid",
          API_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms",
          MANAGED_KMS_KEY_ID: "managed-kms:general",
          MANAGED_KMS_KEY_VERSION: "1",
          MANAGED_KMS_ENDPOINT_URL: "https://kms.koed.example/v1/",
          MANAGED_KMS_AUTH_TOKEN: "general-token",
          TEAM_MEMORY_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms",
          TEAM_MEMORY_MANAGED_KMS_KEY_ID: "managed-kms:team",
          TEAM_MEMORY_MANAGED_KMS_KEY_VERSION: "1",
          TEAM_MEMORY_MANAGED_KMS_ENDPOINT_URL:
            "https://team-kms.koed.example/v1/",
          TEAM_MEMORY_MANAGED_KMS_AUTH_TOKEN: "team-token"
        }
      })
    ).toThrow("Owner-private replica envelope encryption provider is required");
  });

  it("requires a KMS-backed Team Memory provider for paid managed cloud", () => {
    expect(() =>
      validateEnvelopeEncryptionProviderEnvironment({
        environment: {
          KOED_DEPLOYMENT_PROFILE: "koed_managed_cloud",
          KOED_MANAGED_CLOUD_RELEASE_STAGE: "paid",
          API_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms",
          MANAGED_KMS_KEY_ID: "managed-kms:general",
          MANAGED_KMS_KEY_VERSION: "1",
          MANAGED_KMS_ENDPOINT_URL: "https://kms.koed.example/v1/",
          MANAGED_KMS_AUTH_TOKEN: "general-token",
          TEAM_MEMORY_DATA_ENCRYPTION_KEY: generatedRootKey()
        }
      })
    ).toThrow("KMS-backed TEAM_MEMORY_ENVELOPE_ENCRYPTION_PROVIDER");
  });
});

describe("resolveApiDataEncryptionKeyFromEnv", () => {
  it("prefers the documented root API key name over the app-local alias", () => {
    expect(
      resolveApiDataEncryptionKeyFromEnv({
        API_DATA_ENCRYPTION_KEY: " root-key ",
        DATA_ENCRYPTION_KEY: "alias-key"
      })
    ).toBe("root-key");
  });

  it("falls back to the app-local alias used by child processes", () => {
    expect(
      resolveApiDataEncryptionKeyFromEnv({
        DATA_ENCRYPTION_KEY: " alias-key "
      })
    ).toBe("alias-key");
  });

  it("fails clearly when neither key is configured", () => {
    expect(() => requireApiDataEncryptionKey({})).toThrow(
      "API_DATA_ENCRYPTION_KEY (or DATA_ENCRYPTION_KEY)"
    );
  });
});

describe("recipient public-key transport encryption", () => {
  it("keeps the recipient private key encrypted by the target root provider", async () => {
    const root =
      createLocalTestKeyEnvelopeEncryptionProvider(generatedRootKey());
    const material = await generateRecipientKeyMaterial(root, {
      keyId: "sync-recipient:test",
      keyVersion: 1,
      scope: { deploymentId: "target-deployment" }
    });
    const serialized = JSON.stringify(material);

    expect(material.publicJwk.d).toBeUndefined();
    expect(serialized).not.toContain('"d":');
    expect(material.encryptedPrivateKey.providerMode).toBe("local_test_key");
  });

  it("encrypts at the source and decrypts only with the target private key", async () => {
    const root =
      createLocalTestKeyEnvelopeEncryptionProvider(generatedRootKey());
    const material = await generateRecipientKeyMaterial(root, {
      keyId: "sync-recipient:roundtrip",
      keyVersion: 2
    });
    const source = createRecipientPublicKeyEnvelopeEncryptionProvider(material);
    const target = await createRecipientPrivateKeyEnvelopeEncryptionProvider(
      root,
      material
    );
    const envelope = await source.encrypt({
      plaintext: "cross-instance payload",
      scope: { objectClass: "sync_package" },
      provenance: { rowFamily: "sync_package", sourceId: "package-1" },
      ciphertextLocation: "sync_package.chunk",
      aad: { relationshipId: "relationship-1", chunkIndex: 0 }
    });

    expect(() => source.decrypt(envelope)).toThrow(RecipientKeyTransportError);
    await expect(decryptEnvelopeToUtf8(target, envelope)).resolves.toBe(
      "cross-instance payload"
    );
  });

  it("fails closed for a wrong recipient key and tampered payload", async () => {
    const root =
      createLocalTestKeyEnvelopeEncryptionProvider(generatedRootKey());
    const [first, second] = await Promise.all([
      generateRecipientKeyMaterial(root, {
        keyId: "sync-recipient:first",
        keyVersion: 1
      }),
      generateRecipientKeyMaterial(root, {
        keyId: "sync-recipient:second",
        keyVersion: 1
      })
    ]);
    const source = createRecipientPublicKeyEnvelopeEncryptionProvider(first);
    const target = await createRecipientPrivateKeyEnvelopeEncryptionProvider(
      root,
      first
    );
    const wrongTarget =
      await createRecipientPrivateKeyEnvelopeEncryptionProvider(root, second);
    const envelope = await source.encrypt({
      plaintext: "protected",
      scope: { objectClass: "sync_package" },
      provenance: { rowFamily: "sync_package" },
      ciphertextLocation: "sync_package.chunk"
    });

    expect(() => wrongTarget.decrypt(envelope)).toThrow(
      InvalidEncryptedPayloadEnvelopeError
    );
    expect(() =>
      target.decrypt({ ...envelope, ciphertext: `${envelope.ciphertext}AA` })
    ).toThrow(InvalidEncryptedPayloadEnvelopeError);
  });

  it("does not allow recipient transport mode as a configured root provider", () => {
    expect(() =>
      createEnvelopeEncryptionProviderFromEnvironment({
        environment: {
          API_ENVELOPE_ENCRYPTION_PROVIDER: "recipient_public_key"
        }
      })
    ).toThrow("Unsupported API_ENVELOPE_ENCRYPTION_PROVIDER");
  });
});
