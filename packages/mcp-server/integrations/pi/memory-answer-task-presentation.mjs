/* global AbortController, setTimeout, clearTimeout */
import { formatMemoryAnswerCompletion } from "./memory-answer-presentation.mjs";
import { MemoryAnswerDelivery } from "./memory-answer-delivery.mjs";

export const collectMemoryAnswerTask = async (
  port,
  taskId,
  { signal, waitSeconds = 0 } = {}
) => {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 30) {
    throw new Error(
      "Memory Answer wait must be an integer from 0 to 30 seconds."
    );
  }
  if (!isMemoryAnswerTaskId(taskId)) {
    throw new Error("Memory Answer task identity is invalid.");
  }
  const checkAbort = () => {
    if (signal?.aborted)
      throw new Error("Memory Answer collection was aborted.");
  };
  let pendingSnapshot;
  let previousIdentity;
  const read = async (id, readSignal = signal) => {
    checkAbort();
    const task = await port.get(id, readSignal);
    checkAbort();
    if (readSignal?.aborted)
      throw new Error("Memory Answer collection was aborted.");
    validateMemoryAnswerTask(task, taskId);
    if (
      previousIdentity &&
      (task.invocationKey !== previousIdentity.invocationKey ||
        task.version < previousIdentity.version)
    )
      throw new Error("Memory Answer task identity or version changed.");
    previousIdentity = {
      invocationKey: task.invocationKey,
      version: task.version
    };
    if (["accepted", "running", "cancel_requested"].includes(task.status)) {
      pendingSnapshot = { ...task, result: null };
    }
    return task;
  };
  if (waitSeconds === 0) return await read(taskId);

  const controller = new AbortController();
  const deadline = Date.now() + waitSeconds * 1000;
  let timer;
  let onAbort;
  const bound = new Promise((resolve, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new Error("Memory Answer collection was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => {
      controller.abort();
      try {
        checkAbort();
        if (!pendingSnapshot)
          throw new Error("Memory Answer collection timed out.");
        validateMemoryAnswerTask(pendingSnapshot, taskId);
        // A timeout can expose only a pending handle, never cached answer text.
        resolve(pendingSnapshot);
      } catch (error) {
        reject(error);
      }
    }, waitSeconds * 1000);
  });
  const operation = async () => {
    const initial = await read(taskId, controller.signal);
    if (["completed", "failed", "cancelled"].includes(initial.status))
      return initial;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return await bound;
    const delivery = new MemoryAnswerDelivery(
      { get: read, subscribe: port.subscribe?.bind(port) },
      { maxObservationMs: remaining }
    );
    const observed = await delivery.observe(taskId, {
      signal: controller.signal
    });
    checkAbort();
    if (observed.kind === "terminal") {
      validateMemoryAnswerTask(observed.task, taskId);
      return observed.task;
    }
    if (observed.reason === "expired")
      throw new Error("Memory Answer task has expired.");
    // The outer deadline also bounds initial and final authorization reads.
    if (observed.reason === "observation-timeout")
      return await read(taskId, controller.signal);
    return await bound;
  };
  try {
    return await Promise.race([operation(), bound]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
};

export const isMemoryAnswerTaskId = (value) =>
  typeof value === "string" &&
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(
    value
  );

export const validateMemoryAnswerTask = (task, expectedId) => {
  if (
    !isMemoryAnswerTaskId(task.id) ||
    (expectedId !== undefined &&
      task.id.toLowerCase() !== expectedId.toLowerCase())
  ) {
    throw new Error("Memory Answer task identity is invalid.");
  }
  const expiresAt = Date.parse(task.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Memory Answer task has expired.");
  }
};

export const pendingMemoryAnswerTask = (task) => ({
  status: "pending",
  task_id: task.id,
  expires_at: task.expiresAt,
  guidance:
    "Recall is running. Continue independent work, then call memory_answer_result with this task_id when recalled memory is needed. Do not repeat memory_answer or use a tight polling loop."
});

export const presentMemoryAnswerTask = (task) => {
  if (
    task.status === "accepted" ||
    task.status === "running" ||
    task.status === "cancel_requested"
  )
    return pendingMemoryAnswerTask(task);
  if (task.status === "completed") {
    // The formatter projects only readable text when details are disabled.
    return {
      status: "completed",
      task_id: task.id,
      text: formatMemoryAnswerCompletion(task.result, "completed", {
        includeDetails: false
      })
    };
  }
  return {
    status: task.status === "cancelled" ? "cancelled" : "failed",
    task_id: task.id,
    message:
      task.status === "cancelled"
        ? "Memory Answer was cancelled. No answer is available."
        : "Memory Answer failed. No answer is available."
  };
};
