// @vitest-environment happy-dom

import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  collaborationSafeErrorMessages,
  collaborationSnapshotSchema,
  type CollaborationMessage,
  type CollaborationSelection,
  type CollaborationSnapshot,
  type CollaborationThread,
  type OwnedShareItem,
  type PendingShare,
  type PersonalDesktopApi,
  type SharedMemoryGrant,
  type SharedMemoryPreview,
  type SharedMemoryRepresentation,
  type SharedMemorySession,
  type SharedMemorySourceItem
} from "@koed/shared";
import { act, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CollaborationActionGrantProjection,
  CollaborationClientListener,
  CollaborationClientUpdate,
  CollaborationRendererClient
} from "./collaboration/renderer-client.js";
import { CollaborationClientError } from "./collaboration/renderer-client.js";
import { App } from "./renderer/App.js";
import {
  CollaborationModalLayer,
  CollaborationRoutes
} from "./renderer/collaboration/CollaborationRoutes.js";
import {
  formatShareListTime,
  PersonalMemoryView
} from "./renderer/collaboration/CollaborationRoutesImpl.js";
import { DesktopStatusStore } from "./renderer/services/desktop-commands.js";
import { DraftStore } from "./renderer/state/drafts.js";
import type { KoedServerStatus } from "./types.js";

vi.mock("@koed/memory-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@koed/memory-ui")>();
  const { useEffect } = await import("react");
  return {
    ...actual,
    ChatTimeline: ({
      ariaLabel,
      className,
      firstUnreadMessageId,
      messages,
      onAtEndChange,
      onVisibleRangeChange,
      renderFirstUnread,
      renderMessage
    }: {
      ariaLabel?: string;
      className?: string;
      firstUnreadMessageId?: string | null;
      messages: Array<{ id: string }>;
      onAtEndChange?: (value: boolean) => void;
      onVisibleRangeChange?: (value: {
        endIndex: number;
        endKey: string;
        firstVisibleMessageId: string | null;
        lastVisibleMessageId: string | null;
        startIndex: number;
        startKey: string;
        visibleMessageIds: string[];
      }) => void;
      renderFirstUnread: (row: {
        key: string;
        kind: "first-unread";
        messageId: string;
      }) => ReactNode;
      renderMessage: (row: {
        boundary: {
          continuesNextPage: boolean;
          continuesPreviousPage: boolean;
          endsGroup: boolean;
          startsGroup: boolean;
        };
        groupId: string;
        key: string;
        kind: "message";
        message: { id: string };
        position: "only";
      }) => ReactNode;
    }) => {
      useEffect(() => {
        const ids = messages.map(({ id }) => id);
        onAtEndChange?.(true);
        onVisibleRangeChange?.({
          endIndex: Math.max(0, messages.length - 1),
          endKey: messages.at(-1)?.id ?? "empty",
          firstVisibleMessageId: ids[0] ?? null,
          lastVisibleMessageId: ids.at(-1) ?? null,
          startIndex: 0,
          startKey: ids[0] ?? "empty",
          visibleMessageIds: ids
        });
      }, [messages, onAtEndChange, onVisibleRangeChange]);
      return (
        <div role="list" aria-label={ariaLabel} className={className}>
          {firstUnreadMessageId
            ? renderFirstUnread({
                key: `first-unread:${firstUnreadMessageId}`,
                kind: "first-unread",
                messageId: firstUnreadMessageId
              })
            : null}
          {messages.map((message) => (
            <Fragment key={message.id}>
              {renderMessage({
                boundary: {
                  continuesNextPage: false,
                  continuesPreviousPage: false,
                  endsGroup: true,
                  startsGroup: true
                },
                groupId: message.id,
                key: `message:${message.id}`,
                kind: "message",
                message,
                position: "only"
              })}
            </Fragment>
          ))}
        </div>
      );
    },
    VirtualizedTimeline: ({
      ariaLabel,
      className,
      events,
      renderEvent
    }: {
      ariaLabel?: string;
      className?: string;
      events: { id: string }[];
      renderEvent: (event: { id: string }) => ReactNode;
    }) => (
      <div role="list" aria-label={ariaLabel} className={className}>
        {events.map((event) => renderEvent(event))}
      </div>
    )
  };
});

const uuid = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const at = "2026-07-17T08:30:00.000Z";
const revision = "snapshot.revision-000001";
const ids = {
  mark: uuid(1),
  alex: uuid(2),
  riley: uuid(3),
  team: uuid(4),
  teamTwo: uuid(5),
  workspace: uuid(6),
  notes: uuid(7),
  personalChannel: uuid(8),
  channel: uuid(9),
  dm: uuid(10),
  discussion: uuid(11),
  eventSession: uuid(15),
  leafSession: uuid(13),
  rollupSession: uuid(14),
  grant: uuid(15),
  logicalMemory: uuid(16),
  remoteMark: uuid(17),
  invitation: uuid(18),
  membership: uuid(19)
};

const person = (id: string, displayName: string) => ({
  id,
  displayName,
  presence: "available" as const,
  membershipState: "enabled" as const
});
const teamPerson = (value: ReturnType<typeof person>) => ({
  ...value,
  teamPresence: {
    mode: "auto" as const,
    manualStatus: "available" as const,
    activityLevel: "active" as const,
    lastActivityAt: at,
    nextTransitionAt: "2026-07-17T08:35:00.001Z",
    preferenceVersion: 1
  }
});
const mark = person(ids.mark, "Mark Fixture");
const remoteMark = person(ids.remoteMark, "Mark Fixture");
const alex = person(ids.alex, "Alex Chen");
const riley = person(ids.riley, "Riley Jones");
const participant = (value: typeof mark) => {
  return {
    id: value.id,
    displayName: value.displayName,
    membershipState: value.membershipState
  };
};

const managedPerson = (
  value: typeof mark,
  role: "owner" | "admin" | "member",
  access: "disabled" | "read" | "write" = "write",
  version = 1
) => ({
  ...teamPerson(value),
  management: {
    membershipId: `${ids.membership.slice(0, -1)}${
      value.id === ids.remoteMark ? "1" : value.id === ids.alex ? "2" : "3"
    }`,
    email: `${value.displayName.toLowerCase().replaceAll(" ", ".")}@example.test`,
    role,
    status: "enabled" as const,
    version,
    workspaceAccess: [
      {
        workspaceId: ids.workspace,
        userId: value.id,
        access,
        version: access === "disabled" ? null : 1
      }
    ]
  }
});

const baseThread = (id: string, logicalId: string) => ({
  id,
  logicalId,
  name: null,
  topic: null,
  version: 1,
  lifecycle: "active" as const,
  canPost: true,
  latestSequence: 1,
  unreadCount: 0,
  lastReadMessageId: null,
  lastReadSequence: 0,
  createdAt: at,
  updatedAt: at,
  lastActivityAt: at,
  archivedAt: null
});

const notes = () => ({
  ...baseThread(ids.notes, uuid(101)),
  kind: "notes_to_self" as const,
  scope: "personal" as const,
  ownerUserId: ids.mark,
  participants: [participant(mark)]
});
type PersonalChannel = Extract<
  CollaborationThread,
  { kind: "personal_channel" }
>;
const personalChannel = (
  overrides?: Partial<PersonalChannel>
): PersonalChannel => ({
  ...baseThread(ids.personalChannel, uuid(102)),
  kind: "personal_channel" as const,
  scope: "personal" as const,
  ownerUserId: ids.mark,
  name: "research",
  ...overrides
});
type WorkspaceChannel = Extract<
  CollaborationThread,
  { kind: "workspace_channel" }
>;

const channel = (overrides?: Partial<WorkspaceChannel>): WorkspaceChannel => ({
  ...baseThread(ids.channel, uuid(103)),
  kind: "workspace_channel" as const,
  scope: "team" as const,
  teamId: ids.team,
  workspaceId: ids.workspace,
  name: "general",
  topic: "Launch coordination",
  ...overrides
});
const directMessage = () => ({
  ...baseThread(ids.dm, uuid(104)),
  kind: "dm" as const,
  scope: "team" as const,
  teamId: ids.team,
  participants: [participant(remoteMark), participant(alex)]
});
const discussion = () => ({
  ...baseThread(ids.discussion, uuid(105)),
  kind: "shared_session_discussion" as const,
  scope: "team" as const,
  teamId: ids.team,
  workspaceId: ids.workspace,
  sharedLogicalMemoryId: ids.logicalMemory,
  shareGrantId: ids.grant
});

const message = (
  id: string,
  threadId: string,
  body: string,
  sender = alex,
  delivery: CollaborationMessage["delivery"] = "sent"
): CollaborationMessage => ({
  id,
  threadId,
  scope:
    threadId === ids.notes || threadId === ids.personalChannel
      ? "personal"
      : "team",
  teamId:
    threadId === ids.notes || threadId === ids.personalChannel
      ? null
      : ids.team,
  sequence: 1,
  sender: participant(sender),
  senderKind: "user",
  body,
  createdAt: at,
  updatedAt: at,
  editedAt: null,
  deletedAt: null,
  delivery,
  recipientStatus: delivery === "sent" ? "sent" : null,
  failure:
    delivery === "failed"
      ? {
          code: "temporarily_unavailable",
          userMessage: "Collaboration is temporarily unavailable.",
          retryable: true,
          retryAfterMs: null
        }
      : null
});

const page = (
  threadId: string,
  items: CollaborationMessage[] = [],
  hasOlder = false
) => ({
  snapshotRevision: revision,
  olderCursor: hasOlder ? "cursor.page-000000001" : null,
  newerCursor: null,
  hasOlder,
  hasNewer: false,
  threadId,
  items
});

const richSharedSource = `## Source formatting

| Surface | State |
| --- | --- |
| Shared Memory | Ready |

\`\`\`sh
pnpm typecheck
\`\`\``;

const sourceItem = (
  representation: SharedMemoryRepresentation
): SharedMemorySourceItem =>
  representation === "memory_events"
    ? {
        id: uuid(201),
        representation,
        sequence: 1,
        occurredAt: at,
        sourceItems: [
          {
            id: uuid(202),
            sourceKind: "user_message",
            occurredAt: at,
            body: richSharedSource,
            actorName: "You",
            toolName: null,
            toolCallId: null
          }
        ]
      }
    : representation === "curated_assertions"
      ? {
          id: uuid(205),
          representation,
          sequence: 1,
          occurredAt: at,
          assertionText:
            "Production releases require an owner-approved rollback plan.",
          topicTitle: "Release policy",
          tags: ["deployment", "decision"],
          sourceCount: 3,
          sourceRevision: revision
        }
      : {
          id: representation === "lcm_leaves" ? uuid(203) : uuid(204),
          representation,
          sequence: 1,
          occurredAt: at,
          summaryText:
            representation === "lcm_leaves"
              ? "Launch notes are ready for review."
              : "Quarterly research has been consolidated.",
          lexicalAnchors: ["launch-review-anchor"],
          sourceCount: representation === "lcm_leaves" ? 14 : 38,
          sourceRevision: revision
        };

const candidateManifestFor = (representation: SharedMemoryRepresentation) => [
  { sourceId: sourceItem(representation).id, revisionHash: "d".repeat(64) }
];

const sharedSession = (
  id: string,
  title: string,
  representation: SharedMemoryRepresentation,
  sourceState: SharedMemorySession["sourceState"] = "ready"
): SharedMemorySession => ({
  id,
  logicalMemoryId: ids.logicalMemory,
  shareGrantId: id,
  teamId: ids.team,
  workspaceId: ids.workspace,
  owner: participant(remoteMark),
  title,
  latestActivityAt: at,
  representation,
  representationState: "current",
  liveState: "live",
  sourceState,
  sourceRevision: revision,
  companionThreadId: ids.discussion,
  unreadCompanionCount: 0,
  version: 1
});

const sessions = () => [
  sharedSession(ids.eventSession, "Realtime capture review", "memory_events"),
  sharedSession(ids.leafSession, "Launch notes", "lcm_leaves"),
  sharedSession(ids.rollupSession, "Quarterly research", "lcm_rollups")
];

const baseSnapshot = (): CollaborationSnapshot =>
  collaborationSnapshotSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    snapshotRevision: revision,
    generatedAt: at,
    connection: {
      state: "live",
      backendId: "up_team_example",
      connectedAt: at,
      retryAt: null,
      reconnectAttempt: 0,
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    },
    limits: COLLABORATION_DEFAULT_LIMITS,
    navigation: {
      personalOwner: mark,
      teamPrincipal: remoteMark,
      personal: {
        memory: [
          {
            id: uuid(301),
            logicalMemoryId: uuid(302),
            title: "Renderer cutover",
            projectName: "koed",
            updatedAt: at,
            preview: "The collaboration renderer uses the shared contract.",
            eventCount: 12,
            hasSynchronizedRevision: true,
            syncState: "ready"
          }
        ],
        notesToSelf: notes(),
        channels: [personalChannel()]
      },
      teams: [
        {
          id: ids.team,
          name: "Atlas Research",
          role: "owner",
          membershipVersion: 1,
          lifecycle: "active",
          unreadCount: 2,
          people: [
            managedPerson(remoteMark, "owner"),
            managedPerson(alex, "member", "read"),
            managedPerson(riley, "member", "disabled")
          ],
          directMessages: [directMessage()],
          workspaces: [
            {
              id: ids.workspace,
              name: "Launch Plans",
              description: "Launch work",
              access: "write",
              lifecycle: "active",
              version: 1,
              channels: [channel({ unreadCount: 1 })],
              sharedMemory: sessions()
            }
          ],
          version: 1
        },
        {
          id: ids.teamTwo,
          name: "Beta Team",
          role: "member",
          membershipVersion: 1,
          lifecycle: "active",
          unreadCount: 0,
          people: [teamPerson(remoteMark)],
          directMessages: [],
          workspaces: [],
          version: 1
        }
      ]
    },
    selection: { kind: "notes_to_self" },
    view: {
      kind: "thread",
      thread: notes(),
      messages: page(ids.notes, [
        message(
          uuid(401),
          ids.notes,
          "Check the Shared Memory split view.",
          mark
        )
      ])
    }
  });

