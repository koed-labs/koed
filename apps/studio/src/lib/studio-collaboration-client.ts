"use client";

import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationRendererEventSchema,
  collaborationSnapshotSchema,
  type CollaborationCommandResult,
  type CollaborationRendererCommand,
  type CollaborationRendererEvent,
  type CollaborationSnapshot,
  type CollaborationSubscription
} from "@koed/shared/collaboration";

export type StudioTeamDraftAuthority = {
  backendId: string;
  principalUserId: string;
  teamId: string;
  threadId: string;
};

export type StudioTeamDraft = {
  text: string;
  pendingSend: {
    clientMessageId: string;
    body: string;
    createdAt: string;
  } | null;
  updatedAt?: string;
};

export class StudioCollaborationRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(message: string, status: number, code: string | null = null, retryable = status === 429 || status >= 500) {
    super(message);
    this.name = "StudioCollaborationRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const wait = (signal: AbortSignal, duration = 1_000) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, duration);
    signal.addEventListener("abort", finish, { once: true });
  });

const MAX_EVENT_FRAME_BYTES = 2 * 1024 * 1024;

export const canApplySubscriptionSnapshot = (input: {
  currentVersion: number | null;
  snapshotVersion: number;
  alreadyAcknowledged: boolean;
}): boolean => !input.alreadyAcknowledged &&
  (input.currentVersion === null || input.snapshotVersion >= input.currentVersion);

