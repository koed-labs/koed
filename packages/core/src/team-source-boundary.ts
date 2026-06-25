import type { LcmSourceItem } from "./index.js";

export type TeamVisibleSourceBoundaryRejectionReason =
  | "missing_source_id"
  | "missing_session_id"
  | "unshared_session"
  | "derived_child_requires_expansion"
  | "supporting_context_requires_expansion";

export interface TeamVisibleShareGrantBoundary {
  shareGrantId: string;
  teamId: string;
  teamWorkspaceId: string;
  sessionId: string;
  isActive: boolean;
  ownerUserId?: string | null;
}

export interface TeamVisibleSourceBoundary {
  teamId: string;
  teamWorkspaceId: string;
  shareGrants: TeamVisibleShareGrantBoundary[];
}

export interface AuthorizedTeamVisibleSourceItem {
  sourceItem: LcmSourceItem;
  shareGrantId: string;
  sessionId: string;
}

export interface RejectedTeamVisibleSourceItem {
  sourceItem: LcmSourceItem;
  reason: TeamVisibleSourceBoundaryRejectionReason;
}

export interface TeamVisibleSummaryProvenance {
  teamId: string;
  teamWorkspaceId: string;
  shareGrantIds: string[];
  sourceItems: Array<{
    kind: LcmSourceItem["kind"];
    sourceTable?: LcmSourceItem["sourceTable"];
    sourceId: string;
    sessionId: string;
    shareGrantId: string;
    position: number;
  }>;
}

export interface TeamVisibleSourceBoundaryAssessment {
  state: "authorized" | "mixed" | "empty";
  authorized: AuthorizedTeamVisibleSourceItem[];
  rejected: RejectedTeamVisibleSourceItem[];
  provenance: TeamVisibleSummaryProvenance | null;
}

const sourceItemPayload = (
  sourceItem: LcmSourceItem
): Record<string, unknown> => {
  if (
    sourceItem.payload &&
    typeof sourceItem.payload === "object" &&
    !Array.isArray(sourceItem.payload)
  ) {
    return sourceItem.payload as Record<string, unknown>;
  }
  return {};
};

export const teamVisibleSourceItemSessionId = (
  sourceItem: LcmSourceItem
): string | null => {
  const payload = sourceItemPayload(sourceItem);
  const sessionId = payload.sessionId;
  if (typeof sessionId === "string" && sessionId.trim()) {
    return sessionId;
  }
  const snakeCaseSessionId = payload.session_id;
  return typeof snakeCaseSessionId === "string" && snakeCaseSessionId.trim()
    ? snakeCaseSessionId
    : null;
};

export const assessTeamVisibleSourceBoundary = (
  sourceItems: LcmSourceItem[],
  boundary: TeamVisibleSourceBoundary
): TeamVisibleSourceBoundaryAssessment => {
  const grantsBySessionId = new Map(
    boundary.shareGrants
      .filter(
        (grant) =>
          grant.isActive &&
          grant.teamId === boundary.teamId &&
          grant.teamWorkspaceId === boundary.teamWorkspaceId
      )
      .map((grant) => [grant.sessionId, grant])
  );
  const authorized: AuthorizedTeamVisibleSourceItem[] = [];
  const rejected: RejectedTeamVisibleSourceItem[] = [];

  for (const sourceItem of sourceItems) {
    if (sourceItem.kind === "lcm_child") {
      rejected.push({
        sourceItem,
        reason: "derived_child_requires_expansion"
      });
      continue;
    }

    if (
      sourceItem.supportingContext &&
      sourceItem.supportingContext.length > 0
    ) {
      rejected.push({
        sourceItem,
        reason: "supporting_context_requires_expansion"
      });
      continue;
    }

    if (!sourceItem.sourceId) {
      rejected.push({ sourceItem, reason: "missing_source_id" });
      continue;
    }

    const sessionId = teamVisibleSourceItemSessionId(sourceItem);
    if (!sessionId) {
      rejected.push({ sourceItem, reason: "missing_session_id" });
      continue;
    }

    const grant = grantsBySessionId.get(sessionId);
    if (!grant) {
      rejected.push({ sourceItem, reason: "unshared_session" });
      continue;
    }

    authorized.push({
      sourceItem,
      shareGrantId: grant.shareGrantId,
      sessionId
    });
  }

  const state =
    authorized.length === 0
      ? "empty"
      : rejected.length > 0
        ? "mixed"
        : "authorized";

  const provenance: TeamVisibleSummaryProvenance | null =
    state === "authorized"
      ? {
          teamId: boundary.teamId,
          teamWorkspaceId: boundary.teamWorkspaceId,
          shareGrantIds: [
            ...new Set(authorized.map((item) => item.shareGrantId))
          ].sort(),
          sourceItems: authorized.map(
            ({ sourceItem, sessionId, shareGrantId }) => ({
              kind: sourceItem.kind,
              sourceTable: sourceItem.sourceTable,
              sourceId: sourceItem.sourceId!,
              sessionId,
              shareGrantId,
              position: sourceItem.position
            })
          )
        }
      : null;

  return { state, authorized, rejected, provenance };
};

export const requireAuthorizedTeamVisibleSourceBoundary = (
  sourceItems: LcmSourceItem[],
  boundary: TeamVisibleSourceBoundary
): TeamVisibleSummaryProvenance => {
  const assessment = assessTeamVisibleSourceBoundary(sourceItems, boundary);
  if (assessment.state !== "authorized" || !assessment.provenance) {
    throw new Error(
      `Team-visible summary source boundary is ${assessment.state}; refusing derived summary from mixed or unauthorized provenance.`
    );
  }
  return assessment.provenance;
};
