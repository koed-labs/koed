import { randomUUID } from "node:crypto";

import type { MemorySourceRepository } from "@koed/db";
import {
  MANAGED_DEVELOPMENT_PREVIEW_MAX_RECORDS,
  MANAGED_DEVELOPMENT_PREVIEW_POLICY_VERSION,
  managedDevelopmentPreviewRecordSchema,
  type ManagedDevelopmentPreviewAccess,
  type ManagedDevelopmentPreviewCandidate,
  type ManagedDevelopmentPreviewRecord
} from "@koed/shared";

import type {
  ManagedTerminalPreviewSignal,
  ManagedTerminalRuntime
} from "./terminal-runtime.js";

type InternalPreview = {
  ownerUserId: string;
  record: ManagedDevelopmentPreviewRecord;
  navigationUrl: string;
};

export interface ManagedDevelopmentPreviewRuntime {
  nominate(
    ownerUserId: string,
    executionId: string,
    candidate: ManagedDevelopmentPreviewCandidate
  ): Promise<ManagedDevelopmentPreviewRecord>;
  list(
    ownerUserId: string,
    executionId: string
  ): Promise<ManagedDevelopmentPreviewRecord[]>;
  access(input: {
    ownerUserId: string;
    executionId: string;
    previewId: string;
    lifecycleGeneration: number;
  }): Promise<ManagedDevelopmentPreviewAccess>;
  close(): void;
}

const previewError = (message: string, statusCode: number, code: string) =>
  Object.assign(new Error(message), { statusCode, code });

const normalizedCandidateUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.port ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
    ) {
      return null;
    }
    url.hostname = "127.0.0.1";
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
};

const previewKey = (
  ownerUserId: string,
  executionId: string,
  terminalId: string,
  url: URL
) => `${ownerUserId}:${executionId}:${terminalId}:${url.origin}`;

