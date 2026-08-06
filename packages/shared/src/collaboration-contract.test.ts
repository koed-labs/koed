import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  COLLABORATION_NAME_MAX_CODE_POINTS,
  collaborationCommandReturnsSnapshot,
  collaborationCommandResultSchema,
  collaborationApprovalReviewSchema,
  collaborationDurableSendEventSchema,
  collaborationDurableSendSchema,
  collaborationLimitsSchema,
  collaborationMessageBodySchema,
  collaborationMessagePageSchema,
  collaborationMessageSchema,
  collaborationNameSchema,
  collaborationOpaqueCursorSchema,
  collaborationRemoteBackendUrlSchema,
  collaborationRendererCommandSchema,
  collaborationRendererEventSchema,
  collaborationSnapshotResultCommands,
  collaborationSnapshotSchema,
  collaborationTeamPresenceStatusCatalogueSchema,
  collaborationThreadSchema,
  collaborationTeamPersonSchema,
  collaborationTopicDescriptionSchema,
  collaborationWorkspaceAccessSchema,
  isPersonalCollaborationSelection,
  isTeamCollaborationSelection,
  sharedMemorySourcePageSchema,
  type CollaborationCommandResult,
  type CollaborationRendererCommand
} from "./collaboration-contract.js";
import { teamPresenceStatusCatalogue } from "./team-presence.js";

const ids = {
  request: "00000000-0000-4000-8000-000000000001",
  user: "00000000-0000-4000-8000-000000000002",
  otherUser: "00000000-0000-4000-8000-000000000003",
  thirdUser: "00000000-0000-4000-8000-000000000004",
  backend: "up_team_example",
  team: "00000000-0000-4000-8000-000000000006",
  workspace: "00000000-0000-4000-8000-000000000007",
  thread: "00000000-0000-4000-8000-000000000008",
  logicalThread: "00000000-0000-4000-8000-000000000009",
  message: "00000000-0000-4000-8000-000000000010",
  subscription: "00000000-0000-4000-8000-000000000011",
  delivery: "00000000-0000-4000-8000-000000000012",
  event: "00000000-0000-4000-8000-000000000013",
  sharedSession: "00000000-0000-4000-8000-000000000014",
  logicalMemory: "00000000-0000-4000-8000-000000000015",
  shareGrant: "00000000-0000-4000-8000-000000000016",
  sourceItem: "00000000-0000-4000-8000-000000000017",
  actionGrant: "00000000-0000-4000-8000-000000000018",
  invitation: "00000000-0000-4000-8000-000000000019",
  membership: "00000000-0000-4000-8000-000000000020",
  consent: "00000000-0000-4000-8000-000000000021",
  mutation: "00000000-0000-4000-8000-000000000022",
  remoteReplica: "00000000-0000-4000-8000-000000000023"
} as const;

const timestamp = "2026-07-17T08:30:00.000Z";
const revision = "snapshot.revision-000001";
const cursor = "cursor.page-000000001";

const authoritativeApprovalReview = () => ({
  version: 1 as const,
  title: "Archive Research?",
  description: "Review the current Team and Workspace.",
  consequence: "The Workspace will no longer be normally available.",
  confirmLabel: "Archive Workspace",
  details: [{ label: "Team", value: "Équipe 東京" }]
});

describe("authoritative approval copy", () => {
  it("retains legitimate normalized Unicode", () => {
    expect(
      collaborationApprovalReviewSchema.parse(authoritativeApprovalReview())
        .details[0]?.value
    ).toBe("Équipe 東京");
  });

  it.each([
    "Team\nAdmin",
    "Team\u0000Admin",
    "Team\u202eAdmin",
    "Team\u2066Admin",
    "Team\u206aAdmin"
  ])("rejects dangerous review value %j", (value) => {
    expect(
      collaborationApprovalReviewSchema.safeParse({
        ...authoritativeApprovalReview(),
        details: [{ label: "Team", value }]
      }).success
    ).toBe(false);
  });
});

const participant = (
  id: string = ids.user,
  displayName = "Alice"
): { id: string; displayName: string; membershipState: "enabled" } => ({
  id,
  displayName,
  membershipState: "enabled"
});

const personalChannel = () => ({
  id: ids.thread,
  logicalId: ids.logicalThread,
  scope: "personal" as const,
  ownerUserId: ids.user,
  kind: "personal_channel" as const,
  name: "Research",
  topic: "Working notes",
  version: 1,
  lifecycle: "active" as const,
  canPost: true,
  latestSequence: 1,
  unreadCount: 0,
  lastReadMessageId: ids.message,
  lastReadSequence: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastActivityAt: timestamp,
  archivedAt: null
});

const notesToSelf = () => ({
  ...personalChannel(),
  kind: "notes_to_self" as const,
  name: null,
  topic: null,
  participants: [participant()]
});

const workspaceChannel = () => ({
  ...personalChannel(),
  scope: "team" as const,
  kind: "workspace_channel" as const,
  teamId: ids.team,
  workspaceId: ids.workspace,
  name: "general",
  ownerUserId: undefined
});

const message = () => ({
  id: ids.message,
  threadId: ids.thread,
  scope: "personal" as const,
  teamId: null,
  sequence: 1,
  sender: participant(),
  senderKind: "user" as const,
  body: "A bounded collaboration message.",
  createdAt: timestamp,
  updatedAt: timestamp,
  editedAt: null,
  deletedAt: null,
  delivery: "sent" as const,
  failure: null,
  recipientStatus: null
});

const messagePage = () => ({
  snapshotRevision: revision,
  olderCursor: null,
  newerCursor: null,
  hasOlder: false,
  hasNewer: false,
  threadId: ids.thread,
  items: [message()]
});

const limits = () => ({ ...COLLABORATION_DEFAULT_LIMITS });

const actionGrant = () => ({ id: ids.actionGrant });

