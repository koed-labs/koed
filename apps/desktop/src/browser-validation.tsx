import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationRendererEventSchema,
  collaborationSafeErrorMessages,
  collaborationSnapshotSchema,
  type CollaborationCommandResult,
  type CollaborationRendererEvent,
  type CollaborationRendererCommand,
  type CollaborationSnapshot
} from "@koed/shared/collaboration";
import type {
  PersonalDesktopApi,
  PersonalDesktopConversationEvent,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { VirtualizedTimeline } from "@koed/memory-ui";
import { Profiler, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";

import { createCollaborationRendererClient } from "./collaboration/renderer-client.js";
import { App } from "./renderer/App.js";
import "./renderer/index.css";

const uuid = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const timestamp = "2099-01-02T09:38:00.000Z";
const revision = "snapshot.revision-browser-0001";
const maxName = (prefix: string, index: number) =>
  `${prefix} ${index} ${"coordination-".repeat(8)}`.slice(
    0,
    COLLABORATION_DEFAULT_LIMITS.nameMaxNormalizedCodePoints
  );
const maxDisplayName = (prefix: string) =>
  `${prefix} ${"collaboration-".repeat(10)}`.slice(
    0,
    COLLABORATION_DEFAULT_LIMITS.displayNameMaxNormalizedCodePoints
  );

const personalThread: PersonalDesktopProjectThread = {
  id: "browser-thread",
  name: "Captured Session title deliberately long enough to verify overflow handling",
  sessionId: uuid(1),
  sourceAiClient: "codex-cli",
  projectId: "browser-project",
  projectName: "Koed Desktop browser validation",
  projectPath: "/private/operator/koed",
  projectAssignmentSource: "detected",
  eventCount: 10_000,
  invalidatedCount: 1,
  latestAt: timestamp,
  sample:
    "Captured Session preview used for browser-computed layout validation."
};

const personalProject: PersonalDesktopProject = {
  id: "browser-project",
  name: "Koed Desktop browser validation",
  path: "/private/operator/koed",
  eventCount: 10_000,
  threads: [personalThread]
};

const personalEvents: PersonalDesktopConversationEvent[] = Array.from(
  { length: 500 },
  (_, index) => ({
    actor: index % 2 === 0 ? "user" : "assistant",
    content: `Browser validation Memory Event ${index + 1}`,
    contentPreview: `Browser validation Memory Event ${index + 1}`,
    eventType: index === 4 ? "tool_call" : "message",
    id: uuid(700 + index),
    invalidatedAt: index === 5 ? timestamp : null,
    metadata:
      index === 4
        ? { toolName: "exec_command", input: { cmd: "pnpm test" } }
        : {},
    sourceEventTime: timestamp,
    sourceSequence: index + 1,
    timestamp
  })
);

const personalMemoryApi: PersonalDesktopApi = {
  assignSessionProject: async () => ({ projectId: personalProject.id }),
  listProjects: async () => [personalProject],
  loadEventPage: async () => personalEvents,
  subscribe: () => () => undefined
};

const ValidationApp = () => {
  const client = useMemo(
    () =>
      createCollaborationRendererClient({
        command: async (command) => resultFor(command, collaborationFixture()),
        subscribe: () => () => undefined
      }),
    []
  );
  useEffect(() => {
    document.documentElement.dataset.browserValidationReady = "true";
    return () => client.dispose();
  }, [client]);
  return (
    <App
      collaborationClient={client}
      onboardingComplete
      personalMemoryApi={personalMemoryApi}
      statusReadyOverride
    />
  );
};

const collaborationFixture = (): CollaborationSnapshot => {
  const currentUser = {
    id: uuid(10),
    displayName: maxDisplayName("Mark"),
    presence: "available" as const,
    membershipState: "enabled" as const
  };
  const teammate = {
    id: uuid(11),
    displayName: maxDisplayName("Alice Chen"),
    presence: "available" as const,
    membershipState: "enabled" as const
  };
  const teamPrincipal = {
    ...currentUser,
    id: uuid(23)
  };
  const participant = (person: typeof currentUser) => ({
    id: person.id,
    displayName: person.displayName,
    membershipState: person.membershipState
  });
  const baseThread = {
    name: null,
    topic: null,
    version: 1,
    lifecycle: "active" as const,
    canPost: true,
    latestSequence: 1,
    unreadCount: 0,
    lastReadMessageId: null,
    lastReadSequence: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    archivedAt: null
  };
  const notes = {
    ...baseThread,
    id: uuid(12),
    logicalId: uuid(13),
    scope: "personal" as const,
    ownerUserId: currentUser.id,
    kind: "notes_to_self" as const,
    latestSequence: 2,
    unreadCount: 2,
    participants: [participant(currentUser)]
  };
  const channel = {
    ...baseThread,
    id: uuid(14),
    logicalId: uuid(15),
    scope: "team" as const,
    teamId: uuid(16),
    workspaceId: uuid(17),
    kind: "workspace_channel" as const,
    name: "memory-quality",
    topic: "Review shared memory quality"
  };
  const discussion = {
    ...baseThread,
    id: uuid(18),
    logicalId: uuid(19),
    scope: "team" as const,
    teamId: uuid(16),
    workspaceId: uuid(17),
    kind: "shared_session_discussion" as const,
    sharedLogicalMemoryId: uuid(20),
    shareGrantId: uuid(21),
    latestSequence: 2
  };
  const session = {
    id: uuid(21),
    logicalMemoryId: uuid(20),
    shareGrantId: uuid(21),
    teamId: uuid(16),
    workspaceId: uuid(17),
    owner: participant(currentUser),
    title: "Collaboration renderer cutover",
    latestActivityAt: timestamp,
    representation: "memory_events" as const,
    representationState: "current" as const,
    liveState: "live" as const,
    sourceState: "ready" as const,
    sourceRevision: revision,
    companionThreadId: discussion.id,
    unreadCompanionCount: 0,
    version: 1
  };
  const page = (threadId: string, items: unknown[] = []) => ({
    snapshotRevision: revision,
    olderCursor: null,
    newerCursor: null,
    hasOlder: false,
    hasNewer: false,
    threadId,
    items
  });
  const teams = Array.from({ length: 50 }, (_, teamIndex) => {
    const teamId = teamIndex === 0 ? uuid(16) : uuid(500_000 + teamIndex);
    const workspaces = Array.from({ length: 20 }, (_, workspaceIndex) => {
      const workspaceId =
        teamIndex === 0 && workspaceIndex === 0
          ? uuid(17)
          : uuid(400_000 + teamIndex * 100 + workspaceIndex);
      const channels = Array.from({ length: 50 }, (_, channelIndex) => {
        if (teamIndex === 0 && workspaceIndex === 0 && channelIndex === 0) {
          return channel;
        }
        const channelBase =
          100_000 + teamIndex * 5_000 + workspaceIndex * 200 + channelIndex * 2;
        return {
          ...baseThread,
          id: uuid(channelBase),
          logicalId: uuid(channelBase + 1),
          scope: "team" as const,
          teamId,
          workspaceId,
          kind: "workspace_channel" as const,
          name: maxName("channel", channelIndex + 1),
          topic: "Maximum-size navigation validation"
        };
      });
      return {
        id: workspaceId,
        name: maxName("Workspace", workspaceIndex + 1),
        description: "Maximum-size Workspace navigation validation",
        access: "write" as const,
        lifecycle: "active" as const,
        version: 1,
        channels,
        sharedMemory: teamIndex === 0 && workspaceIndex === 0 ? [session] : []
      };
    });
    return {
      id: teamId,
      name: maxName("Koed Team", teamIndex + 1),
      role: "owner" as const,
      lifecycle: "active" as const,
      unreadCount: teamIndex % 7 === 0 ? 3 : 0,
      people: [teamPrincipal, teammate],
      directMessages: [],
      workspaces,
      version: 1
    };
  });
  return collaborationSnapshotSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    snapshotRevision: revision,
    generatedAt: timestamp,
    connection: {
      state: "live",
      backendId: "up_browser_team",
      connectedAt: timestamp,
      retryAt: null,
      reconnectAttempt: 0,
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    },
    limits: COLLABORATION_DEFAULT_LIMITS,
    navigation: {
      personalOwner: currentUser,
      teamPrincipal,
      personal: { memory: [], notesToSelf: notes, channels: [] },
      teams
    },
    selection: {
      kind: "shared_session",
      teamId: uuid(16),
      workspaceId: uuid(17),
      sharedSessionId: session.id
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
        sharedSessionId: session.id,
        representation: "memory_events",
        items: [
          {
            id: uuid(23),
            representation: "memory_events",
            sequence: 1,
            occurredAt: timestamp,
            sourceItems: [
              {
                id: uuid(24),
                sourceKind: "agent_message",
                occurredAt: timestamp,
                body: "The target renderer now consumes the strict shared collaboration contract.",
                actorName: maxDisplayName("Codex"),
                toolName: null,
                toolCallId: null
              }
            ]
          }
        ]
      },
      companion: {
        thread: discussion,
        messages: page(discussion.id, [
          {
            id: uuid(25),
            threadId: discussion.id,
            scope: "team",
            teamId: uuid(16),
            sequence: 1,
            sender: participant(teammate),
            senderKind: "user",
            body: "The access-boundary checks are ready for review.",
            createdAt: timestamp,
            updatedAt: timestamp,
            editedAt: null,
            deletedAt: null,
            delivery: "sent",
            recipientStatus: "sent",
            failure: null
          },
          {
            id: uuid(26),
            threadId: discussion.id,
            scope: "team",
            teamId: uuid(16),
            sequence: 2,
            sender: participant(teamPrincipal),
            senderKind: "user",
            body: "Receipt state is visible without exposing per-recipient activity.",
            createdAt: timestamp,
            updatedAt: timestamp,
            editedAt: null,
            deletedAt: null,
            delivery: "sent",
            recipientStatus: "read",
            failure: null
          }
        ])
      }
    }
  });
};

