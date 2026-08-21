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
  type CollaborationSnapshot,
  type OwnedShareItem
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

const richMarkdownFixture = `# Formatting parity

Paragraph with **strong text**, ~~retired text~~, \`inline code\`, a [safe link](https://koed.example/docs), an [unsafe link](javascript:alert(1)), and ![remote image](https://koed.example/image.png).

- First item
  1. Nested ordered item
  2. Second nested item
- [x] Completed task
- [ ] Pending task

> A captured decision remains distinct from Team discussion.

| Surface | State |
| --- | --- |
| Personal Memory | Ready |
| Team Chat | Ready |

\`\`\`ts
const longLine = "${"formatting-parity-".repeat(240)}";
console.log(longLine);
\`\`\``;

const personalEvent = (
  index: number,
  overrides: Partial<PersonalDesktopConversationEvent> = {}
): PersonalDesktopConversationEvent => ({
  actor: index % 2 === 0 ? "user" : "assistant",
  content: `Browser validation Memory Event ${index + 1}`,
  contentPreview: `Browser validation Memory Event ${index + 1}`,
  eventType: "message",
  id: uuid(700 + index),
  invalidatedAt: null,
  metadata: {},
  sourceEventTime: timestamp,
  sourceSequence: index + 1,
  timestamp,
  ...overrides
});

const patchFixture = `*** Begin Patch
*** Update File: src/app.ts
@@
-const state = "legacy";
+const state = "desktop";
*** Add File: src/formatting.ts
@@
+export const formattingParity = true;
*** Delete File: src/explorer-only.ts
@@
-export const explorerOnly = true;
*** End Patch`;

const parityEvents: PersonalDesktopConversationEvent[] = [
  personalEvent(489, {
    actor: "agent",
    content:
      '{"risk_level":"medium","user_authorization":"high","outcome":"allow","rationale":"This browser validation action is bounded and local."}',
    contentPreview: "Codex Auto Approval decision",
    approvalDecisionDisplay: {
      kind: "auto_approval",
      version: 1,
      riskLevel: "medium",
      userAuthorization: "high",
      outcome: "allow",
      rationale: "This browser validation action is bounded and local."
    }
  }),
  personalEvent(490, {
    actor: "user",
    content:
      "The following is the Codex agent history whose request action you are assessing. TRANSCRIPT START ... TRANSCRIPT END",
    contentPreview: "Approval review transcript formatting fixture",
    transcriptDisplay: {
      kind: "approval_review",
      version: 1,
      truncated: false,
      segments: [
        {
          kind: "message",
          sequence: 1,
          actor: "user",
          content: "## Review request\n\n- Preserve message formatting"
        },
        {
          kind: "message",
          sequence: 2,
          actor: "agent",
          content: "I will validate the Captured Session."
        },
        {
          kind: "tool_call",
          sequence: 3,
          toolName: "exec",
          content: "pnpm --filter @koed/desktop test"
        },
        {
          kind: "tool_result",
          sequence: 4,
          toolName: "exec",
          content: "Tests passed"
        }
      ]
    }
  }),
  personalEvent(491, {
    actor: "user",
    content: richMarkdownFixture,
    contentPreview: "Formatting parity fixture"
  }),
  personalEvent(492, {
    actor: "assistant",
    content: "oversized ".repeat(30_000),
    contentPreview: "Oversized Markdown safety fixture"
  }),
  personalEvent(493, {
    actor: "tool",
    content: "pnpm --filter @koed/desktop test",
    contentPreview: "Desktop tests passed",
    eventType: "tool_call",
    metadata: { toolName: "exec_command" },
    toolDisplay: {
      kind: "command",
      label: "Ran command",
      preview: "pnpm --filter @koed/desktop test",
      toolName: "exec_command",
      status: "completed",
      callId: "call-command-browser-validation"
    }
  }),
  personalEvent(494, {
    actor: "tool",
    content: "Read packages/memory-ui/src/SecureMarkdown.tsx",
    eventType: "tool_call",
    metadata: { toolName: "read_file" },
    toolDisplay: {
      kind: "file_read",
      label: "Read file",
      preview: "packages/memory-ui/src/SecureMarkdown.tsx",
      toolName: "read_file"
    }
  }),
  personalEvent(495, {
    actor: "tool",
    content: "Found SecureMarkdown in 8 files",
    eventType: "tool_call",
    metadata: { toolName: "rg" },
    toolDisplay: {
      kind: "search",
      label: "Searched files",
      preview: "SecureMarkdown",
      toolName: "rg"
    }
  }),
  personalEvent(496, {
    actor: "tool",
    content: "The formatter inspected the rendered output.",
    eventType: "tool_call",
    metadata: { toolName: "format_inspector" },
    toolDisplay: {
      kind: "tool",
      label: "Format inspector",
      preview: "Rendered output inspected",
      toolName: "format_inspector"
    }
  }),
  personalEvent(497, {
    actor: "tool",
    content: patchFixture,
    contentPreview: "Three source files changed",
    eventType: "tool_call",
    metadata: { toolName: "apply_patch" },
    toolDisplay: {
      kind: "file_change",
      label: "Changed files",
      preview: "3 files changed",
      toolName: "apply_patch",
      status: "completed",
      callId: "call-patch-browser-validation",
      patchSource: patchFixture
    }
  }),
  personalEvent(498, {
    actor: "tool",
    content: "*** Begin Patch\n*** End Patch",
    contentPreview: "Malformed source patch",
    eventType: "tool_call",
    invalidatedAt: timestamp,
    metadata: { toolName: "apply_patch" },
    toolDisplay: {
      kind: "file_change",
      label: "Changed files",
      preview: "Malformed source patch",
      toolName: "apply_patch",
      patchSource: "*** Begin Patch\n*** End Patch"
    }
  }),
  personalEvent(499, {
    actor: "assistant",
    content: "Formatting parity validation complete.",
    contentPreview: "Formatting parity validation complete."
  }),
  personalEvent(500, {
    actor: "user",
    content: "Keep this final row visible for scroll-anchor validation.",
    contentPreview: "Final scroll-anchor row"
  })
];

