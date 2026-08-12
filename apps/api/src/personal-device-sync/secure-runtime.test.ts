import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  signPdsRecord
} from "@koed/shared";
import {
  createReloadablePdsSecureKeyProviderFromEnvironment,
  createPdsSecureRuntimeFromEnvironment,
  createPdsSecureRuntimeForApiStartup,
  pdsSecureProviderEnvironment,
  serializePdsPackageForEncryptedStorage
} from "./secure-runtime.js";

const rawPair = (type: "ed25519" | "x25519") => {
  const pair =
    type === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("x25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  const privateJwk = pair.privateKey.export({ format: "jwk" });
  if (typeof publicJwk.x !== "string" || typeof privateJwk.d !== "string") {
    throw new Error("PDS test key export failed");
  }
  return {
    privateKey: pair.privateKey,
    publicKey: publicJwk.x,
    privateSeed: privateJwk.d
  };
};

const reloadableRuntimeSecret = () => {
  const authority = rawPair("ed25519");
  const signing = rawPair("ed25519");
  const kem = rawPair("x25519");
  const groupId = randomBytes(16).toString("base64url");
  const deviceId = randomBytes(16).toString("base64url");
  const signingKeyId = randomBytes(16).toString("base64url");
  const kemKeyId = randomBytes(16).toString("base64url");
  const authorityKeyId = randomBytes(16).toString("base64url");
  const authorityHead = randomBytes(32).toString("base64url");
  const unsigned = {
    protocol: "koed/pds/v1",
    groupId,
    deviceId,
    deviceSigningKeyId: signingKeyId,
    deviceSigningPublicKey: signing.publicKey,
    deviceKemKeyId: kemKeyId,
    deviceKemPublicKey: kem.publicKey,
    epoch: "1",
    operationFamilies: ["pds_relay"],
    statementSequence: "1",
    statementHash: authorityHead,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString()
  };
  const certificate = canonicalizePdsJson({
    ...unsigned,
    authoritySignature: {
      keyId: authorityKeyId,
      signature: signPdsRecord(
        "membership-certificate",
        unsigned,
        authority.privateKey
      )
    }
  });
  return {
    version: 1,
    userId: "user-one",
    relayUrl: "https://relay.example",
    groupId,
    device: {
      id: deviceId,
      originDeploymentId: "deployment-one",
      signingKeyId,
      signingPrivateSeed: signing.privateSeed,
      kemKeyId,
      kemPrivateSeed: kem.privateSeed
    },
    authority: {
      keyId: authorityKeyId,
      publicKey: authority.publicKey,
      head: authorityHead
    },
    recovery: {
      signingKeyId: randomBytes(16).toString("base64url"),
      signingPublicKey: rawPair("ed25519").publicKey
    },
    certificate,
    recipientCertificates: [certificate],
    groupSecrets: {
      currentEpoch: "1",
      contentKey: randomBytes(32).toString("base64url"),
      sourceFingerprintKey: randomBytes(32).toString("base64url"),
      tombstoneFloorKey: randomBytes(32).toString("base64url"),
      projectAliasKey: randomBytes(32).toString("base64url")
    }
  };
};

describe("PDS secure runtime", () => {
  it("stores retained packages in the strict canonical relay wire form", () => {
    const serialized = serializePdsPackageForEncryptedStorage({
      z: "last",
      a: { n: "1", b: true }
    });

    expect(serialized).toBe('{"a":{"b":true,"n":"1"},"z":"last"}');
    expect(parseCanonicalPdsJson(serialized)).toEqual({
      a: { b: true, n: "1" },
      z: "last"
    });
  });

  it("runs the Desktop secret bridge provider through Electron's Node mode", () => {
    expect(
      pdsSecureProviderEnvironment({
        PDS_SECRET_PROVIDER: "desktop_bridge"
      }).ELECTRON_RUN_AS_NODE
    ).toBe("1");
  });

  it("loads and verifies a headless authority signer by opaque reference", async () => {
    const pair = generateKeyPairSync("ed25519");
    const privateJwk = pair.privateKey.export({ format: "jwk" });
    const secret = JSON.stringify({
      version: 1,
      keyId: "authority_one",
      publicKey: privateJwk.x,
      privateSeed: privateJwk.d
    });
    const resolved: string[] = [];
    const runtime = await createPdsSecureRuntimeFromEnvironment(
      {
        PDS_SECRET_PROVIDER: "headless",
        PDS_SECRET_PROVIDER_COMMAND: "/operator/secret-provider",
        PDS_AUTHORITY_SECRET_REF: "pds-authority"
      },
      {
        resolveHeadlessSecret: async (reference) => {
          resolved.push(reference);
          return secret;
        }
      }
    );

    expect(resolved).toEqual(["pds-authority"]);
    expect(runtime.authoritySigner).toMatchObject({
      keyId: "authority_one",
      publicKey: privateJwk.x
    });
    expect(runtime.secureKeyProvider).toBeNull();
  });

  it("loads a separate local authority from the Desktop secret bridge", async () => {
    const pair = generateKeyPairSync("ed25519");
    const privateJwk = pair.privateKey.export({ format: "jwk" });
    const runtime = await createPdsSecureRuntimeFromEnvironment(
      {
        PDS_SECRET_PROVIDER: "desktop_bridge",
        PDS_SECRET_PROVIDER_COMMAND: "/desktop/secret-bridge",
        PDS_AUTHORITY_SECRET_REF: "pds-authority"
      },
      {
        resolveHeadlessSecret: async (reference) =>
          reference === "pds-authority"
            ? JSON.stringify({
                version: 1,
                keyId: "local-authority",
                publicKey: privateJwk.x,
                privateSeed: privateJwk.d
              })
            : null
      }
    );
    expect(runtime.authoritySigner).toMatchObject({
      keyId: "local-authority",
      publicKey: privateJwk.x
    });
    expect(runtime.secureKeyProvider).toBeNull();
  });

  it("retries a transient Desktop authority handoff before API startup", async () => {
    const pair = generateKeyPairSync("ed25519");
    const privateJwk = pair.privateKey.export({ format: "jwk" });
    let resolutions = 0;
    const delays: number[] = [];
    const runtime = await createPdsSecureRuntimeForApiStartup(
      {
        PDS_SECRET_PROVIDER: "desktop_bridge",
        PDS_SECRET_PROVIDER_COMMAND: "/desktop/secret-bridge",
        PDS_AUTHORITY_SECRET_REF: "pds-authority"
      },
      {
        resolveHeadlessSecret: async () => {
          resolutions += 1;
          return resolutions < 3
            ? null
            : JSON.stringify({
                version: 1,
                keyId: "local-authority",
                publicKey: privateJwk.x,
                privateSeed: privateJwk.d
              });
        },
        sleep: (delayMs) => {
          delays.push(delayMs);
          return Promise.resolve();
        }
      }
    );

    expect(resolutions).toBe(3);
    expect(delays).toEqual([100, 100]);
    expect(runtime.authoritySigner).toMatchObject({
      keyId: "local-authority",
      publicKey: privateJwk.x
    });
  });

  it("refuses API startup when a configured authority stays unavailable", async () => {
    await expect(
      createPdsSecureRuntimeForApiStartup(
        {
          PDS_SECRET_PROVIDER: "desktop_bridge",
          PDS_SECRET_PROVIDER_COMMAND: "/desktop/secret-bridge",
          PDS_AUTHORITY_SECRET_REF: "pds-authority"
        },
        {
          attempts: 3,
          resolveHeadlessSecret: async () => null,
          sleep: () => Promise.resolve()
        }
      )
    ).rejects.toThrow(
      "Configured Personal Device Sync authority could not be loaded."
    );
  });

  it("refuses a configured authority without a secure provider", async () => {
    await expect(
      createPdsSecureRuntimeForApiStartup({
        PDS_AUTHORITY_SECRET_REF: "pds-authority"
      })
    ).rejects.toThrow(
      "Configured Personal Device Sync authority provider is invalid."
    );
  });

  it("fails closed when a headless authority seed does not match its public key", async () => {
    const first = generateKeyPairSync("ed25519").privateKey.export({
      format: "jwk"
    });
    const second = generateKeyPairSync("ed25519").privateKey.export({
      format: "jwk"
    });
    await expect(
      createPdsSecureRuntimeFromEnvironment(
        {
          PDS_SECRET_PROVIDER: "headless",
          PDS_SECRET_PROVIDER_COMMAND: "/operator/secret-provider",
          PDS_AUTHORITY_SECRET_REF: "pds-authority"
        },
        {
          resolveHeadlessSecret: async () =>
            JSON.stringify({
              version: 1,
              keyId: "authority_one",
              publicKey: first.x,
              privateSeed: second.d
            })
        }
      )
    ).resolves.toEqual({ authoritySigner: null, secureKeyProvider: null });
  });

  it("rejects authority private material from desktop bridge runtime payload", async () => {
    const secret = JSON.stringify({
      version: 1,
      userId: "user_one",
      relayUrl: "https://relay.example",
      groupId: "group_one",
      device: {
        id: "device_one",
        originDeploymentId: "deployment_one",
        signingKeyId: "signing_one",
        signingPrivateSeed: "seed",
        kemKeyId: "kem_one",
        kemPrivateSeed: "seed"
      },
      authority: {
        keyId: "authority_one",
        publicKey: "public",
        head: "head",
        secretSeed: "must-never-be-accepted"
      },
      certificate: "certificate",
      recipientCertificates: [],
      groupSecrets: {
        currentEpoch: "1",
        contentKey: "content",
        sourceFingerprintKey: "fingerprint",
        tombstoneFloorKey: "floor",
        projectAliasKey: "project"
      }
    });
    await expect(
      createPdsSecureRuntimeFromEnvironment(
        {
          PDS_SECRET_PROVIDER: "desktop_bridge",
          PDS_SECRET_PROVIDER_COMMAND: "/desktop/bridge",
          PDS_RUNTIME_SECRET_REF: "desktop-pds-ref"
        },
        { resolveHeadlessSecret: async () => secret }
      )
    ).resolves.toEqual({ authoritySigner: null, secureKeyProvider: null });
  });

  it("adopts a protected Desktop runtime after API startup", async () => {
    let stored: string | null = null;
    const resolved: string[] = [];
    const provider = createReloadablePdsSecureKeyProviderFromEnvironment(
      {
        PDS_SECRET_PROVIDER: "desktop_bridge",
        PDS_SECRET_PROVIDER_COMMAND: "/desktop/bridge",
        PDS_RUNTIME_SECRET_REF: "desktop-pds-ref"
      },
      {
        resolveHeadlessSecret: async (reference) => {
          resolved.push(reference);
          return stored;
        }
      }
    );
    expect(provider).not.toBeNull();
    await expect(provider?.isReady?.()).resolves.toBe(false);
    await expect(
      provider?.getSourceContext({
        userId: "user-one",
        groupId: "group-one"
      })
    ).resolves.toBeNull();

    const runtime = reloadableRuntimeSecret();
    stored = JSON.stringify(runtime);
    await expect(provider?.isReady?.()).resolves.toBe(true);
    await expect(
      provider?.getSourceContext({
        userId: runtime.userId,
        groupId: runtime.groupId
      })
    ).resolves.toMatchObject({
      originDeploymentId: runtime.device.originDeploymentId,
      originDeviceId: runtime.device.id
    });
    await expect(
      provider?.getSourceContext({
        userId: "different-user",
        groupId: runtime.groupId
      })
    ).resolves.toBeNull();
    expect(resolved).toEqual([
      "desktop-pds-ref",
      "desktop-pds-ref",
      "desktop-pds-ref",
      "desktop-pds-ref",
      "desktop-pds-ref"
    ]);
  });
});
