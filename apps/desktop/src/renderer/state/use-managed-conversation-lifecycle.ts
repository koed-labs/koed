import {
  managedConversationUpdatesSince,
  type ManagedConversationUpdateEnvelope
} from "./managed-conversation-runtime.js";
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
export type ManagedConversationPendingSend = {
  request: Parameters<ManagedConversationDesktopApi["send"]>[0];
  attachments: Array<{ commandId: string; label: string }>;
};
type InitialPromptSettlement = {
  clientUserMessageId: string;
  status: "queued" | "rejected";
  message: string;
};
type RecoveryState = {
  drafts: ReadonlyMap<string, ManagedConversationDraft>;
  pendingSends: ReadonlyMap<string, ManagedConversationPendingSend>;
};
const MANAGED_CONVERSATION_RECOVERY_LIMIT = 100;
const MANAGED_CONVERSATION_RECOVERY_TARGET_BYTES = 900 * 1024;
const exactRecoveryValue = (value: unknown): string =>
  JSON.stringify(value, function (_key, candidate: unknown) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate))
      return Object.fromEntries(
        Object.entries(candidate).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      );
    return candidate;
  });
const recoveredManagedConversationState = (value: string): RecoveryState => {
  const empty = (): RecoveryState => ({
    drafts: new Map(),
    pendingSends: new Map()
  });
  if (!value) return empty();
  try {
    const payload = JSON.parse(value) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new TypeError("Invalid Conversation recovery.");
    const root = payload as Record<string, unknown>;
    if (root.schemaVersion !== 1 || !Array.isArray(root.drafts))
      throw new TypeError("Invalid Conversation recovery.");
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
    const pendingSends = new Map<string, ManagedConversationPendingSend>();
    if (root.pendingSends !== undefined && !Array.isArray(root.pendingSends))
      throw new TypeError("Invalid pending Conversation sends.");
    if (
      Array.isArray(root.pendingSends) &&
      root.pendingSends.length > MANAGED_CONVERSATION_RECOVERY_LIMIT
    )
      throw new TypeError("Too many pending Conversation sends.");
    for (const candidate of (root.pendingSends ?? []) as unknown[]) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      )
        throw new TypeError("Invalid pending Conversation send.");
      const entry = candidate as Record<string, unknown>;
      const request = parseManagedConversationRequest({
        operation: "send",
        ...(entry.request as Record<string, unknown>)
      });
      if (request.operation !== "send" || !Array.isArray(entry.attachments))
        throw new TypeError("Invalid pending Conversation send.");
      const attachments = entry.attachments.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
          throw new TypeError("Invalid pending attachment.");
        const attachment = item as Record<string, unknown>;
        if (
          typeof attachment.commandId !== "string" ||
          typeof attachment.label !== "string" ||
          !request.fileMentionCommandIds.includes(attachment.commandId)
        )
          throw new TypeError("Invalid pending attachment.");
        return { commandId: attachment.commandId, label: attachment.label };
      });
      if (
        typeof entry.executionId !== "string" ||
        entry.executionId !== request.executionId ||
        pendingSends.has(entry.executionId)
      )
        throw new TypeError("Invalid pending Conversation identity.");
      const { operation: _operation, ...sendRequest } = request;
      void _operation;
      pendingSends.set(entry.executionId, {
        request: sendRequest,
        attachments
      });
    }
    return { drafts: recovered, pendingSends };
  } catch {
    // A corrupt pending record cannot be interpreted as proof that no send is pending.
    throw new TypeError("Conversation recovery could not be read safely.");
  }
};