const resultFor = (
  command: CollaborationRendererCommand,
  snapshot: CollaborationSnapshot
) => {
  const data =
    command.command === "collaboration.load" ||
    command.command === "collaboration.select" ||
    command.command === "collaboration.reconnect_backend" ||
    command.command === "collaboration.disconnect_backend"
      ? { snapshot }
      : command.command === "collaboration.subscribe"
        ? {
            subscription: {
              id: uuid(command.input.scope.scope === "personal" ? 30 : 31),
              scope: command.input.scope,
              state: "active",
              version: 1,
              expiresAt: "2099-01-02T10:38:00.000Z"
            }
          }
        : command.command === "collaboration.acknowledge_delivery"
          ? {
              subscriptionId: command.input.subscriptionId,
              acknowledgedEventId: command.input.eventId,
              subscriptionVersion: command.input.expectedSubscriptionVersion + 1
            }
          : {};
  return collaborationCommandResultSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: command.requestId,
    command: command.command,
    ok: true,
    data
  });
};

const ChatValidationApp = () => {
  const client = useMemo(() => {
    const snapshot = collaborationFixture();
    return createCollaborationRendererClient({
      command: async (command) => {
        const browserWindow = window as Window & {
          __koedBrowserCommandCount?: number;
        };
        browserWindow.__koedBrowserCommandCount =
          (browserWindow.__koedBrowserCommandCount ?? 0) + 1;
        if (command.command === "collaboration.select") {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          );
        }
        return resultFor(command, snapshot);
      },
      subscribe: () => () => undefined
    });
  }, []);
  useEffect(() => {
    document.documentElement.dataset.browserValidationReady = "true";
    return () => client.dispose();
  }, [client]);
  return (
    <Profiler
      id="browser-validation-app"
      onRender={(_id, phase, actualDuration) => {
        const browserWindow = window as Window & {
          __koedRenderProfiles?: Array<{
            actualDuration: number;
            phase: string;
          }>;
        };
        browserWindow.__koedRenderProfiles ??= [];
        browserWindow.__koedRenderProfiles.push({ actualDuration, phase });
      }}
    >
      <App
        collaborationClient={client}
        initialCollaborationSelection={collaborationFixture().selection}
        onboardingComplete
        statusReadyOverride
      />
    </Profiler>
  );
};

