import { useCallback, useEffect, useRef, useState } from "react";
import {
  personalDesktopProjectThreadSchema,
  type PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../project-memory-ui.js";
import {
  parseManagedConversationIdentity,
  parseManagedConversationRequest,
  type ManagedConversationDesktopApi,
  type ManagedConversationIdentity
} from "../../ipc/managed-conversation-protocol.js";
import type { PersonalMemoryStore } from "./personal-memory.js";
import type { ManagedConversationRealtimeUpdate } from "./managed-conversation-runtime.js";
export type InitialConversationPrompt = {
  clientUserMessageId: string;
  prompt: string;
  status: "queued" | "rejected" | "reconciling";
  message: string;
};

export type ManagedConversationDraft = {
  conversation: ManagedConversationIdentity;
  launchInput: Parameters<ManagedConversationDesktopApi["start"]>[0];
  initialPrompt?: InitialConversationPrompt;
  confirmedTerminal?: boolean;
  retryStartPending?: boolean;
  status: "starting" | "ready" | "failed" | "reconciling";
  message: string;
  thread: PersonalDesktopProjectThread;
};
const MANAGED_CONVERSATION_RECOVERY_LIMIT = 100;
const MANAGED_CONVERSATION_RECOVERY_TARGET_BYTES = 900 * 1024;
const recoveredManagedConversationDrafts = (
  value: string
): ReadonlyMap<string, ManagedConversationDraft> => {
  if (!value) return new Map();
  try {
    const payload = JSON.parse(value) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return new Map();
    const root = payload as Record<string, unknown>;
    if (root.schemaVersion !== 1 || !Array.isArray(root.drafts))
      return new Map();
    const recovered = new Map<string, ManagedConversationDraft>();
    for (const candidate of root.drafts.slice(
      0,
      MANAGED_CONVERSATION_RECOVERY_LIMIT
    )) {
      try {
        if (
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        )
          continue;
        const entry = candidate as Record<string, unknown>;
        if (
          typeof entry.routeId !== "string" ||
          !entry.draft ||
          typeof entry.draft !== "object"
        )
          continue;
        const draft = entry.draft as Record<string, unknown>;
        const launch = parseManagedConversationRequest({
          operation: "start",
          ...(draft.launchInput as Record<string, unknown>)
        });
        if (launch.operation !== "start") continue;
        const { operation: _operation, ...launchInput } = launch;
        void _operation;
        const conversation = parseManagedConversationIdentity(
          draft.conversation
        );
        // The route stays stable when a terminal retry creates a new execution.
        parseManagedConversationIdentity({
          ...conversation,
          executionId: entry.routeId
        });
        const status = draft.status;
        if (
          status !== "starting" &&
          status !== "ready" &&
          status !== "failed" &&
          status !== "reconciling"
        )
          continue;
        const message = typeof draft.message === "string" ? draft.message : "";
        const thread = personalDesktopProjectThreadSchema.parse(draft.thread);
        const prompt = draft.initialPrompt;
        const initialPrompt: ManagedConversationDraft["initialPrompt"] =
          prompt && typeof prompt === "object" && !Array.isArray(prompt)
            ? (() => {
                const item = prompt as Record<string, unknown>;
                if (
                  typeof item.clientUserMessageId !== "string" ||
                  typeof item.prompt !== "string" ||
                  (item.status !== "queued" &&
                    item.status !== "rejected" &&
                    item.status !== "reconciling") ||
                  typeof item.message !== "string"
                )
                  return undefined;
                return {
                  clientUserMessageId: item.clientUserMessageId,
                  prompt: item.prompt,
                  status: item.status,
                  message: item.message
                };
              })()
            : undefined;
        recovered.set(entry.routeId, {
          conversation,
          launchInput,
          confirmedTerminal: draft.confirmedTerminal === true,
          retryStartPending: draft.retryStartPending === true,
          ...(initialPrompt ? { initialPrompt } : {}),
          status,
          message,
          thread
        });
      } catch {
        // Skip one malformed recovery record without discarding valid entries.
      }
    }
    return recovered;
  } catch {
    return new Map();
  }
};

const managedConversationRecoveryValue = (
  drafts: ReadonlyMap<string, ManagedConversationDraft>
): string => {
  const entries: Array<{ routeId: string; draft: ManagedConversationDraft }> =
    [];
  const candidates = [...drafts.entries()]
    .sort(
      ([, left], [, right]) =>
        Date.parse(right.thread.latestAt) - Date.parse(left.thread.latestAt)
    )
    .slice(0, MANAGED_CONVERSATION_RECOVERY_LIMIT);
  for (const [routeId, draft] of candidates) {
    const candidate = [...entries, { routeId, draft }];
    const value = JSON.stringify({ schemaVersion: 1, drafts: candidate });
    if (
      new TextEncoder().encode(value).byteLength >
      MANAGED_CONVERSATION_RECOVERY_TARGET_BYTES
    )
      break;
    entries.push({ routeId, draft });
  }
  return JSON.stringify({ schemaVersion: 1, drafts: entries });
};

const provisionalConversationTitle = (prompt: string | undefined): string =>
  prompt?.trim().replace(/\s+/gu, " ").slice(0, 120) ||
  "New AI Client Conversation";

export type ManagedConversationLifecycle = ReturnType<
  typeof useManagedConversationLifecycle
>;

export function useManagedConversationLifecycle({
  api,
  store,
  ownerId,
  revision = 0,
  update = null
}: {
  api?: ManagedConversationDesktopApi | null;
  store: PersonalMemoryStore | null;
  ownerId?: string | null;
  revision?: number;
  update?: {
    revision: number;
    update: ManagedConversationRealtimeUpdate;
  } | null;
}) {
  const [drafts, setDrafts] = useState<
    ReadonlyMap<string, ManagedConversationDraft>
  >(new Map());
  const [recoveryOwner, setRecoveryOwner] = useState<string | null>(null);
  const scope = useRef({ api, ownerId });
  if (scope.current.api !== api || scope.current.ownerId !== ownerId)
    scope.current = { api, ownerId };
  const currentScope = scope.current;
  const writeQueue = useRef(Promise.resolve());
  const executionVersions = useRef(
    new Map<string, { generation: number; version: number }>()
  );

  useEffect(() => {
    const currentScope = scope.current;
    setDrafts(new Map());
    executionVersions.current.clear();
    setRecoveryOwner(null);
    if (!ownerId) return;
    let active = true;
    if (!api?.readRecovery) {
      setRecoveryOwner(ownerId);
      return;
    }
    void api
      .readRecovery(ownerId)
      .then((result) => {
        if (!active || scope.current !== currentScope) return;
        setDrafts(
          (current) =>
            new Map([
              ...recoveredManagedConversationDrafts(result.value),
              ...current
            ])
        );
        setRecoveryOwner(ownerId);
      })
      .catch(() => {
        if (active && scope.current === currentScope) setRecoveryOwner(ownerId);
      });
    return () => {
      active = false;
    };
  }, [api, ownerId]);

  useEffect(() => {
    if (!ownerId || recoveryOwner !== ownerId || !api?.writeRecovery) return;
    const currentScope = scope.current;
    const write = api.writeRecovery;
    const timer = window.setTimeout(() => {
      const value = managedConversationRecoveryValue(drafts);
      writeQueue.current = writeQueue.current
        .catch(() => undefined)
        .then(async () => {
          if (scope.current === currentScope) await write(ownerId, value);
        })
        .catch(() => undefined);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [api, drafts, ownerId, recoveryOwner]);

  const started = useCallback(
    (
      project: DesktopProject,
      conversation: ManagedConversationIdentity,
      status: "starting" | "ready",
      launchInput: ManagedConversationDraft["launchInput"],
      initialPrompt?: InitialConversationPrompt
    ) => {
      if (scope.current !== currentScope) return null;
      const routeId = conversation.executionId;
      if (!routeId) return null;
      const thread: PersonalDesktopProjectThread = {
        id: conversation.threadId,
        name: provisionalConversationTitle(initialPrompt?.prompt),
        sessionId: conversation.capturedSessionId,
        sourceAiClient:
          launchInput.aiClientDriverId === "claude"
            ? "claude-code"
            : launchInput.aiClientDriverId,
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        projectAssignmentSource: "user_override",
        eventCount: 0,
        invalidatedCount: 0,
        latestAt: new Date().toISOString(),
        sample: initialPrompt?.prompt ?? "",
        presentation: null
      };
      if (status === "ready" && conversation.capturedSessionId !== routeId)
        store?.upsertThread(thread);
      setDrafts((current) =>
        new Map(current).set(routeId, {
          conversation,
          launchInput,
          initialPrompt,
          status,
          thread,
          message:
            status === "starting"
              ? launchInput.contextKind === "independent"
                ? "Starting a Chat…"
                : "Starting the AI Client in this Project…"
              : ""
        })
      );
      return routeId;
    },
    [store, currentScope]
  );

  useEffect(() => {
    if (!update) return;
    const realtime = update.update;
    const previous = executionVersions.current.get(realtime.execution.id);
    const generation = realtime.execution.executionGeneration;
    const version = realtime.execution.stateVersion;
    if (
      previous &&
      (generation < previous.generation ||
        (generation === previous.generation && version < previous.version))
    )
      return;
    executionVersions.current.set(realtime.execution.id, {
      generation,
      version
    });
    setDrafts((current) => {
      const entry = [...current.entries()].find(
        ([, draft]) => draft.conversation.executionId === realtime.execution.id
      );
      if (!entry) return current;
      const [routeId, draft] = entry;
      if (draft.retryStartPending) return current;
      const capturedSessionId =
        realtime.execution.sessionId ?? draft.conversation.capturedSessionId;
      const threadId =
        realtime.execution.providerThreadId ?? draft.conversation.threadId;
      const next: ManagedConversationDraft = {
        ...draft,
        conversation: { ...draft.conversation, capturedSessionId, threadId },
        confirmedTerminal: ["failed", "fenced", "stopped"].includes(
          realtime.execution.state
        ),
        status:
          realtime.execution.state === "running" &&
          realtime.execution.sessionId &&
          realtime.execution.providerThreadId
            ? "ready"
            : realtime.execution.state === "reconciling"
              ? "reconciling"
              : ["failed", "fenced", "stopped"].includes(
                    realtime.execution.state
                  )
                ? "failed"
                : draft.status,
        message: realtime.execution.state === "running" ? "" : draft.message,
        thread: {
          ...draft.thread,
          id: threadId,
          sessionId: capturedSessionId,
          latestAt:
            realtime.latestCommand?.commandKind === "prompt" &&
            realtime.latestCommand.clientUserMessageId
              ? realtime.latestCommand.updatedAt
              : draft.thread.latestAt
        }
      };
      if (
        next.confirmedTerminal === draft.confirmedTerminal &&
        next.status === draft.status &&
        next.message === draft.message &&
        capturedSessionId === draft.conversation.capturedSessionId &&
        threadId === draft.conversation.threadId &&
        next.thread.latestAt === draft.thread.latestAt
      )
        return current;
      return new Map(current).set(routeId, next);
    });
  }, [update]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    for (const [routeId, draft] of drafts) {
      if (draft.status !== "starting" && draft.status !== "reconciling")
        continue;
      const executionId = draft.conversation.executionId;
      if (!executionId) continue;
      const request = async () => {
        if (!draft.retryStartPending) return api.inspect(executionId);
        // Persist the replacement key before dispatch, including after recovery.
        if (ownerId && api.writeRecovery) {
          const write = api.writeRecovery;
          writeQueue.current = writeQueue.current
            .catch(() => undefined)
            .then(async () => {
              if (scope.current === currentScope)
                await write(ownerId, managedConversationRecoveryValue(drafts));
            });
          await writeQueue.current;
        }
        if (!active || scope.current !== currentScope) return null;
        return api.start(draft.launchInput);
      };
      void request()
        .then((result) => {
          if (
            !result ||
            !active ||
            scope.current !== currentScope ||
            (result.status === "starting" && !draft.retryStartPending)
          )
            return;
          if (result.status === "ready" && result.conversation) {
            store?.upsertThread({
              ...draft.thread,
              id: result.conversation.threadId,
              sessionId: result.conversation.capturedSessionId
            });
          }
          setDrafts((current) => {
            if (current.get(routeId) !== draft) return current;
            const conversation =
              result.conversation ??
              (result.operation === "start"
                ? {
                    ...draft.conversation,
                    executionId: result.executionId,
                    capturedSessionId: result.executionId,
                    threadId: result.executionId
                  }
                : draft.conversation);
            const message =
              result.status === "ready"
                ? ""
                : result.status === "starting"
                  ? draft.message
                  : (("message" in result ? result.message : undefined) ??
                    "The AI Client could not establish a writable Conversation.");
            if (
              !draft.retryStartPending &&
              draft.status === result.status &&
              draft.message === message &&
              conversation === draft.conversation
            )
              return current;
            return new Map(current).set(routeId, {
              ...draft,
              conversation,
              retryStartPending: false,
              confirmedTerminal: result.status === "failed",
              status: result.status,
              message,
              thread: {
                ...draft.thread,
                id: conversation.threadId,
                sessionId: conversation.capturedSessionId
              }
            });
          });
        })
        .catch((cause: unknown) => {
          if (!active || scope.current !== currentScope) return;
          setDrafts((current) =>
            current.get(routeId) !== draft
              ? current
              : new Map(current).set(routeId, {
                  ...draft,
                  status: "failed",
                  message:
                    cause instanceof Error ? cause.message : String(cause)
                })
          );
        });
    }
    return () => {
      active = false;
    };
  }, [api, drafts, revision, store, currentScope, ownerId]);

  const retry = useCallback(
    (routeId: string) => {
      const draft = drafts.get(routeId);
      if (!api || !draft) return;
      if (draft.status !== "failed" && draft.status !== "reconciling") return;
      const pending: ManagedConversationDraft = {
        ...draft,
        launchInput: draft.confirmedTerminal
          ? { ...draft.launchInput, idempotencyKey: crypto.randomUUID() }
          : draft.launchInput,
        confirmedTerminal: false,
        retryStartPending: true,
        status: "starting",
        message:
          draft.launchInput.contextKind === "independent"
            ? "Starting a Chat…"
            : "Starting the AI Client in this Project…"
      };
      setDrafts((current) =>
        current.get(routeId) === draft
          ? new Map(current).set(routeId, pending)
          : current
      );
    },
    [api, drafts]
  );
  return { drafts, started, retry };
}
