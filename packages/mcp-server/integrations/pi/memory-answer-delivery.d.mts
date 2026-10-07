/** The execution owner remains responsible for task and result authorization. */
export interface MemoryAnswerDeliveryTask {
  id: string;
  invocationKey: string | null;
  status:
    | "accepted"
    | "running"
    | "cancel_requested"
    | "completed"
    | "failed"
    | "cancelled";
  version: number;
  expiresAt: string;
}

export interface MemoryAnswerExecutionPort<
  Task extends MemoryAnswerDeliveryTask = MemoryAnswerDeliveryTask,
  Input = Record<string, unknown>,
  Caller = unknown
> {
  start(
    input: Input,
    caller: Caller,
    invocationKey?: string,
    signal?: AbortSignal
  ): Promise<Task>;
  get(taskId: string, signal?: AbortSignal): Promise<Task>;
  cancel(taskId: string, signal?: AbortSignal): Promise<Task>;
}

export type MemoryAnswerObservation<Task extends MemoryAnswerDeliveryTask> =
  | { kind: "terminal"; task: Task }
  | {
      kind: "detached";
      taskId: string;
      reason:
        | "observer-aborted"
        | "stale-origin"
        | "expired"
        | "observation-timeout";
    };

export declare class MemoryAnswerDelivery<
  Task extends MemoryAnswerDeliveryTask = MemoryAnswerDeliveryTask,
  Input = Record<string, unknown>,
  Caller = unknown
> {
  constructor(
    port: MemoryAnswerExecutionPort<Task, Input, Caller>,
    options?: {
      /** Initial interval (default 1000ms); unchanged pending states back off to 5s.
       * HTTP 429 retries honor positive safe-integer retryAfterMs up to 300000ms,
       * otherwise back off from 5s to 60s, within the original observation bound. */
      pollMs?: number;
      maxObservationMs?: number;
      now?: () => number;
    }
  );
  accept(
    input: Input,
    caller: Caller,
    invocationKey?: string,
    signal?: AbortSignal
  ): Promise<Task>;
  get(taskId: string, signal?: AbortSignal): Promise<Task>;
  /** Explicit execution cancellation; aborting observe only detaches delivery. */
  cancel(taskId: string, signal?: AbortSignal): Promise<Task>;
  observe(
    taskId: string,
    options?: {
      signal?: AbortSignal;
      /** Must check adapter Conversation/generation/authority synchronously. */
      isCurrent?: (task?: Task) => boolean;
      /** Must synchronously enqueue presentation, with no intervening await. */
      present?: (task: Task) => void;
    }
  ): Promise<MemoryAnswerObservation<Task>>;
}
