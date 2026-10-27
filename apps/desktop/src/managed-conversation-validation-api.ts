import type {
  ManagedConversationDesktopApi,
  ManagedConversationIdentity
} from "./ipc/managed-conversation-protocol.js";

/** Synthetic AI Client for isolated native UI demonstrations. No real runner starts. */
export const createManagedConversationValidationApi = ({
  timestamp = new Date().toISOString(),
  onStart
}: {
  timestamp?: string;
  onStart?: (
    input: Parameters<ManagedConversationDesktopApi["start"]>[0]
  ) => void;
} = {}) => {
  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const managedValidationTrace: {
    sends: Array<{ executionId: string; prompt: string }>;
    starts: Array<{
      contextKind: "project" | "independent";
      executionId: string;
      projectId: string;
    }>;
  } = { sends: [], starts: [] };
  const managedValidationConversations = new Map<
    string,
    ManagedConversationIdentity
  >();
  const managedValidationDrafts = new Map<string, string>();
  const managedValidationLatestCommands = new Map<
    string,
    { clientUserMessageId: string; id: string }
  >();
  let managedValidationSequence = 100;

  const managedDraftKey = (input: {
    projectId: string;
    capturedSessionId: string;
    threadId: string;
  }): string =>
    `${input.projectId}:${input.capturedSessionId}:${input.threadId}`;

  const unavailableManagedOperation = async (): Promise<never> => {
    throw new Error("This browser fixture operation is unavailable.");
  };

  const managedConversations: ManagedConversationDesktopApi = {
    launchOptions: async () => ({
      operation: "launch_options",
      options: {
        runners: [
          {
            kind: "local_device",
            deploymentId: uuid(50),
            deviceId: uuid(51),
            displayName: "This device"
          }
        ],
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "Codex",
            ready: true,
            readiness: "ready",
            models: [
              {
                id: "gpt-test",
                displayName: "GPT Test",
                isDefault: true,
                supportedReasoningEfforts: ["medium"],
                defaultReasoningEffort: "medium"
              }
            ],
            capabilities: {
              defaultPermissionMode: "supervised",
              permissionModes: [{ mode: "supervised", support: "supported" }]
            }
          }
        ]
      }
    }),
    start: async (input) => {
      const executionId = uuid(++managedValidationSequence);
      const conversation: ManagedConversationIdentity = {
        executionId,
        projectId: input.projectId,
        capturedSessionId: executionId,
        threadId: executionId,
        executionOwner: {
          driverId: input.aiClientDriverId,
          instanceId: input.aiClientInstanceId
        }
      };
      managedValidationConversations.set(executionId, conversation);
      managedValidationTrace.starts.push({
        contextKind: input.contextKind ?? "project",
        executionId,
        projectId: input.projectId
      });
      onStart?.(input);
      return {
        operation: "start",
        status: "ready",
        executionId,
        conversation
      };
    },
    inspect: async (executionId) => ({
      operation: "inspect",
      status: "ready",
      executionId,
      conversation: managedValidationConversations.get(executionId)
    }),
    send: async (input) => {
      const conversation = managedValidationConversations.get(
        input.executionId
      );
      if (!conversation) throw new Error("Unknown browser fixture execution.");
      managedValidationTrace.sends.push({
        executionId: input.executionId,
        prompt: input.prompt
      });
      managedValidationLatestCommands.set(input.executionId, {
        clientUserMessageId: input.clientUserMessageId,
        id: uuid(++managedValidationSequence)
      });
      return {
        operation: "send",
        status: "queued",
        conversation,
        idempotencyKey: input.idempotencyKey,
        clientUserMessageId: input.clientUserMessageId,
        turnId: uuid(++managedValidationSequence)
      };
    },
    readDraft: async (input) => ({
      operation: "draft_read",
      value: managedValidationDrafts.get(managedDraftKey(input)) ?? ""
    }),
    writeDraft: async (input) => {
      managedValidationDrafts.set(managedDraftKey(input), input.value);
      return { operation: "draft_write", ok: true };
    },
    deleteDraft: async (input) => {
      managedValidationDrafts.delete(managedDraftKey(input));
      return { operation: "draft_delete", ok: true };
    },
    targets: async () => ({ operation: "targets", devices: [] }),
    usage: async (executionId) => ({
      operation: "usage",
      executionId,
      provider: "codex",
      model: "gpt-test",
      reasoningEffort: "medium",
      permissionMode: "supervised",
      usage: null
    }),
    runtime: async (executionId) => {
      const latest = managedValidationLatestCommands.get(executionId);
      return {
        operation: "runtime",
        executionId,
        executionGeneration: 1,
        executionStateVersion: 1,
        executionState: "idle",
        executionLastErrorCode: null,
        latestCommand: latest
          ? {
              id: latest.id,
              sequence: managedValidationTrace.sends.length,
              executionGeneration: 1,
              commandKind: "prompt",
              clientUserMessageId: latest.clientUserMessageId,
              state: "completed",
              lastErrorCode: null,
              updatedAt: timestamp
            }
          : null,
        items: []
      };
    },
    respond: async (input) => ({
      operation: "runtime_respond",
      accepted: true,
      itemId: input.itemId
    }),
    interrupt: async (input) => ({
      operation: "interrupt",
      status: "queued",
      executionId: input.executionId,
      commandId: uuid(++managedValidationSequence)
    }),
    stop: async (input) => ({
      operation: "stop",
      status: "queued",
      executionId: input.executionId,
      commandId: uuid(++managedValidationSequence)
    }),
    transferStatus: async (executionId) => ({
      operation: "transfer_status",
      executionId,
      handoff: null,
      fork: null
    }),
    handoff: unavailableManagedOperation,
    fork: unavailableManagedOperation,
    discoverCommands: async () => ({
      operation: "command_discovery",
      status: "unavailable",
      commands: []
    }),
    resume: async (input) => {
      const conversation = managedValidationConversations.get(
        input.capturedSessionId
      );
      return conversation
        ? { operation: "resume", status: "ready", conversation }
        : {
            operation: "resume",
            status: "read_only",
            conversation: {
              executionId: null,
              projectId: input.projectId,
              capturedSessionId: input.capturedSessionId,
              threadId: input.threadId
            },
            message: "This Captured Session is read-only."
          };
    }
  };

  return { api: managedConversations, trace: managedValidationTrace };
};
