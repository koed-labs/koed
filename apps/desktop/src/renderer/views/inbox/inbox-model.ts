import type {
  CollaborationDurableSend,
  CollaborationSelection,
  CollaborationSnapshot
} from "@koed/shared/collaboration";

export type InboxUnreadItem = {
  context: string;
  count: number;
  id: string;
  selection: CollaborationSelection;
  title: string;
};

export type InboxOutboxItem = {
  context: string;
  id: string;
  send: CollaborationDurableSend;
  title: string;
};

export type InboxSharedMemoryConflict = {
  context: string;
  description: string;
  id: string;
  selection: CollaborationSelection;
  title: string;
};

export type InboxConnectionFault = {
  description: string;
  id: string;
  title: string;
};

export type InboxModel = {
  connectionFaults: InboxConnectionFault[];
  failedOutbox: InboxOutboxItem[];
  queuedOutbox: InboxOutboxItem[];
  sharedMemoryConflicts: InboxSharedMemoryConflict[];
  unread: InboxUnreadItem[];
};

const threadTitle = (
  thread: {
    kind: string;
    name: string | null;
    participants?: readonly { displayName: string }[];
  },
  fallback: string
): string => {
  if (thread.kind === "notes_to_self") return "Notes to self";
  if (thread.name) return thread.name;
  if (thread.participants?.length) {
    return thread.participants.map(({ displayName }) => displayName).join(", ");
  }
  return fallback;
};

const outboxStateLabel = (
  send: CollaborationDurableSend
): { context: string; title: string } => {
  switch (send.state) {
    case "queued":
      return { title: "Message queued", context: "Waiting for connection" };
    case "manual_retry":
      return {
        title: "Message needs retry",
        context: send.failure?.userMessage ?? "Delivery did not complete"
      };
    case "failed":
      return {
        title: "Message failed",
        context: send.failure?.userMessage ?? "Delivery failed"
      };
    case "sent":
      return { title: "Message sent", context: "Delivered" };
  }
};

export const inboxModelFromSnapshot = (
  snapshot: CollaborationSnapshot
): InboxModel => {
  const unread: InboxUnreadItem[] = [];
  const sharedMemoryConflicts: InboxSharedMemoryConflict[] = [];
  const authorizedThreads = new Map<
    string,
    { context: string; title: string }
  >();

  const addUnread = (
    thread: {
      id: string;
      kind: string;
      name: string | null;
      participants?: readonly { displayName: string }[];
      unreadCount: number;
    },
    context: string,
    selection: CollaborationSelection,
    fallback: string
  ) => {
    const title = threadTitle(thread, fallback);
    authorizedThreads.set(thread.id, { title, context });
    if (thread.unreadCount <= 0) return;
    unread.push({
      id: `unread:${thread.id}`,
      title,
      context,
      count: thread.unreadCount,
      selection
    });
  };

  addUnread(
    snapshot.navigation.personal.notesToSelf,
    "Personal",
    { kind: "notes_to_self" },
    "Notes to self"
  );
  for (const thread of snapshot.navigation.personal.channels) {
    addUnread(
      thread,
      "Personal channel",
      { kind: "personal_channel", threadId: thread.id },
      "Personal channel"
    );
  }

  for (const team of snapshot.navigation.teams) {
    for (const thread of team.directMessages) {
      addUnread(
        thread,
        team.name,
        {
          kind: "team_direct_message",
          teamId: team.id,
          threadId: thread.id
        },
        "Direct message"
      );
    }
    for (const workspace of team.workspaces) {
      const context = `${team.name} · ${workspace.name}`;
      for (const thread of workspace.channels) {
        addUnread(
          thread,
          context,
          {
            kind: "workspace_channel",
            teamId: team.id,
            workspaceId: workspace.id,
            threadId: thread.id
          },
          "Team channel"
        );
      }
      for (const session of workspace.sharedMemory) {
        const selection: CollaborationSelection = {
          kind: "shared_session",
          teamId: team.id,
          workspaceId: workspace.id,
          sharedSessionId: session.id
        };
        authorizedThreads.set(session.companionThreadId, {
          title: `${session.title} discussion`,
          context
        });
        if (session.unreadCompanionCount > 0) {
          unread.push({
            id: `unread:${session.companionThreadId}`,
            title: `${session.title} discussion`,
            context,
            count: session.unreadCompanionCount,
            selection
          });
        }
        const sourceConflict =
          session.sourceState === "unavailable" ||
          session.sourceState === "permission_denied";
        if (sourceConflict) {
          sharedMemoryConflicts.push({
            id: `shared-memory:${session.id}`,
            title: session.title,
            context,
            description:
              session.sourceState === "permission_denied"
                ? "Current access no longer permits this shared source."
                : "The authorized shared source is unavailable.",
            selection
          });
        }
      }
    }
  }

  const failedOutbox: InboxOutboxItem[] = [];
  const queuedOutbox: InboxOutboxItem[] = [];
  for (const send of snapshot.outbox ?? []) {
    if (send.state === "sent") continue;
    const thread = authorizedThreads.get(send.authority.threadId);
    if (!thread) continue;
    if (
      send.authority.scope === "personal" &&
      send.authority.ownerUserId !== snapshot.navigation.personalOwner.id
    ) {
      continue;
    }
    if (
      send.authority.scope === "team" &&
      (send.authority.principalUserId !==
        snapshot.navigation.teamPrincipal?.id ||
        send.authority.backendId !== snapshot.connection.backendId)
    ) {
      continue;
    }
    const state = outboxStateLabel(send);
    const item = {
      id: `outbox:${send.clientMessageId}`,
      title: `${state.title} in ${thread.title}`,
      context: state.context,
      send
    };
    if (send.state === "queued") queuedOutbox.push(item);
    else failedOutbox.push(item);
  }

  const connectionFaults: InboxConnectionFault[] = [];
  switch (snapshot.connection.state) {
    case "access_revoked":
      connectionFaults.push({
        id: "connection:access-revoked",
        title: "Team access was revoked",
        description:
          "Team state was removed from this device. Review Team Connection before reconnecting."
      });
      break;
    case "unavailable":
      connectionFaults.push({
        id: "connection:unavailable",
        title: "Team Backend is unavailable",
        description: "Reconnect when the remote Team Backend is reachable."
      });
      break;
    case "reconnecting":
      connectionFaults.push({
        id: "connection:reconnecting",
        title: "Reconnecting to Team Backend",
        description: snapshot.connection.retryAt
          ? `The next retry is scheduled for ${new Date(snapshot.connection.retryAt).toLocaleString()}.`
          : "Koed is retrying the authorized Team connection."
      });
      break;
    case "disconnected":
      if (snapshot.connection.backendId) {
        connectionFaults.push({
          id: "connection:disconnected",
          title: "Team Backend is disconnected",
          description: "Reconnect or remove the saved Team Connection."
        });
      }
      break;
    case "connecting":
    case "live":
      break;
  }

  return {
    connectionFaults,
    failedOutbox,
    queuedOutbox,
    sharedMemoryConflicts,
    unread
  };
};
