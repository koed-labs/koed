import { createHash } from "node:crypto";

import type {
  ClaimedPersonalAgentChatDelivery,
  ManagedConversationCommandRecord,
  ManagedConversationExecutionRecord,
  MemorySourceRepository
} from "@koed/db";
import {
  personalAgentExecutionContextSchema,
  type PersonalAgentChatContextTransfer
} from "@koed/shared";
import type { Logger } from "pino";

export type PersonalAgentChatChildResult = {
  status:
    | "pending"
    | "completed"
    | "confirmed_failure"
    | "indeterminate"
    | "stopped";
  messageId: string;
  executionId: string | null;
  executionGeneration: number | null;
  startCommandId: string | null;
  promptCommandId: string | null;
  assistantOutput: { text: string; truncated: boolean } | null;
  jobId: string | null;
  errorCode: string | null;
  cancelRequested: boolean;
  terminal: boolean;
  /** True only when captured provider output remains queued for checkpoint recovery. */
  checkpointPending?: boolean;
};

type PersonalAgentChatPrepareInput = {
  actor: { userId: string };
  conversationId: string;
  deliveryId: string;
  claimToken: string;
  targetDeviceId: string;
  targetDeploymentId: string;
  provider: string;
  aiClientInstanceId: string;
  model: string;
  reasoningEffort: string | null;
  permissionMode: "supervised" | "auto_edit" | "auto" | "full_access";
  prompt: string;
  contextText: string | null;
  contextTransfer: PersonalAgentChatContextTransfer | null;
  clientUserMessageId: string;
  selectedResourceIds: string[];
  selectedResourceHostedInstanceId?: string;
  agentId?: string;
  agentVersion?: number;
  personalAgentContext?: unknown;
  idempotencyKey: string;
};

export type PersonalAgentChatPrepareRequest = PersonalAgentChatPrepareInput;

export type PersonalAgentChatChildCancellation = {
  deliveryId: string;
  conversationId: string;
  claimToken: string;
  executionId: string;
  promptCommandId: string | null;
  startCommandId?: string;
  executionGeneration: number;
};

export type PersonalAgentChatBatchCancellation = {
  deliveryId: string;
  conversationId: string;
  messageId: string;
  claimToken: string;
  requestId: string;
};

/** The local and outbound runners share these fenced operations. */
export interface PersonalAgentChatRunnerAuthority {
  claimDelivery(input: {
    ownerUserId: string;
    targetDeviceId: string;
    targetDeploymentId: string;
    runnerId: string;
    leaseMs: number;
  }): Promise<ClaimedPersonalAgentChatDelivery | null>;
  renewDeliveryClaim(input: {
    ownerUserId: string;
    deliveryId: string;
    claimToken: string;
    leaseMs: number;
  }): Promise<boolean>;
  prepareChild(input: PersonalAgentChatPrepareInput): Promise<{
    execution: ManagedConversationExecutionRecord;
    command: ManagedConversationCommandRecord;
  }>;
  getChildResult(input: {
    actor: { userId: string };
    conversationId: string;
    deliveryId: string;
    claimToken: string;
    targetDeviceId: string;
    targetDeploymentId: string;
  }): Promise<PersonalAgentChatChildResult | null>;
  cancelChild(input: PersonalAgentChatChildCancellation): Promise<unknown>;
  cancelBatch(input: PersonalAgentChatBatchCancellation): Promise<unknown>;
  completeDelivery(input: {
    ownerUserId: string;
    deliveryId: string;
    claimToken: string;
    executionId: string;
    commandId: string;
    jobId: string | null;
    reply: string;
    truncated: boolean;
    contextTransfer: PersonalAgentChatContextTransfer | null;
  }): Promise<boolean>;
  failDelivery(input: {
    ownerUserId: string;
    deliveryId: string;
    claimToken: string;
    certainty: "confirmed_failure" | "indeterminate";
    errorCode: string;
  }): Promise<boolean>;
}