type StatefulActor = "alice" | "bob";

const interactionIds = {
  alice: uuid(101),
  bob: uuid(102),
  alicePersonal: uuid(103),
  bobPersonal: uuid(104),
  alphaTeam: uuid(110),
  alphaWorkspace: uuid(111),
  alphaChannel: uuid(112),
  alphaChannelLogical: uuid(113),
  alphaDm: uuid(114),
  alphaDmLogical: uuid(115),
  alphaSession: uuid(118),
  alphaMemory: uuid(117),
  alphaGrant: uuid(118),
  alphaDiscussion: uuid(119),
  alphaDiscussionLogical: uuid(120),
  betaTeam: uuid(121),
  betaWorkspace: uuid(122),
  betaChannel: uuid(123),
  betaChannelLogical: uuid(124),
  betaSession: uuid(127),
  betaMemory: uuid(126),
  betaGrant: uuid(127),
  betaDiscussion: uuid(128),
  betaDiscussionLogical: uuid(129),
  aliceNotes: uuid(130),
  bobNotes: uuid(131),
  actionGrant: uuid(140),
  personalSubscription: uuid(141),
  alphaSubscription: uuid(142),
  betaSubscription: uuid(143)
} as const;

const interactionPerson = (actor: StatefulActor) => ({
  id: interactionIds[actor],
  displayName: actor === "alice" ? "Alice Nguyen" : "Bob Chen",
  presence: "available" as const,
  membershipState: "enabled" as const
});

const interactionParticipant = (actor: StatefulActor) => {
  const person = interactionPerson(actor);
  return {
    id: person.id,
    displayName: person.displayName,
    membershipState: person.membershipState
  };
};

const interactionThreadBase = {
  name: null,
  topic: null,
  version: 1,
  lifecycle: "active" as const,
  canPost: true,
  latestSequence: 1,
  unreadCount: 0,
  lastReadMessageId: null,
  lastReadSequence: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastActivityAt: timestamp,
  archivedAt: null
};

const interactionChannel = (team: "alpha" | "beta") => ({
  ...interactionThreadBase,
  id:
    team === "alpha" ? interactionIds.alphaChannel : interactionIds.betaChannel,
  logicalId:
    team === "alpha"
      ? interactionIds.alphaChannelLogical
      : interactionIds.betaChannelLogical,
  scope: "team" as const,
  teamId: team === "alpha" ? interactionIds.alphaTeam : interactionIds.betaTeam,
  workspaceId:
    team === "alpha"
      ? interactionIds.alphaWorkspace
      : interactionIds.betaWorkspace,
  kind: "workspace_channel" as const,
  name: team === "alpha" ? "product" : "cloud-api",
  topic:
    team === "alpha"
      ? "Electron collaboration delivery"
      : "Cloud memory contracts"
});