const viewFor = (
  current: CollaborationSnapshot,
  selection: CollaborationSelection
): CollaborationSnapshot => {
  let view: CollaborationSnapshot["view"];
  switch (selection.kind) {
    case "personal_memory":
      view = {
        kind: "personal_memory",
        entries: current.navigation.personal.memory
      };
      break;
    case "notes_to_self":
      view = {
        kind: "thread",
        thread: notes(),
        messages: page(ids.notes, [
          message(
            uuid(401),
            ids.notes,
            "Check the Shared Memory split view.",
            mark
          )
        ])
      };
      break;
    case "personal_channel": {
      const selectedPersonalChannel = current.navigation.personal.channels.find(
        (thread) => thread.id === selection.threadId
      );
      view = {
        kind: "thread",
        thread:
          selectedPersonalChannel?.kind === "personal_channel"
            ? selectedPersonalChannel
            : personalChannel(),
        messages: page(ids.personalChannel)
      };
      break;
    }
    case "team_people": {
      const team = current.navigation.teams.find(
        (item) => item.id === selection.teamId
      );
      view = {
        kind: "team_people",
        teamId: selection.teamId,
        people: team?.people ?? []
      };
      break;
    }
    case "workspace_channel":
      view = {
        kind: "thread",
        thread: channel({ unreadCount: 1 }),
        messages: page(
          ids.channel,
          [message(uuid(402), ids.channel, "Welcome to Atlas Research.")],
          true
        )
      };
      break;
    case "team_direct_message":
      view = {
        kind: "thread",
        thread: directMessage(),
        messages: page(ids.dm)
      };
      break;
    case "workspace_shared_memory":
      view = {
        kind: "shared_memory_index",
        teamId: selection.teamId,
        workspaceId: selection.workspaceId,
        sessions:
          current.navigation.teams
            .find((team) => team.id === selection.teamId)
            ?.workspaces.find(
              (workspace) => workspace.id === selection.workspaceId
            )?.sharedMemory ?? []
      };
      break;
    case "shared_session": {
      const session = sessions().find(
        (item) => item.id === selection.sharedSessionId
      )!;
      view = {
        kind: "shared_session",
        session,
        source: {
          snapshotRevision: revision,
          olderCursor: "cursor.source-00000001",
          newerCursor: null,
          hasOlder: true,
          hasNewer: false,
          sharedSessionId: session.id,
          representation: session.representation,
          items: [sourceItem(session.representation)]
        },
        companion: {
          thread: discussion(),
          messages: page(ids.discussion, [
            message(
              uuid(403),
              ids.discussion,
              "Discuss the shared source here.",
              riley
            )
          ])
        }
      };
      break;
    }
  }
  return collaborationSnapshotSchema.parse({ ...current, selection, view });
};

type MockClient = CollaborationRendererClient & {
  emit(
    snapshot: CollaborationSnapshot,
    announcement?: string,
    kind?: CollaborationClientUpdate["kind"]
  ): void;
  emitUpdate(
    snapshot: CollaborationSnapshot,
    update: CollaborationClientUpdate
  ): void;
};

const requireCurrent = (client: MockClient): CollaborationSnapshot => {
  const current = client.current();
  if (!current) throw new Error("Expected current collaboration snapshot");
  return current;
};

const createClient = (initial = baseSnapshot()): MockClient => {
  let current = initial;
  const listeners = new Set<CollaborationClientListener>();
  const publish = (
    next: CollaborationSnapshot,
    announcement?: string,
    kind: CollaborationClientUpdate["kind"] = "command"
  ) => {
    current = next;
    for (const listener of listeners) {
      void listener(
        current,
        announcement === undefined ? { kind } : { kind, announcement }
      );
    }
    return current;
  };
  const select = vi.fn(async (selection: CollaborationSelection) =>
    publish(viewFor(current, selection))
  );
  const updatePersonalChannel = (thread: PersonalChannel) =>
    publish({
      ...current,
      navigation: {
        ...current.navigation,
        personal: {
          ...current.navigation.personal,
          channels: current.navigation.personal.channels.map((candidate) =>
            candidate.id === thread.id ? thread : candidate
          )
        }
      },
      view:
        current.view.kind === "thread" && current.view.thread.id === thread.id
          ? { ...current.view, thread }
          : current.view
    });
  const client: MockClient = {
    load: vi.fn(async () => current),
    current: () => current,
    currentRemoteUrl: () => "https://team.koed.example",
    currentSelection: () => current.selection,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select,
    connectRemote: vi.fn(async ({ remoteUrl }) => {
      expect(remoteUrl).not.toContain("@");
      return publish({
        ...current,
        connection: { ...current.connection, state: "live" }
      });
    }),
    reconnect: vi.fn(async () =>
      publish({
        ...current,
        connection: { ...current.connection, state: "live" }
      })
    ),
    authorizeManagedConversationTransfer: vi.fn(async () => ({
      id: uuid(499)
    })),
    disconnect: vi.fn(async () =>
      publish({
        ...current,
        connection: { ...current.connection, state: "disconnected" },
        navigation: { ...current.navigation, teams: [] }
      } as CollaborationSnapshot)
    ),
    createTeam: vi.fn(async ({ name }) => {
      const team = { ...current.navigation.teams[1]!, id: uuid(501), name };
      return publish({
        ...current,
        navigation: {
          ...current.navigation,
          teams: [...current.navigation.teams, team]
        }
      });
    }),
    joinTeam: vi.fn(async () => current),
    createWorkspace: vi.fn(async ({ teamId, name, description }) => {
      const team = current.navigation.teams.find((item) => item.id === teamId)!;
      const workspace = {
        ...team.workspaces[0]!,
        id: uuid(510),
        name,
        description,
        channels: [],
        sharedMemory: []
      };
      return publish({
        ...current,
        navigation: {
          ...current.navigation,
          teams: current.navigation.teams.map((item) =>
            item.id === teamId
              ? { ...item, workspaces: [...item.workspaces, workspace] }
              : item
          )
        }
      });
    }),
    createInvitation: vi.fn(async (input) => ({
      invitation: {
        id: ids.invitation,
        teamId: input.teamId,
        defaultWorkspaceId: input.defaultWorkspaceId,
        defaultWorkspaceAccess: input.defaultWorkspaceAccess,
        email: input.email,
        role: input.role,
        lifecycle: "pending" as const,
        version: 1,
        createdAt: at,
        expiresAt: "2026-07-20T08:30:00.000Z",
        acceptedAt: null,
        revokedAt: null
      },
      invitationUrl:
        "https://team.example.test/invitations/accept?token=one-time"
    })),
    listInvitations: vi.fn(async ({ teamId }) => ({
      teamId,
      items: [],
      nextCursor: null
    })),
    revokeInvitation: vi.fn(
      async ({ teamId, invitationId, expectedVersion }) => ({
        id: invitationId,
        teamId,
        defaultWorkspaceId: ids.workspace,
        defaultWorkspaceAccess: "read" as const,
        email: "member@example.test",
        role: "member" as const,
        lifecycle: "revoked" as const,
        version: expectedVersion + 1,
        createdAt: at,
        expiresAt: "2026-07-20T08:30:00.000Z",
        acceptedAt: null,
        revokedAt: at
      })
    ),
    updateMemberRole: vi.fn(
      async ({ teamId, userId, role, expectedVersion }) => ({
        id: ids.membership,
        teamId,
        userId,
        displayName: "Alex Chen",
        email: "alex.chen@example.test",
        role,
        status: "enabled" as const,
        version: expectedVersion + 1,
        createdAt: at,
        updatedAt: at,
        acceptedAt: at,
        disabledAt: null
      })
    ),
    disableMember: vi.fn(async ({ teamId, userId, expectedVersion }) => ({
      id: ids.membership,
      teamId,
      userId,
      displayName: "Alex Chen",
      email: "alex.chen@example.test",
      role: "member" as const,
      status: "disabled" as const,
      version: expectedVersion + 1,
      createdAt: at,
      updatedAt: at,
      acceptedAt: at,
      disabledAt: at
    })),
    leaveTeam: vi.fn(async ({ teamId, expectedVersion }) => ({
      id: ids.membership,
      teamId,
      userId: ids.remoteMark,
      displayName: "Mark Fixture",
      email: "mark.fixture@example.test",
      role: "owner" as const,
      status: "disabled" as const,
      version: expectedVersion + 1,
      createdAt: at,
      updatedAt: at,
      acceptedAt: at,
      disabledAt: at
    })),
    archiveWorkspace: vi.fn(
      async ({ teamId, workspaceId, expectedVersion }) => ({
        id: workspaceId,
        teamId,
        name: "Launch Plans",
        description: "Launch work",
        lifecycle: "archived" as const,
        version: expectedVersion + 1,
        createdAt: at,
        updatedAt: at,
        archivedAt: at
      })
    ),
    restoreWorkspace: vi.fn(
      async ({ teamId, workspaceId, expectedVersion }) => ({
        id: workspaceId,
        teamId,
        name: "Launch Plans",
        description: "Launch work",
        lifecycle: "active" as const,
        version: expectedVersion + 1,
        createdAt: at,
        updatedAt: at,
        archivedAt: null
      })
    ),
    setWorkspaceAccess: vi.fn(async (input) => ({
      workspaceId: input.workspaceId,
      userId: input.userId,
      access: input.access,
      version: (input.expectedVersion ?? 0) + 1
    })),
    setTeamPresence: vi.fn(async (input) => {
      const person = current.navigation.teams
        .find((team) => team.id === input.teamId)!
        .people.find(
          (candidate) => candidate.id === current.navigation.teamPrincipal?.id
        )!;
      return {
        ...person,
        teamPresence: {
          ...person.teamPresence,
          mode: input.mode,
          manualStatus: input.manualStatus,
          preferenceVersion: input.expectedVersion + 1
        }
      };
    }),
    reportTeamActivity: vi.fn(async (teamIds) => teamIds),
    createPersonalChannel: vi.fn(async () => current),
    renameThread: vi.fn(async ({ thread, name }) =>
      updatePersonalChannel({
        ...(thread as PersonalChannel),
        name,
        version: thread.version + 1
      })
    ),
    updateThreadTopic: vi.fn(async ({ thread, topic }) =>
      updatePersonalChannel({
        ...(thread as PersonalChannel),
        topic,
        version: thread.version + 1
      })
    ),
    archiveThread: vi.fn(async ({ thread }) =>
      updatePersonalChannel({
        ...(thread as PersonalChannel),
        lifecycle: "archived",
        canPost: false,
        archivedAt: at,
        version: thread.version + 1
      })
    ),
    restoreThread: vi.fn(async ({ thread }) =>
      updatePersonalChannel({
        ...(thread as PersonalChannel),
        lifecycle: "active",
        canPost: true,
        archivedAt: null,
        version: thread.version + 1
      })
    ),
    createWorkspaceChannel: vi.fn(async () => current),
    startDirectMessage: vi.fn(async () => current),
    startGroupDirectMessage: vi.fn(async () => current),
    sendMessage: vi.fn(async ({ thread, clientMessageId, body }) => {
      const sent = message(clientMessageId, thread.threadId, body, mark);
      if (current.view.kind === "thread") {
        return publish({
          ...current,
          view: {
            ...current.view,
            messages: {
              ...current.view.messages,
              items: [
                ...current.view.messages.items.filter(
                  (candidate) => candidate.id !== sent.id
                ),
                sent
              ]
            }
          }
        });
      }
      if (current.view.kind === "shared_session") {
        return publish({
          ...current,
          view: {
            ...current.view,
            companion: {
              ...current.view.companion,
              messages: {
                ...current.view.companion.messages,
                items: [
                  ...current.view.companion.messages.items.filter(
                    (candidate) => candidate.id !== sent.id
                  ),
                  sent
                ]
              }
            }
          }
        });
      }
      return current;
    }),
    retryMessage: vi.fn(async (input) => client.sendMessage(input)),
    markRead: vi.fn(async () => current),
    markDelivered: vi.fn(async () => current),
    loadMessagePage: vi.fn(async () => current),
    loadSharedSourcePage: vi.fn(async () => current),
    listOwnedSharedMemoryGrants: vi.fn(async () => []),
    listOwnedShares: vi.fn(async () => ({ shares: [], nextCursor: null })),
    getOwnedShare: vi.fn(async () => {
      throw new Error("No owned share fixture");
    }),
    renameOwnedShare: vi.fn(async () => {
      throw new Error("No owned share fixture");
    }),
    controlPendingShare: vi.fn(),
    shareConversationSource: vi.fn(),
    revokeConversationSource: vi.fn(),
    prepareSharedMemorySource: vi.fn(
      async () => current.navigation.personal.memory[0]!
    ),
    previewSharedMemoryCandidate: vi.fn(async (input) => ({
      sessionId: input.sessionId,
      logicalMemoryId: ids.logicalMemory,
      representation: input.representation,
      sourceRevision: 12,
      candidateHash: "c".repeat(64),
      itemCount: 1,
      excludedItemCount: 0,
      manifest: candidateManifestFor(input.representation),
      byteCount: 128,
      items: [sourceItem(input.representation)]
    })),
    pauseSharedMemorySync: vi.fn(async () => ({
      ...current.navigation.personal.memory[0]!,
      syncState: "paused" as const
    })),
    resumeSharedMemorySync: vi.fn(async () => ({
      ...current.navigation.personal.memory[0]!,
      syncState: "ready" as const
    })),
    revokeSharedMemorySync: vi.fn(async () => ({
      ...current.navigation.personal.memory[0]!,
      syncState: "revoked" as const
    })),
    previewSharedMemory: vi.fn(async (input) => ({
      logicalMemoryId: input.logicalMemoryId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      representation: input.representation,
      allowedRepresentations: input.allowedRepresentations,
      previewRevision: 1,
      sourceRevision: 12,
      policyRevision: 1,
      contentPolicyVersion: 1,
      classifierVersion: 1,
      redactedContentHash: "a".repeat(64),
      previewHash: "b".repeat(64),
      itemCount: 1,
      items: [sourceItem(input.representation)],
      nextCursor: null
    })),
    loadSharedMemoryPreviewPage: vi.fn(async () => {
      throw new Error(
        "Shared Memory owner flow is not configured in this fixture"
      );
    }),
    shareMemory: vi.fn(async (input) => ({
      id: ids.grant,
      logicalGrantId: input.logicalGrantId,
      logicalMemoryId: input.logicalMemoryId,
      ownerUserId: ids.remoteMark,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      consentId: input.consentId,
      ownerAllowedRepresentations: ["memory_events" as const],
      activeRepresentation: "memory_events" as const,
      representationPolicyRevision: 1,
      sourceRevision: 12,
      grantVersion: 1,
      lifecycle: "active" as const,
      createdAt: at,
      updatedAt: at,
      revokedAt: null,
      companionThreadId: ids.discussion
    })),
    revokeSharedMemory: vi.fn(async () => {
      throw new Error(
        "Shared Memory owner flow is not configured in this fixture"
      );
    }),
    changeSharedMemoryRepresentation: vi.fn(async () => {
      throw new Error(
        "Shared Memory owner flow is not configured in this fixture"
      );
    }),
    dispose: vi.fn(),
    emit(next, announcement, kind) {
      publish(next, announcement, kind);
    },
    emitUpdate(next, update) {
      current = next;
      for (const listener of listeners) void listener(current, update);
    }
  };
  return client;
};

const click = async (container: HTMLElement, label: string) => {
  const button = [...document.body.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.querySelector(".desktop-sidebar-nav-label")?.textContent?.trim() ===
        label ||
      item.textContent?.replace(/\s+/g, " ").trim() === label
  ) as HTMLButtonElement | undefined;
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
};