export const createManagedDevelopmentPreviewRuntime = (options: {
  requireRepository(): MemorySourceRepository;
  terminalRuntime: ManagedTerminalRuntime;
  fetch?: typeof globalThis.fetch;
  readinessDelaysMs?: number[];
  onChange?: (record: ManagedDevelopmentPreviewRecord) => void;
  onError?: (error: unknown, code: string) => void;
}): ManagedDevelopmentPreviewRuntime => {
  const previews = new Map<string, InternalPreview>();
  const idsByKey = new Map<string, string>();
  const pending = new Set<string>();
  const closedTerminals = new Set<string>();
  const fetch = options.fetch ?? globalThis.fetch;
  const readinessDelaysMs = options.readinessDelaysMs ?? [
    0, 100, 250, 500, 1_000, 2_000
  ];
  let closed = false;

  const terminalKey = (input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
    terminalId: string;
  }) =>
    `${input.ownerUserId}:${input.executionId}:${input.executionGeneration}:${input.terminalId}`;

  const verifyExecution = async (
    ownerUserId: string,
    executionId: string,
    executionGeneration: number
  ) => {
    const repository = options.requireRepository();
    const [execution, binding] = await Promise.all([
      repository.getManagedConversationExecution(
        { userId: ownerUserId },
        executionId
      ),
      repository.getManagedConversationRuntimeBinding(
        { userId: ownerUserId },
        executionId
      )
    ]);
    if (
      !execution ||
      !binding ||
      execution.executionGeneration !== executionGeneration ||
      binding.executionGeneration !== executionGeneration ||
      binding.workspaceLifecycle !== "ready"
    ) {
      throw previewError(
        "Development preview workspace authority is stale",
        409,
        "preview_workspace_stale"
      );
    }
  };

  const readiness = async (url: URL): Promise<boolean> => {
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(1_500)
      });
      await response.body?.cancel();
      return response.status >= 100 && response.status < 500;
    } catch {
      return false;
    }
  };

  const publish = async (input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
    terminalId: string;
    source: ManagedDevelopmentPreviewRecord["source"];
    url: URL;
  }): Promise<ManagedDevelopmentPreviewRecord> => {
    if (closed)
      throw previewError("Preview runtime is closed", 503, "runtime_closed");
    if (closedTerminals.has(terminalKey(input))) {
      throw previewError(
        "Development server process is closed",
        409,
        "preview_process_closed"
      );
    }
    await verifyExecution(
      input.ownerUserId,
      input.executionId,
      input.executionGeneration
    );
    const port = Number(input.url.port);
    const ownsListener = await options.terminalRuntime.verifyPreviewListener({
      ownerUserId: input.ownerUserId,
      executionId: input.executionId,
      executionGeneration: input.executionGeneration,
      terminalId: input.terminalId,
      port
    });
    if (!ownsListener) {
      throw previewError(
        "Development server listener could not be verified",
        409,
        "preview_listener_unverified"
      );
    }
    if (!(await readiness(input.url))) {
      throw previewError(
        "Development server is not ready",
        409,
        "preview_not_ready"
      );
    }
    const key = previewKey(
      input.ownerUserId,
      input.executionId,
      input.terminalId,
      input.url
    );
    const existingId = idsByKey.get(key);
    const existing = existingId ? previews.get(existingId) : null;
    const now = new Date().toISOString();
    const record = managedDevelopmentPreviewRecordSchema.parse({
      id: existing?.record.id ?? randomUUID(),
      executionId: input.executionId,
      executionGeneration: input.executionGeneration,
      lifecycleGeneration:
        existing?.record.state === "closed"
          ? existing.record.lifecycleGeneration + 1
          : (existing?.record.lifecycleGeneration ?? 1),
      terminalId: input.terminalId,
      state: "available",
      source: input.source,
      policyVersion: MANAGED_DEVELOPMENT_PREVIEW_POLICY_VERSION,
      discoveredAt: existing?.record.discoveredAt ?? now,
      updatedAt: now
    });
    previews.set(record.id, {
      ownerUserId: input.ownerUserId,
      record,
      navigationUrl: input.url.toString()
    });
    idsByKey.set(key, record.id);
    options.onChange?.(record);

    const owned = [...previews.values()].filter(
      ({ ownerUserId, record: item }) =>
        ownerUserId === input.ownerUserId &&
        item.executionId === input.executionId
    );
    if (owned.length > MANAGED_DEVELOPMENT_PREVIEW_MAX_RECORDS) {
      for (const stale of owned
        .sort((left, right) =>
          left.record.updatedAt.localeCompare(right.record.updatedAt)
        )
        .slice(0, owned.length - MANAGED_DEVELOPMENT_PREVIEW_MAX_RECORDS)) {
        previews.delete(stale.record.id);
      }
    }
    return record;
  };

  const closeForTerminal = (
    signal: Extract<ManagedTerminalPreviewSignal, { type: "closed" }>
  ) => {
    closedTerminals.add(terminalKey(signal));
    const now = new Date().toISOString();
    for (const internal of previews.values()) {
      if (
        internal.ownerUserId !== signal.ownerUserId ||
        internal.record.executionId !== signal.executionId ||
        internal.record.terminalId !== signal.terminalId ||
        internal.record.executionGeneration !== signal.executionGeneration ||
        internal.record.state === "closed"
      ) {
        continue;
      }
      internal.record = managedDevelopmentPreviewRecordSchema.parse({
        ...internal.record,
        state: "closed",
        updatedAt: now
      });
      options.onChange?.(internal.record);
    }
  };

  const scheduleCandidate = (
    signal: Extract<ManagedTerminalPreviewSignal, { type: "candidate" }>
  ) => {
    const url = normalizedCandidateUrl(signal.url);
    if (!url) return;
    const key = previewKey(
      signal.ownerUserId,
      signal.executionId,
      signal.terminalId,
      url
    );
    if (pending.has(key)) return;
    pending.add(key);
    void (async () => {
      let lastError: unknown;
      for (const delay of readinessDelaysMs) {
        if (closed) return;
        if (delay > 0) {
          await new Promise((resolveWait) => setTimeout(resolveWait, delay));
        }
        try {
          await publish({
            ...signal,
            source: "terminal_output",
            url
          });
          return;
        } catch (error) {
          lastError = error;
          if (
            error instanceof Error &&
            "code" in error &&
            !["preview_listener_unverified", "preview_not_ready"].includes(
              String((error as { code?: unknown }).code)
            )
          ) {
            break;
          }
        }
      }
      options.onError?.(lastError, "preview_candidate_rejected");
    })().finally(() => pending.delete(key));
  };

  const unsubscribe = options.terminalRuntime.subscribePreviewSignals(
    (signal) => {
      if (signal.type === "candidate") scheduleCandidate(signal);
      else closeForTerminal(signal);
    }
  );

  return {
    async nominate(ownerUserId, executionId, candidate) {
      const url = normalizedCandidateUrl(
        `${candidate.scheme}://127.0.0.1:${candidate.port}/`
      );
      if (!url) {
        throw previewError(
          "Development preview candidate is invalid",
          400,
          "preview_candidate_invalid"
        );
      }
      return await publish({
        ownerUserId,
        executionId,
        executionGeneration: candidate.executionGeneration,
        terminalId: candidate.terminalId,
        source: "user_port",
        url
      });
    },

    async list(ownerUserId, executionId) {
      const records = [...previews.values()]
        .filter(
          (internal) =>
            internal.ownerUserId === ownerUserId &&
            internal.record.executionId === executionId
        )
        .map(({ record }) => record)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      if (records[0]) {
        await verifyExecution(
          ownerUserId,
          executionId,
          records[0].executionGeneration
        );
      } else {
        const execution = await options
          .requireRepository()
          .getManagedConversationExecution(
            { userId: ownerUserId },
            executionId
          );
        if (!execution)
          throw previewError(
            "Managed execution was not found",
            404,
            "execution_missing"
          );
      }
      return records;
    },

    async access(input) {
      const internal = previews.get(input.previewId);
      if (
        !internal ||
        internal.ownerUserId !== input.ownerUserId ||
        internal.record.executionId !== input.executionId ||
        internal.record.lifecycleGeneration !== input.lifecycleGeneration ||
        internal.record.state !== "available"
      ) {
        throw previewError(
          "Development preview is unavailable",
          404,
          "preview_unavailable"
        );
      }
      await verifyExecution(
        input.ownerUserId,
        input.executionId,
        internal.record.executionGeneration
      );
      const url = new URL(internal.navigationUrl);
      const ownsListener = await options.terminalRuntime.verifyPreviewListener({
        ownerUserId: input.ownerUserId,
        executionId: input.executionId,
        executionGeneration: internal.record.executionGeneration,
        terminalId: internal.record.terminalId,
        port: Number(url.port)
      });
      if (!ownsListener || !(await readiness(url))) {
        internal.record = managedDevelopmentPreviewRecordSchema.parse({
          ...internal.record,
          state: "closed",
          updatedAt: new Date().toISOString()
        });
        options.onChange?.(internal.record);
        throw previewError(
          "Development preview is unavailable",
          409,
          "preview_unavailable"
        );
      }
      return {
        preview: internal.record,
        navigationUrl: internal.navigationUrl
      };
    },

    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      previews.clear();
      idsByKey.clear();
      pending.clear();
      closedTerminals.clear();
    }
  };
};
