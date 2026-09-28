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
  type CollaborationSnapshot
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

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "StudioCollaborationRequestError";
    this.status = status;
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const wait = (signal: AbortSignal, duration = 1_000) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, duration);
    signal.addEventListener("abort", finish, { once: true });
  });

const MAX_EVENT_FRAME_BYTES = 2 * 1024 * 1024;

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
        failure.error.code
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
    listener: (event: CollaborationRendererEvent) => void,
    onSnapshot?: (snapshot: CollaborationSnapshot) => void
  ): () => void {
    const controller = new AbortController();
    const dispatch = (event: unknown) => {
      const parsed = collaborationRendererEventSchema.safeParse(event);
      if (parsed.success) listener(parsed.data);
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
          if (!controller.signal.aborted) {
            const snapshot = await this.loadSession().catch(() => null);
            if (snapshot) onSnapshot?.(snapshot);
          }
        } catch {
          if (!controller.signal.aborted) await wait(controller.signal);
        }
      }
    };
    void connect();
    return () => controller.abort();
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
