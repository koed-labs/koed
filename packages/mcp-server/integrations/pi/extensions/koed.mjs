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
import {
  isMemoryAnswerTaskId,
  validateMemoryAnswerTask,
  pendingMemoryAnswerTask,
  presentMemoryAnswerTask,
  collectMemoryAnswerTask
} from "../memory-answer-task-presentation.mjs";
import { formatMemoryAnswerCompletion } from "../memory-answer-presentation.mjs";
import { MEMORY_ANSWER_DELIVERY_MODES } from "../memory-answer-delivery-policy.mjs";

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
    delivery_mode: Type.Optional(
      Type.Union(
        MEMORY_ANSWER_DELIVERY_MODES.map((value) => Type.Literal(value)),
        {
          description:
            "Use non-blocking by default. Set delivery_mode=non_blocking for those memory_answer calls. Blocking is an option only when you absolutely cannot start any work until you have checked for relevant memory."
        }
      )
    ),
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
    team_backend_id: Type.Optional(
      Type.String({ minLength: 1, maxLength: 160 })
    ),
    recent_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 36500 })),
    source_after: Type.Optional(Type.String()),
    source_before: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    include_evidence: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
);

const workspaceParameters = Type.Object(
  {
    team_backend_id: Type.Optional(
      Type.String({ minLength: 1, maxLength: 160 })
    )
  },
  { additionalProperties: false }
);

