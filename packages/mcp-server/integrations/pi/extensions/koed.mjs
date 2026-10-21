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
import {
  formatMemoryAnswerCompletion,
  withCitationAliases
} from "../memory-answer-presentation.mjs";
import { MEMORY_ANSWER_DELIVERY_MODES } from "../memory-answer-delivery-policy.mjs";
import { workItemCompletionRequest } from "../work-item-completion-request.mjs";
import { memoryActionRequest } from "../memory-action-request.mjs";

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
          if (
            name === "memory_answer" &&
            params.delivery_mode !== "non_blocking"
          )
            result = withCitationAliases(result);
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
    "Use non-blocking by default. Set delivery_mode=non_blocking for those memory_answer calls. Blocking is an option only when you absolutely cannot start any work until you have checked for relevant memory. Recall Koed memory evidence for answer synthesis. Keep task_id; continue independent work, then collect with memory_answer_result(wait=true) when needed. No automatic follow-up is delivered. Do not repeat a pending question, poll rapidly, invent prior constraints or claim dependent work is complete before collection. Cancel unnecessary recall with memory_answer_cancel. Personal Memory is the default; global without team_workspace_id searches Personal Memory only. For Team, use memory_workspaces, then pass team_workspace_id and team_backend_id. The open Desktop Workspace does not select scope." +
      (process.env.KOED_MANAGED_CONVERSATION === "1"
        ? " In this Desktop managed conversation, request response_detail=with_citations. Preserve each returned alias exactly and place [m:alias] after the claim it supports. Never invent or reuse an alias from another turn."
        : ""),
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
  if (process.env.KOED_MANAGED_MEMORY_ACTIONS === "1") {
    const referenceParameters = {
      citation_alias: Type.Optional(
        Type.String({ pattern: "^r[0-9a-f]{32}c[1-9][0-9]*$", maxLength: 128 })
      ),
      reference: Type.Optional(Type.String({ minLength: 1, maxLength: 500 }))
    };
    for (const name of ["memory_forget", "memory_correct"]) {
      pi.registerTool({
        name,
        label: name === "memory_forget" ? "Forget Memory" : "Correct Memory",
        description:
          name === "memory_forget"
            ? "Request to forget the User's own cited Curated Memory, only when explicitly asked. Koed verifies the current Conversation, citation and ownership, then reports the outcome with Undo."
            : "Request a reviewed, source-linked correction to the User's own cited Curated Memory. Koed verifies the exact User statement and does not overwrite the assertion.",
        parameters: Type.Object(
          name === "memory_correct"
            ? {
                ...referenceParameters,
                correction: Type.String({ minLength: 1, maxLength: 4000 }),
                user_statement: Type.String({ minLength: 1, maxLength: 16000 })
              }
            : referenceParameters,
          { additionalProperties: false }
        ),
        async execute() {
          return memoryActionRequest(name);
        }
      });
    }
  }
  if (process.env.KOED_MANAGED_WORK_ITEM_COMPLETION === "1") {
    pi.registerTool({
      name: "work_item_complete",
      label: "Complete Work Item",
      description:
        "Report that the current managed Work Item is complete without a pull request. Koed validates this request against the running Agent execution before changing its status. Call only after the goal is met.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return workItemCompletionRequest();
      }
    });
  }
  if (process.env.KOED_MANAGED_MERGE_PROPOSAL === "1") {
    pi.registerTool({
      name: "review_request_merge_propose",
      label: "Propose pull request merge",
      description:
        "Ask Koed to show Native review for a pull request. Pass only its number. This tool cannot merge it.",
      parameters: Type.Object(
        { number: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, { number }) {
        return {
          content: [
            {
              type: "text",
              text: `Koed review_request_merge_propose request v1: {"number":${number},"status":"requested"}`
            }
          ],
          details: { number, status: "requested" }
        };
      }
    });
  }
  if (process.env.KOED_MANAGED_TEXT_ACTIONS === "1") {
    const uuid = Type.String({ format: "uuid" });
    const label = Type.String({ minLength: 1, maxLength: 160 });
    const fields = {
      koed_project_create: {
        name: label,
        folderPath: Type.Optional(
          Type.String({ minLength: 1, maxLength: 2048 })
        )
      },
      koed_project_move_chats: {
        projectId: uuid,
        sessionIds: Type.Array(uuid, { minItems: 1, maxItems: 50 })
      },
      koed_project_delete: { projectId: uuid },
      koed_chat_create: { projectId: Type.Optional(uuid) },
      koed_chat_move: { sessionId: uuid, projectId: Type.Optional(uuid) },
      koed_chat_delete: { sessionId: uuid },
      koed_todo_add: {
        projectId: uuid,
        title: label,
        goal: Type.Optional(Type.String({ maxLength: 20000 })),
        dueOn: Type.Optional(Type.String({ format: "date" }))
      },
      koed_todo_send: { projectId: uuid, workItemId: uuid, agentId: uuid },
      koed_team_invite: {
        projectId: uuid,
        email: Type.String({ format: "email", maxLength: 320 })
      },
      koed_deck_make: {
        projectId: uuid,
        title: Type.String({ minLength: 1, maxLength: 500 }),
        scope: Type.String({ minLength: 1, maxLength: 2000 }),
        madeFrom: Type.String({ minLength: 1, maxLength: 4000 }),
        cards: Type.Array(
          Type.Object(
            {
              question: Type.String({ minLength: 1, maxLength: 4000 }),
              answer: Type.String({ minLength: 1, maxLength: 16000 }),
              sourceRef: Type.Optional(
                Type.Union([Type.String({ maxLength: 2048 }), Type.Null()])
              ),
              topicLabel: Type.Optional(
                Type.Union([Type.String({ maxLength: 240 }), Type.Null()])
              )
            },
            { additionalProperties: false }
          ),
          { minItems: 1, maxItems: 100 }
        )
      },
      koed_hq_open: { projectId: uuid },
      koed_settings_open: {
        section: Type.Optional(
          Type.Union(
            ["general", "agents", "models", "devices"].map((value) =>
              Type.Literal(value)
            )
          )
        )
      },
      koed_settings_set_theme: {
        theme: Type.Union(
          ["light", "dark", "system"].map((value) => Type.Literal(value))
        )
      }
    };
    for (const [name, parameters] of Object.entries(fields)) {
      pi.registerTool({
        name,
        label: name.replace(/^koed_/, "").replaceAll("_", " "),
        description:
          "Request this Koed action for the current User turn. Koed verifies current ownership and shows the required approval. This tool does not perform the action.",
        parameters: Type.Object(parameters, { additionalProperties: false }),
        async execute() {
          return {
            content: [
              {
                type: "text",
                text: `Koed ${name} request v1: {"status":"requested"}`
              }
            ],
            details: { status: "requested" }
          };
        }
      });
    }
  }
  if (
    process.env.KOED_MANAGED_DOC_EXECUTION_ID &&
    process.env.KOED_MANAGED_DOC_EXECUTION_GENERATION &&
    process.env.KOED_MANAGED_DOC_API_URL &&
    process.env.KOED_MANAGED_DOC_HELPER_URL
  ) {
    pi.registerTool({
      name: "flashcard_sources",
      label: "Read Project Sources for flashcards",
      description:
        "Read authorized current Project Sources before generating flashcards. Use memory_answer separately for exam scope, learning preferences and weak spots. Respect exclusions.",
      parameters: Type.Union([
        Type.Object(
          {
            mode: Type.Literal("list"),
            cursor: Type.Optional(Type.Integer({ minimum: 0 }))
          },
          { additionalProperties: false }
        ),
        Type.Object(
          {
            mode: Type.Literal("read"),
            source_id: Type.Optional(Type.String({ format: "uuid" })),
            cursor: Type.Optional(Type.Integer({ minimum: 0 }))
          },
          { additionalProperties: false }
        )
      ]),
      async execute(_toolCallId, input) {
        const { readWorkItemsFromDocPage, listWorkItemsFromDocSources } =
          await import(process.env.KOED_MANAGED_DOC_HELPER_URL);
        const page =
          input.mode === "list"
            ? await listWorkItemsFromDocSources(input, process.env)
            : await readWorkItemsFromDocPage(input, process.env);
        return {
          content: [{ type: "text", text: JSON.stringify(page) }],
          details: page
        };
      }
    });
    pi.registerTool({
      name: "work_items_from_doc",
      label: "Make Work Items from a document",
      description:
        "For a typed request, first list current Project documents by name and continue while nextCursor exists; ask the User if names are ambiguous. A Project HQ selection lists only that document. Read the chosen source_id in pages (or omit it for a selected document), then preview actionable lines with current revision IDs and verbatim evidence. Preview counts new versus existing Plan Work Items without writing. Apply is only for a User start or prompt; a Koed catch-up may offer the preview count but must not apply. No to-tickets skill is required.",
      parameters: Type.Union([
        Type.Object(
          {
            mode: Type.Literal("list"),
            cursor: Type.Optional(Type.Integer({ minimum: 0 }))
          },
          { additionalProperties: false }
        ),
        Type.Object(
          {
            mode: Type.Literal("read"),
            source_id: Type.Optional(Type.String({ format: "uuid" })),
            cursor: Type.Optional(Type.Integer({ minimum: 0 }))
          },
          { additionalProperties: false }
        ),
        Type.Object(
          {
            mode: Type.Literal("preview"),
            source_id: Type.String({ format: "uuid" }),
            source_revision_id: Type.String({ format: "uuid" }),
            note_revision_id: Type.String({ format: "uuid" }),
            proposals: Type.Array(
              Type.Object(
                {
                  line_number: Type.Integer({ minimum: 1 }),
                  source_line: Type.String({ minLength: 1, maxLength: 4000 }),
                  title: Type.String({ minLength: 1, maxLength: 500 }),
                  goal: Type.String({ minLength: 1, maxLength: 20000 }),
                  due_text: Type.Union([
                    Type.Null(),
                    Type.String({ minLength: 1, maxLength: 100 })
                  ])
                },
                { additionalProperties: false }
              ),
              { minItems: 1, maxItems: 30 }
            )
          },
          { additionalProperties: false }
        ),
        Type.Object(
          {
            mode: Type.Literal("apply"),
            source_id: Type.String({ format: "uuid" }),
            source_revision_id: Type.String({ format: "uuid" }),
            note_revision_id: Type.String({ format: "uuid" }),
            proposals: Type.Array(
              Type.Object(
                {
                  line_number: Type.Integer({ minimum: 1 }),
                  source_line: Type.String({ minLength: 1, maxLength: 4000 }),
                  title: Type.String({ minLength: 1, maxLength: 500 }),
                  goal: Type.String({ minLength: 1, maxLength: 20000 }),
                  due_text: Type.Union([
                    Type.Null(),
                    Type.String({ minLength: 1, maxLength: 100 })
                  ])
                },
                { additionalProperties: false }
              ),
              { minItems: 1, maxItems: 30 }
            )
          },
          { additionalProperties: false }
        )
      ]),
      async execute(_toolCallId, input) {
        if (input.mode === "apply") {
          return {
            content: [
              {
                type: "text",
                text: 'Koed work_items_from_doc apply request v1: {"status":"requested"}'
              }
            ],
            details: { status: "requested" }
          };
        }
        const {
          readWorkItemsFromDocPage,
          listWorkItemsFromDocSources,
          previewWorkItemsFromDoc
        } = await import(process.env.KOED_MANAGED_DOC_HELPER_URL);
        const page =
          input.mode === "list"
            ? await listWorkItemsFromDocSources(input, process.env)
            : input.mode === "preview"
              ? await previewWorkItemsFromDoc(input, process.env)
              : await readWorkItemsFromDocPage(input, process.env);
        return {
          content: [{ type: "text", text: JSON.stringify(page) }],
          details: page
        };
      }
    });
  }
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
