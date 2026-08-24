import {
  isPersonalCollaborationSelection,
  isTeamCollaborationSelection,
  type CollaborationRendererCommand
} from "@koed/shared";

export type CollaborationCommandName = CollaborationRendererCommand["command"];
type CommandFor<Name extends CollaborationCommandName> = Extract<
  CollaborationRendererCommand,
  { command: Name }
>;

export type CollaborationCommandScope = "personal" | "team";
export type DesktopCollaborationOperationFamily =
  | "personal_collaboration_read"
  | "personal_collaboration_write";
export type UpstreamCollaborationOperationFamily =
  | DesktopCollaborationOperationFamily
  | "team_chat_read"
  | "team_chat_write";

export interface CollaborationUpstreamOperation {
  operationFamily: UpstreamCollaborationOperationFamily;
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  body: Record<string, unknown>;
  resultKey: "thread" | "message" | "readState" | "person" | "acceptedTeamIds";
  idempotencyKey?: string;
}

export type PersonalCollaborationUpstreamOperation =
  CollaborationUpstreamOperation & {
    operationFamily: DesktopCollaborationOperationFamily;
  };
export type TeamCollaborationUpstreamOperation =
  CollaborationUpstreamOperation & {
    operationFamily: "team_chat_read" | "team_chat_write";
  };

type ScopeRule<Name extends CollaborationCommandName> =
  | CollaborationCommandScope
  | "unsupported"
  | ((command: CommandFor<Name>) => CollaborationCommandScope | "unsupported");

interface CollaborationCommandDescriptor<
  Name extends CollaborationCommandName
> {
  scope: ScopeRule<Name>;
  desktopOperationFamily: DesktopCollaborationOperationFamily;
  personalOperation?: (
    command: CommandFor<Name>
  ) => PersonalCollaborationUpstreamOperation;
  teamOperation?: (
    command: CommandFor<Name>
  ) => TeamCollaborationUpstreamOperation;
  matchesTeamResult?: (
    command: CommandFor<Name>,
    result: Record<string, unknown>
  ) => boolean;
}

type CollaborationCommandRegistry = {
  [Name in CollaborationCommandName]: CollaborationCommandDescriptor<Name>;
};

const read = "personal_collaboration_read" as const;
const write = "personal_collaboration_write" as const;

const personalThreadPath = (threadId: string): string =>
  `/v1/collaboration/personal/threads/${encodeURIComponent(threadId)}`;

const teamThreadPath = (thread: {
  scope: "team";
  teamId: string;
  threadId: string;
}): string =>
  `/v1/collaboration/teams/${encodeURIComponent(thread.teamId)}/threads/${encodeURIComponent(thread.threadId)}`;

const personalThreadScope = (
  command: CommandFor<"collaboration.rename_thread">
): CollaborationCommandScope =>
  command.input.thread.scope === "personal" ? "personal" : "team";

const threadScope = (
  command:
    | CommandFor<"collaboration.rename_thread">
    | CommandFor<"collaboration.update_thread_topic">
    | CommandFor<"collaboration.archive_thread">
    | CommandFor<"collaboration.restore_thread">
    | CommandFor<"collaboration.send_message">
    | CommandFor<"collaboration.retry_message">
    | CommandFor<"collaboration.mark_read">
    | CommandFor<"collaboration.mark_delivered">
    | CommandFor<"collaboration.load_message_page">
): CollaborationCommandScope =>
  command.input.thread.scope === "personal" ? "personal" : "team";