const approvalReview = () => ({
  version: 1 as const,
  title: "Create Team?",
  description: "Review the exact Team creation request.",
  consequence: "A new Team will be created.",
  confirmLabel: "Create Team",
  details: []
});

const pendingActionGrantStatus = () => ({
  version: 1 as const,
  actionGrant: actionGrant(),
  approvalTier: "step_up" as const,
  review: approvalReview(),
  state: "pending" as const,
  activationUrl:
    "https://team.example.test/koed/v1/high-risk/browser-activations/00000000-0000-4000-8000-000000000018",
  expiresAt: timestamp
});

const invitation = () => ({
  id: ids.invitation,
  teamId: ids.team,
  defaultWorkspaceId: ids.workspace,
  defaultWorkspaceAccess: "write" as const,
  email: "alice@example.test",
  role: "member" as const,
  lifecycle: "pending" as const,
  version: 1,
  createdAt: timestamp,
  expiresAt: timestamp,
  acceptedAt: null,
  revokedAt: null
});

const membership = () => ({
  id: ids.membership,
  teamId: ids.team,
  userId: ids.otherUser,
  displayName: "Bob",
  email: "bob@example.test",
  role: "member" as const,
  status: "enabled" as const,
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  acceptedAt: timestamp,
  disabledAt: null
});

const workspace = () => ({
  id: ids.workspace,
  teamId: ids.team,
  name: "Engineering",
  description: "Product engineering",
  lifecycle: "active" as const,
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null
});

const previewItem = () => ({
  id: ids.sourceItem,
  representation: "memory_events" as const,
  sequence: 1,
  occurredAt: timestamp,
  sourceItems: [
    {
      id: ids.event,
      sourceKind: "agent_message" as const,
      occurredAt: timestamp,
      body: "A safe preview item.",
      actorName: "Agent",
      toolName: null,
      toolCallId: null
    }
  ]
});

const preview = () => ({
  logicalMemoryId: ids.logicalMemory,
  teamId: ids.team,
  workspaceId: ids.workspace,
  representation: "memory_events" as const,
  allowedRepresentations: ["memory_events", "lcm_leaves"] as const,
  previewRevision: 1,
  sourceRevision: 1,
  policyRevision: 1,
  contentPolicyVersion: 1,
  classifierVersion: 1,
  redactedContentHash: "a".repeat(64),
  previewHash: "b".repeat(64),
  itemCount: 1,
  items: [previewItem()],
  nextCursor: null
});

const grant = () => ({
  id: ids.shareGrant,
  logicalGrantId: ids.logicalThread,
  logicalMemoryId: ids.logicalMemory,
  ownerUserId: ids.user,
  teamId: ids.team,
  workspaceId: ids.workspace,
  consentId: ids.consent,
  ownerAllowedRepresentations: ["memory_events", "lcm_leaves"] as const,
  activeRepresentation: "memory_events" as const,
  representationPolicyRevision: 1,
  sourceRevision: 1,
  grantVersion: 1,
  lifecycle: "active" as const,
  createdAt: timestamp,
  updatedAt: timestamp,
  revokedAt: null,
  companionThreadId: ids.thread
});

const snapshot = () => ({
  contractVersion: COLLABORATION_CONTRACT_VERSION,
  snapshotRevision: revision,
  generatedAt: timestamp,
  connection: {
    state: "live" as const,
    backendId: ids.backend,
    connectedAt: timestamp,
    retryAt: null,
    reconnectAttempt: 0,
    protocolVersion: COLLABORATION_CONTRACT_VERSION
  },
  limits: limits(),
  teamPresenceStatusCatalogue,
  navigation: {
    personalOwner: {
      ...participant(),
      presence: "available" as const
    },
    teamPrincipal: null,
    personal: {
      memory: [],
      notesToSelf: notesToSelf(),
      channels: [personalChannel()]
    },
    teams: []
  },
  selection: { kind: "personal_channel" as const, threadId: ids.thread },
  view: {
    kind: "thread" as const,
    thread: personalChannel(),
    messages: messagePage()
  }
});

