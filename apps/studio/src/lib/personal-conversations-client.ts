import {
  personalAgentChatCancelResponseSchema,
  personalAgentChatConversationPageSchema,
  personalAgentChatContinueResponseSchema,
  personalAgentChatReadResponseSchema,
  personalAgentChatSubmitResponseSchema,
  type PersonalAgentChatConversationSummary,
  type PersonalAgentChatSubmit
} from "@koed/shared/personal-agent-chat-contract";

export class PersonalConversationError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "PersonalConversationError";
    this.status = status;
    this.code = code;
  }
}

function isHostedStudio(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname;
  return (
    process.env.NEXT_PUBLIC_KOED_STUDIO_HOSTED === "1" ||
    path === "/studio" ||
    path.startsWith("/studio/")
  );
}

async function request(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  method?: "POST" | "PATCH"
): Promise<Record<string, unknown>> {
  const hosted = isHostedStudio();
  const prefix = hosted
    ? "/v1/personal-conversations"
    : "/studio-api/personal-conversations";
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (body !== undefined && !hosted) {
    const session = await fetch("/studio-api/github/session", {
      cache: "no-store",
      signal
    });
    const sessionPayload: unknown = await session.json().catch(() => null);
    if (
      !session.ok ||
      !isRecord(sessionPayload) ||
      typeof sessionPayload.csrfToken !== "string"
    ) {
      throw new PersonalConversationError(
        "Studio session is unavailable. Refresh before sending."
      );
    }
    headers["x-studio-csrf"] = sessionPayload.csrfToken;
  }
  const response = await fetch(`${prefix}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    credentials: "include",
    signal
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope =
      isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    throw new PersonalConversationError(
      envelope && typeof envelope.message === "string"
        ? envelope.message
        : isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : "The Personal conversation request failed.",
      response.status,
      envelope && typeof envelope.code === "string" ? envelope.code : undefined
    );
  }
  if (!isRecord(payload))
    throw new PersonalConversationError(
      "The Personal conversation service returned an invalid response."
    );
  return payload;
}

export async function renamePersonalConversation(
  conversationId: string,
  title: string | null,
  requestId: string,
  signal?: AbortSignal
) {
  return personalAgentChatReadResponseSchema.parse(
    await request(
      `/${encodeURIComponent(conversationId)}`,
      { requestId, title },
      signal,
      "PATCH"
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function listPersonalConversations(
  signal?: AbortSignal
): Promise<PersonalAgentChatConversationSummary[]> {
  const payload = personalAgentChatConversationPageSchema.parse(
    await request("", undefined, signal)
  );
  return payload.conversations;
}

export async function readPersonalConversation(
  conversationId: string,
  options: {
    beforeSequence?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {}
) {
  const query = new URLSearchParams();
  if (options.beforeSequence !== undefined)
    query.set("beforeSequence", String(options.beforeSequence));
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const suffix = query.size ? `?${query.toString()}` : "";
  return personalAgentChatReadResponseSchema.parse(
    await request(
      `/${encodeURIComponent(conversationId)}${suffix}`,
      undefined,
      options.signal
    )
  );
}

export async function submitPersonalConversationMessage(
  conversationId: string,
  input: PersonalAgentChatSubmit,
  signal?: AbortSignal
) {
  const response = personalAgentChatSubmitResponseSchema.parse(
    await request(
      `/${encodeURIComponent(conversationId)}/messages`,
      input,
      signal
    )
  );
  return response;
}

export async function cancelPersonalConversationMessage(
  conversationId: string,
  messageId: string,
  requestId: string,
  signal?: AbortSignal
) {
  return personalAgentChatCancelResponseSchema.parse(
    await request(
      `/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/cancel`,
      { requestId },
      signal
    )
  );
}

export async function continuePersonalConversationMessage(
  conversationId: string,
  messageId: string,
  requestId: string,
  skipFailedDeliveryId: string,
  signal?: AbortSignal
) {
  return personalAgentChatContinueResponseSchema.parse(
    await request(
      `/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/continue`,
      { requestId, skipFailedDeliveryId },
      signal
    )
  );
}