const personalThreadMutation = (
  command:
    | CommandFor<"collaboration.rename_thread">
    | CommandFor<"collaboration.update_thread_topic">
    | CommandFor<"collaboration.archive_thread">
    | CommandFor<"collaboration.restore_thread">
): PersonalCollaborationUpstreamOperation => {
  const suffix =
    command.command === "collaboration.rename_thread"
      ? "name"
      : command.command === "collaboration.update_thread_topic"
        ? "topic"
        : command.command === "collaboration.archive_thread"
          ? "archive"
          : "restore";
  const body =
    command.command === "collaboration.rename_thread"
      ? {
          name: command.input.name,
          expectedVersion: command.input.expectedVersion
        }
      : command.command === "collaboration.update_thread_topic"
        ? {
            topic: command.input.topic,
            expectedVersion: command.input.expectedVersion
          }
        : { expectedVersion: command.input.expectedVersion };
  return {
    operationFamily: write,
    method:
      command.command === "collaboration.rename_thread" ||
      command.command === "collaboration.update_thread_topic"
        ? "PATCH"
        : "POST",
    path: `${personalThreadPath(command.input.thread.threadId)}/${suffix}`,
    body,
    resultKey: "thread"
  };
};

const teamThreadMutation = (
  command:
    | CommandFor<"collaboration.rename_thread">
    | CommandFor<"collaboration.update_thread_topic">
    | CommandFor<"collaboration.archive_thread">
    | CommandFor<"collaboration.restore_thread">
): TeamCollaborationUpstreamOperation => {
  if (command.input.thread.scope !== "team") {
    throw new TypeError("Team operation requires a Team thread");
  }
  const suffix =
    command.command === "collaboration.rename_thread"
      ? "name"
      : command.command === "collaboration.update_thread_topic"
        ? "topic"
        : command.command === "collaboration.archive_thread"
          ? "archive"
          : "restore";
  const body =
    command.command === "collaboration.rename_thread"
      ? {
          name: command.input.name,
          expectedVersion: command.input.expectedVersion
        }
      : command.command === "collaboration.update_thread_topic"
        ? {
            topic: command.input.topic,
            expectedVersion: command.input.expectedVersion
          }
        : { expectedVersion: command.input.expectedVersion };
  return {
    operationFamily: "team_chat_write",
    method:
      command.command === "collaboration.rename_thread" ||
      command.command === "collaboration.update_thread_topic"
        ? "PATCH"
        : "POST",
    path: `${teamThreadPath(command.input.thread)}/${suffix}`,
    body,
    resultKey: "thread"
  };
};

const personalMessageOperation = (
  command:
    | CommandFor<"collaboration.send_message">
    | CommandFor<"collaboration.retry_message">
): PersonalCollaborationUpstreamOperation => ({
  operationFamily: write,
  method: "POST",
  path: `${personalThreadPath(command.input.thread.threadId)}/messages`,
  body: { bodyText: command.input.body },
  resultKey: "message",
  idempotencyKey: command.input.clientMessageId
});

const teamMessageOperation = (
  command:
    | CommandFor<"collaboration.send_message">
    | CommandFor<"collaboration.retry_message">
): TeamCollaborationUpstreamOperation => {
  if (command.input.thread.scope !== "team") {
    throw new TypeError("Team operation requires a Team thread");
  }
  return {
    operationFamily: "team_chat_write",
    method: "POST",
    path: `${teamThreadPath(command.input.thread)}/messages`,
    body: { bodyText: command.input.body },
    resultKey: "message",
    idempotencyKey: command.input.clientMessageId
  };
};

const matchesThreadIdentity = (
  command:
    | CommandFor<"collaboration.rename_thread">
    | CommandFor<"collaboration.update_thread_topic">
    | CommandFor<"collaboration.archive_thread">
    | CommandFor<"collaboration.restore_thread">,
  result: Record<string, unknown>
): boolean =>
  command.input.thread.scope === "team" &&
  result.id === command.input.thread.threadId &&
  result.teamId === command.input.thread.teamId;

const matchesMessage = (
  command:
    | CommandFor<"collaboration.send_message">
    | CommandFor<"collaboration.retry_message">,
  result: Record<string, unknown>
): boolean =>
  command.input.thread.scope === "team" &&
  result.threadId === command.input.thread.threadId &&
  result.teamId === command.input.thread.teamId &&
  result.body === command.input.body;

