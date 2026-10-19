import { expect, it } from "vitest";
import type { RepositoryIdentity } from "./repository-identity.js";
import {
  createTeamRepositorySnapshot,
  requirePortableTeamRepositoryContext
} from "./team-repository-snapshot.js";
const automatic: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_original",
  root: "/private/checkout",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout",
  originatingDeviceId: "private_device",
  selectedRemote: "origin",
  anchorDisplay: "private-label"
};
it("exports only effective portable context and explicitly permitted labels", () => {
  const override = { ...automatic, key: "gr_override" };
  const snapshot = createTeamRepositorySnapshot(
    { state: "recorded", version: 2, automatic, override, effective: override },
    { permittedLabel: "Approved Project", capturedBranchObservation: "main" }
  );
  expect(snapshot).toEqual({
    version: 1,
    classification: "portable_repository",
    fingerprint: "gr_override",
    label: "Approved Project",
    branchObservation: null
  });
  expect(JSON.stringify(snapshot)).not.toMatch(
    /gr_original|private-label|private_device|private\/checkout/
  );
  expect(
    createTeamRepositorySnapshot({
      state: "recorded",
      version: 1,
      automatic,
      override: null,
      effective: automatic
    }).label
  ).toBeNull();
});
it("keeps nonportable overrides and historical classification unresolved without leaking automatic provenance", () => {
  const override = {
    ...automatic,
    kind: "device_local_repository" as const,
    key: "dl_local"
  };
  for (const assignment of [
    {
      state: "recorded" as const,
      version: 2,
      automatic,
      override,
      effective: override
    },
    {
      state: "historical_unresolved" as const,
      version: 1,
      automatic: null,
      override: null,
      effective: null
    }
  ])
    expect(
      createTeamRepositorySnapshot(assignment, {
        permittedLabel: "hidden",
        capturedBranchObservation: "main"
      })
    ).toEqual({
      version: 1,
      classification: "unresolved",
      fingerprint: null,
      label: null,
      branchObservation: null
    });
});
it("rejects device-local and unresolved Team targets and retains portable clone context", () => {
  expect(
    requirePortableTeamRepositoryContext({
      ...automatic,
      root: "/teammate/clone",
      checkoutId: "peer_checkout"
    }).key
  ).toBe("gr_original");
  expect(() =>
    requirePortableTeamRepositoryContext({
      ...automatic,
      kind: "device_local_repository",
      key: "dl_local"
    })
  ).toThrow("portable");
  expect(() =>
    requirePortableTeamRepositoryContext({
      ...automatic,
      kind: "unresolved",
      key: null
    })
  ).toThrow();
});
