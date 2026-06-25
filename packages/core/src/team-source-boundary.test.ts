import { describe, expect, it } from "vitest";
import type { LcmSourceItem } from "./index.js";
import {
  assessTeamVisibleSourceBoundary,
  requireAuthorizedTeamVisibleSourceBoundary,
  type TeamVisibleSourceBoundary
} from "./team-source-boundary.js";

const boundary = (
  sessions: string[],
  input: { teamId?: string; teamWorkspaceId?: string } = {}
): TeamVisibleSourceBoundary => ({
  teamId: input.teamId ?? "team-a",
  teamWorkspaceId: input.teamWorkspaceId ?? "workspace-a",
  shareGrants: sessions.map((sessionId, index) => ({
    shareGrantId: `grant-${index + 1}`,
    teamId: input.teamId ?? "team-a",
    teamWorkspaceId: input.teamWorkspaceId ?? "workspace-a",
    sessionId,
    isActive: true,
    ownerUserId: "bob"
  }))
});

const sourceItem = (
  sessionId: string,
  input: Partial<LcmSourceItem> = {}
): LcmSourceItem => ({
  kind: "memory_event",
  sourceTable: "memory_events",
  sourceId: `event-${sessionId}-${input.position ?? 0}`,
  visibility: "personal",
  text: `source for ${sessionId}`,
  payload: {
    sessionId,
    workspaceId: "repo-a",
    metadata: { projectPath: "/repo/a" }
  },
  position: input.position ?? 0,
  ...input
});

describe("team-visible source boundary", () => {
  it("rejects a shared session summary when adjacent private session source items are present", () => {
    const assessment = assessTeamVisibleSourceBoundary(
      [
        sourceItem("shared-session"),
        sourceItem("private-adjacent", { position: 1 })
      ],
      boundary(["shared-session"])
    );

    expect(assessment.state).toBe("mixed");
    expect(assessment.authorized.map((item) => item.sessionId)).toEqual([
      "shared-session"
    ]);
    expect(assessment.rejected).toMatchObject([{ reason: "unshared_session" }]);
    expect(assessment.provenance).toBeNull();
  });

  it("rejects same-user different-session sources unless that session is shared too", () => {
    const assessment = assessTeamVisibleSourceBoundary(
      [
        sourceItem("shared-session", {
          payload: { sessionId: "shared-session", ownerUserId: "bob" }
        }),
        sourceItem("same-user-private-session", {
          position: 1,
          payload: {
            sessionId: "same-user-private-session",
            ownerUserId: "bob"
          }
        })
      ],
      boundary(["shared-session"])
    );

    expect(assessment.state).toBe("mixed");
    expect(assessment.rejected[0]?.reason).toBe("unshared_session");
  });

  it("rejects same-repo unshared session sources even when project metadata matches", () => {
    const assessment = assessTeamVisibleSourceBoundary(
      [
        sourceItem("shared-session", {
          payload: {
            sessionId: "shared-session",
            workspaceId: "repo-a",
            metadata: { projectPath: "/repo/a" }
          }
        }),
        sourceItem("same-repo-private-session", {
          position: 1,
          payload: {
            sessionId: "same-repo-private-session",
            workspaceId: "repo-a",
            metadata: { projectPath: "/repo/a" }
          }
        })
      ],
      boundary(["shared-session"])
    );

    expect(assessment.state).toBe("mixed");
    expect(assessment.rejected[0]?.reason).toBe("unshared_session");
  });

  it("allows explicit multi-session sharing into the same Team Workspace", () => {
    const assessment = assessTeamVisibleSourceBoundary(
      [sourceItem("session-a"), sourceItem("session-b", { position: 1 })],
      boundary(["session-a", "session-b"])
    );

    expect(assessment.state).toBe("authorized");
    expect(assessment.provenance).toMatchObject({
      teamId: "team-a",
      teamWorkspaceId: "workspace-a",
      shareGrantIds: ["grant-1", "grant-2"],
      sourceItems: [
        {
          sourceId: "event-session-a-0",
          sessionId: "session-a",
          shareGrantId: "grant-1"
        },
        {
          sourceId: "event-session-b-1",
          sessionId: "session-b",
          shareGrantId: "grant-2"
        }
      ]
    });
  });

  it("rejects retained but inactive Share Grants", () => {
    const activeBoundary = boundary(["shared-session"]);
    const assessment = assessTeamVisibleSourceBoundary(
      [sourceItem("shared-session")],
      {
        ...activeBoundary,
        shareGrants: activeBoundary.shareGrants.map((grant) => ({
          ...grant,
          isActive: false
        }))
      }
    );

    expect(assessment.state).toBe("empty");
    expect(assessment.rejected[0]?.reason).toBe("unshared_session");
    expect(assessment.provenance).toBeNull();
  });

  it("reads snake_case session ids from expanded source item payloads", () => {
    const assessment = assessTeamVisibleSourceBoundary(
      [
        sourceItem("shared-session", {
          payload: { session_id: "shared-session" }
        })
      ],
      boundary(["shared-session"])
    );

    expect(assessment.state).toBe("authorized");
    expect(assessment.authorized[0]?.sessionId).toBe("shared-session");
  });

  it("fails closed when expanded source items include supporting context", () => {
    const assessment = assessTeamVisibleSourceBoundary(
      [
        sourceItem("shared-session", {
          supportingContext: [
            {
              sourceId: "conversation-item-1",
              sourceRole: "supporting_context",
              contextKind: "ide_client_context",
              label: "IDE/client context",
              text: "Unreviewed adjacent IDE state"
            }
          ]
        })
      ],
      boundary(["shared-session"])
    );

    expect(assessment.state).toBe("empty");
    expect(assessment.rejected[0]?.reason).toBe(
      "supporting_context_requires_expansion"
    );
    expect(assessment.provenance).toBeNull();
  });

  it("fails closed for derived child summaries until they are expanded to raw authorized sources", () => {
    const assessment = assessTeamVisibleSourceBoundary(
      [
        {
          kind: "lcm_child",
          nodeId: "personal-rollup",
          text: "Could contain private adjacent context",
          position: 0,
          payload: { sessionId: "shared-session" }
        }
      ],
      boundary(["shared-session"])
    );

    expect(assessment.state).toBe("empty");
    expect(assessment.rejected[0]?.reason).toBe(
      "derived_child_requires_expansion"
    );
    expect(() =>
      requireAuthorizedTeamVisibleSourceBoundary(
        [
          sourceItem("shared-session"),
          sourceItem("private-session", { position: 1 })
        ],
        boundary(["shared-session"])
      )
    ).toThrow(/mixed or unauthorized provenance/);
  });
});