const interactionDm = {
  ...interactionThreadBase,
  id: interactionIds.alphaDm,
  logicalId: interactionIds.alphaDmLogical,
  scope: "team" as const,
  teamId: interactionIds.alphaTeam,
  kind: "dm" as const,
  participants: [interactionParticipant("alice"), interactionParticipant("bob")]
};

const interactionDiscussion = (team: "alpha" | "beta") => ({
  ...interactionThreadBase,
  id:
    team === "alpha"
      ? interactionIds.alphaDiscussion
      : interactionIds.betaDiscussion,
  logicalId:
    team === "alpha"
      ? interactionIds.alphaDiscussionLogical
      : interactionIds.betaDiscussionLogical,
  scope: "team" as const,
  teamId: team === "alpha" ? interactionIds.alphaTeam : interactionIds.betaTeam,
  workspaceId:
    team === "alpha"
      ? interactionIds.alphaWorkspace
      : interactionIds.betaWorkspace,
  kind: "shared_session_discussion" as const,
  sharedLogicalMemoryId:
    team === "alpha" ? interactionIds.alphaMemory : interactionIds.betaMemory,
  shareGrantId:
    team === "alpha" ? interactionIds.alphaGrant : interactionIds.betaGrant
});

const interactionSession = (team: "alpha" | "beta") => ({
  id:
    team === "alpha" ? interactionIds.alphaSession : interactionIds.betaSession,
  logicalMemoryId:
    team === "alpha" ? interactionIds.alphaMemory : interactionIds.betaMemory,
  shareGrantId:
    team === "alpha" ? interactionIds.alphaGrant : interactionIds.betaGrant,
  teamId: team === "alpha" ? interactionIds.alphaTeam : interactionIds.betaTeam,
  workspaceId:
    team === "alpha"
      ? interactionIds.alphaWorkspace
      : interactionIds.betaWorkspace,
  owner: interactionParticipant(team === "alpha" ? "bob" : "alice"),
  title:
    team === "alpha"
      ? "Workspace Memory Timeline UX"
      : "Flat User-Owned Memory Model",
  latestActivityAt: timestamp,
  representation:
    team === "alpha" ? ("memory_events" as const) : ("lcm_rollups" as const),
  representationState: "current" as const,
  liveState: "live" as const,
  sourceState: "ready" as const,
  sourceRevision: `${revision}-${team}`,
  companionThreadId:
    team === "alpha"
      ? interactionIds.alphaDiscussion
      : interactionIds.betaDiscussion,
  unreadCompanionCount: 0,
  version: 1
});

const interactionMessage = (
  threadId: string,
  teamId: string,
  actor: StatefulActor,
  body: string,
  sequence: number,
  id = uuid(200 + sequence)
) => ({
  id,
  threadId,
  scope: "team" as const,
  teamId,
  sequence,
  sender: interactionParticipant(actor),
  senderKind: "user" as const,
  body,
  createdAt: timestamp,
  updatedAt: timestamp,
  editedAt: null,
  deletedAt: null,
  delivery: "sent" as const,
  recipientStatus: "sent" as const,
  failure: null
});

const interactionPage = (
  threadId: string,
  items: ReturnType<typeof interactionMessage>[]
) => ({
  snapshotRevision: revision,
  olderCursor: null,
  newerCursor: null,
  hasOlder: false,
  hasNewer: false,
  threadId,
  items
});

