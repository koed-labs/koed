/**
 * The Koed phone API: what the paired phone app may read and do through the
 * Desktop phone gateway. Version 1.
 *
 * The phone never reaches the local Koed API. Every route here is served by
 * the gateway in the Desktop main process, which calls the same owner-bound
 * Desktop handlers the renderer uses. Request bodies are validated here;
 * responses are shaped for the phone and carry no credentials, paths outside
 * a conversation, or Team data.
 */
import { z } from "zod";

export const PHONE_API_VERSION = 1;
export const PHONE_API_PREFIX = "/koed-phone/v1";

const id = z.string().trim().min(1).max(512);
const uuid = z.uuid();
const text = z
  .string()
  .max(256_000)
  .refine((value) => value.trim().length > 0, "Text is empty");

/* ---------- requests ---------- */

export const phonePairRequestSchema = z
  .object({
    /** The 256-bit secret from the QR code, or the 6-digit code typed by hand. */
    secret: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/u)
      .optional(),
    code: z
      .string()
      .regex(/^\d{6}$/u)
      .optional(),
    deviceName: z.string().trim().min(1).max(80),
    platform: z.enum(["ios", "android", "web", "other"])
  })
  .strict()
  .refine(
    (value) => Boolean(value.secret) !== Boolean(value.code),
    "Send either the QR secret or the typed code"
  );

export const phoneMessageRequestSchema = z
  .object({
    text,
    /** Idempotency: the same id is never sent twice to the AI Client. */
    clientMessageId: uuid,
    voice: z.boolean().optional()
  })
  .strict();

export const phoneRespondRequestSchema = z
  .object({
    executionId: id,
    itemId: id,
    executionGeneration: z.number().int().nonnegative(),
    itemKind: z.enum([
      "command_approval",
      "file_approval",
      "permissions_approval",
      "user_input"
    ]),
    decision: z
      .enum(["accept", "acceptForSession", "decline", "cancel"])
      .optional(),
    answers: z
      .record(z.string().max(256), z.array(z.string().max(4_096)).max(16))
      .optional()
  })
  .strict()
  .refine(
    (value) =>
      value.itemKind === "user_input"
        ? Boolean(value.answers) && !value.decision
        : Boolean(value.decision) && !value.answers,
    "Approvals take a decision; questions take answers"
  );

export const phoneControlRequestSchema = z
  .object({ action: z.enum(["interrupt", "stop"]) })
  .strict();

export const phoneJobRunActionSchema = z.enum(["skip", "retry"]);

export const phoneJobPauseRequestSchema = z
  .object({ paused: z.boolean() })
  .strict();

export const phoneAskRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(32_000),
    askThreadId: uuid.optional(),
    clientRequestId: uuid
  })
  .strict();

export const phonePushRequestSchema = z
  .object({
    /** An Expo push token, or null to stop push notifications to this phone. */
    expoPushToken: z
      .string()
      .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$/u)
      .nullable()
  })
  .strict();

export type PhonePairRequest = z.infer<typeof phonePairRequestSchema>;
export type PhoneMessageRequest = z.infer<typeof phoneMessageRequestSchema>;
export type PhoneRespondRequest = z.infer<typeof phoneRespondRequestSchema>;
export type PhoneAskRequest = z.infer<typeof phoneAskRequestSchema>;

/* ---------- responses ---------- */

export type PhoneAgent = {
  id: string;
  name: string;
  role: string | null;
  /** The Agent's Pixelkin look (Pixelkin Lab subset); the phone draws it. */
  look: Record<string, unknown>;
  aiClientInstanceId: string;
  aiClientName: string | null;
  defaultModel: string | null;
  isChiefOfStaff: boolean;
};

export type PhoneQuestion = {
  id: string;
  header: string | null;
  question: string | null;
  options: Array<{ label: string; description: string | null }>;
  isOther: boolean;
  isSecret: boolean;
};

