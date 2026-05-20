#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MemoryApiClient,
  type McpServerConfig,
  defaultConfig
} from "./index.js";

interface HookPayload {
  session_id?: string;
  turn_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  prompt?: string;
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

interface CaptureItem {
  actor: "user" | "assistant" | "tool" | "system";
  eventType: string;
  content: string;
  metadata: Record<string, unknown>;
}

interface CaptureState {
  seen: Record<string, true>;
}

type CaptureHookConfig = McpServerConfig & {
  baseUrl?: string;
  captureEnabled?: boolean;
  capturePausedUntil?: string | null;
};

const parseArgs = (args: string[]): { configPath?: string } => {
  const parsed: { configPath?: string } = {};

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--config") {
      parsed.configPath = args[index + 1];
      index += 1;
    }
  }

  return parsed;
};

const expandHome = (filePath: string): string =>
  filePath.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asUnknownArray = (value: unknown): unknown[] | null =>
  Array.isArray(value) ? (value as unknown[]) : null;

const loadConfig = (configPath?: string): CaptureHookConfig => {
  const envConfig = defaultConfig();

  if (!configPath) {
    return envConfig;
  }

  const fileConfig = JSON.parse(
    fs.readFileSync(expandHome(configPath), "utf8")
  ) as Partial<CaptureHookConfig>;

  return {
    apiUrl: fileConfig.apiUrl ?? fileConfig.baseUrl ?? envConfig.apiUrl,
    apiToken: fileConfig.apiToken ?? envConfig.apiToken,
    captureEnabled: fileConfig.captureEnabled,
    capturePausedUntil: fileConfig.capturePausedUntil
  };
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer<ArrayBufferLike>[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const positiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const hookMaxItems = (): number =>
  positiveIntEnv("MEMORY_HOOK_MAX_ITEMS", 10);

const hookTriggersLcmSummary = (): boolean =>
  (process.env.MEMORY_HOOK_TRIGGER_LCM_SUMMARY ?? "true")
    .trim()
    .toLowerCase() !== "false";

const hookLcmSummaryDelayMs = (): number =>
  positiveIntEnv("MEMORY_HOOK_LCM_SUMMARY_DELAY_MS", 10_000);

const hookLcmSummaryLimit = (): number =>
  positiveIntEnv("MEMORY_HOOK_LCM_SUMMARY_LIMIT", 2);

const pausedUntilActive = (value?: string | null): boolean => {
  if (!value) {
    return false;
  }
  if (value === "until-resumed") {
    return true;
  }
  const numericSeconds = Number.parseInt(value, 10);
  const timestamp = Number.isFinite(numericSeconds)
    ? numericSeconds * 1000
    : new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
};

const stringifyContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (isRecord(item) && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  return "";
};

const roleToActor = (role: unknown): CaptureItem["actor"] | null =>
  role === "user" ||
  role === "assistant" ||
  role === "tool" ||
  role === "system"
    ? role
    : null;

const extractTranscriptItem = (
  record: unknown,
  index: number,
  options: { preferEventMessages: boolean }
): CaptureItem | null => {
  if (!record || typeof record !== "object") {
    return null;
  }

  const raw = isRecord(record) ? record : null;
  if (!raw) {
    return null;
  }
  const payload = isRecord(raw.payload) ? raw.payload : undefined;
  const item = payload ?? raw;
  if (
    options.preferEventMessages &&
    raw.type === "response_item" &&
    item.type === "message"
  ) {
    return null;
  }
  const message = isRecord(item.message) ? item.message : undefined;
  const actor =
    roleToActor(item.role) ??
    roleToActor(message?.role) ??
    roleToActor(item.actor) ??
    (item.type === "user_message"
      ? "user"
      : item.type === "assistant_message" || item.type === "agent_message"
        ? "assistant"
        : null);
  if (!actor) {
    return null;
  }

  const content = stringifyContent(
    item.content ??
      item.text ??
      (typeof item.message === "string" ? item.message : undefined) ??
      message?.content ??
      message?.text
  );
  if (!content.trim()) {
    return null;
  }

  return {
    actor,
    eventType: `codex_transcript_${actor}`,
    content,
    metadata: {
      transcriptIndex: index,
      transcriptType: item.type,
      transcriptParentType: raw.type,
      transcriptId: item.id
    }
  };
};

const parseTranscript = (transcriptPath: string): CaptureItem[] => {
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }

  const text = fs.readFileSync(transcriptPath, "utf8");
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const records: unknown[] = [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const parsedArray = asUnknownArray(parsed);
    if (parsedArray) {
      records.push(...parsedArray);
    } else if (
      isRecord(parsed) &&
      asUnknownArray(parsed.items)
    ) {
      records.push(...asUnknownArray(parsed.items)!);
    } else {
      records.push(parsed);
    }
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        continue;
      }
    }
  }

  const preferEventMessages = records.some((record) => {
    if (!record || typeof record !== "object") {
      return false;
    }
    const raw = isRecord(record) ? record : null;
    const payload = raw ? (isRecord(raw.payload) ? raw.payload : undefined) : undefined;
    return (
      raw?.type === "event_msg" &&
      (payload?.type === "user_message" ||
        payload?.type === "agent_message" ||
        payload?.type === "assistant_message")
    );
  });

  return records
    .map((record, index) =>
      extractTranscriptItem(record, index, { preferEventMessages })
    )
    .filter((item): item is CaptureItem => Boolean(item));
};