const createStatefulCollaborationBridge = (actor: StatefulActor) => {
  let connection: CollaborationSnapshot["connection"] = {
    state: "live",
    backendId: "up_browser_team",
    connectedAt: timestamp,
    retryAt: null,
    reconnectAttempt: 0,
    protocolVersion: COLLABORATION_CONTRACT_VERSION
  };
  let selection: CollaborationSnapshot["selection"] = {
    kind: "shared_session",
    teamId: interactionIds.alphaTeam,
    workspaceId: interactionIds.alphaWorkspace,
    sharedSessionId: interactionIds.alphaSession
  };
  let listener: ((event: CollaborationRendererEvent) => void) | null = null;
  let messageSequence = 10;
  let invitationSequence = 0;
  let deliverySequence = 0;
  const acceptedInvitations = new Set<string>();
  const invitations: Array<{
    id: string;
    teamId: string;
    defaultWorkspaceId: string;
    defaultWorkspaceAccess: "read" | "write";
    email: string;
    role: "owner" | "admin" | "member";
    lifecycle: "pending" | "accepted" | "revoked" | "expired";
    version: number;
    createdAt: string;
    expiresAt: string;
    acceptedAt: string | null;
    revokedAt: string | null;
  }> = [];
  const messages = new Map<string, ReturnType<typeof interactionMessage>[]>([
    [
      interactionIds.alphaChannel,
      [
        interactionMessage(
          interactionIds.alphaChannel,
          interactionIds.alphaTeam,
          "bob",
          "Product channel baseline from Bob.",
          1,
          uuid(201)
        )
      ]
    ],
    [
      interactionIds.alphaDm,
      [
        interactionMessage(
          interactionIds.alphaDm,
          interactionIds.alphaTeam,
          "bob",
          "DM baseline from Bob.",
          1,
          uuid(202)
        )
      ]
    ],
    [
      interactionIds.alphaDiscussion,
      [
        interactionMessage(
          interactionIds.alphaDiscussion,
          interactionIds.alphaTeam,
          "alice",
          "Timeline source is ready for discussion.",
          1,
          uuid(203)
        )
      ]
    ],
    [interactionIds.betaChannel, []],
    [interactionIds.betaDiscussion, []]
  ]);
  const presencePreferences = new Map<
    string,
    {
      mode: "auto" | "manual";
      manualStatus: "available" | "do_not_disturb" | "out_of_office";
      preferenceVersion: number;
    }
  >();

  const managedPerson = (
    personActor: StatefulActor,
    team: "alpha" | "beta"
  ) => {
    const person = interactionPerson(personActor);
    const workspaceId =
      team === "alpha"
        ? interactionIds.alphaWorkspace
        : interactionIds.betaWorkspace;
    const presenceKey = `${team}:${personActor}`;
    const preference = presencePreferences.get(presenceKey) ?? {
      mode: personActor === "alice" ? ("auto" as const) : ("manual" as const),
      manualStatus:
        personActor === "alice"
          ? ("available" as const)
          : ("out_of_office" as const),
      preferenceVersion: personActor === "alice" ? 1 : 2
    };
    presencePreferences.set(presenceKey, preference);
    return {
      ...person,
      teamPresence:
        preference.mode === "auto"
          ? {
              mode: "auto" as const,
              manualStatus: preference.manualStatus,
              activityLevel: "active" as const,
              lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
              nextTransitionAt: new Date(Date.now() + 4 * 60_000).toISOString(),
              preferenceVersion: preference.preferenceVersion
            }
          : {
              mode: "manual" as const,
              manualStatus: preference.manualStatus,
              activityLevel: null,
              lastActivityAt: null,
              nextTransitionAt: null,
              preferenceVersion: preference.preferenceVersion
            },
      management: {
        membershipId: uuid(
          (team === "alpha" ? 400 : 410) + (personActor === "alice" ? 1 : 2)
        ),
        email: `${personActor}@example.test`,
        role:
          personActor === "alice" && team === "alpha"
            ? ("owner" as const)
            : ("member" as const),
        status: "enabled" as const,
        version: 1,
        workspaceAccess: [
          {
            workspaceId,
            userId: person.id,
            access: "write" as const,
            version: 1
          }
        ]
      }
    };
  };

  const teams = () => [
    {
      id: interactionIds.alphaTeam,
      name: "Electron Team App",
      role: actor === "alice" ? ("owner" as const) : ("member" as const),
      lifecycle: "active" as const,
      unreadCount: 0,
      membershipVersion: 1,
      people: [managedPerson("alice", "alpha"), managedPerson("bob", "alpha")],
      directMessages: [interactionDm],
      workspaces: [
        {
          id: interactionIds.alphaWorkspace,
          name: "Electron Team App",
          description: "Desktop collaboration validation",
          access: "write" as const,
          lifecycle: "active" as const,
          version: 1,
          channels: [interactionChannel("alpha")],
          sharedMemory: [interactionSession("alpha")]
        }
      ],
      version: 1
    },
    {
      id: interactionIds.betaTeam,
      name: "Cloud Memory Platform",
      role: "member" as const,
      lifecycle: "active" as const,
      unreadCount: 0,
      membershipVersion: 1,
      people: [managedPerson("alice", "beta"), managedPerson("bob", "beta")],
      directMessages: [],
      workspaces: [
        {
          id: interactionIds.betaWorkspace,
          name: "Cloud Memory Platform",
          description: "Cloud contract validation",
          access: "write" as const,
          lifecycle: "active" as const,
          version: 1,
          channels: [interactionChannel("beta")],
          sharedMemory: [interactionSession("beta")]
        }
      ],
      version: 1
    }
  ];

  const snapshot = (): CollaborationSnapshot => {
    const currentActor = {
      ...interactionPerson(actor),
      id:
        actor === "alice"
          ? interactionIds.alicePersonal
          : interactionIds.bobPersonal
    };
    const notesId =
      actor === "alice" ? interactionIds.aliceNotes : interactionIds.bobNotes;
    const notes = {
      ...interactionThreadBase,
      id: notesId,
      logicalId: uuid(actor === "alice" ? 150 : 151),
      scope: "personal" as const,
      ownerUserId: currentActor.id,
      kind: "notes_to_self" as const,
      participants: [
        {
          id: currentActor.id,
          displayName: currentActor.displayName,
          membershipState: currentActor.membershipState
        }
      ]
    };
    const navigation = {
      personalOwner: currentActor,
      teamPrincipal: interactionPerson(actor),
      personal: { memory: [], notesToSelf: notes, channels: [] },
      teams: teams()
    };
    let view: CollaborationSnapshot["view"];
    const selected = selection;
    if (selected.kind === "team_people") {
      const selectedTeamId = selected.teamId;
      const team = navigation.teams.find((item) => item.id === selectedTeamId)!;
      view = { kind: "team_people", teamId: team.id, people: team.people };
    } else if (selected.kind === "workspace_shared_memory") {
      const selectedTeamId = selected.teamId;
      const selectedWorkspaceId = selected.workspaceId;
      const workspace = navigation.teams
        .find((item) => item.id === selectedTeamId)!
        .workspaces.find((item) => item.id === selectedWorkspaceId)!;
      view = {
        kind: "shared_memory_index",
        teamId: selectedTeamId,
        workspaceId: selectedWorkspaceId,
        sessions: workspace.sharedMemory
      };
    } else if (selected.kind === "shared_session") {
      const team =
        selected.teamId === interactionIds.alphaTeam ? "alpha" : "beta";
      const session = interactionSession(team);
      const discussion = interactionDiscussion(team);
      view = {
        kind: "shared_session",
        session,
        source: {
          snapshotRevision: revision,
          olderCursor: null,
          newerCursor: null,
          hasOlder: false,
          hasNewer: false,
          sharedSessionId: session.id,
          representation: session.representation,
          items:
            team === "alpha"
              ? [
                  {
                    id: uuid(160),
                    representation: "memory_events",
                    sequence: 1,
                    occurredAt: timestamp,
                    sourceItems: [
                      {
                        id: uuid(161),
                        sourceKind: "agent_message",
                        occurredAt: timestamp,
                        body: "Deterministic Electron source replacement.",
                        actorName: "Codex",
                        toolName: null,
                        toolCallId: null
                      }
                    ]
                  }
                ]
              : [
                  {
                    id: uuid(162),
                    representation: "lcm_rollups",
                    sequence: 1,
                    occurredAt: timestamp,
                    summaryText:
                      "Deterministic cloud memory rollup replacement.",
                    sourceCount: 2,
                    sourceRevision: `${revision}-beta`
                  }
                ]
        },
        companion: {
          thread: discussion,
          messages: interactionPage(
            discussion.id,
            messages.get(discussion.id) ?? []
          )
        }
      };
    } else if (
      selected.kind === "workspace_channel" ||
      selected.kind === "team_direct_message"
    ) {
      const thread =
        selected.kind === "team_direct_message"
          ? interactionDm
          : selected.threadId === interactionIds.alphaChannel
            ? interactionChannel("alpha")
            : interactionChannel("beta");
      view = {
        kind: "thread",
        thread,
        messages: interactionPage(thread.id, messages.get(thread.id) ?? [])
      };
    } else {
      view = {
        kind: "thread",
        thread: notes,
        messages: interactionPage(notes.id, [])
      };
    }
    const parsedSnapshot = collaborationSnapshotSchema.safeParse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      snapshotRevision: revision,
      generatedAt: timestamp,
      connection,
      limits: COLLABORATION_DEFAULT_LIMITS,
      navigation,
      selection,
      view
    });
    if (!parsedSnapshot.success) {
      throw new Error(
        `Invalid stateful snapshot: ${parsedSnapshot.error.message}`
      );
    }
    return parsedSnapshot.data;
  };

  const result = (command: CollaborationRendererCommand, data: unknown) =>
    collaborationCommandResultSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: command.requestId,
      command: command.command,
      ok: true,
      data
    });
  const failure = (command: CollaborationRendererCommand) =>
    collaborationCommandResultSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: command.requestId,
      command: command.command,
      ok: false,
      error: {
        code: "conflict",
        userMessage: collaborationSafeErrorMessages.conflict,
        retryable: false,
        retryAfterMs: null
      }
    });
  const recorded: CollaborationRendererCommand[] = [];
  let suspendAcknowledgements = false;
  const nextCommandFailures = new Map<string, Error>();

  const command = async (
    input: CollaborationRendererCommand
  ): Promise<CollaborationCommandResult> => {
    const parsed = collaborationRendererCommandSchema.parse(input);
    recorded.push(parsed);
    const injectedFailure = nextCommandFailures.get(parsed.command);
    if (injectedFailure) {
      nextCommandFailures.delete(parsed.command);
      throw injectedFailure;
    }
    switch (parsed.command) {
      case "collaboration.load":
        return result(parsed, { snapshot: snapshot() });
      case "collaboration.select":
        selection = parsed.input.selection;
        // Real preload IPC yields back to the renderer before a response is
        // projected. Preserve that boundary in the stress fixture so click
        // latency measures UI work, not synchronous fake transport work.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
        return result(parsed, { snapshot: snapshot() });
      case "collaboration.reconnect_backend":
        connection = {
          ...connection,
          state: "live",
          connectedAt: timestamp,
          retryAt: null,
          reconnectAttempt: 0
        };
        return result(parsed, { snapshot: snapshot() });
      case "collaboration.request_action_grant":
        return result(parsed, {
          status: {
            version: 1,
            actionGrant: { id: interactionIds.actionGrant },
            state: "approved",
            activationUrl: null,
            expiresAt: "2099-01-02T10:38:00.000Z"
          }
        });
      case "collaboration.create_invitation": {
        invitationSequence += 1;
        const invitation = {
          id: uuid(300 + invitationSequence),
          teamId: parsed.input.teamId,
          defaultWorkspaceId: parsed.input.defaultWorkspaceId,
          defaultWorkspaceAccess: parsed.input.defaultWorkspaceAccess,
          email: parsed.input.email,
          role: parsed.input.role,
          lifecycle: "pending" as const,
          version: 1,
          createdAt: timestamp,
          expiresAt: "2099-01-05T09:38:00.000Z",
          acceptedAt: null,
          revokedAt: null
        };
        invitations.unshift(invitation);
        return result(parsed, {
          invitation,
          invitationUrl: `https://team.example.test/invitations/accept?token=alpha-${invitationSequence}`
        });
      }
      case "collaboration.list_invitations":
        return result(parsed, {
          page: {
            teamId: parsed.input.teamId,
            items: invitations.filter(
              (item) => item.teamId === parsed.input.teamId
            ),
            nextCursor: null
          }
        });
      case "collaboration.revoke_invitation": {
        const invitation = invitations.find(
          (item) => item.id === parsed.input.invitationId
        )!;
        invitation.lifecycle = "revoked";
        invitation.version += 1;
        invitation.revokedAt = timestamp;
        return result(parsed, { invitation });
      }
      case "collaboration.join_team":
        if (acceptedInvitations.has(parsed.input.invitation))
          return failure(parsed);
        acceptedInvitations.add(parsed.input.invitation);
        return result(parsed, { snapshot: snapshot() });
      case "collaboration.set_team_presence": {
        const team =
          parsed.input.teamId === interactionIds.alphaTeam ? "alpha" : "beta";
        const preferenceKey = `${team}:${actor}`;
        presencePreferences.set(preferenceKey, {
          mode: parsed.input.mode,
          manualStatus: parsed.input.manualStatus,
          preferenceVersion: parsed.input.expectedVersion + 1
        });
        return result(parsed, { person: managedPerson(actor, team) });
      }
      case "collaboration.report_team_activity":
        return result(parsed, { acceptedTeamIds: parsed.input.teamIds });
      case "collaboration.send_message": {
        messageSequence += 1;
        const teamId =
          parsed.input.thread.scope === "team"
            ? parsed.input.thread.teamId
            : interactionIds.alphaTeam;
        const message = interactionMessage(
          parsed.input.thread.threadId,
          teamId,
          actor,
          parsed.input.body,
          messageSequence,
          parsed.input.clientMessageId
        );
        messages.set(parsed.input.thread.threadId, [
          ...(messages.get(parsed.input.thread.threadId) ?? []),
          message
        ]);
        return result(parsed, { message });
      }
      case "collaboration.mark_read": {
        const page = messages.get(parsed.input.thread.threadId) ?? [];
        const readMessage = page.find(
          (message) => message.id === parsed.input.messageId
        );
        return result(parsed, {
          readState: {
            threadId: parsed.input.thread.threadId,
            messageId: parsed.input.messageId,
            sequence: readMessage?.sequence ?? 0,
            updatedAt: timestamp
          }
        });
      }
      case "collaboration.subscribe": {
        const subscriptionId =
          parsed.input.scope.scope === "personal"
            ? interactionIds.personalSubscription
            : parsed.input.scope.teamId === interactionIds.alphaTeam
              ? interactionIds.alphaSubscription
              : interactionIds.betaSubscription;
        return result(parsed, {
          subscription: {
            id: subscriptionId,
            scope: parsed.input.scope,
            state: "active",
            version: 1,
            expiresAt: "2099-01-02T10:38:00.000Z"
          }
        });
      }
      case "collaboration.unsubscribe":
        return result(parsed, {});
      case "collaboration.acknowledge_delivery":
        if (suspendAcknowledgements) {
          return new Promise<CollaborationCommandResult>(() => undefined);
        }
        return result(parsed, {
          subscriptionId: parsed.input.subscriptionId,
          acknowledgedEventId: parsed.input.eventId,
          subscriptionVersion: parsed.input.expectedSubscriptionVersion + 1
        });
      default:
        throw new Error(
          `Unexpected stateful browser command: ${parsed.command}`
        );
    }
  };

  const emit = (event: unknown) =>
    listener?.(collaborationRendererEventSchema.parse(event));
  const emitMessage = (
    thread: "channel" | "dm",
    body: string,
    sender: StatefulActor
  ) => {
    const threadId =
      thread === "channel"
        ? interactionIds.alphaChannel
        : interactionIds.alphaDm;
    messageSequence += 1;
    deliverySequence += 1;
    const message = interactionMessage(
      threadId,
      interactionIds.alphaTeam,
      sender,
      body,
      messageSequence,
      uuid(500 + messageSequence)
    );
    messages.set(threadId, [...(messages.get(threadId) ?? []), message]);
    emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: interactionIds.alphaSubscription,
      deliveryId: `delivery_browser_${String(deliverySequence).padStart(20, "0")}`,
      eventId: uuid(600 + deliverySequence),
      occurredAt: timestamp,
      family: "message_created",
      resource: {
        scope: "team",
        teamId: interactionIds.alphaTeam,
        workspaceId:
          thread === "channel" ? interactionIds.alphaWorkspace : null,
        threadId,
        messageId: message.id,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: { type: "message_created", message }
    });
  };
  const setReconnecting = () => {
    connection = {
      ...connection,
      state: "reconnecting",
      retryAt: "2099-01-02T09:39:00.000Z",
      reconnectAttempt: 1
    };
    emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection,
      error: null
    });
  };
  const revokeTeamAccess = () => {
    emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: interactionIds.alphaSubscription,
      occurredAt: timestamp,
      reason: "access_revoked"
    });
  };
  const emitBackpressure = () => {
    emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "control",
      subscriptionId: interactionIds.alphaSubscription,
      occurredAt: timestamp,
      reason: "backpressure"
    });
  };

  return {
    bridge: {
      command,
      subscribe(next: (event: CollaborationRendererEvent) => void) {
        listener = next;
        return () => {
          listener = null;
        };
      }
    },
    controls: {
      commands: () => recorded.map((item) => structuredClone(item)),
      emitMessage,
      suspendAcknowledgements: () => {
        suspendAcknowledgements = true;
      },
      failNextApiRequest: (privateDetail: string) => {
        nextCommandFailures.set(
          "collaboration.send_message",
          new Error(privateDetail)
        );
      },
      failNextBrokerRequest: (privateDetail: string) => {
        nextCommandFailures.set(
          "collaboration.select",
          new Error(privateDetail)
        );
      },
      failNextEnrollment: (privateDetail: string) => {
        nextCommandFailures.set(
          "collaboration.connect_backend",
          new Error(privateDetail)
        );
      },
      emitRealtimeFailure: (privateDetail: string) => {
        // Model the broker retaining diagnostic detail while exposing only the
        // contract's fixed safe error to the renderer.
        void new Error(privateDetail);
        connection = { ...connection, state: "unavailable", retryAt: null };
        emit({
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          type: "connection",
          connection,
          error: {
            code: "temporarily_unavailable",
            userMessage: collaborationSafeErrorMessages.temporarily_unavailable,
            retryable: true,
            retryAfterMs: null
          }
        });
      },
      emitBackpressure,
      setReconnecting,
      revokeTeamAccess
    }
  };
};

