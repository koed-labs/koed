import { describe, expect, it } from "vitest";
import { pendingCuratedOwnerPolicyProposalMatches } from "./shared-memory-repository.js";

const policyId = "00000000-0000-4000-8000-000000000001";
const otherPolicyId = "00000000-0000-4000-8000-000000000002";

describe("signed Curated source-owner policy lineage", () => {
  it("accepts a separately reviewed Curated opt-in on an existing summary source", () => {
    expect(
      pendingCuratedOwnerPolicyProposalMatches({
        current: { policyId, version: 3 },
        artifact: { policyId, version: 4 },
        policyChanged: true
      })
    ).toBe(true);
  });

  it("rejects stale versions and a different policy identity", () => {
    for (const artifact of [
      { policyId, version: 3 },
      { policyId, version: 5 },
      { policyId: otherPolicyId, version: 4 }
    ]) {
      expect(
        pendingCuratedOwnerPolicyProposalMatches({
          current: { policyId, version: 3 },
          artifact,
          policyChanged: true
        })
      ).toBe(false);
    }
    expect(
      pendingCuratedOwnerPolicyProposalMatches({
        current: { policyId, version: 3 },
        artifact: { policyId, version: 4 },
        policyChanged: false
      })
    ).toBe(false);
  });

  it("requires a first-version proposal when no owner policy exists", () => {
    expect(
      pendingCuratedOwnerPolicyProposalMatches({
        current: null,
        artifact: { policyId, version: 1 },
        policyChanged: true
      })
    ).toBe(true);
    expect(
      pendingCuratedOwnerPolicyProposalMatches({
        current: null,
        artifact: { policyId, version: 2 },
        policyChanged: true
      })
    ).toBe(false);
  });
});