describe("collaboration text bounds", () => {
  it("normalizes names before enforcing Unicode code-point limits", () => {
    const exact = ` ${"😀".repeat(COLLABORATION_NAME_MAX_CODE_POINTS)} `;

    expect(collaborationNameSchema.parse(exact)).toBe(
      "😀".repeat(COLLABORATION_NAME_MAX_CODE_POINTS)
    );
    expect(
      collaborationNameSchema.safeParse(
        "😀".repeat(COLLABORATION_NAME_MAX_CODE_POINTS + 1)
      ).success
    ).toBe(false);
    expect(collaborationNameSchema.parse(" Cafe\u0301 ")).toBe("Café");
  });

  it("enforces topic and message limits as UTF-8 bytes", () => {
    expect(
      collaborationTopicDescriptionSchema.safeParse("é".repeat(512)).success
    ).toBe(true);
    expect(
      collaborationTopicDescriptionSchema.safeParse("é".repeat(513)).success
    ).toBe(false);
    expect(
      collaborationMessageBodySchema.safeParse("é".repeat(16_384)).success
    ).toBe(true);
    expect(
      collaborationMessageBodySchema.safeParse("é".repeat(16_385)).success
    ).toBe(false);
  });

  it("accepts exactly 100 history items and rejects item 101", () => {
    const exactItems = Array.from(
      { length: COLLABORATION_DEFAULT_LIMITS.historyPageMaxItems },
      (_, index) => ({ ...message(), sequence: index + 1 })
    );
    expect(
      collaborationMessagePageSchema.safeParse({
        ...messagePage(),
        items: exactItems
      }).success
    ).toBe(true);
    expect(
      collaborationMessagePageSchema.safeParse({
        ...messagePage(),
        items: [
          ...exactItems,
          { ...message(), sequence: exactItems.length + 1 }
        ]
      }).success
    ).toBe(false);

    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.load_message_page",
      input: {
        thread: { scope: "personal" as const, threadId: ids.thread },
        direction: "older" as const,
        cursor: null,
        limit: COLLABORATION_DEFAULT_LIMITS.historyPageMaxItems
      }
    };
    expect(collaborationRendererCommandSchema.safeParse(command).success).toBe(
      true
    );
    expect(
      collaborationRendererCommandSchema.safeParse({
        ...command,
        input: { ...command.input, limit: command.input.limit + 1 }
      }).success
    ).toBe(false);
    expect(
      collaborationRendererCommandSchema.safeParse({
        ...command,
        contractVersion: COLLABORATION_CONTRACT_VERSION - 1
      }).success
    ).toBe(false);
  });

  it("enforces UTF-8 bounds when Node Buffer is unavailable", async () => {
    vi.stubGlobal("Buffer", undefined);
    vi.resetModules();
    try {
      const browserContract = await import("./collaboration-contract.js");
      expect(
        browserContract.collaborationMessageBodySchema.safeParse(
          "é".repeat(16_384)
        ).success
      ).toBe(true);
      expect(
        browserContract.collaborationMessageBodySchema.safeParse(
          "é".repeat(16_385)
        ).success
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe("durable collaboration send DTOs", () => {
  const queued = () => ({
    clientMessageId: ids.mutation,
    authority: {
      scope: "team" as const,
      backendId: ids.backend,
      principalUserId: ids.user,
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.thread
    },
    body: "A currently authorized durable body.",
    localCreationOrder: 3,
    state: "queued" as const,
    retryable: true,
    removalSupported: false as const,
    failure: null,
    createdAt: timestamp,
    updatedAt: timestamp
  });

  it("exposes immutable authority/order state while making removal explicitly unavailable", () => {
    expect(collaborationDurableSendSchema.parse(queued())).toEqual(queued());
    expect(
      collaborationDurableSendSchema.safeParse({
        ...queued(),
        state: "manual_retry",
        failure: null
      }).success
    ).toBe(false);
  });

  it("permits an authority-safe failed projection with no protected body", () => {
    expect(
      collaborationDurableSendSchema.parse({
        ...queued(),
        body: null,
        state: "failed",
        retryable: false,
        failure: {
          code: "access_revoked",
          userMessage: "Access to this collaboration item has ended.",
          retryable: false,
          retryAfterMs: null
        }
      })
    ).toMatchObject({ body: null, state: "failed", retryable: false });
  });

  it("requires sent confirmation to carry the same logical identity", () => {
    expect(
      collaborationDurableSendEventSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        type: "durable_send",
        eventId: ids.event,
        send: { ...queued(), state: "sent", retryable: false },
        message: { ...message(), clientMessageId: ids.otherUser }
      }).success
    ).toBe(false);
  });
});

describe("collaboration renderer commands", () => {
  it("keeps snapshot-bearing command routing in the shared contract", () => {
    expect(collaborationSnapshotResultCommands).toEqual([
      "collaboration.load",
      "collaboration.select",
      "collaboration.reconnect_backend",
      "collaboration.disconnect_backend",
      "collaboration.connect_backend",
      "collaboration.create_team",
      "collaboration.join_team",
      "collaboration.create_workspace"
    ]);
    for (const command of collaborationSnapshotResultCommands) {
      expect(collaborationCommandReturnsSnapshot(command)).toBe(true);
    }
    expect(
      collaborationCommandReturnsSnapshot("collaboration.send_message")
    ).toBe(false);
  });

  it("classifies every selection scope from the shared contract", () => {
    const personal = [
      { kind: "personal_memory" as const },
      { kind: "notes_to_self" as const },
      { kind: "personal_channel" as const, threadId: ids.thread }
    ];
    const team = [
      { kind: "team_people" as const, teamId: ids.team },
      {
        kind: "workspace_channel" as const,
        teamId: ids.team,
        workspaceId: ids.workspace,
        threadId: ids.thread
      },
      {
        kind: "team_direct_message" as const,
        teamId: ids.team,
        threadId: ids.thread
      },
      {
        kind: "workspace_shared_memory" as const,
        teamId: ids.team,
        workspaceId: ids.workspace
      },
      {
        kind: "shared_session" as const,
        teamId: ids.team,
        workspaceId: ids.workspace,
        sharedSessionId: ids.sharedSession
      }
    ];

    for (const selection of personal) {
      expect(isPersonalCollaborationSelection(selection)).toBe(true);
      expect(isTeamCollaborationSelection(selection)).toBe(false);
    }
    for (const selection of team) {
      expect(isPersonalCollaborationSelection(selection)).toBe(false);
      expect(isTeamCollaborationSelection(selection)).toBe(true);
    }
  });

  it("keeps Team management metadata explicit and Workspace Access versioned", () => {
    expect(
      collaborationTeamPersonSchema.parse({
        ...participant(),
        presence: "available",
        teamPresence: {
          mode: "auto",
          manualStatus: "available",
          activityLevel: "active",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          nextTransitionAt: "2026-01-01T00:05:00.001Z",
          preferenceVersion: 1
        },
        management: {
          membershipId: ids.membership,
          email: "OWNER@EXAMPLE.TEST",
          role: "owner",
          status: "enabled",
          version: 2,
          workspaceAccess: [
            {
              workspaceId: ids.workspace,
              userId: ids.user,
              access: "write",
              version: 3
            }
          ]
        }
      }).management?.email
    ).toBe("owner@example.test");
    expect(
      collaborationWorkspaceAccessSchema.safeParse({
        workspaceId: ids.workspace,
        userId: ids.user,
        access: "read",
        version: null
      }).success
    ).toBe(false);
    expect(
      collaborationTeamPersonSchema.safeParse({
        ...participant(),
        presence: "available",
        management: {
          membershipId: ids.membership,
          email: "owner@example.test",
          role: "owner",
          status: "enabled",
          version: 2,
          workspaceAccess: [
            {
              workspaceId: ids.workspace,
              userId: ids.otherUser,
              access: "disabled",
              version: null
            }
          ]
        }
      }).success
    ).toBe(false);
  });

  it("preserves named command and result discriminants for TypeScript consumers", () => {
    type SendCommand = Extract<
      CollaborationRendererCommand,
      { command: "collaboration.send_message" }
    >;
    type SendResult = Extract<
      CollaborationCommandResult,
      { command: "collaboration.send_message"; ok: true }
    >;
    type RetryCommand = Extract<
      CollaborationRendererCommand,
      { command: "collaboration.retry_message" }
    >;

    expectTypeOf<SendCommand>().not.toBeNever();
    expectTypeOf<SendCommand["input"]>().toMatchTypeOf<{
      thread:
        | { scope: "personal"; threadId: string }
        | { scope: "team"; teamId: string; threadId: string };
      clientMessageId: string;
      body: string;
    }>();
    expectTypeOf<RetryCommand["input"]>().toMatchTypeOf<SendCommand["input"]>();
    expectTypeOf<SendResult>().not.toBeNever();
  });

  it("accepts named Personal and Team commands and normalizes their text", () => {
    const personal = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.create_personal_channel",
      input: { name: " Cafe\u0301 ", topic: " Notes " }
    });
    const team = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.create_workspace_channel",
      input: {
        teamId: ids.team,
        workspaceId: ids.workspace,
        name: "general",
        topic: null
      }
    });

    expect(personal.input).toEqual({ name: "Café", topic: "Notes" });
    expect(team.command).toBe("collaboration.create_workspace_channel");
  });

  it("accepts HTTPS and loopback development backend URLs", () => {
    expect(
      collaborationRemoteBackendUrlSchema.parse(
        "https://team.example.test/koed/"
      )
    ).toBe("https://team.example.test/koed");
    expect(
      collaborationRemoteBackendUrlSchema.parse("http://localhost:3300/")
    ).toBe("http://localhost:3300");
    expect(
      collaborationRendererCommandSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.connect_backend",
        input: { remoteUrl: "http://127.0.0.1:3300" }
      }).success
    ).toBe(true);
  });

  it("rejects credentials, fragments, unsafe schemes, and unsafe backend URL shapes", () => {
    for (const remoteUrl of [
      "https://user:secret@team.example.test",
      "https://team.example.test/#fragment",
      "https://team.example.test/?route=private",
      "http://team.example.test",
      "ftp://team.example.test",
      "file:///tmp/koed",
      "https://team.example.test/../admin",
      "https://team.example.test/%2fadmin",
      "https://team.example.test/path with spaces"
    ]) {
      expect(
        collaborationRemoteBackendUrlSchema.safeParse(remoteUrl).success
      ).toBe(false);
    }
  });

  it("rejects arbitrary transport, authorization, and reusable credential fields", () => {
    for (const forbidden of [
      { url: "https://example.test/v1/private" },
      { method: "DELETE" },
      { path: "/v1/private" },
      { headers: { authorization: "Bearer secret" } },
      { authorization: "Bearer secret" },
      { credential: "reusable-secret" }
    ]) {
      expect(
        collaborationRendererCommandSchema.safeParse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: ids.request,
          command: "collaboration.connect_backend",
          input: { remoteUrl: "https://team.example.test", ...forbidden }
        }).success
      ).toBe(false);
    }
  });

  it("accepts explicit invite, membership, Workspace, and Shared Memory actions", () => {
    const commands = [
      {
        command: "collaboration.create_team",
        input: {
          name: "Product Team",
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.join_team",
        input: {
          invitation:
            "https://team.example.test/invitations/accept?token=one-time",
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.create_invitation",
        input: {
          teamId: ids.team,
          email: "ALICE@EXAMPLE.TEST",
          role: "member",
          defaultWorkspaceId: ids.workspace,
          defaultWorkspaceAccess: "write",
          ttlHours: 24,
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.list_invitations",
        input: {
          teamId: ids.team,
          includeRevoked: false,
          cursor: null,
          limit: 25
        }
      },
      {
        command: "collaboration.revoke_invitation",
        input: {
          teamId: ids.team,
          invitationId: ids.invitation,
          expectedVersion: 1,
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.update_member_role",
        input: {
          teamId: ids.team,
          userId: ids.otherUser,
          role: "admin",
          expectedVersion: 1,
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.disable_member",
        input: {
          teamId: ids.team,
          userId: ids.otherUser,
          expectedVersion: 1,
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.leave_team",
        input: {
          teamId: ids.team,
          expectedVersion: 1,
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.archive_workspace",
        input: {
          teamId: ids.team,
          workspaceId: ids.workspace,
          expectedVersion: 1,
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.restore_workspace",
        input: {
          teamId: ids.team,
          workspaceId: ids.workspace,
          expectedVersion: 1,
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.set_workspace_access",
        input: {
          teamId: ids.team,
          workspaceId: ids.workspace,
          userId: ids.otherUser,
          access: "read",
          expectedVersion: null,
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.preview_shared_memory",
        input: {
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          representation: "memory_events",
          allowedRepresentations: ["memory_events", "lcm_leaves"],
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.load_shared_memory_preview_page",
        input: {
          previewHash: "b".repeat(64),
          cursor,
          limit: 25
        }
      },
      {
        command: "collaboration.share_memory",
        input: {
          mutationId: ids.mutation,
          logicalGrantId: ids.logicalThread,
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          consentId: ids.consent,
          mode: "continuous",
          allowedRepresentations: ["memory_events", "lcm_leaves"],
          selectedRepresentation: "memory_events",
          previewRevision: 1,
          previewHash: "b".repeat(64),
          expiresAt: null,
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.revoke_shared_memory",
        input: {
          mutationId: ids.mutation,
          teamId: ids.team,
          workspaceId: ids.workspace,
          shareGrantId: ids.shareGrant,
          expectedGrantVersion: 1,
          reasonCode: "owner_revoked",
          actionGrant: actionGrant()
        }
      },
      {
        command: "collaboration.change_shared_memory_representation",
        input: {
          mutationId: ids.mutation,
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          shareGrantId: ids.shareGrant,
          consentId: ids.consent,
          representation: "lcm_leaves",
          expectedGrantVersion: 1,
          mode: "continuous",
          allowedRepresentations: ["lcm_leaves"],
          previewRevision: 1,
          previewHash: "b".repeat(64),
          expiresAt: null,
          actionGrant: actionGrant()
        }
      }
    ];

    for (const value of commands) {
      expect(
        collaborationRendererCommandSchema.safeParse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: ids.request,
          ...value
        }).success,
        value.command
      ).toBe(true);
    }
  });

  it("rejects reusable secrets in scoped high-risk action grants", () => {
    for (const leaked of [
      { token: "secret" },
      { authorization: "Bearer secret" },
      { credential: "secret" }
    ]) {
      expect(
        collaborationRendererCommandSchema.safeParse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: ids.request,
          command: "collaboration.disable_member",
          input: {
            teamId: ids.team,
            userId: ids.otherUser,
            expectedVersion: 1,
            actionGrant: { ...actionGrant(), ...leaked }
          }
        }).success
      ).toBe(false);
    }
  });

  it("accepts allowlisted Action Grant request, poll, and cancel commands and rejects arbitrary intents", () => {
    for (const intent of [
      {
        intent: "collaboration.create_team",
        commandRequestId: ids.mutation,
        name: "Product Team"
      },
      {
        intent: "collaboration.join_team",
        commandRequestId: ids.mutation,
        invitation:
          "https://team.example.test/koed/invitations/accept?token=kti_validInvitationToken123456"
      },
      {
        intent: "collaboration.create_workspace",
        commandRequestId: ids.mutation,
        teamId: ids.team,
        name: "Research",
        description: "Shared research"
      },
      {
        intent: "collaboration.leave_team",
        commandRequestId: ids.mutation,
        teamId: ids.team,
        expectedVersion: 1
      },
      {
        intent: "collaboration.set_workspace_access",
        commandRequestId: ids.mutation,
        teamId: ids.team,
        workspaceId: ids.workspace,
        userId: ids.otherUser,
        access: "disabled",
        expectedVersion: 2
      },
      {
        intent: "collaboration.preview_shared_memory",
        commandRequestId: ids.mutation,
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["memory_events", "lcm_leaves"]
      },
      {
        intent: "collaboration.share_memory",
        commandRequestId: ids.mutation,
        mutationId: ids.mutation,
        logicalGrantId: ids.logicalThread,
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        consentId: ids.consent,
        mode: "continuous",
        allowedRepresentations: ["memory_events", "lcm_leaves"],
        selectedRepresentation: "memory_events",
        previewRevision: 1,
        previewHash: "b".repeat(64),
        expiresAt: null
      },
      {
        intent: "collaboration.revoke_shared_memory",
        commandRequestId: ids.mutation,
        mutationId: ids.mutation,
        teamId: ids.team,
        workspaceId: ids.workspace,
        shareGrantId: ids.shareGrant,
        expectedGrantVersion: 1,
        reasonCode: "owner_revoked"
      },
      {
        intent: "collaboration.change_shared_memory_representation",
        commandRequestId: ids.mutation,
        mutationId: ids.mutation,
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        shareGrantId: ids.shareGrant,
        consentId: ids.consent,
        representation: "lcm_leaves",
        expectedGrantVersion: 1,
        mode: "continuous",
        allowedRepresentations: ["lcm_leaves"],
        previewRevision: 1,
        previewHash: "b".repeat(64),
        expiresAt: null
      }
    ] as const) {
      expect(
        collaborationRendererCommandSchema.safeParse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: ids.request,
          command: "collaboration.request_action_grant",
          input: { intent }
        }).success,
        intent.intent
      ).toBe(true);
    }
    expect(
      collaborationRendererCommandSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.await_action_grant",
        input: { actionGrant: actionGrant() }
      }).success
    ).toBe(true);
    expect(
      collaborationRendererCommandSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.cancel_action_grant",
        input: { actionGrant: actionGrant() }
      }).success
    ).toBe(true);
    expect(
      collaborationRendererCommandSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.request_action_grant",
        input: {
          intent: {
            intent: "collaboration.preview_shared_memory",
            commandRequestId: ids.mutation,
            teamId: ids.team,
            workspaceId: ids.workspace,
            logicalMemoryId: ids.logicalMemory,
            representation: "memory_events",
            allowedRepresentations: ["memory_events"],
            method: "POST",
            path: "/v1/private",
            body: { unsafe: true }
          }
        }
      }).success
    ).toBe(false);
  });

  it.each(["createGeneralChannel", "create_general_channel"])(
    "rejects the retired %s Workspace channel policy field",
    (field) => {
      const workspaceInput = {
        teamId: ids.team,
        name: "Research",
        description: null,
        [field]: false
      };
      expect(
        collaborationRendererCommandSchema.safeParse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: ids.request,
          command: "collaboration.request_action_grant",
          input: {
            intent: {
              intent: "collaboration.create_workspace",
              commandRequestId: ids.mutation,
              ...workspaceInput
            }
          }
        }).success
      ).toBe(false);
      expect(
        collaborationRendererCommandSchema.safeParse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: ids.request,
          command: "collaboration.create_workspace",
          input: { ...workspaceInput, actionGrant: actionGrant() }
        }).success
      ).toBe(false);
    }
  );

  it("rejects duplicate or non-consented Shared Memory representations", () => {
    for (const input of [
      {
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["lcm_leaves"],
        actionGrant: actionGrant()
      },
      {
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["memory_events", "memory_events"],
        actionGrant: actionGrant()
      }
    ]) {
      expect(
        collaborationRendererCommandSchema.safeParse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: ids.request,
          command: "collaboration.preview_shared_memory",
          input
        }).success
      ).toBe(false);
    }
  });

  it("rejects duplicate group-DM participants and malformed IDs", () => {
    expect(
      collaborationRendererCommandSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.start_group_direct_message",
        input: {
          teamId: ids.team,
          participantUserIds: [ids.otherUser, ids.otherUser]
        }
      }).success
    ).toBe(false);
    expect(
      collaborationRendererCommandSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: "not-a-uuid",
        command: "collaboration.load",
        input: {}
      }).success
    ).toBe(false);
  });

  it("keeps opaque cursors bounded and excludes cursors from renderer acknowledgements", () => {
    expect(collaborationOpaqueCursorSchema.safeParse(cursor).success).toBe(
      true
    );
    expect(collaborationOpaqueCursorSchema.safeParse("short").success).toBe(
      false
    );
    expect(
      collaborationRendererCommandSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.acknowledge_delivery",
        input: {
          subscriptionId: ids.subscription,
          deliveryId: ids.delivery,
          eventId: ids.event,
          expectedSubscriptionVersion: 2,
          cursor: "crt1.renderer-must-not-own-this"
        }
      }).success
    ).toBe(false);
  });

  it("requires explicit Personal or Team thread references", () => {
    expect(
      collaborationRendererCommandSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.send_message",
        input: {
          thread: { scope: "personal", threadId: ids.thread },
          clientMessageId: ids.message,
          body: "Personal note"
        }
      }).success
    ).toBe(true);
    expect(
      collaborationRendererCommandSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.send_message",
        input: {
          thread: { scope: "team", threadId: ids.thread },
          clientMessageId: ids.message,
          body: "Missing Team binding"
        }
      }).success
    ).toBe(false);
  });

  it("binds a retry to the original client message identity and exact body", () => {
    const retry = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: ids.request,
      command: "collaboration.retry_message",
      input: {
        thread: { scope: "personal", threadId: ids.thread },
        clientMessageId: ids.message,
        body: "Retry this exact body"
      }
    };
    expect(collaborationRendererCommandSchema.safeParse(retry).success).toBe(
      true
    );
    expect(
      collaborationRendererCommandSchema.safeParse({
        ...retry,
        input: {
          thread: retry.input.thread,
          clientMessageId: retry.input.clientMessageId
        }
      }).success
    ).toBe(false);
  });
});

