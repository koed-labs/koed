import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as mcpServerApi from "../src/index.js";
import {
  CodexAppServerClient,
  prepareManagedCodexHome,
  removeManagedCodexHome
} from "../src/codex-app-server-runner.js";
import { MemoryApiError, type MemoryApiClient } from "../src/index.js";
import {
  CodexManagedConversationSession,
  KOED_MANAGED_CONVERSATION_ENV
} from "../src/codex-managed-conversation.js";

const protocolNotificationMethods = [
  "thread/started",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "turn/started",
  "turn/completed",
  "thread/tokenUsage/updated"
];
const protocolRequestMethods = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "turn/start",
  "turn/interrupt"
];
const protocolItemTypes = [
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "plan",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction"
];

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 1_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const managedSessionHomes = (directory: string): string[] => {
  const root = path.join(directory, "koed-home", "codex-managed");
  return fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .filter((entry) => entry.startsWith("session-"))
        .map((entry) => path.join(root, entry))
    : [];
};

const writeManagedFakeAppServer = (
  directory: string,
  transcriptPath: string,
  options: {
    turnDelayMs?: number;
    terminalJsonlDelayMs?: number;
    runUntilInterrupted?: boolean;
    interruptTerminalDelayMs?: number;
    ignoreInterruptResponse?: boolean;
    retryableError?: boolean;
    nonRetryableErrorBeforeCompletion?: boolean;
    unsupportedServerRequest?: boolean;
    stateNoiseCount?: number;
    transientDeltaCount?: number;
    childNotificationCount?: number;
    preStartEventCount?: number;
    hangTurnStartResponse?: boolean;
    oversizedAnswerBytes?: number;
    idleNotificationDelayMs?: number;
    exitAfterTurn?: boolean;
    continueTurnIndexAcrossLaunches?: boolean;
    hangFirstInitialize?: boolean;
    launchCounterPath?: string;
    lifecyclePath?: string;
    pathOnlyInThreadStarted?: boolean;
    primaryParentThreadId?: string;
  } = {}
): string => {
  const modulePath = path.join(directory, "managed-fake-app-server.mjs");
  const scriptPath = path.join(directory, "managed-fake-app-server");
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh
exec "${process.execPath}" "${modulePath}" "$@"
`,
    { mode: 0o700 }
  );
  fs.writeFileSync(
    modulePath,
    `
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const outputIndex = process.argv.indexOf("--out");
if (process.argv.includes("generate-json-schema")) {
  const output = process.argv[outputIndex + 1];
  fs.mkdirSync(path.join(output, "v2"), { recursive: true });
  const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value));
  write("ServerNotification.json", { oneOf: ${JSON.stringify(
    protocolNotificationMethods
  )}.map((method) => ({ properties: { method: { enum: [method] } } })) });
  write("ClientRequest.json", { oneOf: ${JSON.stringify(
    protocolRequestMethods
  )}.map((method) => ({ properties: { method: { enum: [method] } } })) });
  const string = { type: "string" };
  const integer = { type: "integer" };
  const array = { type: "array" };
  const stringArray = { type: "array", items: string };
  const semantics = {
    userMessage: { required: ["content"], properties: { content: array, clientId: string } },
    agentMessage: { required: ["text"], properties: { text: string, phase: {} } },
    reasoning: { properties: { summary: stringArray, content: stringArray } },
    commandExecution: { required: ["command", "status"], properties: { command: string, aggregatedOutput: string, exitCode: integer, status: {}, durationMs: integer } },
    mcpToolCall: { required: ["arguments", "server", "status", "tool"], properties: { server: string, tool: string, arguments: {}, result: {}, error: {}, status: {}, durationMs: integer } },
    dynamicToolCall: { required: ["arguments", "status", "tool"], properties: { tool: string, arguments: {}, contentItems: array, success: {}, status: {}, durationMs: integer } },
    collabAgentToolCall: { required: ["agentsStates", "receiverThreadIds", "status", "tool"], properties: { tool: {}, agentsStates: {}, prompt: {}, receiverThreadIds: array, status: {} } }
  };
  const threadItem = {
    oneOf: ${JSON.stringify(protocolItemTypes)}.map((type) => {
      const semantic = semantics[type] ?? { properties: {} };
      return {
        required: ["id", "type", ...(semantic.required ?? [])],
        properties: {
          id: string,
          type: { enum: [type] },
          ...semantic.properties,
          ...(type === "userMessage" ? { clientId: string } : {})
        }
      };
    })
  };
  write("v2/ItemCompletedNotification.json", { required: ["item", "threadId", "turnId", "completedAtMs"], definitions: { ThreadItem: threadItem } });
  write("v2/ItemStartedNotification.json", { required: ["item", "threadId", "turnId", "startedAtMs"], definitions: { ThreadItem: threadItem } });
  write("v2/TurnCompletedNotification.json", { required: ["threadId", "turn"], definitions: { Turn: { required: ["id"] } } });
  write("v2/TurnStartedNotification.json", { required: ["threadId", "turn"], definitions: { Turn: { required: ["id"] } } });
  write("v2/ThreadTokenUsageUpdatedNotification.json", { required: ["threadId", "turnId", "tokenUsage"] });
  write("v2/ThreadStartedNotification.json", { required: ["thread"], definitions: { Thread: { required: ["id", "sessionId", "ephemeral"], properties: { id: string, sessionId: string, parentThreadId: string, ephemeral: {}, path: string } } } });
  write("v2/AgentMessageDeltaNotification.json", { required: ["delta", "itemId", "threadId", "turnId"] });
  write("v2/CommandExecutionOutputDeltaNotification.json", { required: ["delta", "itemId", "threadId", "turnId"] });
  write("v2/FileChangeOutputDeltaNotification.json", { required: ["delta", "itemId", "threadId", "turnId"] });
  write("v2/PlanDeltaNotification.json", { required: ["delta", "itemId", "threadId", "turnId"] });
  write("v2/ReasoningSummaryTextDeltaNotification.json", { required: ["delta", "itemId", "summaryIndex", "threadId", "turnId"] });
  write("v2/ReasoningTextDeltaNotification.json", { required: ["contentIndex", "delta", "itemId", "threadId", "turnId"] });
  write("v2/ThreadStartResponse.json", { required: ["thread"], definitions: { Thread: { required: ["id", "sessionId"] } } });
  write("v2/ThreadResumeResponse.json", { required: ["thread"], definitions: { Thread: { required: ["id", "sessionId"] } } });
  write("v2/ThreadForkResponse.json", { required: ["thread"], definitions: { Thread: { required: ["id", "sessionId"], properties: { id: string, sessionId: string, forkedFromId: { type: ["string", "null"] } } } } });
  write("v2/TurnStartResponse.json", { required: ["turn"], definitions: { Turn: { required: ["id"] } } });
  write("v2/ThreadStartParams.json", { properties: { historyMode: {} } });
  write("v2/ThreadResumeParams.json", { required: ["threadId"] });
  write("v2/ThreadForkParams.json", { required: ["threadId"], properties: { path: {}, deferGoalContinuation: {}, excludeTurns: {} } });
  write("v2/TurnStartParams.json", { required: ["input", "threadId"], properties: { clientUserMessageId: {} } });
  write("v2/TurnInterruptParams.json", { required: ["threadId", "turnId"] });
  process.exit(0);
}

if (!process.argv.includes("app-server") || !process.argv.includes("stdio://")) process.exit(3);
const transcriptPath = ${JSON.stringify(transcriptPath)};
const childTranscriptPath = transcriptPath + ".child.jsonl";
const options = ${JSON.stringify(options)};
const threadId = "managed-thread-1";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const append = (records) => fs.appendFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
const lifecycle = (event) => {
  if (options.lifecyclePath) fs.appendFileSync(options.lifecyclePath, event + "\\n");
};
if (!process.env.CODEX_HOME || process.env.CODEX_HOME === process.env.FAKE_SOURCE_CODEX_HOME) process.exit(5);
if (process.env.${KOED_MANAGED_CONVERSATION_ENV} !== "1") process.exit(10);
if ((fs.statSync(process.env.CODEX_HOME).mode & 0o777) !== 0o700) process.exit(11);
const isolatedConfig = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
if (isolatedConfig.includes("capture_hook")) process.exit(6);
if ((fs.statSync(path.join(process.env.CODEX_HOME, "config.toml")).mode & 0o777) !== 0o600) process.exit(12);
const expectedAuth = JSON.parse(process.env.FAKE_EXPECTED_AUTH ?? "{}");
const copiedAuth = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "auth.json"), "utf8"));
if (JSON.stringify(copiedAuth) !== JSON.stringify(expectedAuth)) process.exit(7);
if ((fs.statSync(path.join(process.env.CODEX_HOME, "auth.json")).mode & 0o777) !== 0o600) process.exit(13);
let launchNumber = 1;
if (options.launchCounterPath) {
  launchNumber = fs.existsSync(options.launchCounterPath)
    ? Number(fs.readFileSync(options.launchCounterPath, "utf8")) + 1
    : 1;
  fs.writeFileSync(options.launchCounterPath, String(launchNumber));
}
process.on("SIGTERM", () => {
  lifecycle("signal");
  process.exit(0);
});

