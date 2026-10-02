"use client";

import {
  pullRequestFrozenReviewSchema,
  pullRequestOperationSchema,
  pullRequestOperationPageSchema,
  pullRequestReviewDraftSchema,
  pullRequestReviewSchema,
  type PullRequestFrozenReview,
  type PullRequestOperationRecord,
  type PullRequestOperationPayload,
  type PullRequestReviewDraft,
  type PullRequestReviewRecord
} from "@koed/shared/pull-requests";

export class PullRequestsHttpError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly operationId: string | undefined;

  constructor(
    message: string,
    status?: number,
    code?: string,
    operationId?: string
  ) {
    super(message);
    this.name = "PullRequestsHttpError";
    this.status = status;
    this.code = code;
    this.operationId = operationId;
  }
}

type ClientOptions = {
  fetcher?: typeof fetch;
  hosted?: boolean;
  pollIntervalMs?: number;
  maxPollMs?: number;
};

type DraftWrite = {
  expectedReviewRevision: number;
  expectedDraftRevision: number;
  executionGeneration: number;
  connectionGeneration: number;
  accountId: string;
  baseSha: string;
  headSha: string;
  event: PullRequestReviewDraft["event"];
  body: string;
  findings: PullRequestReviewDraft["findings"];
};

type FreezeInput = Omit<DraftWrite, "event" | "body" | "findings">;
export type PullRequestRunner = {
  deviceId: string;
  deploymentId: string;
  label: string;
};
export type PullRequestActionGrantStatus = {
  state: string;
  actionGrant: { id: string };
  approvalTier: string;
  review: null | {
    title: string;
    description: string;
    consequence: string;
    confirmLabel: string;
    details: Array<{ label: string; value: string }>;
  };
  activationUrl: string | null;
};

function actionGrantStatus(value: unknown): PullRequestActionGrantStatus {
  const result =
    isRecord(value) && isRecord(value.result) ? value.result : value;
  const data = isRecord(result) && isRecord(result.data) ? result.data : result;
  const status = isRecord(data) && isRecord(data.status) ? data.status : null;
  if (
    !status ||
    !isRecord(status.actionGrant) ||
    typeof status.actionGrant.id !== "string" ||
    typeof status.state !== "string"
  ) {
    throw new PullRequestsHttpError(
      "The source-control approval service returned an invalid status."
    );
  }
  return status as PullRequestActionGrantStatus;
}

export type PullRequestDetailsSelection = Extract<
  PullRequestOperationPayload,
  { kind: "pull_request_details" }
>;