type StatefulBrowserControls = ReturnType<
  typeof createStatefulCollaborationBridge
>["controls"];

const CollaborationInteractionsValidationApp = () => {
  const fixture = useMemo(() => {
    const actor =
      new URLSearchParams(window.location.search).get("actor") === "bob"
        ? "bob"
        : "alice";
    return createStatefulCollaborationBridge(actor);
  }, []);
  const client = useMemo(
    () => createCollaborationRendererClient(fixture.bridge),
    [fixture]
  );
  useEffect(() => {
    const browserWindow = window as Window & {
      __koedCollaborationInteractions?: StatefulBrowserControls;
    };
    browserWindow.__koedCollaborationInteractions = fixture.controls;
    document.documentElement.dataset.browserValidationReady = "true";
    return () => {
      delete browserWindow.__koedCollaborationInteractions;
      client.dispose();
    };
  }, [client, fixture]);
  return (
    <App
      collaborationClient={client}
      initialCollaborationSelection={{
        kind: "shared_session",
        teamId: interactionIds.alphaTeam,
        workspaceId: interactionIds.alphaWorkspace,
        sharedSessionId: interactionIds.alphaSession
      }}
      onboardingComplete
      statusReadyOverride
    />
  );
};

const timelineFixture = Array.from({ length: 10_000 }, (_, index) => ({
  id: `timeline-${index}`,
  timestamp: timestamp,
  body: `Virtualized fixture row ${index}`
}));

const TimelineValidationApp = () => {
  useEffect(() => {
    document.documentElement.dataset.browserValidationReady = "true";
  }, []);
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        minHeight: 0
      }}
      data-total-items="10000"
    >
      <VirtualizedTimeline
        ariaLabel="Ten thousand row timeline"
        className="collab-virtual-list"
        estimatedItemHeight={40}
        events={timelineFixture}
        hasOlderEvents={false}
        onLoadOlder={() => undefined}
        renderEvent={(item) => (
          <div
            role="listitem"
            data-timeline-item={item.id}
            style={{ height: 40, padding: "8px 12px" }}
          >
            {item.body}
          </div>
        )}
        threadKey="browser-ten-thousand"
      />
    </main>
  );
};

const browserValidationView = new URLSearchParams(window.location.search).get(
  "view"
);
createRoot(document.querySelector("#root")!).render(
  browserValidationView === "chat" ? (
    <ChatValidationApp />
  ) : browserValidationView === "collaboration-interactions" ? (
    <CollaborationInteractionsValidationApp />
  ) : browserValidationView === "timeline" ? (
    <TimelineValidationApp />
  ) : (
    <ValidationApp />
  )
);
