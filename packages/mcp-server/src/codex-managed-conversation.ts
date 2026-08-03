import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CodexAppServerClient,
  CodexAppServerCapacityError,
  acquireManagedCodexHomeLease,
  codexAppServerRawEventByteLength,
  prepareManagedCodexHome,
  removeManagedCodexHome,
  reuseManagedCodexHome,
  type CodexAppServerExit,
  type CodexAppServerRawEvent,
  type CodexAppServerRunConfig,
  type CodexAppServerRunResult,
  type CodexAppServerThreadInfo,
  type ManagedCodexHomeLease
} from "./codex-app-server-runner.js";
import {
  assertCodexConversationProtocolCompatibility,
  type CodexConversationProtocolCompatibility
} from "./codex-app-server-protocol-compatibility.js";
import {
  adaptCodexAppServerConversationEvent,
  type CodexConversationIdentityIssue,
  type CodexManagedConversationSourceContext
} from "./codex-conversation-source-adapter.js";
import { ingestCodexTranscriptJournal } from "./codex-transcript-journal.js";
import type { MemoryApiClient } from "./index.js";
import {
  persistRawConversationItems,
  projectRawConversationItems
} from "./raw-conversation-items.js";
import type { RawConversationItemRequest } from "./conversation-source-types.js";

export interface CodexManagedConversationConfig {
  memoryClient: MemoryApiClient;
  appServer: CodexAppServerRunConfig;
  projectId?: string;
  transcriptReadMaxBytes?: number;
  requestTimeoutMs?: number;
  interruptRequestTimeoutMs?: number;
  serverRequestTimeoutMs?: number;
  interruptGraceMs?: number;
  closeGraceMs?: number;
  terminalReconciliationTimeoutMs?: number;
  maxRawEvents?: number;
  maxRawEventBytes?: number;
  maxPendingRawEvents?: number;
  maxPendingRawEventBytes?: number;
  maxTurnStates?: number;
  maxTurnBytes?: number;
  maxLineBytes?: number;
  maxPreStartEvents?: number;
  maxPreStartEventBytes?: number;
  resume?: {
    threadId: string;
    sessionId: string;
    transcriptPath: string;
    codexHome: string;
  };
  fork?: {
    parentThreadId: string;
    sourceTranscriptPath: string;
    codexHome: string;
  };
}

export interface CodexManagedConversationStartResult {
  thread: CodexAppServerThreadInfo;
  sessionId: string;
  transcriptPath: string;
  codexHome: string;
}

export interface CodexManagedConversationSealedSource {
  threadId: string;
  sessionId: string;
  artifactId: string;
  logicalSourceId: string;
  sourceGenerationId: string;
  originKeyId: string;
  closureHash: string;
  providerCursorOffset: number;
  providerCursorLine: number;
}

export class CodexManagedConversationIdentityError extends Error {
  constructor(readonly issues: CodexConversationIdentityIssue[]) {
    super(
      `Codex managed conversation has ${issues.length} unresolved source identit${
        issues.length === 1 ? "y" : "ies"
      }`
    );
    this.name = "CodexManagedConversationIdentityError";
  }
}

export class CodexManagedConversationCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexManagedConversationCapacityError";
  }
}

export const KOED_MANAGED_CONVERSATION_ENV = "KOED_MANAGED_CONVERSATION";

const DEFAULT_MAX_PRE_START_EVENTS = 1_000;
const DEFAULT_MAX_PRE_START_EVENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TERMINAL_RECONCILIATION_TIMEOUT_MS = 5_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const positiveFiniteInteger = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const identityIssueKey = (issue: CodexConversationIdentityIssue): string =>
  JSON.stringify(issue);

const itemTurnId = (item: RawConversationItemRequest): string | null =>
  typeof item.externalTurnId === "string" ? item.externalTurnId : null;

const isTerminalItem = (item: RawConversationItemRequest): boolean => {
  const metadata = asRecord(item.metadata);
  return (
    metadata.semanticControl === "turn_completed" ||
    item.sourceEventType === "turn_aborted"
  );
};

const rawEventThreadId = (
  event: CodexAppServerRawEvent
): string | undefined => {
  const params = asRecord(event.params);
  const result = asRecord(event.result);
  const candidates = [
    params.threadId,
    asRecord(params.thread).id,
    asRecord(result.thread).id
  ];
  return candidates.find(
    (candidate): candidate is string => typeof candidate === "string"
  );
};

type ManagedConversationSource = {
  thread: CodexAppServerThreadInfo;
  sessionId: string;
  threadKind: "conversation" | "subagent";
  parentThreadId?: string;
  parentSessionId?: string;
};