/** Something only the person can decide: a pending AI Client approval or question, or a missed job run. */
export type PhoneNeed =
  | {
      kind: "approval" | "question";
      id: string;
      executionId: string;
      itemId: string;
      executionGeneration: number;
      itemKind:
        | "command_approval"
        | "file_approval"
        | "permissions_approval"
        | "user_input";
      title: string;
      command: string | null;
      cwd: string | null;
      reason: string | null;
      questions: PhoneQuestion[];
      supportsSessionApproval: boolean;
      /** Risky actions need Face ID on the phone and are never in "Allow all safe". */
      risky: boolean;
      conversation: PhoneConversationRef | null;
      at: string;
    }
  | {
      kind: "missed";
      id: string;
      jobId: string;
      runId: string;
      jobTitle: string;
      agentId: string;
      scheduledFor: string;
      at: string;
    };

export type PhoneConversationRef = {
  projectId: string;
  threadId: string;
  sessionId: string | null;
  title: string;
};

export type PhoneWorking = {
  executionId: string;
  state: string;
  /** A turn is in progress (the AI Client is working), not just an open session. */
  busy: boolean;
  conversation: PhoneConversationRef | null;
  updatedAt: string | null;
};

export type PhoneUpcoming = {
  jobId: string;
  title: string;
  agentId: string;
  at: string;
};

export type PhoneComputer = {
  name: string;
  online: true;
  aiClients: Array<{
    instanceId: string;
    name: string;
    driverId: string;
    ready: boolean;
    models: string[];
    usage: Array<{
      window: string;
      usedPercent: number | null;
      status: "ok" | "near_limit" | "limited" | "unknown";
      resetsAt: string | null;
    }>;
  }>;
};

export type PhoneHome = {
  mac: { name: string };
  chief: PhoneAgent | null;
  agents: PhoneAgent[];
  chiefConversation: PhoneConversationRef | null;
  working: PhoneWorking[];
  upcoming: PhoneUpcoming[];
  needs: PhoneNeed[];
  /** False when the execution list was cut at the API page limit. */
  complete: boolean;
};

export type PhoneEvent = {
  id: string;
  /** "user" for what the person said, "assistant" for the AI Client's words, "tool" for steps. */
  role: "user" | "assistant" | "tool" | "other";
  text: string;
  at: string;
  providerTurnId: string | null;
  toolName: string | null;
};

export type PhoneTimeline = {
  conversation: PhoneConversationRef | null;
  execution: { executionId: string; state: string; busy: boolean } | null;
  events: PhoneEvent[];
  /** Live text of the turn in progress, before capture has stored it. */
  streaming: string | null;
};

export type PhoneRun = {
  executionId: string;
  state: string;
  busy: boolean;
  executionGeneration: number;
  conversation: PhoneConversationRef | null;
  steps: Array<{
    id: string;
    kind: string;
    title: string;
    detail: string | null;
    at: string;
  }>;
  needs: PhoneNeed[];
  updatedAt: string | null;
};

export type PhoneJob = {
  id: string;
  title: string;
  instruction: string;
  agentId: string;
  schedule:
    | { kind: "daily" | "weekdays"; at: string; tz: string }
    | { kind: "weekly"; at: string; tz: string; dow: number[] }
    | { kind: "monthly"; at: string; tz: string; dom: number };
  paused: boolean;
  pausedReason: string | null;
  version: number;
  nextRunAt: string | null;
  conversationSessionId: string;
};

export type PhoneJobRun = {
  id: string;
  jobId: string;
  scheduledFor: string;
  trigger: "scheduled" | "manual";
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  skipReason: string | null;
};

export type PhoneAskTurn = {
  id: string;
  askThreadId: string;
  query: string;
  answerMarkdown: string | null;
  status: "pending" | "answered" | "error";
  errorMessage: string | null;
  createdAt: string;
};

export type PhoneLiveEvent =
  | { type: "changed"; keys: string[] }
  | {
      type: "notification";
      notification: {
        id: string;
        kind: "approval" | "question" | "missed" | "result";
        title: string;
        body: string;
        route: string;
      };
    };