const personalEvents: PersonalDesktopConversationEvent[] = [
  ...Array.from({ length: 489 }, (_, index) => personalEvent(index)),
  ...parityEvents
];

const personalMemoryApi: PersonalDesktopApi = {
  assignSessionProject: async () => ({ projectId: personalProject.id }),
  listProjects: async () => [personalProject],
  loadEventPage: async () => personalEvents,
  updateSessionTitle: async ({ title }) => ({ title }),
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
  const teamPerson = (person: typeof currentUser) => ({
    ...person,
    teamPresence: {
      mode: "auto" as const,
      manualStatus: "available" as const,
      activityLevel: "active" as const,
      lastActivityAt: timestamp,
      nextTransitionAt: new Date(
        new Date(timestamp).getTime() + 5 * 60_000
      ).toISOString(),
      preferenceVersion: 1
    }
  });
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
    maximumFidelity: "memory_events" as const,
    includeCuratedMemory: false,
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
      people: [teamPerson(teamPrincipal), teamPerson(teammate)],
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
                body: richMarkdownFixture,
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
            body: richMarkdownFixture,
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
          : command.command === "collaboration.report_team_activity"
            ? { acceptedTeamIds: command.input.teamIds }
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
          __koedBrowserCommands?: string[];
          __koedBrowserUserCommands?: string[];
        };
        browserWindow.__koedBrowserCommands ??= [];
        browserWindow.__koedBrowserCommands.push(command.command);
        if (
          command.command !== "collaboration.report_team_activity" &&
          command.command !== "collaboration.mark_delivered" &&
          command.command !== "collaboration.mark_read"
        ) {
          browserWindow.__koedBrowserUserCommands ??= [];
          browserWindow.__koedBrowserUserCommands.push(command.command);
          browserWindow.__koedBrowserCommandCount =
            browserWindow.__koedBrowserUserCommands.length;
        }
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
  betaSubscription: uuid(143),
  pendingShare: uuid(701),
  pendingMutation: uuid(702),
  pendingLogicalGrant: uuid(703),
  pendingConsent: uuid(704),
  pendingGrant: uuid(705),
  pendingPreview: uuid(706),
  activeGrant: uuid(711),
  activeLogicalGrant: uuid(712),
  activeConsent: uuid(713)
} as const;

