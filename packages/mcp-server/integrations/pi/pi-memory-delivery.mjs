/* global AbortController, setTimeout, clearTimeout */
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { MemoryAnswerDelivery } from "./memory-answer-delivery.mjs";

export const RECEIPT = "koed-memory-answer-receipt-v1";
export const DISPOSITION = "koed-memory-answer-disposition-v1";
export const COMPLETION = "koed-memory-answer-completion";
const hash = (query) => createHash("sha256").update(query).digest("hex");
const textResult = (result) => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  details: result
});
// Print and JSON modes are single-shot: Pi disposes the runtime once the
// prompted turn returns, before a deferred result could be presented.
const capabilities = (pi, ctx) =>
  ctx.mode !== "print" &&
  ctx.mode !== "json" &&
  Boolean(ctx.sessionManager.getSessionFile()) &&
  typeof ctx.sessionManager.getBranch === "function" &&
  typeof ctx.sessionManager.getEntries === "function" &&
  typeof pi.appendEntry === "function" &&
  typeof pi.sendMessage === "function";
const validReceipt = (value) =>
  value &&
  value.schema === 1 &&
  [
    "taskId",
    "invocation",
    "conversation",
    "sessionFile",
    "generation",
    "scope",
    "query",
    "queryHash",
    "expiresAt"
  ].every((key) => typeof value[key] === "string") &&
  value.query.length > 0 &&
  value.query.length <= 32000 &&
  hash(value.query) === value.queryHash &&
  Number.isFinite(Date.parse(value.expiresAt));