const threadInfoFromStartedEvent = (
  event: CodexAppServerRawEvent
): CodexAppServerThreadInfo | null => {
  if (event.method !== "thread/started") {
    return null;
  }
  const thread = asRecord(asRecord(event.params).thread);
  if (typeof thread.id !== "string") {
    return null;
  }
  return {
    id: thread.id,
    ...(typeof thread.sessionId === "string"
      ? { sessionId: thread.sessionId }
      : {}),
    ...(typeof thread.path === "string" ? { path: thread.path } : {}),
    ...(typeof thread.cwd === "string" ? { cwd: thread.cwd } : {}),
    ...(thread.source !== undefined ? { source: thread.source } : {}),
    ...(typeof thread.modelProvider === "string"
      ? { modelProvider: thread.modelProvider }
      : {}),
    ...(typeof thread.cliVersion === "string"
      ? { cliVersion: thread.cliVersion }
      : {}),
    ...(thread.gitInfo !== undefined ? { gitInfo: thread.gitInfo } : {}),
    ...(typeof thread.name === "string" ? { name: thread.name } : {}),
    ...(typeof thread.parentThreadId === "string"
      ? { parentThreadId: thread.parentThreadId }
      : {}),
    ...(typeof thread.forkedFromId === "string"
      ? { forkedFromId: thread.forkedFromId }
      : {}),
    raw: thread
  };
};

const mergeStartedThreadInfo = (
  responseThread: CodexAppServerThreadInfo,
  events: CodexAppServerRawEvent[]
): CodexAppServerThreadInfo => {
  const startedThreads = events
    .map(threadInfoFromStartedEvent)
    .filter(
      (thread): thread is CodexAppServerThreadInfo =>
        thread?.id === responseThread.id
    );
  let merged = responseThread;
  for (const startedThread of startedThreads) {
    for (const field of [
      "sessionId",
      "parentThreadId",
      "forkedFromId",
      "path",
      "cwd"
    ] as const) {
      if (
        merged[field] !== undefined &&
        startedThread[field] !== undefined &&
        merged[field] !== startedThread[field]
      ) {
        throw new Error(
          `Codex app-server thread/start and thread/started disagree on ${field}`
        );
      }
    }
    merged = {
      ...startedThread,
      ...merged,
      raw: { ...startedThread.raw, ...merged.raw }
    };
  }
  return merged;
};