describe("collaboration snapshots and DTOs", () => {
  it("accepts a bounded Personal snapshot without transport configuration", () => {
    expect(collaborationSnapshotSchema.parse(snapshot())).toEqual(snapshot());
  });

  it("keeps the local Personal owner distinct from the remote Team principal", () => {
    const remotePrincipal = {
      ...participant(ids.otherUser, "Bob"),
      presence: "available" as const
    };
    const remoteTeamPerson = {
      ...remotePrincipal,
      teamPresence: {
        mode: "auto" as const,
        manualStatus: "available" as const,
        activityLevel: "active" as const,
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        nextTransitionAt: "2026-01-01T00:05:00.001Z",
        preferenceVersion: 1
      }
    };
    const withTeam = {
      ...snapshot(),
      navigation: {
        ...snapshot().navigation,
        teamPrincipal: remotePrincipal,
        teams: [
          {
            id: ids.team,
            name: "Remote Team",
            role: "member" as const,
            lifecycle: "active" as const,
            unreadCount: 0,
            people: [remoteTeamPerson],
            directMessages: [],
            workspaces: [],
            version: 1
          }
        ]
      }
    };

    expect(collaborationSnapshotSchema.safeParse(withTeam).success).toBe(true);
    expect(withTeam.navigation.personalOwner.id).not.toBe(
      withTeam.navigation.teamPrincipal.id
    );
    expect(
      collaborationSnapshotSchema.safeParse({
        ...withTeam,
        navigation: { ...withTeam.navigation, teamPrincipal: null }
      }).success
    ).toBe(false);
    expect(
      collaborationSnapshotSchema.safeParse({
        ...withTeam,
        navigation: {
          ...withTeam.navigation,
          teamPrincipal: withTeam.navigation.personalOwner
        }
      }).success
    ).toBe(false);
    expect(
      collaborationSnapshotSchema.safeParse({
        ...withTeam,
        navigation: {
          ...withTeam.navigation,
          teams: [
            {
              ...withTeam.navigation.teams[0],
              people: [
                {
                  ...remotePrincipal,
                  id: ids.thirdUser
                }
              ]
            }
          ]
        }
      }).success
    ).toBe(false);
  });

  it("returns a versioned Presence catalogue and safely degrades future status keys", () => {
    const remotePrincipal = {
      ...participant(ids.otherUser, "Bob"),
      presence: "away" as const
    };
    const parsed = collaborationSnapshotSchema.parse({
      ...snapshot(),
      teamPresenceStatusCatalogue: {
        version: 2,
        statuses: [
          ...teamPresenceStatusCatalogue.statuses,
          { key: "heads_down", label: "Heads down" }
        ]
      },
      navigation: {
        ...snapshot().navigation,
        teamPrincipal: remotePrincipal,
        teams: [
          {
            id: ids.team,
            name: "Remote Team",
            role: "member",
            lifecycle: "active",
            unreadCount: 0,
            people: [
              {
                ...remotePrincipal,
                teamPresence: {
                  mode: "manual",
                  manualStatus: "heads_down",
                  activityLevel: null,
                  lastActivityAt: null,
                  nextTransitionAt: null,
                  preferenceVersion: 2
                }
              }
            ],
            directMessages: [],
            workspaces: [],
            version: 1
          }
        ]
      }
    });

    expect(parsed.teamPresenceStatusCatalogue.version).toBe(2);
    expect(parsed.teamPresenceStatusCatalogue.statuses).toContainEqual({
      key: "heads_down",
      label: "Heads down"
    });
    expect(
      parsed.navigation.teams[0]?.people[0]?.teamPresence.manualStatus
    ).toBe("unknown");
    expect(
      collaborationTeamPresenceStatusCatalogueSchema.safeParse({
        version: 2,
        statuses: [
          { key: "available", label: "Available" },
          { key: "available", label: "Duplicate" }
        ]
      }).success
    ).toBe(false);
  });

  it("binds Personal navigation only to the local Personal owner", () => {
    const value = snapshot();
    expect(
      collaborationSnapshotSchema.safeParse({
        ...value,
        navigation: {
          ...value.navigation,
          personalOwner: {
            ...value.navigation.personalOwner,
            id: ids.otherUser
          }
        }
      }).success
    ).toBe(false);
  });

  it("accepts each advertised security maximum exactly and rejects one over", () => {
    const minimums = Object.fromEntries(
      Object.keys(COLLABORATION_DEFAULT_LIMITS).map((field) => [field, 1])
    );
    for (const [field, maximum] of Object.entries(
      COLLABORATION_DEFAULT_LIMITS
    )) {
      expect(
        collaborationLimitsSchema.safeParse({
          ...minimums,
          [field]: maximum
        }).success,
        `${field} at limit ${maximum}`
      ).toBe(true);
      expect(
        collaborationLimitsSchema.safeParse({
          ...minimums,
          [field]: maximum + 1
        }).success,
        `${field} one over ${maximum}`
      ).toBe(false);
    }
  });

  it("enforces thread scope and participant invariants", () => {
    const validChannel = workspaceChannel();
    delete (validChannel as { ownerUserId?: unknown }).ownerUserId;
    expect(collaborationThreadSchema.safeParse(validChannel).success).toBe(
      true
    );

    expect(
      collaborationThreadSchema.safeParse({
        ...validChannel,
        workspaceId: undefined
      }).success
    ).toBe(false);
    expect(
      collaborationThreadSchema.safeParse({
        ...validChannel,
        kind: "dm",
        participants: [
          participant(ids.user, "Alice"),
          participant(ids.user, "Alice again")
        ]
      }).success
    ).toBe(false);
    expect(
      collaborationThreadSchema.safeParse({
        ...notesToSelf(),
        participants: [participant(ids.otherUser, "Bob")]
      }).success
    ).toBe(false);
  });

  it("rejects cross-scope messages, unsafe failure combinations, and mixed-thread pages", () => {
    expect(
      collaborationMessageSchema.safeParse({
        ...message(),
        scope: "team",
        teamId: null
      }).success
    ).toBe(false);
    expect(
      collaborationMessageSchema.safeParse({
        ...message(),
        failure: {
          code: "offline",
          userMessage: "Try again.",
          retryable: true,
          retryAfterMs: 1_000
        }
      }).success
    ).toBe(false);
    expect(
      collaborationMessagePageSchema.safeParse({
        ...messagePage(),
        threadId: ids.logicalThread
      }).success
    ).toBe(false);
  });

  it("preserves explicit Shared Memory representations without fallback mixing", () => {
    const memoryEvent = {
      id: ids.sourceItem,
      representation: "memory_events" as const,
      sequence: 1,
      occurredAt: timestamp,
      sourceItems: [
        {
          id: ids.event,
          sourceKind: "tool_call" as const,
          occurredAt: timestamp,
          body: '{"cmd":"pnpm test"}',
          actorName: "Agent",
          toolName: "exec_command",
          toolCallId: "call-contract-round-trip"
        }
      ]
    };
    const page = {
      snapshotRevision: revision,
      olderCursor: null,
      newerCursor: null,
      hasOlder: false,
      hasNewer: false,
      sharedSessionId: ids.sharedSession,
      representation: "memory_events" as const,
      items: [memoryEvent]
    };

    expect(sharedMemorySourcePageSchema.safeParse(page).success).toBe(true);
    expect(
      sharedMemorySourcePageSchema.safeParse({
        ...page,
        representation: "lcm_leaves"
      }).success
    ).toBe(false);
  });
});