type LocalPersonalAgentChatRepository = MemorySourceRepository & {
  preparePersonalAgentChatChild(
    input: PersonalAgentChatPrepareInput & {
      targetDeviceId: string;
      targetDeploymentId: string;
    }
  ): Promise<{
    execution: ManagedConversationExecutionRecord;
    command: ManagedConversationCommandRecord;
  }>;
  getPersonalAgentChatChildResult(input: {
    actor: { userId: string };
    conversationId: string;
    deliveryId: string;
    claimToken: string;
    targetDeviceId: string;
    targetDeploymentId: string;
  }): Promise<PersonalAgentChatChildResult | null>;
};

export const createLocalPersonalAgentChatRunnerAuthority = (input: {
  repository: MemorySourceRepository;
  ownerUserId: string;
  targetDeviceId: string;
  targetDeploymentId: string;
}): PersonalAgentChatRunnerAuthority => {
  const repository = input.repository as LocalPersonalAgentChatRepository;
  const actor = { userId: input.ownerUserId };
  const target = {
    targetDeviceId: input.targetDeviceId,
    targetDeploymentId: input.targetDeploymentId
  };
  return {
    claimDelivery(claim) {
      return repository.claimNextPersonalAgentChatDelivery({
        ownerUserId: claim.ownerUserId,
        targetDeviceId: claim.targetDeviceId,
        deploymentId: claim.targetDeploymentId,
        runnerId: claim.runnerId,
        leaseMs: claim.leaseMs
      });
    },
    renewDeliveryClaim(claim) {
      return repository.renewPersonalAgentChatDeliveryClaim(claim);
    },
    prepareChild(prepare) {
      return repository.preparePersonalAgentChatChild(prepare);
    },
    getChildResult(result) {
      return repository.getPersonalAgentChatChildResult(result);
    },
    async cancelChild(cancel) {
      const result = await repository.getPersonalAgentChatChildResult({
        actor,
        conversationId: cancel.conversationId,
        deliveryId: cancel.deliveryId,
        claimToken: cancel.claimToken,
        ...target
      });
      if (
        !result ||
        !result.cancelRequested ||
        result.executionId !== cancel.executionId ||
        result.promptCommandId !== cancel.promptCommandId ||
        (cancel.promptCommandId === null &&
          result.startCommandId !== cancel.startCommandId)
      ) {
        throw Object.assign(
          new Error("Cancellation does not match the active Agent delivery"),
          { statusCode: 409 }
        );
      }
      const cancellation =
        cancel.promptCommandId === null
          ? await repository.cancelManagedConversationStart(actor, {
              executionId: cancel.executionId,
              executionGeneration: cancel.executionGeneration
            })
          : await repository.cancelManagedConversationPrompt(actor, {
              executionId: cancel.executionId,
              commandId: cancel.promptCommandId,
              executionGeneration: cancel.executionGeneration
            });
      if (
        cancellation &&
        ["queued", "dispatching", "blocked", "indeterminate"].includes(
          cancellation.state
        )
      ) {
        return repository.enqueueManagedConversationControl(actor, {
          executionId: cancel.executionId,
          executionGeneration: cancel.executionGeneration,
          commandKind: "interrupt",
          idempotencyKey: `personal-chat-cancel:${cancel.deliveryId}:${cancel.promptCommandId ?? cancel.startCommandId}`
        });
      }
      return cancellation;
    },
    async cancelBatch(cancel) {
      const result = await repository.getPersonalAgentChatChildResult({
        actor,
        conversationId: cancel.conversationId,
        deliveryId: cancel.deliveryId,
        claimToken: cancel.claimToken,
        ...target
      });
      if (
        !result ||
        !result.cancelRequested ||
        !result.terminal ||
        result.status !== "stopped" ||
        result.messageId !== cancel.messageId
      ) {
        throw Object.assign(
          new Error("Agent stop has not been confirmed for this batch"),
          { statusCode: 409 }
        );
      }
      return repository.cancelPersonalAgentChatBatch(actor, {
        conversationId: cancel.conversationId,
        messageId: cancel.messageId,
        requestId: cancel.requestId,
        confirmedStopped: true
      });
    },
    completeDelivery(completion) {
      return repository.completePersonalAgentChatDelivery(completion);
    },
    failDelivery(failure) {
      return repository.failPersonalAgentChatDelivery(failure);
    }
  };
};