export class CodexManagedConversationSession {
  private client: CodexAppServerClient | null = null;
  private readonly bufferedEvents: CodexAppServerRawEvent[] = [];
  private readonly identityIssues: CodexConversationIdentityIssue[] = [];
  private readonly identityIssueKeys = new Set<string>();
  private readonly clientUserMessageIds = new Map<string, string>();
  private readonly terminalTurnSessions = new Map<string, string>();
  private readonly childSources = new Map<string, ManagedConversationSource>();
  private bufferedEventBytes = 0;
  private thread: CodexAppServerThreadInfo | null = null;
  private protocol: CodexConversationProtocolCompatibility | null = null;
  private sessionId: string | null = null;
  private startPromise: Promise<CodexManagedConversationStartResult> | null =
    null;
  private turnQueue: Promise<void> = Promise.resolve();
  private closingPromise: Promise<void> | null = null;
  private managedHome: string | null = null;
  private managedHomeLease: ManagedCodexHomeLease | null = null;
  private managedHomeDurable = false;
  private terminalError: Error | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly config: CodexManagedConversationConfig) {}

  async start(): Promise<CodexManagedConversationStartResult> {
    if (this.started && this.client && !this.client.isClosed()) {
      return this.startResult();
    }
    if (this.started) {
      this.started = false;
      this.client = null;
    }
    if (this.closed) {
      throw (
        this.terminalError ??
        new Error("Codex managed conversation session is closed")
      );
    }
    if (!this.startPromise) {
      const startPromise = this.startInternal();
      this.startPromise = startPromise;
      const clearStartPromise = () => {
        if (this.startPromise === startPromise) {
          this.startPromise = null;
        }
      };
      void startPromise.then(clearStartPromise, clearStartPromise);
    }
    return this.startPromise;
  }

  private async startInternal(): Promise<CodexManagedConversationStartResult> {
    const previousThread = this.thread;
    const previousSessionId = this.sessionId;
    const resumeTarget =
      previousThread &&
      previousSessionId &&
      previousThread.path &&
      this.managedHome
        ? {
            threadId: previousThread.id,
            sessionId: previousSessionId,
            transcriptPath: previousThread.path,
            codexHome: this.managedHome
          }
        : this.config.resume;
    const forkTarget = resumeTarget ? undefined : this.config.fork;
    let managedHome: string | null = null;
    let client: CodexAppServerClient | null = null;
    try {
      managedHome =
        resumeTarget || forkTarget
          ? path.resolve((resumeTarget ?? forkTarget)!.codexHome)
          : prepareManagedCodexHome(this.config.appServer.env);
      this.managedHome ??= managedHome;
      this.managedHomeDurable = Boolean(resumeTarget || forkTarget);
      if (
        this.managedHomeLease &&
        this.managedHomeLease.managedHome !== managedHome
      ) {
        throw new Error(
          "Managed Codex home lease does not match resume target"
        );
      }
      this.managedHomeLease ??= acquireManagedCodexHomeLease(
        managedHome,
        this.config.appServer.env
      );
      if (resumeTarget || forkTarget) {
        managedHome = reuseManagedCodexHome(
          managedHome,
          this.config.appServer.env
        );
      }
      const managedEnv = {
        ...this.config.appServer.env,
        CODEX_HOME: managedHome,
        [KOED_MANAGED_CONVERSATION_ENV]: "1"
      };
      this.protocol = assertCodexConversationProtocolCompatibility({
        binary: this.config.appServer.appServerBinary,
        cwd: this.config.appServer.cwd,
        env: managedEnv
      });
      const createdClient = new CodexAppServerClient(
        this.config.appServer.appServerBinary,
        this.config.appServer.cwd,
        managedEnv,
        (event) => this.handleRawEvent(event),
        {
          requestTimeoutMs: this.config.requestTimeoutMs,
          interruptRequestTimeoutMs: this.config.interruptRequestTimeoutMs,
          serverRequestTimeoutMs: this.config.serverRequestTimeoutMs,
          closeGraceMs: this.config.closeGraceMs,
          maxRawEvents: this.config.maxRawEvents,
          maxRawEventBytes: this.config.maxRawEventBytes,
          maxPendingRawEvents: this.config.maxPendingRawEvents,
          maxPendingRawEventBytes: this.config.maxPendingRawEventBytes,
          maxTurnStates: this.config.maxTurnStates,
          maxTurnBytes: this.config.maxTurnBytes,
          maxLineBytes: this.config.maxLineBytes,
          onExit: (exit) =>
            this.handleClientExit(createdClient, managedHome!, exit)
        }
      );
      client = createdClient;
      this.client = client;
      const initialization = await client.initialize(
        this.config.appServer.clientName
      );
      if (typeof initialization.codexHome !== "string") {
        throw new Error(
          "Codex app-server initialize response did not include codexHome"
        );
      }
      if (initialization.codexHome !== managedHome) {
        throw new Error(
          "Codex app-server initialize response reported an unexpected codexHome"
        );
      }
      let thread = resumeTarget
        ? await client.resumeThread(
            resumeTarget.threadId,
            this.config.appServer
          )
        : forkTarget
          ? await client.forkThread(
              forkTarget.parentThreadId,
              forkTarget.sourceTranscriptPath,
              this.config.appServer
            )
          : await client.startThread(this.config.appServer, {
              ephemeral: false,
              historyMode: "legacy",
              threadSource: "user",
              minimalContext: false
            });
      await client.flushRawEventHandler();
      thread = mergeStartedThreadInfo(thread, this.bufferedEvents);
      if (!thread.path) {
        throw new Error(
          "Codex managed conversation must have a persisted rollout path"
        );
      }
      if (resumeTarget) {
        if (thread.id !== resumeTarget.threadId) {
          throw new Error(
            "Codex app-server resumed a different thread identity"
          );
        }
        if (thread.path !== resumeTarget.transcriptPath) {
          throw new Error(
            "Codex app-server resumed a thread with a different rollout path"
          );
        }
      }
      if (
        forkTarget &&
        (thread.id === forkTarget.parentThreadId ||
          thread.forkedFromId !== forkTarget.parentThreadId ||
          thread.path === forkTarget.sourceTranscriptPath)
      ) {
        throw new Error(
          "Codex app-server did not preserve the requested fork lineage"
        );
      }
      const response = await this.config.memoryClient.createSession({
        ...(this.config.projectId ? { projectId: this.config.projectId } : {}),
        externalSessionId: thread.id,
        sourceRuntime: "codex",
        captureMethod: "api",
        model: this.config.appServer.model,
        cwd: thread.cwd ?? this.config.appServer.cwd,
        idempotencyKey: `managed-codex-session:${thread.id}`,
        sourceHash: sha256({
          adapter: "codex-app-server-conversation-v1",
          threadId: thread.id,
          sessionId: thread.sessionId,
          path: thread.path,
          parentThreadId: thread.parentThreadId
        }),
        metadata: {
          managedConversation: true,
          externalThreadId: thread.id,
          sessionTreeId: thread.sessionId,
          ...(thread.parentThreadId
            ? {
                parentThreadId: thread.parentThreadId,
                parentExternalSessionId: thread.parentThreadId
              }
            : {}),
          ...(thread.forkedFromId
            ? {
                forked_from_id: thread.forkedFromId
              }
            : {}),
          threadSource: thread.source,
          modelProvider: thread.modelProvider,
          cliVersion: thread.cliVersion,
          gitInfo: thread.gitInfo,
          appServerInitialize: {
            codexHome: initialization.codexHome,
            platformFamily: initialization.platformFamily,
            platformOs: initialization.platformOs
          },
          appServerProtocol: {
            adapterVersion: "codex-app-server-conversation-v1",
            schemaSha256: this.protocol.schemaSha256
          }
        }
      });
      const session = asRecord(response.session);
      if (response.skipped === true || typeof session.id !== "string") {
        throw new Error(
          response.skipped === true
            ? "Capture Policy did not create a Captured Session for the managed Codex conversation"
            : "Koed did not create a Captured Session for the managed Codex thread"
        );
      }
      if (resumeTarget && session.id !== resumeTarget.sessionId) {
        throw new Error(
          "Managed Codex resume does not match its Captured Session"
        );
      }
      this.thread = thread;
      this.sessionId = session.id;
      this.managedHomeDurable = true;
      if (this.closed) {
        throw new Error("Codex managed conversation session is closed");
      }
      if (client.isClosed()) {
        throw new Error(
          "Codex managed conversation app-server exited during startup"
        );
      }
      await this.persistBufferedEvents();
      if (client.isClosed()) {
        throw new Error(
          "Codex managed conversation app-server exited during startup"
        );
      }
      this.started = true;
      if (resumeTarget || forkTarget) {
        await this.reconcileTranscript();
      }
      this.throwIdentityIssues();
      return this.startResult();
    } catch (error) {
      this.started = false;
      if (!this.managedHomeDurable) {
        this.thread = previousThread;
        this.sessionId = previousSessionId;
      }
      this.bufferedEvents.length = 0;
      this.bufferedEventBytes = 0;
      if (!this.managedHomeDurable && (!previousThread || !previousSessionId)) {
        this.clearTurnTracking();
      }
      if (client && this.client === client) {
        this.client = null;
      }
      if (
        error instanceof CodexManagedConversationCapacityError ||
        error instanceof CodexAppServerCapacityError ||
        client?.terminalFailure()
      ) {
        this.terminalError =
          error instanceof Error
            ? error
            : (client?.terminalFailure() ?? new Error(String(error)));
        this.closed = true;
      }
      if (client) {
        try {
          await client.closeAndWait(
            positiveFiniteInteger(this.config.closeGraceMs, 1_000)
          );
        } catch {
          // Preserve the startup failure that initiated cleanup.
        }
      }
      this.removeManagedHome(managedHome);
      throw error;
    }
  }

  async runTurn(
    prompt: string,
    timeoutMs: number,
    clientUserMessageId?: string
  ): Promise<CodexAppServerRunResult> {
    const operation = this.turnQueue.then(() =>
      this.runTurnSerialized(prompt, timeoutMs, clientUserMessageId)
    );
    this.turnQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async runTurnSerialized(
    prompt: string,
    timeoutMs: number,
    requestedClientUserMessageId?: string
  ): Promise<CodexAppServerRunResult> {
    await this.start();
    const client = this.appServerClient();
    const thread = this.thread!;
    await client.flushRawEventHandler();
    if (thread.path && fs.existsSync(thread.path)) {
      await this.reconcileTranscript();
    }
    this.throwIdentityIssues();

    const rawEventStart = client.rawEventCount();
    const clientUserMessageId =
      requestedClientUserMessageId ?? `koed-user-message:${randomUUID()}`;
    const effectiveTimeoutMs = positiveFiniteInteger(timeoutMs, 1);
    let timeout: NodeJS.Timeout | undefined;
    let result: CodexAppServerRunResult | undefined;
    let runError: unknown;
    let timedOut = false;
    let turnId: string | null = null;
    let turnPromise: Promise<CodexAppServerRunResult> | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        reject(
          new Error(`Codex app-server timed out after ${effectiveTimeoutMs}ms`)
        );
      }, effectiveTimeoutMs);
    });
    try {
      turnId = await Promise.race([
        client.startTurn(
          thread.id,
          prompt,
          this.config.appServer,
          clientUserMessageId
        ),
        timeoutPromise
      ]);
      this.clientUserMessageIds.set(turnId, clientUserMessageId);
      turnPromise = client.waitForTurn(thread.id, turnId);
      result = await Promise.race([turnPromise, timeoutPromise]);
    } catch (error) {
      runError = error;
    }
    if (timeout) {
      clearTimeout(timeout);
    }

    let interruptError: unknown;
    if (timedOut) {
      this.closed = true;
      this.started = false;
      if (turnId && turnPromise) {
        try {
          await client.interruptTurn(thread.id, turnId);
        } catch (error) {
          interruptError = error;
        }
        await this.awaitTurnTerminal(
          turnPromise,
          positiveFiniteInteger(this.config.interruptGraceMs, 1_000)
        );
      } else {
        // A turn/start response can be lost after the server accepted the turn.
        // Stop the child immediately when no turn id exists to interrupt.
        client.close();
        try {
          await client.closeAndWait(
            positiveFiniteInteger(this.config.closeGraceMs, 1_000)
          );
        } catch (error) {
          interruptError = error;
        }
      }
    }

    const turnStartFailed = !timedOut && !turnId && runError !== undefined;
    const recoverableTransportStop =
      turnStartFailed &&
      client.isClosed() &&
      !client.terminalFailure() &&
      !this.terminalError;
    let turnStartCleanupError: unknown;
    if (turnStartFailed) {
      this.closed = !recoverableTransportStop;
      this.started = false;
      client.close();
      try {
        await client.closeAndWait(
          positiveFiniteInteger(this.config.closeGraceMs, 1_000)
        );
      } catch (error) {
        turnStartCleanupError = error;
      }
    }

    let ingestionError: unknown;
    try {
      await client.flushRawEventHandler();
    } catch (error) {
      ingestionError = error;
    }
    try {
      if (turnId) {
        await this.reconcileAndSealTurn(turnId, ingestionError === undefined);
      } else if (thread.path && fs.existsSync(thread.path)) {
        await this.reconcileTranscript();
      }
    } catch (error) {
      ingestionError = ingestionError ?? error;
    }
    try {
      this.throwIdentityIssues();
    } catch (error) {
      ingestionError = ingestionError ?? error;
    }

    if (timedOut) {
      this.closed = true;
      this.started = false;
      if (this.client === client) {
        this.client = null;
      }
      try {
        await client.closeAndWait(
          positiveFiniteInteger(this.config.closeGraceMs, 1_000)
        );
      } catch (error) {
        ingestionError = ingestionError ?? error;
      }
      this.removeManagedHome();
      const causes = [interruptError, ingestionError].filter(
        (error) => error !== undefined
      );
      throw new Error(
        `Codex app-server timed out after ${effectiveTimeoutMs}ms`,
        {
          ...(causes.length > 0 ? { cause: causes[0] } : {})
        }
      );
    }
    if (turnStartFailed) {
      if (this.client === client) {
        this.client = null;
      }
      if (!recoverableTransportStop) {
        this.removeManagedHome();
      }
      if (
        runError instanceof Error &&
        (turnStartCleanupError !== undefined || ingestionError !== undefined)
      ) {
        throw new Error(runError.message, {
          cause: turnStartCleanupError ?? ingestionError
        });
      }
      throw runError;
    }
    if (client.terminalFailure()) {
      this.terminalError = client.terminalFailure();
      this.closed = true;
      this.started = false;
      if (this.client === client) {
        this.client = null;
      }
      try {
        await client.closeAndWait(
          positiveFiniteInteger(this.config.closeGraceMs, 1_000)
        );
      } catch (error) {
        ingestionError = ingestionError ?? error;
      }
      this.removeManagedHome();
    }
    if (ingestionError) {
      throw ingestionError;
    }
    if (runError) {
      throw runError;
    }
    if (!result) {
      throw new Error("Codex app-server turn finished without a result");
    }
    return {
      ...result,
      model: `codex-app-server:${this.config.appServer.model}:${this.config.appServer.reasoningEffort}`,
      threadId: thread.id,
      turnId: turnId ?? undefined,
      rawEvents: client.rawEventsSince(rawEventStart),
      primaryThreadId: thread.id
    };
  }

  async reconcileTranscript(): Promise<number> {
    return this.reconcileTranscriptInternal(true);
  }

  private async reconcileTranscriptInternal(
    releaseTerminalTurns: boolean
  ): Promise<number> {
    const start = this.startResult();
    const sources: ManagedConversationSource[] = [
      {
        thread: start.thread,
        sessionId: start.sessionId,
        threadKind: "conversation"
      },
      ...this.childSources.values()
    ];
    let persistedCount = 0;
    for (const source of sources) {
      persistedCount += await this.reconcileConversationSource(
        source,
        releaseTerminalTurns
      );
    }
    if (releaseTerminalTurns) {
      await this.releaseTerminalTurns();
    }
    return persistedCount;
  }

  private async reconcileConversationSource(
    source: ManagedConversationSource,
    releaseTerminalTurns: boolean
  ): Promise<number> {
    if (!source.thread.path) {
      throw new Error(
        `Managed ${source.threadKind} thread ${source.thread.id} has no persisted rollout path`
      );
    }
    if (
      !fs.existsSync(source.thread.path) ||
      fs.statSync(source.thread.path).size === 0
    ) {
      return 0;
    }
    let persistedCount = 0;
    while (true) {
      const result = await ingestCodexTranscriptJournal({
        client: this.config.memoryClient,
        sourceSession: {
          externalSessionId: source.thread.id,
          sourceRuntime: "codex",
          captureMethod: "api",
          model: this.config.appServer.model,
          cwd: source.thread.cwd ?? this.config.appServer.cwd,
          idempotencyKey: `managed-codex-session:${source.thread.id}`,
          sourceHash: sha256({
            adapter: "codex-app-server-conversation-v1",
            threadId: source.thread.id,
            sessionId: source.thread.sessionId,
            path: source.thread.path,
            parentThreadId: source.parentThreadId
          }),
          metadata: {
            managedConversation: true,
            externalThreadId: source.thread.id,
            sessionTreeId: source.thread.sessionId,
            threadKind: source.threadKind,
            ...(source.parentThreadId
              ? {
                  parentThreadId: source.parentThreadId,
                  parentExternalSessionId: source.parentThreadId
                }
              : {}),
            ...(source.parentSessionId
              ? { parentSessionId: source.parentSessionId }
              : {}),
            threadSource: source.thread.source,
            modelProvider: source.thread.modelProvider,
            cliVersion: source.thread.cliVersion,
            gitInfo: source.thread.gitInfo,
            appServerProtocol: {
              adapterVersion: "codex-app-server-conversation-v1",
              schemaSha256: this.protocol?.schemaSha256
            }
          }
        },
        sourceSessionId: source.thread.id,
        transcriptPath: source.thread.path,
        context: {
          threadKind: source.threadKind,
          transcriptSessionId: source.thread.id,
          parentThreadId: source.parentThreadId,
          transcriptMetadata: {
            cwd: source.thread.cwd ?? this.config.appServer.cwd,
            ...(source.parentThreadId
              ? { parentThreadId: source.parentThreadId }
              : {}),
            ...(source.parentSessionId
              ? { parentSessionId: source.parentSessionId }
              : {})
          }
        },
        maxBytesPerBatch: this.config.transcriptReadMaxBytes ?? 1_000_000,
        liveStartOffset: 0,
        liveStartLine: 0,
        preferStableResponseItems: true,
        projectPersisted: async (persisted, items) => {
          const pageTerminalTurnIds = [
            ...new Set(
              items
                .filter((item) => isTerminalItem(item))
                .map(itemTurnId)
                .filter((turnId): turnId is string => turnId !== null)
            )
          ];
          this.rememberTerminalItems(items, source.sessionId);
          if (releaseTerminalTurns) {
            for (const turnId of pageTerminalTurnIds) {
              await this.releaseTurnProjection(turnId, source.sessionId);
            }
          }
          await projectRawConversationItems(
            this.config.memoryClient,
            persisted.filter((item) => !isTerminalItem(item)),
            `managed Codex transcript ${source.thread.id}`
          );
          return releaseTerminalTurns || pageTerminalTurnIds.length === 0;
        }
      });
      persistedCount += result.itemsPersisted;
      if (
        result.canonicalCursorOffset >= result.artifact.providerCursorOffset ||
        !result.cursorAdvanced ||
        result.recordsConsumed === 0
      ) {
        break;
      }
    }
    return persistedCount;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.started = false;
    const client = this.client;
    this.client = null;
    if (client) {
      client.close();
    } else {
      this.removeManagedHome();
    }
  }

  async closeAndWait(): Promise<void> {
    if (this.closingPromise) {
      return this.closingPromise;
    }
    this.closed = true;
    this.started = false;
    const closingPromise = this.closeAndWaitInternal();
    this.closingPromise = closingPromise;
    return closingPromise;
  }

  private async closeAndWaitInternal(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    await this.turnQueue.catch(() => undefined);
    const client = this.client;
    this.client = null;
    let handlerError: unknown;
    let reconcileError: unknown;
    let closeError: unknown;
    try {
      if (client) {
        try {
          await client.flushRawEventHandler();
        } catch (error) {
          handlerError = error;
        }
      }
      if (
        this.thread?.path &&
        this.sessionId &&
        fs.existsSync(this.thread.path)
      ) {
        try {
          await this.reconcileTranscriptInternal(true);
        } catch (error) {
          reconcileError = error;
        }
      }
      if (client) {
        try {
          await client.closeAndWait(
            positiveFiniteInteger(this.config.closeGraceMs, 1_000)
          );
          handlerError = undefined;
        } catch (error) {
          closeError = error;
        }
      }
      if (
        !closeError &&
        this.thread?.path &&
        this.sessionId &&
        fs.existsSync(this.thread.path)
      ) {
        try {
          await this.waitForStableTranscript(this.thread.path);
          await this.reconcileTranscriptInternal(true);
        } catch (error) {
          reconcileError = error;
        }
      }
    } finally {
      this.removeManagedHome();
    }
    const error =
      this.terminalError ?? closeError ?? handlerError ?? reconcileError;
    if (error) {
      throw error;
    }
  }

  async quiesceAndSealSources(): Promise<
    CodexManagedConversationSealedSource[]
  > {
    await this.closeAndWait();
    const primary = this.startResult();
    const sources: ManagedConversationSource[] = [
      {
        thread: primary.thread,
        sessionId: primary.sessionId,
        threadKind: "conversation"
      },
      ...this.childSources.values()
    ];
    const sealed: CodexManagedConversationSealedSource[] = [];
    for (const source of sources) {
      const lookup =
        await this.config.memoryClient.lookupConversationSourceArtifact({
          sourceKind: "codex",
          externalSessionId: source.thread.id
        });
      const artifact = asRecord(lookup.artifact);
      const artifactId = artifact.id;
      const logicalSourceId = artifact.logicalSourceId;
      const sourceGenerationId = artifact.sourceGenerationId;
      const originKeyId = artifact.originKeyId;
      const providerCursorOffset = artifact.providerCursorOffset;
      const providerCursorLine = artifact.providerCursorLine;
      if (
        typeof artifactId !== "string" ||
        typeof logicalSourceId !== "string" ||
        typeof sourceGenerationId !== "string" ||
        typeof originKeyId !== "string" ||
        typeof providerCursorOffset !== "number" ||
        typeof providerCursorLine !== "number"
      ) {
        throw new Error(
          `Managed Conversation source ${source.thread.id} is incomplete`
        );
      }
      const finalized =
        artifact.lifecycle === "finalized" &&
        typeof artifact.closureHash === "string"
          ? lookup
          : await this.config.memoryClient.finalizeConversationSourceArtifact(
              artifactId,
              {
                expectedProviderOffset: providerCursorOffset,
                expectedProviderLine: providerCursorLine
              }
            );
      const finalizedArtifact = asRecord(finalized.artifact);
      if (
        finalizedArtifact.lifecycle !== "finalized" ||
        typeof finalizedArtifact.closureHash !== "string"
      ) {
        throw new Error(
          `Managed Conversation source ${source.thread.id} was not sealed`
        );
      }
      sealed.push({
        threadId: source.thread.id,
        sessionId: source.sessionId,
        artifactId,
        logicalSourceId,
        sourceGenerationId,
        originKeyId,
        closureHash: finalizedArtifact.closureHash,
        providerCursorOffset,
        providerCursorLine
      });
    }
    return sealed;
  }

  private async waitForStableTranscript(transcriptPath: string): Promise<void> {
    let prior = fs.statSync(transcriptPath);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(25);
      const current = fs.statSync(transcriptPath);
      if (current.size === prior.size && current.mtimeMs === prior.mtimeMs) {
        return;
      }
      prior = current;
    }
    throw new Error("Managed Conversation transcript did not reach stable EOF");
  }

  private startResult(): CodexManagedConversationStartResult {
    if (
      !this.thread ||
      !this.sessionId ||
      !this.thread.path ||
      !this.managedHome
    ) {
      throw new Error("Codex managed conversation session has not started");
    }
    return {
      thread: this.thread,
      sessionId: this.sessionId,
      transcriptPath: this.thread.path,
      codexHome: this.managedHome
    };
  }

  private appServerClient(): CodexAppServerClient {
    if (!this.client) {
      throw new Error("Codex managed conversation app-server is not running");
    }
    return this.client;
  }

  private handleClientExit(
    client: CodexAppServerClient,
    managedHome: string,
    exit: CodexAppServerExit
  ): void {
    const wasCurrentClient = this.client === client;
    if (exit.terminalError) {
      this.terminalError = exit.terminalError;
      this.closed = true;
    } else if (
      wasCurrentClient &&
      !exit.requestedClose &&
      (exit.signal !== null || (exit.code !== null && exit.code !== 0))
    ) {
      this.terminalError = new Error(
        `Codex managed conversation app-server exited unexpectedly (${exit.code ?? exit.signal ?? "unknown"})`
      );
      this.closed = true;
    }
    if (wasCurrentClient) {
      this.client = null;
      this.started = false;
    }
    if (this.terminalError) {
      this.removeManagedHome(managedHome);
    } else if (exit.requestedClose) {
      this.removeManagedHome(managedHome);
    }
  }

  private removeManagedHome(
    managedHome = this.managedHome,
    force = false
  ): void {
    if (!managedHome) {
      return;
    }
    this.releaseManagedHomeLease(managedHome);
    if (!force && this.managedHomeDurable) {
      return;
    }
    if (this.managedHome === managedHome) {
      this.managedHome = null;
      this.managedHomeDurable = false;
    }
    removeManagedCodexHome(managedHome, this.config.appServer.env);
  }

  private releaseManagedHomeLease(managedHome: string): void {
    if (
      !this.managedHomeLease ||
      this.managedHomeLease.managedHome !== path.resolve(managedHome)
    ) {
      return;
    }
    const lease = this.managedHomeLease;
    this.managedHomeLease = null;
    lease.release();
  }

  private async handleRawEvent(event: CodexAppServerRawEvent): Promise<void> {
    if (!this.started || !this.thread || !this.sessionId) {
      const bytes = codexAppServerRawEventByteLength(event);
      const maxEvents = positiveFiniteInteger(
        this.config.maxPreStartEvents,
        DEFAULT_MAX_PRE_START_EVENTS
      );
      const maxBytes = positiveFiniteInteger(
        this.config.maxPreStartEventBytes,
        DEFAULT_MAX_PRE_START_EVENT_BYTES
      );
      if (
        this.bufferedEvents.length >= maxEvents ||
        this.bufferedEventBytes + bytes > maxBytes
      ) {
        throw new CodexManagedConversationCapacityError(
          `Codex managed conversation pre-start event capacity exceeded (${maxEvents} events / ${maxBytes} bytes)`
        );
      }
      this.bufferedEvents.push(event);
      this.bufferedEventBytes += bytes;
      return;
    }
    await this.persistEvent(event);
  }

  private sourceForThread(threadId: string): ManagedConversationSource | null {
    if (this.thread?.id === threadId && this.sessionId) {
      return {
        thread: this.thread,
        sessionId: this.sessionId,
        threadKind: "conversation",
        ...(this.thread.parentThreadId
          ? { parentThreadId: this.thread.parentThreadId }
          : {})
      };
    }
    return this.childSources.get(threadId) ?? null;
  }

  private async ensureChildSource(
    thread: CodexAppServerThreadInfo & { parentThreadId?: string }
  ): Promise<ManagedConversationSource> {
    const existing = this.childSources.get(thread.id);
    if (existing) {
      return existing;
    }
    if (!thread.parentThreadId) {
      throw new Error(
        `Non-primary managed thread ${thread.id} has no parent identity`
      );
    }
    const parent = this.sourceForThread(thread.parentThreadId);
    if (!parent) {
      throw new Error(
        `Managed child thread ${thread.id} references unknown parent ${thread.parentThreadId}`
      );
    }
    if (!thread.path) {
      throw new Error(
        `Managed child thread ${thread.id} has no persisted rollout path`
      );
    }
    const response = await this.config.memoryClient.createSession({
      ...(this.config.projectId ? { projectId: this.config.projectId } : {}),
      externalSessionId: thread.id,
      sourceRuntime: "codex",
      captureMethod: "api",
      model: this.config.appServer.model,
      cwd: thread.cwd ?? this.config.appServer.cwd,
      idempotencyKey: `managed-codex-session:${thread.id}`,
      sourceHash: sha256({
        adapter: "codex-app-server-conversation-v1",
        threadId: thread.id,
        sessionId: thread.sessionId,
        path: thread.path,
        parentThreadId: thread.parentThreadId
      }),
      metadata: {
        managedConversation: true,
        externalThreadId: thread.id,
        sessionTreeId: thread.sessionId,
        threadKind: "subagent",
        parentThreadId: thread.parentThreadId,
        parentExternalSessionId: thread.parentThreadId,
        parentSessionId: parent.sessionId,
        threadSource: thread.source,
        modelProvider: thread.modelProvider,
        cliVersion: thread.cliVersion,
        gitInfo: thread.gitInfo,
        appServerProtocol: {
          adapterVersion: "codex-app-server-conversation-v1",
          schemaSha256: this.protocol?.schemaSha256
        }
      }
    });
    const session = asRecord(response.session);
    if (response.skipped === true || typeof session.id !== "string") {
      throw new Error(
        `Koed did not create a Captured Session for child thread ${thread.id}`
      );
    }
    const source: ManagedConversationSource = {
      thread,
      sessionId: session.id,
      threadKind: "subagent",
      parentThreadId: thread.parentThreadId,
      parentSessionId: parent.sessionId
    };
    this.childSources.set(thread.id, source);
    return source;
  }

  private async persistEvent(event: CodexAppServerRawEvent): Promise<void> {
    const startedThread = threadInfoFromStartedEvent(event);
    if (startedThread && this.thread && startedThread.id !== this.thread.id) {
      await this.ensureChildSource(startedThread);
    }
    const threadId = rawEventThreadId(event) ?? this.thread?.id;
    const source = threadId ? this.sourceForThread(threadId) : null;
    if (!source) {
      throw new Error(
        `Managed app-server event ${event.method} references an unknown thread`
      );
    }
    const context: CodexManagedConversationSourceContext = {
      sessionId: source.sessionId,
      externalThreadId: source.thread.id,
      transcriptPath: source.thread.path,
      clientUserMessageIds: this.clientUserMessageIds
    };
    const adapted = adaptCodexAppServerConversationEvent(event, context);
    this.addIdentityIssues(adapted.identityIssues);
    if (adapted.items.length === 0) {
      return;
    }
    await persistRawConversationItems(
      this.config.memoryClient,
      adapted.items,
      `managed Codex app-server event ${event.method}`
    );
  }

  private async persistBufferedEvents(): Promise<void> {
    this.bufferedEvents.sort((left, right) => left.sequence - right.sequence);
    while (this.bufferedEvents.length > 0) {
      const event = this.bufferedEvents[0]!;
      await this.persistEvent(event);
      this.bufferedEvents.shift();
      this.bufferedEventBytes -= codexAppServerRawEventByteLength(event);
    }
    this.bufferedEventBytes = 0;
  }

  private async reconcileAndSealTurn(
    turnId: string,
    releaseProjection: boolean
  ): Promise<void> {
    if (!releaseProjection) {
      await this.reconcileTranscriptInternal(false);
      return;
    }
    const stopAt =
      Date.now() +
      positiveFiniteInteger(
        this.config.terminalReconciliationTimeoutMs,
        DEFAULT_TERMINAL_RECONCILIATION_TIMEOUT_MS
      );
    while (Date.now() < stopAt) {
      await this.reconcileTranscriptInternal(false);
      const terminalSessionId = this.terminalTurnSessions.get(turnId);
      if (terminalSessionId) {
        await this.releaseTurnProjection(turnId, terminalSessionId);
        await this.releaseTerminalTurns();
        return;
      }
      await sleep(50);
    }
    throw new Error(
      `Codex transcript did not persist terminal evidence for turn ${turnId}`
    );
  }

  private async releaseTurnProjection(
    turnId: string,
    sessionId = this.terminalTurnSessions.get(turnId) ?? this.sessionId!
  ): Promise<void> {
    const released =
      await this.config.memoryClient.releaseConversationProjectionHold({
        sessionId,
        externalTurnId: turnId
      });
    if (released.conversationItemIds.length > 0) {
      await projectRawConversationItems(
        this.config.memoryClient,
        released.conversationItemIds.map((id) => ({ id })),
        `managed Codex terminal turn ${turnId}`
      );
    }
    this.terminalTurnSessions.delete(turnId);
    this.clientUserMessageIds.delete(turnId);
  }

  private async releaseTerminalTurns(): Promise<void> {
    for (const [turnId, sessionId] of [...this.terminalTurnSessions]) {
      await this.releaseTurnProjection(turnId, sessionId);
    }
  }

  private rememberTerminalItems(
    source: RawConversationItemRequest[],
    sessionId: string
  ): void {
    for (const item of source) {
      const turnId = itemTurnId(item);
      if (turnId && isTerminalItem(item)) {
        this.terminalTurnSessions.set(turnId, sessionId);
      }
    }
  }

  private addIdentityIssues(issues: CodexConversationIdentityIssue[]): void {
    const limit = positiveFiniteInteger(this.config.maxTurnStates, 100);
    for (const issue of issues) {
      const key = identityIssueKey(issue);
      if (this.identityIssueKeys.has(key)) {
        continue;
      }
      this.identityIssueKeys.add(key);
      this.identityIssues.push(issue);
      if (this.identityIssues.length > limit) {
        const removed = this.identityIssues.shift();
        if (removed) {
          this.identityIssueKeys.delete(identityIssueKey(removed));
        }
      }
    }
  }

  private async awaitTurnTerminal(
    turnPromise: Promise<CodexAppServerRunResult>,
    graceMs: number
  ): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        turnPromise.then(
          () => true,
          () => true
        ),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), graceMs);
        })
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private clearTurnTracking(): void {
    this.clientUserMessageIds.clear();
    this.terminalTurnSessions.clear();
    this.childSources.clear();
    this.identityIssues.length = 0;
    this.identityIssueKeys.clear();
  }

  private throwIdentityIssues(): void {
    if (this.identityIssues.length > 0) {
      throw new CodexManagedConversationIdentityError([...this.identityIssues]);
    }
  }
}
