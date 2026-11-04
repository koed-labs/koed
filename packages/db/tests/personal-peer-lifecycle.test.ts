import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPeerLifecycleFixture,
  validatePeerLifecycleFixture
} from "./fixtures/personal-peer-lifecycle.js";
import { personalSourceDeviceFixture } from "./fixtures/personal-source-device.js";

describe("peer lifecycle test fixture", () => {
  it("derives a floor from the authenticated tombstone chain", () => {
    const fixture = createPeerLifecycleFixture();
    expect(validatePeerLifecycleFixture(fixture)).toEqual([
      {
        logicalMemoryId: fixture.tombstone.draft.logicalMemoryId,
        deletionFloorToken: fixture.tombstone.draft.deletionFloorToken
      }
    ]);
  });

  it("binds both source devices and their certificates to the authenticated head", () => {
    const lifecycle = createPeerLifecycleFixture();
    const peers = personalSourceDeviceFixture(lifecycle);
    expect(peers.groupId).toBe(lifecycle.expectedGroupId);
    expect(peers.authorityHead).toBe(lifecycle.expectedHead);
    expect(peers.origin.deviceId).toBe(
      lifecycle.genesis.draft.body.initialDeviceId
    );
    expect(peers.receiver.deviceId).toBe(
      lifecycle.admission.draft.body.deviceId
    );
    expect(peers.epoch).toBe("2");
  });

  it("rejects substituted device, recovery and authority keys", () => {
    for (const name of [
      "authority",
      "author",
      "receiver",
      "recovery",
      "recoveryKem",
      "deviceKem",
      "receiverKem"
    ] as const) {
      const lifecycle = createPeerLifecycleFixture();
      const algorithm = name.endsWith("Kem") ? "x25519" : "ed25519";
      const altered = {
        ...lifecycle,
        identities: {
          ...lifecycle.identities,
          [name]: generateKeyPairSync(algorithm)
        }
      };
      expect(() => personalSourceDeviceFixture(altered)).toThrow();
    }
  });

  it("rejects secrets that were not recovered from the signed key bundle", () => {
    const fixture = createPeerLifecycleFixture();
    expect(() =>
      validatePeerLifecycleFixture({
        ...fixture,
        secrets: { ...fixture.secrets, projectAliasKey: fixture.expectedHead }
      })
    ).toThrow();
  });

  it("authenticates the second device admission before the tombstone", () => {
    const fixture = createPeerLifecycleFixture();
    expect(fixture.admission.draft.sequence).toBe("2");
    expect(fixture.statement.draft.sequence).toBe("3");
    expect(fixture.tombstone.draft.activeDeviceSnapshot).toHaveLength(2);
    expect(() =>
      validatePeerLifecycleFixture({
        ...fixture,
        admission: {
          ...fixture.admission,
          authorization: {
            ...fixture.admission.authorization,
            signature: fixture.statement.authorization.signature
          }
        }
      })
    ).toThrow();
  });

  it("rejects altered signatures, group, previous head, and advertised head", () => {
    const fixture = createPeerLifecycleFixture();
    const cases = [
      {
        ...fixture,
        tombstone: {
          ...fixture.tombstone,
          authorization: {
            ...fixture.tombstone.authorization,
            signature: fixture.statement.authorization.signature
          }
        }
      },
      { ...fixture, expectedGroupId: "different-group" },
      { ...fixture, expectedPreviousHash: fixture.expectedHead },
      { ...fixture, expectedHead: fixture.expectedPreviousHash }
    ];
    for (const value of cases) {
      expect(() => validatePeerLifecycleFixture(value)).toThrow();
    }
  });

  it("rejects an altered or missing advertised floor and a missing control", () => {
    const fixture = createPeerLifecycleFixture();
    expect(() =>
      validatePeerLifecycleFixture({
        ...fixture,
        floors: [
          {
            ...fixture.floors[0]!,
            deletionFloorToken: fixture.expectedPreviousHash
          }
        ]
      })
    ).toThrow();
    expect(() =>
      validatePeerLifecycleFixture({ ...fixture, floors: [] })
    ).toThrow();
    expect(() =>
      validatePeerLifecycleFixture({
        ...fixture,
        tombstone: undefined as unknown as typeof fixture.tombstone
      })
    ).toThrow();
  });
});