export const collaborationCommandRegistry = {
  "collaboration.load": { scope: "personal", desktopOperationFamily: read },
  "collaboration.select": {
    scope: (command) =>
      isPersonalCollaborationSelection(command.input.selection)
        ? "personal"
        : isTeamCollaborationSelection(command.input.selection)
          ? "team"
          : "unsupported",
    desktopOperationFamily: read
  },
  "collaboration.connect_backend": {
    scope: "unsupported",
    desktopOperationFamily: write
  },
  "collaboration.reconnect_backend": {
    scope: "unsupported",
    desktopOperationFamily: write
  },
  "collaboration.disconnect_backend": {
    scope: "unsupported",
    desktopOperationFamily: write
  },
  "collaboration.request_action_grant": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.await_action_grant": {
    scope: "team",
    desktopOperationFamily: read
  },
  "collaboration.confirm_action_grant": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.cancel_action_grant": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.create_team": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.join_team": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.create_workspace": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.create_personal_channel": {
    scope: "personal",
    desktopOperationFamily: write,
    personalOperation: (command) => ({
      operationFamily: write,
      method: "POST",
      path: "/v1/collaboration/personal/channels",
      body: { name: command.input.name, topic: command.input.topic },
      resultKey: "thread",
      idempotencyKey: command.requestId
    })
  },
  "collaboration.create_workspace_channel": {
    scope: "team",
    desktopOperationFamily: write,
    teamOperation: (command) => ({
      operationFamily: "team_chat_write",
      method: "POST",
      path: `/v1/collaboration/teams/${encodeURIComponent(command.input.teamId)}/workspaces/${encodeURIComponent(command.input.workspaceId)}/channels`,
      body: { name: command.input.name, topic: command.input.topic },
      resultKey: "thread",
      idempotencyKey: command.requestId
    }),
    matchesTeamResult: (command, result) =>
      result.kind === "workspace_channel" &&
      result.teamId === command.input.teamId &&
      result.workspaceId === command.input.workspaceId &&
      result.name === command.input.name &&
      result.topic === command.input.topic
  },
  "collaboration.start_direct_message": {
    scope: "team",
    desktopOperationFamily: write,
    teamOperation: (command) => ({
      operationFamily: "team_chat_write",
      method: "POST",
      path: `/v1/collaboration/teams/${encodeURIComponent(command.input.teamId)}/direct-messages`,
      body: { participantUserId: command.input.participantUserId },
      resultKey: "thread",
      idempotencyKey: command.requestId
    }),
    matchesTeamResult: (command, result) =>
      result.kind === "dm" &&
      result.teamId === command.input.teamId &&
      Array.isArray(result.participants) &&
      result.participants.some(
        (participant) =>
          participant !== null &&
          typeof participant === "object" &&
          (participant as { id?: unknown }).id ===
            command.input.participantUserId
      )
  },
  "collaboration.start_group_direct_message": {
    scope: "team",
    desktopOperationFamily: write,
    teamOperation: (command) => ({
      operationFamily: "team_chat_write",
      method: "POST",
      path: `/v1/collaboration/teams/${encodeURIComponent(command.input.teamId)}/group-direct-messages`,
      body: { participantUserIds: command.input.participantUserIds },
      resultKey: "thread",
      idempotencyKey: command.requestId
    }),
    matchesTeamResult: (command, result) => {
      if (
        result.kind !== "group_dm" ||
        result.teamId !== command.input.teamId ||
        !Array.isArray(result.participants)
      ) {
        return false;
      }
      const participantIds = new Set(
        result.participants.map((participant) =>
          participant !== null && typeof participant === "object"
            ? (participant as { id?: unknown }).id
            : null
        )
      );
      return (
        result.participants.length ===
          command.input.participantUserIds.length + 1 &&
        command.input.participantUserIds.every((id) => participantIds.has(id))
      );
    }
  },
  "collaboration.set_team_presence": {
    scope: "team",
    desktopOperationFamily: write,
    teamOperation: (command) => ({
      operationFamily: "team_chat_read",
      method: "PUT",
      path: `/v1/teams/${encodeURIComponent(command.input.teamId)}/presence/me`,
      body: {
        mode: command.input.mode,
        manualStatus: command.input.manualStatus,
        expectedVersion: command.input.expectedVersion
      },
      resultKey: "person"
    }),
    matchesTeamResult: (command, result) => {
      const teamPresence = result.teamPresence;
      return (
        teamPresence !== null &&
        typeof teamPresence === "object" &&
        (teamPresence as { mode?: unknown }).mode === command.input.mode &&
        (teamPresence as { manualStatus?: unknown }).manualStatus ===
          command.input.manualStatus
      );
    }
  },
  "collaboration.report_team_activity": {
    scope: "team",
    desktopOperationFamily: write,
    teamOperation: (command) => ({
      operationFamily: "team_chat_read",
      method: "POST",
      path: "/v1/teams/presence/activity",
      body: { teamIds: command.input.teamIds },
      resultKey: "acceptedTeamIds"
    })
  },
  "collaboration.rename_thread": {
    scope: personalThreadScope,
    desktopOperationFamily: write,
    personalOperation: personalThreadMutation,
    teamOperation: teamThreadMutation,
    matchesTeamResult: (command, result) =>
      matchesThreadIdentity(command, result) &&
      result.name === command.input.name
  },
  "collaboration.update_thread_topic": {
    scope: threadScope,
    desktopOperationFamily: write,
    personalOperation: personalThreadMutation,
    teamOperation: teamThreadMutation,
    matchesTeamResult: (command, result) =>
      matchesThreadIdentity(command, result) &&
      result.topic === command.input.topic
  },
  "collaboration.archive_thread": {
    scope: threadScope,
    desktopOperationFamily: write,
    personalOperation: personalThreadMutation,
    teamOperation: teamThreadMutation,
    matchesTeamResult: (command, result) =>
      matchesThreadIdentity(command, result) && result.lifecycle === "archived"
  },
  "collaboration.restore_thread": {
    scope: threadScope,
    desktopOperationFamily: write,
    personalOperation: personalThreadMutation,
    teamOperation: teamThreadMutation,
    matchesTeamResult: (command, result) =>
      matchesThreadIdentity(command, result) && result.lifecycle === "active"
  },
  "collaboration.send_message": {
    scope: threadScope,
    desktopOperationFamily: write,
    personalOperation: personalMessageOperation,
    teamOperation: teamMessageOperation,
    matchesTeamResult: matchesMessage
  },
  "collaboration.retry_message": {
    scope: threadScope,
    desktopOperationFamily: write,
    personalOperation: personalMessageOperation,
    teamOperation: teamMessageOperation,
    matchesTeamResult: matchesMessage
  },
  "collaboration.mark_read": {
    scope: threadScope,
    desktopOperationFamily: write,
    personalOperation: (command) => ({
      operationFamily: read,
      method: "PUT",
      path: `${personalThreadPath(command.input.thread.threadId)}/read-state`,
      body: { messageId: command.input.messageId },
      resultKey: "readState"
    }),
    teamOperation: (command) => {
      if (command.input.thread.scope !== "team") {
        throw new TypeError("Team operation requires a Team thread");
      }
      return {
        operationFamily: "team_chat_read",
        method: "PUT",
        path: `${teamThreadPath(command.input.thread)}/read-state`,
        body: { messageId: command.input.messageId },
        resultKey: "readState"
      };
    },
    matchesTeamResult: (command, result) =>
      command.input.thread.scope === "team" &&
      result.threadId === command.input.thread.threadId &&
      result.messageId === command.input.messageId
  },
  "collaboration.mark_delivered": {
    scope: threadScope,
    desktopOperationFamily: write,
    personalOperation: (command) => ({
      operationFamily: read,
      method: "PUT",
      path: `${personalThreadPath(command.input.thread.threadId)}/delivery-state`,
      body: { messageId: command.input.messageId },
      resultKey: "readState"
    }),
    teamOperation: (command) => {
      if (command.input.thread.scope !== "team") {
        throw new TypeError("Team operation requires a Team thread");
      }
      return {
        operationFamily: "team_chat_read",
        method: "PUT",
        path: `${teamThreadPath(command.input.thread)}/delivery-state`,
        body: { messageId: command.input.messageId },
        resultKey: "readState"
      };
    },
    matchesTeamResult: (command, result) =>
      command.input.thread.scope === "team" &&
      result.threadId === command.input.thread.threadId &&
      result.deliveredMessageId === command.input.messageId
  },
  "collaboration.load_message_page": {
    scope: threadScope,
    desktopOperationFamily: read,
    teamOperation: (command) => {
      if (command.input.thread.scope !== "team") {
        throw new TypeError("Team operation requires a Team thread");
      }
      return {
        operationFamily: "team_chat_read",
        method: "GET",
        path: `${teamThreadPath(command.input.thread)}/messages`,
        body: {},
        resultKey: "message"
      };
    },
    matchesTeamResult: () => false
  },
  "collaboration.load_shared_source_page": {
    scope: "team",
    desktopOperationFamily: read
  },
  "collaboration.create_invitation": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.list_invitations": {
    scope: "team",
    desktopOperationFamily: read
  },
  "collaboration.revoke_invitation": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.update_member_role": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.disable_member": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.leave_team": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.archive_workspace": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.restore_workspace": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.set_workspace_access": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.list_owned_shared_memory_grants": {
    scope: "team",
    desktopOperationFamily: read
  },
  "collaboration.list_owned_shares": {
    scope: "team",
    desktopOperationFamily: read
  },
  "collaboration.get_owned_share": {
    scope: "team",
    desktopOperationFamily: read
  },
  "collaboration.control_pending_share": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.share_conversation_source": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.revoke_conversation_source": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.prepare_shared_memory_source": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.pause_shared_memory_sync": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.resume_shared_memory_sync": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.revoke_shared_memory_sync": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.preview_shared_memory_candidate": {
    scope: "personal",
    desktopOperationFamily: read
  },
  "collaboration.preview_shared_memory": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.load_shared_memory_preview_page": {
    scope: "team",
    desktopOperationFamily: read
  },
  "collaboration.share_memory": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.revoke_shared_memory": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.change_shared_memory_fidelity": {
    scope: "team",
    desktopOperationFamily: write
  },
  "collaboration.subscribe": {
    scope: (command) => command.input.scope.scope,
    desktopOperationFamily: read
  },
  "collaboration.unsubscribe": {
    scope: "unsupported",
    desktopOperationFamily: write
  },
  "collaboration.acknowledge_delivery": {
    scope: "unsupported",
    desktopOperationFamily: write
  }
} satisfies CollaborationCommandRegistry;