export const managedConversationRecoveryValue = (
  drafts: ReadonlyMap<string, ManagedConversationDraft>,
  pendingSends: ReadonlyMap<string, ManagedConversationPendingSend>
): string => {
  if (pendingSends.size > MANAGED_CONVERSATION_RECOVERY_LIMIT)
    throw new Error(
      "Too many unresolved Conversation sends; no prompt was sent."
    );
  const entries: Array<{ routeId: string; draft: ManagedConversationDraft }> =
    [];
  const candidates = [...drafts.entries()]
    .sort(([, left], [, right]) => {
      const leftProtected = Number(
        pendingSends.has(left.conversation.executionId ?? "")
      );
      const rightProtected = Number(
        pendingSends.has(right.conversation.executionId ?? "")
      );
      return (
        rightProtected - leftProtected ||
        Date.parse(right.thread.latestAt) - Date.parse(left.thread.latestAt)
      );
    })
    .slice(0, MANAGED_CONVERSATION_RECOVERY_LIMIT);
  for (const [routeId, draft] of candidates) {
    const candidate = [...entries, { routeId, draft }];
    const value = JSON.stringify({
      schemaVersion: 1,
      drafts: candidate,
      pendingSends: [...pendingSends].map(([executionId, pending]) => ({
        executionId,
        ...pending
      }))
    });
    if (
      new TextEncoder().encode(value).byteLength >
      MANAGED_CONVERSATION_RECOVERY_TARGET_BYTES
    ) {
      if (pendingSends.has(draft.conversation.executionId ?? ""))
        throw new Error("Conversation recovery is full; no prompt was sent.");
      break;
    }
    entries.push({ routeId, draft });
  }
  const value = JSON.stringify({
    schemaVersion: 1,
    drafts: entries,
    pendingSends: [...pendingSends].map(([executionId, pending]) => ({
      executionId,
      ...pending
    }))
  });
  if (
    new TextEncoder().encode(value).byteLength >
    MANAGED_CONVERSATION_RECOVERY_TARGET_BYTES
  )
    throw new Error("Conversation recovery is full; no prompt was sent.");
  return value;
};

const provisionalConversationTitle = (prompt: string | undefined): string =>
  prompt?.trim().replace(/\s+/gu, " ").slice(0, 120) ||
  "New AI Client Conversation";

type CurrentManagedConversationLifecycle = ReturnType<
  typeof useManagedConversationLifecycle
>;
export type ManagedConversationLifecycle = Omit<
  CurrentManagedConversationLifecycle,
  "pendingSends" | "recoveryStatus" | "persistPendingSend"