export function pullRequestOperationData(
  operation: PullRequestOperationRecord
) {
  if (operation.state !== "completed" || !operation.result) {
    throw new PullRequestsHttpError(
      "The pull request operation has no completed result."
    );
  }
  return operation.result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hostedPathname() {
  if (typeof window === "undefined") return false;
  return (
    window.location.pathname === "/studio" ||
    window.location.pathname.startsWith("/studio/")
  );
}

function errorMessage(value: unknown, fallback: string) {
  if (!isRecord(value)) return fallback;
  const envelope = isRecord(value.error) ? value.error : value;
  const candidate =
    typeof envelope.message === "string"
      ? envelope.message
      : typeof envelope.error === "string"
        ? envelope.error
        : null;
  return (
    candidate
      ?.trim()
      .replace(/[\r\n]+/g, " ")
      .slice(0, 280) || fallback
  );
}

function randomId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `pr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function operationFrom(value: unknown): PullRequestOperationRecord {
  const candidate =
    isRecord(value) && isRecord(value.operation) ? value.operation : value;
  return pullRequestOperationSchema.parse(candidate);
}

function recordFrom(value: unknown): PullRequestReviewRecord {
  const candidate =
    isRecord(value) && isRecord(value.review) ? value.review : value;
  return pullRequestReviewSchema.parse(candidate);
}

function draftFrom(value: unknown): PullRequestReviewDraft | null {
  const candidate = isRecord(value) && "draft" in value ? value.draft : value;
  return candidate === null || candidate === undefined
    ? null
    : pullRequestReviewDraftSchema.parse(candidate);
}

function frozenReviewFrom(value: unknown): PullRequestFrozenReview | null {
  const candidate =
    isRecord(value) && "frozenReview" in value ? value.frozenReview : value;
  if (candidate === null || candidate === undefined) return null;
  return pullRequestFrozenReviewSchema.parse(candidate);
}

function abortableDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function createPullRequestsClient({
  fetcher = fetch,
  hosted = hostedPathname(),
  pollIntervalMs = 650,
  maxPollMs = 180_000
}: ClientOptions = {}) {
  const basePath = hosted ? "/v1/pull-requests" : "/studio-api/pull-requests";

  const request = async (
    path: string,
    input: {
      method?: "GET" | "POST" | "PUT";
      body?: unknown;
      signal?: AbortSignal;
    } = {}
  ): Promise<unknown> => {
    const method = input.method ?? (input.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = { accept: "application/json" };
    if (input.body !== undefined) {
      headers["content-type"] = "application/json";
      if (!hosted) {
        const session = await fetcher("/studio-api/github/session", {
          headers: { accept: "application/json" },
          credentials: "include",
          cache: "no-store",
          signal: input.signal
        });
        const sessionPayload: unknown = await session.json().catch(() => null);
        const csrfToken =
          isRecord(sessionPayload) &&
          typeof sessionPayload.csrfToken === "string"
            ? sessionPayload.csrfToken
            : null;
        if (!session.ok || !csrfToken) {
          throw new PullRequestsHttpError(
            "Studio session is unavailable. Refresh before trying again.",
            session.status
          );
        }
        headers["x-studio-csrf"] = csrfToken;
      }
    }
    const response = await fetcher(`${basePath}${path}`, {
      method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal: input.signal
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = isRecord(payload)
        ? isRecord(payload.error) && typeof payload.error.code === "string"
          ? payload.error.code
          : typeof payload.code === "string"
            ? payload.code
            : undefined
        : undefined;
      throw new PullRequestsHttpError(
        errorMessage(payload, "The pull request request failed."),
        response.status,
        code
      );
    }
    return payload;
  };

  const createOperation = async (
    payload: PullRequestOperationPayload,
    signal?: AbortSignal,
    requestId = randomId(),
    confirmation?: Record<string, unknown>,
    extra: {
      target?: { deviceId: string; deploymentId: string };
      actionGrantId?: string;
      commandRequestId?: string;
    } = {}
  ) =>
    operationFrom(
      await request("/operations", {
        method: "POST",
        body: {
          requestId,
          payload,
          ...(confirmation ? { confirmation } : {}),
          ...extra
        },
        signal
      })
    );

  const loadOperation = async (operationId: string, signal?: AbortSignal) =>
    operationFrom(
      await request(`/operations/${encodeURIComponent(operationId)}`, {
        signal
      })
    );

  const waitForOperation = async (
    initial: PullRequestOperationRecord,
    input: {
      signal?: AbortSignal;
      onUpdate?: (operation: PullRequestOperationRecord) => void;
    } = {}
  ): Promise<PullRequestOperationRecord> => {
    const startedAt = Date.now();
    let operation = initial;
    input.onUpdate?.(operation);
    while (operation.state === "pending" || operation.state === "claimed") {
      if (Date.now() - startedAt >= maxPollMs) {
        throw new PullRequestsHttpError(
          `This GitHub operation (${operation.id}) is still running. Check its status before retrying.`,
          408,
          "pull_request_operation_pending",
          operation.id
        );
      }
      await abortableDelay(pollIntervalMs, input.signal);
      operation = await loadOperation(operation.id, input.signal);
      input.onUpdate?.(operation);
    }
    if (
      operation.state === "failed" ||
      operation.state === "uncertain" ||
      operation.state === "cancelled"
    ) {
      throw new PullRequestsHttpError(
        operation.state === "uncertain"
          ? "GitHub may have received this operation. Reconcile its status before retrying."
          : operation.state === "cancelled"
            ? "The pull request operation was cancelled."
            : `The pull request operation failed${operation.errorCode ? ` (${operation.errorCode})` : ""}.`,
        undefined,
        operation.errorCode ?? operation.state,
        operation.id
      );
    }
    return operation;
  };

  const runOperation = async (
    payload: PullRequestOperationPayload,
    input: {
      signal?: AbortSignal;
      onUpdate?: (operation: PullRequestOperationRecord) => void;
      confirmation?: Record<string, unknown>;
      requestId?: string;
      target?: { deviceId: string; deploymentId: string };
      actionGrantId?: string;
      commandRequestId?: string;
    } = {}
  ) => {
    const operation = await createOperation(
      payload,
      input.signal,
      input.requestId ?? randomId(),
      input.confirmation,
      {
        ...(input.target ? { target: input.target } : {}),
        ...(input.actionGrantId ? { actionGrantId: input.actionGrantId } : {}),
        ...(input.commandRequestId
          ? { commandRequestId: input.commandRequestId }
          : {})
      }
    );
    return waitForOperation(operation, input);
  };

  return {
    basePath,
    request,
    createOperation,
    loadOperation,
    waitForOperation,
    runOperation,
    async listRunners(signal?: AbortSignal): Promise<PullRequestRunner[]> {
      const value = await request("/runners", { signal });
      const list =
        isRecord(value) && Array.isArray(value.runners) ? value.runners : [];
      return list.flatMap((entry) =>
        isRecord(entry) &&
        typeof entry.deviceId === "string" &&
        typeof entry.deploymentId === "string"
          ? [
              {
                deviceId: entry.deviceId,
                deploymentId: entry.deploymentId,
                label:
                  typeof entry.label === "string"
                    ? entry.label
                    : "Authorized runner"
              }
            ]
          : []
      );
    },
    async requestActionGrant(
      input: Record<string, unknown>,
      signal?: AbortSignal
    ) {
      return actionGrantStatus(
        await request("/action-grants", { method: "POST", body: input, signal })
      );
    },
    async updateActionGrant(
      grantId: string,
      input: {
        requestId: string;
        command: "await" | "confirm" | "cancel";
        decision?: "approve" | "cancel";
        actionGrantId: string;
      },
      signal?: AbortSignal
    ) {
      return actionGrantStatus(
        await request(`/action-grants/${encodeURIComponent(grantId)}`, {
          method: "POST",
          body: input,
          signal
        })
      );
    },
    async listReviews(
      input: {
        repository?: string;
        number?: number;
        agentId?: string;
      } = {},
      signal?: AbortSignal
    ): Promise<PullRequestReviewRecord[]> {
      const query = new URLSearchParams();
      if (input.repository) query.set("repository", input.repository);
      if (input.number !== undefined) query.set("number", String(input.number));
      if (input.agentId) query.set("agentId", input.agentId);
      const value = await request(query.size ? `?${query.toString()}` : "", {
        signal
      });
      const list =
        isRecord(value) && Array.isArray(value.reviews)
          ? value.reviews
          : Array.isArray(value)
            ? value
            : null;
      if (!list)
        throw new PullRequestsHttpError(
          "The review service returned an invalid review list."
        );
      return list.map((review) => pullRequestReviewSchema.parse(review));
    },
    async listOperations(
      input: { limit?: number; before?: string } = {},
      signal?: AbortSignal
    ) {
      const query = new URLSearchParams();
      if (input.limit) query.set("limit", String(input.limit));
      if (input.before) query.set("before", input.before);
      const value = await request(
        `/operations${query.size ? `?${query.toString()}` : ""}`,
        { signal }
      );
      return pullRequestOperationPageSchema.parse(value);
    },
    async createReview(
      input: {
        requestId: string;
        detailsOperationId: string;
        agentId: string;
        projectId?: string;
      },
      signal?: AbortSignal
    ) {
      return recordFrom(
        await request("", { method: "POST", body: input, signal })
      );
    },
    async getReview(reviewId: string, signal?: AbortSignal) {
      return recordFrom(
        await request(`/${encodeURIComponent(reviewId)}`, { signal })
      );
    },
    async getDraft(reviewId: string, signal?: AbortSignal) {
      return draftFrom(
        await request(`/${encodeURIComponent(reviewId)}/draft`, { signal })
      );
    },
    async getFrozenReview(reviewId: string, signal?: AbortSignal) {
      return frozenReviewFrom(
        await request(`/${encodeURIComponent(reviewId)}/draft/frozen`, {
          signal
        })
      );
    },
    async saveDraft(reviewId: string, input: DraftWrite, signal?: AbortSignal) {
      return draftFrom(
        await request(`/${encodeURIComponent(reviewId)}/draft`, {
          method: "PUT",
          body: input,
          signal
        })
      );
    },
    async freezeDraft(
      reviewId: string,
      input: FreezeInput,
      signal?: AbortSignal
    ) {
      return frozenReviewFrom(
        await request(`/${encodeURIComponent(reviewId)}/draft/freeze`, {
          method: "POST",
          body: input,
          signal
        })
      );
    },
    async enableFixes(
      reviewId: string,
      expectedRevision: number,
      signal?: AbortSignal
    ) {
      return recordFrom(
        await request(`/${encodeURIComponent(reviewId)}/enable-fixes`, {
          method: "POST",
          body: { expectedRevision },
          signal
        })
      );
    },
    async refreshReview(
      reviewId: string,
      expectedRevision: number,
      detailsOperationId: string,
      signal?: AbortSignal
    ) {
      return recordFrom(
        await request(`/${encodeURIComponent(reviewId)}/refresh`, {
          method: "POST",
          body: { expectedRevision, detailsOperationId },
          signal
        })
      );
    },
    async cancelOperation(
      operationId: string,
      expectedRevision: number,
      signal?: AbortSignal
    ) {
      return operationFrom(
        await request(`/operations/${encodeURIComponent(operationId)}/cancel`, {
          method: "POST",
          body: { expectedRevision },
          signal
        })
      );
    }
  };
}

export const pullRequestsClient = createPullRequestsClient();

export type { DraftWrite, FreezeInput };
