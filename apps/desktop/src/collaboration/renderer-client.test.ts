import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  collaborationCommandResultSchema,
  collaborationRendererEventSchema,
  collaborationSafeErrorMessages,
  collaborationSnapshotSchema,
  type CollaborationCommandResult,
  type CollaborationRendererCommand,
  type CollaborationRendererEvent,
  type CollaborationSnapshot
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";

import {
  CollaborationClientError,
  createCollaborationRendererClient,
  type CollaborationRendererBridge
} from "./renderer-client.js";

const id = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const timestamp = "2026-07-17T08:30:00.000Z";
const revision = "snapshot.revision-000001";
const delivery = (suffix: number) =>
  `delivery_000000000000000000000000000000${suffix}`;

const ids = {
  user: id(1),
  other: id(2),
  team: id(3),
  workspace: id(4),
  notes: id(5),
  notesLogical: id(6),
  channel: id(7),
  channelLogical: id(8),
  message: id(9),
  subscription: id(10),
  teamSubscription: id(11),
  actionGrant: id(12),
  remoteUser: id(13),
  sharedSession: id(16),
  logicalMemory: id(15),
  shareGrant: id(16),
  discussion: id(17),
  discussionLogical: id(18),
  sourceItem: id(19),
  sourcePart: id(20),
  capturedSession: id(21),
  consent: id(22),
  logicalGrant: id(23),
  invitation: id(24),
  membership: id(25)
};

const approvalReview = {
  version: 1 as const,
  title: "Create Team?",
  description: "Review the exact Team creation request.",
  consequence: "A new Team will be created.",
  confirmLabel: "Create Team",
  details: []
};

const person = (personId = ids.user, displayName = "Mark") => ({
  id: personId,
  displayName,
  presence: "available" as const,
  membershipState: "enabled" as const
});

const teamPerson = (personId = ids.user, displayName = "Mark") => ({
  ...person(personId, displayName),
  teamPresence: {
    mode: "auto" as const,
    manualStatus: "available" as const,
    activityLevel: "active" as const,
    lastActivityAt: timestamp,
    nextTransitionAt: "2026-07-17T08:35:00.001Z",
    preferenceVersion: 1
  }
});

const participant = (personId = ids.user, displayName = "Mark") => {
  const value = person(personId, displayName);
  return {
    id: value.id,
    displayName: value.displayName,
    membershipState: value.membershipState
  };
};

const baseThread = {
  name: null,
  topic: null,
  version: 1,
  lifecycle: "active" as const,
  canPost: true,
  latestSequence: 0,
  unreadCount: 0,
  lastReadMessageId: null,
  lastReadSequence: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastActivityAt: timestamp,
  archivedAt: null
};

const notes = () => ({
  ...baseThread,
  id: ids.notes,
  logicalId: ids.notesLogical,
  scope: "personal" as const,
  ownerUserId: ids.user,
  kind: "notes_to_self" as const,
  participants: [participant()]
});

const channel = () => ({
  ...baseThread,
  id: ids.channel,
  logicalId: ids.channelLogical,
  scope: "team" as const,
  teamId: ids.team,
  workspaceId: ids.workspace,
  kind: "workspace_channel" as const,
  name: "general"
});

const emptyPage = (threadId: string) => ({
  snapshotRevision: revision,
  olderCursor: null,
  newerCursor: null,
  hasOlder: false,
  hasNewer: false,
  threadId,
  items: []
});

const fixture = (options?: {
  selectedTeam?: boolean;
  maxPendingEvents?: number;
  backendId?: string;
  teamPrincipalId?: string;
}): CollaborationSnapshot => {
  const selectedTeam = options?.selectedTeam ?? false;
  return collaborationSnapshotSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    snapshotRevision: revision,
    generatedAt: timestamp,
    connection: {
      state: "live",
      backendId: options?.backendId ?? "up_team_example",
      connectedAt: timestamp,
      retryAt: null,
      reconnectAttempt: 0,
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    },
    limits: {
      ...COLLABORATION_DEFAULT_LIMITS,
      rendererMaxPendingEvents:
        options?.maxPendingEvents ??
        COLLABORATION_DEFAULT_LIMITS.rendererMaxPendingEvents
    },
    navigation: {
      personalOwner: person(),
      teamPrincipal: person(options?.teamPrincipalId ?? ids.remoteUser),
      personal: { memory: [], notesToSelf: notes(), channels: [] },
      teams: [
        {
          id: ids.team,
          name: "Koed Team",
          role: "owner",
          lifecycle: "active",
          unreadCount: 0,
          people: [teamPerson(ids.remoteUser), teamPerson(ids.other, "Alex")],
          directMessages: [],
          version: 1,
          workspaces: [
            {
              id: ids.workspace,
              name: "Product",
              description: null,
              access: "write",
              lifecycle: "active",
              version: 1,
              channels: [channel()],
              sharedMemory: []
            }
          ]
        }
      ]
    },
    selection: selectedTeam
      ? {
          kind: "workspace_channel",
          teamId: ids.team,
          workspaceId: ids.workspace,
          threadId: ids.channel
        }
      : { kind: "notes_to_self" },
    view: selectedTeam
      ? { kind: "thread", thread: channel(), messages: emptyPage(ids.channel) }
      : { kind: "thread", thread: notes(), messages: emptyPage(ids.notes) }
  });
};

const sharedFixture = (): CollaborationSnapshot => {
  const current = fixture({ selectedTeam: true });
  const session = {
    id: ids.sharedSession,
    logicalMemoryId: ids.logicalMemory,
    shareGrantId: ids.shareGrant,
    teamId: ids.team,
    workspaceId: ids.workspace,
    owner: participant(ids.remoteUser),
    title: "Shared capture",
    latestActivityAt: timestamp,
    maximumFidelity: "memory_events" as const,
    includeCuratedMemory: false,
    liveState: "live" as const,
    sourceState: "ready" as const,
    sourceRevision: revision,
    companionThreadId: ids.discussion,
    unreadCompanionCount: 0,
    version: 1
  };
  const discussion = {
    ...baseThread,
    id: ids.discussion,
    logicalId: ids.discussionLogical,
    scope: "team" as const,
    teamId: ids.team,
    workspaceId: ids.workspace,
    kind: "shared_session_discussion" as const,
    sharedLogicalMemoryId: ids.logicalMemory,
    shareGrantId: ids.shareGrant
  };
  return collaborationSnapshotSchema.parse({
    ...current,
    navigation: {
      ...current.navigation,
      teams: current.navigation.teams.map((team) => ({
        ...team,
        workspaces: team.workspaces.map((workspace) => ({
          ...workspace,
          sharedMemory: [session]
        }))
      }))
    },
    selection: {
      kind: "shared_session",
      teamId: ids.team,
      workspaceId: ids.workspace,
      sharedSessionId: ids.sharedSession
    },
    view: {
      kind: "shared_session",
      session,
      source: {
        snapshotRevision: revision,
        olderCursor: null,
        newerCursor: null,
        hasOlder: false,
        hasNewer: false,
        sharedSessionId: ids.sharedSession,
        representation: "memory_events",
        items: [
          {
            id: ids.sourceItem,
            representation: "memory_events",
            sequence: 1,
            occurredAt: timestamp,
            sourceItems: [
              {
                id: ids.sourcePart,
                sourceKind: "agent_message",
                occurredAt: timestamp,
                body: "Higher-fidelity source must not survive a downgrade.",
                actorName: "Codex",
                toolName: null,
                toolCallId: null
              }
            ]
          }
        ]
      },
      companion: {
        thread: discussion,
        messages: emptyPage(ids.discussion)
      }
    }
  });
};

const sharedIndexFixture = (includeSession: boolean): CollaborationSnapshot => {
  const shared = sharedFixture();
  const team = shared.navigation.teams[0]!;
  const workspace = team.workspaces[0]!;
  const session = workspace.sharedMemory[0]!;
  const sessions = includeSession ? [session] : [];
  return collaborationSnapshotSchema.parse({
    ...shared,
    navigation: {
      ...shared.navigation,
      teams: [
        {
          ...team,
          workspaces: [{ ...workspace, sharedMemory: sessions }]
        }
      ]
    },
    selection: {
      kind: "workspace_shared_memory",
      teamId: ids.team,
      workspaceId: ids.workspace
    },
    view: {
      kind: "shared_memory_index",
      teamId: ids.team,
      workspaceId: ids.workspace,
      sessions
    }
  });
};

const subscription = (team = false, version = 1) => ({
  id: team ? ids.teamSubscription : ids.subscription,
  scope: team
    ? ({ scope: "team", teamId: ids.team } as const)
    : ({ scope: "personal" } as const),
  state: "active" as const,
  version,
  expiresAt: "2026-07-17T09:30:00.000Z"
});

const personalMemoryEntry = () => ({
  id: ids.capturedSession,
  logicalMemoryId: ids.logicalMemory,
  title: "Captured planning session",
  projectName: "koed",
  updatedAt: timestamp,
  preview: "12 Memory Events",
  eventCount: 12,
  hasSynchronizedRevision: true,
  syncState: "ready" as const
});

const sharedPreview = () => ({
  logicalMemoryId: ids.logicalMemory,
  teamId: ids.team,
  workspaceId: ids.workspace,
  representation: "memory_events" as const,
  maximumFidelity: "memory_events" as const,
  includeCuratedMemory: false,
  previewRevision: 1,
  sourceRevision: 12,
  policyRevision: 1,
  contentPolicyVersion: 1,
  classifierVersion: 1,
  sourceContentHash: "a".repeat(64),
  previewHash: "b".repeat(64),
  itemCount: 1,
  items: [
    {
      id: ids.sourceItem,
      representation: "memory_events" as const,
      sequence: 1,
      occurredAt: timestamp,
      sourceItems: [
        {
          id: ids.sourcePart,
          sourceKind: "agent_message" as const,
          occurredAt: timestamp,
          body: "Exact redacted preview",
          actorName: "Codex",
          toolName: null,
          toolCallId: null
        }
      ]
    }
  ],
  nextCursor: null
});