export class StudioCollaborationClient {
  private readonly fetcher: typeof fetch;
  private csrfToken: string | null = null;
  private currentSnapshot: CollaborationSnapshot | null = null;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher.bind(globalThis);
  }

  current(): CollaborationSnapshot | null {
    return this.currentSnapshot;
  }

  async loadSession(): Promise<CollaborationSnapshot> {
    const response = await this.fetcher(
      "/studio-api/collaboration/studio-session",
      {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin"
      }
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new StudioCollaborationRequestError(
        "Team connection is temporarily unavailable.",
        response.status,
        isRecord(body) && typeof body.error === "string" ? body.error : null
      );
    }
    const snapshot = collaborationSnapshotSchema.safeParse(
      isRecord(body) ? body.snapshot : null
    );
    if (
      !snapshot.success ||
      !isRecord(body) ||
      typeof body.csrfToken !== "string"
    ) {
      throw new StudioCollaborationRequestError(
        "Koed returned invalid Team state.",
        502
      );
    }
    this.csrfToken = body.csrfToken;
    this.currentSnapshot = snapshot.data;
    return snapshot.data;
  }

  async command(
    command: CollaborationRendererCommand
  ): Promise<CollaborationCommandResult> {
    const validCommand = collaborationRendererCommandSchema.parse(command);
    const token = this.csrfToken ?? (await this.loadSession(), this.csrfToken);
    if (!token) throw new StudioCollaborationRequestError("Team session expired.", 403);
    const response = await this.fetcher(
      "/studio-api/collaboration/command",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-studio-csrf": token
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(validCommand)
      }
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 403) this.csrfToken = null;
      throw new StudioCollaborationRequestError(
        response.status === 403
          ? "Team access changed. Refresh to check access."
          : "Team connection is temporarily unavailable.",
        response.status,
        isRecord(body) && typeof body.error === "string" ? body.error : null
      );
    }
    const result = collaborationCommandResultSchema.safeParse(body);
    if (
      !result.success ||
      result.data.requestId !== validCommand.requestId ||
      result.data.command !== validCommand.command
    ) {
      throw new StudioCollaborationRequestError(
        "Koed returned an invalid Team command result.",
        502
      );
    }
    if (!result.data.ok) {
      const failure = result.data;
      throw new StudioCollaborationRequestError(
        failure.error.userMessage,
        409,
        failure.error.code,
        failure.error.retryable
      );
    }
    if ("snapshot" in result.data.data) {
      this.currentSnapshot = result.data.data.snapshot;
    }
    return result.data;
  }

  async run(
    command: CollaborationRendererCommand["command"],
    input: Record<string, unknown>,
    requestId: string = crypto.randomUUID()
  ): Promise<CollaborationCommandResult> {
    return await this.command({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId,
      command,
      input
    } as CollaborationRendererCommand);
  }

  subscribe(
    listener: (event: CollaborationRendererEvent) => void | boolean | Promise<void | boolean>,
    onSnapshot: ((snapshot: CollaborationSnapshot) => void | Promise<void>) | undefined,
    teamId: string
  ): () => void {
    const controller = new AbortController();
    let resolveStreamReady!: (ready: boolean) => void;
    const streamReady = new Promise<boolean>((resolve) => { resolveStreamReady = resolve; });
    let resolveSubscriptionReady!: (subscription: CollaborationSubscription | null) => void;
    let subscriptionReady: Promise<CollaborationSubscription | null>;
    const resetSubscriptionReady = () => {
      subscriptionReady = new Promise<CollaborationSubscription | null>((resolve) => { resolveSubscriptionReady = resolve; });
    };
    resetSubscriptionReady();
    let subscription: CollaborationSubscription | null = null;
    let stopped = false;
    let subscriptionRevoked = false;
    let eventTail: Promise<void> = Promise.resolve();
    const seenDeliveries = new Set<string>();
    const deliveryOrder: string[] = [];
    let streamOpenedBefore = false;
    const releaseSubscription = (id: string) => {
      void this.run("collaboration.unsubscribe", { subscriptionId: id }).catch(() => undefined);
    };
    const acknowledge = async (event: Extract<CollaborationRendererEvent, { type: "snapshot" | "update" }>) => {
      if (!subscription) return;
      const subscriptionId = subscription.id;
      const result = await this.run("collaboration.acknowledge_delivery", {
        subscriptionId,
        deliveryId: event.deliveryId,
        eventId: event.eventId,
        expectedSubscriptionVersion: event.type === "snapshot" ? event.subscription.version : subscription.version
      });
      if (result.ok && result.command === "collaboration.acknowledge_delivery" && result.data.subscriptionId === subscriptionId && subscription?.id === subscriptionId) {
        subscription = { ...subscription, state: "active", version: result.data.subscriptionVersion };
        seenDeliveries.add(event.deliveryId);
        deliveryOrder.push(event.deliveryId);
        while (deliveryOrder.length > 512) seenDeliveries.delete(deliveryOrder.shift()!);
      }
    };
    const deliver = async (event: CollaborationRendererEvent) => {
      if (stopped || controller.signal.aborted) return;
      if (event.type === "connection") {
        await listener(event);
        if (event.connection.state === "access_revoked") {
          subscriptionRevoked = true;
          const current = subscription;
          subscription = null;
          resolveSubscriptionReady(null);
          if (current) releaseSubscription(current.id);
        }
        return;
      }
      if (event.type === "control") {
        const current = subscription;
        if (!current || event.subscriptionId !== current.id) return;
        try { await listener(event); } catch { /* Renewal must proceed even if the UI could not refresh. */ }
        if (event.reason === "access_revoked") {
          subscriptionRevoked = true;
          subscription = null;
          resolveSubscriptionReady(null);
          return;
        }
        if (event.reason === "requires_snapshot" || event.reason === "backpressure") {
          subscription = null;
          releaseSubscription(current.id);
          resetSubscriptionReady();
          void startSubscription();
        }
        return;
      }
      const activeSubscription = await subscriptionReady;
      if (!activeSubscription || stopped || subscriptionRevoked || controller.signal.aborted || subscription?.id !== activeSubscription.id) return;
      if (event.type === "snapshot") {
        if (event.subscription.id !== activeSubscription.id || event.subscription.scope.scope !== "team" || event.subscription.scope.teamId !== teamId) return;
        if (!canApplySubscriptionSnapshot({ currentVersion: subscription?.version ?? null, snapshotVersion: event.subscription.version, alreadyAcknowledged: seenDeliveries.has(event.deliveryId) })) return;
        subscription = event.subscription;
      } else if (event.type === "update") {
        if (event.subscriptionId !== activeSubscription.id || !subscription || subscription.state !== "active") return;
      } else {
        await listener(event);
        return;
      }
      if (seenDeliveries.has(event.deliveryId)) return;
      const applied = await listener(event);
      if (applied === false) return;
      if (stopped || controller.signal.aborted) return;
      await acknowledge(event);
    };
    const dispatch = (event: unknown) => {
      const parsed = collaborationRendererEventSchema.safeParse(event);
      if (!parsed.success) return;
      eventTail = eventTail.then(() => deliver(parsed.data)).catch(() => undefined);
    };
    const startSubscription = async () => {
      const ready = await streamReady;
      if (!ready || stopped || controller.signal.aborted) { resolveSubscriptionReady(null); return; }
      while (!stopped && !subscriptionRevoked && !controller.signal.aborted) {
        try {
          const result = await this.run("collaboration.subscribe", { scope: { scope: "team", teamId } });
          if (stopped || subscriptionRevoked || controller.signal.aborted) {
            if (result.ok && result.command === "collaboration.subscribe") releaseSubscription(result.data.subscription.id);
            resolveSubscriptionReady(null);
            return;
          }
          if (!result.ok) {
            if (result.error.retryable) {
              await wait(controller.signal, result.error.retryAfterMs ?? 1_000);
              continue;
            }
            resolveSubscriptionReady(null);
            return;
          }
          if (result.command !== "collaboration.subscribe" || result.data.subscription.scope.scope !== "team" || result.data.subscription.scope.teamId !== teamId) {
            resolveSubscriptionReady(null);
            return;
          }
          const created = result.data.subscription;
          if (stopped || controller.signal.aborted) {
            releaseSubscription(created.id);
            resolveSubscriptionReady(null);
            return;
          }
          subscription = created;
          resolveSubscriptionReady(created);
          return;
        } catch (failure) {
          const retryable = !(failure instanceof StudioCollaborationRequestError) || failure.retryable;
          if (!retryable) {
            resolveSubscriptionReady(null);
            const snapshot = await this.loadSession().catch(() => null);
            if (snapshot && !stopped) await onSnapshot?.(snapshot);
            return;
          }
          await wait(controller.signal);
        }
      }
      resolveSubscriptionReady(null);
    };
    const connect = async () => {
      while (!controller.signal.aborted) {
        try {
          if (!this.csrfToken) await this.loadSession();
          const response = await this.fetcher(
            "/studio-api/collaboration/events",
            {
              method: "GET",
              headers: { accept: "text/event-stream", "x-studio-csrf": this.csrfToken ?? "" },
              credentials: "same-origin",
              cache: "no-store",
              signal: controller.signal
            }
          );
          if (!response.ok || !response.body) {
            if (response.status === 403) this.csrfToken = null;
            await wait(controller.signal);
            continue;
          }
          if (streamOpenedBefore && !controller.signal.aborted) {
            const snapshot = await this.loadSession().catch(() => null);
            if (snapshot && !stopped) {
              try { await onSnapshot?.(snapshot); } catch { /* The next reconnect or durable delivery can retry catch-up. */ }
            }
          }
          streamOpenedBefore = true;
          resolveStreamReady(true);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let data: string[] = [];
          let frameBytes = 0;
          while (!controller.signal.aborted) {
            const part = await reader.read();
            if (part.done) break;
            buffer += decoder.decode(part.value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line === "") {
                if (data.length) {
                  try {
                    dispatch(JSON.parse(data.join("\n")));
                  } catch {
                    // Ignore malformed broker frames and retain the stream.
                  }
                  data = [];
                }
                frameBytes = 0;
              } else if (line.startsWith("data:")) {
                frameBytes += new TextEncoder().encode(line).byteLength;
                if (frameBytes > MAX_EVENT_FRAME_BYTES) {
                  data = [];
                  buffer = "";
                  await reader.cancel().catch(() => undefined);
                  break;
                }
                data.push(line.slice(5).trimStart());
              }
            }
            if (buffer.length > MAX_EVENT_FRAME_BYTES) {
              buffer = "";
              data = [];
              await reader.cancel().catch(() => undefined);
              break;
            }
          }
          await reader.cancel().catch(() => undefined);
        } catch {
          if (!controller.signal.aborted) await wait(controller.signal);
        }
      }
    };
    void connect();
    void startSubscription();
    return () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      resolveStreamReady(false);
      resolveSubscriptionReady(null);
      const active = subscription;
      subscription = null;
      if (active) releaseSubscription(active.id);
    };
  }

  async loadDraft(authority: StudioTeamDraftAuthority): Promise<StudioTeamDraft | null> {
    const body = await this.draftRequest({ action: "load", authority });
    if (body.draft === null) return null;
    if (!isRecord(body.draft) || typeof body.draft.text !== "string") {
      throw new StudioCollaborationRequestError("Stored draft is invalid.", 502);
    }
    return body.draft as StudioTeamDraft;
  }

  async saveDraft(
    authority: StudioTeamDraftAuthority,
    draft: StudioTeamDraft
  ): Promise<void> {
    await this.draftRequest({ action: "save", authority, draft });
  }

  async deleteDraft(authority: StudioTeamDraftAuthority): Promise<void> {
    await this.draftRequest({ action: "delete", authority });
  }

  private async draftRequest(
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const token = this.csrfToken ?? (await this.loadSession(), this.csrfToken);
    if (!token) throw new StudioCollaborationRequestError("Team session expired.", 403);
    const response = await this.fetcher(
      "/studio-api/collaboration/team-draft",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-studio-csrf": token
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(payload)
      }
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body)) {
      if (response.status === 403) this.csrfToken = null;
      throw new StudioCollaborationRequestError(
        "Studio could not access the device draft store.",
        response.status,
        isRecord(body) && typeof body.error === "string" ? body.error : null
      );
    }
    return body;
  }
}