let turnIndex = options.continueTurnIndexAcrossLaunches ? launchNumber - 1 : 0;
let activeTurn = null;
const pendingServerRequests = new Map();
const stableId = (base, index) => index === 0 ? base : base + "-" + (index + 1);
const iso = (milliseconds) => new Date(milliseconds).toISOString();

const completeTurn = (turn, status) => {
  if (!activeTurn || activeTurn.turnId !== turn.turnId) return;
  const persistTerminal = () => append([{ timestamp: iso(turn.base + 1000), type: "event_msg", payload: { type: "task_complete", turn_id: turn.turnId } }]);
  if (options.terminalJsonlDelayMs) setTimeout(persistTerminal, options.terminalJsonlDelayMs);
  else persistTerminal();
  send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.turnId, itemId: turn.messageId, delta: turn.answer } });
  send({ method: "item/completed", params: { threadId, turnId: turn.turnId, completedAtMs: turn.base + 100, item: { id: turn.userItemId, type: "userMessage", clientId: turn.clientUserMessageId, content: [{ type: "text", text: turn.prompt }] } } });
  send({ method: "item/completed", params: { threadId, turnId: turn.turnId, completedAtMs: turn.base + 200, item: { id: turn.reasoningId, type: "reasoning", summary: ["Inspect the source."], content: ["private reasoning"] } } });
  send({ method: "item/completed", params: { threadId, turnId: turn.turnId, completedAtMs: turn.base + 400, item: { id: turn.callId, type: "commandExecution", command: "printf managed", cwd: turn.cwd, commandActions: [], aggregatedOutput: "managed", exitCode: 0, durationMs: 100, status: "completed" } } });
  send({ method: "item/completed", params: { threadId, turnId: turn.turnId, completedAtMs: turn.base + 500, item: { id: turn.messageId, type: "agentMessage", text: turn.answer, phase: "final_answer" } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turn.turnId, status, error: status === "completed" ? null : { message: status }, completedAt: (turn.base + 1000) / 1000, durationMs: 1000 } } });
  lifecycle("terminal:" + status);
  activeTurn = null;
  if (options.exitAfterTurn) {
    setTimeout(() => {
      lifecycle("idle-exit");
      process.exit(0);
    }, 100);
  }
};