const ownerOnlyCredentialSource =
  "username: preview-owner password: correct-horse-battery-staple";
const teamSafeCredentialSource = "username: [USERNAME] password: [SECRET]";

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
  owner: interactionParticipant("alice"),
  title:
    team === "alpha"
      ? "Workspace Memory Timeline UX"
      : "Flat User-Owned Memory Model",
  latestActivityAt: timestamp,
  maximumFidelity:
    team === "alpha" ? ("memory_events" as const) : ("lcm_rollups" as const),
  includeCuratedMemory: false,
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
  let pendingOwnedShare: Extract<OwnedShareItem, { kind: "pending" }> = {
    kind: "pending",
    pendingShare: {
      id: interactionIds.pendingShare,
      mutationId: interactionIds.pendingMutation,
      logicalGrantId: interactionIds.pendingLogicalGrant,
      consentId: interactionIds.pendingConsent,
      logicalMemoryId: interactionIds.alphaMemory,
      teamId: interactionIds.alphaTeam,
      workspaceId: interactionIds.alphaWorkspace,
      representation: "memory_events",
      maximumFidelity: "memory_events",
      includeCuratedMemory: false,
      mode: "continuous",
      sourceRevision: 12,
      state: "activated",
      stage: "complete",
      workspaceAccessState: "active",
      sourceUpdateState: "active",
      operationVersion: 3,
      attemptCount: 1,
      redactedFailureCode: null,
      lastProgressAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      activatedAt: timestamp,
      revokedAt: null,
      grantId: interactionIds.pendingGrant
    },
    sourceAccess: null,
    summary: {
      sourceSessionId: interactionIds.alphaSession,
      sourceTitle: "Packaged asynchronous sharing",
      teamName: "Electron Team App",
      workspaceName: "Electron Team App",
      mode: "continuous",
      authorizedPreview: {
        previewId: interactionIds.pendingPreview,
        previewHash: "a".repeat(64),
        previewRevision: 1,
        sourceRevision: 12
      },
      lastReadyRevision: 12,
      lastSuccessfulUpdateAt: timestamp
    }
  };
  let activeOwnedShare: Extract<OwnedShareItem, { kind: "grant" }> | null = {
    kind: "grant",
    grant: {
      id: interactionIds.activeGrant,
      logicalGrantId: interactionIds.activeLogicalGrant,
      logicalMemoryId: interactionIds.alphaMemory,
      ownerUserId:
        actor === "alice"
          ? interactionIds.alicePersonal
          : interactionIds.bobPersonal,
      teamId: interactionIds.alphaTeam,
      workspaceId: interactionIds.alphaWorkspace,
      consentId: interactionIds.activeConsent,
      maximumFidelity: "memory_events",
      includeCuratedMemory: false,
      fidelityPolicyRevision: 1,
      sourceRevision: 12,
      grantVersion: 2,
      lifecycle: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      revokedAt: null,
      companionThreadId: interactionIds.alphaDiscussion
    },
    sourceAccess: null,
    summary: {
      sourceSessionId: interactionIds.alphaSession,
      sourceTitle: "Packaged revocation fixture",
      teamName: "Electron Team App",
      workspaceName: "Electron Team App",
      mode: "snapshot",
      authorizedPreview: null,
      lastReadyRevision: 12,
      lastSuccessfulUpdateAt: timestamp
    }
  };
  const revokedOwnedShares: OwnedShareItem[] = [];
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
          representation: session.maximumFidelity,
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
                        body: `Deterministic Electron source replacement. ${teamSafeCredentialSource}`,
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
                    lexicalAnchors: ["cloud-memory-rollup"],
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
  let pendingNativeReview: {
    version: 1;
    title: string;
    description: string;
    consequence: string;
    confirmLabel: string;
    details: Array<{ label: string; value: string }>;
  } | null = null;

  const nativeReviewFor = (
    intent: Extract<
      CollaborationRendererCommand,
      { command: "collaboration.request_action_grant" }
    >["input"]["intent"]
  ) => {
    switch (intent.intent) {
      case "collaboration.create_invitation":
        return {
          version: 1 as const,
          title: `Invite ${intent.email}?`,
          description: "Review the exact invitation before it is issued.",
          consequence: `The recipient can join with ${intent.defaultWorkspaceAccess} access.`,
          confirmLabel: "Create invitation",
          details: [
            { label: "Email", value: intent.email },
            { label: "Role", value: intent.role },
            { label: "Workspace Access", value: intent.defaultWorkspaceAccess }
          ]
        };
      case "collaboration.join_team":
        return {
          version: 1 as const,
          title: "Join Team?",
          description: "Review the invitation before joining this Team.",
          consequence: "The Team will become available in Desktop.",
          confirmLabel: "Join Team",
          details: [{ label: "Invitation", value: intent.invitation }]
        };
      case "collaboration.revoke_invitation":
        return {
          version: 1 as const,
          title: "Revoke invitation?",
          description: "Review the exact pending invitation.",
          consequence: "The invitation can no longer be used.",
          confirmLabel: "Revoke invitation",
          details: [{ label: "Invitation", value: intent.invitationId }]
        };
      case "collaboration.revoke_shared_memory":
        return {
          version: 1 as const,
          title: "Revoke Workspace access?",
          description: "Review the exact Shared Memory grant.",
          consequence:
            "The Workspace loses access. Personal Memory is not deleted.",
          confirmLabel: "Revoke Workspace access",
          details: [
            { label: "Share Grant", value: intent.shareGrantId },
            { label: "Workspace", value: intent.workspaceId }
          ]
        };
      default:
        throw new Error(
          `Unexpected Native-review browser intent: ${intent.intent}`
        );
    }
  };

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
        pendingNativeReview = nativeReviewFor(parsed.input.intent);
        return result(parsed, {
          status: {
            version: 1,
            actionGrant: { id: interactionIds.actionGrant },
            approvalTier: "native_review",
            review: pendingNativeReview,
            state: "review_required",
            activationUrl: null,
            expiresAt: "2099-01-02T10:38:00.000Z"
          }
        });
      case "collaboration.confirm_action_grant": {
        if (!pendingNativeReview) {
          throw new Error("Native review decision has no pending review");
        }
        const review = pendingNativeReview;
        pendingNativeReview = null;
        return result(parsed, {
          status: {
            version: 1,
            actionGrant: parsed.input.actionGrant,
            approvalTier: "native_review",
            review,
            state:
              parsed.input.decision === "approve" ? "approved" : "canceled",
            activationUrl: null,
            expiresAt: "2099-01-02T10:38:00.000Z"
          }
        });
      }
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
      case "collaboration.list_owned_shares":
        return result(parsed, {
          shares: parsed.input.history
            ? revokedOwnedShares
            : [
                pendingOwnedShare,
                ...(activeOwnedShare ? [activeOwnedShare] : [])
              ],
          nextCursor: null
        });
      case "collaboration.get_owned_share": {
        const share = [
          pendingOwnedShare,
          ...(activeOwnedShare ? [activeOwnedShare] : []),
          ...revokedOwnedShares
        ].find(
          (item) =>
            item.kind === parsed.input.kind &&
            (item.kind === "pending" ? item.pendingShare.id : item.grant.id) ===
              parsed.input.id
        );
        if (!share) return failure(parsed);
        return result(parsed, { share });
      }
      case "collaboration.preview_shared_memory_candidate":
        return result(parsed, {
          candidate: {
            sessionId: parsed.input.sessionId,
            logicalMemoryId: interactionIds.alphaMemory,
            representation: parsed.input.representation,
            sourceRevision: 12,
            candidateHash: "c".repeat(64),
            itemCount: 1,
            excludedItemCount: 0,
            manifest: [
              {
                sourceId: uuid(160),
                revisionHash: "d".repeat(64)
              }
            ],
            byteCount: new TextEncoder().encode(ownerOnlyCredentialSource)
              .byteLength,
            items: [
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
                    body: ownerOnlyCredentialSource,
                    actorName: "Codex",
                    toolName: null,
                    toolCallId: null
                  }
                ]
              }
            ]
          }
        });
      case "collaboration.control_pending_share": {
        const sourceUpdateState =
          parsed.input.action === "pause"
            ? "paused"
            : parsed.input.action === "resume"
              ? "active"
              : pendingOwnedShare.pendingShare.sourceUpdateState;
        pendingOwnedShare = {
          ...pendingOwnedShare,
          pendingShare: {
            ...pendingOwnedShare.pendingShare,
            sourceUpdateState,
            operationVersion:
              pendingOwnedShare.pendingShare.operationVersion + 1,
            updatedAt: timestamp
          }
        };
        return result(parsed, {
          pendingShare: pendingOwnedShare.pendingShare
        });
      }
      case "collaboration.revoke_shared_memory": {
        if (!activeOwnedShare || activeOwnedShare.kind !== "grant") {
          return failure(parsed);
        }
        const revoked: OwnedShareItem = {
          ...activeOwnedShare,
          grant: {
            ...activeOwnedShare.grant,
            lifecycle: "revoked",
            grantVersion: activeOwnedShare.grant.grantVersion + 1,
            updatedAt: timestamp,
            revokedAt: timestamp
          }
        };
        activeOwnedShare = null;
        revokedOwnedShares.unshift(revoked);
        return result(parsed, { grant: revoked.grant });
      }
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
  const emitPendingShareNeedsAttention = () => {
    pendingOwnedShare = {
      ...pendingOwnedShare,
      pendingShare: {
        ...pendingOwnedShare.pendingShare,
        state: "needs_attention",
        stage: "processing",
        sourceUpdateState: "failed",
        operationVersion: pendingOwnedShare.pendingShare.operationVersion + 1,
        attemptCount: pendingOwnedShare.pendingShare.attemptCount + 1,
        redactedFailureCode: "source_preparation_stalled",
        updatedAt: timestamp
      }
    };
    deliverySequence += 1;
    emit({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "update",
      subscriptionId: interactionIds.personalSubscription,
      deliveryId: `delivery_browser_${String(deliverySequence).padStart(20, "0")}`,
      eventId: uuid(900 + deliverySequence),
      occurredAt: timestamp,
      family: "pending_share_lifecycle",
      resource: {
        scope: "personal",
        teamId: null,
        workspaceId: null,
        threadId: null,
        messageId: null,
        sharedSessionId: null,
        shareGrantId: null
      },
      update: {
        type: "owned_share_status_changed",
        pendingShareId: pendingOwnedShare.pendingShare.id,
        sourceTitle: pendingOwnedShare.summary.sourceTitle,
        state: pendingOwnedShare.pendingShare.state,
        stage: pendingOwnedShare.pendingShare.stage,
        workspaceAccessState:
          pendingOwnedShare.pendingShare.workspaceAccessState,
        sourceUpdateState: pendingOwnedShare.pendingShare.sourceUpdateState,
        redactedFailureCode: pendingOwnedShare.pendingShare.redactedFailureCode
      }
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
      emitPendingShareNeedsAttention,
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
    () =>
      createCollaborationRendererClient(fixture.bridge, {
        confirmNativeReview: () => true
      }),
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
