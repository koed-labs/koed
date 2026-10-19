import { expect, it } from "vitest";
import type { RepositoryIdentity } from "./repository-identity.js";
import {
  createPdsRepositoryAssignment,
  verifyPdsRepositoryAssignment,
  verifyPdsRepositoryAssignmentWithKeyHistory,
  pdsSelectedRepositoryToken
} from "./personal-repository-assignment.js";
const key = Buffer.alloc(32, 7).toString("base64url");
const identity: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_fixture",
  root: "/capture",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout_origin",
  originatingDeviceId: "origin_device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/team/repo"
};
it("binds one effective anchor to the verified group key and epoch", () => {
  const assignment = {
    state: "recorded" as const,
    version: 2,
    automatic: identity,
    override: null,
    effective: identity
  };
  const wire = createPdsRepositoryAssignment(assignment, "3", key);
  expect(verifyPdsRepositoryAssignment(wire, "3", "3", key)).toEqual(
    assignment
  );
  expect(wire.assignmentVersion).toBe("2");
  expect(pdsSelectedRepositoryToken(key, identity.key!)).toBe(
    wire.selectedAnchor?.token
  );
  expect(() => verifyPdsRepositoryAssignment(wire, "3", "4", key)).toThrow(
    "epoch"
  );
  expect(() => verifyPdsRepositoryAssignment(wire, "4", "3", key)).toThrow(
    "epoch"
  );
  expect(() =>
    verifyPdsRepositoryAssignment(
      wire,
      "3",
      "3",
      Buffer.alloc(32, 8).toString("base64url")
    )
  ).toThrow("token");
  expect(() =>
    verifyPdsRepositoryAssignment(
      { ...wire, automatic: { ...identity, key: "gr_other" } },
      "3",
      "3",
      key
    )
  ).toThrow("token");
});
it("preserves unresolved history and device-local override provenance without the original portable token", () => {
  const local = {
    ...identity,
    kind: "device_local_repository" as const,
    key: "dl_local"
  };
  const assignment = {
    state: "recorded" as const,
    version: 3,
    automatic: identity,
    override: local,
    effective: local
  };
  const wire = createPdsRepositoryAssignment(assignment, "1", key);
  expect(wire.selectedAnchor).toBeNull();
  expect(verifyPdsRepositoryAssignment(wire, "1", "1", key)).toEqual(
    assignment
  );
  const historical = {
    state: "historical_unresolved" as const,
    version: 4,
    automatic: null,
    override: null,
    effective: null
  };
  expect(
    verifyPdsRepositoryAssignment(
      createPdsRepositoryAssignment(historical, "1", key),
      "1",
      "1",
      key
    )
  ).toEqual(historical);
  expect(() =>
    createPdsRepositoryAssignment(
      { ...historical, automatic: identity, effective: identity },
      "1",
      key
    )
  ).toThrow("Historical");
});

it("verifies retained old-epoch source with archived group keys after rotation", () => {
  const assignment = {
    state: "recorded" as const,
    version: 1,
    automatic: identity,
    override: null,
    effective: identity
  };
  const wire = createPdsRepositoryAssignment(assignment, "1", key);
  const current = Buffer.alloc(32, 8).toString("base64url");
  expect(
    verifyPdsRepositoryAssignmentWithKeyHistory(wire, "1", {
      currentEpoch: "2",
      projectKey: current,
      historicalProjectKeys: { "1": key }
    })
  ).toEqual(assignment);
  expect(() =>
    verifyPdsRepositoryAssignmentWithKeyHistory(wire, "1", {
      currentEpoch: "2",
      projectKey: current
    })
  ).toThrow("epoch");
  expect(() =>
    verifyPdsRepositoryAssignmentWithKeyHistory(wire, "1", {
      currentEpoch: "2",
      projectKey: current,
      historicalProjectKeys: { "1": current }
    })
  ).toThrow("token");
});
