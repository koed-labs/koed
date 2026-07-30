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
  type PersonalDesktopApi,
  type SharedMemoryRepresentation,
  type SharedMemorySession,
  type SharedMemorySourceItem
} from "@koed/shared";
import { act, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CollaborationClientListener,
  CollaborationClientUpdate,
  CollaborationRendererClient
} from "./collaboration/renderer-client.js";
import { CollaborationClientError } from "./collaboration/renderer-client.js";
import { App } from "./renderer/App.js";
import { CollaborationRoutes } from "./renderer/collaboration/CollaborationRoutes.js";
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
    SecureMarkdown: ({
      className,
      source
    }: {
      className?: string;
      source: string;
    }) => <p className={className}>{source}</p>,
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
            sourceKind: "tool_result",
            occurredAt: at,
            body: "Typecheck completed without errors.",
            actorName: "Codex",
            toolName: "typecheck",
            toolCallId: "call-typecheck-correlation"
          }
        ]
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
        sourceCount: representation === "lcm_leaves" ? 14 : 38,
        sourceRevision: revision
      };

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
    prepareSharedMemorySource: vi.fn(
      async () => current.navigation.personal.memory[0]!
    ),
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
    consentSharedMemory: vi.fn(async (input) => ({
      id: input.consentId,
      logicalMemoryId: input.logicalMemoryId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      mode: input.mode,
      state: "active" as const,
      version: 1,
      allowedRepresentations: input.allowedRepresentations,
      selectedRepresentation: input.selectedRepresentation,
      previewRevision: input.previewRevision,
      previewHash: input.previewHash,
      sourceRevision: 12,
      createdAt: at,
      updatedAt: at,
      activatedAt: at,
      revokedAt: null
    })),
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
    }
  };
  return client;
};

const click = async (container: HTMLElement, label: string) => {
  const button = [...document.body.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
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
      explorer: {
        ...component(state),
        url: "http://127.0.0.1:3300/explorer"
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
      explorer: { ...starting, url: "http://127.0.0.1:3300/explorer" },
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
    expect(document.body.textContent).not.toContain("Create Workspace");
    expect(document.body.textContent).not.toContain("Pending invitations");
    expect(
      document.body.querySelector('select[aria-label^="Role for"]')
    ).toBeNull();
    expect(
      document.body.querySelector('select[aria-label*="access for"]')
    ).toBeNull();
    expect(client.listInvitations).not.toHaveBeenCalled();

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
    ).toContain("offline");
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

  it("does not send when Enter confirms an IME composition", async () => {
    const client = await render();
    const textarea = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message Notes to self"]'
    )!;
    await act(async () => setValue(textarea, "変換中"));
    expect(document.body.textContent).toContain("Personal · Private to you");
    expect(
      document.body.querySelector('[aria-label="9 of 32,768 UTF-8 bytes"]')
    ).not.toBeNull();
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
    expect(document.body.textContent).toContain("Personal · Private to you");
    expect(document.body.textContent).not.toContain(
      "Welcome to Atlas Research."
    );

    await act(async () => client.emit(withTeamLifecycle("deletion_requested")));
    expect(document.body.textContent).toContain("Personal · Private to you");
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
    expect(document.body.textContent).toContain("Personal · Private to you");
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