> &
  Partial<
    Pick<
      CurrentManagedConversationLifecycle,
      "pendingSends" | "recoveryStatus" | "persistPendingSend"
    >
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
  update?: ManagedConversationUpdateEnvelope | null;
}) {
  const [drafts, setDrafts] = useState<
    ReadonlyMap<string, ManagedConversationDraft>
  >(new Map());
  const [pendingSends, setPendingSends] = useState<
    ReadonlyMap<string, ManagedConversationPendingSend>
  >(new Map());
  const pendingSendsRef = useRef(pendingSends);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [recoveryStatus, setRecoveryStatus] = useState<
    "loading" | "ready" | "unavailable"
  >("loading");
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
    setPendingSends(new Map());
    pendingSendsRef.current = new Map();
    setRecoveryStatus("loading");
    executionVersions.current.clear();
    setRecoveryOwner(null);
    if (!ownerId) return;
    let active = true;
    if (!api?.readRecovery) {
      setRecoveryStatus("unavailable");
      setRecoveryOwner(ownerId);
      return;
    }
    void api
      .readRecovery(ownerId)
      .then((result) => {
        if (!active || scope.current !== currentScope) return;
        const recovered = recoveredManagedConversationState(result.value);
        pendingSendsRef.current = recovered.pendingSends;
        setPendingSends(recovered.pendingSends);
        setDrafts((current) => new Map([...recovered.drafts, ...current]));
        setRecoveryStatus("ready");
        setRecoveryOwner(ownerId);
      })
      .catch(() => {
        if (active && scope.current === currentScope) {
          setRecoveryStatus("unavailable");
          setRecoveryOwner(ownerId);
        }
      });
    return () => {
      active = false;
    };
  }, [api, ownerId]);

  useEffect(() => {
    if (
      !ownerId ||
      recoveryOwner !== ownerId ||
      recoveryStatus !== "ready" ||
      !api?.writeRecovery
    )
      return;
    const currentScope = scope.current;
    const write = api.writeRecovery;
    const timer = window.setTimeout(() => {
      writeQueue.current = writeQueue.current
        .catch(() => undefined)
        .then(async () => {
          if (scope.current === currentScope)
            await write(
              ownerId,
              managedConversationRecoveryValue(
                draftsRef.current,
                pendingSendsRef.current
              )
            );
        })
        .catch(() => undefined);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [api, drafts, ownerId, recoveryOwner, recoveryStatus]);

  const persistPendingSend = useCallback(
    async (
      executionId: string,
      pending: ManagedConversationPendingSend | null,
      settlement?: InitialPromptSettlement,
      expectedRequest?: ManagedConversationPendingSend["request"]
    ) => {
      if (
        !ownerId ||
        recoveryStatus !== "ready" ||
        recoveryOwner !== ownerId ||
        !api?.writeRecovery ||
        scope.current !== currentScope ||
        (pending && pending.request.executionId !== executionId)
      )
        throw new Error(
          "Secure Conversation recovery is unavailable; no prompt was sent."
        );
      const write = api.writeRecovery;
      const commit = writeQueue.current
        .catch(() => undefined)
        .then(async () => {
          if (scope.current !== currentScope)
            throw new Error("Conversation owner changed; no prompt was sent.");
          const next = new Map(pendingSendsRef.current);
          const existing = next.get(executionId);
          if (!pending && !existing && expectedRequest) return;
          if (
            pending &&
            existing &&
            exactRecoveryValue(existing) !== exactRecoveryValue(pending)
          )
            throw new Error(
              "Another unresolved prompt already owns this Conversation."
            );
          if (
            !pending &&
            (existing || expectedRequest) &&
            (!existing ||
              !expectedRequest ||
              exactRecoveryValue(existing.request) !==
                exactRecoveryValue(expectedRequest))
          )
            throw new Error(
              "The pending prompt changed; its older result cannot clear recovery."
            );
          if (pending) next.set(executionId, pending);
          else next.delete(executionId);
          const nextDrafts = new Map(draftsRef.current);
          if (settlement) {
            const entry = [...nextDrafts.entries()].find(
              ([, draft]) =>
                draft.conversation.executionId === executionId &&
                draft.initialPrompt?.clientUserMessageId ===
                  settlement.clientUserMessageId
            );
            if (entry) {
              const [routeId, draft] = entry;
              nextDrafts.set(routeId, {
                ...draft,
                initialPrompt: { ...draft.initialPrompt!, ...settlement }
              });
            }
          }
          await write(
            ownerId,
            managedConversationRecoveryValue(nextDrafts, next)
          );
          if (scope.current !== currentScope)
            throw new Error("Conversation owner changed; no prompt was sent.");
          pendingSendsRef.current = next;
          draftsRef.current = nextDrafts;
          setDrafts(nextDrafts);
          setPendingSends(next);
        });
      writeQueue.current = commit.catch(() => undefined);
      await commit;
    },
    [api, ownerId, recoveryOwner, recoveryStatus, currentScope]
  );

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
      const next = new Map(draftsRef.current).set(routeId, {
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
      });
      draftsRef.current = next;
      setDrafts(next);
      return routeId;
    },
    [store, currentScope]
  );

  const processedUpdateRevision = useRef(0);
  useEffect(() => {
    if (!update) return;
    const batch = managedConversationUpdatesSince(
      update,
      processedUpdateRevision.current
    );
    processedUpdateRevision.current = update.revision;
    for (const { update: realtime } of batch.updates) {
      const previous = executionVersions.current.get(realtime.execution.id);
      const generation = realtime.execution.executionGeneration;
      const version = realtime.execution.stateVersion;
      if (
        previous &&
        (generation < previous.generation ||
          (generation === previous.generation && version < previous.version))
      )
        continue;
      executionVersions.current.set(realtime.execution.id, {
        generation,
        version
      });
      setDrafts((current) => {
        const entry = [...current.entries()].find(
          ([, draft]) =>
            draft.conversation.executionId === realtime.execution.id
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
    }
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
                await write(
                  ownerId,
                  managedConversationRecoveryValue(
                    draftsRef.current,
                    pendingSendsRef.current
                  )
                );
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
  return {
    drafts,
    pendingSends,
    recoveryStatus:
      recoveryOwner === ownerId ? recoveryStatus : ("loading" as const),
    persistPendingSend,
    started,
    retry
  };
}
