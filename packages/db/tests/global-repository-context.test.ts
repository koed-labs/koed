import { expect, it } from "vitest";
import type { RepositoryIdentity } from "@koed/shared";
import {
  canonicalGlobalCandidateKey,
  classifyRepositoryEvidence,
  classifyTeamRepositoryEvidence,
  globalRepositoryPoolLimits
} from "../src/global-repository-context.js";
const current: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_current",
  root: "/current",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout_current",
  originatingDeviceId: "device_current",
  selectedRemote: "origin",
  anchorDisplay: "example.test/team/current"
};
const source = (
  identity: RepositoryIdentity | null,
  branch: string | null = "main"
) => ({ identity, branch, label: identity?.anchorDisplay ?? null });
it("gives no preference for a shared branch in another repository, conflicting branches, or unknown caller", () => {
  expect(
    classifyRepositoryEvidence(
      [source({ ...current, key: "gr_other" })],
      current
    )
  ).toMatchObject({
    classification: "other",
    repositoryBonus: 0,
    branchBonus: 0
  });
  expect(
    classifyRepositoryEvidence(
      [source(current, "main"), source(current, "preview")],
      current
    )
  ).toMatchObject({
    classification: "current",
    repositoryBonus: 0.04,
    branchBonus: 0,
    branch: null
  });
  expect(classifyRepositoryEvidence([source(current)], null)).toMatchObject({
    classification: "unknown",
    repositoryBonus: 0,
    branchBonus: 0
  });
  expect(classifyRepositoryEvidence([source(null)], current)).toMatchObject({
    classification: "unknown",
    label: null,
    repositoryBonus: 0,
    branchBonus: 0
  });
});
it("keeps mixed and device-incomparable provenance unknown", () => {
  expect(
    classifyRepositoryEvidence(
      [source(current), source({ ...current, key: "gr_other" })],
      current
    ).classification
  ).toBe("unknown");
  const local = {
    ...current,
    kind: "device_local_repository" as const,
    key: "dl_current"
  };
  expect(
    classifyRepositoryEvidence(
      [source({ ...local, originatingDeviceId: "other_device" })],
      local
    )
  ).toMatchObject({
    classification: "unknown",
    repositoryBonus: 0,
    branchBonus: 0
  });
  expect(
    classifyRepositoryEvidence(
      [
        source({
          ...current,
          originatingDeviceId: "other_device",
          root: "/clone"
        })
      ],
      current
    ).classification
  ).toBe("current");
});
it("bounds both pools by the existing cap and retains full canonical namespaces", () => {
  for (let cap = 1; cap <= 100; cap++) {
    const split = globalRepositoryPoolLimits(cap, true);
    expect(split.current + split.global).toBe(cap);
    expect(split.global).toBeGreaterThan(0);
  }
  expect(globalRepositoryPoolLimits(4, false)).toEqual({
    global: 4,
    current: 0
  });
  const row = {
    visibility: "personal",
    source_type: "memory_node",
    source_id: "source",
    source_chunk_index: 0,
    source_chunk_count: 2,
    source_generation: 7
  };
  const key = canonicalGlobalCandidateKey(row);
  for (const change of [
    { visibility: "team" },
    { source_chunk_index: 1 },
    { source_chunk_count: 3 },
    { source_generation: 8 },
    { source_type: "memory_event" }
  ])
    expect(canonicalGlobalCandidateKey({ ...row, ...change })).not.toBe(key);
});

it("classifies Team snapshots and requires authorized comparable branch disclosure", () => {
  const snapshot = {
    version: 1 as const,
    classification: "portable_repository" as const,
    fingerprint: current.key,
    label: "Team Project",
    branchObservation: "main"
  };
  expect(
    classifyTeamRepositoryEvidence(snapshot, snapshot, current)
  ).toMatchObject({
    classification: "current",
    label: "Team Project",
    repositoryBonus: 0.04,
    branchBonus: 0.01
  });
  for (const disclosed of [
    undefined,
    { ...snapshot, fingerprint: "gr_other" },
    { ...snapshot, branchObservation: null }
  ]) {
    expect(
      classifyTeamRepositoryEvidence(snapshot, disclosed, current)
    ).toMatchObject({
      classification: "current",
      repositoryBonus: 0.04,
      branchBonus: 0,
      branch: null
    });
  }
  expect(
    classifyTeamRepositoryEvidence(
      { ...snapshot, fingerprint: "gr_other" },
      snapshot,
      current
    )
  ).toMatchObject({
    classification: "other",
    repositoryBonus: 0,
    branchBonus: 0
  });
  expect(
    classifyTeamRepositoryEvidence(snapshot, snapshot, {
      ...current,
      kind: "device_local_repository"
    })
  ).toMatchObject({
    classification: "unknown",
    repositoryBonus: 0,
    branchBonus: 0
  });
  expect(
    classifyTeamRepositoryEvidence(
      {
        version: 1,
        classification: "unresolved",
        fingerprint: null,
        label: null,
        branchObservation: null
      },
      snapshot,
      current
    )
  ).toMatchObject({
    classification: "unknown",
    repositoryBonus: 0,
    branchBonus: 0
  });
});
