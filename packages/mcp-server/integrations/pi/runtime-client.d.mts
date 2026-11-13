import type {
  MemoryAnswerDeliveryTask,
  MemoryAnswerExecutionPort
} from "./memory-answer-delivery.mjs";
interface PiRuntimeContext {
  cwd: string;
  sessionManager?: { getSessionId?: () => unknown };
}
export declare const piRuntimeCallerContext: (context: PiRuntimeContext) => {
  cwd: string;
  clientInfo: { name: "pi"; version: "koed-extension-v1" };
  conversation?: { externalSessionId: string; sourceRuntime: "pi" };
};
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
  context: PiRuntimeContext;
  signal?: AbortSignal;
  invocationKey: string;
}) => Promise<Record<string, unknown>>;
