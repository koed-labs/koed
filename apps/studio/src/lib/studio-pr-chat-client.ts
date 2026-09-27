"use client";

import type {
  PRChatAdapter,
  PRChatConversation,
  PRChatMessage,
  PRChatResponse,
  PRChatScope
} from "@/components/studio/PRChatPanel";
import type { ChatComposerSelection } from "@/components/ChatComposer";

export class PRChatHttpError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "PRChatHttpError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function safeMessage(value: unknown, fallback: string) {
  if (!isRecord(value)) return fallback;
  const candidate =
    typeof value.message === "string" ? value.message : value.error;
  if (typeof candidate !== "string" || !candidate.trim()) return fallback;
  return candidate.replace(/[\r\n]+/g, " ").slice(0, 280);
}

function scopeQuery(scope: PRChatScope) {
  const query = new URLSearchParams({
    repo: scope.repositoryFullName,
    number: String(scope.pullRequestNumber),
    headSha: scope.headSha,
    baseSha: scope.baseSha
  });
  return query.toString();
}

function messageTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function parseMessage(value: unknown, index: number): PRChatMessage {
  if (!isRecord(value))
    throw new Error("The PR chat runtime returned an invalid message.");
  const role =
    value.role === "user" || value.role === "assistant" ? value.role : null;
  const content = typeof value.text === "string" ? value.text.trim() : "";
  if (!role || !content)
    throw new Error("The PR chat runtime returned an invalid message.");
  const requestId =
    typeof value.requestId === "string" ? value.requestId : "message";
  return {
    id: `${requestId}-${role}-${index}`,
    role,
    content,
    createdAt: messageTimestamp(value.createdAt),
    author:
      isRecord(value.author) &&
      typeof value.author.agentId === "string" &&
      typeof value.author.name === "string"
        ? {
            agentId: value.author.agentId,
            name: value.author.name,
            ...(isRecord(value.author.avatar)
              ? {
                  avatar: value.author.avatar as {
                    image?: string;
                    spec?: Record<string, unknown>;
                  }
                }
              : {})
          }
        : null
  };
}

async function readJson(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>;
}

async function assertOk(response: Response, fallback: string) {
  const payload = await readJson(response);
  if (!response.ok) {
    const code =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : undefined;
    throw new PRChatHttpError(
      safeMessage(payload, fallback),
      response.status,
      code
    );
  }
  return payload;
}

function parseConversation(value: unknown): PRChatConversation {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("The PR chat runtime returned an invalid conversation.");
  }
  return {
    messages: value.messages.map(parseMessage)
  };
}

function parseResponse(value: unknown): PRChatResponse {
  if (!isRecord(value) || !isRecord(value.message)) {
    throw new Error("The PR chat runtime returned no assistant response.");
  }
  return { message: parseMessage(value.message, 0) };
}

async function freshCsrfToken(signal: AbortSignal) {
  const response = await fetch("/studio-api/github/session", {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal
  });
  const payload = await assertOk(response, "Studio session is unavailable.");
  const token =
    isRecord(payload) && typeof payload.csrfToken === "string"
      ? payload.csrfToken
      : null;
  if (!token)
    throw new Error("Studio session is unavailable. Refresh and try again.");
  return token;
}

async function loadConversation(input: {
  scope: PRChatScope;
  signal: AbortSignal;
}): Promise<PRChatConversation> {
  const response = await fetch(
    `/studio-api/pr-chat/conversation?${scopeQuery(input.scope)}`,
    {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: input.signal
    }
  );
  return parseConversation(
    await assertOk(response, "The pull request conversation is unavailable.")
  );
}

async function sendMessage(input: {
  scope: PRChatScope;
  text: string;
  requestId: string;
  selection: ChatComposerSelection;
  signal: AbortSignal;
}): Promise<PRChatResponse> {
  const csrfToken = await freshCsrfToken(input.signal);
  const response = await fetch("/studio-api/pr-chat/message", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-studio-csrf": csrfToken
    },
    body: JSON.stringify({
      repo: input.scope.repositoryFullName,
      number: input.scope.pullRequestNumber,
      headSha: input.scope.headSha,
      baseSha: input.scope.baseSha,
      text: input.text,
      requestId: input.requestId,
      selection: input.selection
    }),
    signal: input.signal
  });
  return parseResponse(
    await assertOk(response, "The pull request chat could not answer.")
  );
}

async function getApproval(input: {
  scope: PRChatScope;
  requestId: string;
  signal: AbortSignal;
}) {
  const query = new URLSearchParams({
    ...Object.fromEntries(new URLSearchParams(scopeQuery(input.scope))),
    requestId: input.requestId
  });
  const response = await fetch(`/studio-api/pr-chat/approval?${query}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: input.signal
  });
  const payload = await assertOk(response, "Approval status is unavailable.");
  if (
    !isRecord(payload) ||
    typeof payload.approvalId !== "string" ||
    typeof payload.title !== "string" ||
    typeof payload.detail !== "string"
  )
    return null;
  return {
    approvalId: payload.approvalId,
    title: payload.title,
    detail: payload.detail
  };
}

async function resolveApproval(input: {
  scope: PRChatScope;
  requestId: string;
  approvalId: string;
  decision: "accept" | "decline";
  signal: AbortSignal;
}) {
  const csrfToken = await freshCsrfToken(input.signal);
  const response = await fetch("/studio-api/pr-chat/approval/resolve", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-studio-csrf": csrfToken
    },
    body: JSON.stringify({
      repo: input.scope.repositoryFullName,
      number: input.scope.pullRequestNumber,
      headSha: input.scope.headSha,
      baseSha: input.scope.baseSha,
      requestId: input.requestId,
      approvalId: input.approvalId,
      decision: input.decision
    }),
    signal: input.signal
  });
  await assertOk(response, "The permission decision could not be recorded.");
}

/** Stable renderer client. Demo routes deliberately pass no adapter. */
export const prChatHttpAdapter: PRChatAdapter = Object.freeze({
  load: loadConversation,
  send: sendMessage,
  getApproval,
  resolveApproval
});