const descriptorFor = <Command extends CollaborationRendererCommand>(
  command: Command
): CollaborationCommandDescriptor<Command["command"]> =>
  collaborationCommandRegistry[
    command.command
  ] as CollaborationCommandDescriptor<Command["command"]>;

export const collaborationCommandScope = (
  command: CollaborationRendererCommand
): CollaborationCommandScope | "unsupported" => {
  const scope = descriptorFor(command).scope;
  return typeof scope === "function" ? scope(command) : scope;
};

export const desktopCollaborationOperationFamily = (
  command: CollaborationRendererCommand
): DesktopCollaborationOperationFamily =>
  descriptorFor(command).desktopOperationFamily;

export const personalCollaborationOperationFor = (
  command: CollaborationRendererCommand
): PersonalCollaborationUpstreamOperation | null => {
  if (collaborationCommandScope(command) !== "personal") return null;
  const operation = descriptorFor(command).personalOperation;
  return operation ? operation(command) : null;
};

export const teamCollaborationOperationFor = (
  command: CollaborationRendererCommand
): TeamCollaborationUpstreamOperation | null => {
  if (collaborationCommandScope(command) !== "team") return null;
  const operation = descriptorFor(command).teamOperation;
  return operation ? operation(command) : null;
};

export const teamCollaborationResultMatchesCommand = (
  command: CollaborationRendererCommand,
  value: unknown
): boolean => {
  if (command.command === "collaboration.report_team_activity") {
    return (
      Array.isArray(value) &&
      value.every(
        (teamId) =>
          typeof teamId === "string" && command.input.teamIds.includes(teamId)
      )
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const matcher = descriptorFor(command).matchesTeamResult;
  return matcher ? matcher(command, value as Record<string, unknown>) : false;
};
