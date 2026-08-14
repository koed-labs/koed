export type CurrentMemoryEvidenceSourceFamily =
  | "memory_events"
  | "lcm_leaves"
  | "lcm_rollups"
  | "curated_assertions";

const currentMemoryEvidenceSourceFamilies =
  new Set<CurrentMemoryEvidenceSourceFamily>([
    "memory_events",
    "lcm_leaves",
    "lcm_rollups",
    "curated_assertions"
  ]);

/**
 * Reserved for collaboration content that a future Capture Policy explicitly
 * admits to Memory. A displayed chat message or realtime collaboration event
 * is not a member of this family merely because a User can see it.
 */
export type CollaborationMemoryEvidenceSourceFamily =
  "captured_collaboration_memory";

export type EvidenceSourceFamily =
  | CurrentMemoryEvidenceSourceFamily
  | CollaborationMemoryEvidenceSourceFamily;

export const nonMemoryCollaborationSourceFamilies = [
  "collaboration_dm",
  "collaboration_personal_channel",
  "collaboration_presence",
  "collaboration_typing",
  "collaboration_read_receipt",
  "collaboration_transient_event"
] as const;

export type NonMemoryCollaborationSourceFamily =
  (typeof nonMemoryCollaborationSourceFamilies)[number];

export const isCurrentlyAdmittedEvidenceSourceFamily = (
  sourceFamily: string
): sourceFamily is CurrentMemoryEvidenceSourceFamily =>
  currentMemoryEvidenceSourceFamilies.has(
    sourceFamily as CurrentMemoryEvidenceSourceFamily
  );

export type DurableEvidenceSourceContract =
  | {
      retrievalScope: "personal";
      sourceFamily: CurrentMemoryEvidenceSourceFamily;
      provenanceBoundary: "owner_personal";
    }
  | {
      retrievalScope: "team_workspace";
      sourceFamily: CurrentMemoryEvidenceSourceFamily;
      provenanceBoundary: "active_share_grant_representation";
    }
  | {
      retrievalScope: "personal" | "team_workspace";
      sourceClass: "collaboration_memory";
      sourceFamily: CollaborationMemoryEvidenceSourceFamily;
      captureBoundary: "explicit_collaboration_capture_policy";
      authorizationBoundary: "source_audience_and_retrieval_scope";
      provenanceBoundary: "captured_collaboration_source";
    };

export interface CanonicalEvidenceSourceIdentity {
  sourceType: "curated_memory" | "memory_event" | "memory_node";
  sourceId: string;
  sourceChunkIndex: number;
}

export const canonicalEvidenceSourceIdentity = (
  sourceType: CanonicalEvidenceSourceIdentity["sourceType"],
  sourceId: string,
  sourceChunkIndex: number
): CanonicalEvidenceSourceIdentity => ({
  sourceType,
  sourceId,
  sourceChunkIndex
});

export const teamEvidenceSourceContract = (
  sourceFamily: CurrentMemoryEvidenceSourceFamily
): DurableEvidenceSourceContract => {
  return {
    retrievalScope: "team_workspace",
    sourceFamily,
    provenanceBoundary: "active_share_grant_representation"
  };
};
