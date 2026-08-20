/* global AbortController, AbortSignal, fetch */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { Type } from "typebox";
import { resolveInstalledKoedHome } from "../koed-home.mjs";

const koedHome = resolveInstalledKoedHome(process.env, import.meta.url);
const registrationPath = join(koedHome, "run", "local-ai-runtime.json");
const signalDirectory = join(koedHome, "run", "pi-transcript-signals");
const wakePath = join(koedHome, "run", "pi-transcript-watcher.wake");

const readRegistration = () => {
  const value = JSON.parse(readFileSync(registrationPath, "utf8"));
  if (typeof value.url !== "string" || typeof value.authorization !== "string")
    throw new Error("Koed Local AI Runtime registration is invalid");
  return value;
};

const writePrivate = (target, content) => {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, target);
};

const signalWatcher = (ctx, eventName) => {
  const transcriptPath = ctx.sessionManager.getSessionFile();
  const sourceSessionId = ctx.sessionManager.getSessionId();
  if (!transcriptPath) {
    if (eventName === "session_start")
      ctx.ui.notify(
        "Koed capture unavailable for ephemeral --no-session Pi session",
        "warning"
      );
    return;
  }
  const identity = createHash("sha256")
    .update(`${sourceSessionId}\0${resolve(transcriptPath)}`)
    .digest("hex");
  writePrivate(
    join(signalDirectory, `${identity}.json`),
    `${JSON.stringify({ sourceSessionId, transcriptPath: resolve(transcriptPath), cwd: ctx.cwd, eventName, observedAt: new Date().toISOString() })}\n`
  );
  writePrivate(wakePath, `${Date.now()}\n`);
};

const callTool = async (name, input, ctx, signal) => {
  const registration = readRegistration();
  const response = await fetch(new URL(`/v1/tools/${name}`, registration.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: registration.authorization
    },
    body: JSON.stringify({
      input,
      caller: {
        cwd: ctx.cwd,
        clientInfo: { name: "pi", version: "koed-extension-v1" }
      }
    }),
    signal
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `Koed Local AI Runtime returned HTTP ${response.status}`
    );
  return body;
};

const answerParameters = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 32000 }),
    retrieval_hints: Type.Optional(
      Type.Object(
        {
          lexical: Type.Optional(Type.Array(Type.String())),
          exact: Type.Optional(Type.Array(Type.String())),
          semantic: Type.Optional(Type.Array(Type.String())),
          entities: Type.Optional(Type.Array(Type.String())),
          temporal_intent: Type.Optional(Type.String())
        },
        { additionalProperties: false }
      )
    ),
    response_detail: Type.Optional(
      Type.Union([
        Type.Literal("answer_only"),
        Type.Literal("with_citations"),
        Type.Literal("with_evidence")
      ])
    ),
    search_domain: Type.Optional(
      Type.Union([
        Type.Literal("global"),
        Type.Literal("project"),
        Type.Literal("session")
      ])
    ),
    project_id: Type.Optional(Type.String()),
    session_id: Type.Optional(Type.String()),
    team_workspace_id: Type.Optional(Type.String()),
    recent_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 36500 })),
    source_after: Type.Optional(Type.String()),
    source_before: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    include_evidence: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
);

const intakeParameters = Type.Object(
  {
    proposed_claim: Type.String({ minLength: 1, maxLength: 4000 }),
    proposed_topic: Type.Optional(
      Type.String({ minLength: 1, maxLength: 500 })
    ),
    rationale: Type.Optional(Type.String({ maxLength: 4000 })),
    tags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 20 })
    ),
    sensitivity_hint: Type.Optional(
      Type.Union([
        Type.Literal("normal"),
        Type.Literal("sensitive"),
        Type.Literal("review_required")
      ])
    ),
    expires_at: Type.Optional(Type.String()),
    evidence_conversation_item_ids: Type.Optional(Type.Array(Type.String())),
    evidence_memory_event_ids: Type.Optional(Type.Array(Type.String())),
    evidence_exact_quote: Type.Optional(
      Type.String({ minLength: 1, maxLength: 16000 })
    ),
    operation: Type.Optional(
      Type.Union([
        Type.Literal("store"),
        Type.Literal("merge"),
        Type.Literal("supersede"),
        Type.Literal("conflict")
      ])
    ),
    target_assertion_id: Type.Optional(Type.String()),
    source_project_id: Type.Optional(Type.String()),
    source_session_id: Type.Optional(Type.String())
  },
  { additionalProperties: false }
);

export default function koedExtension(pi) {
  let sessionController;
  const register = (name, label, description, parameters) =>
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      async execute(_id, params, signal, _update, ctx) {
        const combined = AbortSignal.any(
          [signal, sessionController?.signal].filter(Boolean)
        );
        try {
          const result = await callTool(name, params, ctx, combined);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result
          };
        } catch (error) {
          throw new Error(
            `Koed unavailable: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
      }
    });
  register(
    "memory_answer",
    "Memory Answer",
    "Recall Koed memory evidence for answer synthesis.",
    answerParameters
  );
  register(
    "memory_intake_propose",
    "Memory Intake Propose",
    "Propose curated Personal Memory backed by evidence.",
    intakeParameters
  );
  pi.on("session_start", (_event, ctx) => {
    sessionController?.abort();
    sessionController = new AbortController();
    try {
      signalWatcher(ctx, "session_start");
    } catch {
      /* correctness comes from filesystem discovery */
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    try {
      signalWatcher(ctx, "agent_settled");
    } catch {
      /* correctness comes from filesystem discovery */
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    try {
      signalWatcher(ctx, "session_tree");
    } catch {
      /* correctness comes from filesystem discovery */
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      signalWatcher(ctx, "session_shutdown");
    } catch {
      /* correctness comes from filesystem discovery */
    }
    sessionController?.abort();
    sessionController = undefined;
  });
}