const success = (
  command: CollaborationRendererCommand,
  snapshot: CollaborationSnapshot,
  subscriptionVersions: Map<string, number>
): CollaborationCommandResult => {
  let data: unknown;
  switch (command.command) {
    case "collaboration.load":
    case "collaboration.select":
    case "collaboration.reconnect_backend":
    case "collaboration.disconnect_backend":
    case "collaboration.create_team":
    case "collaboration.join_team":
    case "collaboration.create_workspace":
      data = { snapshot };
      break;
    case "collaboration.request_action_grant":
    case "collaboration.await_action_grant":
      data = {
        status: {
          version: 1,
          actionGrant: { id: ids.actionGrant },
          approvalTier: "direct",
          review: null,
          state: "approved",
          activationUrl: null,
          expiresAt: "2026-07-18T09:30:00.000Z"
        }
      };
      break;
    case "collaboration.cancel_action_grant":
      data = {
        status: {
          version: 1,
          actionGrant: command.input.actionGrant,
          approvalTier: "direct",
          review: null,
          state: "canceled",
          activationUrl: null,
          expiresAt: "2026-07-18T09:30:00.000Z"
        }
      };
      break;
    case "collaboration.create_invitation":
      data = {
        invitation: {
          id: ids.invitation,
          teamId: command.input.teamId,
          defaultWorkspaceId: command.input.defaultWorkspaceId,
          defaultWorkspaceAccess: command.input.defaultWorkspaceAccess,
          email: command.input.email,
          role: command.input.role,
          lifecycle: "pending",
          version: 1,
          createdAt: timestamp,
          expiresAt: "2026-07-18T08:30:00.000Z",
          acceptedAt: null,
          revokedAt: null
        },
        invitationUrl:
          "https://team.example.test/invitations/accept?token=one-time"
      };
      break;
    case "collaboration.list_invitations":
      data = {
        page: { teamId: command.input.teamId, items: [], nextCursor: null }
      };
      break;
    case "collaboration.revoke_invitation":
      data = {
        invitation: {
          id: command.input.invitationId,
          teamId: command.input.teamId,
          defaultWorkspaceId: ids.workspace,
          defaultWorkspaceAccess: "write",
          email: "member@example.test",
          role: "member",
          lifecycle: "revoked",
          version: command.input.expectedVersion + 1,
          createdAt: timestamp,
          expiresAt: "2026-07-18T08:30:00.000Z",
          acceptedAt: null,
          revokedAt: timestamp
        }
      };
      break;
    case "collaboration.update_member_role":
    case "collaboration.disable_member":
    case "collaboration.leave_team": {
      const userId =
        command.command === "collaboration.leave_team"
          ? ids.remoteUser
          : command.input.userId;
      data = {
        membership: {
          id: ids.membership,
          teamId: command.input.teamId,
          userId,
          displayName: "Alex",
          email: "alex@example.test",
          role:
            command.command === "collaboration.update_member_role"
              ? command.input.role
              : "member",
          status:
            command.command === "collaboration.update_member_role"
              ? "enabled"
              : "disabled",
          version: command.input.expectedVersion + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          acceptedAt: timestamp,
          disabledAt:
            command.command === "collaboration.update_member_role"
              ? null
              : timestamp
        }
      };
      break;
    }
    case "collaboration.archive_workspace":
    case "collaboration.restore_workspace":
      data = {
        workspace: {
          id: command.input.workspaceId,
          teamId: command.input.teamId,
          name: "Product",
          description: null,
          lifecycle:
            command.command === "collaboration.archive_workspace"
              ? "archived"
              : "active",
          version: command.input.expectedVersion + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt:
            command.command === "collaboration.archive_workspace"
              ? timestamp
              : null
        }
      };
      break;
    case "collaboration.set_workspace_access":
      data = {
        access: {
          workspaceId: command.input.workspaceId,
          userId: command.input.userId,
          access: command.input.access,
          version: (command.input.expectedVersion ?? 0) + 1
        }
      };
      break;
    case "collaboration.prepare_shared_memory_source":
      data = { entry: personalMemoryEntry() };
      break;
    case "collaboration.preview_shared_memory_candidate": {
      const candidate = sharedPreview();
      data = {
        candidate: {
          sessionId: command.input.sessionId,
          logicalMemoryId: ids.logicalMemory,
          representation: command.input.representation,
          sourceRevision: candidate.sourceRevision,
          candidateHash: candidate.previewHash,
          itemCount: candidate.itemCount,
          excludedItemCount: 0,
          manifest: candidate.items.map((item) => ({
            sourceId: item.id,
            revisionHash: candidate.previewHash
          })),
          byteCount: 512,
          items: candidate.items
        }
      };
      break;
    }
    case "collaboration.preview_shared_memory":
    case "collaboration.load_shared_memory_preview_page":
      data = { preview: sharedPreview() };
      break;
    case "collaboration.share_memory":
      data = {
        grant: {
          id: ids.shareGrant,
          logicalGrantId: command.input.logicalGrantId,
          logicalMemoryId: command.input.logicalMemoryId,
          ownerUserId: ids.remoteUser,
          teamId: command.input.teamId,
          workspaceId: command.input.workspaceId,
          consentId: command.input.consentId,
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          fidelityPolicyRevision: 1,
          sourceRevision: 12,
          grantVersion: 1,
          lifecycle: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          revokedAt: null,
          companionThreadId: ids.discussion
        }
      };
      break;
    case "collaboration.rename_thread":
      data = {
        thread: {
          ...channel(),
          name: command.input.name,
          version: command.input.expectedVersion + 1
        }
      };
      break;
    case "collaboration.update_thread_topic":
      data = {
        thread: {
          ...channel(),
          topic: command.input.topic,
          version: command.input.expectedVersion + 1
        }
      };
      break;
    case "collaboration.archive_thread":
      data = {
        thread: {
          ...channel(),
          lifecycle: "archived",
          canPost: false,
          archivedAt: timestamp,
          version: command.input.expectedVersion + 1
        }
      };
      break;
    case "collaboration.restore_thread":
      data = {
        thread: {
          ...channel(),
          version: command.input.expectedVersion + 1
        }
      };
      break;
    case "collaboration.send_message":
    case "collaboration.retry_message":
      data = {
        message: {
          id: ids.message,
          threadId: command.input.thread.threadId,
          scope: command.input.thread.scope,
          teamId:
            command.input.thread.scope === "team"
              ? command.input.thread.teamId
              : null,
          sequence: 1,
          sender: participant(),
          senderKind: "user",
          body: command.input.body,
          createdAt: timestamp,
          updatedAt: timestamp,
          editedAt: null,
          deletedAt: null,
          delivery: "sent",
          recipientStatus: "sent",
          failure: null
        }
      };
      break;
    case "collaboration.mark_read":
    case "collaboration.mark_delivered":
      data = {
        readState: {
          threadId: command.input.thread.threadId,
          deliveredMessageId: command.input.messageId,
          deliveredSequence: 1,
          deliveredAt: timestamp,
          messageId:
            command.command === "collaboration.mark_read"
              ? command.input.messageId
              : null,
          sequence: command.command === "collaboration.mark_read" ? 1 : 0,
          readAt:
            command.command === "collaboration.mark_read" ? timestamp : null,
          unreadCount: command.command === "collaboration.mark_read" ? 0 : 1,
          version: command.command === "collaboration.mark_read" ? 2 : 1,
          updatedAt: timestamp
        }
      };
      break;
    case "collaboration.subscribe": {
      const team = command.input.scope.scope === "team";
      const next = subscription(team);
      subscriptionVersions.set(next.id, next.version);
      data = { subscription: next };
      break;
    }
    case "collaboration.unsubscribe":
      data = {};
      break;
    case "collaboration.acknowledge_delivery": {
      const nextVersion = command.input.expectedSubscriptionVersion + 1;
      subscriptionVersions.set(command.input.subscriptionId, nextVersion);
      data = {
        subscriptionId: command.input.subscriptionId,
        acknowledgedEventId: command.input.eventId,
        subscriptionVersion: nextVersion
      };
      break;
    }
    default:
      throw new Error(`Unexpected test command ${command.command}`);
  }
  return collaborationCommandResultSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: true,
    data
  });
};

const createBridge = (initial = fixture()) => {
  let current = initial;
  let listener: ((event: CollaborationRendererEvent) => void) | null = null;
  const versions = new Map<string, number>();
  const command = vi.fn(async (input: CollaborationRendererCommand) => {
    if (input.command === "collaboration.select") {
      const selection = input.input.selection;
      const keepsPreparedSharedSnapshot =
        selection.kind === "shared_session" &&
        current.selection.kind === "shared_session" &&
        current.selection.sharedSessionId === selection.sharedSessionId;
      if (!keepsPreparedSharedSnapshot) {
        const authoritative = current;
        current = collaborationSnapshotSchema.parse({
          ...fixture({ selectedTeam: "teamId" in selection }),
          connection: authoritative.connection,
          navigation: authoritative.navigation,
          snapshotRevision: authoritative.snapshotRevision
        });
        if (selection.kind === "team_people") {
          const team = current.navigation.teams.find(
            (candidate) => candidate.id === selection.teamId
          )!;
          current = collaborationSnapshotSchema.parse({
            ...current,
            selection,
            view: {
              kind: "team_people",
              teamId: selection.teamId,
              people: team.people
            }
          });
        }
      }
    }
    return success(input, current, versions);
  });
  const bridge: CollaborationRendererBridge = {
    command,
    subscribe(next) {
      listener = next;
      return () => {
        listener = null;
      };
    }
  };
  return {
    bridge,
    command,
    setSnapshot(next: CollaborationSnapshot) {
      current = next;
    },
    emit(event: CollaborationRendererEvent) {
      listener?.(collaborationRendererEventSchema.parse(event));
    }
  };
};

const waitFor = async (check: () => void) => {
  await vi.waitFor(check, { timeout: 2_000 });
};