const reader = readline.createInterface({ input: process.stdin });
reader.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if ((typeof message.id === "number" || typeof message.id === "string") && !message.method && pendingServerRequests.has(message.id)) {
    const turn = pendingServerRequests.get(message.id);
    pendingServerRequests.delete(message.id);
    if (message.error?.code !== -32601) process.exit(8);
    completeTurn(turn, "completed");
    return;
  }
  if (message.method === "initialize") {
    if (options.hangFirstInitialize && launchNumber === 1) return;
    send({ id: message.id, result: { userAgent: "fake", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    if (message.params.ephemeral !== false || message.params.historyMode !== "legacy" || "persistExtendedHistory" in message.params || "config" in message.params) process.exit(4);
    for (let index = 0; index < (options.preStartEventCount ?? 0); index += 1) {
      send({ method: "item/completed", params: { threadId, turnId: "prestart-turn", completedAtMs: Date.now(), item: { id: "prestart-" + index, type: "agentMessage", text: "prestart" } } });
    }
    if (options.pathOnlyInThreadStarted) {
      send({ method: "thread/started", params: { thread: { id: threadId, sessionId: "session-tree-1", ...(options.primaryParentThreadId ? { parentThreadId: options.primaryParentThreadId } : {}), path: transcriptPath, cwd: message.params.cwd, source: "user", modelProvider: "openai", cliVersion: "fake-1", gitInfo: { branch: "test" } } } });
    }
    send({ id: message.id, result: { thread: { id: threadId, sessionId: "session-tree-1", ...(options.pathOnlyInThreadStarted ? {} : { path: transcriptPath }), cwd: message.params.cwd, source: "user", modelProvider: "openai", cliVersion: "fake-1", gitInfo: { branch: "test" } } } });
    if (typeof options.idleNotificationDelayMs === "number") {
      setTimeout(() => send({ method: "item/completed", params: { threadId, turnId: "idle-turn", completedAtMs: Date.now(), item: { id: "idle-message", type: "agentMessage", text: "Idle durable event", phase: "final_answer" } } }), options.idleNotificationDelayMs);
    }
    return;
  }
  if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId, sessionId: "session-tree-1", path: transcriptPath, cwd: message.params.cwd, source: "user", modelProvider: "openai", cliVersion: "fake-1" } } });
    return;
  }
  if (message.method === "thread/fork") {
    const forkedThreadId = "managed-thread-fork-1";
    if (fs.existsSync(message.params.path)) fs.copyFileSync(message.params.path, childTranscriptPath);
    else fs.writeFileSync(childTranscriptPath, "");
    send({ method: "thread/started", params: { thread: { id: forkedThreadId, sessionId: "session-tree-fork-1", forkedFromId: message.params.threadId, path: childTranscriptPath, cwd: message.params.cwd, source: "user", modelProvider: "openai", cliVersion: "fake-1" } } });
    send({ id: message.id, result: { thread: { id: forkedThreadId, sessionId: "session-tree-fork-1", forkedFromId: message.params.threadId, path: childTranscriptPath, cwd: message.params.cwd, source: "user", modelProvider: "openai", cliVersion: "fake-1" } } });
    return;
  }
  if (message.method === "turn/start") {
    if (activeTurn) process.exit(9);
    const index = turnIndex++;
    const turnId = "managed-turn-" + (index + 1);
    const base = Date.parse("2026-07-11T10:00:00.000Z") + index * 10_000;
    const answer = options.oversizedAnswerBytes
      ? "x".repeat(options.oversizedAnswerBytes)
      : index === 0 ? "Managed answer" : "Managed answer " + (index + 1);
    const turn = {
      turnId,
      base,
      answer,
      prompt: message.params.input[0].text,
      cwd: message.params.cwd,
      clientUserMessageId: message.params.clientUserMessageId,
      userItemId: stableId("user-item-1", index),
      reasoningId: stableId("reasoning-1", index),
      responseCallId: stableId("response-call-1", index),
      callId: stableId("call-1", index),
      messageId: stableId("message-1", index)
    };
    activeTurn = turn;
    lifecycle("turn-accepted");
    if (options.hangTurnStartResponse) return;
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    append([
      { timestamp: iso(base - 1000), type: "session_meta", payload: { id: threadId, cwd: turn.cwd, timestamp: iso(base - 1000) } },
      { timestamp: iso(base), type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: iso(base + 100), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: turn.prompt }] } },
      { timestamp: iso(base + 150), type: "event_msg", payload: { type: "user_message", client_id: turn.clientUserMessageId, message: turn.prompt } },
      { timestamp: iso(base + 200), type: "response_item", payload: { id: turn.reasoningId, type: "reasoning", summary: ["Inspect the source."], content: ["private reasoning"] } },
      { timestamp: iso(base + 300), type: "response_item", payload: { id: turn.responseCallId, type: "function_call", name: "exec_command", call_id: turn.callId, arguments: { cmd: "printf managed" } } },
      { timestamp: iso(base + 400), type: "response_item", payload: { type: "function_call_output", call_id: turn.callId, output: { output: "managed", exitCode: 0 }, status: "completed" } },
      { timestamp: iso(base + 500), type: "response_item", payload: { id: turn.messageId, type: "message", role: "assistant", content: [{ type: "output_text", text: turn.answer }] } }
    ]);
    if (options.retryableError) {
      send({ method: "error", params: { threadId, turnId, error: { message: "temporary upstream failure", willRetry: true } } });
    }
    if (options.nonRetryableErrorBeforeCompletion) {
      send({ method: "error", params: { threadId, turnId, error: { message: "non-terminal diagnostic failure", willRetry: false } } });
    }
    for (let noise = 0; noise < (options.stateNoiseCount ?? 0); noise += 1) {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId: "noise-turn-" + noise, itemId: "noise-" + noise, delta: "noise" } });
    }
    for (let delta = 0; delta < (options.transientDeltaCount ?? 0); delta += 1) {
      send({ method: "item/commandExecution/outputDelta", params: { threadId, turnId, itemId: turn.callId, delta: "stream-noise" } });
    }
    for (let child = 0; child < (options.childNotificationCount ?? 0); child += 1) {
      if (child === 0) {
        fs.writeFileSync(childTranscriptPath, [
          { timestamp: iso(turn.base + 210), type: "session_meta", payload: { id: "child-thread-1", cwd: turn.cwd, parentThreadId: threadId, timestamp: iso(turn.base + 210) } },
          { timestamp: iso(turn.base + 220), type: "event_msg", payload: { type: "task_started", turn_id: "child-turn-1" } },
          { timestamp: iso(turn.base + 250), type: "response_item", payload: { id: "child-message-0", type: "message", role: "assistant", content: [{ type: "output_text", text: "child-only" }] } },
          { timestamp: iso(turn.base + 300), type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn-1" } }
        ].map((record) => JSON.stringify(record)).join("\\n") + "\\n");
        send({ method: "thread/started", params: { thread: { id: "child-thread-1", sessionId: "session-tree-1", parentThreadId: threadId, ephemeral: false, path: childTranscriptPath, cwd: turn.cwd, source: "subagent", modelProvider: "openai", cliVersion: "fake-1" } } });
      }
      send({ method: "item/completed", params: { threadId: "child-thread-1", turnId: "child-turn-1", completedAtMs: turn.base + 250, item: { id: "child-message-" + child, type: "agentMessage", text: "child-only" } } });
    }
    if ((options.childNotificationCount ?? 0) > 0) {
      send({ method: "turn/completed", params: { threadId: "child-thread-1", turn: { id: "child-turn-1", status: "completed", completedAt: (turn.base + 300) / 1000 } } });
    }
    if (options.unsupportedServerRequest) {
      const requestId = "server-request-" + index;
      pendingServerRequests.set(requestId, turn);
      send({ id: requestId, method: "account/login/start", params: { threadId, turnId } });
      return;
    }
    if (options.runUntilInterrupted) return;
    setTimeout(() => completeTurn(turn, "completed"), options.turnDelayMs ?? 0);
    return;
  }
  if (message.method === "turn/interrupt") {
    lifecycle("interrupt");
    if (!options.ignoreInterruptResponse) send({ id: message.id, result: {} });
    if (activeTurn) {
      const interrupted = activeTurn;
      setTimeout(() => completeTurn(interrupted, "interrupted"), options.interruptTerminalDelayMs ?? 0);
    }
  }
});
`,
    { mode: 0o600 }
  );
  return scriptPath;
};

interface FakeSourceArtifact {
  id: string;
  sessionId: string;
  externalSessionId: string;
  sourceFingerprint: string;
  journalStartOffset: number;
  journalStartLine: number;
  liveStartOffset: number;
  liveStartLine: number;
  providerCursorOffset: number;
  providerCursorLine: number;
  currentSourceLength: number;
  sourceModifiedAt: string | null;
}

interface FakeSourceSegment {
  id: string;
  artifactId: string;
  segmentIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  sourceStartLine: number;
  sourceEndLine: number;
  plaintextDigest: string;
  plaintextSize: number;
  bytesBase64: string;
}

interface FakeSourceCursor {
  artifactId: string;
  consumerKind: "canonical_live";
  segmentIndex: number;
  sourceOffset: number;
  sourceLine: number;
  lastVerifiedDigest: string | null;
  parserState: Record<string, unknown>;
}

class FakeMemoryClient {
  readonly operations: Array<Record<string, unknown>> = [];
  readonly canonicalIds = new Map<string, string>();
  readonly observations: Array<Record<string, unknown>> = [];
  readonly observationKeys = new Set<string>();
  readonly sourceArtifacts = new Map<string, FakeSourceArtifact>();
  readonly sourceSegments = new Map<string, FakeSourceSegment[]>();
  readonly sourceCursors = new Map<string, FakeSourceCursor>();
  persistAttempts = 0;
  private persistFailuresRemaining = 0;
  private appServerPersistenceUnavailable = false;
  private delayedPersistsRemaining = 0;
  private persistDelayMs = 0;
  private releaseFailuresRemaining = 0;
  private nextId = 1;

  constructor(private readonly sessionId = "koed-session-1") {}

  failNextPersist(count = 1): void {
    this.persistFailuresRemaining = count;
  }

  setAppServerPersistenceUnavailable(unavailable: boolean): void {
    this.appServerPersistenceUnavailable = unavailable;
  }

  delayNextPersist(delayMs: number, count = 1): void {
    this.persistDelayMs = delayMs;
    this.delayedPersistsRemaining = count;
  }

  failNextRelease(count = 1): void {
    this.releaseFailuresRemaining = count;
  }

  async createSession(input: Record<string, unknown>) {
    this.operations.push({ kind: "create_session", input });
    return {
      session: {
        id:
          input.externalSessionId === "managed-thread-1"
            ? this.sessionId
            : `koed-session:${String(input.externalSessionId)}`
      }
    };
  }

  async ensureConversationSourceArtifact(input: Record<string, unknown>) {
    const externalSessionId = String(input.externalSessionId);
    const existing = this.sourceArtifacts.get(externalSessionId);
    if (existing) {
      existing.currentSourceLength = Math.max(
        existing.currentSourceLength,
        Number(input.currentSourceLength)
      );
      existing.sourceModifiedAt =
        typeof input.sourceModifiedAt === "string"
          ? input.sourceModifiedAt
          : existing.sourceModifiedAt;
      return { artifact: existing };
    }
    const artifact: FakeSourceArtifact = {
      id: `artifact-${this.sourceArtifacts.size + 1}`,
      sessionId:
        externalSessionId === "managed-thread-1"
          ? this.sessionId
          : `koed-session:${externalSessionId}`,
      externalSessionId,
      sourceFingerprint: String(input.sourceFingerprint),
      journalStartOffset: Number(input.journalStartOffset),
      journalStartLine: Number(input.journalStartLine),
      liveStartOffset: Number(input.liveStartOffset),
      liveStartLine: Number(input.liveStartLine),
      providerCursorOffset: Number(input.journalStartOffset),
      providerCursorLine: Number(input.journalStartLine),
      currentSourceLength: Number(input.currentSourceLength),
      sourceModifiedAt:
        typeof input.sourceModifiedAt === "string"
          ? input.sourceModifiedAt
          : null
    };
    this.sourceArtifacts.set(externalSessionId, artifact);
    this.sourceSegments.set(artifact.id, []);
    this.operations.push({ kind: "source_artifact", artifactId: artifact.id });
    return { artifact };
  }

  async lookupConversationSourceArtifact(input: { externalSessionId: string }) {
    const artifact = this.sourceArtifacts.get(input.externalSessionId);
    if (!artifact) {
      throw new MemoryApiError("not found", { status: 404 });
    }
    return { artifact };
  }

  async appendConversationSourceSegment(
    artifactId: string,
    input: Record<string, unknown>
  ) {
    const artifact = [...this.sourceArtifacts.values()].find(
      (candidate) => candidate.id === artifactId
    );
    if (!artifact) throw new Error("missing fake source artifact");
    if (
      artifact.providerCursorOffset !== Number(input.expectedProviderOffset) ||
      artifact.providerCursorLine !== Number(input.expectedProviderLine)
    ) {
      throw new MemoryApiError("cursor conflict", { status: 409 });
    }
    const segments = this.sourceSegments.get(artifactId)!;
    const segment: FakeSourceSegment = {
      id: `segment-${artifactId}-${segments.length + 1}`,
      artifactId,
      segmentIndex: segments.length + 1,
      sourceStartOffset: artifact.providerCursorOffset,
      sourceEndOffset: Number(input.sourceEndOffset),
      sourceStartLine: artifact.providerCursorLine,
      sourceEndLine: Number(input.sourceEndLine),
      plaintextDigest: String(input.plaintextDigest),
      plaintextSize: Number(input.plaintextSize),
      bytesBase64: String(input.bytesBase64)
    };
    segments.push(segment);
    artifact.providerCursorOffset = segment.sourceEndOffset;
    artifact.providerCursorLine = segment.sourceEndLine;
    artifact.currentSourceLength = Number(input.currentSourceLength);
    this.operations.push({ kind: "source_segment", segmentId: segment.id });
    return { artifact, segment };
  }

  async listConversationSourceSegments(
    artifactId: string,
    input: { afterOffset: number; limit?: number }
  ) {
    return {
      segments: this.sourceSegments
        .get(artifactId)!
        .filter((segment) => segment.sourceEndOffset > input.afterOffset)
        .slice(0, input.limit ?? 20)
        .map(({ bytesBase64, ...segment }) => {
          void bytesBase64;
          return segment;
        })
    };
  }

  async getConversationSourceSegmentContent(
    artifactId: string,
    segmentId: string
  ) {
    const segment = this.sourceSegments
      .get(artifactId)!
      .find((candidate) => candidate.id === segmentId);
    if (!segment) throw new Error("missing fake source segment");
    const { bytesBase64, ...safeSegment } = segment;
    return { segment: safeSegment, bytesBase64 };
  }

  async getConversationSourceCursor(artifactId: string) {
    return { cursor: this.sourceCursors.get(artifactId) ?? null };
  }

  async advanceConversationSourceCursor(
    artifactId: string,
    input: Record<string, unknown>
  ) {
    const artifact = [...this.sourceArtifacts.values()].find(
      (candidate) => candidate.id === artifactId
    );
    if (!artifact) throw new Error("missing fake source artifact");
    const existing = this.sourceCursors.get(artifactId);
    const expectedOffset = existing?.sourceOffset ?? artifact.liveStartOffset;
    if (expectedOffset !== Number(input.expectedSourceOffset)) {
      throw new MemoryApiError("cursor conflict", { status: 409 });
    }
    const cursor: FakeSourceCursor = {
      artifactId,
      consumerKind: "canonical_live",
      segmentIndex: Number(input.segmentIndex),
      sourceOffset: Number(input.sourceOffset),
      sourceLine: Number(input.sourceLine),
      lastVerifiedDigest:
        typeof input.lastVerifiedDigest === "string"
          ? input.lastVerifiedDigest
          : null,
      parserState: (input.parserState ?? {}) as Record<string, unknown>
    };
    this.sourceCursors.set(artifactId, cursor);
    this.operations.push({ kind: "source_cursor", cursor });
    return { cursor };
  }

  async createConversationItems(input: {
    items: Array<Record<string, unknown>>;
  }) {
    this.persistAttempts += 1;
    if (this.delayedPersistsRemaining > 0) {
      this.delayedPersistsRemaining -= 1;
      await new Promise((resolve) => setTimeout(resolve, this.persistDelayMs));
    }
    if (this.persistFailuresRemaining > 0) {
      this.persistFailuresRemaining -= 1;
      throw new Error("transient memory API failure");
    }
    if (
      this.appServerPersistenceUnavailable &&
      input.items.some((item) => item.sourceTransport === "app_server")
    ) {
      throw new Error("persistent app-server ingestion failure");
    }
    const items = input.items.flatMap((item) => {
      if (item.observationOnly === true) {
        const observationKey = String(item.idempotencyKey);
        if (!this.observationKeys.has(observationKey)) {
          this.observationKeys.add(observationKey);
          this.observations.push({ ...item });
        }
        return [];
      }
      const key = String(item.canonicalItemKey ?? item.idempotencyKey);
      let id = this.canonicalIds.get(key);
      if (!id) {
        id = `raw-${this.nextId++}`;
        this.canonicalIds.set(key, id);
      }
      const persisted = { ...item, id };
      const observationKey = String(item.idempotencyKey);
      if (!this.observationKeys.has(observationKey)) {
        this.observationKeys.add(observationKey);
        this.observations.push(persisted);
      }
      return [persisted];
    });
    this.operations.push({ kind: "persist", items });
    return { items };
  }

  async projectConversationItems(input: {
    conversationItemIds: string[];
    limit: number;
  }) {
    this.operations.push({ kind: "project", ids: input.conversationItemIds });
    return { projection: {} };
  }

  async releaseConversationProjectionHold(input: {
    sessionId: string;
    externalTurnId: string;
  }) {
    if (this.releaseFailuresRemaining > 0) {
      this.releaseFailuresRemaining -= 1;
      this.operations.push({
        kind: "release_failed",
        sessionId: input.sessionId,
        externalTurnId: input.externalTurnId
      });
      throw new Error("transient projection hold release failure");
    }
    const conversationItemIds = [
      ...new Set(
        this.observations
          .filter(
            (item) =>
              item.sessionId === input.sessionId &&
              item.externalTurnId === input.externalTurnId &&
              typeof item.id === "string"
          )
          .map((item) => String(item.id))
      )
    ];
    this.operations.push({
      kind: "release",
      sessionId: input.sessionId,
      externalTurnId: input.externalTurnId,
      ids: conversationItemIds
    });
    return { conversationItemIds };
  }
}

const configFor = (
  memoryClient: FakeMemoryClient,
  appServerBinary: string,
  directory: string,
  resume?: {
    threadId: string;
    sessionId: string;
    transcriptPath: string;
    codexHome?: string;
  },
  lifecycle: {
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
    transcriptReadMaxBytes?: number;
  } = {}
) => {
  const sourceCodexHome = path.join(directory, "source-codex-home");
  const koedHome = path.join(directory, "koed-home");
  const auth = { OPENAI_API_KEY: "managed-test-key" };
  fs.mkdirSync(sourceCodexHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(sourceCodexHome, "auth.json"),
    JSON.stringify(auth),
    {
      mode: 0o600
    }
  );
  fs.writeFileSync(
    path.join(sourceCodexHome, "config.toml"),
    'notify = ["capture_hook"]\n',
    { mode: 0o600 }
  );
  const appServerEnv = {
    ...process.env,
    CODEX_HOME: sourceCodexHome,
    KOED_HOME: koedHome,
    FAKE_SOURCE_CODEX_HOME: sourceCodexHome,
    FAKE_EXPECTED_AUTH: JSON.stringify(auth)
  };
  const managedResume = resume
    ? {
        ...resume,
        codexHome: resume.codexHome ?? prepareManagedCodexHome(appServerEnv)
      }
    : undefined;
  return {
    memoryClient: memoryClient as unknown as MemoryApiClient,
    appServer: {
      appServerBinary,
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      cwd: directory,
      env: appServerEnv,
      clientName: "koed-managed-test",
      baseInstructions: "Test managed ingestion.",
      developerInstructions: ""
    },
    ...lifecycle,
    ...(managedResume ? { resume: managedResume } : {})
  };
};

describe("Codex managed conversation coordinator", () => {
  it("accepts a rollout path supplied by the buffered thread/started event", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-conversation-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          pathOnlyInThreadStarted: true
        }),
        directory
      )
    );

    try {
      await expect(session.start()).resolves.toMatchObject({
        thread: { id: "managed-thread-1", path: transcriptPath },
        transcriptPath
      });
    } finally {
      session.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains parent identity when thread/started supplies the primary rollout path", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-conversation-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          pathOnlyInThreadStarted: true,
          primaryParentThreadId: "parent-thread-1"
        }),
        directory
      )
    );

    try {
      await expect(session.start()).resolves.toMatchObject({
        thread: {
          id: "managed-thread-1",
          parentThreadId: "parent-thread-1",
          path: transcriptPath
        },
        transcriptPath
      });
      expect(
        memoryClient.operations.find(
          (operation) => operation.kind === "create_session"
        )
      ).toMatchObject({
        input: {
          metadata: {
            parentThreadId: "parent-thread-1",
            parentExternalSessionId: "parent-thread-1"
          }
        }
      });
    } finally {
      session.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists app-server items immediately and reconciles JSONL before sealing", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-conversation-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    expect(fs.existsSync(transcriptPath)).toBe(false);
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath),
        directory
      )
    );
    let managedHome: string | undefined;

    try {
      const result = await session.runTurn("Managed prompt", 5000);
      expect(result).toMatchObject({
        text: "Managed answer",
        threadId: "managed-thread-1",
        turnId: "managed-turn-1"
      });
      expect(
        memoryClient.operations.filter(
          (operation) => operation.kind === "create_session"
        )
      ).toHaveLength(1);
      expect(
        memoryClient.observations.some(
          (item) => item.sourceEventType === "item/agentMessage/delta"
        )
      ).toBe(false);

      const canonicalGroups = new Map<string, Array<Record<string, unknown>>>();
      for (const observation of memoryClient.observations) {
        if (typeof observation.canonicalItemKey !== "string") {
          continue;
        }
        const group = canonicalGroups.get(observation.canonicalItemKey) ?? [];
        group.push(observation);
        canonicalGroups.set(observation.canonicalItemKey, group);
      }
      for (const group of canonicalGroups.values()) {
        expect(new Set(group.map((item) => item.id))).toHaveLength(1);
      }
      const pairedGroups = [...canonicalGroups.values()].filter((group) =>
        ["app_server", "transcript"].every((transport) =>
          group.some((item) => item.sourceTransport === transport)
        )
      );
      expect(
        pairedGroups
          .map((group) => String(group[0]!.observationComponent))
          .sort()
      ).toEqual([
        "control",
        "message",
        "message",
        "reasoning_summary",
        "tool_call",
        "tool_result"
      ]);
      const pairedToolCall = pairedGroups.find(
        (group) => group[0]!.observationComponent === "tool_call"
      );
      expect(
        pairedToolCall?.map((item) => String(item.externalItemId)).sort()
      ).toEqual(["call-1", "response-call-1"]);
      expect(new Set(pairedToolCall?.map((item) => item.id))).toHaveLength(1);
      const controlObservations = memoryClient.observations.filter(
        (item) =>
          item.metadata &&
          typeof item.metadata === "object" &&
          (item.metadata as Record<string, unknown>).semanticControl ===
            "turn_completed"
      );
      expect(
        controlObservations.map((item) => item.sourceTransport).sort()
      ).toEqual(["app_server", "transcript"]);
      expect(new Set(controlObservations.map((item) => item.id))).toHaveLength(
        1
      );

      const transcriptPersistIndex = memoryClient.operations.findIndex(
        (operation) =>
          operation.kind === "persist" &&
          Array.isArray(operation.items) &&
          operation.items.some(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              (item as Record<string, unknown>).sourceEventType ===
                "task_complete"
          )
      );
      const controlId = String(controlObservations[0]!.id);
      const releaseIndex = memoryClient.operations.findIndex(
        (operation) => operation.kind === "release"
      );
      const firstControlProjectionIndex = memoryClient.operations.findIndex(
        (operation) =>
          operation.kind === "project" &&
          Array.isArray(operation.ids) &&
          operation.ids.includes(controlId)
      );
      expect(transcriptPersistIndex).toBeGreaterThan(-1);
      expect(releaseIndex).toBeGreaterThan(transcriptPersistIndex);
      expect(firstControlProjectionIndex).toBeGreaterThan(releaseIndex);
      expect(
        memoryClient.operations.findIndex(
          (operation) => operation.kind === "project"
        )
      ).toBeGreaterThan(transcriptPersistIndex);
      expect(
        memoryClient.observations.some(
          (item) => item.sourceRecordType === "session_meta"
        )
      ).toBe(true);
      const createSession = memoryClient.operations.find(
        (operation) => operation.kind === "create_session"
      );
      const createInput = createSession?.input as
        | Record<string, unknown>
        | undefined;
      const metadata = createInput?.metadata as
        | Record<string, unknown>
        | undefined;
      const initialization = metadata?.appServerInitialize as
        | Record<string, unknown>
        | undefined;
      managedHome = String(initialization?.codexHome);
      expect(path.dirname(managedHome)).toBe(
        path.join(directory, "koed-home", "codex-managed")
      );
      expect(path.basename(managedHome)).toMatch(/^session-/);
      expect(initialization?.codexHome).toBe(managedHome);
      expect(
        fs.readFileSync(path.join(managedHome, "config.toml"), "utf8")
      ).not.toContain("capture_hook");
      expect(
        JSON.parse(fs.readFileSync(path.join(managedHome, "auth.json"), "utf8"))
      ).toEqual({ OPENAI_API_KEY: "managed-test-key" });
    } finally {
      await session.closeAndWait();
      if (managedHome) {
        expect(fs.existsSync(managedHome)).toBe(true);
        expect(
          fs.existsSync(path.join(managedHome, "koed-ingestion-state.json"))
        ).toBe(false);
        const artifact = memoryClient.sourceArtifacts.get("managed-thread-1");
        expect(
          artifact
            ? memoryClient.sourceCursors.get(artifact.id)?.sourceOffset
            : undefined
        ).toBe(fs.statSync(transcriptPath).size);
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("waits for persisted JSONL terminal evidence after app-server completion", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-terminal-lag-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          terminalJsonlDelayMs: 150
        }),
        directory,
        undefined,
        { terminalReconciliationTimeoutMs: 1_000 }
      )
    );

    try {
      await expect(
        session.runTurn("Delayed terminal", 3_000)
      ).resolves.toMatchObject({
        text: "Managed answer",
        turnId: "managed-turn-1"
      });
      const terminalPersist = memoryClient.operations.findIndex(
        (operation) =>
          operation.kind === "persist" &&
          Array.isArray(operation.items) &&
          operation.items.some(
            (item) =>
              (item as Record<string, unknown>).sourceEventType ===
              "task_complete"
          )
      );
      const release = memoryClient.operations.findIndex(
        (operation) => operation.kind === "release"
      );
      expect(terminalPersist).toBeGreaterThan(-1);
      expect(release).toBeGreaterThan(terminalPersist);
    } finally {
      await session.closeAndWait();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent turns on one managed thread", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-concurrency-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          turnDelayMs: 30
        }),
        directory
      )
    );

    try {
      const [first, second] = await Promise.all([
        session.runTurn("First prompt", 2_000),
        session.runTurn("Second prompt", 2_000)
      ]);
      expect([first.turnId, second.turnId]).toEqual([
        "managed-turn-1",
        "managed-turn-2"
      ]);
      expect([first.text, second.text]).toEqual([
        "Managed answer",
        "Managed answer 2"
      ]);
      expect(
        memoryClient.observations.filter(
          (item) => item.sourceEventType === "turn/start"
        )
      ).toHaveLength(2);
    } finally {
      session.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("waits for turn completion after error notices and handles string request ids", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-retryable-error-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          retryableError: true,
          nonRetryableErrorBeforeCompletion: true,
          unsupportedServerRequest: true
        }),
        directory
      )
    );

    try {
      const result = await session.runTurn("Retryable prompt", 2_000);
      expect(result.text).toBe("Managed answer");
      expect(result.rawEvents?.map((event) => event.method)).toEqual(
        expect.arrayContaining([
          "error",
          "account/login/start",
          "turn/completed"
        ])
      );
    } finally {
      session.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries a transient raw-ingestion API failure without losing events", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-api-retry-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath),
        directory
      )
    );

    try {
      await session.start();
      memoryClient.failNextPersist();
      const result = await session.runTurn("Transient API prompt", 2_000);
      expect(result.text).toBe("Managed answer");
      const successfulPersistCalls = memoryClient.operations.filter(
        (operation) => operation.kind === "persist"
      ).length;
      expect(memoryClient.persistAttempts).toBe(successfulPersistCalls + 1);
      expect(
        new Set(
          memoryClient.observations
            .filter((item) => item.rawText === "Managed answer")
            .map((item) => item.sourceTransport)
        )
      ).toEqual(new Set(["app_server", "transcript"]));
    } finally {
      session.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves the active turn while reconciling a rollout in small pages", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-paged-reconciliation-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath),
        directory,
        undefined,
        { transcriptReadMaxBytes: 320 }
      )
    );

    try {
      const result = await session.runTurn("Paged prompt", 2_000);
      expect(result.text).toBe("Managed answer");
      const pagedTurnItems = memoryClient.observations.filter(
        (item) =>
          item.sourceTransport === "transcript" &&
          item.externalTurnId === "managed-turn-1"
      );
      expect(pagedTurnItems.length).toBeGreaterThan(5);
      expect(
        pagedTurnItems.some((item) => item.sourceEventType === "task_complete")
      ).toBe(true);
    } finally {
      await session.closeAndWait();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("waits for terminal interruption before bounded process shutdown", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-interruption-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    const lifecyclePath = path.join(directory, "lifecycle.log");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          runUntilInterrupted: true,
          interruptTerminalDelayMs: 40,
          ignoreInterruptResponse: true,
          lifecyclePath
        }),
        directory,
        undefined,
        {
          requestTimeoutMs: 200,
          interruptRequestTimeoutMs: 100,
          interruptGraceMs: 200,
          closeGraceMs: 200
        }
      )
    );

    try {
      await expect(session.runTurn("Timeout prompt", 15)).rejects.toThrow(
        "timed out after 15ms"
      );
      const lifecycle = fs
        .readFileSync(lifecyclePath, "utf8")
        .trim()
        .split("\n");
      expect(lifecycle).toEqual([
        "turn-accepted",
        "interrupt",
        "terminal:interrupted",
        "signal"
      ]);
      expect(
        memoryClient.observations.some(
          (item) => item.sourceEventType === "task_complete"
        )
      ).toBe(true);
      await expect(session.runTurn("Closed prompt", 100)).rejects.toThrow(
        "closed"
      );
    } finally {
      session.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("closes a failed startup child and can retry startup cleanly", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-start-cleanup-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    const launchCounterPath = path.join(directory, "launch-count");
    const lifecyclePath = path.join(directory, "lifecycle.log");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          hangFirstInitialize: true,
          launchCounterPath,
          lifecyclePath
        }),
        directory,
        undefined,
        { requestTimeoutMs: 300, closeGraceMs: 200 }
      )
    );

    try {
      await expect(session.start()).rejects.toThrow(
        "initialize request timed out"
      );
      expect(fs.readFileSync(launchCounterPath, "utf8")).toBe("1");
      expect(fs.readFileSync(lifecyclePath, "utf8")).toContain("signal");
      expect(managedSessionHomes(directory)).toEqual([]);

      const started = await session.start();
      expect(started.thread.id).toBe("managed-thread-1");
      expect(fs.readFileSync(launchCounterPath, "utf8")).toBe("2");
      expect(
        memoryClient.operations.filter(
          (operation) => operation.kind === "create_session"
        )
      ).toHaveLength(1);
    } finally {
      await session.closeAndWait();
      expect(managedSessionHomes(directory)).toHaveLength(1);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leases a durable managed home exclusively and releases it on close", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-exclusive-lease-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const binary = writeManagedFakeAppServer(directory, transcriptPath);
    const first = new CodexManagedConversationSession(
      configFor(memoryClient, binary, directory)
    );
    let second: CodexManagedConversationSession | undefined;

    try {
      const started = await first.start();
      const leasePath = path.join(
        started.codexHome,
        ".koed-managed-home.lease"
      );
      expect(fs.existsSync(leasePath)).toBe(true);
      second = new CodexManagedConversationSession(
        configFor(memoryClient, binary, directory, {
          threadId: started.thread.id,
          sessionId: started.sessionId,
          transcriptPath: started.transcriptPath,
          codexHome: started.codexHome
        })
      );

      await expect(second.start()).rejects.toThrow(/lease|active/i);
      await first.closeAndWait();
      expect(fs.existsSync(leasePath)).toBe(false);

      const resumed = await second.start();
      expect(resumed.codexHome).toBe(started.codexHome);
      expect(fs.existsSync(leasePath)).toBe(true);
    } finally {
      await second?.closeAndWait().catch(() => undefined);
      await first.closeAndWait().catch(() => undefined);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers a stale managed-home lease and replaces its owner record", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-stale-lease-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient("stale-lease-session");
    const binary = writeManagedFakeAppServer(directory, transcriptPath);
    const config = configFor(memoryClient, binary, directory, {
      threadId: "managed-thread-1",
      sessionId: "stale-lease-session",
      transcriptPath
    });
    const codexHome = config.resume!.codexHome;
    const leasePath = path.join(codexHome, ".koed-managed-home.lease");
    fs.mkdirSync(leasePath, { mode: 0o700 });
    fs.writeFileSync(
      path.join(leasePath, "owner.json"),
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        hostname: os.hostname(),
        processStartId: "stale-process",
        token: "stale-token",
        createdAt: "2020-01-01T00:00:00.000Z"
      }),
      { mode: 0o600 }
    );
    const session = new CodexManagedConversationSession(config);
    const contender = new CodexManagedConversationSession(config);

    try {
      await session.start();
      const owner = JSON.parse(
        fs.readFileSync(path.join(leasePath, "owner.json"), "utf8")
      ) as { pid: number; token: string };
      expect(owner.pid).toBe(process.pid);
      expect(owner.token).not.toBe("stale-token");
      expect(
        fs
          .readdirSync(codexHome)
          .filter((entry) =>
            entry.startsWith(".koed-managed-home.lease.stale-")
          )
      ).toHaveLength(1);
      await expect(contender.start()).rejects.toThrow(/lease|active/i);
    } finally {
      await contender.closeAndWait().catch(() => undefined);
      await session.closeAndWait().catch(() => undefined);
      expect(fs.existsSync(leasePath)).toBe(false);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exports a validated destroy operation that refuses an active home", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-destroy-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const binary = writeManagedFakeAppServer(directory, transcriptPath);
    const config = configFor(memoryClient, binary, directory);
    const session = new CodexManagedConversationSession(config);
    const destroyManagedCodexHome = (
      mcpServerApi as unknown as Record<string, unknown>
    ).destroyManagedCodexHome as
      | ((managedHome: string, env?: NodeJS.ProcessEnv) => void)
      | undefined;

    try {
      expect(destroyManagedCodexHome).toBeTypeOf("function");
      if (!destroyManagedCodexHome) {
        throw new Error("destroyManagedCodexHome is not exported");
      }
      const started = await session.start();
      expect(() =>
        destroyManagedCodexHome(started.codexHome, config.appServer.env)
      ).toThrow(/lease|active/i);

      await session.closeAndWait();
      const retainedTranscript = path.join(
        started.codexHome,
        "sessions",
        "retained-rollout.jsonl"
      );
      fs.mkdirSync(path.dirname(retainedTranscript), { recursive: true });
      fs.writeFileSync(retainedTranscript, "sensitive transcript", {
        mode: 0o600
      });
      expect(fs.existsSync(path.join(started.codexHome, "auth.json"))).toBe(
        true
      );
      expect(
        fs.existsSync(path.join(started.codexHome, "koed-ingestion-state.json"))
      ).toBe(false);

      destroyManagedCodexHome(started.codexHome, config.appServer.env);
      expect(fs.existsSync(started.codexHome)).toBe(false);
      expect(() =>
        destroyManagedCodexHome(directory, config.appServer.env)
      ).toThrow(/outside/i);
    } finally {
      await session.closeAndWait().catch(() => undefined);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds retained raw history and prunes stale turn state", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-bounded-history-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const binary = writeManagedFakeAppServer(directory, transcriptPath, {
      stateNoiseCount: 30
    });
    const config = configFor(memoryClient, binary, directory);
    const managedHome = prepareManagedCodexHome(config.appServer.env);
    const client = new CodexAppServerClient(
      binary,
      directory,
      {
        ...config.appServer.env,
        CODEX_HOME: managedHome,
        [KOED_MANAGED_CONVERSATION_ENV]: "1"
      },
      undefined,
      { maxRawEvents: 6, maxTurnStates: 3 }
    );

    try {
      await client.initialize("koed-managed-history-test");
      const thread = await client.startThread(config.appServer, {
        ephemeral: false,
        historyMode: "legacy",
        threadSource: "user",
        minimalContext: false
      });
      const turnId = await client.startTurn(
        thread.id,
        "History prompt",
        config.appServer,
        "history-user-message"
      );
      const result = await client.waitForTurn(thread.id, turnId);
      expect(result.text).toBe("Managed answer");
      expect(client.getRawEvents()).toHaveLength(6);
      expect(client.getRawEvents()[0]!.sequence).toBeGreaterThan(20);
      expect(client.turnStateCount()).toBeLessThanOrEqual(3);
    } finally {
      await client.closeAndWait(200);
      removeManagedCodexHome(managedHome, config.appServer.env);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("filters transient deltas while retaining child-thread durable sources", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-delta-stress-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          transientDeltaCount: 3_000,
          childNotificationCount: 2
        }),
        directory,
        undefined,
        {
          maxRawEvents: 20,
          maxRawEventBytes: 8_000,
          maxPendingRawEvents: 12,
          maxPendingRawEventBytes: 24_000,
          maxTurnStates: 4,
          maxTurnBytes: 256
        }
      )
    );

    try {
      const result = await session.runTurn("Delta stress prompt", 5_000);
      expect(result.text).toBe("Managed answer");
      expect(result.rawEvents?.length).toBeLessThanOrEqual(20);
      expect(
        memoryClient.observations.some(
          (item) => item.externalThreadId === "child-thread-1"
        )
      ).toBe(true);
      expect(
        memoryClient.operations.some(
          (operation) =>
            operation.kind === "create_session" &&
            (operation.input as Record<string, unknown>)?.externalSessionId ===
              "child-thread-1"
        )
      ).toBe(true);
      expect(
        memoryClient.observations.some((item) =>
          String(item.sourceEventType).toLowerCase().endsWith("delta")
        )
      ).toBe(false);
    } finally {
      await session.closeAndWait();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed instead of evicting an oversized durable lifecycle event", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-durable-overflow-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    const lifecyclePath = path.join(directory, "lifecycle.log");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          oversizedAnswerBytes: 2_048,
          lifecyclePath
        }),
        directory,
        undefined,
        {
          maxPendingRawEvents: 100,
          maxPendingRawEventBytes: 1_000,
          maxTurnBytes: 4_096,
          maxLineBytes: 4_096,
          closeGraceMs: 200
        }
      )
    );

    try {
      await expect(session.runTurn("Overflow prompt", 2_000)).rejects.toThrow(
        "durable event capacity exceeded"
      );
      expect(fs.readFileSync(lifecyclePath, "utf8")).toContain("signal");
      expect(managedSessionHomes(directory)).toHaveLength(1);
      await expect(session.runTurn("Closed prompt", 100)).rejects.toThrow(
        "durable event capacity exceeded"
      );
    } finally {
      await session.closeAndWait().catch(() => undefined);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds pre-start lifecycle buffering and cleans the failed home", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-prestart-overflow-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          preStartEventCount: 4
        }),
        directory,
        undefined,
        { maxPreStartEvents: 2, maxPreStartEventBytes: 10_000 }
      )
    );

    try {
      await expect(session.start()).rejects.toThrow(
        "pre-start event capacity exceeded"
      );
      expect(managedSessionHomes(directory)).toEqual([]);
      expect(
        memoryClient.operations.filter(
          (operation) => operation.kind === "create_session"
        )
      ).toHaveLength(0);
    } finally {
      await session.closeAndWait().catch(() => undefined);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds aggregate turn text and stdout line bytes", async () => {
    for (const testCase of [
      {
        name: "turn-bytes",
        lifecycle: { maxTurnBytes: 128, maxLineBytes: 4_096 },
        expected: "aggregate turn byte capacity exceeded"
      },
      {
        name: "line-bytes",
        lifecycle: { maxTurnBytes: 4_096, maxLineBytes: 512 },
        expected: "stdout line byte capacity exceeded"
      }
    ]) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), `koed-managed-${testCase.name}-`)
      );
      const transcriptPath = path.join(directory, "rollout.jsonl");
      fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
      const memoryClient = new FakeMemoryClient();
      const session = new CodexManagedConversationSession(
        configFor(
          memoryClient,
          writeManagedFakeAppServer(directory, transcriptPath, {
            oversizedAnswerBytes: 2_048
          }),
          directory,
          undefined,
          { ...testCase.lifecycle, closeGraceMs: 200 }
        )
      );
      try {
        await expect(
          session.runTurn("Byte limit prompt", 2_000)
        ).rejects.toThrow(testCase.expected);
        expect(managedSessionHomes(directory)).toHaveLength(1);
      } finally {
        await session.closeAndWait().catch(() => undefined);
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("includes turn/start request time in the caller timeout and stops the accepted turn", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-turn-start-timeout-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    const lifecyclePath = path.join(directory, "lifecycle.log");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          hangTurnStartResponse: true,
          lifecyclePath
        }),
        directory,
        undefined,
        { requestTimeoutMs: 1_000, closeGraceMs: 200 }
      )
    );

    try {
      await session.start();
      await expect(session.runTurn("Unanswered start", 20)).rejects.toThrow(
        "timed out after 20ms"
      );
      expect(fs.readFileSync(lifecyclePath, "utf8").trim().split("\n")).toEqual(
        ["turn-accepted", "signal"]
      );
      expect(managedSessionHomes(directory)).toHaveLength(1);
    } finally {
      await session.closeAndWait().catch(() => undefined);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops an ambiguously accepted turn/start after its request timeout", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-turn-request-timeout-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    const lifecyclePath = path.join(directory, "lifecycle.log");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          hangTurnStartResponse: true,
          lifecyclePath
        }),
        directory,
        undefined,
        { requestTimeoutMs: 200, closeGraceMs: 200 }
      )
    );

    try {
      await session.start();
      await expect(session.runTurn("Request timeout", 1_000)).rejects.toThrow(
        "turn/start request timed out after 200ms"
      );
      expect(fs.readFileSync(lifecyclePath, "utf8").trim().split("\n")).toEqual(
        ["turn-accepted", "signal"]
      );
      expect(managedSessionHomes(directory)).toHaveLength(1);
      await expect(session.runTurn("Closed prompt", 100)).rejects.toThrow(
        "closed"
      );
    } finally {
      await session.closeAndWait().catch(() => undefined);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers from an idle child exit while retaining its isolated session home", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-idle-restart-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    const lifecyclePath = path.join(directory, "lifecycle.log");
    const launchCounterPath = path.join(directory, "launch-count");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          exitAfterTurn: true,
          continueTurnIndexAcrossLaunches: true,
          launchCounterPath,
          lifecyclePath
        }),
        directory,
        undefined,
        { closeGraceMs: 200 }
      )
    );

    try {
      const first = await session.runTurn("First process", 2_000);
      expect(first.text).toBe("Managed answer");
      const createSession = memoryClient.operations.find(
        (operation) => operation.kind === "create_session"
      );
      const createInput = createSession?.input as Record<string, unknown>;
      const metadata = createInput.metadata as Record<string, unknown>;
      const initialization = metadata.appServerInitialize as Record<
        string,
        unknown
      >;
      expect(typeof initialization.codexHome).toBe("string");
      const firstHome = String(initialization.codexHome);
      await waitFor(() =>
        fs.existsSync(lifecyclePath)
          ? fs.readFileSync(lifecyclePath, "utf8").includes("idle-exit")
          : false
      );
      await waitFor(
        () => !(session as unknown as { started: boolean }).started
      );
      expect(fs.existsSync(firstHome)).toBe(true);
      expect(managedSessionHomes(directory)).toEqual([firstHome]);

      const second = await session.runTurn("Second process", 2_000);
      expect(second.text).toBe("Managed answer 2");
      expect(fs.readFileSync(launchCounterPath, "utf8")).toBe("2");
      expect(
        memoryClient.operations.filter(
          (operation) => operation.kind === "create_session"
        )
      ).toHaveLength(2);
    } finally {
      await session.closeAndWait();
      expect(managedSessionHomes(directory)).toHaveLength(1);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("flushes handlers and reconciles terminal JSONL during graceful close", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-graceful-close-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    const lifecyclePath = path.join(directory, "lifecycle.log");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath, {
          idleNotificationDelayMs: 20,
          lifecyclePath
        }),
        directory,
        undefined,
        { closeGraceMs: 200 }
      )
    );

    try {
      await session.start();
      const persistAttempts = memoryClient.persistAttempts;
      memoryClient.delayNextPersist(60);
      fs.appendFileSync(
        transcriptPath,
        [
          {
            timestamp: "2026-07-11T11:59:59.000Z",
            type: "session_meta",
            payload: {
              id: "managed-thread-1",
              cwd: directory,
              timestamp: "2026-07-11T11:59:59.000Z"
            }
          },
          {
            timestamp: "2026-07-11T12:00:00.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "close-turn" }
          },
          {
            timestamp: "2026-07-11T12:00:01.000Z",
            type: "response_item",
            payload: {
              id: "close-message",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Close answer" }]
            }
          },
          {
            timestamp: "2026-07-11T12:00:02.000Z",
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "close-turn" }
          }
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n"
      );
      await waitFor(() => memoryClient.persistAttempts > persistAttempts);
      await session.closeAndWait();

      expect(
        memoryClient.observations.some(
          (item) => item.rawText === "Idle durable event"
        )
      ).toBe(true);
      expect(
        memoryClient.observations.some(
          (item) => item.rawText === "Close answer"
        )
      ).toBe(true);
      expect(
        memoryClient.operations.some(
          (operation) =>
            operation.kind === "release" &&
            operation.externalTurnId === "close-turn"
        )
      ).toBe(true);
      expect(fs.readFileSync(lifecyclePath, "utf8")).toContain("signal");
      expect(managedSessionHomes(directory)).toHaveLength(1);
    } finally {
      await session.closeAndWait().catch(() => undefined);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resumes an existing Koed session and recovers missed completion from JSONL", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-recovery-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(
      transcriptPath,
      [
        {
          timestamp: "2026-07-11T09:59:59.000Z",
          type: "session_meta",
          payload: {
            id: "managed-thread-1",
            cwd: directory,
            timestamp: "2026-07-11T09:59:59.000Z"
          }
        },
        {
          timestamp: "2026-07-11T10:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "recovered-turn" }
        },
        {
          timestamp: "2026-07-11T10:00:01.000Z",
          type: "response_item",
          payload: {
            id: "recovered-message",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Recovered answer" }]
          }
        },
        {
          timestamp: "2026-07-11T10:00:02.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "recovered-turn" }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
      { mode: 0o600 }
    );
    const memoryClient = new FakeMemoryClient("existing-koed-session");
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath),
        directory,
        {
          threadId: "managed-thread-1",
          sessionId: "existing-koed-session",
          transcriptPath
        }
      )
    );

    try {
      const started = await session.start();
      expect(started.sessionId).toBe("existing-koed-session");
      expect(
        memoryClient.operations.filter(
          (operation) => operation.kind === "create_session"
        )
      ).toHaveLength(1);
      expect(
        memoryClient.observations.some(
          (item) => item.rawText === "Recovered answer"
        )
      ).toBe(true);
      expect(
        memoryClient.observations.some(
          (item) =>
            item.metadata &&
            typeof item.metadata === "object" &&
            (item.metadata as Record<string, unknown>).semanticControl ===
              "turn_completed"
        )
      ).toBe(true);
    } finally {
      session.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates an explicit native fork with durable parent lineage", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-fork-")
    );
    const childTranscriptPath = path.join(directory, "fork-rollout.jsonl");
    const memoryClient = new FakeMemoryClient();
    const appServerBinary = writeManagedFakeAppServer(
      directory,
      childTranscriptPath
    );
    const base = configFor(memoryClient, appServerBinary, directory);
    const managedHome = prepareManagedCodexHome(base.appServer.env);
    const sourceTranscriptPath = path.join(
      managedHome,
      "sessions",
      "parent-rollout.jsonl"
    );
    fs.mkdirSync(path.dirname(sourceTranscriptPath), {
      recursive: true,
      mode: 0o700
    });
    fs.writeFileSync(
      sourceTranscriptPath,
      `${JSON.stringify({
        timestamp: "2026-07-11T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "managed-thread-1", cwd: directory }
      })}\n`,
      { mode: 0o600 }
    );
    const session = new CodexManagedConversationSession({
      ...base,
      fork: {
        parentThreadId: "managed-thread-1",
        sourceTranscriptPath,
        codexHome: managedHome
      }
    });

    try {
      await expect(session.start()).resolves.toMatchObject({
        thread: {
          id: "managed-thread-fork-1",
          forkedFromId: "managed-thread-1",
          path: `${childTranscriptPath}.child.jsonl`
        }
      });
      const created = memoryClient.operations.find(
        (operation) => operation.kind === "create_session"
      );
      expect(created).toMatchObject({
        input: {
          externalSessionId: "managed-thread-fork-1",
          metadata: { forked_from_id: "managed-thread-1" }
        }
      });
      const sourceArtifact = memoryClient.sourceArtifacts.get(
        "managed-thread-fork-1"
      );
      expect(sourceArtifact).toMatchObject({
        externalSessionId: "managed-thread-fork-1"
      });
      expect(typeof sourceArtifact?.providerCursorOffset).toBe("number");
    } finally {
      await session.closeAndWait().catch(() => undefined);
      removeManagedCodexHome(managedHome, base.appServer.env);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists a durable transcript checkpoint across coordinator restarts", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-checkpoint-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const appServerBinary = writeManagedFakeAppServer(
      directory,
      transcriptPath
    );
    const first = new CodexManagedConversationSession(
      configFor(memoryClient, appServerBinary, directory)
    );

    try {
      const started = await first.start();
      await first.runTurn("Checkpoint prompt", 2_000);
      await first.closeAndWait();
      const artifact = memoryClient.sourceArtifacts.get(started.thread.id);
      expect(artifact).toBeDefined();
      expect(
        artifact
          ? memoryClient.sourceCursors.get(artifact.id)?.sourceOffset
          : undefined
      ).toBe(fs.statSync(transcriptPath).size);
      const transcriptObservationCount = memoryClient.observations.filter(
        (item) => item.sourceTransport === "transcript"
      ).length;

      const resumed = new CodexManagedConversationSession(
        configFor(memoryClient, appServerBinary, directory, {
          threadId: started.thread.id,
          sessionId: started.sessionId,
          transcriptPath: started.transcriptPath,
          codexHome: started.codexHome
        })
      );
      try {
        const resumedStart = await resumed.start();
        expect(resumedStart.codexHome).toBe(started.codexHome);
        expect(
          memoryClient.observations.filter(
            (item) => item.sourceTransport === "transcript"
          )
        ).toHaveLength(transcriptObservationCount);
      } finally {
        await resumed.closeAndWait();
      }
    } finally {
      await first.closeAndWait().catch(() => undefined);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays terminal JSONL after an interrupted hold release before checkpoint commit", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-terminal-replay-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(
      transcriptPath,
      [
        {
          timestamp: "2026-07-11T12:59:59.000Z",
          type: "session_meta",
          payload: {
            id: "managed-thread-1",
            cwd: directory,
            timestamp: "2026-07-11T12:59:59.000Z"
          }
        },
        {
          timestamp: "2026-07-11T13:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "replay-turn" }
        },
        {
          timestamp: "2026-07-11T13:00:01.000Z",
          type: "response_item",
          payload: {
            id: "replay-message",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Replay answer" }]
          }
        },
        {
          timestamp: "2026-07-11T13:00:02.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "replay-turn" }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
      { mode: 0o600 }
    );
    const memoryClient = new FakeMemoryClient("terminal-replay-session");
    const binary = writeManagedFakeAppServer(directory, transcriptPath);
    const firstConfig = configFor(memoryClient, binary, directory, {
      threadId: "managed-thread-1",
      sessionId: "terminal-replay-session",
      transcriptPath
    });
    const codexHome = firstConfig.resume!.codexHome;
    const first = new CodexManagedConversationSession(firstConfig);
    let resumed: CodexManagedConversationSession | undefined;
    memoryClient.failNextRelease();

    try {
      await expect(first.start()).rejects.toThrow(
        "transient projection hold release failure"
      );
      const checkpointPath = path.join(codexHome, "koed-ingestion-state.json");
      const committedOffset = fs.existsSync(checkpointPath)
        ? (Object.values(
            (
              JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as {
                transcriptOffsets: Record<string, { offset: number }>;
              }
            ).transcriptOffsets
          )[0]?.offset ?? 0)
        : 0;
      expect(committedOffset).toBeLessThan(fs.statSync(transcriptPath).size);

      resumed = new CodexManagedConversationSession(
        configFor(memoryClient, binary, directory, {
          threadId: "managed-thread-1",
          sessionId: "terminal-replay-session",
          transcriptPath,
          codexHome
        })
      );
      await resumed.start();

      expect(
        memoryClient.operations.some(
          (operation) =>
            operation.kind === "release" &&
            operation.externalTurnId === "replay-turn"
        )
      ).toBe(true);
      const terminal = memoryClient.observations.find(
        (item) => item.sourceEventType === "task_complete"
      );
      expect(
        memoryClient.operations.some(
          (operation) =>
            operation.kind === "project" &&
            Array.isArray(operation.ids) &&
            operation.ids.includes(String(terminal?.id))
        )
      ).toBe(true);
    } finally {
      await resumed?.closeAndWait().catch(() => undefined);
      await first.closeAndWait().catch(() => undefined);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays terminal JSONL after persistent app-server ingestion failure and restart", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-ingestion-restart-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const binary = writeManagedFakeAppServer(directory, transcriptPath);
    const first = new CodexManagedConversationSession(
      configFor(memoryClient, binary, directory)
    );
    let resumed: CodexManagedConversationSession | undefined;

    try {
      const started = await first.start();
      memoryClient.setAppServerPersistenceUnavailable(true);

      await expect(
        first.runTurn("Persist through transcript recovery", 2_000)
      ).rejects.toThrow("persistent app-server ingestion failure");

      const terminal = memoryClient.observations.find(
        (item) =>
          item.sourceTransport === "transcript" &&
          item.sourceEventType === "task_complete"
      );
      expect(terminal).toBeDefined();
      expect(
        memoryClient.operations.some(
          (operation) =>
            operation.kind === "release" &&
            operation.externalTurnId === "managed-turn-1"
        )
      ).toBe(false);

      const checkpointPath = path.join(
        started.codexHome,
        "koed-ingestion-state.json"
      );
      const committedOffset = fs.existsSync(checkpointPath)
        ? (Object.values(
            (
              JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as {
                transcriptOffsets: Record<string, { offset: number }>;
              }
            ).transcriptOffsets
          )[0]?.offset ?? 0)
        : 0;
      expect(committedOffset).toBeLessThan(fs.statSync(transcriptPath).size);

      const leasePath = path.join(
        started.codexHome,
        ".koed-managed-home.lease"
      );
      first.close();
      await expect
        .poll(() => fs.existsSync(leasePath), { timeout: 1_000, interval: 10 })
        .toBe(false);
      memoryClient.setAppServerPersistenceUnavailable(false);
      resumed = new CodexManagedConversationSession(
        configFor(memoryClient, binary, directory, {
          threadId: started.thread.id,
          sessionId: started.sessionId,
          transcriptPath: started.transcriptPath,
          codexHome: started.codexHome
        })
      );
      await resumed.start();

      expect(
        memoryClient.operations.some(
          (operation) =>
            operation.kind === "release" &&
            operation.externalTurnId === "managed-turn-1"
        )
      ).toBe(true);
      expect(
        memoryClient.operations.some(
          (operation) =>
            operation.kind === "project" &&
            Array.isArray(operation.ids) &&
            operation.ids.includes(String(terminal?.id))
        )
      ).toBe(true);
    } finally {
      memoryClient.setAppServerPersistenceUnavailable(false);
      await resumed?.closeAndWait().catch(() => undefined);
      first.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not commit a terminal checkpoint while projection remains held", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-held-checkpoint-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "", { mode: 0o600 });
    const memoryClient = new FakeMemoryClient();
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath),
        directory
      )
    );

    try {
      const started = await session.start();
      fs.appendFileSync(
        transcriptPath,
        [
          {
            timestamp: "2026-07-11T13:59:59.000Z",
            type: "session_meta",
            payload: {
              id: "managed-thread-1",
              cwd: directory,
              timestamp: "2026-07-11T13:59:59.000Z"
            }
          },
          {
            timestamp: "2026-07-11T14:00:00.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "held-turn" }
          },
          {
            timestamp: "2026-07-11T14:00:01.000Z",
            type: "response_item",
            payload: {
              id: "held-message",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Held answer" }]
            }
          },
          {
            timestamp: "2026-07-11T14:00:02.000Z",
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "held-turn" }
          }
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n"
      );

      await (
        session as unknown as {
          reconcileAndSealTurn(
            turnId: string,
            releaseProjection: boolean
          ): Promise<void>;
        }
      ).reconcileAndSealTurn("held-turn", false);

      expect(
        memoryClient.observations.some(
          (item) => item.sourceEventType === "task_complete"
        )
      ).toBe(true);
      expect(
        memoryClient.operations.some(
          (operation) =>
            operation.kind === "release" &&
            operation.externalTurnId === "held-turn"
        )
      ).toBe(false);
      const checkpointPath = path.join(
        started.codexHome,
        "koed-ingestion-state.json"
      );
      const committedOffset = fs.existsSync(checkpointPath)
        ? (Object.values(
            (
              JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as {
                transcriptOffsets: Record<string, { offset: number }>;
              }
            ).transcriptOffsets
          )[0]?.offset ?? 0)
        : 0;
      expect(committedOffset).toBeLessThan(fs.statSync(transcriptPath).size);
    } finally {
      await session.closeAndWait().catch(() => undefined);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats a reconciled JSONL turn_aborted record as terminal", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-managed-aborted-recovery-")
    );
    const transcriptPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(
      transcriptPath,
      [
        {
          timestamp: "2026-07-11T10:59:59.000Z",
          type: "session_meta",
          payload: {
            id: "managed-thread-1",
            cwd: directory,
            timestamp: "2026-07-11T10:59:59.000Z"
          }
        },
        {
          timestamp: "2026-07-11T11:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "aborted-turn" }
        },
        {
          timestamp: "2026-07-11T11:00:01.000Z",
          type: "response_item",
          payload: {
            id: "aborted-message",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Partial answer" }]
          }
        },
        {
          timestamp: "2026-07-11T11:00:02.000Z",
          type: "event_msg",
          payload: { type: "turn_aborted", turn_id: "aborted-turn" }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
      { mode: 0o600 }
    );
    const memoryClient = new FakeMemoryClient("existing-aborted-session");
    const session = new CodexManagedConversationSession(
      configFor(
        memoryClient,
        writeManagedFakeAppServer(directory, transcriptPath),
        directory,
        {
          threadId: "managed-thread-1",
          sessionId: "existing-aborted-session",
          transcriptPath
        }
      )
    );

    try {
      await session.start();
      const terminal = memoryClient.observations.find(
        (item) => item.sourceEventType === "turn_aborted"
      );
      expect(terminal?.externalTurnId).toBe("aborted-turn");
      expect(
        (terminal?.metadata as Record<string, unknown>)?.semanticControl
      ).toBe("turn_completed");
      expect(
        memoryClient.operations.some(
          (operation) =>
            operation.kind === "project" &&
            Array.isArray(operation.ids) &&
            operation.ids.includes(String(terminal?.id))
        )
      ).toBe(true);
    } finally {
      await session.closeAndWait();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
