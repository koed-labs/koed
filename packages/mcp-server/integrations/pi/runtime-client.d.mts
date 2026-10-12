import type {
  MemoryAnswerDeliveryTask,
  MemoryAnswerExecutionPort
} from "./memory-answer-delivery.mjs";
export declare const readRuntimeRegistration: (koedHome: string) => {
  protocolVersion: 1;
  url: string;
  authorization: string;
  pid: number;
  startedAt: string;
};
export declare const createRuntimeTaskPort: (
  koedHome: string
) => MemoryAnswerExecutionPort<MemoryAnswerDeliveryTask> & { scope: string };
export declare const callLocalRuntimeTool: (input: {
  koedHome: string;
  name: string;
  input: Record<string, unknown>;
  context: { cwd: string };
  signal?: AbortSignal;
  invocationKey: string;
}) => Promise<Record<string, unknown>>;