describe("collaboration renderer client", () => {
  it("prewarms recent Shared Memory and renders the cached view before revalidation", async () => {
    const prepared = sharedFixture();
    const initial = collaborationSnapshotSchema.parse({
      ...prepared,
      selection: { kind: "notes_to_self" },
      view: {
        kind: "thread",
        thread: notes(),
        messages: emptyPage(ids.notes)
      }
    });
    const versions = new Map<string, number>();
    let releaseRevalidation: () => void = () => {
      throw new Error("Shared-session revalidation did not start.");
    };
    let sharedSelections = 0;
    const bridge: CollaborationRendererBridge = {
      command: vi.fn(async (command) => {
        if (
          command.command === "collaboration.select" &&
          command.input.selection.kind === "shared_session"
        ) {
          sharedSelections += 1;
          if (sharedSelections > 1) {
            await new Promise<void>((resolve) => {
              releaseRevalidation = resolve;
            });
          }
          return success(command, prepared, versions);
        }
        return success(command, initial, versions);
      }),
      subscribe: () => () => undefined
    };
    const client = createCollaborationRendererClient(bridge);
    await client.load();
    await waitFor(() => expect(sharedSelections).toBe(1));
    expect(
      vi
        .mocked(bridge.command)
        .mock.calls.find(
          ([command]) =>
            command.command === "collaboration.select" &&
            command.input.selection.kind === "shared_session"
        )?.[0]
    ).toMatchObject({ input: { navigationIntent: "prewarm" } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const selected = client.select(prepared.selection);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(client.current()?.view).toMatchObject({
      kind: "shared_session",
      session: { id: ids.sharedSession }
    });
    releaseRevalidation();
    await selected;
    expect(sharedSelections).toBe(2);
    client.dispose();
  });

  it("joins an in-flight Shared Memory prewarm instead of issuing a duplicate selection", async () => {
    const prepared = sharedFixture();
    const initial = collaborationSnapshotSchema.parse({
      ...prepared,
      selection: { kind: "notes_to_self" },
      view: {
        kind: "thread",
        thread: notes(),
        messages: emptyPage(ids.notes)
      }
    });
    const versions = new Map<string, number>();
    let releasePrewarm: () => void = () => {
      throw new Error("Shared-session prewarm did not start.");
    };
    let sharedSelections = 0;
    const bridge: CollaborationRendererBridge = {
      command: vi.fn(async (command) => {
        if (
          command.command === "collaboration.select" &&
          command.input.selection.kind === "shared_session"
        ) {
          sharedSelections += 1;
          await new Promise<void>((resolve) => {
            releasePrewarm = resolve;
          });
          return success(command, prepared, versions);
        }
        return success(command, initial, versions);
      }),
      subscribe: () => () => undefined
    };
    const client = createCollaborationRendererClient(bridge);
    await client.load();
    await waitFor(() => expect(sharedSelections).toBe(1));

    const selected = client.select(prepared.selection);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sharedSelections).toBe(1);
    releasePrewarm();
    await selected;

    expect(sharedSelections).toBe(1);
    expect(client.current()?.view).toMatchObject({
      kind: "shared_session",
      session: { id: ids.sharedSession }
    });
    client.dispose();
  });

  it("projects a durable queue immediately and reconciles duplicate confirmation to one sent row", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const input = {
      thread: { scope: "personal" as const, threadId: ids.notes },
      clientMessageId: id(90),
      body: "Persist before transport."
    };
    const durableSend = {
      clientMessageId: input.clientMessageId,
      authority: {
        scope: "personal" as const,
        ownerUserId: ids.user,
        threadId: ids.notes
      },
      body: input.body,
      localCreationOrder: 1,
      state: "queued" as const,
      retryable: true,
      removalSupported: false as const,
      failure: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    mock.command.mockImplementationOnce(async (command) =>
      collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: command.requestId,
        command: command.command,
        ok: true,
        data: { durableSend }
      })
    );

    await client.sendMessage(input);

    expect(client.current()?.outbox).toEqual([durableSend]);
    const confirmedMessage = {
      id: ids.message,
      clientMessageId: input.clientMessageId,
      threadId: ids.notes,
      scope: "personal" as const,
      teamId: null,
      sequence: 1,
      sender: participant(),
      senderKind: "user" as const,
      body: input.body,
      createdAt: timestamp,
      updatedAt: timestamp,
      editedAt: null,
      deletedAt: null,
      delivery: "sent" as const,
      recipientStatus: null,
      failure: null
    };
    const confirmation = collaborationRendererEventSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "durable_send",
      eventId: id(901),
      send: {
        ...durableSend,
        state: "sent",
        retryable: false
      },
      message: confirmedMessage
    });
    mock.emit(confirmation);
    mock.emit(confirmation);

    await waitFor(() => {
      expect(client.current()?.outbox).toEqual([]);
      const current = client.current();
      if (current?.view.kind !== "thread") {
        throw new Error("Expected thread view");
      }
      expect(current.view.messages.items).toEqual([confirmedMessage]);
    });
    client.dispose();
  });

  it("hydrates manual retry after renderer recreation with immutable copy/retry data and no removal capability", async () => {
    const initial = collaborationSnapshotSchema.parse({
      ...fixture(),
      outbox: [
        {
          clientMessageId: id(92),
          authority: {
            scope: "personal",
            ownerUserId: ids.user,
            threadId: ids.notes
          },
          body: "Survive renderer recreation.",
          localCreationOrder: 7,
          state: "manual_retry",
          retryable: true,
          removalSupported: false,
          failure: {
            code: "temporarily_unavailable",
            userMessage: collaborationSafeErrorMessages.temporarily_unavailable,
            retryable: true,
            retryAfterMs: null
          },
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ]
    });
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);

    await client.load();

    expect(client.current()?.outbox).toEqual(initial.outbox);
    expect(client.current()?.outbox?.[0]).toMatchObject({
      clientMessageId: id(92),
      body: "Survive renderer recreation.",
      state: "manual_retry",
      retryable: true,
      removalSupported: false
    });
    client.dispose();
  });

  it("publishes a failed send, retries its immutable identity, and renders one logical message", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const input = {
      thread: { scope: "personal" as const, threadId: ids.notes },
      clientMessageId: id(91),
      body: "Retry this exact body."
    };

    mock.command.mockImplementationOnce(async (command) =>
      collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: command.requestId,
        command: command.command,
        ok: true,
        data: {
          message: {
            id: ids.message,
            threadId: input.thread.threadId,
            scope: input.thread.scope,
            teamId: null,
            sequence: 1,
            sender: participant(),
            senderKind: "user",
            body: input.body,
            createdAt: timestamp,
            updatedAt: timestamp,
            editedAt: null,
            deletedAt: null,
            delivery: "failed",
            recipientStatus: null,
            failure: {
              code: "temporarily_unavailable",
              userMessage: "Collaboration is temporarily unavailable.",
              retryable: true,
              retryAfterMs: null
            }
          }
        }
      })
    );

    await expect(client.sendMessage(input)).rejects.toMatchObject({
      name: "CollaborationClientError",
      code: "temporarily_unavailable",
      retryable: true
    });
    expect(client.current()?.view).toMatchObject({
      kind: "thread",
      messages: {
        items: [
          expect.objectContaining({ body: input.body, delivery: "failed" })
        ]
      }
    });

    await client.retryMessage(input);

    expect(mock.command).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "collaboration.retry_message",
        input
      })
    );
    expect(client.current()?.view).toMatchObject({
      kind: "thread",
      messages: {
        items: [expect.objectContaining({ body: input.body, delivery: "sent" })]
      }
    });
    const current = client.current();
    if (current?.view.kind !== "thread") {
      throw new Error("Expected thread view");
    }
    expect(current.view.messages.items).toHaveLength(1);
    client.dispose();
  });

  it("ignores selection responses superseded by newer navigation", async () => {
    const initial = fixture();
    const channelSnapshot = fixture({ selectedTeam: true });
    const team = channelSnapshot.navigation.teams[0]!;
    const peopleSnapshot = collaborationSnapshotSchema.parse({
      ...channelSnapshot,
      selection: { kind: "team_people", teamId: ids.team },
      view: { kind: "team_people", teamId: ids.team, people: team.people }
    });
    const versions = new Map<string, number>();
    const pendingSelections: Array<{
      command: CollaborationRendererCommand;
      resolve: (result: CollaborationCommandResult) => void;
    }> = [];
    const bridge: CollaborationRendererBridge = {
      command: vi.fn(async (command) => {
        if (command.command !== "collaboration.select") {
          return success(command, initial, versions);
        }
        return await new Promise<CollaborationCommandResult>((resolve) => {
          pendingSelections.push({ command, resolve });
        });
      }),
      subscribe: () => () => undefined
    };
    const client = createCollaborationRendererClient(bridge);
    await client.load();

    const older = client.select({ kind: "team_people", teamId: ids.team });
    const newer = client.select({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    expect(pendingSelections).toHaveLength(2);

    pendingSelections[1]!.resolve(
      success(pendingSelections[1]!.command, channelSnapshot, versions)
    );
    await newer;
    pendingSelections[0]!.resolve(
      success(pendingSelections[0]!.command, peopleSnapshot, versions)
    );
    await older;

    expect(client.currentSelection()).toEqual(channelSnapshot.selection);
    expect(client.current()?.view.kind).toBe("thread");
    client.dispose();
  });

  it("does not launch stale snapshot work after subscription synchronization", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const originalCommand = mock.command.getMockImplementation()!;
    let releaseTeamSubscription: (() => void) | null = null;
    mock.command.mockImplementation(async (command) => {
      if (
        command.command === "collaboration.subscribe" &&
        command.input.scope.scope === "team"
      ) {
        await new Promise<void>((resolve) => {
          releaseTeamSubscription = resolve;
        });
      }
      return originalCommand(command);
    });

    const prepared = sharedFixture();
    const preparedTeam = prepared.navigation.teams[0]!;
    mock.setSnapshot(
      collaborationSnapshotSchema.parse({
        ...prepared,
        selection: { kind: "team_people", teamId: ids.team },
        view: {
          kind: "team_people",
          teamId: ids.team,
          people: preparedTeam.people
        }
      })
    );
    const older = client.select({ kind: "team_people", teamId: ids.team });
    await waitFor(() => expect(releaseTeamSubscription).not.toBeNull());

    mock.setSnapshot(fixture());
    await client.select({ kind: "notes_to_self" });
    releaseTeamSubscription!();
    await older;

    expect(client.currentSelection()).toEqual({ kind: "notes_to_self" });
    expect(
      mock.command.mock.calls.filter(
        ([command]) =>
          command.command === "collaboration.select" &&
          command.input.navigationIntent === "prewarm"
      )
    ).toHaveLength(0);
    client.dispose();
  });

  it("publishes an authorized navigation shell before selection I/O completes", async () => {
    const initial = fixture();
    const authoritative = collaborationSnapshotSchema.parse({
      ...fixture({ selectedTeam: true }),
      selection: {
        kind: "workspace_shared_memory",
        teamId: ids.team,
        workspaceId: ids.workspace
      },
      view: {
        kind: "shared_memory_index",
        teamId: ids.team,
        workspaceId: ids.workspace,
        sessions: []
      }
    });
    let releaseSelection!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const versions = new Map<string, number>();
    const bridge: CollaborationRendererBridge = {
      command: vi.fn(async (command) => {
        if (command.command === "collaboration.select") {
          await blocked;
          return success(command, authoritative, versions);
        }
        return success(command, initial, versions);
      }),
      subscribe: () => () => undefined
    };
    const client = createCollaborationRendererClient(bridge);
    await client.load();

    const selected = client.select(authoritative.selection);
    expect(client.currentSelection()).toEqual(authoritative.selection);
    expect(client.current()?.view).toEqual(authoritative.view);
    releaseSelection();
    await selected;
    client.dispose();
  });

  it("obtains an approved one-use Action Grant before creating a Team", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    await client.createTeam({ name: "Product Team" });

    const request = mock.command.mock.calls
      .map(([command]) => command)
      .find(
        (command) => command.command === "collaboration.request_action_grant"
      );
    const create = mock.command.mock.calls
      .map(([command]) => command)
      .find((command) => command.command === "collaboration.create_team");
    expect(request).toMatchObject({
      command: "collaboration.request_action_grant",
      input: {
        intent: {
          intent: "collaboration.create_team",
          name: "Product Team"
        }
      }
    });
    expect(create).toMatchObject({
      command: "collaboration.create_team",
      input: {
        name: "Product Team",
        actionGrant: { id: ids.actionGrant }
      }
    });
    if (
      request?.command !== "collaboration.request_action_grant" ||
      create?.command !== "collaboration.create_team"
    ) {
      throw new Error("Expected Action Grant and Team creation commands");
    }
    expect(request.input.intent.commandRequestId).toBe(create.requestId);
    expect(
      mock.command.mock.calls.some(
        ([command]) => command.command === "collaboration.await_action_grant"
      )
    ).toBe(false);
    client.dispose();
  });

  it("confirms an authoritative Native review without browser waiting", async () => {
    const mock = createBridge(fixture({ selectedTeam: true }));
    const review = {
      version: 1 as const,
      title: "Invite member@example.test?",
      description: "Review the exact invitation before it is issued.",
      consequence: "The recipient can join with read access.",
      confirmLabel: "Create invitation",
      details: [
        { label: "Team", value: "Koed Team" },
        { label: "Workspace", value: "Product" }
      ]
    };
    const confirmNativeReview = vi.fn(async () => true);
    const client = createCollaborationRendererClient(mock.bridge, {
      confirmNativeReview
    });
    await client.load();
    const defaultCommand = mock.command.getMockImplementation();
    if (!defaultCommand) throw new Error("Expected collaboration mock");
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.request_action_grant") {
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: {
            status: {
              version: 1,
              actionGrant: { id: ids.actionGrant },
              approvalTier: "native_review",
              review,
              state: "review_required",
              activationUrl: null,
              expiresAt: "2099-07-18T09:30:00.000Z"
            }
          }
        });
      }
      if (command.command === "collaboration.confirm_action_grant") {
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: {
            status: {
              version: 1,
              actionGrant: command.input.actionGrant,
              approvalTier: "native_review",
              review,
              state: "approved",
              activationUrl: null,
              expiresAt: "2099-07-18T09:30:00.000Z"
            }
          }
        });
      }
      return defaultCommand(command);
    });

    await client.createInvitation({
      teamId: ids.team,
      email: "member@example.test",
      role: "member",
      defaultWorkspaceId: ids.workspace,
      defaultWorkspaceAccess: "read",
      ttlHours: 72
    });

    expect(confirmNativeReview).toHaveBeenCalledWith(review);
    expect(
      mock.command.mock.calls.find(
        ([command]) => command.command === "collaboration.confirm_action_grant"
      )?.[0]
    ).toMatchObject({
      input: { actionGrant: { id: ids.actionGrant }, decision: "approve" }
    });
    expect(
      mock.command.mock.calls.some(
        ([command]) => command.command === "collaboration.await_action_grant"
      )
    ).toBe(false);
    client.dispose();
  });

  it("cancels Team invitation creation from the authoritative Native review", async () => {
    const mock = createBridge(fixture({ selectedTeam: true }));
    const review = {
      version: 1 as const,
      title: "Invite member@example.test?",
      description: "Review the exact invitation before it is issued.",
      consequence: "The recipient can join with read access.",
      confirmLabel: "Create invitation",
      details: [
        { label: "Team", value: "Koed Team" },
        { label: "Workspace", value: "Product" }
      ]
    };
    const confirmNativeReview = vi.fn(async () => false);
    const client = createCollaborationRendererClient(mock.bridge, {
      confirmNativeReview
    });
    await client.load();
    const defaultCommand = mock.command.getMockImplementation();
    if (!defaultCommand) throw new Error("Expected collaboration mock");
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.request_action_grant") {
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: {
            status: {
              version: 1,
              actionGrant: { id: ids.actionGrant },
              approvalTier: "native_review",
              review,
              state: "review_required",
              activationUrl: null,
              expiresAt: "2099-07-18T09:30:00.000Z"
            }
          }
        });
      }
      if (command.command === "collaboration.confirm_action_grant") {
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: {
            status: {
              version: 1,
              actionGrant: command.input.actionGrant,
              approvalTier: "native_review",
              review,
              state: "canceled",
              activationUrl: null,
              expiresAt: "2099-07-18T09:30:00.000Z"
            }
          }
        });
      }
      return defaultCommand(command);
    });

    await expect(
      client.createInvitation({
        teamId: ids.team,
        email: "member@example.test",
        role: "member",
        defaultWorkspaceId: ids.workspace,
        defaultWorkspaceAccess: "read",
        ttlHours: 72
      })
    ).rejects.toMatchObject({ code: "permission_denied" });

    expect(confirmNativeReview).toHaveBeenCalledWith(review);
    expect(
      mock.command.mock.calls.find(
        ([command]) => command.command === "collaboration.confirm_action_grant"
      )?.[0]
    ).toMatchObject({
      input: { actionGrant: { id: ids.actionGrant }, decision: "cancel" }
    });
    expect(
      mock.command.mock.calls.some(
        ([command]) => command.command === "collaboration.create_invitation"
      )
    ).toBe(false);
    client.dispose();
  });

  it("retries an ambiguous approved mutation with the same exact request", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const defaultCommand = mock.command.getMockImplementation();
    if (!defaultCommand) throw new Error("Expected collaboration mock");
    let attempts = 0;
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.create_team") {
        attempts += 1;
        if (attempts === 1) {
          return collaborationCommandResultSchema.parse({
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: command.requestId,
            command: command.command,
            ok: false,
            error: {
              code: "temporarily_unavailable",
              userMessage:
                collaborationSafeErrorMessages.temporarily_unavailable,
              retryable: true,
              retryAfterMs: 0
            }
          });
        }
      }
      return defaultCommand(command);
    });

    await client.createTeam({ name: "Product Team" });

    const attemptsMade = mock.command.mock.calls
      .map(([command]) => command)
      .filter((command) => command.command === "collaboration.create_team");
    expect(attemptsMade).toHaveLength(2);
    expect(attemptsMade[1]).toEqual(attemptsMade[0]);
    client.dispose();
  });

  it("continues waiting after a retryable Action Grant status limit", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    const observedStates: string[] = [];
    client.subscribeActionGrants?.(() => {
      const current = client.currentActionGrants?.().at(-1);
      if (current) observedStates.push(current.state);
    });
    await client.load();
    const defaultCommand = mock.command.getMockImplementation();
    if (!defaultCommand) throw new Error("Expected collaboration mock");
    let polls = 0;
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.request_action_grant") {
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: {
            status: {
              version: 1,
              actionGrant: { id: ids.actionGrant },
              approvalTier: "step_up",
              review: approvalReview,
              state: "pending",
              activationUrl: "https://team.example.test/approve",
              expiresAt: new Date(Date.now() + 60_000).toISOString()
            }
          }
        });
      }
      if (command.command === "collaboration.await_action_grant") {
        polls += 1;
        if (polls === 1) {
          return collaborationCommandResultSchema.parse({
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: command.requestId,
            command: command.command,
            ok: false,
            error: {
              code: "rate_limited",
              userMessage: collaborationSafeErrorMessages.rate_limited,
              retryable: true,
              retryAfterMs: 1
            }
          });
        }
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: {
            status: {
              version: 1,
              actionGrant: { id: ids.actionGrant },
              approvalTier: "step_up",
              review: approvalReview,
              state: "approved",
              activationUrl: null,
              expiresAt: new Date(Date.now() + 60_000).toISOString()
            }
          }
        });
      }
      return defaultCommand(command);
    });

    await client.createTeam({ name: "Product Team" });

    expect(polls).toBe(2);
    expect(
      mock.command.mock.calls.some(
        ([command]) => command.command === "collaboration.create_team"
      )
    ).toBe(true);
    expect(observedStates).toEqual([
      "awaiting_approval",
      "approved",
      "executing",
      "completed"
    ]);
    expect(client.currentActionGrants?.()).toEqual([
      expect.objectContaining({
        id: ids.actionGrant,
        operation: "Create Team",
        retryable: false,
        state: "completed"
      })
    ]);
    expect(JSON.stringify(client.currentActionGrants?.())).not.toContain(
      "activationUrl"
    );
    client.dispose();
  });

  it("continues an Action Grant across a non-revoking realtime resnapshot", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const defaultCommand = mock.command.getMockImplementation();
    if (!defaultCommand) throw new Error("Expected collaboration mock");
    let waits = 0;
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.request_action_grant") {
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: {
            status: {
              version: 1,
              actionGrant: { id: ids.actionGrant },
              approvalTier: "step_up",
              review: approvalReview,
              state: "pending",
              activationUrl: "https://team.example.test/approve",
              expiresAt: new Date(Date.now() + 60_000).toISOString()
            }
          }
        });
      }
      if (command.command === "collaboration.await_action_grant") {
        waits += 1;
        if (waits === 1) {
          mock.emit({
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            type: "control",
            subscriptionId: ids.subscription,
            occurredAt: timestamp,
            reason: "requires_snapshot"
          });
        }
      }
      return defaultCommand(command);
    });

    await client.createTeam({ name: "Product Team" });

    expect(waits).toBe(2);
    expect(
      mock.command.mock.calls.some(
        ([command]) => command.command === "collaboration.create_team"
      )
    ).toBe(true);
    client.dispose();
  });

  it("cancels an Action Grant when realtime authority is actually revoked", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const defaultCommand = mock.command.getMockImplementation();
    if (!defaultCommand) throw new Error("Expected collaboration mock");
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.request_action_grant") {
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: {
            status: {
              version: 1,
              actionGrant: { id: ids.actionGrant },
              approvalTier: "step_up",
              review: approvalReview,
              state: "pending",
              activationUrl: "https://team.example.test/approve",
              expiresAt: new Date(Date.now() + 60_000).toISOString()
            }
          }
        });
      }
      if (command.command === "collaboration.await_action_grant") {
        mock.emit({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          type: "control",
          subscriptionId: ids.subscription,
          occurredAt: timestamp,
          reason: "access_revoked"
        });
      }
      return defaultCommand(command);
    });

    await expect(
      client.createTeam({ name: "Product Team" })
    ).rejects.toMatchObject({
      code: "access_revoked"
    });
    expect(
      mock.command.mock.calls.some(
        ([command]) => command.command === "collaboration.create_team"
      )
    ).toBe(false);
    client.dispose();
  });

  it("uses strict versioned commands for Team and Workspace administration", async () => {
    const mock = createBridge(fixture({ selectedTeam: true }));
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    await client.createWorkspace({
      teamId: ids.team,
      name: "Operations",
      description: "Runbooks"
    });
    const created = await client.createInvitation({
      teamId: ids.team,
      email: "MEMBER@EXAMPLE.TEST",
      role: "member",
      defaultWorkspaceId: ids.workspace,
      defaultWorkspaceAccess: "read",
      ttlHours: 48
    });
    expect(created.invitation.email).toBe("member@example.test");
    await client.listInvitations({ teamId: ids.team });
    await client.revokeInvitation({
      teamId: ids.team,
      invitationId: ids.invitation,
      expectedVersion: 1
    });
    await client.updateMemberRole({
      teamId: ids.team,
      userId: ids.other,
      role: "admin",
      expectedVersion: 1
    });
    await client.disableMember({
      teamId: ids.team,
      userId: ids.other,
      expectedVersion: 2
    });
    await client.setWorkspaceAccess({
      teamId: ids.team,
      workspaceId: ids.workspace,
      userId: ids.other,
      access: "write",
      expectedVersion: null
    });
    await client.archiveWorkspace({
      teamId: ids.team,
      workspaceId: ids.workspace,
      expectedVersion: 1
    });
    await client.restoreWorkspace({
      teamId: ids.team,
      workspaceId: ids.workspace,
      expectedVersion: 2
    });
    await client.leaveTeam({ teamId: ids.team, expectedVersion: 1 });

    const commands = mock.command.mock.calls.map(([command]) => command);
    for (const protectedCommand of commands.filter((command) =>
      [
        "collaboration.create_workspace",
        "collaboration.create_invitation",
        "collaboration.revoke_invitation",
        "collaboration.update_member_role",
        "collaboration.disable_member",
        "collaboration.set_workspace_access",
        "collaboration.archive_workspace",
        "collaboration.restore_workspace",
        "collaboration.leave_team"
      ].includes(command.command)
    )) {
      const grant = commands.find(
        (candidate) =>
          candidate.command === "collaboration.request_action_grant" &&
          candidate.input.intent.commandRequestId === protectedCommand.requestId
      );
      expect(grant, protectedCommand.command).toBeDefined();
    }
    expect(commands).toContainEqual(
      expect.objectContaining({
        command: "collaboration.set_workspace_access",
        input: expect.objectContaining({
          access: "write",
          expectedVersion: null
        })
      })
    );
    client.dispose();
  });

  it("keeps Shared Memory authority IDs out of renderer intents while correlating the owner flow", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    const candidate = await client.previewSharedMemoryCandidate({
      sessionId: ids.capturedSession,
      representation: "memory_events"
    });
    const entry = await client.prepareSharedMemorySource({
      sessionId: ids.capturedSession
    });
    const preview = await client.previewSharedMemory({
      logicalMemoryId: entry.logicalMemoryId!,
      teamId: ids.team,
      workspaceId: ids.workspace,
      representation: "memory_events",
      maximumFidelity: "memory_events",
      includeCuratedMemory: false
    });
    await client.shareMemory({
      mutationId: ids.message,
      logicalGrantId: ids.logicalGrant,
      consentId: ids.consent,
      logicalMemoryId: ids.logicalMemory,
      teamId: ids.team,
      workspaceId: ids.workspace,
      mode: "continuous",
      maximumFidelity: "memory_events",
      includeCuratedMemory: false,
      previewRevision: preview.previewRevision,
      previewHash: preview.previewHash,
      expiresAt: null,
      title: "Launch review"
    });

    const commands = mock.command.mock.calls.map(([command]) => command);
    expect(candidate).toMatchObject({
      sessionId: ids.capturedSession,
      itemCount: 1,
      excludedItemCount: 0
    });
    expect(
      commands.find(
        (command) =>
          command.command === "collaboration.preview_shared_memory_candidate"
      )
    ).not.toHaveProperty("input.actionGrant");
    const previewGrant = commands.find(
      (command) =>
        command.command === "collaboration.request_action_grant" &&
        command.input.intent.intent === "collaboration.preview_shared_memory"
    );
    const shareGrant = commands.find(
      (command) =>
        command.command === "collaboration.request_action_grant" &&
        command.input.intent.intent === "collaboration.share_memory"
    );
    expect(previewGrant).not.toHaveProperty("input.intent.remoteReplicaId");
    expect(shareGrant).not.toHaveProperty("input.intent.previewId");
    expect(shareGrant).toHaveProperty("input.intent.title", "Launch review");
    const protectedCommands = commands.filter(
      (command) =>
        command.command === "collaboration.preview_shared_memory" ||
        command.command === "collaboration.share_memory"
    );
    for (const protectedCommand of protectedCommands) {
      const grant = commands.find(
        (candidate) =>
          candidate.command === "collaboration.request_action_grant" &&
          candidate.input.intent.commandRequestId === protectedCommand.requestId
      );
      expect(grant).toBeDefined();
    }
    client.dispose();
  });

  it("sends versioned thread lifecycle commands and applies authorized DTOs", async () => {
    const mock = createBridge(fixture({ selectedTeam: true }));
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    await client.renameThread({ thread: channel(), name: "planning" });
    expect(client.current()?.view).toEqual(
      expect.objectContaining({
        thread: expect.objectContaining({ name: "planning", version: 2 })
      })
    );
    await client.updateThreadTopic({ thread: channel(), topic: "Milestones" });
    await client.archiveThread({ thread: channel() });
    expect(client.current()?.view).toEqual(
      expect.objectContaining({
        thread: expect.objectContaining({
          lifecycle: "archived",
          canPost: false,
          version: 2
        })
      })
    );
    await client.restoreThread({ thread: channel() });

    const lifecycleCommands = mock.command.mock.calls
      .map(([command]) => command)
      .filter((command) =>
        [
          "collaboration.rename_thread",
          "collaboration.update_thread_topic",
          "collaboration.archive_thread",
          "collaboration.restore_thread"
        ].includes(command.command)
      );
    expect(lifecycleCommands).toHaveLength(4);
    expect(lifecycleCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "collaboration.rename_thread",
          input: expect.objectContaining({ expectedVersion: 1 })
        }),
        expect.objectContaining({
          command: "collaboration.update_thread_topic",
          input: expect.objectContaining({ expectedVersion: 1 })
        }),
        expect.objectContaining({
          command: "collaboration.archive_thread",
          input: expect.objectContaining({ expectedVersion: 1 })
        }),
        expect.objectContaining({
          command: "collaboration.restore_thread",
          input: expect.objectContaining({ expectedVersion: 1 })
        })
      ])
    );
    client.dispose();
  });

  it("creates UUID-correlated commands and safely rejects bridge mismatches", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    const load = mock.command.mock.calls[0]![0];
    expect(load.command).toBe("collaboration.load");
    expect(load.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const badBridge: CollaborationRendererBridge = {
      subscribe: () => () => undefined,
      command: async (command) =>
        ({
          ...success(command, fixture(), new Map()),
          requestId: id(999)
        }) as CollaborationCommandResult
    };
    await expect(
      createCollaborationRendererClient(badBridge).load()
    ).rejects.toMatchObject({
      name: "CollaborationClientError",
      code: "temporarily_unavailable",
      message: collaborationSafeErrorMessages.temporarily_unavailable
    });
    client.dispose();
  });

  it("redacts bridge rejection details before they reach Team connection UI", async () => {
    const privateDetail =
      "private enrollment URL https://internal.invalid with secret key";
    const bridge: CollaborationRendererBridge = {
      subscribe: () => () => undefined,
      command: async () => {
        throw new Error(privateDetail);
      }
    };
    const client = createCollaborationRendererClient(bridge);

    const error = await client
      .connectRemote({ remoteUrl: "https://team.example.test" })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      name: "CollaborationClientError",
      code: "temporarily_unavailable",
      message: collaborationSafeErrorMessages.temporarily_unavailable
    });
    expect(String(error)).not.toContain(privateDetail);
    client.dispose();
  });

  it("throws typed safe failures", async () => {
    const mock = createBridge();
    mock.bridge.command = async (command) =>
      collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: command.requestId,
        command: command.command,
        ok: false,
        error: {
          code: "permission_denied",
          userMessage: "You do not have access to this collaboration item.",
          retryable: false,
          retryAfterMs: null
        }
      });
    const client = createCollaborationRendererClient(mock.bridge);
    const error = await client.load().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CollaborationClientError);
    expect(error).toMatchObject({
      code: "permission_denied",
      retryable: false
    });
    client.dispose();
  });

  it("applies before acknowledgement, dedupes event IDs, and acknowledges redelivery", async () => {
    const mock = createBridge();
    const order: string[] = [];
    const announcements: string[] = [];
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.acknowledge_delivery") {
        order.push("ack");
      }
      return success(command, fixture(), new Map());
    });
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    client.subscribe((_snapshot, update) => {
      if (update.kind === "realtime") {
        order.push("apply");
        if (update.announcement) announcements.push(update.announcement);
      }
    });

    const eventId = id(20);
    const message = {
      id: ids.message,
      threadId: ids.notes,
      scope: "personal" as const,
      teamId: null,
      sequence: 1,
      sender: participant(ids.other, "Alice"),
      senderKind: "user" as const,
      body: "Applied exactly once.",
      createdAt: timestamp,
      updatedAt: timestamp,
      editedAt: null,
      deletedAt: null,
      delivery: "sent" as const,
      recipientStatus: null,
      failure: null
    };
    const realtime = (deliveryId: string): CollaborationRendererEvent => ({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.subscription,
      deliveryId,
      eventId,
      occurredAt: timestamp,
      family: "message_created",
      resource: {
        scope: "personal",
        teamId: null,
        workspaceId: null,
        threadId: ids.notes,
        messageId: ids.message,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: { type: "message_created", message }
    });
    mock.emit(realtime(delivery(1)));
    await waitFor(() => expect(order).toEqual(["apply", "ack"]));
    await waitFor(() =>
      expect(mock.command).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "collaboration.mark_delivered",
          input: {
            thread: { scope: "personal", threadId: ids.notes },
            messageId: ids.message
          }
        })
      )
    );
    mock.emit(realtime(delivery(2)));
    await waitFor(() => expect(order).toEqual(["apply", "ack", "ack"]));
    expect(announcements).toEqual([
      "New message from Alice: Applied exactly once."
    ]);
    const current = client.current();
    expect(current?.view.kind).toBe("thread");
    expect(
      current?.view.kind === "thread" ? current.view.messages.items : []
    ).toHaveLength(1);
    client.dispose();
  });

  it("retries a transient background delivery receipt until it succeeds", async () => {
    const mock = createBridge();
    let deliveryAttempts = 0;
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.mark_delivered") {
        deliveryAttempts += 1;
        if (deliveryAttempts === 1) {
          return collaborationCommandResultSchema.parse({
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: command.requestId,
            command: command.command,
            ok: false,
            error: {
              code: "temporarily_unavailable",
              userMessage:
                collaborationSafeErrorMessages.temporarily_unavailable,
              retryable: true,
              retryAfterMs: 1
            }
          });
        }
      }
      return success(command, fixture(), new Map());
    });
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.subscription,
      deliveryId: delivery(91),
      eventId: id(91),
      occurredAt: timestamp,
      family: "message_created",
      resource: {
        scope: "personal",
        teamId: null,
        workspaceId: null,
        threadId: ids.notes,
        messageId: ids.message,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: {
        type: "message_created",
        message: {
          id: ids.message,
          threadId: ids.notes,
          scope: "personal",
          teamId: null,
          sequence: 1,
          sender: participant(ids.other, "Alice"),
          senderKind: "user",
          body: "Retry delivery.",
          createdAt: timestamp,
          updatedAt: timestamp,
          editedAt: null,
          deletedAt: null,
          delivery: "sent",
          recipientStatus: null,
          failure: null
        }
      }
    });

    await waitFor(() => expect(deliveryAttempts).toBe(2));
    client.dispose();
  });

  it("does not let an older receipt response regress newer read state", async () => {
    const mock = createBridge();
    let resolveDelivered:
      | ((result: CollaborationCommandResult) => void)
      | null = null;
    let resolveRead: ((result: CollaborationCommandResult) => void) | null =
      null;
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.mark_delivered") {
        return new Promise<CollaborationCommandResult>((resolve) => {
          resolveDelivered = resolve;
        });
      }
      if (command.command === "collaboration.mark_read") {
        return new Promise<CollaborationCommandResult>((resolve) => {
          resolveRead = resolve;
        });
      }
      return success(command, fixture(), new Map());
    });
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    const delivered = client.markDelivered({
      thread: { scope: "personal", threadId: ids.notes },
      messageId: ids.message
    });
    const read = client.markRead({
      thread: { scope: "personal", threadId: ids.notes },
      messageId: ids.message
    });
    await waitFor(() => {
      expect(resolveDelivered).not.toBeNull();
      expect(resolveRead).not.toBeNull();
    });
    const commandResult = (
      command: "collaboration.mark_delivered" | "collaboration.mark_read",
      version: number,
      sequence: number,
      unreadCount: number
    ) =>
      collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: mock.command.mock.calls.find(
          ([candidate]) => candidate.command === command
        )![0].requestId,
        command,
        ok: true,
        data: {
          readState: {
            threadId: ids.notes,
            deliveredMessageId: ids.message,
            deliveredSequence: 1,
            deliveredAt: timestamp,
            messageId: sequence > 0 ? ids.message : null,
            sequence,
            readAt: sequence > 0 ? timestamp : null,
            unreadCount,
            version,
            updatedAt: timestamp
          }
        }
      });

    resolveRead!(commandResult("collaboration.mark_read", 2, 1, 0));
    await read;
    resolveDelivered!(commandResult("collaboration.mark_delivered", 1, 0, 1));
    await delivered;

    const current = client.current();
    expect(current?.view.kind).toBe("thread");
    expect(
      current?.view.kind === "thread" && current.view.thread
    ).toMatchObject({
      lastReadSequence: 1,
      unreadCount: 0
    });
    client.dispose();
  });

  it("applies a realtime Personal Memory sync-state upsert to navigation", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const entry = {
      id: ids.capturedSession,
      logicalMemoryId: ids.logicalMemory,
      title: "Realtime sync state",
      projectName: "Koed",
      updatedAt: timestamp,
      preview: "4 Memory Events",
      eventCount: 4,
      hasSynchronizedRevision: true,
      syncState: "ready" as const
    };

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.subscription,
      deliveryId: delivery(3),
      eventId: id(30),
      occurredAt: timestamp,
      family: "personal_memory_changed",
      resource: {
        scope: "personal",
        teamId: null,
        workspaceId: null,
        threadId: null,
        messageId: null,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: { type: "personal_memory_upserted", entry }
    });

    await waitFor(() =>
      expect(client.current()?.navigation.personal.memory).toEqual([entry])
    );
    client.dispose();
  });

  it("merges a pushed Team person without dropping management metadata or reordering the roster", async () => {
    const initial = fixture();
    const management = {
      membershipId: ids.membership,
      email: "managed@example.test",
      role: "owner" as const,
      status: "enabled" as const,
      version: 4,
      workspaceAccess: [
        {
          workspaceId: ids.workspace,
          userId: ids.remoteUser,
          access: "write" as const,
          version: 2
        }
      ]
    };
    const managedPeople = initial.navigation.teams[0]!.people.map((person) =>
      person.id === ids.remoteUser ? { ...person, management } : person
    );
    const managedSnapshot = collaborationSnapshotSchema.parse({
      ...initial,
      navigation: {
        ...initial.navigation,
        teams: initial.navigation.teams.map((team) => ({
          ...team,
          people: managedPeople
        }))
      },
      selection: { kind: "team_people", teamId: ids.team },
      view: { kind: "team_people", teamId: ids.team, people: managedPeople }
    });
    const mock = createBridge(managedSnapshot);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const updatedPerson = {
      ...teamPerson(ids.remoteUser),
      presence: "away" as const,
      teamPresence: {
        mode: "manual" as const,
        manualStatus: "do_not_disturb" as const,
        activityLevel: null,
        lastActivityAt: null,
        nextTransitionAt: null,
        preferenceVersion: 2
      }
    };

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.teamSubscription,
      deliveryId: delivery(4),
      eventId: id(31),
      occurredAt: timestamp,
      family: "team_presence_changed",
      resource: {
        scope: "team",
        teamId: ids.team,
        workspaceId: null,
        threadId: null,
        messageId: null,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: {
        type: "team_person_upserted",
        teamId: ids.team,
        person: updatedPerson
      }
    });

    await waitFor(() =>
      expect(
        client
          .current()
          ?.navigation.teams[0]?.people.map((candidate) => candidate.id)
      ).toEqual([ids.remoteUser, ids.other])
    );
    expect(
      client.current()?.navigation.teams[0]?.people[0]?.teamPresence
    ).toMatchObject({
      mode: "manual",
      manualStatus: "do_not_disturb",
      preferenceVersion: 2
    });
    expect(
      client.current()?.navigation.teams[0]?.people[0]?.management
    ).toEqual(management);
    const current = client.current();
    expect(
      current?.view.kind === "team_people"
        ? current.view.people[0]?.management
        : null
    ).toEqual(management);
    client.dispose();
  });

  it("does not let a delayed presence command overwrite a newer pushed preference", async () => {
    const initial = fixture();
    const people = initial.navigation.teams[0]!.people;
    const mock = createBridge(
      collaborationSnapshotSchema.parse({
        ...initial,
        selection: { kind: "team_people", teamId: ids.team },
        view: { kind: "team_people", teamId: ids.team, people }
      })
    );
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    let resolveCommand!: (result: CollaborationCommandResult) => void;
    let commandRequestId = "";
    mock.command.mockImplementationOnce(
      (command) =>
        new Promise<CollaborationCommandResult>((resolve) => {
          commandRequestId = command.requestId;
          resolveCommand = resolve;
        })
    );

    const pending = client.setTeamPresence({
      teamId: ids.team,
      mode: "manual",
      manualStatus: "do_not_disturb",
      expectedVersion: 1
    });
    const pushedPerson = {
      ...teamPerson(ids.remoteUser),
      teamPresence: {
        mode: "manual" as const,
        manualStatus: "out_of_office" as const,
        activityLevel: null,
        lastActivityAt: null,
        nextTransitionAt: null,
        preferenceVersion: 3
      }
    };
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.teamSubscription,
      deliveryId: delivery(5),
      eventId: id(32),
      occurredAt: timestamp,
      family: "team_presence_changed",
      resource: {
        scope: "team",
        teamId: ids.team,
        workspaceId: null,
        threadId: null,
        messageId: null,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: {
        type: "team_person_upserted",
        teamId: ids.team,
        person: pushedPerson
      }
    });
    await waitFor(() =>
      expect(
        client.current()?.navigation.teams[0]?.people[0]?.teamPresence
          .preferenceVersion
      ).toBe(3)
    );

    resolveCommand(
      collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: commandRequestId,
        command: "collaboration.set_team_presence",
        ok: true,
        data: {
          person: {
            ...teamPerson(ids.remoteUser),
            teamPresence: {
              mode: "manual",
              manualStatus: "do_not_disturb",
              activityLevel: null,
              lastActivityAt: null,
              nextTransitionAt: null,
              preferenceVersion: 2
            }
          }
        }
      })
    );
    await pending;

    expect(
      client.current()?.navigation.teams[0]?.people[0]?.teamPresence
    ).toMatchObject({
      manualStatus: "out_of_office",
      preferenceVersion: 3
    });
    client.dispose();
  });

  it("reloads authoritative presence after an optimistic preference conflict", async () => {
    const initial = fixture();
    const initialTeam = initial.navigation.teams[0]!;
    const selectedPeople = collaborationSnapshotSchema.parse({
      ...initial,
      selection: { kind: "team_people", teamId: ids.team },
      view: {
        kind: "team_people",
        teamId: ids.team,
        people: initialTeam.people
      }
    });
    const mock = createBridge(selectedPeople);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const authoritativePerson = {
      ...teamPerson(ids.remoteUser),
      teamPresence: {
        mode: "manual" as const,
        manualStatus: "out_of_office" as const,
        activityLevel: null,
        lastActivityAt: null,
        nextTransitionAt: null,
        preferenceVersion: 4
      }
    };
    const authoritative = collaborationSnapshotSchema.parse({
      ...selectedPeople,
      navigation: {
        ...selectedPeople.navigation,
        teams: selectedPeople.navigation.teams.map((team) => ({
          ...team,
          people: team.people.map((candidate) =>
            candidate.id === ids.remoteUser ? authoritativePerson : candidate
          )
        }))
      },
      view: {
        kind: "team_people",
        teamId: ids.team,
        people: initialTeam.people.map((candidate) =>
          candidate.id === ids.remoteUser ? authoritativePerson : candidate
        )
      }
    });
    mock.setSnapshot(authoritative);
    mock.command.mockImplementationOnce(async (command) =>
      collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: command.requestId,
        command: "collaboration.set_team_presence",
        ok: false,
        error: {
          code: "conflict",
          userMessage: collaborationSafeErrorMessages.conflict,
          retryable: true,
          retryAfterMs: null
        }
      })
    );
    mock.command.mockImplementationOnce(async (command) =>
      success(command, authoritative, new Map())
    );

    await expect(
      client.setTeamPresence({
        teamId: ids.team,
        mode: "manual",
        manualStatus: "do_not_disturb",
        expectedVersion: 1
      })
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      client.current()?.navigation.teams[0]?.people[0]?.teamPresence
    ).toMatchObject({
      manualStatus: "out_of_office",
      preferenceVersion: 4
    });
    expect(client.currentSelection()).toEqual({
      kind: "team_people",
      teamId: ids.team
    });
    expect(
      mock.command.mock.calls.filter(
        ([command]) => command.command === "collaboration.load"
      )
    ).toHaveLength(2);
    expect(
      mock.command.mock.calls
        .filter(([command]) => command.command === "collaboration.load")
        .at(-1)?.[0].input
    ).toEqual({ forceRemoteNavigation: true });
    expect(
      mock.command.mock.calls
        .filter(([command]) => command.command === "collaboration.select")
        .at(-1)?.[0].input
    ).toEqual({
      selection: { kind: "team_people", teamId: ids.team }
    });
    client.dispose();
  });

  it("retries a failed acknowledgement in order without applying a delivery twice", async () => {
    const mock = createBridge();
    const acknowledgedDeliveries: string[] = [];
    let acknowledgementAttempt = 0;
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.acknowledge_delivery") {
        acknowledgedDeliveries.push(command.input.deliveryId);
        acknowledgementAttempt += 1;
        if (acknowledgementAttempt === 1) {
          return collaborationCommandResultSchema.parse({
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: command.requestId,
            command: command.command,
            ok: false,
            error: {
              code: "offline",
              userMessage: collaborationSafeErrorMessages.offline,
              retryable: true,
              retryAfterMs: 1
            }
          });
        }
      }
      return success(command, fixture(), new Map());
    });
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    let applied = 0;
    client.subscribe((_snapshot, update) => {
      if (update.kind === "realtime") applied += 1;
    });

    const realtime = (
      deliveryId: string,
      eventId: string,
      messageId: string,
      sequence: number
    ): CollaborationRendererEvent => ({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.subscription,
      deliveryId,
      eventId,
      occurredAt: timestamp,
      family: "message_created",
      resource: {
        scope: "personal",
        teamId: null,
        workspaceId: null,
        threadId: ids.notes,
        messageId,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: {
        type: "message_created",
        message: {
          id: messageId,
          threadId: ids.notes,
          scope: "personal",
          teamId: null,
          sequence,
          sender: participant(),
          senderKind: "user",
          body: `Message ${sequence}`,
          createdAt: timestamp,
          updatedAt: timestamp,
          editedAt: null,
          deletedAt: null,
          delivery: "sent",
          recipientStatus: null,
          failure: null
        }
      }
    });
    mock.emit(realtime(delivery(41), id(41), id(51), 1));
    mock.emit(realtime(delivery(42), id(42), id(52), 2));

    await waitFor(() =>
      expect(acknowledgedDeliveries).toEqual([
        delivery(41),
        delivery(41),
        delivery(42)
      ])
    );
    expect(applied).toBe(2);
    const current = client.current();
    expect(current?.view.kind).toBe("thread");
    expect(
      current?.view.kind === "thread" ? current.view.messages.items : []
    ).toHaveLength(2);
    client.dispose();
  });

  it("purges an open higher-fidelity source before applying a fidelity downgrade", async () => {
    const initial = sharedFixture();
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    if (initial.view.kind !== "shared_session") {
      throw new Error("Expected Shared Memory fixture");
    }
    const downgradedSession = {
      ...initial.view.session,
      maximumFidelity: "lcm_leaves" as const,
      sourceRevision: "snapshot.revision-000002",
      version: 2
    };
    mock.setSnapshot(
      collaborationSnapshotSchema.parse({
        ...initial,
        navigation: {
          ...initial.navigation,
          teams: initial.navigation.teams.map((team) => ({
            ...team,
            workspaces: team.workspaces.map((workspace) => ({
              ...workspace,
              sharedMemory: [downgradedSession]
            }))
          }))
        },
        view: {
          ...initial.view,
          session: downgradedSession,
          source: {
            snapshotRevision: downgradedSession.sourceRevision,
            olderCursor: null,
            newerCursor: null,
            hasOlder: false,
            hasNewer: false,
            sharedSessionId: ids.sharedSession,
            representation: "lcm_leaves",
            items: [
              {
                id: id(32),
                representation: "lcm_leaves",
                sequence: 1,
                occurredAt: timestamp,
                summaryText: "Only the authorized leaf summary remains.",
                lexicalAnchors: ["authorized-leaf-summary"],
                sourceCount: 4,
                sourceRevision: downgradedSession.sourceRevision
              }
            ]
          }
        }
      })
    );
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.teamSubscription,
      deliveryId: delivery(30),
      eventId: id(30),
      occurredAt: timestamp,
      family: "fidelity_changed",
      resource: {
        scope: "team",
        teamId: ids.team,
        workspaceId: ids.workspace,
        threadId: null,
        messageId: null,
        sharedSessionId: ids.sharedSession,
        shareGrantId: ids.shareGrant
      },
      update: {
        type: "shared_session_upserted",
        session: downgradedSession
      }
    });
    await waitFor(() => {
      const current = client.current();
      expect(current?.view.kind).toBe("shared_session");
      if (current?.view.kind !== "shared_session") return;
      expect(current.view.session.maximumFidelity).toBe("lcm_leaves");
      expect(current.view.source.representation).toBe("lcm_leaves");
      expect(current.view.source.items).toHaveLength(1);
      expect(JSON.stringify(current.view)).not.toContain(
        "Higher-fidelity source"
      );
    });
    expect(
      mock.command.mock.calls.filter(
        ([command]) => command.command === "collaboration.select"
      )
    ).toHaveLength(1);
    client.dispose();
  });

  it("preserves the Shared Memory shell and companion while fidelity is unavailable", async () => {
    const initial = sharedFixture();
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.teamSubscription,
      deliveryId: delivery(31),
      eventId: id(31),
      occurredAt: timestamp,
      family: "fidelity_changed",
      resource: {
        scope: "team",
        teamId: ids.team,
        workspaceId: ids.workspace,
        threadId: null,
        messageId: null,
        sharedSessionId: ids.sharedSession,
        shareGrantId: ids.shareGrant
      },
      update: {
        type: "shared_session_removed",
        sharedSessionId: ids.sharedSession
      }
    });

    await waitFor(() => {
      const current = client.current();
      expect(current?.selection).toEqual(initial.selection);
      expect(current?.view.kind).toBe("shared_session");
      if (current?.view.kind !== "shared_session") return;
      expect(current.view.session).toMatchObject({
        sourceState: "unavailable"
      });
      expect(current.view.source.items).toEqual([]);
      expect(current.view.companion).toEqual(
        initial.view.kind === "shared_session" ? initial.view.companion : null
      );
    });
    client.dispose();
  });

  it("adds a newly shared session to the open Shared Memory index", async () => {
    const initial = sharedIndexFixture(false);
    const session =
      sharedFixture().navigation.teams[0]!.workspaces[0]!.sharedMemory[0]!;
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.teamSubscription,
      deliveryId: delivery(41),
      eventId: id(41),
      occurredAt: timestamp,
      family: "thread_lifecycle",
      resource: {
        scope: "team",
        teamId: ids.team,
        workspaceId: ids.workspace,
        threadId: ids.discussion,
        messageId: null,
        sharedSessionId: ids.sharedSession,
        shareGrantId: ids.shareGrant
      },
      update: { type: "shared_session_upserted", session }
    });

    await waitFor(() => {
      const current = client.current();
      expect(current?.view.kind).toBe("shared_memory_index");
      if (current?.view.kind !== "shared_memory_index") return;
      expect(current.view.sessions).toEqual([session]);
    });
    client.dispose();
  });

  it("removes a revoked session from the open Shared Memory index", async () => {
    const initial = sharedIndexFixture(true);
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.teamSubscription,
      deliveryId: delivery(42),
      eventId: id(42),
      occurredAt: timestamp,
      family: "access_revoked",
      resource: {
        scope: "team",
        teamId: ids.team,
        workspaceId: ids.workspace,
        threadId: null,
        messageId: null,
        sharedSessionId: ids.sharedSession,
        shareGrantId: ids.shareGrant
      },
      update: {
        type: "shared_session_removed",
        sharedSessionId: ids.sharedSession
      }
    });

    await waitFor(() => {
      const current = client.current();
      expect(current?.view.kind).toBe("shared_memory_index");
      if (current?.view.kind !== "shared_memory_index") return;
      expect(current.view.sessions).toEqual([]);
    });
    client.dispose();
  });

  it("falls back within the Team when a Shared Memory grant is permanently removed", async () => {
    const initial = sharedFixture();
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.teamSubscription,
      deliveryId: delivery(32),
      eventId: id(32),
      occurredAt: timestamp,
      family: "share_grant_lifecycle",
      resource: {
        scope: "team",
        teamId: ids.team,
        workspaceId: ids.workspace,
        threadId: null,
        messageId: null,
        sharedSessionId: ids.sharedSession,
        shareGrantId: ids.shareGrant
      },
      update: {
        type: "shared_session_removed",
        sharedSessionId: ids.sharedSession
      }
    });

    await waitFor(() => {
      expect(client.currentSelection()).toEqual({
        kind: "team_people",
        teamId: ids.team
      });
    });
    client.dispose();
  });

  it("propagates companion discussion unread state through Shared Memory navigation", async () => {
    const mock = createBridge(sharedFixture());
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const incoming = {
      id: ids.message,
      threadId: ids.discussion,
      scope: "team" as const,
      teamId: ids.team,
      sequence: 1,
      sender: participant(ids.other, "Alex"),
      senderKind: "user" as const,
      body: "Review the shared source.",
      createdAt: timestamp,
      updatedAt: timestamp,
      editedAt: null,
      deletedAt: null,
      delivery: "sent" as const,
      recipientStatus: null,
      failure: null
    };
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.teamSubscription,
      deliveryId: delivery(40),
      eventId: id(40),
      occurredAt: timestamp,
      family: "shared_session_discussion_activity",
      resource: {
        scope: "team",
        teamId: ids.team,
        workspaceId: ids.workspace,
        threadId: ids.discussion,
        messageId: ids.message,
        sharedSessionId: ids.sharedSession,
        shareGrantId: ids.shareGrant
      },
      update: { type: "message_created", message: incoming }
    });
    await waitFor(() => {
      const current = client.current();
      expect(current?.navigation.teams[0]?.unreadCount).toBe(1);
      expect(
        current?.navigation.teams[0]?.workspaces[0]?.sharedMemory[0]
          ?.unreadCompanionCount
      ).toBe(1);
      if (current?.view.kind !== "shared_session") {
        throw new Error("Expected Shared Memory view");
      }
      expect(current.view.companion.thread.unreadCount).toBe(1);
      expect(current.view.session.unreadCompanionCount).toBe(1);
    });

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.teamSubscription,
      deliveryId: delivery(41),
      eventId: id(41),
      occurredAt: timestamp,
      family: "shared_session_discussion_activity",
      resource: {
        scope: "team",
        teamId: ids.team,
        workspaceId: ids.workspace,
        threadId: ids.discussion,
        messageId: ids.message,
        sharedSessionId: ids.sharedSession,
        shareGrantId: ids.shareGrant
      },
      update: {
        type: "receipt_state_updated",
        readState: {
          threadId: ids.discussion,
          deliveredMessageId: ids.message,
          deliveredSequence: 1,
          deliveredAt: timestamp,
          sequence: 1,
          messageId: ids.message,
          readAt: timestamp,
          unreadCount: 0,
          version: 2,
          updatedAt: timestamp
        }
      }
    });
    await waitFor(() => {
      const current = client.current();
      expect(current?.navigation.teams[0]?.unreadCount).toBe(0);
      expect(
        current?.navigation.teams[0]?.workspaces[0]?.sharedMemory[0]
          ?.unreadCompanionCount
      ).toBe(0);
    });
    client.dispose();
  });

  it("recovers a crash after event application but before acknowledgement", async () => {
    const mock = createBridge();
    const versions = new Map<string, number>();
    let rendererGeneration = 1;
    let abandonedAcknowledgements = 0;
    let successfulAcknowledgements = 0;
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.acknowledge_delivery") {
        if (rendererGeneration === 1) {
          abandonedAcknowledgements += 1;
          return new Promise<CollaborationCommandResult>(() => undefined);
        }
        successfulAcknowledgements += 1;
      }
      return success(command, fixture(), versions);
    });
    const message = {
      id: ids.message,
      threadId: ids.notes,
      scope: "personal" as const,
      teamId: null,
      sequence: 1,
      sender: participant(),
      senderKind: "user" as const,
      body: "Replayed after reload.",
      createdAt: timestamp,
      updatedAt: timestamp,
      editedAt: null,
      deletedAt: null,
      delivery: "sent" as const,
      recipientStatus: null,
      failure: null
    };
    const replay = (deliveryId: string): CollaborationRendererEvent => ({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.subscription,
      deliveryId,
      eventId: id(27),
      occurredAt: timestamp,
      family: "message_created",
      resource: {
        scope: "personal",
        teamId: null,
        workspaceId: null,
        threadId: ids.notes,
        messageId: ids.message,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: { type: "message_created", message }
    });

    const first = createCollaborationRendererClient(mock.bridge);
    await first.load();
    let firstApplications = 0;
    first.subscribe((_snapshot, update) => {
      if (update.kind === "realtime") firstApplications += 1;
    });
    mock.emit(replay(delivery(7)));
    await waitFor(() => {
      expect(firstApplications).toBe(1);
      expect(abandonedAcknowledgements).toBe(1);
    });
    first.dispose();

    rendererGeneration = 2;
    const second = createCollaborationRendererClient(mock.bridge);
    await second.load();
    let replayApplications = 0;
    second.subscribe((_snapshot, update) => {
      if (update.kind === "realtime") replayApplications += 1;
    });
    mock.emit(replay(delivery(8)));
    await waitFor(() => {
      const current = second.current();
      expect(replayApplications).toBe(1);
      expect(
        current?.view.kind === "thread" ? current.view.messages.items : []
      ).toHaveLength(1);
      expect(successfulAcknowledgements).toBe(1);
    });

    mock.emit(replay(delivery(9)));
    await waitFor(() => {
      expect(replayApplications).toBe(1);
      expect(successfulAcknowledgements).toBe(2);
    });
    expect(abandonedAcknowledgements).toBe(1);
    second.dispose();
  });

  it("tracks current selection and purges protected Team state on revocation and backend change", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    await client.select({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    expect(client.currentSelection().kind).toBe("workspace_channel");

    const personal = fixture();
    if (personal.view.kind !== "thread") {
      throw new Error("Expected Personal thread fixture");
    }
    const personalWithHistory = collaborationSnapshotSchema.parse({
      ...personal,
      view: {
        ...personal.view,
        messages: {
          ...personal.view.messages,
          items: [
            {
              id: ids.message,
              threadId: ids.notes,
              scope: "personal",
              teamId: null,
              sequence: 1,
              sender: participant(),
              senderKind: "user",
              body: "Personal history survives Team revocation.",
              createdAt: timestamp,
              updatedAt: timestamp,
              editedAt: null,
              deletedAt: null,
              delivery: "sent",
              recipientStatus: "sent",
              failure: null
            }
          ]
        }
      }
    });
    const originalCommand = mock.command.getMockImplementation()!;
    let returnedPersonalHistory = false;
    mock.command.mockImplementation(async (command) => {
      if (
        command.command === "collaboration.select" &&
        command.input.selection.kind === "notes_to_self" &&
        !returnedPersonalHistory
      ) {
        returnedPersonalHistory = true;
        return success(command, personalWithHistory, new Map());
      }
      return originalCommand(command);
    });

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: ids.teamSubscription,
      occurredAt: timestamp,
      reason: "access_revoked"
    });
    await waitFor(() => {
      expect(client.current()?.navigation.teams).toEqual([]);
      const current = client.current();
      expect(
        current?.view.kind === "thread"
          ? current.view.messages.items[0]?.body
          : null
      ).toBe("Personal history survives Team revocation.");
    });
    expect(
      mock.command.mock.calls.some(
        ([command]) =>
          command.command === "collaboration.unsubscribe" &&
          command.input.subscriptionId === ids.teamSubscription
      )
    ).toBe(false);
    expect(client.currentSelection().kind).toBe("notes_to_self");
    await client.load();
    expect(client.current()?.navigation.teams).toHaveLength(1);
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: {
        ...client.current()!.connection,
        state: "disconnected",
        backendId: null,
        connectedAt: null
      },
      error: null
    });
    await waitFor(() => expect(client.current()?.navigation.teams).toEqual([]));
    expect(client.current()?.connection.state).toBe("disconnected");

    await client.load();
    expect(client.current()?.navigation.teams).toHaveLength(1);
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: {
        state: "live",
        backendId: "up_other_backend",
        connectedAt: timestamp,
        retryAt: null,
        reconnectAttempt: 0,
        protocolVersion: COLLABORATION_CONTRACT_VERSION
      },
      error: null
    });
    await waitFor(() =>
      expect(client.current()?.connection.backendId).toBe("up_other_backend")
    );
    expect(client.current()?.navigation.teams).toEqual([]);
    client.dispose();
  });

  it("purges Team state and fences in-flight history when the backend disconnects", async () => {
    const initial = fixture({ selectedTeam: true });
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    const originalCommand = mock.command.getMockImplementation()!;
    let releaseHistory!: () => void;
    const blockedHistory = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.load_message_page") {
        await blockedHistory;
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: {
            page: {
              ...emptyPage(ids.channel),
              items: [
                {
                  id: ids.message,
                  threadId: ids.channel,
                  scope: "team",
                  teamId: ids.team,
                  sequence: 1,
                  sender: participant(ids.other, "Alex"),
                  senderKind: "user",
                  body: "disconnected-delayed-history-sentinel",
                  createdAt: timestamp,
                  updatedAt: timestamp,
                  editedAt: null,
                  deletedAt: null,
                  delivery: "sent",
                  recipientStatus: null,
                  failure: null
                }
              ]
            }
          }
        });
      }
      return originalCommand(command);
    });

    const delayedHistory = client.loadMessagePage({
      thread: { scope: "team", teamId: ids.team, threadId: ids.channel },
      direction: "older",
      cursor: null
    });
    await client.disconnect();

    expect(client.currentRemoteUrl()).toBeNull();
    expect(client.current()?.navigation.teams).toEqual([]);
    expect(client.currentSelection().kind).toBe("notes_to_self");
    releaseHistory();
    await expect(delayedHistory).rejects.toMatchObject({
      code: "access_revoked"
    });
    expect(JSON.stringify(client.current())).not.toContain(
      "disconnected-delayed-history-sentinel"
    );
    expect(
      mock.command.mock.calls.some(
        ([command]) => command.command === "collaboration.unsubscribe"
      )
    ).toBe(true);
    client.dispose();
  });

  it.each([
    ["membership disablement", "team_membership_access"],
    ["Workspace access removal", "workspace_lifecycle_access"],
    ["Workspace write-to-read downgrade", "workspace_access_downgrade"],
    ["session or device revocation", "access_revoked"],
    ["backend identity switch", "backend_changed"]
  ] as const)(
    "clears an open protected view and queued state after %s",
    async (_label, transition) => {
      const protectedBody = `protected-${transition}-sentinel`;
      const selected = fixture({ selectedTeam: true });
      if (selected.view.kind !== "thread") {
        throw new Error("Expected selected Team thread fixture");
      }
      const initial = collaborationSnapshotSchema.parse({
        ...selected,
        outbox: [
          {
            clientMessageId: id(93),
            authority: {
              scope: "team",
              backendId: selected.connection.backendId,
              principalUserId: ids.remoteUser,
              teamId: ids.team,
              workspaceId: ids.workspace,
              threadId: ids.channel
            },
            body: protectedBody,
            localCreationOrder: 1,
            state: "queued",
            retryable: true,
            removalSupported: false,
            failure: null,
            createdAt: timestamp,
            updatedAt: timestamp
          }
        ],
        view: {
          ...selected.view,
          messages: {
            ...selected.view.messages,
            items: [
              {
                id: ids.message,
                threadId: ids.channel,
                scope: "team",
                teamId: ids.team,
                sequence: 1,
                sender: participant(ids.other, "Alex"),
                senderKind: "user",
                body: protectedBody,
                createdAt: timestamp,
                updatedAt: timestamp,
                editedAt: null,
                deletedAt: null,
                delivery: "queued",
                recipientStatus: null,
                failure: null
              }
            ]
          }
        }
      });
      const mock = createBridge(initial);
      const client = createCollaborationRendererClient(mock.bridge);
      await client.load();
      expect(JSON.stringify(client.current())).toContain(protectedBody);

      if (
        transition === "team_membership_access" ||
        transition === "workspace_lifecycle_access" ||
        transition === "workspace_access_downgrade"
      ) {
        const personal = fixture();
        const team = initial.navigation.teams[0]!;
        const downgradedChannel = {
          ...team.workspaces[0]!.channels[0]!,
          canPost: false
        };
        const downgradedTeam = {
          ...team,
          workspaces: team.workspaces.map((workspace) => ({
            ...workspace,
            access: "read" as const,
            channels: [downgradedChannel]
          }))
        };
        const keepsReadOnlyWorkspace =
          transition === "workspace_access_downgrade";
        const keepsTeam = transition !== "team_membership_access";
        const navigation = {
          ...initial.navigation,
          teams: keepsTeam
            ? [
                keepsReadOnlyWorkspace
                  ? downgradedTeam
                  : { ...team, workspaces: [] }
              ]
            : []
        };
        const fallback = keepsReadOnlyWorkspace
          ? {
              selection: initial.selection,
              view: {
                kind: "thread" as const,
                thread: downgradedChannel,
                messages: emptyPage(ids.channel)
              }
            }
          : keepsTeam
            ? {
                selection: { kind: "team_people" as const, teamId: ids.team },
                view: {
                  kind: "team_people" as const,
                  teamId: ids.team,
                  people: team.people
                }
              }
            : { selection: personal.selection, view: personal.view };
        mock.emit({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          type: "update",
          subscriptionId: ids.teamSubscription,
          deliveryId: delivery(70),
          eventId: id(70),
          occurredAt: timestamp,
          family:
            transition === "workspace_access_downgrade"
              ? "workspace_lifecycle_access"
              : transition,
          resource: {
            scope: "team",
            teamId: ids.team,
            workspaceId:
              transition === "team_membership_access" ? null : ids.workspace,
            threadId: null,
            messageId: null,
            sharedSessionId: null,
            shareGrantId: null
          },
          update: {
            type: "navigation_snapshot",
            navigation,
            ...fallback
          }
        });
      } else {
        mock.emit({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          type: "connection",
          connection: {
            ...initial.connection,
            state: transition === "access_revoked" ? "access_revoked" : "live",
            backendId:
              transition === "access_revoked"
                ? initial.connection.backendId
                : "up_other_backend",
            connectedAt: transition === "access_revoked" ? null : timestamp
          },
          error:
            transition === "access_revoked"
              ? {
                  code: "access_revoked",
                  userMessage: collaborationSafeErrorMessages.access_revoked,
                  retryable: false,
                  retryAfterMs: null
                }
              : null
        });
      }

      await waitFor(() => {
        const current = client.current();
        expect(JSON.stringify(current)).not.toContain(protectedBody);
        expect(
          current?.view.kind === "thread" ? current.view.messages.items : []
        ).toEqual([]);
        expect(current?.outbox).toEqual([]);
        if (transition === "workspace_access_downgrade") {
          expect(current?.view).toMatchObject({
            kind: "thread",
            thread: { canPost: false }
          });
        } else {
          expect(current?.selection).not.toEqual(initial.selection);
        }
      });
      client.dispose();
    }
  );

  it("does not let a delayed selection restore Team content after access revocation", async () => {
    const initial = fixture({ selectedTeam: true });
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const originalCommand = mock.command.getMockImplementation()!;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.select") await blocked;
      return originalCommand(command);
    });

    const delayedSelection = client.select({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: {
        ...initial.connection,
        state: "access_revoked",
        connectedAt: null
      },
      error: {
        code: "access_revoked",
        userMessage: collaborationSafeErrorMessages.access_revoked,
        retryable: false,
        retryAfterMs: null
      }
    });
    await waitFor(() => expect(client.current()?.navigation.teams).toEqual([]));
    release();

    await expect(delayedSelection).rejects.toMatchObject({
      code: "access_revoked"
    });
    expect(client.current()?.navigation.teams).toEqual([]);
    expect(client.currentSelection().kind).toBe("notes_to_self");
    client.dispose();
  });

  it("does not let delayed Team history repaint a revoked thread", async () => {
    const initial = fixture({ selectedTeam: true });
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const originalCommand = mock.command.getMockImplementation()!;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.command.mockImplementation(async (command) => {
      if (command.command !== "collaboration.load_message_page") {
        return originalCommand(command);
      }
      await blocked;
      return collaborationCommandResultSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: command.requestId,
        command: command.command,
        ok: true,
        data: {
          page: {
            ...emptyPage(ids.channel),
            items: [
              {
                id: ids.message,
                threadId: ids.channel,
                scope: "team",
                teamId: ids.team,
                sequence: 1,
                sender: participant(ids.other, "Alex"),
                senderKind: "user",
                body: "revoked-delayed-history-sentinel",
                createdAt: timestamp,
                updatedAt: timestamp,
                editedAt: null,
                deletedAt: null,
                delivery: "sent",
                recipientStatus: null,
                failure: null
              }
            ]
          }
        }
      });
    });

    const delayedHistory = client.loadMessagePage({
      thread: { scope: "team", teamId: ids.team, threadId: ids.channel },
      direction: "older",
      cursor: null
    });
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: {
        ...initial.connection,
        state: "access_revoked",
        connectedAt: null
      },
      error: {
        code: "access_revoked",
        userMessage: collaborationSafeErrorMessages.access_revoked,
        retryable: false,
        retryAfterMs: null
      }
    });
    await waitFor(() => expect(client.current()?.navigation.teams).toEqual([]));
    release();

    await expect(delayedHistory).rejects.toMatchObject({
      code: "access_revoked"
    });
    expect(JSON.stringify(client.current())).not.toContain(
      "revoked-delayed-history-sentinel"
    );
    client.dispose();
  });

  it("fails closed when access revocation names an unknown subscription", async () => {
    const initial = fixture({ selectedTeam: true });
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: ids.other,
      occurredAt: timestamp,
      reason: "access_revoked"
    });

    await waitFor(() => expect(client.current()?.navigation.teams).toEqual([]));
    expect(client.current()?.navigation.personalOwner).toEqual(
      initial.navigation.personalOwner
    );
    expect(client.currentSelection()).toEqual({ kind: "notes_to_self" });
    expect(client.current()?.connection.state).toBe("access_revoked");

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: ids.teamSubscription,
      deliveryId: delivery(98),
      eventId: id(98),
      occurredAt: timestamp,
      family: "message_created",
      resource: {
        scope: "team",
        teamId: ids.team,
        workspaceId: ids.workspace,
        threadId: ids.channel,
        messageId: ids.message,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: {
        type: "message_created",
        message: {
          id: ids.message,
          clientMessageId: id(99),
          threadId: ids.channel,
          scope: "team",
          teamId: ids.team,
          sequence: 99,
          sender: participant(ids.other, "Stale sender"),
          senderKind: "user",
          body: "stale-after-unknown-revocation",
          createdAt: timestamp,
          updatedAt: timestamp,
          editedAt: null,
          deletedAt: null,
          delivery: "sent",
          recipientStatus: null,
          failure: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(JSON.stringify(client.current())).not.toContain(
      "stale-after-unknown-revocation"
    );
    client.dispose();
  });

  it("purges old subscriptions before applying a new principal on the same backend", async () => {
    const initial = fixture({ selectedTeam: true });
    const protectedBody = "old-principal-protected-content";
    if (initial.view.kind !== "thread") {
      throw new Error("Expected selected Team thread fixture");
    }
    const protectedSnapshot = collaborationSnapshotSchema.parse({
      ...initial,
      view: {
        ...initial.view,
        messages: {
          ...initial.view.messages,
          items: [
            {
              id: ids.message,
              threadId: ids.channel,
              scope: "team",
              teamId: ids.team,
              sequence: 1,
              sender: participant(ids.remoteUser, "Previous principal"),
              senderKind: "user",
              body: protectedBody,
              createdAt: timestamp,
              updatedAt: timestamp,
              editedAt: null,
              deletedAt: null,
              delivery: "sent",
              recipientStatus: null,
              failure: null
            }
          ]
        }
      }
    });
    const mock = createBridge(protectedSnapshot);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const updates: Array<{ kind: string; snapshot: CollaborationSnapshot }> =
      [];
    client.subscribe((snapshot, update) => {
      updates.push({ kind: update.kind, snapshot });
    });

    const replacement = fixture({
      selectedTeam: true,
      teamPrincipalId: ids.other
    });
    mock.setSnapshot(replacement);
    await client.reconnect();

    expect(updates.map(({ kind }) => kind)).toEqual(["purge", "command"]);
    expect(updates[0]?.snapshot.navigation.teams).toEqual([]);
    expect(JSON.stringify(updates[0]?.snapshot)).not.toContain(protectedBody);
    expect(client.current()?.navigation.teamPrincipal?.id).toBe(ids.other);
    expect(client.current()?.navigation.personalOwner.id).toBe(ids.user);
    expect(JSON.stringify(client.current())).not.toContain(protectedBody);
    const unsubscribedIds = mock.command.mock.calls
      .map(([command]) => command)
      .filter((command) => command.command === "collaboration.unsubscribe")
      .map((command) => command.input.subscriptionId);
    expect(unsubscribedIds).toEqual(
      expect.arrayContaining([ids.subscription, ids.teamSubscription])
    );
    client.dispose();
  });

  it.each(["requires_snapshot", "backpressure"] as const)(
    "reloads authoritative Team state after a %s control",
    async (reason) => {
      const mock = createBridge();
      const client = createCollaborationRendererClient(mock.bridge);
      await client.load();
      await client.select({
        kind: "workspace_channel",
        teamId: ids.team,
        workspaceId: ids.workspace,
        threadId: ids.channel
      });
      const recoveredSelections: CollaborationSnapshot["selection"][] = [];
      client.subscribe((next, update) => {
        if (update.kind === "command" || update.kind === "realtime") {
          recoveredSelections.push(next.selection);
        }
      });
      const refreshed = fixture();
      const team = refreshed.navigation.teams[0]!;
      mock.setSnapshot(
        collaborationSnapshotSchema.parse({
          ...refreshed,
          navigation: {
            ...refreshed.navigation,
            teams: [{ ...team, name: "Refreshed Team" }]
          }
        })
      );

      mock.emit({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        type: "control",
        subscriptionId: ids.teamSubscription,
        occurredAt: timestamp,
        reason
      });

      await waitFor(() =>
        expect(client.current()?.navigation.teams[0]?.name).toBe(
          "Refreshed Team"
        )
      );
      expect(client.currentSelection()).toEqual({
        kind: "workspace_channel",
        teamId: ids.team,
        workspaceId: ids.workspace,
        threadId: ids.channel
      });
      expect(
        mock.command.mock.calls.some(
          ([command]) =>
            command.command === "collaboration.unsubscribe" &&
            command.input.subscriptionId === ids.teamSubscription
        )
      ).toBe(false);
      expect(
        mock.command.mock.calls.filter(
          ([command]) => command.command === "collaboration.load"
        )
      ).toHaveLength(2);
      expect(recoveredSelections).not.toContainEqual({
        kind: "notes_to_self"
      });
      client.dispose();
    }
  );

  it("retries a transient authoritative snapshot failure without losing the selected Team", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    await client.select({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    const refreshed = fixture({ selectedTeam: true });
    const team = refreshed.navigation.teams[0]!;
    mock.setSnapshot(
      collaborationSnapshotSchema.parse({
        ...refreshed,
        navigation: {
          ...refreshed.navigation,
          teams: [{ ...team, name: "Recovered Team" }]
        }
      })
    );
    const originalCommand = mock.command.getMockImplementation()!;
    let failNextLoad = true;
    mock.command.mockImplementation(async (command) => {
      if (command.command === "collaboration.load" && failNextLoad) {
        failNextLoad = false;
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: false,
          error: {
            code: "temporarily_unavailable",
            userMessage: collaborationSafeErrorMessages.temporarily_unavailable,
            retryable: true,
            retryAfterMs: 1
          }
        });
      }
      return originalCommand(command);
    });

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: ids.teamSubscription,
      occurredAt: timestamp,
      reason: "requires_snapshot"
    });

    await waitFor(() =>
      expect(client.current()?.navigation.teams[0]?.name).toBe("Recovered Team")
    );
    expect(client.currentSelection()).toEqual({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    expect(
      mock.command.mock.calls.filter(
        ([command]) => command.command === "collaboration.load"
      )
    ).toHaveLength(3);
    client.dispose();
  });

  it("does not let delayed stream recovery overwrite a newer user selection", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    await client.select({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    const originalCommand = mock.command.getMockImplementation()!;
    let releaseRecoverySelection: (() => void) | null = null;
    mock.command.mockImplementation(async (command) => {
      if (
        command.command === "collaboration.select" &&
        command.input.selection.kind === "workspace_channel"
      ) {
        await new Promise<void>((resolve) => {
          releaseRecoverySelection = resolve;
        });
      }
      return originalCommand(command);
    });

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: ids.teamSubscription,
      occurredAt: timestamp,
      reason: "requires_snapshot"
    });
    await waitFor(() => expect(releaseRecoverySelection).not.toBeNull());

    await client.select({ kind: "notes_to_self" });
    releaseRecoverySelection!();
    await waitFor(() =>
      expect(client.currentSelection()).toEqual({ kind: "notes_to_self" })
    );
    const current = client.current();
    expect(current?.view.kind).toBe("thread");
    if (current?.view.kind === "thread") {
      expect(current.view.thread.scope).toBe("personal");
    }
    client.dispose();
  });

  it("falls back to Team People and restores realtime when a selected Team resource disappears", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    const updates: Array<{ kind: string; announcement?: string }> = [];
    client.subscribe((_snapshot, update) => {
      updates.push(update);
    });
    await client.load();
    await client.select({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });

    const originalCommand = mock.command.getMockImplementation()!;
    let rejectStaleSelection = true;
    mock.command.mockImplementation(async (command) => {
      if (
        rejectStaleSelection &&
        command.command === "collaboration.select" &&
        command.input.selection.kind === "workspace_channel"
      ) {
        rejectStaleSelection = false;
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: false,
          error: {
            code: "not_available",
            userMessage: collaborationSafeErrorMessages.not_available,
            retryable: false,
            retryAfterMs: null
          }
        });
      }
      return originalCommand(command);
    });
    mock.setSnapshot(fixture());

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: ids.teamSubscription,
      occurredAt: timestamp,
      reason: "requires_snapshot"
    });

    await waitFor(() =>
      expect(client.currentSelection()).toEqual({
        kind: "team_people",
        teamId: ids.team
      })
    );
    expect(
      mock.command.mock.calls.filter(
        ([command]) =>
          command.command === "collaboration.subscribe" &&
          command.input.scope.scope === "team"
      )
    ).toHaveLength(2);
    expect(updates.at(-1)).toEqual({
      kind: "command",
      announcement: "",
      authoritativeRecovery: true
    });
    client.dispose();
  });

  it("restores an open Shared Memory view after a transient fidelity transition", async () => {
    const initial = sharedFixture();
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const originalCommand = mock.command.getMockImplementation()!;
    let rejectTransitionSelection = true;
    mock.command.mockImplementation(async (command) => {
      if (
        rejectTransitionSelection &&
        command.command === "collaboration.select" &&
        command.input.selection.kind === "shared_session"
      ) {
        rejectTransitionSelection = false;
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: false,
          error: {
            code: "not_available",
            userMessage: collaborationSafeErrorMessages.not_available,
            retryable: false,
            retryAfterMs: null
          }
        });
      }
      return originalCommand(command);
    });
    mock.setSnapshot(fixture({ selectedTeam: true }));

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: ids.teamSubscription,
      occurredAt: timestamp,
      reason: "requires_snapshot"
    });
    await waitFor(() =>
      expect(client.currentSelection()).toEqual({
        kind: "team_people",
        teamId: ids.team
      })
    );

    mock.setSnapshot(initial);
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: ids.teamSubscription,
      occurredAt: timestamp,
      reason: "requires_snapshot"
    });
    await waitFor(() =>
      expect(client.currentSelection()).toEqual(initial.selection)
    );
    expect(client.current()?.view).toMatchObject({
      kind: "shared_session",
      session: { id: ids.sharedSession, sourceState: "ready" }
    });
    client.dispose();
  });

  it("retains an open Shared Memory selection when a superseded subscription requests a snapshot", async () => {
    const initial = sharedFixture();
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const originalCommand = mock.command.getMockImplementation()!;
    let sourceAvailable = false;
    mock.command.mockImplementation(async (command) => {
      if (
        !sourceAvailable &&
        command.command === "collaboration.select" &&
        command.input.selection.kind === "shared_session"
      ) {
        return collaborationCommandResultSchema.parse({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: false,
          error: {
            code: "not_available",
            userMessage: collaborationSafeErrorMessages.not_available,
            retryable: false,
            retryAfterMs: null
          }
        });
      }
      return originalCommand(command);
    });
    mock.setSnapshot(fixture({ selectedTeam: true }));

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: crypto.randomUUID(),
      occurredAt: timestamp,
      reason: "requires_snapshot"
    });
    await waitFor(() =>
      expect(client.currentSelection()).toEqual({
        kind: "team_people",
        teamId: ids.team
      })
    );

    sourceAvailable = true;
    mock.setSnapshot(initial);
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: crypto.randomUUID(),
      occurredAt: timestamp,
      reason: "requires_snapshot"
    });
    await waitFor(() =>
      expect(client.currentSelection()).toEqual(initial.selection)
    );
    expect(client.current()?.view).toMatchObject({
      kind: "shared_session",
      session: { id: ids.sharedSession, sourceState: "ready" }
    });
    client.dispose();
  });

  it("reloads the authoritative snapshot once enrollment becomes live", async () => {
    const disconnected = fixture();
    const initial = collaborationSnapshotSchema.parse({
      ...disconnected,
      connection: {
        ...disconnected.connection,
        state: "connecting",
        connectedAt: null
      },
      navigation: {
        ...disconnected.navigation,
        teamPrincipal: null,
        teams: []
      }
    });
    const mock = createBridge(initial);
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    mock.setSnapshot(fixture());

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: fixture().connection,
      error: null
    });

    await waitFor(() => {
      expect(client.current()?.connection.state).toBe("live");
      expect(client.current()?.navigation.teams).toHaveLength(1);
    });
    expect(
      mock.command.mock.calls.filter(
        ([command]) => command.command === "collaboration.load"
      )
    ).toHaveLength(2);
    expect(
      mock.command.mock.calls.filter(
        ([command]) => command.command === "collaboration.subscribe"
      )
    ).toHaveLength(2);
    expect(
      mock.command.mock.calls.filter(
        ([command]) => command.command === "collaboration.unsubscribe"
      )
    ).toHaveLength(1);
    client.dispose();
  });

  it("deduplicates concurrent subscription creation for the same scope", async () => {
    const mock = createBridge();
    const originalCommand = mock.command.getMockImplementation()!;
    let releaseSubscribe: (() => void) | undefined;
    const subscribeBlocked = new Promise<void>((resolve) => {
      releaseSubscribe = resolve;
    });
    mock.command.mockImplementation(async (command) => {
      if (
        command.command === "collaboration.subscribe" &&
        command.input.scope.scope === "personal"
      ) {
        await subscribeBlocked;
      }
      return originalCommand(command);
    });
    const client = createCollaborationRendererClient(mock.bridge);

    const firstLoad = client.load();
    const secondLoad = client.load();
    await waitFor(() =>
      expect(
        mock.command.mock.calls.filter(
          ([command]) => command.command === "collaboration.subscribe"
        )
      ).toHaveLength(1)
    );
    releaseSubscribe?.();
    await Promise.all([firstLoad, secondLoad]);

    expect(
      mock.command.mock.calls.filter(
        ([command]) => command.command === "collaboration.subscribe"
      )
    ).toHaveLength(1);
    client.dispose();
  });

  it("retains a visited Team subscription across Personal navigation", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    await client.select({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    await client.select({ kind: "notes_to_self" });
    await client.select({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });

    expect(
      mock.command.mock.calls.filter(
        ([command]) =>
          command.command === "collaboration.subscribe" &&
          command.input.scope.scope === "team"
      )
    ).toHaveLength(1);
    expect(
      mock.command.mock.calls.some(
        ([command]) =>
          command.command === "collaboration.unsubscribe" &&
          command.input.subscriptionId === ids.teamSubscription
      )
    ).toBe(false);
    client.dispose();
  });

  it("keeps the selected Team snapshot when its realtime stream becomes live", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    await client.select({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    const loadsBeforeStream = mock.command.mock.calls.filter(
      ([command]) => command.command === "collaboration.load"
    ).length;

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: {
        ...fixture().connection,
        state: "connecting",
        connectedAt: null
      },
      error: null
    });
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: fixture().connection,
      error: null
    });

    await waitFor(() =>
      expect(client.current()?.connection.state).toBe("live")
    );
    expect(client.currentSelection()).toEqual({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    expect(
      mock.command.mock.calls.filter(
        ([command]) => command.command === "collaboration.load"
      )
    ).toHaveLength(loadsBeforeStream);
    client.dispose();
  });

  it("reloads Team state once when its realtime stream recovers", async () => {
    const mock = createBridge();
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    await client.select({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    const loadsBeforeRecovery = mock.command.mock.calls.filter(
      ([command]) => command.command === "collaboration.load"
    ).length;

    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: {
        ...fixture().connection,
        state: "reconnecting",
        connectedAt: null,
        reconnectAttempt: 1
      },
      error: null
    });
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: fixture().connection,
      error: null
    });

    await waitFor(() =>
      expect(
        mock.command.mock.calls.filter(
          ([command]) => command.command === "collaboration.load"
        )
      ).toHaveLength(loadsBeforeRecovery + 1)
    );
    expect(client.current()?.connection.state).toBe("live");
    client.dispose();
  });

  it("bounds pending realtime state and never polls", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const mock = createBridge(fixture({ maxPendingEvents: 1 }));
    const client = createCollaborationRendererClient(mock.bridge);
    await client.load();
    const loadsBeforeOverflow = mock.command.mock.calls.filter(
      ([command]) => command.command === "collaboration.load"
    ).length;
    let release: (() => void) | undefined;
    const removeBlockingListener = client.subscribe((_snapshot, update) => {
      if (update.kind !== "connection") return;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const connectionEvent: CollaborationRendererEvent = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: {
        ...fixture().connection,
        state: "reconnecting",
        reconnectAttempt: 1
      },
      error: null
    };
    mock.emit(connectionEvent);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    mock.emit(connectionEvent);
    mock.emit(connectionEvent);
    await waitFor(() => expect(client.current()?.navigation.teams).toEqual([]));
    expect(client.current()?.connection.state).toBe("unavailable");
    expect(setIntervalSpy).not.toHaveBeenCalled();
    removeBlockingListener();
    release?.();
    mock.emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: fixture().connection,
      error: null
    });
    await waitFor(() => {
      expect(client.current()?.connection.state).toBe("live");
      expect(client.current()?.navigation.teams).toHaveLength(1);
      expect(
        mock.command.mock.calls.filter(
          ([command]) => command.command === "collaboration.load"
        ).length
      ).toBeGreaterThan(loadsBeforeOverflow);
    });
    client.dispose();
  });
});
