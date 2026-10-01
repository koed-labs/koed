import type {
  MemoryAnswerDeliveryTask,
  MemoryAnswerExecutionPort
} from "./memory-answer-delivery.mjs";
export declare const RECEIPT: string;
export declare const DISPOSITION: string;
export declare const COMPLETION: string;
export interface PiDeliveryContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getBranch(): Array<{
      type: string;
      customType?: string;
      data?: unknown;
      details?: unknown;
    }>;
    getEntries(): Array<{
      type: string;
      customType?: string;
      data?: unknown;
      details?: unknown;
    }>;
  };
  ui?: { notify?(message: string, level: string): void };
}
export declare function createPiMemoryDelivery(
  pi: {
    appendEntry?(type: string, data: Record<string, unknown>): void;
    sendMessage?(
      message: {
        customType: string;
        content: string;
        display: boolean;
        details: Record<string, unknown>;
      },
      options: { deliverAs: "followUp"; triggerTurn: true }
    ): void;
  },
  options: {
    port: MemoryAnswerExecutionPort<MemoryAnswerDeliveryTask> & {
      scope: string;
    };
    blocking(
      input: Record<string, unknown>,
      context: PiDeliveryContext,
      signal: AbortSignal | undefined,
      invocation: string
    ): Promise<Record<string, unknown>>;
    mode?: string;
    pollMs?: number;
    retryMs?: number;
  }
): {
  execute(
    id: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    context: PiDeliveryContext
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
  start(event: { reason: string }, context: PiDeliveryContext): void;
  detach(invalidate?: boolean): void;
  pending: Map<string, { watcher: Promise<unknown> }>;
  settle(): Promise<void>;
};