// Receipts are Pi presentation history only. The runtime remains the sole task
// owner; stopping this observer never cancels accepted work.
export function createPiMemoryDelivery(
  pi,
  { port, blocking, mode = "auto", pollMs = 1000, retryMs = 1000 }
) {
  const boundary = new MemoryAnswerDelivery(port, { pollMs });
  const pending = new Map();
  const accepting = new Set();
  let context,
    epoch = 0,
    alive = false;
  const settled = (ctx) =>
    new Set(
      ctx.sessionManager.getEntries().flatMap((entry) => {
        if (
          entry.type === "custom" &&
          entry.customType === DISPOSITION &&
          typeof entry.data?.taskId === "string"
        )
          return [entry.data.taskId];
        if (
          entry.type === "custom_message" &&
          entry.customType === COMPLETION &&
          typeof entry.details?.taskId === "string"
        )
          return [entry.details.taskId];
        return [];
      })
    );
  const matches = (binding, ctx) =>
    binding.conversation === ctx.sessionManager.getSessionId() &&
    binding.sessionFile ===
      resolve(ctx.sessionManager.getSessionFile() ?? ".") &&
    binding.scope === port.scope;
  const current = (binding, ownEpoch, task) =>
    alive &&
    ownEpoch === epoch &&
    context &&
    matches(binding, context) &&
    !settled(context).has(binding.taskId) &&
    context.sessionManager
      .getBranch()
      .some(
        (e) =>
          e.type === "custom" &&
          e.customType === RECEIPT &&
          e.data?.taskId === binding.taskId &&
          e.data?.generation === binding.generation
      ) &&
    (!task ||
      (task.id === binding.taskId &&
        task.invocationKey === binding.invocation));
  const detach = (invalidate = false) => {
    if (invalidate && context && capabilities(pi, context)) {
      const done = settled(context);
      // Tree navigation moves the branch before handlers run. An earlier
      // asynchronous handler can let stale observers finish and disappear.
      // Invalidate matching history receipts even when no observer remains.
      const bindings = [
        ...[...pending.values()].map((item) => item.binding),
        ...context.sessionManager
          .getEntries()
          .flatMap((entry) =>
            entry.type === "custom" && entry.customType === RECEIPT
              ? [entry.data]
              : []
          )
      ];
      for (const binding of bindings) {
        if (
          validReceipt(binding) &&
          matches(binding, context) &&
          !done.has(binding.taskId)
        ) {
          pi.appendEntry(DISPOSITION, {
            taskId: binding.taskId,
            disposition: "detached"
          });
          done.add(binding.taskId);
        }
      }
    }
    alive = false;
    epoch++;
    for (const item of pending.values()) item.controller.abort();
    pending.clear();
    accepting.clear();
  };
  const observe = (binding) => {
    if (pending.has(binding.taskId)) return;
    const ownEpoch = epoch;
    const controller = new AbortController();
    const watcher = (async () => {
      while (
        current(binding, ownEpoch) &&
        Date.parse(binding.expiresAt) > Date.now()
      ) {
        try {
          return await boundary.observe(binding.taskId, {
            signal: controller.signal,
            isCurrent: (task) => current(binding, ownEpoch, task),
            present: (task) => {
              // Record the enqueue attempt first: no duplicate after restart. A
              // crash or Pi queue failure between this marker and context append
              // can lose delivery; Pi's void API cannot provide exactly once.
              pi.appendEntry(DISPOSITION, {
                taskId: task.id,
                disposition: "enqueued"
              });
              const completion = {
                type: "memory_answer_completion",
                ...binding,
                status: task.status,
                ...(task.status === "completed"
                  ? { result: task.result }
                  : { errorCode: task.lastErrorCode ?? task.status })
              };
              pi.sendMessage(
                {
                  customType: COMPLETION,
                  content: JSON.stringify(completion),
                  display: true,
                  details: binding
                },
                { deliverAs: "followUp", triggerTurn: true }
              );
            }
          });
        } catch (error) {
          if (controller.signal.aborted || !current(binding, ownEpoch)) return;
          const status = error?.statusCode ?? error?.status;
          if (status && status < 500 && status !== 429) {
            context.ui?.notify?.(
              "Koed Memory Answer delivery unavailable; resume to retry authorized recall.",
              "warning"
            );
            return;
          }
          // Runtime restarts preserve execution. Bounded retries reload the
          // protected registration; never reuse a cached token or result.
          await new Promise((done) => {
            const finish = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", finish);
              done();
            };
            const timer = setTimeout(finish, retryMs);
            controller.signal.addEventListener("abort", finish, { once: true });
          });
        }
      }
    })().finally(() => {
      if (pending.get(binding.taskId)?.controller === controller)
        pending.delete(binding.taskId);
    });
    pending.set(binding.taskId, { binding, controller, watcher });
  };
  const start = (event, ctx) => {
    detach();
    context = ctx;
    alive = true;
    if (
      mode === "blocking" ||
      !capabilities(pi, ctx) ||
      event.reason === "fork"
    )
      return;
    const done = settled(ctx);
    // Recover only current-branch, same-Conversation receipts, bounded to 128.
    for (const entry of ctx.sessionManager.getBranch().slice().reverse()) {
      if (pending.size >= 128) break;
      if (entry.type !== "custom" || entry.customType !== RECEIPT) continue;
      const binding = entry.data;
      if (
        validReceipt(binding) &&
        matches(binding, ctx) &&
        !done.has(binding.taskId) &&
        Date.parse(binding.expiresAt) > Date.now()
      )
        observe(binding);
    }
  };
  const execute = async (id, input, signal, ctx) => {
    const invocation = `${ctx.sessionManager.getSessionId()}:${id}`;
    if (
      mode === "blocking" ||
      input.team_workspace_id ||
      !capabilities(pi, ctx)
    )
      return textResult(await blocking(input, ctx, signal, invocation));
    if (
      !alive ||
      context?.sessionManager.getSessionId() !==
        ctx.sessionManager.getSessionId()
    )
      throw new Error("Koed Memory Answer Conversation is inactive");
    const previous = ctx.sessionManager
      .getBranch()
      .find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === RECEIPT &&
          entry.data?.invocation === invocation
      );
    if (
      previous &&
      (!validReceipt(previous.data) ||
        !matches(previous.data, ctx) ||
        previous.data.queryHash !== hash(input.query))
    )
      throw new Error(
        "Koed Memory Answer invocation does not match its recorded query"
      );
    if (pending.size + accepting.size >= 128)
      return textResult(await blocking(input, ctx, signal, invocation));
    const reservation = {};
    accepting.add(reservation);
    const ownEpoch = epoch;
    const origin = {
      conversation: ctx.sessionManager.getSessionId(),
      sessionFile: resolve(ctx.sessionManager.getSessionFile()),
      generation: randomUUID(),
      scope: port.scope,
      invocation,
      queryHash: hash(input.query)
    };
    let task;
    try {
      task = await boundary.accept(
        input,
        {
          cwd: ctx.cwd,
          clientInfo: {
            name: "pi",
            version: "koed-extension-v1",
            deliveryOrigin: origin
          }
        },
        invocation,
        signal
      );
    } catch (error) {
      if (
        error?.statusCode === 409 &&
        error?.code === "memory_answer_team_ineligible"
      )
        return textResult(await blocking(input, ctx, signal, invocation));
      throw error;
    } finally {
      accepting.delete(reservation);
    }
    if (!alive || epoch !== ownEpoch || !matches(origin, ctx))
      throw new Error("Koed Memory Answer observer detached");
    const binding = {
      schema: 1,
      ...origin,
      taskId: task.id,
      query: input.query,
      expiresAt: task.expiresAt
    };
    // Pi persists this custom entry with its normal session history. Before the
    // first assistant message Pi may buffer it in memory, as documented by Pi.
    const existing = ctx.sessionManager
      .getBranch()
      .find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === RECEIPT &&
          entry.data?.taskId === task.id
      );
    if (
      existing &&
      (!validReceipt(existing.data) ||
        !matches(existing.data, ctx) ||
        existing.data.queryHash !== binding.queryHash ||
        existing.data.invocation !== invocation)
    )
      throw new Error(
        "Koed Memory Answer receipt does not match this invocation"
      );
    const saved = existing?.data ?? binding;
    if (!existing) pi.appendEntry(RECEIPT, binding);
    if (!settled(ctx).has(task.id)) observe(saved);
    return textResult({
      accepted: true,
      ...saved,
      status: task.status,
      notice:
        "Koed will deliver the result automatically. Continue independent work; await the result before a memory-dependent decision. Do not poll for status."
    });
  };
  return {
    execute,
    start,
    detach,
    pending,
    async settle() {
      await Promise.all([...pending.values()].map((item) => item.watcher));
    }
  };
}
