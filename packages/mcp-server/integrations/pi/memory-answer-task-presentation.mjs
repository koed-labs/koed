import { formatMemoryAnswerCompletion } from "./memory-answer-presentation.mjs";
import { MemoryAnswerDelivery } from "./memory-answer-delivery.mjs";

export const collectMemoryAnswerTask = async (
  port,
  taskId,
  { signal, wait = false, maxObservationMs, pollMs } = {}
) => {
  if (typeof wait !== "boolean")
    throw new Error("Memory Answer wait must be a boolean.");
  if (!isMemoryAnswerTaskId(taskId)) {
    throw new Error("Memory Answer task identity is invalid.");
  }
  const checkAbort = () => {
    if (signal?.aborted)
      throw new Error("Memory Answer collection was aborted.");
  };
  let previousIdentity;
  const read = async (id, readSignal = signal) => {
    checkAbort();
    let onAbort;
    const detached = new Promise((_, reject) => {
      onAbort = () =>
        reject(new Error("Memory Answer collection was aborted."));
      readSignal?.addEventListener("abort", onAbort, { once: true });
      if (readSignal?.aborted) onAbort();
    });
    let task;
    try {
      // Ignore non-cooperative late reads after detachment. The observer owns
      // the task-expiry and observation-lifecycle deadline signals.
      task = await Promise.race([
        Promise.resolve().then(() => port.get(id, readSignal)),
        detached
      ]);
    } finally {
      readSignal?.removeEventListener("abort", onAbort);
    }
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
    return task;
  };
  if (!wait) return await read(taskId);
  const delivery = new MemoryAnswerDelivery(
    { get: read, subscribe: port.subscribe?.bind(port) },
    { maxObservationMs, pollMs }
  );
  const observed = await delivery.observe(taskId, { signal });
  checkAbort();
  if (observed.kind === "terminal") {
    validateMemoryAnswerTask(observed.task, taskId);
    return observed.task;
  }
  if (observed.reason === "expired")
    throw new Error("Memory Answer task has expired.");
  if (observed.reason === "observation-timeout")
    throw new Error(
      "Memory Answer observation lifecycle ended. Collect the existing task again if needed."
    );
  throw new Error("Memory Answer collection was aborted.");
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
    // Execution already projects the result to the requested detail level.
    // The shared formatter includes only supported answer fields, not task metadata.
    return {
      status: "completed",
      task_id: task.id,
      text: formatMemoryAnswerCompletion(task.result, "completed", {
        includeDetails: true
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
