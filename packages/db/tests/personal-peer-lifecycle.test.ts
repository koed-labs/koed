import { describe, expect, it } from "vitest";
import {
  createPeerLifecycleFixture,
  validatePeerLifecycleFixture
} from "./fixtures/personal-peer-lifecycle.js";

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
