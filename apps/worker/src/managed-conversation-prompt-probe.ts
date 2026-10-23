/** Test-only driver for the real managed command-to-provider prompt boundary. */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ClaimedManagedConversationCommand,
  ManagedConversationExecutionCheckpointRecord,
  ManagedConversationRuntimeBindingRecord,
  MemorySourceRepository
} from "@koed/db";
import type { CodexManagedConversationSession } from "@koed/mcp-server";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import type { GitExecutionCheckoutDriver } from "@koed/shared/execution-checkout";
import { createManagedConversationService } from "./managed-conversation-service.js";

const probeStop = "ManagedConversationPromptProbeStop";

export async function probeManagedConversationProviderPrompt(input: {
  command: ClaimedManagedConversationCommand;
  binding: ManagedConversationRuntimeBindingRecord;
  baseline: ManagedConversationExecutionCheckpointRecord;
  teamMessageTexts: readonly string[];
  koedHome: string;
}): Promise<{ prompt: string; teamMessageTexts: readonly string[] }> {
  if (input.teamMessageTexts.length === 0)
    throw new Error("ManagedConversationPromptProbeRequiresTeamMessageError");
  const captured: string[] = [];
  const failures: string[] = [];
  let teamMessageReads = 0;
  // The real owner resolver needs an installed instance. The probe intercepts
  // provider dispatch, so use a known executable without relying on host Codex.
  const registryPath = resolve(input.koedHome, "ai-client-instances.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      instances: [
        {
          instanceId: input.command.execution.aiClientInstanceId,
          driverId: "codex",
          displayName: "Prompt probe Codex",
          executablePath: process.execPath,
          configHome: input.koedHome
        }
      ]
    })
  );
  const repository = {
    // Team Chat is human collaboration data. If command execution ever grows
    // a Team read, this probe must fail at the owning repository boundary.
    listTeamMessagesV2: () => {
      teamMessageReads += 1;
      return Promise.reject(
        new Error("ManagedConversationPromptProbeTeamReadError")
      );
    },
    listManagedConversationExecutionCheckoutCleanupRequests: () =>
      Promise.resolve([]),
    listPendingManagedConversationRuntimeBindings: () => Promise.resolve([]),
    reconcileAbandonedManagedConversationCommands: () => Promise.resolve(0),
    claimManagedConversationCommands: () => Promise.resolve([input.command]),
    getManagedConversationExecution: () =>
      Promise.resolve(input.command.execution),
    getManagedConversationRuntimeBinding: () => Promise.resolve(input.binding),
    listManagedConversationExecutionCheckpoints: () =>
      Promise.resolve([input.baseline]),
    listManagedMergeDecisionContext: () => Promise.resolve([]),
    cancelManagedConversationRuntimeItems: () => Promise.resolve(0),
    renewManagedConversationCommandLease: () => Promise.resolve(true),
    failManagedConversationCommand: (failure: { errorCode: string }) => {
      failures.push(failure.errorCode);
      return Promise.resolve({
        updated: true,
        reconciled: false,
        requeued: false
      });
    },
    setManagedConversationExecutionState: () =>
      Promise.resolve(input.command.execution)
  } as unknown as MemorySourceRepository;
  const previousRegistry = process.env.KOED_AI_CLIENT_INSTANCE_REGISTRY;
  process.env.KOED_AI_CLIENT_INSTANCE_REGISTRY = registryPath;
  try {
    const service = createManagedConversationService({
      repository,
      apiUrl: "http://127.0.0.1:1",
      apiToken: "test-only-prompt-probe",
      localOwnerUserId: input.command.ownerUserId,
      appServerBinary: "test-only-prompt-probe",
      deviceId: input.command.execution.runnerDeviceId ?? randomUUID(),
      deploymentId: input.command.execution.runnerDeploymentId ?? randomUUID(),
      koedHome: input.koedHome,
      envelopeEncryptionProvider: {} as EnvelopeEncryptionProvider,
      executionCheckoutDriver: {
        verify: () => Promise.resolve(input.binding)
      } as unknown as GitExecutionCheckoutDriver,
      codexSessionFactory: () =>
        ({
          runTurn: (prompt: string) => {
            captured.push(prompt);
            return Promise.reject(
              Object.assign(new Error(probeStop), { name: probeStop })
            );
          },
          closeAndWait: () => Promise.resolve(undefined)
        }) as unknown as CodexManagedConversationSession,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      } as never
    });
    try {
      await service.processOnce();
    } finally {
      await service.stop();
    }
  } finally {
    if (previousRegistry === undefined)
      delete process.env.KOED_AI_CLIENT_INSTANCE_REGISTRY;
    else process.env.KOED_AI_CLIENT_INSTANCE_REGISTRY = previousRegistry;
  }
  if (captured.length !== 1)
    throw new Error(
      `ManagedConversationPromptProbeDispatchCount:${captured.length}:${failures.join(",")}`
    );
  if (teamMessageReads !== 0)
    throw new Error("ManagedConversationPromptProbeReadTeamMessageError");
  const prompt = captured[0]!;
  if (input.teamMessageTexts.some((text) => prompt.includes(text)))
    throw new Error("ManagedConversationPromptProbeLeakedTeamMessageError");
  return { prompt, teamMessageTexts: input.teamMessageTexts };
}
