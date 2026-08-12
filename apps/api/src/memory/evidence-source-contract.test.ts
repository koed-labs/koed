import { describe, expect, it } from "vitest";
import {
  canonicalEvidenceSourceIdentity,
  isCurrentlyAdmittedEvidenceSourceFamily,
  nonMemoryCollaborationSourceFamilies,
  teamEvidenceSourceContract
} from "./evidence-source-contract.js";
import type { DurableEvidenceSourceContract } from "./evidence-source-contract.js";

describe("durable evidence source contract", () => {
  it.each(["memory_events", "lcm_leaves", "lcm_rollups"] as const)(
    "admits grant-scoped Team %s representations",
    (sourceFamily) => {
      expect(teamEvidenceSourceContract(sourceFamily)).toEqual({
        retrievalScope: "team_workspace",
        sourceFamily,
        provenanceBoundary: "active_share_grant_representation"
      });
    }
  );

  it("admits Team Curated Memory only through its grant representation", () => {
    expect(teamEvidenceSourceContract("curated_assertions")).toEqual({
      retrievalScope: "team_workspace",
      sourceFamily: "curated_assertions",
      provenanceBoundary: "active_share_grant_representation"
    });
  });

  it("reserves a policy- and authorization-bound collaboration Memory family", () => {
    const futureContract = {
      retrievalScope: "team_workspace",
      sourceClass: "collaboration_memory",
      sourceFamily: "captured_collaboration_memory",
      captureBoundary: "explicit_collaboration_capture_policy",
      authorizationBoundary: "source_audience_and_retrieval_scope",
      provenanceBoundary: "captured_collaboration_source"
    } satisfies DurableEvidenceSourceContract;

    expect(futureContract).toMatchObject({
      sourceClass: "collaboration_memory",
      captureBoundary: "explicit_collaboration_capture_policy",
      authorizationBoundary: "source_audience_and_retrieval_scope"
    });
  });

  it("does not treat visible or transient collaboration data as Memory", () => {
    expect(nonMemoryCollaborationSourceFamilies).toEqual([
      "collaboration_dm",
      "collaboration_personal_channel",
      "collaboration_presence",
      "collaboration_typing",
      "collaboration_read_receipt",
      "collaboration_transient_event"
    ]);
    expect(nonMemoryCollaborationSourceFamilies).not.toContain(
      "captured_collaboration_memory"
    );
    expect(
      nonMemoryCollaborationSourceFamilies.every(
        (sourceFamily) => !isCurrentlyAdmittedEvidenceSourceFamily(sourceFamily)
      )
    ).toBe(true);
    expect(
      isCurrentlyAdmittedEvidenceSourceFamily("captured_collaboration_memory")
    ).toBe(false);
  });

  it("uses one canonical source identity across search and expansion", () => {
    expect(
      canonicalEvidenceSourceIdentity("memory_node", "grant-source", 2)
    ).toEqual({
      sourceType: "memory_node",
      sourceId: "grant-source",
      sourceChunkIndex: 2
    });
  });
});