const stableUuid = (namespace: string, value: string): string => {
  const bytes = createHash("sha256")
    .update(`koed-personal-agent-chat:${namespace}:v1\0`)
    .update(value)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const recipientContexts = (
  delivery: ClaimedPersonalAgentChatDelivery
): { agentContext?: unknown } => {
  if (delivery.launch.kind === "generic") return {};

  const contextEnvelope = object(delivery.personalAgentContext);
  if (!contextEnvelope) {
    throw Object.assign(new Error("Personal chat Agent context is missing"), {
      name: "ManagedConversationPersonalAgentContextError"
    });
  }
  const storedContext =
    "context" in contextEnvelope ? contextEnvelope.context : contextEnvelope;
  const agentContext =
    personalAgentExecutionContextSchema.safeParse(storedContext);
  if (
    !agentContext.success ||
    agentContext.data.identity.agentId !== delivery.launch.agentId ||
    agentContext.data.identity.version !== delivery.launch.agentVersion
  ) {
    throw Object.assign(
      new Error("Personal chat Agent context is stale or invalid"),
      { name: "ManagedConversationPersonalAgentContextError" }
    );
  }
  return { agentContext: agentContext.data };
};

const transientFailure = (error: unknown): boolean => {
  const value = object(error);
  if (value?.transient === true) return true;
  if (
    typeof value?.name === "string" &&
    value.name.startsWith("ManagedConversationPersonal")
  ) {
    return false;
  }
  if (value?.name === "ManagedConversationPayloadError") return false;
  const statusCode = value?.statusCode;
  return (
    typeof statusCode !== "number" || statusCode >= 500 || statusCode === 429
  );
};

const errorCode = (error: unknown): string => {
  const value = object(error);
  const code = value?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_]{0,119}$/u.test(code)) {
    return code;
  }
  const name = value?.name;
  if (typeof name === "string") {
    const normalized = name
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/gu, "_")
      .replace(/^_+|_+$/gu, "");
    if (/^[a-z][a-z0-9_]{0,119}$/u.test(normalized)) return normalized;
  }
  return "personal_agent_chat_dispatch_failed";
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface PersonalAgentChatDispatcher {
  start(): void;
  processOnce(): Promise<void>;
  stop(): Promise<void>;
}