describe("collaboration results and realtime", () => {
  it("accepts command-correlated success and safe failure results", () => {
    expect(
      collaborationCommandResultSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.load",
        ok: true,
        data: { snapshot: snapshot() }
      }).success
    ).toBe(true);
    expect(
      collaborationCommandResultSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.load",
        ok: false,
        error: {
          code: "temporarily_unavailable",
          userMessage: "Collaboration is temporarily unavailable.",
          retryable: true,
          retryAfterMs: 2_000
        }
      }).success
    ).toBe(true);
    expect(
      collaborationCommandResultSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.load",
        ok: false,
        error: {
          code: "internal_error",
          userMessage: "Unable to load collaboration.",
          retryable: false,
          retryAfterMs: null,
          stack: "secret internal stack"
        }
      }).success
    ).toBe(false);
  });

  it("correlates canonical backend connection results", () => {
    expect(
      collaborationCommandResultSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.connect_backend",
        ok: true,
        data: {
          backend: {
            id: ids.backend,
            baseUrl: "https://team.example.test/koed/"
          },
          snapshot: snapshot()
        }
      }).success
    ).toBe(true);
    expect(
      collaborationCommandResultSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.connect_backend",
        ok: true,
        data: {
          backend: {
            id: "up_different_backend",
            baseUrl: "https://team.example.test"
          },
          snapshot: snapshot()
        }
      }).success
    ).toBe(false);
    expect(
      collaborationCommandResultSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.connect_backend",
        ok: false,
        error: {
          code: "permission_denied",
          userMessage: "You do not have access to this collaboration item.",
          retryable: false,
          retryAfterMs: null
        }
      }).success
    ).toBe(true);
  });

  it("accepts correlated invite, membership, Workspace, and Shared Memory results", () => {
    const results = [
      {
        command: "collaboration.request_action_grant",
        data: { status: pendingActionGrantStatus() }
      },
      {
        command: "collaboration.await_action_grant",
        data: { status: pendingActionGrantStatus() }
      },
      {
        command: "collaboration.cancel_action_grant",
        data: {
          status: {
            version: 1,
            actionGrant: actionGrant(),
            approvalTier: "step_up",
            review: approvalReview(),
            state: "canceled",
            activationUrl: null,
            expiresAt: timestamp
          }
        }
      },
      {
        command: "collaboration.create_invitation",
        data: {
          invitation: invitation(),
          invitationUrl:
            "https://team.example.test/invitations/accept?token=one-time"
        }
      },
      {
        command: "collaboration.list_invitations",
        data: {
          page: { teamId: ids.team, items: [invitation()], nextCursor: null }
        }
      },
      {
        command: "collaboration.revoke_invitation",
        data: {
          invitation: {
            ...invitation(),
            lifecycle: "revoked",
            revokedAt: timestamp
          }
        }
      },
      {
        command: "collaboration.update_member_role",
        data: { membership: { ...membership(), role: "admin" } }
      },
      {
        command: "collaboration.disable_member",
        data: {
          membership: {
            ...membership(),
            status: "disabled",
            disabledAt: timestamp
          }
        }
      },
      {
        command: "collaboration.leave_team",
        data: {
          membership: {
            ...membership(),
            userId: ids.user,
            status: "disabled",
            disabledAt: timestamp
          }
        }
      },
      {
        command: "collaboration.archive_workspace",
        data: {
          workspace: {
            ...workspace(),
            lifecycle: "archived",
            archivedAt: timestamp
          }
        }
      },
      {
        command: "collaboration.restore_workspace",
        data: { workspace: workspace() }
      },
      {
        command: "collaboration.set_workspace_access",
        data: {
          access: {
            workspaceId: ids.workspace,
            userId: ids.otherUser,
            access: "read",
            version: 1
          }
        }
      },
      {
        command: "collaboration.preview_shared_memory",
        data: { preview: preview() }
      },
      {
        command: "collaboration.load_shared_memory_preview_page",
        data: { preview: preview() }
      },
      {
        command: "collaboration.share_memory",
        data: { grant: grant() }
      },
      {
        command: "collaboration.revoke_shared_memory",
        data: {
          grant: {
            ...grant(),
            lifecycle: "revoked",
            activeRepresentation: null,
            revokedAt: timestamp
          }
        }
      },
      {
        command: "collaboration.change_shared_memory_representation",
        data: { grant: { ...grant(), activeRepresentation: "lcm_leaves" } }
      }
    ];

    for (const value of results) {
      expect(
        collaborationCommandResultSchema.safeParse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: ids.request,
          ok: true,
          ...value
        }).success,
        value.command
      ).toBe(true);
    }

    expect(
      collaborationCommandResultSchema.safeParse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: ids.request,
        command: "collaboration.list_invitations",
        ok: true,
        data: {
          page: { teamId: ids.team, items: [], nextCursor: null },
          invitationUrl: "https://team.example.test/invitations/secret"
        }
      }).success
    ).toBe(false);
  });

  it("accepts typed updates and rejects mismatched protected scope", () => {
    const update = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update" as const,
      subscriptionId: ids.subscription,
      deliveryId: ids.delivery,
      eventId: ids.event,
      occurredAt: timestamp,
      family: "message_created" as const,
      resource: {
        scope: "personal" as const,
        teamId: null,
        workspaceId: null,
        threadId: ids.thread,
        messageId: ids.message,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: { type: "message_created" as const, message: message() }
    };

    expect(collaborationRendererEventSchema.safeParse(update).success).toBe(
      true
    );
    expect(
      collaborationRendererEventSchema.safeParse({
        ...update,
        resource: { ...update.resource, scope: "team", teamId: null }
      }).success
    ).toBe(false);
    expect(
      collaborationRendererEventSchema.safeParse({
        ...update,
        family: "thread_lifecycle"
      }).success
    ).toBe(false);
  });

  it("keeps Personal Memory sync updates on the current contract version and owner-only resources", () => {
    const update = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update" as const,
      subscriptionId: ids.subscription,
      deliveryId: ids.delivery,
      eventId: ids.event,
      occurredAt: timestamp,
      family: "personal_memory_changed" as const,
      resource: {
        scope: "personal" as const,
        teamId: null,
        workspaceId: null,
        threadId: null,
        messageId: null,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: {
        type: "personal_memory_upserted" as const,
        entry: {
          id: ids.sharedSession,
          logicalMemoryId: ids.logicalMemory,
          title: "Realtime sync state",
          projectName: "Koed",
          updatedAt: timestamp,
          preview: "4 Memory Events",
          eventCount: 4,
          hasSynchronizedRevision: true,
          syncState: "ready" as const
        }
      }
    };

    expect(collaborationRendererEventSchema.safeParse(update).success).toBe(
      true
    );
    expect(
      collaborationRendererEventSchema.safeParse({
        ...update,
        resource: { ...update.resource, scope: "team", teamId: ids.team }
      }).success
    ).toBe(false);
    expect(
      collaborationRendererEventSchema.safeParse({
        ...update,
        family: "message_created"
      }).success
    ).toBe(false);
  });

  it("keeps revocation and backpressure controls content-free", () => {
    const control = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control" as const,
      subscriptionId: ids.subscription,
      occurredAt: timestamp,
      reason: "access_revoked" as const
    };

    expect(collaborationRendererEventSchema.safeParse(control).success).toBe(
      true
    );
    for (const protectedField of [
      { message: "Removed from secret workspace" },
      { teamId: ids.team },
      { resource: { threadId: ids.thread } },
      { cursor: "crt1.secret-cursor-value" },
      { authorization: "Bearer secret" }
    ]) {
      expect(
        collaborationRendererEventSchema.safeParse({
          ...control,
          ...protectedField
        }).success
      ).toBe(false);
    }
  });
});
