/* global AbortController, AbortSignal */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { Type } from "typebox";
import { resolveInstalledKoedHome } from "../koed-home.mjs";
import {
  callLocalRuntimeTool,
  createRuntimeTaskPort
} from "../runtime-client.mjs";
import { createPiMemoryDelivery } from "../pi-memory-delivery.mjs";

const koedHome = resolveInstalledKoedHome(process.env, import.meta.url);
const signalDirectory = join(koedHome, "run", "pi-transcript-signals");
const wakePath = join(koedHome, "run", "pi-transcript-watcher.wake");

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

export const callTool = async (name, input, ctx, signal, invocationKey) => {
  return callLocalRuntimeTool({
    koedHome,
    name,
    input,
    context: ctx,
    signal,
    invocationKey
  });
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
  const delivery = createPiMemoryDelivery(pi, {
    port: createRuntimeTaskPort(koedHome),
    mode:
      process.env.KOED_PI_MEMORY_ANSWER_MODE === "blocking"
        ? "blocking"
        : "auto",
    blocking: (input, ctx, signal, invocation) =>
      callTool("memory_answer", input, ctx, signal, invocation)
  });
  const register = (name, label, description, parameters) =>
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      async execute(id, params, signal, _update, ctx) {
        const combined = AbortSignal.any(
          [signal, sessionController?.signal].filter(Boolean)
        );
        try {
          if (name === "memory_answer")
            return await delivery.execute(id, params, combined, ctx);
          const result = await callTool(
            name,
            params,
            ctx,
            combined,
            `${ctx.sessionManager.getSessionId()}:${id}`
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result
          };
        } catch {
          throw new Error(
            "Koed unavailable; check the Local AI Runtime and retry"
          );
        }
      }
    });
  register(
    "memory_answer",
    "Memory Answer",
    "Recall Koed memory evidence for answer synthesis. Personal recall in persistent Pi returns a receipt promptly and the result arrives automatically. Continue useful independent work; wait for the result before a memory-dependent decision. Do not poll for status. Other routes return the result directly.",
    answerParameters
  );
  register(
    "memory_intake_propose",
    "Memory Intake Propose",
    "Propose curated Personal Memory backed by evidence.",
    intakeParameters
  );
  pi.on("session_start", (event, ctx) => {
    sessionController?.abort();
    sessionController = new AbortController();
    delivery.start(event, ctx);
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
    delivery.detach(true);
    sessionController?.abort();
    sessionController = new AbortController();
    delivery.start({ reason: "fork" }, ctx);
    try {
      signalWatcher(ctx, "session_tree");
    } catch {
      /* correctness comes from filesystem discovery */
    }
  });
  pi.on("session_shutdown", (event, ctx) => {
    try {
      signalWatcher(ctx, "session_shutdown");
    } catch {
      /* correctness comes from filesystem discovery */
    }
    delivery.detach(["new", "resume", "fork"].includes(event.reason));
    sessionController?.abort();
    sessionController = undefined;
  });
}