export const createPersonalAgentChatDispatcher = (options: {
  authority: PersonalAgentChatRunnerAuthority;
  processManagedCommands: () => Promise<unknown>;
  ownerUserId: string;
  targetDeviceId: string;
  targetDeploymentId: string;
  runnerId: string;
  logger: Logger;
  pollIntervalMs?: number;
  claimLeaseMs?: number;
  claimRenewIntervalMs?: number;
  terminalPollIntervalMs?: number;
}): PersonalAgentChatDispatcher => {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const claimLeaseMs = options.claimLeaseMs ?? 120_000;
  const claimRenewIntervalMs =
    options.claimRenewIntervalMs ??
    Math.max(5_000, Math.floor(claimLeaseMs / 3));
  const terminalPollIntervalMs = options.terminalPollIntervalMs ?? 1_000;
  let stopped = false;
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const report = (name: string, error: unknown): void => {
    options.logger.warn(
      {
        event: { name, category: "personal_agent_chat" },
        error_name:
          error instanceof Error ? error.name : "PersonalAgentChatRunnerError"
      },
      "Personal Agent chat delivery processing deferred"
    );
  };

  const processClaim = async (
    delivery: ClaimedPersonalAgentChatDelivery
  ): Promise<void> => {
    const reconciliationOnly =
      "reconciliationOnly" in delivery && delivery.reconciliationOnly === true;
    let claimLost = false;
    let renewing = false;
    const claimRenewal = setInterval(() => {
      if (renewing || stopped || claimLost) return;
      renewing = true;
      void options.authority
        .renewDeliveryClaim({
          ownerUserId: delivery.ownerUserId,
          deliveryId: delivery.deliveryId,
          claimToken: delivery.claimToken,
          leaseMs: claimLeaseMs
        })
        .then((renewed) => {
          if (!renewed) claimLost = true;
        })
        .catch((error: unknown) => {
          claimLost = true;
          report("worker.personal_agent_chat.claim_renewal_failed", error);
        })
        .finally(() => {
          renewing = false;
        });
    }, claimRenewIntervalMs);
    claimRenewal.unref?.();

    const stillOwned = async (): Promise<boolean> => {
      if (stopped || claimLost) return false;
      try {
        const renewed = await options.authority.renewDeliveryClaim({
          ownerUserId: delivery.ownerUserId,
          deliveryId: delivery.deliveryId,
          claimToken: delivery.claimToken,
          leaseMs: claimLeaseMs
        });
        if (!renewed) claimLost = true;
        return renewed;
      } catch (error) {
        report("worker.personal_agent_chat.claim_renewal_failed", error);
        // Do not authorize a new child or settlement when the root fence could
        // not be checked. The durable row remains available for reconciliation
        // after this claim expires.
        claimLost = true;
        return false;
      }
    };

    const readResult = async (): Promise<PersonalAgentChatChildResult | null> =>
      options.authority.getChildResult({
        actor: { userId: delivery.ownerUserId },
        conversationId: delivery.conversationId,
        deliveryId: delivery.deliveryId,
        claimToken: delivery.claimToken,
        targetDeviceId: delivery.targetDeviceId,
        targetDeploymentId: delivery.targetDeploymentId
      });

    let nativeProcessing: Promise<void> | null = null;
    const kickNativeProcessing = (): void => {
      if (stopped || nativeProcessing) return;
      const current = options
        .processManagedCommands()
        .then(() => undefined)
        .catch((error: unknown) =>
          report("worker.personal_agent_chat.native_processing_failed", error)
        )
        .finally(() => {
          if (nativeProcessing === current) nativeProcessing = null;
        });
      nativeProcessing = current;
    };

    const settleFailure = async (
      certainty: "confirmed_failure" | "indeterminate",
      code: string
    ): Promise<void> => {
      while (await stillOwned()) {
        try {
          const settled = await options.authority.failDelivery({
            ownerUserId: delivery.ownerUserId,
            deliveryId: delivery.deliveryId,
            claimToken: delivery.claimToken,
            certainty,
            errorCode: code
          });
          if (settled) return;
          return;
        } catch (error) {
          report("worker.personal_agent_chat.failure_settlement_failed", error);
          if (stopped) return;
          await sleep(terminalPollIntervalMs);
        }
      }
    };

    const settleCancellation = async (): Promise<void> => {
      const requestId = stableUuid("cancel", delivery.deliveryId);
      while (await stillOwned()) {
        try {
          await options.authority.cancelBatch({
            deliveryId: delivery.deliveryId,
            conversationId: delivery.conversationId,
            messageId: delivery.messageId,
            claimToken: delivery.claimToken,
            requestId
          });
          return;
        } catch (error) {
          report("worker.personal_agent_chat.cancel_settlement_failed", error);
          if (!(await stillOwned())) return;
          await sleep(terminalPollIntervalMs);
        }
      }
    };

    const settleCompletion = async (
      result: PersonalAgentChatChildResult
    ): Promise<void> => {
      if (
        result.status !== "completed" ||
        !result.executionId ||
        !result.promptCommandId ||
        !result.assistantOutput
      ) {
        await settleFailure(
          "indeterminate",
          "personal_agent_chat_public_output_missing"
        );
        return;
      }
      while (await stillOwned()) {
        try {
          const completed = await options.authority.completeDelivery({
            ownerUserId: delivery.ownerUserId,
            deliveryId: delivery.deliveryId,
            claimToken: delivery.claimToken,
            executionId: result.executionId,
            commandId: result.promptCommandId,
            jobId: result.jobId,
            reply: result.assistantOutput.text,
            truncated: result.assistantOutput.truncated,
            contextTransfer: delivery.contextTransfer
          });
          if (completed) return;
          return;
        } catch (error) {
          report(
            "worker.personal_agent_chat.completion_settlement_failed",
            error
          );
          if (stopped) return;
          await sleep(terminalPollIntervalMs);
        }
      }
    };

    try {
      let expectedExecutionId = delivery.executionId;
      let expectedCommandId = delivery.commandId;
      const hasExecution = Boolean(delivery.executionId);
      const hasCommand = Boolean(delivery.commandId);
      if (hasExecution !== hasCommand) {
        await settleFailure(
          "indeterminate",
          "personal_agent_chat_partial_child_link"
        );
        return;
      }

      if (!hasExecution && !reconciliationOnly) {
        let attempt = 0;
        while (await stillOwned()) {
          try {
            const beforePrepare = await readResult();
            if (beforePrepare?.cancelRequested) {
              if (
                beforePrepare.terminal &&
                beforePrepare.status === "stopped"
              ) {
                await settleCancellation();
                return;
              }
              await sleep(terminalPollIntervalMs);
              continue;
            }
            const contexts = recipientContexts(delivery);
            const launch = delivery.launch;
            const prepared = await options.authority.prepareChild({
              actor: { userId: delivery.ownerUserId },
              conversationId: delivery.conversationId,
              deliveryId: delivery.deliveryId,
              claimToken: delivery.claimToken,
              targetDeviceId: delivery.targetDeviceId,
              targetDeploymentId: delivery.targetDeploymentId,
              provider: launch.provider,
              aiClientInstanceId: launch.aiClientInstanceId,
              model: launch.model,
              reasoningEffort: launch.reasoningEffort,
              permissionMode: launch.permissionMode,
              prompt: delivery.prompt,
              contextText: delivery.conversationContextText,
              contextTransfer: delivery.contextTransfer,
              clientUserMessageId: delivery.messageId,
              selectedResourceIds: launch.selectedResourceIds,
              ...(launch.selectedResourceHostedInstanceId
                ? {
                    selectedResourceHostedInstanceId:
                      launch.selectedResourceHostedInstanceId
                  }
                : {}),
              ...(launch.kind === "agent"
                ? {
                    agentId: launch.agentId,
                    agentVersion: launch.agentVersion
                  }
                : {}),
              ...(contexts.agentContext !== undefined
                ? { personalAgentContext: contexts.agentContext }
                : {}),
              idempotencyKey: `personal-agent-chat-delivery:${delivery.deliveryId}`
            });
            expectedExecutionId = prepared.execution.id;
            expectedCommandId = prepared.command.id;
            break;
          } catch (error) {
            let existing: PersonalAgentChatChildResult | null = null;
            try {
              existing = await readResult();
            } catch (readError) {
              report(
                "worker.personal_agent_chat.result_read_failed",
                readError
              );
            }
            if (existing?.cancelRequested) {
              if (existing.terminal && existing.status === "stopped") {
                await settleCancellation();
                return;
              }
              if (!(await stillOwned())) return;
              await sleep(terminalPollIntervalMs);
              continue;
            }
            if (
              existing?.executionId &&
              (existing.startCommandId || existing.promptCommandId)
            ) {
              expectedExecutionId = existing.executionId;
              expectedCommandId =
                existing.startCommandId ?? existing.promptCommandId;
              break;
            }
            if (!transientFailure(error)) {
              await settleFailure("confirmed_failure", errorCode(error));
              return;
            }
            report("worker.personal_agent_chat.child_prepare_failed", error);
            if (!(await stillOwned())) return;
            const delay = Math.min(
              terminalPollIntervalMs * 2 ** attempt,
              10_000
            );
            attempt = Math.min(attempt + 1, 5);
            await sleep(delay);
          }
        }
      }

      if (stopped || claimLost) return;
      if (!reconciliationOnly) kickNativeProcessing();
      let cancellationAttemptedFor: string | null = null;
      while (!stopped && !claimLost) {
        let result: PersonalAgentChatChildResult | null;
        try {
          result = await readResult();
        } catch (error) {
          report("worker.personal_agent_chat.result_read_failed", error);
          await sleep(terminalPollIntervalMs);
          continue;
        }
        if (!result) {
          await sleep(terminalPollIntervalMs);
          continue;
        }
        if (
          (expectedExecutionId !== null &&
            result.executionId !== expectedExecutionId) ||
          (expectedCommandId !== null &&
            result.startCommandId !== expectedCommandId &&
            result.promptCommandId !== expectedCommandId)
        ) {
          await settleFailure(
            "indeterminate",
            "personal_agent_chat_child_identity_mismatch"
          );
          return;
        }
        if (result.terminal) {
          if (result.status === "completed") {
            await settleCompletion(result);
          } else if (result.status === "confirmed_failure") {
            await settleFailure(
              "confirmed_failure",
              result.errorCode ?? "personal_agent_chat_child_failed"
            );
          } else if (result.status === "indeterminate") {
            await settleFailure(
              "indeterminate",
              result.errorCode ?? "personal_agent_chat_child_indeterminate"
            );
          } else if (result.status === "stopped" && result.cancelRequested) {
            await settleCancellation();
          } else if (result.status === "stopped") {
            await settleFailure(
              "confirmed_failure",
              result.errorCode ?? "personal_agent_chat_child_stopped"
            );
          }
          return;
        }

        if (result.cancelRequested && result.executionId) {
          const commandId = result.promptCommandId ?? result.startCommandId;
          const cancellationKey = `${result.executionId}:${commandId ?? "pending"}`;
          if (
            commandId &&
            result.executionGeneration !== null &&
            cancellationAttemptedFor !== cancellationKey
          ) {
            try {
              await options.authority.cancelChild({
                deliveryId: delivery.deliveryId,
                conversationId: delivery.conversationId,
                claimToken: delivery.claimToken,
                executionId: result.executionId,
                promptCommandId: result.promptCommandId,
                ...(result.promptCommandId === null
                  ? { startCommandId: result.startCommandId ?? undefined }
                  : {}),
                executionGeneration: result.executionGeneration
              });
              cancellationAttemptedFor = cancellationKey;
            } catch (error) {
              report("worker.personal_agent_chat.child_cancel_failed", error);
              if (!(await stillOwned())) return;
            }
          }
        }

        if (!reconciliationOnly || result.checkpointPending) {
          kickNativeProcessing();
        }
        await sleep(terminalPollIntervalMs);
      }
    } catch (error) {
      report("worker.personal_agent_chat.delivery_failed", error);
      if (!transientFailure(error)) {
        await settleFailure("confirmed_failure", errorCode(error));
      }
    } finally {
      clearInterval(claimRenewal);
    }
  };

  const processOnce = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      await running;
      return;
    }
    const current = (async () => {
      let delivery: ClaimedPersonalAgentChatDelivery | null;
      try {
        delivery = await options.authority.claimDelivery({
          ownerUserId: options.ownerUserId,
          targetDeviceId: options.targetDeviceId,
          targetDeploymentId: options.targetDeploymentId,
          runnerId: options.runnerId,
          leaseMs: claimLeaseMs
        });
      } catch (error) {
        report("worker.personal_agent_chat.delivery_claim_failed", error);
        return;
      }
      if (!delivery || stopped) return;
      await processClaim(delivery);
    })();
    running = current;
    try {
      await current;
    } finally {
      if (running === current) running = null;
    }
  };

  return {
    processOnce,
    start() {
      if (stopped || timer) return;
      void processOnce();
      timer = setInterval(() => void processOnce(), pollIntervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      // Do not wait for a native provider call. The Managed Conversation
      // service owns its shutdown and the delivery lease will expire for
      // read-only reconciliation after the runner retires.
      return Promise.resolve();
    }
  };
};