const setValue = (
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    "value"
  );
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

const submit = async () => {
  const form =
    document.body.querySelector<HTMLFormElement>(".collab-modal form")!;
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
};

describe("CollaborationApp", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    container.style.height = "900px";
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.koedDesktop;
    vi.restoreAllMocks();
    vi.useRealTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
  });

  const render = async (client = createClient()) => {
    await act(async () =>
      root.render(
        <App
          collaborationClient={client}
          initialCollaborationSelection={client.current()?.selection}
          onboardingComplete
          statusReadyOverride
        />
      )
    );
    expect(document.body.querySelector(".desktop-app-shell")).not.toBeNull();
    return client;
  };

  it("does not mount Personal Memory before local setup is verified", async () => {
    const component = (
      state: "not_configured" | "healthy"
    ): { state: "not_configured" | "healthy"; message: string } => ({
      state,
      message: state
    });
    const status = (state: "not_configured" | "healthy"): KoedServerStatus => ({
      ok: state === "healthy",
      state,
      koedHome: "/tmp/clean-koed-home",
      generatedAt: "2026-07-23T00:00:00.000Z",
      runtimeMode: "local-personal",
      dependencyMode: "bundled-local",
      api: { ...component(state), url: "http://127.0.0.1:3300" },
      database: component(state),
      redis: component(state),
      workerQueues: component(state),
      embeddingService: component(state),
      apiToken: { ...component(state), configured: state === "healthy" },
      mcpServer: component(state),
      captureHook: component(state),
      codex: { ...component(state), configured: state === "healthy" },
      lcmSummaryService: component(state),
      upstreamBackends: {
        ...component("healthy"),
        registered: 0,
        validated: 0,
        stale: 0,
        failed: 0,
        notChecked: 0
      },
      lastVerification: {
        ...component(state),
        checkedAt: state === "healthy" ? "2026-07-23T00:00:00.000Z" : null
      },
      serverPackage: component(state)
    });
    let currentStatus = status("not_configured");
    const invokeMock = vi.fn(async () => currentStatus);
    window.koedDesktop = {
      invoke: async <T = unknown,>(): Promise<T> => (await invokeMock()) as T
    };
    const listProjects = vi.fn(async () => []);
    const personalMemoryApi: PersonalDesktopApi = {
      assignSessionProject: vi.fn(async () => ({ projectId: null })),
      listProjects,
      loadEventPage: vi.fn(async () => []),
      updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
      subscribe: vi.fn(() => () => undefined)
    };
    const localStatusStore = new DesktopStatusStore();

    await act(async () => {
      root.render(
        <App
          collaborationClient={createClient()}
          onboardingComplete
          personalMemoryApi={personalMemoryApi}
          statusStoreOverride={localStatusStore}
        />
      );
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Set up Koed")
    );
    expect(document.body.textContent).not.toContain(
      "Projects could not be loaded"
    );
    expect(listProjects).not.toHaveBeenCalled();

    currentStatus = status("healthy");
    await act(async () => {
      await localStatusStore.refresh();
    });
    await vi.waitFor(() => expect(listProjects).toHaveBeenCalledOnce());
  });

  it("opens sharing for a local Captured Session before collaboration convergence", async () => {
    const localSessionId = uuid(307);
    const current = baseSnapshot();
    const snapshot = collaborationSnapshotSchema.parse({
      ...current,
      navigation: {
        ...current.navigation,
        personal: {
          ...current.navigation.personal,
          memory: []
        }
      }
    });
    const client = createClient(snapshot);
    const personalMemoryApi: PersonalDesktopApi = {
      assignSessionProject: vi.fn(async () => ({ projectId: null })),
      listProjects: vi.fn<PersonalDesktopApi["listProjects"]>(async () => [
        {
          id: "koed-project",
          name: "koed",
          path: "/workspace/koed",
          eventCount: 2,
          threads: [
            {
              id: "local-thread",
              name: "Local sharing regression",
              sessionId: localSessionId,
              sourceAiClient: "codex-cli",
              projectId: "koed-project",
              projectName: "koed",
              projectPath: "/workspace/koed",
              projectAssignmentSource: "detected",
              eventCount: 2,
              invalidatedCount: 0,
              latestAt: "2026-08-05T12:00:00.000Z",
              sample: "A local Captured Session awaiting Team preparation."
            }
          ]
        }
      ]),
      loadEventPage: vi.fn(async () => []),
      updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
      subscribe: vi.fn(() => () => undefined)
    };

    await act(async () =>
      root.render(
        <App
          collaborationClient={client}
          onboardingComplete
          personalMemoryApi={personalMemoryApi}
          statusReadyOverride
        />
      )
    );

    await vi.waitFor(() =>
      expect(container.querySelector(".personal-project-row")).not.toBeNull()
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".personal-project-row")
        ?.click()
    );
    await vi.waitFor(() =>
      expect(container.querySelector(".personal-session-row")).not.toBeNull()
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".personal-session-row")
        ?.click()
    );
    await vi.waitFor(() =>
      expect(container.querySelector(".personal-share-button")).not.toBeNull()
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".personal-share-button")
        ?.click()
    );

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Review")
    );
    expect(document.body.textContent).not.toContain(
      "Personal Memory unavailable"
    );
  });

  it("tracks an accepted Pending Share when the owner modal is reopened", async () => {
    const snapshot = baseSnapshot();
    const entry = snapshot.navigation.personal.memory[0]!;
    const client = createClient(snapshot);
    const pending: OwnedShareItem = {
      kind: "pending",
      pendingShare: {
        id: uuid(620),
        mutationId: uuid(621),
        logicalGrantId: uuid(622),
        consentId: uuid(623),
        logicalMemoryId: entry.logicalMemoryId!,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["memory_events"],
        mode: "continuous",
        sourceRevision: 12,
        state: "preparing",
        stage: "processing",
        workspaceAccessState: "none",
        sourceUpdateState: "preparing",
        operationVersion: 2,
        attemptCount: 1,
        redactedFailureCode: null,
        lastProgressAt: at,
        createdAt: at,
        updatedAt: at,
        activatedAt: null,
        revokedAt: null,
        grantId: null
      },
      sourceAccess: null,
      summary: {
        sourceSessionId: entry.id,
        sourceTitle: entry.title,
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
        mode: "continuous",
        authorizedPreview: {
          previewId: uuid(624),
          previewHash: "a".repeat(64),
          previewRevision: 1,
          sourceRevision: 12
        },
        lastReadyRevision: null,
        lastSuccessfulUpdateAt: null
      }
    };
    vi.mocked(client.listOwnedShares).mockResolvedValue({
      shares: [pending],
      nextCursor: null
    });

    await act(async () =>
      root.render(
        <CollaborationModalLayer
          client={client}
          markdownAdapters={{
            openExternal: vi.fn(async () => undefined),
            writeClipboard: vi.fn(async () => undefined)
          }}
          modal={{ kind: "share_personal_memory", sessionId: entry.id }}
          onModalChange={vi.fn()}
          snapshot={snapshot}
        />
      )
    );

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("preparing · processing")
    );
    expect(document.body.textContent).not.toContain("Not shared yet.");
    expect(client.listOwnedShares).toHaveBeenCalledWith({
      cursor: null,
      limit: 100,
      history: false
    });

    await click(container, "Share with another Workspace");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Sharing to this Workspace is already being prepared."
      )
    );
    const review = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent === "Review");
    expect(review?.disabled).toBe(true);
  });

  it("opens owner-wide Shares from the active Personal Memory route", async () => {
    const snapshot = baseSnapshot();
    const client = createClient(snapshot);
    const pending: OwnedShareItem = {
      kind: "pending",
      pendingShare: {
        id: uuid(611),
        mutationId: uuid(612),
        logicalGrantId: uuid(613),
        consentId: uuid(614),
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["memory_events"],
        mode: "continuous",
        sourceRevision: 12,
        state: "activated",
        stage: "complete",
        workspaceAccessState: "active",
        sourceUpdateState: "failed",
        operationVersion: 3,
        attemptCount: 1,
        redactedFailureCode: "activation_failed",
        lastProgressAt: at,
        createdAt: at,
        updatedAt: at,
        activatedAt: at,
        revokedAt: null,
        grantId: uuid(615)
      },
      sourceAccess: null,
      summary: {
        sourceSessionId: ids.eventSession,
        sourceTitle: "Owner-wide active route fixture",
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
        mode: "continuous",
        authorizedPreview: {
          previewId: uuid(616),
          previewHash: "a".repeat(64),
          previewRevision: 1,
          sourceRevision: 12
        },
        lastReadyRevision: 12,
        lastSuccessfulUpdateAt: at
      }
    };
    const paused: OwnedShareItem = {
      ...pending,
      pendingShare: {
        ...pending.pendingShare,
        sourceUpdateState: "paused",
        operationVersion: 4
      }
    };
    const renamed: OwnedShareItem = {
      ...pending,
      summary: { ...pending.summary, sourceTitle: "Launch review" }
    };
    const grant: SharedMemoryGrant = {
      id: pending.pendingShare.grantId!,
      logicalGrantId: pending.pendingShare.logicalGrantId,
      logicalMemoryId: pending.pendingShare.logicalMemoryId,
      ownerUserId: ids.remoteMark,
      teamId: pending.pendingShare.teamId,
      workspaceId: pending.pendingShare.workspaceId,
      consentId: pending.pendingShare.consentId,
      ownerAllowedRepresentations: [
        "memory_events",
        "lcm_leaves",
        "lcm_rollups"
      ],
      activeRepresentation: "memory_events",
      representationPolicyRevision: 1,
      sourceRevision: 12,
      grantVersion: 2,
      lifecycle: "active",
      createdAt: at,
      updatedAt: at,
      revokedAt: null,
      companionThreadId: ids.discussion
    };
    const replacement: PendingShare = {
      ...pending.pendingShare,
      representation: "lcm_leaves",
      allowedRepresentations: ["lcm_leaves"],
      state: "preparing",
      stage: "syncing",
      operationVersion: pending.pendingShare.operationVersion + 1
    };
    vi.mocked(client.listOwnedShares).mockResolvedValue({
      shares: [pending],
      nextCursor: null
    });
    vi.mocked(client.listOwnedSharedMemoryGrants).mockResolvedValue([grant]);
    vi.mocked(client.getOwnedShare).mockResolvedValue(pending);
    vi.mocked(client.renameOwnedShare).mockResolvedValue(renamed);
    vi.mocked(client.controlPendingShare).mockResolvedValue(
      paused.pendingShare
    );
    vi.mocked(client.changeSharedMemoryRepresentation).mockResolvedValue(
      replacement
    );
    const personalMemoryApi: PersonalDesktopApi = {
      assignSessionProject: vi.fn(async () => ({ projectId: null })),
      listProjects: vi.fn(async () => []),
      loadEventPage: vi.fn(async () => []),
      updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
      subscribe: vi.fn(() => () => undefined)
    };

    await act(async () =>
      root.render(
        <App
          collaborationClient={client}
          onboardingComplete
          personalMemoryApi={personalMemoryApi}
          statusReadyOverride
        />
      )
    );
    await click(container, "Shares");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Owner-wide active route fixture"
      )
    );
    expect(
      document.body.querySelector(
        '[aria-label="Breadcrumb: Personal / Shares"]'
      )
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Active");
    expect(document.body.textContent).not.toContain("Shared preview");
    expect(
      document.body.querySelector('input[placeholder="Search Shares"]')
    ).not.toBeNull();
    expect(
      document.body.querySelector(".collab-shares-workspace")?.classList
    ).toContain("collab-route-root");
    expect(
      [...document.body.querySelectorAll(".collab-share-section h2")].map(
        (heading) => heading.textContent
      )
    ).toEqual(["Active", "Pending", "Revoked"]);
    const shareRow = document.body.querySelector(".collab-share-row");
    expect(
      shareRow?.querySelector(".desktop-team-disc.collab-share-team-badge")
        ?.textContent
    ).toBe("AR");
    expect(shareRow?.querySelector(".collab-share-status-icon")).toBeNull();
    expect(
      shareRow?.querySelector(".collab-share-row-title strong")?.textContent
    ).toBe("Owner-wide active route fixture");
    expect(
      shareRow?.querySelector(".collab-share-row-error.lucide-circle-alert")
    ).not.toBeNull();
    expect(
      shareRow?.querySelector(".collab-share-row-copy small")?.textContent
    ).toBe("Launch Plans");
    expect(shareRow?.querySelector("time")?.textContent).not.toBe("");
    expect(
      [...document.body.querySelectorAll("button")].some(
        (button) => button.textContent === "History"
      )
    ).toBe(false);
    expect(
      document.body
        .querySelector(".collab-shares-workspace")
        ?.getAttribute("data-narrow-view")
    ).toBe("list");
    await act(async () => (shareRow as HTMLButtonElement).click());
    await vi.waitFor(() =>
      expect(
        document.body
          .querySelector(".collab-shares-workspace")
          ?.getAttribute("data-narrow-view")
      ).toBe("detail")
    );
    expect(
      document.body.querySelector(
        ".collab-share-detail-header .collab-share-state"
      )
    ).toBeNull();
    expect(
      document.body.querySelector(".collab-share-facts .collab-share-state")
        ?.textContent
    ).toBe("active");
    expect(
      [...document.body.querySelectorAll(".collab-share-facts strong")].map(
        (label) => label.textContent
      )
    ).toEqual(["Status", "Shared detail", "Updates", "Source access"]);
    expect(document.body.textContent).not.toContain("Authorized preview");
    expect(
      [...document.body.querySelectorAll("button")].some(
        (button) => button.textContent === "Revoke"
      )
    ).toBe(true);
    await click(container, "Modify");
    expect(
      document.body.querySelector(".collab-modify-share-modal h2")?.textContent
    ).toBe(pending.summary.sourceTitle);
    expect(
      [...document.body.querySelectorAll(".collab-modify-share-modal button")]
        .map((button) => button.textContent?.trim())
        .filter(Boolean)
    ).not.toContain("Revoke Share");
    expect(
      [
        ...document.body.querySelectorAll(
          ".collab-modify-share-form > section h3"
        )
      ].map((heading) => heading.textContent)
    ).toEqual(["Updates", "Shared detail", "Source access"]);
    await click(container, "Change detail");
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(".collab-change-detail-modal h2")
          ?.textContent
      ).toBe("Change shared detail")
    );
    expect(document.body.textContent).toContain("Current detail");
    expect(document.body.textContent).not.toContain(
      "Manage where this Personal Memory is shared"
    );
    expect(document.body.textContent).not.toContain(
      "Share with another Workspace"
    );
    expect(document.body.textContent).not.toContain("Pause updates");
    expect(
      document.body.querySelector(
        '.collab-change-detail-modal button[aria-label="Rename Share"]'
      )
    ).toBeNull();
    const leaves = document.body.querySelector<HTMLInputElement>(
      '.collab-change-detail-modal input[aria-label="LCM Leaves"]'
    );
    expect(leaves).not.toBeNull();
    await act(async () => leaves!.click());
    await click(container, "Review");
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(".collab-change-detail-comparison")
          ?.textContent
      ).toContain("LCM Leaves")
    );
    expect(
      document.body.querySelector(".collab-change-detail-modal fieldset")
    ).toBeNull();
    await click(container, "Apply change");
    await vi.waitFor(() =>
      expect(client.changeSharedMemoryRepresentation).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateSessionId: snapshot.navigation.personal.memory[0]!.id,
          mode: "continuous",
          representation: "lcm_leaves",
          shareGrantId: grant.id,
          teamId: ids.team,
          workspaceId: ids.workspace
        })
      )
    );
    expect(
      document.body.querySelector(".collab-change-detail-modal")
    ).toBeNull();
    await click(container, "Modify");
    await click(container, "Rename Share");
    const renameInput = document.body.querySelector<HTMLInputElement>(
      '.collab-modify-share-modal input[aria-label="Share name"]'
    );
    expect(renameInput).not.toBeNull();
    await act(async () => setValue(renameInput!, "Launch review"));
    await click(container, "Save Share name");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Launch review")
    );
    expect(client.renameOwnedShare).toHaveBeenCalledWith({
      kind: "pending",
      id: pending.pendingShare.id,
      title: "Launch review"
    });
    const pause = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Pause updates"
    );
    expect(pause).not.toBeUndefined();
    pause!.focus();
    await act(async () => pause!.click());
    await vi.waitFor(() => expect(pause!.textContent).toBe("Resume updates"));
    expect(document.activeElement).toBe(pause);
    expect(client.controlPendingShare).toHaveBeenCalledWith({
      pendingShareId: pending.pendingShare.id,
      expectedOperationVersion: 3,
      action: "pause"
    });
  });

  it("closes Share revocation confirmation after approval while execution continues", async () => {
    const snapshot = baseSnapshot();
    const grant: SharedMemoryGrant = {
      id: uuid(621),
      logicalGrantId: uuid(622),
      logicalMemoryId: ids.logicalMemory,
      ownerUserId: ids.remoteMark,
      teamId: ids.team,
      workspaceId: ids.workspace,
      consentId: uuid(623),
      ownerAllowedRepresentations: ["memory_events"],
      activeRepresentation: "memory_events",
      representationPolicyRevision: 1,
      sourceRevision: 12,
      grantVersion: 1,
      lifecycle: "active",
      createdAt: at,
      updatedAt: at,
      revokedAt: null,
      companionThreadId: ids.discussion
    };
    const share: OwnedShareItem = {
      kind: "grant",
      grant,
      sourceAccess: null,
      summary: {
        sourceSessionId: ids.eventSession,
        sourceTitle: "Approval-tracked revoke fixture",
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
        mode: "continuous",
        authorizedPreview: null,
        lastReadyRevision: 12,
        lastSuccessfulUpdateAt: at
      }
    };
    const client = createClient(snapshot);
    vi.mocked(client.listOwnedShares).mockResolvedValue({
      shares: [share],
      nextCursor: null
    });
    vi.mocked(client.getOwnedShare).mockResolvedValue(share);

    let actionGrants: readonly CollaborationActionGrantProjection[] = [];
    const actionGrantListeners = new Set<() => void>();
    client.currentActionGrants = () => actionGrants;
    client.subscribeActionGrants = (listener) => {
      actionGrantListeners.add(listener);
      return () => actionGrantListeners.delete(listener);
    };

    let completeRevocation!: (value: SharedMemoryGrant) => void;
    vi.mocked(client.revokeSharedMemory).mockImplementation(
      () =>
        new Promise((resolve) => {
          completeRevocation = resolve;
        })
    );

    await act(async () =>
      root.render(
        <PersonalMemoryView
          client={client}
          initialSection="shares"
          markdownAdapters={{ openExternal: vi.fn(), writeClipboard: vi.fn() }}
          onShare={vi.fn()}
          snapshot={snapshot}
        />
      )
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(share.summary.sourceTitle)
    );

    await click(container, "Revoke");
    expect(
      document.body.querySelector(
        `[aria-label="Revoke ${share.summary.sourceTitle}"]`
      )
    ).not.toBeNull();
    await click(container, "Revoke Share");
    expect(client.revokeSharedMemory).toHaveBeenCalled();
    expect(
      document.body.querySelector(
        `[aria-label="Revoke ${share.summary.sourceTitle}"]`
      )
    ).not.toBeNull();

    await act(async () => {
      actionGrants = [
        {
          expiresAt: "2026-08-14T15:00:00.000Z",
          id: "revoke-action-grant",
          operation: "Revoke Shared Memory",
          retryable: false,
          state: "approved"
        }
      ];
      for (const listener of actionGrantListeners) listener();
    });
    expect(
      document.body.querySelector(
        `[aria-label="Revoke ${share.summary.sourceTitle}"]`
      )
    ).toBeNull();

    await act(async () =>
      completeRevocation({
        ...grant,
        lifecycle: "revoked",
        grantVersion: grant.grantVersion + 1,
        revokedAt: at
      })
    );
  });

  it("keeps the Shares pane while the responsive status view loads", async () => {
    const snapshot = baseSnapshot();
    const client = createClient(snapshot);
    vi.mocked(client.listOwnedShares).mockImplementation(
      () => new Promise(() => undefined)
    );

    await act(async () =>
      root.render(
        <App
          collaborationClient={client}
          onboardingComplete
          statusReadyOverride
        />
      )
    );
    await click(container, "Shares");
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(".personal-shares-status")
      ).not.toBeNull()
    );

    expect(
      document.body.querySelectorAll(".personal-shares-status")
    ).toHaveLength(1);
    expect(
      document.body.querySelector(".personal-shares-status")?.textContent
    ).not.toContain("Loading Shares");
    expect(
      document.body.querySelectorAll('[aria-label="Loading Shares"]')
    ).toHaveLength(2);
    expect(
      document.body.querySelectorAll(
        ".personal-shares-status .personal-loading-icon"
      )
    ).toHaveLength(2);
    expect(
      document.body.querySelector(
        ".personal-shares-status > .collab-shares-pane"
      )
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        ".personal-shares-status > .collab-share-empty-detail"
      )
    ).not.toBeNull();
  });

  it("shows one retryable Shares error and mutes the clickable sidebar item", async () => {
    const client = createClient();
    vi.mocked(client.listOwnedShares).mockRejectedValue(
      new Error("Team Backend unavailable")
    );

    await render(client);
    await click(container, "Shares");
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(".personal-shares-status")?.textContent
      ).toContain("Shares unavailable")
    );

    const status = document.body.querySelector<HTMLElement>(
      ".personal-shares-status"
    )!;
    const sharesNav = [
      ...document.body.querySelectorAll<HTMLButtonElement>(
        ".desktop-sidebar-nav-item"
      )
    ].find((button) =>
      button.textContent?.replace(/\s+/g, " ").trim().includes("Shares")
    )!;
    expect(
      document.body.querySelectorAll(".personal-shares-status")
    ).toHaveLength(1);
    expect(status.textContent).toContain("Koed could not load your Shares.");
    expect(status.textContent).toContain("Retry");
    expect(status.querySelector(".collab-shares-pane")).not.toBeNull();
    expect(status.querySelector(".collab-share-empty-detail")).not.toBeNull();
    expect(
      status.querySelector(".personal-projects-narrow-state")?.textContent
    ).toContain("Shares unavailable");
    expect(sharesNav.dataset.unavailable).toBe("true");
    expect(sharesNav.disabled).toBe(false);

    const initialCalls = vi.mocked(client.listOwnedShares).mock.calls.length;
    await click(status, "Retry");
    await vi.waitFor(() =>
      expect(
        vi.mocked(client.listOwnedShares).mock.calls.length
      ).toBeGreaterThan(initialCalls)
    );
  });

  it.each([
    {
      action: "Connect",
      backendId: null,
      message: "Connect to a Team to view your Shares.",
      state: "disconnected" as const
    },
    {
      action: "Reconnect",
      backendId: "up_team_example",
      message: "Reconnect to your Team to view your Shares.",
      state: "disconnected" as const
    },
    {
      action: "Retry",
      backendId: "up_team_example",
      message: "Koed could not reach your Team.",
      state: "unavailable" as const
    },
    {
      action: null,
      backendId: "up_team_example",
      message: "Koed is reconnecting to your Team.",
      state: "reconnecting" as const
    },
    {
      action: "Review Access",
      backendId: "up_team_example",
      message: "Your Team access was revoked.",
      state: "access_revoked" as const
    }
  ])(
    "shows the $state Shares unavailable case",
    async ({ action, backendId, message, state }) => {
      const current = baseSnapshot();
      const snapshot = collaborationSnapshotSchema.parse({
        ...current,
        connection: {
          ...current.connection,
          backendId,
          connectedAt: null,
          state
        }
      });
      await render(createClient(snapshot));
      await click(container, "Shares");

      const status = document.body.querySelector(".personal-shares-status")!;
      expect(status.textContent).toContain("Shares unavailable");
      expect(status.textContent).toContain(message);
      expect(
        status.querySelector<HTMLButtonElement>("button")?.textContent ?? null
      ).toBe(action);
    }
  );

  it("opens Team Connection from the Connect action", async () => {
    const current = baseSnapshot();
    const client = createClient(
      collaborationSnapshotSchema.parse({
        ...current,
        connection: {
          ...current.connection,
          backendId: null,
          connectedAt: null,
          state: "disconnected"
        }
      })
    );
    await render(client);
    await click(container, "Shares");
    await click(container, "Connect");

    expect(document.body.textContent).toContain("Team Connection");
    expect(client.reconnect).not.toHaveBeenCalled();
  });

  it("runs the saved Team reconnect action", async () => {
    const current = baseSnapshot();
    const client = createClient(
      collaborationSnapshotSchema.parse({
        ...current,
        connection: {
          ...current.connection,
          connectedAt: null,
          state: "disconnected"
        }
      })
    );
    await render(client);
    await click(container, "Shares");
    await click(container, "Reconnect");

    expect(client.reconnect).toHaveBeenCalledOnce();
  });

  it("keeps the Shares route when collaboration state cannot load", async () => {
    const client = createClient();
    client.current = () => null;
    vi.mocked(client.load).mockRejectedValue(new Error("Bridge unavailable"));

    await render(client);
    await vi.waitFor(() => expect(client.load).toHaveBeenCalled());
    await click(container, "Shares");

    const status = document.body.querySelector(".personal-shares-status")!;
    expect(status.textContent).toContain("Shares unavailable");
    expect(status.textContent).toContain("Koed could not load your Shares.");
    expect(status.textContent).not.toContain("Projects unavailable");
  });

  it("reopens source review for an advanced failed share outside the navigation snapshot", async () => {
    const current = baseSnapshot();
    const source = current.navigation.personal.memory[0]!;
    const snapshot = collaborationSnapshotSchema.parse({
      ...current,
      navigation: {
        ...current.navigation,
        personal: { ...current.navigation.personal, memory: [] }
      }
    });
    const failed: OwnedShareItem = {
      kind: "pending",
      pendingShare: {
        id: uuid(631),
        mutationId: uuid(632),
        logicalGrantId: uuid(633),
        consentId: uuid(634),
        logicalMemoryId: source.logicalMemoryId!,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["memory_events"],
        mode: "continuous",
        sourceRevision: 12,
        state: "failed",
        stage: "processing",
        workspaceAccessState: "none",
        sourceUpdateState: "failed",
        operationVersion: 4,
        attemptCount: 2,
        redactedFailureCode: "candidate_source_advanced",
        lastProgressAt: at,
        createdAt: at,
        updatedAt: at,
        activatedAt: null,
        revokedAt: null,
        grantId: null
      },
      sourceAccess: null,
      summary: {
        sourceSessionId: source.id,
        sourceTitle: source.title,
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
        mode: "continuous",
        authorizedPreview: null,
        lastReadyRevision: null,
        lastSuccessfulUpdateAt: null
      }
    };
    const client = createClient(snapshot);
    vi.mocked(client.listOwnedShares).mockResolvedValue({
      shares: [failed],
      nextCursor: null
    });
    vi.mocked(client.getOwnedShare).mockResolvedValue(failed);
    vi.mocked(client.prepareSharedMemorySource).mockResolvedValue(source);
    vi.mocked(client.controlPendingShare).mockResolvedValue({
      ...failed.pendingShare,
      state: "revoked",
      stage: "complete",
      workspaceAccessState: "revoked",
      sourceUpdateState: "stopped",
      operationVersion: failed.pendingShare.operationVersion + 1,
      redactedFailureCode: null,
      revokedAt: at
    });
    const onShare = vi.fn();

    await act(async () =>
      root.render(
        <PersonalMemoryView
          client={client}
          initialSection="shares"
          markdownAdapters={{ openExternal: vi.fn(), writeClipboard: vi.fn() }}
          onShare={onShare}
          snapshot={snapshot}
        />
      )
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(source.title)
    );
    await click(container, "Modify");
    await click(container, "Review again");

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Review")
    );
    expect(client.prepareSharedMemorySource).toHaveBeenCalledWith({
      sessionId: source.id
    });
    expect(onShare).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      "Personal Memory unavailable"
    );
    await click(container, "Cancel");
    await click(container, "Revoke");
    expect(document.body.textContent).toContain("Stop Pending Share");
    expect(document.body.textContent).toContain(
      "Your Personal Memory will not be deleted."
    );
    await click(container, "Stop Share");
    await vi.waitFor(() =>
      expect(client.controlPendingShare).toHaveBeenCalledWith({
        pendingShareId: failed.pendingShare.id,
        expectedOperationVersion: failed.pendingShare.operationVersion,
        action: "revoke"
      })
    );
  });

  it("shows only time for today's Shares and only date for older Shares", () => {
    const now = new Date(2026, 7, 13, 18, 0).getTime();
    const today = formatShareListTime(
      new Date(2026, 7, 13, 12, 24).toISOString(),
      now
    );
    const older = formatShareListTime(
      new Date(2026, 7, 10, 16, 8).toISOString(),
      now
    );

    expect(today).toContain("12:24");
    expect(today).not.toContain("Aug");
    expect(older).toContain("Aug");
    expect(older).not.toContain(":");
  });

  it("refreshes local health when collaboration becomes live", async () => {
    const initial = {
      ...baseSnapshot(),
      connection: {
        ...baseSnapshot().connection,
        state: "unavailable" as const,
        connectedAt: null
      }
    };
    const client = createClient(collaborationSnapshotSchema.parse(initial));
    const localStatusStore = new DesktopStatusStore();
    const refresh = vi
      .spyOn(localStatusStore, "refresh")
      .mockResolvedValue(null);

    await act(async () => {
      root.render(
        <App
          collaborationClient={client}
          onboardingComplete
          statusStoreOverride={localStatusStore}
        />
      );
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    await act(async () => {
      client.emit(
        {
          ...requireCurrent(client),
          connection: {
            ...requireCurrent(client).connection,
            state: "live",
            connectedAt: "2026-07-23T00:01:00.000Z"
          }
        },
        undefined,
        "connection"
      );
    });

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it("keeps an onboarded device in the app shell while services recover", async () => {
    const starting = {
      state: "starting" as const,
      message: "Starting"
    };
    const status: KoedServerStatus = {
      ok: false,
      state: "starting",
      koedHome: "/tmp/existing-koed-home",
      generatedAt: "2026-07-23T00:00:00.000Z",
      runtimeMode: "local-personal",
      dependencyMode: "bundled-local",
      api: { ...starting, url: "http://127.0.0.1:3300" },
      database: starting,
      redis: starting,
      workerQueues: starting,
      embeddingService: starting,
      apiToken: { ...starting, configured: true },
      mcpServer: starting,
      captureHook: starting,
      codex: { ...starting, configured: true },
      lcmSummaryService: starting,
      upstreamBackends: {
        ...starting,
        registered: 0,
        validated: 0,
        stale: 0,
        failed: 0,
        notChecked: 0
      },
      lastVerification: { ...starting, checkedAt: null },
      serverPackage: starting
    };
    window.koedDesktop = {
      invoke: async <T = unknown,>(): Promise<T> => status as T
    };

    await act(async () => {
      root.render(
        <App
          collaborationClient={createClient()}
          onboardingComplete
          personalMemoryApi={null}
          statusStoreOverride={new DesktopStatusStore()}
        />
      );
    });

    await vi.waitFor(() =>
      expect(document.body.querySelector(".desktop-app-shell")).not.toBeNull()
    );
    expect(document.body.textContent).not.toContain("Set up Koed");
  });

  it("loads pending invitations and creates a copy-once invitation that can be revoked", async () => {
    const client = await render();
    let finishInvitations: (() => void) | undefined;
    vi.mocked(client.listInvitations).mockImplementationOnce(
      ({ teamId }) =>
        new Promise((resolve) => {
          finishInvitations = () =>
            resolve({ teamId, items: [], nextCursor: null });
        })
    );
    const writeText = vi.fn(async () => undefined);
    window.koedDesktop = {
      invoke: vi.fn(),
      clipboard: { writeText }
    };

    await click(container, "Atlas Research");
    await click(container, "People");
    expect(document.body.textContent).toContain("Loading pending invitations");
    await act(async () => finishInvitations?.());
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("No pending invitations.")
    );

    await click(container, "Invite member");
    setValue(
      document.body.querySelector<HTMLInputElement>('input[name="email"]')!,
      "new.member@example.test"
    );
    setValue(
      document.body.querySelector<HTMLSelectElement>('select[name="role"]')!,
      "admin"
    );
    await submit();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Invitation created for new.member@example.test"
      )
    );
    expect(client.createInvitation).toHaveBeenCalledWith({
      teamId: ids.team,
      email: "new.member@example.test",
      role: "admin",
      defaultWorkspaceId: ids.workspace,
      defaultWorkspaceAccess: "write",
      ttlHours: 72
    });
    expect(document.body.textContent).not.toContain("token=one-time");

    await click(container, "Copy invitation link");
    expect(writeText).toHaveBeenCalledWith(
      "https://team.example.test/invitations/accept?token=one-time"
    );
    expect(document.body.textContent).toContain("Invitation link copied.");
    expect(document.body.textContent).not.toContain("Copy invitation link");

    await click(container, "Close Invite member");
    expect(document.body.textContent).toContain("new.member@example.test");
    await click(container, "Revoke");
    expect(client.revokeInvitation).toHaveBeenCalledWith({
      teamId: ids.team,
      invitationId: ids.invitation,
      expectedVersion: 1
    });
    expect(document.body.textContent).toContain("No pending invitations.");
  });

  it("exposes versioned member and Workspace lifecycle controls to Team managers", async () => {
    const client = await render();
    await click(container, "Atlas Research");
    await click(container, "People");
    await vi.waitFor(() => expect(client.listInvitations).toHaveBeenCalled());

    const leave = [
      ...document.body.querySelectorAll<HTMLButtonElement>("button")
    ].find((button) => button.textContent?.includes("Leave Team"))!;
    expect(leave.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "The last owner must assign another owner before leaving."
    );

    await act(async () =>
      setValue(
        document.body.querySelector<HTMLSelectElement>(
          'select[aria-label="Role for Alex Chen"]'
        )!,
        "admin"
      )
    );
    expect(client.updateMemberRole).toHaveBeenCalledWith({
      teamId: ids.team,
      userId: ids.alex,
      role: "admin",
      expectedVersion: 1
    });

    await act(async () =>
      setValue(
        document.body.querySelector<HTMLSelectElement>(
          'select[aria-label="Launch Plans access for Riley Jones"]'
        )!,
        "write"
      )
    );
    expect(client.setWorkspaceAccess).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Riley Jones · Launch Plans: disabled → write"
    );
    await click(container, "Review and apply");
    expect(client.setWorkspaceAccess).toHaveBeenCalledWith({
      teamId: ids.team,
      workspaceId: ids.workspace,
      userId: ids.riley,
      access: "write",
      expectedVersion: null
    });

    const emitRileyAccess = async (
      access: "disabled" | "read" | "write",
      version: number
    ) => {
      const current = requireCurrent(client);
      const updatePeople = (
        people: CollaborationSnapshot["navigation"]["teams"][number]["people"]
      ) =>
        people.map((person) =>
          person.id === ids.riley && person.management
            ? {
                ...person,
                management: {
                  ...person.management,
                  workspaceAccess: [
                    {
                      workspaceId: ids.workspace,
                      userId: ids.riley,
                      access,
                      version
                    }
                  ]
                }
              }
            : person
        );
      await act(async () =>
        client.emit({
          ...current,
          navigation: {
            ...current.navigation,
            teams: current.navigation.teams.map((team) =>
              team.id === ids.team
                ? { ...team, people: updatePeople(team.people) }
                : team
            )
          },
          view:
            current.view.kind === "team_people"
              ? { ...current.view, people: updatePeople(current.view.people) }
              : current.view
        })
      );
    };
    await emitRileyAccess("write", 1);
    await act(async () =>
      setValue(
        document.body.querySelector<HTMLSelectElement>(
          'select[aria-label="Launch Plans access for Riley Jones"]'
        )!,
        "read"
      )
    );
    expect(client.setWorkspaceAccess).toHaveBeenCalledTimes(1);
    await click(container, "Review and apply");
    expect(client.setWorkspaceAccess).toHaveBeenLastCalledWith({
      teamId: ids.team,
      workspaceId: ids.workspace,
      userId: ids.riley,
      access: "read",
      expectedVersion: 1
    });
    await emitRileyAccess("read", 2);
    await act(async () =>
      setValue(
        document.body.querySelector<HTMLSelectElement>(
          'select[aria-label="Launch Plans access for Riley Jones"]'
        )!,
        "disabled"
      )
    );
    expect(client.setWorkspaceAccess).toHaveBeenCalledTimes(2);
    await click(container, "Review and apply");
    expect(client.setWorkspaceAccess).toHaveBeenLastCalledWith({
      teamId: ids.team,
      workspaceId: ids.workspace,
      userId: ids.riley,
      access: "disabled",
      expectedVersion: 2
    });

    await click(container, "Open Launch Plans");
    expect(client.select).toHaveBeenLastCalledWith({
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    await click(container, "People");

    await click(container, "Archive");
    expect(client.archiveWorkspace).toHaveBeenCalledWith({
      teamId: ids.team,
      workspaceId: ids.workspace,
      expectedVersion: 1
    });

    const archived = requireCurrent(client);
    await act(async () =>
      client.emit({
        ...archived,
        navigation: {
          ...archived.navigation,
          teams: archived.navigation.teams.map((team) =>
            team.id === ids.team
              ? {
                  ...team,
                  workspaces: team.workspaces.map((workspace) =>
                    workspace.id === ids.workspace
                      ? {
                          ...workspace,
                          lifecycle: "archived" as const,
                          version: 2
                        }
                      : workspace
                  )
                }
              : team
          )
        }
      })
    );
    await click(container, "Restore");
    expect(client.restoreWorkspace).toHaveBeenCalledWith({
      teamId: ids.team,
      workspaceId: ids.workspace,
      expectedVersion: 2
    });

    await click(container, "Create Workspace");
    setValue(
      document.body.querySelector<HTMLInputElement>('input[name="name"]')!,
      "Operations"
    );
    setValue(
      document.body.querySelector<HTMLTextAreaElement>(
        'textarea[name="description"]'
      )!,
      "Runbooks"
    );
    await submit();
    expect(client.createWorkspace).toHaveBeenCalledWith({
      teamId: ids.team,
      name: "Operations",
      description: "Runbooks"
    });
  });

  it("discards Workspace Access drafts when switching directly between Teams", async () => {
    const starting = baseSnapshot();
    const managedSecondTeam = {
      ...starting.navigation.teams[0]!,
      id: ids.teamTwo,
      name: "Beta Team",
      directMessages: [],
      workspaces: starting.navigation.teams[0]!.workspaces.map((workspace) => ({
        ...workspace,
        channels: [],
        sharedMemory: []
      }))
    };
    const managedTeams = collaborationSnapshotSchema.parse({
      ...starting,
      navigation: {
        ...starting.navigation,
        teams: [starting.navigation.teams[0]!, managedSecondTeam]
      }
    });
    const client = await render(
      createClient(
        viewFor(managedTeams, { kind: "team_people", teamId: ids.team })
      )
    );

    await act(async () =>
      setValue(
        document.body.querySelector<HTMLSelectElement>(
          'select[aria-label="Launch Plans access for Riley Jones"]'
        )!,
        "write"
      )
    );
    expect(document.body.textContent).toContain("1 pending access change");

    await act(async () => {
      await client.select({ kind: "team_people", teamId: ids.teamTwo });
    });

    expect(document.body.textContent).toContain("Beta Team");
    expect(document.body.textContent).not.toContain("pending access change");
    expect(document.body.textContent).not.toContain("Review and apply");
  });

  it("keeps only unapplied Workspace Access changes after a partial failure", async () => {
    const client = createClient();
    vi.mocked(client.setWorkspaceAccess)
      .mockResolvedValueOnce({
        workspaceId: ids.workspace,
        userId: ids.alex,
        access: "disabled",
        version: 2
      })
      .mockRejectedValueOnce(new Error("second change failed"));
    await render(client);
    await click(container, "Atlas Research");
    await click(container, "People");

    await act(async () =>
      setValue(
        document.body.querySelector<HTMLSelectElement>(
          'select[aria-label="Launch Plans access for Alex Chen"]'
        )!,
        "disabled"
      )
    );
    await act(async () =>
      setValue(
        document.body.querySelector<HTMLSelectElement>(
          'select[aria-label="Launch Plans access for Riley Jones"]'
        )!,
        "write"
      )
    );

    expect(document.body.textContent).toContain("2 pending access changes");
    await click(container, "Review and apply");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "The remaining Workspace Access draft could not be applied"
      )
    );

    expect(client.setWorkspaceAccess).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(
      "Alex Chen · Launch Plans: read → disabled"
    );
    expect(document.body.textContent).toContain(
      "Riley Jones · Launch Plans: disabled → write"
    );
    expect(document.body.textContent).toContain("1 pending access change");
  });

  it("keeps a normal User's Team roster usable without management controls", async () => {
    const selected = viewFor(baseSnapshot(), {
      kind: "team_people",
      teamId: ids.team
    });
    const memberSnapshot = collaborationSnapshotSchema.parse({
      ...selected,
      navigation: {
        ...selected.navigation,
        teams: selected.navigation.teams.map((team) =>
          team.id === ids.team
            ? {
                ...team,
                role: "member",
                membershipVersion: 3,
                people: team.people.map(
                  ({
                    id,
                    displayName,
                    presence,
                    membershipState,
                    teamPresence
                  }) => ({
                    id,
                    displayName,
                    presence,
                    membershipState,
                    teamPresence
                  })
                )
              }
            : team
        )
      },
      view: {
        ...selected.view,
        people:
          selected.view.kind === "team_people"
            ? selected.view.people.map(
                ({
                  id,
                  displayName,
                  presence,
                  membershipState,
                  teamPresence
                }) => ({
                  id,
                  displayName,
                  presence,
                  membershipState,
                  teamPresence
                })
              )
            : []
      }
    });
    const client = await render(createClient(memberSnapshot));

    expect(document.body.textContent).toContain("Alex Chen");
    expect(document.body.textContent).toContain("Leave Team");
    expect(document.body.textContent).not.toContain("Invite member");
    expect(document.body.textContent).not.toContain("Invites");
    expect(document.body.textContent).not.toContain("Membership");
    expect(document.body.textContent).not.toContain("Create Workspace");
    expect(document.body.textContent).not.toContain("Pending invitations");
    expect(
      document.body.querySelector('select[aria-label^="Role for"]')
    ).toBeNull();
    expect(
      document.body.querySelector('select[aria-label*="access for"]')
    ).toBeNull();
    expect(client.listInvitations).not.toHaveBeenCalled();

    expect(
      document.body.querySelector(
        '.collab-person-admin-row[data-current-user="true"] .collab-presence-controls'
      )
    ).not.toBeNull();

    await click(container, "Leave Team");
    expect(client.leaveTeam).toHaveBeenCalledWith({
      teamId: ids.team,
      expectedVersion: 3
    });
  });

  it("renders Team presence and lets the current User choose one manual status", async () => {
    const selected = viewFor(baseSnapshot(), {
      kind: "team_people",
      teamId: ids.team
    });
    const setPresence = (
      person: CollaborationSnapshot["navigation"]["teams"][number]["people"][number]
    ) =>
      person.id === ids.remoteMark
        ? {
            ...person,
            presence: "available" as const,
            teamPresence: {
              mode: "manual" as const,
              manualStatus: "available" as const,
              activityLevel: null,
              lastActivityAt: null,
              nextTransitionAt: null,
              preferenceVersion: 7
            }
          }
        : person.id === ids.riley
          ? {
              ...person,
              presence: "away" as const,
              teamPresence: {
                mode: "manual" as const,
                manualStatus: "out_of_office" as const,
                activityLevel: null,
                lastActivityAt: null,
                nextTransitionAt: null,
                preferenceVersion: 2
              }
            }
          : person;
    const presenceSnapshot = collaborationSnapshotSchema.parse({
      ...selected,
      navigation: {
        ...selected.navigation,
        teams: selected.navigation.teams.map((team) =>
          team.id === ids.team
            ? { ...team, people: team.people.map(setPresence) }
            : team
        )
      },
      view:
        selected.view.kind === "team_people"
          ? { ...selected.view, people: selected.view.people.map(setPresence) }
          : selected.view
    });
    const client = await render(createClient(presenceSnapshot));

    const firstMember = document.body.querySelector(".collab-person-admin-row");
    expect(firstMember?.textContent).toContain("Mark Fixture");
    expect(firstMember?.textContent).toContain("Me");

    const auto = document.body.querySelector<HTMLInputElement>(
      '.collab-presence-auto input[type="checkbox"]'
    );
    expect(auto?.checked).toBe(false);
    expect(
      document.body.querySelector('[title="Out of office"]')
    ).not.toBeNull();
    expect(
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="Available"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");

    await click(container, "Do not disturb");
    expect(client.setTeamPresence).toHaveBeenCalledWith({
      teamId: ids.team,
      mode: "manual",
      manualStatus: "do_not_disturb",
      expectedVersion: 7
    });
  });

  it("advances automatic Team presence through every threshold without another server event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    const selected = viewFor(baseSnapshot(), {
      kind: "team_people",
      teamId: ids.teamTwo
    });
    await render(createClient(selected));

    expect(document.body.querySelector('[title="Active"]')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    });
    expect(
      document.body.querySelector('[title="Recently active"]')
    ).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    });
    expect(document.body.querySelector('[title="Idle"]')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90 * 60 * 1000);
    });
    expect(document.body.querySelector('[title="Inactive"]')).not.toBeNull();
    expect(
      document.body.querySelector(".collab-person-identity > span")?.textContent
    ).toContain("Inactive");
  });

  it("renders pushed activity against the current clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(at) + 3 * 60 * 60 * 1000));
    const client = createClient(
      viewFor(baseSnapshot(), {
        kind: "team_people",
        teamId: ids.teamTwo
      })
    );
    await render(client);
    expect(document.body.querySelector('[title="Inactive"]')).not.toBeNull();

    const current = requireCurrent(client);
    const activityAt = new Date(Date.now()).toISOString();
    const updatePeople = (
      people: CollaborationSnapshot["navigation"]["teams"][number]["people"]
    ) =>
      people.map((person) => ({
        ...person,
        presence: "available" as const,
        teamPresence: {
          ...person.teamPresence,
          activityLevel: "active" as const,
          lastActivityAt: activityAt,
          nextTransitionAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        }
      }));
    await act(async () =>
      client.emit({
        ...current,
        navigation: {
          ...current.navigation,
          teams: current.navigation.teams.map((team) =>
            team.id === ids.teamTwo
              ? { ...team, people: updatePeople(team.people) }
              : team
          )
        },
        view:
          current.view.kind === "team_people"
            ? { ...current.view, people: updatePeople(current.view.people) }
            : current.view
      })
    );

    expect(document.body.querySelector('[title="Active"]')).not.toBeNull();
  });

  it("reports foreground activity when an already-focused view mounts", async () => {
    const client = await render();

    await vi.waitFor(() =>
      expect(client.reportTeamActivity).toHaveBeenCalledWith([
        ids.team,
        ids.teamTwo
      ])
    );
  });

  it("shows safe denied and conflict states without exposing internal errors", async () => {
    const client = await render();
    vi.mocked(client.listInvitations).mockRejectedValueOnce(
      new CollaborationClientError({
        code: "permission_denied",
        userMessage: collaborationSafeErrorMessages.permission_denied,
        retryable: false,
        retryAfterMs: null
      })
    );
    await click(container, "Atlas Research");
    await click(container, "People");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        collaborationSafeErrorMessages.permission_denied
      )
    );

    vi.mocked(client.updateMemberRole).mockRejectedValueOnce(
      new CollaborationClientError({
        code: "conflict",
        userMessage: collaborationSafeErrorMessages.conflict,
        retryable: true,
        retryAfterMs: null
      })
    );
    await act(async () =>
      setValue(
        document.body.querySelector<HTMLSelectElement>(
          'select[aria-label="Role for Alex Chen"]'
        )!,
        "admin"
      )
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        collaborationSafeErrorMessages.conflict
      )
    );

    vi.mocked(client.archiveWorkspace).mockRejectedValueOnce(
      new Error("postgresql://internal-secret@database")
    );
    await click(container, "Archive");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "The Workspace could not be archived."
      )
    );
    expect(document.body.textContent).not.toContain("postgresql://");
    expect(document.body.textContent).not.toContain("internal-secret");
  });

  it.each([
    ["raw API", "api-response-body-sentinel"],
    ["realtime", "realtime-frame-payload-sentinel"]
  ] as const)("does not render %s error details", async (surface, sentinel) => {
    const client = createClient();

    if (surface === "raw API") {
      vi.mocked(client.archiveWorkspace).mockRejectedValueOnce(
        new Error(sentinel)
      );
      await render(client);
      await click(container, "Atlas Research");
      await click(container, "People");
      await click(container, "Archive");
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          "The Workspace could not be archived."
        )
      );
    } else {
      const subscribe = client.subscribe.bind(client);
      client.subscribe = (listener) =>
        subscribe((snapshot, update) =>
          listener(snapshot, {
            ...update,
            announcement:
              collaborationSafeErrorMessages.temporarily_unavailable,
            rawDetail: sentinel
          } as CollaborationClientUpdate)
        );
      await render(client);
      await act(async () =>
        client.emit(requireCurrent(client), undefined, "connection")
      );
      expect(document.body.textContent).toContain(
        collaborationSafeErrorMessages.temporarily_unavailable
      );
    }

    expect(document.body.textContent).not.toContain(sentinel);
  });

  it("clears a transient stream announcement when the connection recovers", async () => {
    const client = await render();
    await act(async () =>
      client.emit(
        {
          ...requireCurrent(client),
          connection: {
            ...requireCurrent(client).connection,
            state: "reconnecting"
          }
        },
        "Collaboration is temporarily unavailable.",
        "connection"
      )
    );
    expect(document.body.textContent).toContain(
      "Collaboration is temporarily unavailable."
    );

    await act(async () =>
      client.emit(
        {
          ...requireCurrent(client),
          connection: { ...requireCurrent(client).connection, state: "live" }
        },
        undefined,
        "connection"
      )
    );
    expect(document.body.textContent).not.toContain(
      "Collaboration is temporarily unavailable."
    );
  });

  it("automatically dismisses a transient top-centred notice", async () => {
    const client = await render();
    vi.useFakeTimers();
    await act(async () =>
      client.emit(
        requireCurrent(client),
        "Collaboration is temporarily unavailable.",
        "connection"
      )
    );
    expect(document.body.querySelector("[data-toast]")).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(5_001));
    expect(document.body.querySelector("[data-toast]")).toBeNull();
  });

  it("shows the other User and Team Presence in a direct-message header", async () => {
    await render();
    await click(container, "Atlas Research");
    await click(container, "Alex Chen");
    expect(
      document.body.querySelector(".collab-header-avatar")?.textContent
    ).toBe("AC");
    expect(
      document.body.querySelector(".collab-direct-presence")?.textContent
    ).toContain("active");
    expect(document.body.textContent).not.toContain("Team · Direct message");
  });

  it("uses concise, page-specific breadcrumbs across Personal and Team routes", async () => {
    await render();
    expect(
      document.body.querySelector('[aria-label="Breadcrumb: Notes to self"]')
    ).not.toBeNull();
    expect(document.body.querySelector(".collab-day-divider")).toBeNull();

    await click(container, "Inbox");
    await vi.waitFor(() =>
      expect(
        document.body.querySelector('[aria-label="Breadcrumb: Inbox"]')
      ).not.toBeNull()
    );

    await click(container, "Atlas Research");
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(
          '[aria-label="Breadcrumb: Atlas Research / People"]'
        )
      ).not.toBeNull()
    );
    expect(
      document.body.querySelector(".collab-content-header h1")?.textContent
    ).toBe("People");
    expect(
      document.body.querySelector(".collab-content-header p")?.textContent
    ).toBe("Atlas Research");

    await click(container, "Alex Chen");
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(
          '[aria-label="Breadcrumb: Atlas Research / Direct messages / Alex Chen"]'
        )
      ).not.toBeNull()
    );

    await click(container, "Launch Plans");
    await click(container, "general");
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(
          '[aria-label="Breadcrumb: Atlas Research / Launch Plans / general"]'
        )
      ).not.toBeNull()
    );

    await click(container, "Shared Memory");
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(
          '[aria-label="Breadcrumb: Atlas Research / Launch Plans / Shared Memory"]'
        )
      ).not.toBeNull()
    );
    await click(container, "Realtime capture review");
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(
          '[aria-label="Breadcrumb: Atlas Research / Launch Plans / Shared Memory / Realtime capture review"]'
        )
      ).not.toBeNull()
    );
  });

  it("shows a spinner while an empty chat selection is loading", async () => {
    const initial = collaborationSnapshotSchema.parse({
      ...baseSnapshot(),
      view: {
        kind: "thread",
        thread: notes(),
        messages: page(ids.notes)
      }
    });
    const client = createClient(initial);
    let finishSelection:
      | ((snapshot: CollaborationSnapshot) => void)
      | undefined;
    vi.mocked(client.select).mockImplementationOnce(
      () =>
        new Promise<CollaborationSnapshot>((resolve) => {
          finishSelection = resolve;
        })
    );
    await render(client);

    await click(container, "research");
    expect(
      document.body.querySelector('[aria-label="Loading messages"]')
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain("No messages yet.");

    const selected = viewFor(initial, {
      kind: "personal_channel",
      threadId: ids.personalChannel
    });
    await act(async () => {
      client.emit(selected);
      finishSelection?.(selected);
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("No messages yet.")
    );
    expect(
      document.body.querySelector('[aria-label="Loading messages"]')
    ).toBeNull();
  });

  it("keeps cached Team People visible during a transient outage", async () => {
    const selected = viewFor(baseSnapshot(), {
      kind: "team_people",
      teamId: ids.team
    });
    const client = await render(createClient(selected));

    await act(async () =>
      client.emit(
        {
          ...requireCurrent(client),
          connection: {
            ...requireCurrent(client).connection,
            state: "unavailable",
            connectedAt: null
          }
        },
        "Collaboration is temporarily unavailable.",
        "connection"
      )
    );

    expect(document.body.textContent).toContain("Members");
    expect(document.body.textContent).toContain("Alex Chen");
    expect(document.body.textContent).not.toContain("Team unavailable");
  });

  it("clears a transient stream announcement after verified live activity", async () => {
    const client = await render();
    await act(async () =>
      client.emit(
        requireCurrent(client),
        "Collaboration is temporarily unavailable.",
        "connection"
      )
    );
    expect(document.body.textContent).toContain(
      "Collaboration is temporarily unavailable."
    );

    await act(async () =>
      client.emit(requireCurrent(client), undefined, "realtime")
    );
    expect(document.body.textContent).not.toContain(
      "Collaboration is temporarily unavailable."
    );
  });

  it.each([
    {
      label: "direct message",
      open: async () => {
        await click(container, "Atlas Research");
        await click(container, "Alex Chen");
      },
      protectedMarkers: ["Alex Chen", "Direct message"]
    }
  ])(
    "purges an open $label immediately when Team access is revoked",
    async ({ open, protectedMarkers }) => {
      const client = await render();
      await open();
      for (const marker of protectedMarkers) {
        expect(document.body.textContent).toContain(marker);
      }

      const current = requireCurrent(client);
      const personal = viewFor(current, { kind: "notes_to_self" });
      await act(async () =>
        client.emit(
          collaborationSnapshotSchema.parse({
            ...personal,
            navigation: { ...personal.navigation, teams: [] }
          }),
          "Access to Team content has ended.",
          "purge"
        )
      );

      expect(document.body.textContent).toContain(
        "Check the Shared Memory split view."
      );
      expect(document.body.textContent).toContain(
        "Access to Team content has ended."
      );
      expect(
        document.body.querySelector('button[title="Atlas Research"]')
      ).toBeNull();
      for (const marker of protectedMarkers) {
        expect(document.body.textContent).not.toContain(marker);
      }
    }
  );

  it("exposes a shell-neutral CollaborationRoutes body with injected workflow dependencies", async () => {
    const snapshot = baseSnapshot();
    const client = createClient(snapshot);
    const writeClipboard = vi.fn();
    await act(async () =>
      root.render(
        <CollaborationRoutes
          client={client}
          drafts={new DraftStore()}
          markdownAdapters={{
            openExternal: vi.fn(),
            writeClipboard
          }}
          modal={null}
          onModalChange={vi.fn()}
          onRequestSelection={vi.fn()}
          snapshot={snapshot}
        />
      )
    );

    expect(document.body.textContent).toContain("Notes to self");
    expect(document.body.querySelector(".collab-rail")).toBeNull();
    expect(document.body.querySelector(".collab-sidebar")).toBeNull();
    expect(document.body.querySelector(".collab-conversation")).not.toBeNull();

    const actions = document.body.querySelector<HTMLDetailsElement>(
      "details.collab-message-actions"
    );
    expect(actions?.querySelector("summary")?.tabIndex).toBe(0);
    await click(container, "Copy message");
    expect(writeClipboard).toHaveBeenCalledWith(
      "Check the Shared Memory split view."
    );
  });

  it("keeps Shares detail focus stable while a continuous Pending Share pauses", async () => {
    const setInterval = vi.spyOn(window, "setInterval");
    const snapshot = viewFor(baseSnapshot(), { kind: "personal_memory" });
    const pending: OwnedShareItem = {
      kind: "pending",
      pendingShare: {
        id: uuid(601),
        mutationId: uuid(602),
        logicalGrantId: uuid(603),
        consentId: uuid(604),
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["memory_events"],
        mode: "continuous",
        sourceRevision: 12,
        state: "activated",
        stage: "complete",
        workspaceAccessState: "active",
        sourceUpdateState: "active",
        operationVersion: 3,
        attemptCount: 1,
        redactedFailureCode: null,
        lastProgressAt: at,
        createdAt: at,
        updatedAt: at,
        activatedAt: at,
        revokedAt: null,
        grantId: uuid(605)
      },
      sourceAccess: null,
      summary: {
        sourceSessionId: ids.eventSession,
        sourceTitle: "Async sharing fixture",
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
        mode: "continuous",
        authorizedPreview: {
          previewId: uuid(606),
          previewHash: "a".repeat(64),
          previewRevision: 1,
          sourceRevision: 12
        },
        lastReadyRevision: 12,
        lastSuccessfulUpdateAt: at
      }
    };
    const paused: OwnedShareItem = {
      ...pending,
      pendingShare: {
        ...pending.pendingShare,
        sourceUpdateState: "paused",
        operationVersion: 4
      }
    };
    const client = createClient(snapshot);
    vi.mocked(client.listOwnedShares).mockResolvedValue({
      shares: [pending],
      nextCursor: null
    });
    vi.mocked(client.getOwnedShare).mockResolvedValue(pending);
    vi.mocked(client.controlPendingShare).mockResolvedValue(
      paused.pendingShare
    );

    await act(async () =>
      root.render(
        <PersonalMemoryView
          client={client}
          initialSection="shares"
          markdownAdapters={{ openExternal: vi.fn(), writeClipboard: vi.fn() }}
          onShare={vi.fn()}
          snapshot={snapshot}
        />
      )
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Async sharing fixture")
    );
    expect(setInterval).not.toHaveBeenCalled();
    const initialListCalls = vi.mocked(client.listOwnedShares).mock.calls
      .length;
    await act(async () =>
      client.emitUpdate(snapshot, {
        kind: "realtime",
        realtimeUpdate: {
          type: "owned_share_status_changed",
          pendingShareId: pending.pendingShare.id,
          sourceTitle: pending.summary.sourceTitle,
          state: pending.pendingShare.state,
          stage: pending.pendingShare.stage,
          workspaceAccessState: pending.pendingShare.workspaceAccessState,
          sourceUpdateState: pending.pendingShare.sourceUpdateState,
          redactedFailureCode: pending.pendingShare.redactedFailureCode
        }
      })
    );
    await vi.waitFor(() =>
      expect(client.listOwnedShares).toHaveBeenCalledTimes(initialListCalls + 2)
    );
    await act(async () =>
      client.emitUpdate(snapshot, {
        kind: "command",
        authoritativeRecovery: true
      })
    );
    await vi.waitFor(() =>
      expect(client.listOwnedShares).toHaveBeenCalledTimes(initialListCalls + 4)
    );
    await click(container, "Modify");
    const pause = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Pause updates"
    );
    expect(pause).not.toBeUndefined();
    pause!.focus();
    await act(async () => pause!.click());
    await vi.waitFor(() => expect(pause!.textContent).toBe("Resume updates"));
    expect(document.activeElement).toBe(pause);
    expect(
      container.querySelector('[role="status"][aria-live="polite"]')
    ).not.toBeNull();
    expect(client.controlPendingShare).toHaveBeenCalledWith({
      pendingShareId: pending.pendingShare.id,
      expectedOperationVersion: 3,
      action: "pause"
    });
  });

  it("renders rich Team Chat Markdown through the shared secure renderer", async () => {
    const selected = viewFor(baseSnapshot(), {
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    if (selected.view.kind !== "thread") {
      throw new Error("Expected a Team Chat thread fixture");
    }
    const body = `## Release checklist

- Parent
  - Nested
- [x] Rendered

> Keep the authority boundary visible.

| Surface | State |
| --- | --- |
| Team Chat | Ready |

[Docs](https://koed.example/docs)

\`\`\`sh
pnpm test
\`\`\``;
    const richSnapshot = collaborationSnapshotSchema.parse({
      ...selected,
      view: {
        ...selected.view,
        messages: page(ids.channel, [message(uuid(410), ids.channel, body)])
      }
    });
    const writeClipboard = vi.fn(async () => undefined);
    const openExternal = vi.fn(async () => undefined);

    await act(async () =>
      root.render(
        <CollaborationRoutes
          client={createClient(richSnapshot)}
          drafts={new DraftStore()}
          markdownAdapters={{ openExternal, writeClipboard }}
          modal={null}
          onModalChange={vi.fn()}
          onRequestSelection={vi.fn()}
          snapshot={richSnapshot}
        />
      )
    );

    expect(container.querySelector(".memory-markdown h2")).not.toBeNull();
    expect(container.textContent).not.toContain("Team · Workspace");
    expect(container.querySelector(".memory-markdown table")).not.toBeNull();
    expect(
      container.querySelector(".memory-markdown blockquote")
    ).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();

    const copy = container.querySelector<HTMLButtonElement>(
      '.memory-markdown-copy-code[aria-label="Copy code"]'
    );
    await act(async () => copy?.click());
    await vi.waitFor(() =>
      expect(writeClipboard).toHaveBeenCalledWith("pnpm test")
    );

    const external = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open external link: Docs"]'
    );
    await act(async () => external?.click());
    expect(openExternal).toHaveBeenCalledWith("https://koed.example/docs");
  });

  it("renders rich Markdown across the Shared Memory source view", async () => {
    const selected = viewFor(baseSnapshot(), {
      kind: "shared_session",
      teamId: ids.team,
      workspaceId: ids.workspace,
      sharedSessionId: ids.eventSession
    });
    const writeClipboard = vi.fn(async () => undefined);

    await act(async () =>
      root.render(
        <CollaborationRoutes
          client={createClient(selected)}
          drafts={new DraftStore()}
          markdownAdapters={{
            openExternal: vi.fn(async () => undefined),
            writeClipboard
          }}
          modal={null}
          onModalChange={vi.fn()}
          onRequestSelection={vi.fn()}
          snapshot={selected}
        />
      )
    );

    const source = container.querySelector(".shared-conversation-timeline");
    expect(
      source?.querySelector(
        '.native-conversation-event.user[data-memory-scope="workspace"]'
      )
    ).not.toBeNull();
    expect(source?.textContent).toContain("You");
    expect(source?.querySelector(".collab-source-event")).toBeNull();
    expect(source?.querySelector(".memory-markdown h2")).not.toBeNull();
    expect(source?.querySelector(".memory-markdown table")).not.toBeNull();
    const copy = source?.querySelector<HTMLButtonElement>(
      '.memory-markdown-copy-code[aria-label="Copy code"]'
    );
    await act(async () => copy?.click());
    expect(writeClipboard).toHaveBeenCalledWith("pnpm typecheck");
  });

  it("renders Curated assertions as assertion text, topic, and tags", async () => {
    const selected = viewFor(baseSnapshot(), {
      kind: "shared_session",
      teamId: ids.team,
      workspaceId: ids.workspace,
      sharedSessionId: ids.rollupSession
    });
    if (selected.view.kind !== "shared_session") {
      throw new Error("Expected a Shared Memory fixture");
    }
    const curatedSession = {
      ...selected.view.session,
      representation: "curated_assertions" as const
    };
    const curatedSnapshot = collaborationSnapshotSchema.parse({
      ...selected,
      view: {
        ...selected.view,
        session: curatedSession,
        source: {
          ...selected.view.source,
          representation: "curated_assertions",
          items: [sourceItem("curated_assertions")]
        }
      }
    });

    await act(async () =>
      root.render(
        <CollaborationRoutes
          client={createClient(curatedSnapshot)}
          drafts={new DraftStore()}
          markdownAdapters={{
            openExternal: vi.fn(async () => undefined),
            writeClipboard: vi.fn(async () => undefined)
          }}
          modal={null}
          onModalChange={vi.fn()}
          onRequestSelection={vi.fn()}
          snapshot={curatedSnapshot}
        />
      )
    );

    const source = container.querySelector(".collab-source-event");
    expect(source?.textContent).toContain("Release policy");
    expect(source?.textContent).toContain(
      "Production releases require an owner-approved rollback plan."
    );
    expect(source?.textContent).toContain("deployment · decision");
    expect(source?.textContent).not.toContain("LCM Rollup");
  });

  it("uses the Personal conversation presentation for Shared Memory activity", async () => {
    const selected = viewFor(baseSnapshot(), {
      kind: "shared_session",
      teamId: ids.team,
      workspaceId: ids.workspace,
      sharedSessionId: ids.eventSession
    });
    if (selected.view.kind !== "shared_session") {
      throw new Error("Expected a Shared Memory fixture");
    }
    const activityItem: SharedMemorySourceItem = {
      id: uuid(420),
      representation: "memory_events",
      sequence: 1,
      occurredAt: at,
      sourceItems: [
        {
          id: uuid(421),
          sourceKind: "user_message",
          occurredAt: at,
          body: "Please check the release.",
          actorName: null,
          toolName: null,
          toolCallId: null
        },
        {
          id: uuid(422),
          sourceKind: "tool_call",
          occurredAt: at,
          body: '{"cmd":"pnpm test"}',
          actorName: null,
          toolName: "exec_command",
          toolCallId: "call-release",
          toolDisplay: {
            kind: "command",
            label: "Ran command",
            preview: "pnpm test",
            toolName: "exec_command",
            callId: "call-release"
          }
        },
        {
          id: uuid(423),
          sourceKind: "tool_result",
          occurredAt: at,
          body: "All tests passed.",
          actorName: null,
          toolName: "exec_command",
          toolCallId: "call-release",
          toolDisplay: {
            kind: "command",
            label: "Ran command",
            preview: "All tests passed.",
            toolName: "exec_command",
            callId: "call-release",
            status: "completed"
          }
        },
        {
          id: uuid(424),
          sourceKind: "agent_message",
          occurredAt: at,
          body: '{"outcome":"allow"}',
          actorName: null,
          toolName: null,
          toolCallId: null,
          approvalDecisionDisplay: {
            kind: "auto_approval",
            version: 1,
            riskLevel: "low",
            userAuthorization: "medium",
            outcome: "allow",
            rationale: "The command is within the requested release check."
          }
        }
      ]
    };
    const snapshot = collaborationSnapshotSchema.parse({
      ...selected,
      view: {
        ...selected.view,
        source: {
          ...selected.view.source,
          items: [activityItem]
        }
      }
    });

    await act(async () =>
      root.render(
        <CollaborationRoutes
          client={createClient(snapshot)}
          drafts={new DraftStore()}
          markdownAdapters={{
            openExternal: vi.fn(async () => undefined),
            writeClipboard: vi.fn(async () => undefined)
          }}
          modal={null}
          onModalChange={vi.fn()}
          onRequestSelection={vi.fn()}
          snapshot={snapshot}
        />
      )
    );

    const source = container.querySelector(".shared-conversation-timeline");
    expect(
      source?.querySelector(".native-conversation-event.user")
    ).not.toBeNull();
    expect(source?.querySelector(".native-tool-group")?.textContent).toContain(
      "2 activity items"
    );
    expect(
      source?.querySelector(".native-approval-decision")?.textContent
    ).toContain("Auto approval");
    expect(source?.textContent).toContain("Risk · Low");
    expect(source?.textContent).toContain("Authorization · Medium");
  });

  it("renders the same rich Shared Memory source in the consent preview", async () => {
    const snapshot = baseSnapshot();
    const client = createClient(snapshot);
    const writeClipboard = vi.fn(async () => undefined);

    await act(async () =>
      root.render(
        <CollaborationModalLayer
          client={client}
          markdownAdapters={{
            openExternal: vi.fn(async () => undefined),
            writeClipboard
          }}
          modal={{
            kind: "share_personal_memory",
            sessionId: snapshot.navigation.personal.memory[0]!.id
          }}
          onModalChange={vi.fn()}
          snapshot={snapshot}
        />
      )
    );

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Review")
    );
    expect(
      document.body.querySelector(".collab-share-memory-modal")
    ).not.toBeNull();
    await click(container, "Review");
    await vi.waitFor(() =>
      expect(document.body.querySelector(".collab-preview-list")).not.toBeNull()
    );

    const preview = document.body.querySelector(".collab-preview-list");
    expect(preview?.querySelector(".memory-markdown h2")).not.toBeNull();
    expect(preview?.querySelector(".memory-markdown table")).not.toBeNull();
    const copy = preview?.querySelector<HTMLButtonElement>(
      '.memory-markdown-copy-code[aria-label="Copy code"]'
    );
    await act(async () => copy?.click());
    expect(writeClipboard).toHaveBeenCalledWith("pnpm typecheck");
  });

  it("opens sharing on the first active writable Workspace", async () => {
    const current = baseSnapshot();
    const team = current.navigation.teams[0]!;
    const writableWorkspace = team.workspaces[0]!;
    const snapshot = collaborationSnapshotSchema.parse({
      ...current,
      navigation: {
        ...current.navigation,
        teams: [
          {
            ...team,
            workspaces: [
              {
                ...writableWorkspace,
                id: uuid(309),
                name: "Read-only archive",
                access: "read",
                channels: [],
                sharedMemory: []
              },
              writableWorkspace
            ]
          },
          ...current.navigation.teams.slice(1)
        ]
      }
    });
    const client = createClient(snapshot);

    await act(async () =>
      root.render(
        <CollaborationModalLayer
          client={client}
          markdownAdapters={{
            openExternal: vi.fn(async () => undefined),
            writeClipboard: vi.fn(async () => undefined)
          }}
          modal={{
            kind: "share_personal_memory",
            sessionId: snapshot.navigation.personal.memory[0]!.id
          }}
          onModalChange={vi.fn()}
          snapshot={snapshot}
        />
      )
    );

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Review")
    );
    const workspaceSelect = document.body.querySelectorAll("select")[1];
    expect(workspaceSelect?.value).toBe(writableWorkspace.id);
    expect(document.body.textContent).not.toContain("Read-only archive");
  });

  it("reviews a local Captured Session without starting synchronization", async () => {
    const localSessionId = uuid(305);
    const current = baseSnapshot();
    const snapshot = collaborationSnapshotSchema.parse({
      ...current,
      navigation: {
        ...current.navigation,
        personal: {
          ...current.navigation.personal,
          memory: []
        }
      }
    });
    const client = createClient(snapshot);
    const prepared = {
      id: localSessionId,
      logicalMemoryId: uuid(306),
      title: "Local Captured Session",
      projectName: "koed",
      updatedAt: at,
      preview: "A session available only in Personal Memory.",
      eventCount: 2,
      hasSynchronizedRevision: true,
      syncState: "ready" as const
    };
    vi.mocked(client.previewSharedMemoryCandidate).mockResolvedValue({
      sessionId: localSessionId,
      logicalMemoryId: prepared.logicalMemoryId,
      representation: "memory_events",
      sourceRevision: 2,
      candidateHash: "c".repeat(64),
      itemCount: 1,
      excludedItemCount: 0,
      manifest: candidateManifestFor("memory_events"),
      byteCount: 128,
      items: [sourceItem("memory_events")]
    });

    await act(async () =>
      root.render(
        <CollaborationModalLayer
          client={client}
          markdownAdapters={{
            openExternal: vi.fn(async () => undefined),
            writeClipboard: vi.fn(async () => undefined)
          }}
          modal={{
            kind: "share_personal_memory",
            sessionId: localSessionId,
            localEntry: {
              ...prepared,
              logicalMemoryId: null,
              hasSynchronizedRevision: false,
              syncState: "not_started"
            }
          }}
          onModalChange={vi.fn()}
          snapshot={snapshot}
        />
      )
    );

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Review")
    );
    expect(document.body.textContent).not.toContain(
      "Personal Memory unavailable"
    );

    await click(container, "Review");

    await vi.waitFor(() =>
      expect(document.body.querySelector(".collab-preview-list")).not.toBeNull()
    );
    expect(client.previewSharedMemoryCandidate).toHaveBeenCalledWith({
      sessionId: localSessionId,
      representation: "memory_events"
    });
    expect(client.prepareSharedMemorySource).not.toHaveBeenCalled();
    expect(client.previewSharedMemory).toHaveBeenCalledWith(
      expect.objectContaining({ logicalMemoryId: prepared.logicalMemoryId })
    );
  });

  it("explains when a local Share candidate has no available detail", async () => {
    const snapshot = baseSnapshot();
    const client = createClient(snapshot);
    vi.mocked(client.previewSharedMemoryCandidate).mockResolvedValue({
      sessionId: snapshot.navigation.personal.memory[0]!.id,
      logicalMemoryId: ids.logicalMemory,
      representation: "memory_events",
      sourceRevision: 2,
      candidateHash: "c".repeat(64),
      itemCount: 0,
      excludedItemCount: 0,
      manifest: [],
      byteCount: 0,
      items: []
    });

    await act(async () =>
      root.render(
        <CollaborationModalLayer
          client={client}
          markdownAdapters={{
            openExternal: vi.fn(async () => undefined),
            writeClipboard: vi.fn(async () => undefined)
          }}
          modal={{
            kind: "share_personal_memory",
            sessionId: snapshot.navigation.personal.memory[0]!.id
          }}
          onModalChange={vi.fn()}
          snapshot={snapshot}
        />
      )
    );

    await click(container, "Review");

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "No Memory Events are available for this Personal Memory."
      )
    );
    expect(client.previewSharedMemory).not.toHaveBeenCalled();
  });

  it("shows the local candidate while authoritative destination validation continues", async () => {
    const localSessionId = uuid(307);
    const logicalMemoryId = uuid(308);
    const current = baseSnapshot();
    const snapshot = collaborationSnapshotSchema.parse({
      ...current,
      navigation: {
        ...current.navigation,
        personal: {
          ...current.navigation.personal,
          memory: []
        }
      }
    });
    const processing = {
      id: localSessionId,
      logicalMemoryId,
      title: "Local Captured Session",
      projectName: "koed",
      updatedAt: at,
      preview: "2 Memory Events",
      eventCount: 2,
      hasSynchronizedRevision: false,
      syncState: "processing" as const
    };
    const client = createClient(snapshot);
    vi.mocked(client.previewSharedMemoryCandidate).mockResolvedValue({
      sessionId: localSessionId,
      logicalMemoryId,
      representation: "memory_events",
      sourceRevision: 2,
      candidateHash: "c".repeat(64),
      itemCount: 1,
      excludedItemCount: 0,
      manifest: candidateManifestFor("memory_events"),
      byteCount: 128,
      items: [sourceItem("memory_events")]
    });
    let resolveAuthoritativePreview!: (value: SharedMemoryPreview) => void;
    const authoritativePreview = new Promise<SharedMemoryPreview>((resolve) => {
      resolveAuthoritativePreview = resolve;
    });
    vi.mocked(client.previewSharedMemory).mockReturnValue(authoritativePreview);
    const modal = {
      kind: "share_personal_memory" as const,
      sessionId: localSessionId,
      localEntry: {
        ...processing,
        logicalMemoryId: null,
        syncState: "not_started" as const
      }
    };
    const markdownAdapters = {
      openExternal: vi.fn(async () => undefined),
      writeClipboard: vi.fn(async () => undefined)
    };
    const onViewShare = vi.fn();

    await act(async () =>
      root.render(
        <CollaborationModalLayer
          client={client}
          markdownAdapters={markdownAdapters}
          modal={modal}
          onModalChange={vi.fn()}
          onViewShare={onViewShare}
          snapshot={snapshot}
        />
      )
    );

    await click(container, "Rename Share");
    const titleInput = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Share name"]'
    );
    expect(titleInput).not.toBeNull();
    await act(async () => setValue(titleInput!, "Launch review"));
    await click(container, "Save Share name");
    expect(document.body.textContent).toContain("Launch review");

    await click(container, "Review");

    await vi.waitFor(() => {
      expect(
        document.body.querySelector(".collab-preview-list")
      ).not.toBeNull();
    });
    const previewList = document.body.querySelector(".collab-preview-list");
    const pendingConsentButton = document.body.querySelector<HTMLButtonElement>(
      ".collab-consent-action"
    );
    expect(
      document.body.querySelector(".collab-share-preview-status")
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Checking sharing destination"
    );
    expect(document.body.textContent).not.toContain("Local candidate ready");
    expect(previewList).not.toBeNull();
    expect(pendingConsentButton).toBeDefined();
    expect(pendingConsentButton?.disabled).toBe(true);
    expect(pendingConsentButton?.textContent).toBe("");
    expect(pendingConsentButton?.getAttribute("aria-busy")).toBe("true");
    expect(pendingConsentButton?.querySelector(".collab-spin")).not.toBeNull();
    expect(client.prepareSharedMemorySource).not.toHaveBeenCalled();
    expect(client.previewSharedMemory).toHaveBeenCalledTimes(1);
    expect(client.previewSharedMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalMemoryId,
        candidate: expect.objectContaining({
          sessionId: localSessionId,
          candidateHash: "c".repeat(64)
        })
      })
    );
    await act(async () =>
      resolveAuthoritativePreview({
        logicalMemoryId,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["memory_events"],
        previewRevision: 1,
        sourceRevision: 2,
        policyRevision: 1,
        contentPolicyVersion: 1,
        classifierVersion: 1,
        redactedContentHash: "a".repeat(64),
        previewHash: "b".repeat(64),
        itemCount: 1,
        items: [sourceItem("memory_events")],
        nextCursor: null
      })
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Share")
    );
    const readyConsentButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.trim() === "Share");
    expect(readyConsentButton?.disabled).toBe(false);
    expect(readyConsentButton?.getAttribute("aria-busy")).toBeNull();
    expect(readyConsentButton?.querySelector(".collab-spin")).toBeNull();
    expect(
      document.body.querySelector(".collab-share-preview-status")
    ).toBeNull();

    let resolveSnapshotPreview!: (value: SharedMemoryPreview) => void;
    vi.mocked(client.previewSharedMemory).mockReturnValueOnce(
      new Promise<SharedMemoryPreview>((resolve) => {
        resolveSnapshotPreview = resolve;
      })
    );
    const snapshotRadio = Array.from(
      document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    ).find((input) => input.parentElement?.textContent?.includes("revision"));
    expect(snapshotRadio).toBeDefined();
    await act(async () => snapshotRadio?.click());
    await vi.waitFor(() =>
      expect(client.previewSharedMemory).toHaveBeenLastCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({ mode: "snapshot" })
        })
      )
    );
    expect(
      document.body.querySelector<HTMLButtonElement>(".collab-consent-action")
        ?.textContent
    ).toBe("");
    await act(async () =>
      resolveSnapshotPreview({
        logicalMemoryId,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["memory_events"],
        previewRevision: 2,
        sourceRevision: 2,
        policyRevision: 1,
        contentPolicyVersion: 1,
        classifierVersion: 1,
        redactedContentHash: "a".repeat(64),
        previewHash: "d".repeat(64),
        itemCount: 1,
        items: [sourceItem("memory_events")],
        nextCursor: null
      })
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Share")
    );
    await click(container, "Share");
    expect(client.shareMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "snapshot",
        title: "Launch review",
        previewHash: "d".repeat(64)
      })
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Share complete")
    );
    expect(
      document.body.querySelector(".collab-share-complete-icon")
    ).not.toBeNull();
    expect(
      document.body.querySelector('button[aria-label="Rename Share"]')
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Not shared yet.");
    await click(container, "View share");
    expect(onViewShare).toHaveBeenCalledWith(`grant:${ids.grant}`);
  });

  it("does not send when Enter confirms an IME composition", async () => {
    const client = await render();
    const textarea = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message Notes to self"]'
    )!;
    await act(async () => setValue(textarea, "変換中"));
    expect(document.body.textContent).not.toContain(
      "Personal · Private to you"
    );
    expect(document.body.textContent).not.toContain("32,768 UTF-8 bytes");
    await act(async () => {
      textarea.dispatchEvent(
        new CompositionEvent("compositionstart", {
          bubbles: true,
          data: "変換中"
        })
      );
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          isComposing: true,
          key: "Enter"
        })
      );
    });
    expect(client.sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      textarea.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: "変換中"
        })
      );
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter"
        })
      );
    });
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
  });

  it("keeps per-thread drafts but purges the current draft on a same-thread canPost downgrade", async () => {
    const client = await render();
    const notesComposer = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message Notes to self"]'
    )!;
    await act(async () => setValue(notesComposer, "Personal draft"));

    await click(container, "research");
    const researchComposer = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message research"]'
    )!;
    await act(async () => setValue(researchComposer, "Research draft"));
    await click(container, "Notes to self");
    expect(
      document.body.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message Notes to self"]'
      )?.value
    ).toBe("Personal draft");

    const current = baseSnapshot();
    const readOnlyNotes = { ...notes(), canPost: false };
    await act(async () =>
      client.emit({
        ...current,
        navigation: {
          ...current.navigation,
          personal: {
            ...current.navigation.personal,
            notesToSelf: readOnlyNotes
          }
        },
        selection: { kind: "notes_to_self" },
        view: {
          kind: "thread",
          thread: readOnlyNotes,
          messages:
            current.view.kind === "thread"
              ? current.view.messages
              : page(ids.notes)
        }
      })
    );
    const downgradedComposer = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message Notes to self"]'
    )!;
    expect(downgradedComposer.disabled).toBe(true);
    expect(downgradedComposer.value).toBe("");
  });

  it("renders a long collaboration thread through the bounded ChatTimeline route", async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      ...message(
        uuid(1_000 + index),
        ids.notes,
        `Long thread message ${index + 1}`,
        mark
      ),
      sequence: index + 1
    }));
    const selected = baseSnapshot();
    const longNotes = { ...notes(), latestSequence: messages.length };
    const client = createClient(
      collaborationSnapshotSchema.parse({
        ...selected,
        navigation: {
          ...selected.navigation,
          personal: {
            ...selected.navigation.personal,
            notesToSelf: longNotes
          }
        },
        view: {
          kind: "thread",
          thread: longNotes,
          messages: page(ids.notes, messages)
        }
      })
    );
    await render(client);

    expect(
      container
        .querySelector(".collab-message-history")
        ?.getAttribute("data-rendered-count")
    ).toBe("100");
    expect(document.body.textContent).toContain("Long thread message 100");
  });

  it("renders sender receipts as sent, delivered to everyone, and read by everyone", async () => {
    const messages = (["sent", "delivered", "read"] as const).map(
      (recipientStatus, index) => ({
        ...message(
          uuid(1_200 + index),
          ids.notes,
          `Receipt ${recipientStatus}`,
          mark
        ),
        sequence: index + 1,
        recipientStatus
      })
    );
    const selected = baseSnapshot();
    const receiptNotes = { ...notes(), latestSequence: messages.length };
    await render(
      createClient(
        collaborationSnapshotSchema.parse({
          ...selected,
          navigation: {
            ...selected.navigation,
            personal: {
              ...selected.navigation.personal,
              notesToSelf: receiptNotes
            }
          },
          view: {
            kind: "thread",
            thread: receiptNotes,
            messages: page(ids.notes, messages)
          }
        })
      )
    );

    expect(document.querySelectorAll('[aria-label="Sent"]')).toHaveLength(1);
    expect(
      document.querySelectorAll('[aria-label="Delivered to everyone"]')
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('[aria-label="Read by everyone"]')
    ).toHaveLength(1);
    expect(
      document.querySelector('.collab-recipient-status[data-status="read"]')
    ).not.toBeNull();
  });

  it("replaces Team and Workspace content for suspended, deleting, revoked, and archived lifecycles", async () => {
    const selected = viewFor(baseSnapshot(), {
      kind: "workspace_channel",
      teamId: ids.team,
      workspaceId: ids.workspace,
      threadId: ids.channel
    });
    const withTeamLifecycle = (
      lifecycle: "active" | "suspended" | "deletion_requested" | "purged"
    ): CollaborationSnapshot => ({
      ...selected,
      navigation: {
        ...selected.navigation,
        teams: selected.navigation.teams.map((team) =>
          team.id === ids.team ? { ...team, lifecycle } : team
        )
      }
    });
    const client = await render(createClient(withTeamLifecycle("suspended")));
    expect(document.body.textContent).toContain("Personal");
    expect(document.body.textContent).not.toContain(
      "Welcome to Atlas Research."
    );

    await act(async () => client.emit(withTeamLifecycle("deletion_requested")));
    expect(document.body.textContent).toContain("Personal");
    expect(document.body.textContent).not.toContain(
      "Welcome to Atlas Research."
    );

    await act(async () => client.emit(withTeamLifecycle("purged")));
    expect(
      document.body.querySelector('button[title="Atlas Research"]')
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Welcome to Atlas Research."
    );

    const active = withTeamLifecycle("active");
    await act(async () =>
      client.emit({
        ...active,
        navigation: {
          ...active.navigation,
          teams: active.navigation.teams.map((team) =>
            team.id === ids.team
              ? {
                  ...team,
                  workspaces: team.workspaces.map((workspace) =>
                    workspace.id === ids.workspace
                      ? { ...workspace, lifecycle: "archived" as const }
                      : workspace
                  )
                }
              : team
          )
        }
      })
    );
    expect(document.body.textContent).toContain("Personal");
    expect(document.body.textContent).not.toContain(
      "Welcome to Atlas Research."
    );
  });

  it("marks a narrow Shared Memory discussion read only after its tab is visible", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(max-width: 900px)",
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn()
        }) as MediaQueryList
    );
    const selected = viewFor(baseSnapshot(), {
      kind: "shared_session",
      teamId: ids.team,
      workspaceId: ids.workspace,
      sharedSessionId: ids.eventSession
    });
    if (selected.view.kind !== "shared_session") {
      throw new Error("Expected shared session fixture");
    }
    const client = await render(
      createClient(
        collaborationSnapshotSchema.parse({
          ...selected,
          view: {
            ...selected.view,
            session: { ...selected.view.session, unreadCompanionCount: 2 },
            companion: {
              ...selected.view.companion,
              thread: { ...selected.view.companion.thread, unreadCount: 2 }
            }
          }
        })
      )
    );

    expect(client.markRead).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>("#collab-shared-discussion-tab")!
        .click()
    );
    await vi.waitFor(() => expect(client.markRead).toHaveBeenCalledTimes(1));
    expect(client.markRead).toHaveBeenCalledWith({
      thread: { scope: "team", teamId: ids.team, threadId: ids.discussion },
      messageId: uuid(403)
    });
  });
});
