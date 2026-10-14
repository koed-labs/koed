import type { MemoryAnswerTask } from "@koed/shared";

export function collectMemoryAnswerTask(
  port: {
    get(taskId: string, signal?: AbortSignal): Promise<MemoryAnswerTask>;
    subscribe?(taskId: string, wake: () => void): () => void;
  },
  taskId: string,
  options?: { signal?: AbortSignal; waitSeconds?: number }
): Promise<MemoryAnswerTask>;

export function isMemoryAnswerTaskId(value: unknown): value is string;
export function validateMemoryAnswerTask(
  task: MemoryAnswerTask,
  expectedId?: string
): void;
export interface PendingMemoryAnswerTask {
  status: "pending";
  task_id: string;
  expires_at: string;
  guidance: string;
}
export function pendingMemoryAnswerTask(
  task: MemoryAnswerTask
): PendingMemoryAnswerTask;
export function presentMemoryAnswerTask(
  task: MemoryAnswerTask
):
  | PendingMemoryAnswerTask
  | { status: "completed"; task_id: string; text: string }
  | { status: "failed" | "cancelled"; task_id: string; message: string };
