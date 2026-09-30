import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationRealtimeCursorSchema,
  collaborationRealtimeEventFamilySchema,
  collaborationRendererUpdateSchema,
  collaborationTimestampSchema,
  collaborationThreadSchema,
  collaborationPersonSchema,
  collaborationMessageSchema,
  collaborationTeamSharedProjectSchema,
  type CollaborationMessage,
  type CollaborationPerson,
  type CollaborationThread,
  type CollaborationTeamSharedProject
} from "@koed/shared/collaboration";

export class HostedTeamRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "HostedTeamRequestError";
  }
}

export type HostedTeamPerson = Omit<CollaborationPerson, "presence">;
export type HostedTeamSendReceipt = {
  message: CollaborationMessage;
  acceptedBody: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hostedTeamPersonSchema = collaborationPersonSchema.omit({
  presence: true
});
const teamRealtimeEvent = (
  value: unknown,
  teamId: string,
  subscriptionId: string
) => {
  if (
    !record(value) ||
    value.protocolVersion !== COLLABORATION_CONTRACT_VERSION ||
    !uuid.test(String(value.eventId)) ||
    !record(value.subscription) ||
    value.subscription.id !== subscriptionId
  )
    return null;
  if (
    typeof value.cursor !== "string" ||
    !collaborationRealtimeCursorSchema.safeParse(value.cursor).success
  )
    return null;
  if (
    !collaborationTimestampSchema.safeParse(value.occurredAt).success ||
    !collaborationRealtimeEventFamilySchema.safeParse(value.type).success
  )
    return null;
  if (
    !record(value.resource) ||
    value.resource.scope !== "team" ||
    value.resource.teamId !== teamId ||
    typeof value.resource.type !== "string" ||
    typeof value.resource.id !== "string"
  )
    return null;
  if (
    value.resource.threadId !== null &&
    value.resource.threadId !== undefined &&
    typeof value.resource.threadId !== "string"
  )
    return null;
  if (
    !record(value.actor) ||
    (value.actor.principalId !== null &&
      typeof value.actor.principalId !== "string")
  )
    return null;
  if (!collaborationRendererUpdateSchema.safeParse(value.update).success)
    return null;
  return value;
};

const teamThread = (
  value: unknown,
  teamId: string
): CollaborationThread | null => {
  if (
    !record(value) ||
    value.scope !== "team" ||
    value.teamId !== teamId ||
    typeof value.id !== "string"
  )
    return null;
  const base = {
    id: value.id,
    logicalId: value.logicalId,
    scope: "team",
    teamId,
    name: value.name,
    topic: value.topic,
    version: value.version,
    lifecycle: value.lifecycle,
    canPost: value.lifecycle === "active",
    latestSequence: value.latestSequence,
    unreadCount: value.unreadCount,
    lastReadMessageId: value.lastReadMessageId,
    lastReadSequence: value.lastReadSequence,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastActivityAt: value.lastActivityAt,
    archivedAt: value.archivedAt
  };
  const participants = Array.isArray(value.participants)
    ? value.participants.map((participant) => {
        if (!record(participant)) return participant;
        return {
          id: participant.userId,
          displayName:
            typeof participant.displayName === "string" &&
            participant.displayName.trim()
              ? participant.displayName
              : "Team member",
          membershipState: participant.membershipState
        };
      })
    : value.participants;
  const mapped =
    value.kind === "team_channel"
      ? {
          ...base,
          kind: "team_channel",
          name:
            value.name === null && value.systemKey === "team.general"
              ? "general"
              : value.name,
          systemKey: value.systemKey === "team.general" ? "team.general" : null
        }
      : value.kind === "team_project_channel" &&
          typeof value.teamProjectId === "string"
        ? {
            ...base,
            kind: "team_project_channel",
            teamProjectId: value.teamProjectId
          }
        : value.kind === "dm"
          ? { ...base, kind: "dm", name: null, topic: null, participants }
          : value.kind === "group_dm"
            ? { ...base, kind: "group_dm", participants }
            : null;
  if (!mapped) return null;
  const parsed = collaborationThreadSchema.safeParse(mapped);
  return parsed.success ? parsed.data : null;
};

const teamMessage = (
  value: unknown,
  teamId: string
): CollaborationMessage | null => {
  if (!record(value) || value.scope !== "team" || value.teamId !== teamId)
    return null;
  const mapped = {
    id: value.id,
    threadId: value.threadId,
    scope: "team",
    teamId,
    sequence: value.threadSequence,
    sender: {
      id: value.senderUserId,
      displayName:
        typeof value.senderDisplayName === "string"
          ? value.senderDisplayName
          : "Team member",
      membershipState: "enabled"
    },
    senderKind: "user",
    body: value.bodyText,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    editedAt: value.editedAt ?? null,
    deletedAt: null,
    rootMessageId: value.rootMessageId ?? null,
    version: value.version ?? 1,
    replyCount: value.replyCount ?? 0,
    unreadReplyCount: value.unreadReplyCount ?? 0,
    reactions: Array.isArray(value.reactions) ? value.reactions : [],
    delivery: "sent",
    recipientStatus: value.recipientStatus,
    failure: null
  };
  const parsed = collaborationMessageSchema.safeParse(mapped);
  return parsed.success ? parsed.data : null;
};

export class HostedTeamCollaborationClient {
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher.bind(globalThis);
  }

  async listChannels(teamId: string): Promise<CollaborationThread[]> {
    const response = await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/channels`
    );
    if (!record(response) || !Array.isArray(response.threads)) {
      throw new HostedTeamRequestError(
        "Koed returned invalid Team channels.",
        502
      );
    }
    return response.threads.map((thread) => {
      const parsed = teamThread(thread, teamId);
      if (!parsed || parsed.kind !== "team_channel")
        throw new HostedTeamRequestError(
          "Koed returned invalid Team channels.",
          502
        );
      return parsed;
    });
  }

  async listPeople(teamId: string): Promise<HostedTeamPerson[]> {
    const response = await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/participants`
    );
    if (!record(response) || !Array.isArray(response.participants)) {
      throw new HostedTeamRequestError(
        "Koed returned invalid Team participants.",
        502
      );
    }
    const people = response.participants.map((entry) => {
      if (!record(entry)) return null;
      const parsed = hostedTeamPersonSchema.safeParse({
        id: entry.userId,
        displayName:
          typeof entry.displayName === "string" && entry.displayName.trim()
            ? entry.displayName
            : "Team member",
        membershipState: "enabled"
      });
      return parsed.success ? parsed.data : null;
    });
    if (
      people.some((person) => !person) ||
      new Set(people.map((person) => person?.id)).size !== people.length
    ) {
      throw new HostedTeamRequestError(
        "Koed returned invalid Team participants.",
        502
      );
    }
    return people as HostedTeamPerson[];
  }

  async listDirectMessages(teamId: string): Promise<CollaborationThread[]> {
    const response = await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/direct-messages`
    );
    if (!record(response) || !Array.isArray(response.threads)) {
      throw new HostedTeamRequestError(
        "Koed returned invalid Team direct messages.",
        502
      );
    }
    const threads = response.threads.map((entry) => teamThread(entry, teamId));
    if (
      threads.some(
        (thread) =>
          !thread || (thread.kind !== "dm" && thread.kind !== "group_dm")
      )
    ) {
      throw new HostedTeamRequestError(
        "Koed returned invalid Team direct messages.",
        502
      );
    }
    return threads as CollaborationThread[];
  }

  async startDirectMessage(
    teamId: string,
    participantUserId: string,
    requestId: string
  ): Promise<CollaborationThread> {
    const response = await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/direct-messages`,
      {
        method: "POST",
        headers: { "Idempotency-Key": requestId },
        body: JSON.stringify({ participantUserId })
      }
    );
    const thread = record(response)
      ? teamThread(response.thread, teamId)
      : null;
    if (
      !thread ||
      thread.kind !== "dm" ||
      !thread.participants.some(
        (participant) => participant.id === participantUserId
      )
    ) {
      throw new HostedTeamRequestError(
        "Koed returned an invalid direct message.",
        502
      );
    }
    return thread;
  }

  async startGroupDirectMessage(
    teamId: string,
    participantUserIds: string[],
    requestId: string
  ): Promise<CollaborationThread> {
    const response = await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/group-direct-messages`,
      {
        method: "POST",
        headers: { "Idempotency-Key": requestId },
        body: JSON.stringify({ participantUserIds })
      }
    );
    const thread = record(response)
      ? teamThread(response.thread, teamId)
      : null;
    const requested = new Set(participantUserIds);
    if (
      !thread ||
      thread.kind !== "group_dm" ||
      participantUserIds.length !== requested.size ||
      thread.participants.length !== requested.size + 1 ||
      !participantUserIds.every((id) =>
        thread.participants.some((participant) => participant.id === id)
      )
    ) {
      throw new HostedTeamRequestError(
        "Koed returned an invalid group direct message.",
        502
      );
    }
    return thread;
  }

  async listProjects(
    teamId: string
  ): Promise<
    Array<CollaborationTeamSharedProject & { thread: CollaborationThread }>
  > {
    const response = await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/projects`
    );
    if (!record(response) || !Array.isArray(response.projects)) {
      throw new HostedTeamRequestError(
        "Koed returned invalid Shared Projects.",
        502
      );
    }
    return response.projects.map((entry) => {
      if (!record(entry))
        throw new HostedTeamRequestError(
          "Koed returned invalid Shared Projects.",
          502
        );
      const project = collaborationTeamSharedProjectSchema.safeParse({
        id: entry.id,
        teamId: entry.teamId,
        name: entry.name
      });
      const thread = teamThread(entry.thread, teamId);
      if (!project.success || project.data.teamId !== teamId || !thread) {
        throw new HostedTeamRequestError(
          "Koed returned invalid Shared Projects.",
          502
        );
      }
      if (
        thread.kind !== "team_project_channel" ||
        thread.teamProjectId !== project.data.id
      ) {
        throw new HostedTeamRequestError(
          "Koed returned invalid Shared Projects.",
          502
        );
      }
      return { ...project.data, thread };
    });
  }

  async loadMessages(
    teamId: string,
    threadId: string,
    beforeSequence: number | null = null,
    limit = 50,
    rootMessageId: string | null = null
  ): Promise<{
    items: CollaborationMessage[];
    hasOlder: boolean;
    nextBeforeSequence: number | null;
  }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (beforeSequence !== null)
      query.set("beforeSequence", String(beforeSequence));
    if (rootMessageId !== null) query.set("rootMessageId", rootMessageId);
    const response = await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/threads/${encodeURIComponent(threadId)}/messages?${query}`
    );
    if (
      !record(response) ||
      !Array.isArray(response.messages) ||
      typeof response.hasMore !== "boolean"
    ) {
      throw new HostedTeamRequestError(
        "Koed returned invalid channel history.",
        502
      );
    }
    const items = response.messages.map((message) =>
      teamMessage(message, teamId)
    );
    if (items.some((message) => !message || message.threadId !== threadId))
      throw new HostedTeamRequestError(
        "Koed returned invalid channel history.",
        502
      );
    return {
      items: items as CollaborationMessage[],
      hasOlder: response.hasMore,
      nextBeforeSequence: Number.isSafeInteger(response.nextBeforeSequence)
        ? (response.nextBeforeSequence as number)
        : null
    };
  }

  async sendMessage(
    teamId: string,
    threadId: string,
    bodyText: string,
    clientMessageId: string,
    rootMessageId: string | null = null
  ): Promise<HostedTeamSendReceipt> {
    const response = await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: "POST",
        headers: { "Idempotency-Key": clientMessageId },
        body: JSON.stringify({ bodyText, rootMessageId })
      }
    );
    if (!record(response) || !record(response.message)) {
      throw new HostedTeamRequestError(
        "Koed returned an invalid sent message.",
        502
      );
    }
    const message = teamMessage(response.message, teamId);
    if (!message || message.threadId !== threadId)
      throw new HostedTeamRequestError(
        "Koed returned an invalid sent message.",
        502
      );
    const acceptedBody =
      typeof response.acceptedBody === "string"
        ? response.acceptedBody
        : message.body;
    return { message, acceptedBody };
  }

  async editMessage(
    teamId: string,
    threadId: string,
    messageId: string,
    bodyText: string,
    expectedVersion: number
  ) {
    const response = await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "PATCH", body: JSON.stringify({ bodyText, expectedVersion }) }
    );
    if (!record(response) || !record(response.message)) {
      throw new HostedTeamRequestError(
        "Koed returned an invalid edited message.",
        502
      );
    }
    const message = teamMessage(response.message, teamId);
    if (!message || message.threadId !== threadId || message.id !== messageId) {
      throw new HostedTeamRequestError(
        "Koed returned an invalid edited message.",
        502
      );
    }
    return message;
  }

  async setMessageReaction(
    teamId: string,
    threadId: string,
    messageId: string,
    emoji: string,
    active: boolean
  ) {
    const response = await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { method: "PUT", body: JSON.stringify({ emoji, active }) }
    );
    if (!record(response) || !record(response.message)) {
      throw new HostedTeamRequestError(
        "Koed returned an invalid message reaction.",
        502
      );
    }
    const message = teamMessage(response.message, teamId);
    if (!message || message.threadId !== threadId || message.id !== messageId) {
      throw new HostedTeamRequestError(
        "Koed returned an invalid message reaction.",
        502
      );
    }
    return message;
  }

  async markRead(
    teamId: string,
    threadId: string,
    messageId: string,
    rootMessageId: string | null = null
  ) {
    await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/threads/${encodeURIComponent(threadId)}/read-state`,
      { method: "PUT", body: JSON.stringify({ messageId, rootMessageId }) }
    );
  }

  async createChannel(
    teamId: string,
    name: string,
    topic: string | null,
    requestId: string
  ) {
    const response = await this.request(
      `/v1/collaboration/teams/${encodeURIComponent(teamId)}/channels`,
      {
        method: "POST",
        headers: { "Idempotency-Key": requestId },
        body: JSON.stringify({ name, topic })
      }
    );
    if (!record(response))
      throw new HostedTeamRequestError(
        "Koed returned an invalid channel.",
        502
      );
    const thread = teamThread(response.thread, teamId);
    if (!thread || thread.kind !== "team_channel") {
      throw new HostedTeamRequestError(
        "Koed returned an invalid channel.",
        502
      );
    }
    return thread;
  }

  subscribeTeam(
    teamId: string,
    listener: (event: Record<string, unknown>) => void | Promise<void>,
    onRevoked: () => void,
    onConnectionChange?: (connected: boolean) => void
  ): () => void {
    const controller = new AbortController();
    const clientInstanceId = crypto.randomUUID();
    const subscriptionKey = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("");
    let cursor: string | null = null;
    let subscriptionId: string | null = null;
    let isConnected = false;
    const reportConnection = (connected: boolean) => {
      if (isConnected === connected) return;
      isConnected = connected;
      onConnectionChange?.(connected);
    };
    reportConnection(false);
    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        if (controller.signal.aborted) return resolve();
        const timer = setTimeout(finish, ms);
        function finish() {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", finish);
          resolve();
        }
        controller.signal.addEventListener("abort", finish, { once: true });
      });
    const post = async (path: string, body: unknown) => {
      const response = await this.fetcher(path, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw new HostedTeamRequestError(
          "Team access could not be renewed.",
          response.status
        );
      return payload;
    };
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          if (!cursor || !subscriptionId) {
            const opened = await post("/v1/collaboration/realtime/snapshot", {
              scope: "team",
              teamId,
              clientInstanceId,
              subscriptionKey
            });
            if (
              !record(opened) ||
              opened.protocolVersion !== COLLABORATION_CONTRACT_VERSION ||
              typeof opened.cursor !== "string" ||
              !collaborationRealtimeCursorSchema.safeParse(opened.cursor)
                .success ||
              !record(opened.subscription) ||
              typeof opened.subscription.id !== "string" ||
              !uuid.test(opened.subscription.id) ||
              !record(opened.snapshot) ||
              opened.snapshot.scope !== "team" ||
              opened.snapshot.teamId !== teamId
            )
              throw new HostedTeamRequestError(
                "Koed returned invalid realtime state.",
                502
              );
            cursor = opened.cursor;
            subscriptionId = opened.subscription.id;
          }
          const query = new URLSearchParams({
            scope: "team",
            teamId,
            clientInstanceId,
            subscriptionKey,
            cursor
          });
          const response = await this.fetcher(
            `/v1/collaboration/realtime/stream?${query}`,
            {
              credentials: "include",
              cache: "no-store",
              signal: controller.signal,
              headers: { accept: "text/event-stream", "Last-Event-ID": cursor }
            }
          );
          if (!response.ok || !response.body) {
            if (response.status === 401 || response.status === 403) {
              reportConnection(false);
              onRevoked();
              return;
            }
            throw new HostedTeamRequestError(
              "Realtime stream is unavailable.",
              response.status
            );
          }
          reportConnection(true);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let data: string[] = [];
          let eventName = "message";
          let frameBytes = 0;
          let oversized = false;
          const flush = async () => {
            if (eventName === "ready") {
              let ready: unknown;
              try {
                ready = JSON.parse(data.join("\n"));
              } catch {
                ready = null;
              }
              if (
                record(ready) &&
                ready.protocolVersion === COLLABORATION_CONTRACT_VERSION &&
                record(ready.subscription) &&
                ready.subscription.id === subscriptionId &&
                typeof ready.cursor === "string" &&
                collaborationRealtimeCursorSchema.safeParse(ready.cursor)
                  .success
              )
                cursor = ready.cursor;
            } else if (eventName === "collaboration_event") {
              let event: unknown;
              try {
                event = JSON.parse(data.join("\n"));
              } catch {
                event = null;
              }
              const parsed = teamRealtimeEvent(
                event,
                teamId,
                subscriptionId ?? ""
              );
              if (parsed) {
                await listener(parsed);
                const acknowledged = await post(
                  "/v1/collaboration/realtime/ack",
                  {
                    subscriptionId,
                    eventId: parsed.eventId,
                    cursor: parsed.cursor,
                    clientInstanceId,
                    subscriptionKey
                  }
                );
                if (!record(acknowledged))
                  throw new HostedTeamRequestError(
                    "Koed returned invalid realtime acknowledgement.",
                    502
                  );
                cursor = parsed.cursor as string;
              }
            } else if (
              eventName === "access_revoked" ||
              eventName === "control"
            ) {
              let control: unknown;
              try {
                control = JSON.parse(data.join("\n"));
              } catch {
                control = null;
              }
              if (
                record(control) &&
                control.protocolVersion === COLLABORATION_CONTRACT_VERSION &&
                record(control.subscription) &&
                control.subscription.id === subscriptionId &&
                (eventName === "access_revoked" ||
                  control.reason === "access_revoked")
              ) {
                onRevoked();
                controller.abort();
                return;
              }
            }
            data = [];
            eventName = "message";
            frameBytes = 0;
          };
          while (!controller.signal.aborted) {
            const next = await reader.read();
            if (next.done) break;
            buffer += decoder.decode(next.value, { stream: true });
            if (new TextEncoder().encode(buffer).byteLength > 2 * 1024 * 1024) {
              oversized = true;
              break;
            }
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line) {
                await flush();
                continue;
              }
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              if (line.startsWith("data:")) {
                frameBytes += new TextEncoder().encode(line).byteLength;
                if (frameBytes > 2 * 1024 * 1024) {
                  oversized = true;
                  break;
                }
                data.push(line.slice(5).trimStart());
              }
            }
            if (oversized) break;
          }
          await reader.cancel().catch(() => undefined);
          reportConnection(false);
          if (oversized) {
            cursor = null;
            subscriptionId = null;
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          reportConnection(false);
          if (
            error instanceof HostedTeamRequestError &&
            (error.status === 401 || error.status === 403)
          ) {
            onRevoked();
            return;
          }
          await delay(1_000);
        }
      }
    };
    void run();
    return () => {
      reportConnection(false);
      controller.abort();
    };
  }

  private async request(
    path: string,
    init: RequestInit = {}
  ): Promise<unknown> {
    const response = await this.fetcher(path, {
      ...init,
      credentials: "include",
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init.headers
      }
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new HostedTeamRequestError(
        record(body) && typeof body.error === "string"
          ? body.error
          : "Team connection is unavailable.",
        response.status
      );
    }
    return body;
  }
}