const fallbackItems = (payload: HookPayload): CaptureItem[] => {
  const metadata = {
    hookEventName: payload.hook_event_name,
    externalSessionId: payload.session_id,
    externalTurnId: payload.turn_id,
    model: payload.model,
    cwd: payload.cwd
  };

  if (payload.prompt) {
    return [
      {
        actor: "user",
        eventType: "codex_user_prompt",
        content: payload.prompt,
        metadata
      }
    ];
  }

  if (payload.last_assistant_message) {
    return [
      {
        actor: "assistant",
        eventType: "codex_assistant_message",
        content: payload.last_assistant_message,
        metadata
      }
    ];
  }

  if (payload.tool_name) {
    return [
      {
        actor: "tool",
        eventType: "codex_tool_result",
        content: stringifyContent({
          toolInput: payload.tool_input,
          toolResponse: payload.tool_response
        }),
        metadata: { ...metadata, toolName: payload.tool_name }
      }
    ];
  }

  return [];
};

const statePath = (): string =>
  path.join(os.homedir(), ".koed", "capture-state.json");

const loadState = (): CaptureState => {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8")) as CaptureState;
  } catch {
    return { seen: {} };
  }
};

const saveState = (state: CaptureState): void => {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    JSON.stringify(
      { seen: Object.fromEntries(Object.entries(state.seen).slice(-5000)) },
      null,
      2
    ),
    {
      mode: 0o600
    }
  );
};

const triggerDetachedLcmSummary = (configPath?: string): void => {
  if (!hookTriggersLcmSummary()) {
    return;
  }

  const cliPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "cli.js"
  );
  const args = [
    cliPath,
    "lcm-summarize",
    ...(configPath ? ["--config", configPath] : []),
    "--limit",
    String(hookLcmSummaryLimit()),
    "--delay-ms",
    String(hookLcmSummaryDelayMs())
  ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
};

const main = async () => {
  const { configPath } = parseArgs(process.argv.slice(2));
  const stdin = await readStdin();
  const payload = JSON.parse(stdin || "{}") as HookPayload;
  const config = loadConfig(configPath);
  if (config.captureEnabled === false) {
    console.error("koed capture hook skipped because capture is paused");
    return;
  }
  if (
    pausedUntilActive(config.capturePausedUntil)
  ) {
    console.error("koed capture hook skipped because local pause is active");
    return;
  }

  const client = new MemoryApiClient(config);
  const workspaceId = payload.cwd ?? "default";
  const policyResponse = (await client.effectiveCapturePolicy({
    projectId: workspaceId,
    threadId: payload.session_id
  })) as {
    policy?: {
      captureState?: string;
      visibility?: string;
      pauseUntil?: string | null;
      source?: string;
    };
  };
  const policy = policyResponse.policy;
  if (policy?.captureState !== "enabled") {
    console.error(
      `koed capture hook skipped by ${policy?.source ?? "default"} policy`
    );
    return;
  }
  const transcriptItems = payload.transcript_path
    ? parseTranscript(payload.transcript_path)
    : [];
  const items =
    transcriptItems.length > 0 ? transcriptItems : fallbackItems(payload);
  const captureItems = items.slice(-hookMaxItems());
  const state = loadState();
  const session =
    payload.session_id || payload.transcript_path
      ? await client.createSession({
          externalSessionId: payload.session_id,
          sourceRuntime: "codex-cli",
          captureMethod: "hook",
          model: payload.model,
          cwd: payload.cwd,
          codexTranscriptPath: payload.transcript_path,
          idempotencyKey: hash({
            externalSessionId: payload.session_id,
            transcriptPath: payload.transcript_path,
            cwd: payload.cwd
          })
        })
      : null;
  if (session?.skipped || (session && !session.session)) {
    console.error("koed capture hook skipped because session policy disabled capture");
    return;
  }

  let captured = 0;
  for (const item of captureItems) {
    const itemHash = hash({
      session: payload.session_id,
      transcriptPath: payload.transcript_path,
      item
    });
    if (state.seen[itemHash]) {
      continue;
    }

    try {
      await client.capturePersonalEvent({
        workspaceId,
        sessionId: session?.session?.id,
        actor: item.actor,
        eventType: item.eventType,
        content: item.content,
        metadata: {
          ...item.metadata,
          hookEventName: payload.hook_event_name,
          externalSessionId: payload.session_id,
          externalTurnId: payload.turn_id,
          sourceHash: itemHash,
          automaticCaptureScope: "personal"
        },
        sourceRuntime: "codex-cli",
        captureMethod: "hook",
        codexTranscriptPath: payload.transcript_path,
        idempotencyKey: itemHash,
        sourceHash: itemHash
      });
      state.seen[itemHash] = true;
      captured += 1;
    } catch (error) {
      console.error(
        `koed capture hook stopped after ${captured} event(s): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      break;
    }
  }

  saveState(state);
  if (captured > 0) {
    triggerDetachedLcmSummary(configPath);
  }
  console.error(
    `koed capture hook stored ${captured} personal event(s)`
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(process.env.MEMORY_HOOK_STRICT === "true" ? 1 : 0);
});
