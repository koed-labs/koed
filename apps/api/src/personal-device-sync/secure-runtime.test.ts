import { describe, expect, it } from "vitest";
import {
  createPdsSecureRuntimeFromEnvironment,
  installPdsDesktopSecretResolver
} from "./secure-runtime.js";

describe("PDS secure runtime", () => {
  it("rejects authority private material from desktop secret payload", async () => {
    installPdsDesktopSecretResolver(async () =>
      JSON.stringify({
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
      })
    );
    await expect(
      createPdsSecureRuntimeFromEnvironment({
        PDS_SECRET_PROVIDER: "desktop",
        PDS_RUNTIME_SECRET_REF: "desktop-pds-ref"
      })
    ).resolves.toEqual({ authoritySigner: null, secureKeyProvider: null });
  });
});