const taskIdPattern =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const taskParameters = Type.Object(
  { task_id: Type.String({ pattern: taskIdPattern.source }) },
  { additionalProperties: false }
);
const resultParameters = Type.Object(
  {
    task_id: Type.String({ pattern: taskIdPattern.source }),
    wait: Type.Optional(Type.Boolean())
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
  const port = createRuntimeTaskPort(koedHome);
  const register = (name, label, description, parameters) =>
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      async execute(id, params, signal, _update, ctx) {
        if (
          name === "memory_answer_result" &&
          params.wait !== undefined &&
          typeof params.wait !== "boolean"
        )
          throw new Error("wait must be a boolean");
        const combined = AbortSignal.any(
          [signal, sessionController?.signal].filter(Boolean)
        );
        try {
          const invocation = `${ctx.sessionManager.getSessionId()}:${id}`;
          let result;
          if (
            name === "memory_answer" &&
            params.delivery_mode === "non_blocking"
          ) {
            const input = { ...params };
            delete input.delivery_mode;
            const task = await port.start(
              input,
              {
                cwd: ctx.cwd,
                clientInfo: { name: "pi", version: "koed-extension-v1" }
              },
              invocation,
              combined
            );
            validateMemoryAnswerTask(task);
            result = pendingMemoryAnswerTask(task);
          } else if (
            name === "memory_answer_result" ||
            name === "memory_answer_cancel"
          ) {
            if (!isMemoryAnswerTaskId(params.task_id))
              throw new Error("Koed Memory Answer task identity is invalid");
            let task =
              name === "memory_answer_result"
                ? await collectMemoryAnswerTask(
                    port,
                    params.task_id.toLowerCase(),
                    {
                      signal: combined,
                      wait: params.wait ?? false
                    }
                  )
                : await port.get(params.task_id.toLowerCase(), combined);
            validateMemoryAnswerTask(task, params.task_id);
            if (name === "memory_answer_cancel") {
              task = await port.cancel(params.task_id.toLowerCase(), combined);
              validateMemoryAnswerTask(task, params.task_id);
              result = {
                status:
                  task.status === "cancel_requested"
                    ? "cancel_requested"
                    : ["accepted", "running"].includes(task.status)
                      ? "pending"
                      : ["completed", "cancelled"].includes(task.status)
                        ? task.status
                        : "failed",
                task_id: task.id,
                expires_at: task.expiresAt
              };
            } else result = presentMemoryAnswerTask(task);
          } else {
            const input = { ...params };
            delete input.delivery_mode;
            result = await callTool(name, input, ctx, combined, invocation);
          }
          return {
            content: [
              {
                type: "text",
                text:
                  name === "memory_answer" &&
                  params.delivery_mode !== "non_blocking"
                    ? formatMemoryAnswerCompletion(result, "completed", {
                        includeDetails:
                          params.include_evidence === true ||
                          params.response_detail === "with_citations" ||
                          params.response_detail === "with_evidence"
                      })
                    : typeof result.text === "string"
                      ? result.text
                      : JSON.stringify(result)
              }
            ],
            details: result
          };
        } catch (error) {
          if (error?.code === "runtime_feature_unavailable") {
            throw new Error(
              "The running Koed Local AI Runtime does not support this Team recall feature. Restart the runtime through koed-server or Koed Desktop and retry.",
              { cause: error }
            );
          }
          const nonBlocking =
            name === "memory_answer" && params.delivery_mode === "non_blocking";
          const status = error?.statusCode;
          // The runtime rejected the submission before creating a task, so a
          // later retry is safe. Timeouts, transport and 5xx stay ambiguous.
          if (
            nonBlocking &&
            Number.isInteger(status) &&
            status >= 400 &&
            status < 500 &&
            status !== 408
          ) {
            throw Object.assign(
              new Error(
                status === 429
                  ? `Koed Memory Answer queue is full; no task was created. Retry the submission${
                      error.retryAfterMs !== undefined
                        ? ` after ${error.retryAfterMs} ms`
                        : " later"
                    }.`
                  : `Koed rejected the Memory Answer submission (HTTP ${status}); no task was created.`
              ),
              {
                statusCode: status,
                ...(error.retryAfterMs !== undefined
                  ? { retryAfterMs: error.retryAfterMs }
                  : {})
              }
            );
          }
          // Runtime exception causes may contain private provider details.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(
            nonBlocking
              ? "Koed Memory Answer submission could not be confirmed. Acceptance may be uncertain; do not resubmit this request."
              : "Koed unavailable; check the Local AI Runtime and retry"
          );
        }
      }
    });
  register(
    "memory_answer",
    "Memory Answer",
    "Use non-blocking by default. Set delivery_mode=non_blocking for those memory_answer calls. Blocking is an option only when you absolutely cannot start any work until you have checked for relevant memory. Recall Koed memory evidence for answer synthesis. Keep task_id; continue independent work, then collect with memory_answer_result(wait=true) when needed. No automatic follow-up is delivered. Do not repeat a pending question, poll rapidly, invent prior constraints or claim dependent work is complete before collection. Cancel unnecessary recall with memory_answer_cancel. Personal Memory is the default; global without team_workspace_id searches Personal Memory only. For Team, use memory_workspaces, then pass team_workspace_id and team_backend_id. The open Desktop Workspace does not select scope.",
    answerParameters
  );
  register(
    "memory_answer_result",
    "Collect Memory Answer",
    "Collect an accepted Memory Answer by task_id. Omitted or false wait returns promptly with pending or final answer text, including citations or evidence requested at submission; compact is the default. When independent work is finished and recalled memory is needed, set wait=true to wait for this task within the call, subject to task expiry, cancellation, client timeout, or disconnection. Waiting does not start another recall. Do not repeat recall or use a tight polling loop.",
    resultParameters
  );
  register(
    "memory_answer_cancel",
    "Cancel Memory Answer",
    "Cancel an accepted Memory Answer by task_id when it is no longer needed. Returns promptly; cancellation may still be in progress.",
    taskParameters
  );
  register(
    "memory_workspaces",
    "Discover Team Workspaces",
    "Discover authorized Team Workspaces from existing Desktop or headless Koed enrollment. Select the relevant Workspace and pass its team_workspace_id and team_backend_id to memory_answer with search_domain=global to search all shared memory in that Workspace. Query multiple relevant Workspaces separately. Unavailable backends do not mean Team Memory is empty. Returns IDs and names, never credentials.",
    workspaceParameters
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
    sessionController?.abort();
    sessionController = new AbortController();
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
