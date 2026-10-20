import type { MemorySourceRepository } from "@koed/db";
import {
  readDesktopLocalCredentialAuthorization,
  readLocalEdgeClientCredentialAuthorization
} from "@koed/shared";

type GuardOptions = {
  repository: MemorySourceRepository;
  ownerUserId: string;
  apiUrl: string;
  koedHome: string;
  fetch?: typeof fetch;
  resolveDesktopCredential?: typeof readDesktopLocalCredentialAuthorization;
  resolveTeamCredential?: typeof readLocalEdgeClientCredentialAuthorization;
};

/** The embedded runner bypasses the HTTP runner routes. Fence that path here. */
export const guardLocalSharedWorkItemRepository = ({
  repository,
  ownerUserId,
  apiUrl,
  koedHome,
  fetch: send = fetch,
  resolveDesktopCredential = readDesktopLocalCredentialAuthorization,
  resolveTeamCredential = readLocalEdgeClientCredentialAuthorization
}: GuardOptions): MemorySourceRepository => {
  const actor = { userId: ownerUserId };
  const pendingProgress = new Map<string, string>();
  const deniedProgress = new Set<string>();
  let progressCursor: string | undefined;
  let nextDurableProgressScanAt = 0;
  const check = async (executionId: string): Promise<void> => {
    const dispatch = await repository.getSharedWorkItemDispatchForExecution(
      actor,
      executionId
    );
    if (!dispatch) return;
    const credential = resolveDesktopCredential(koedHome);
    if (
      !credential?.operationFamilies.includes("managed_execution") ||
      !credential.operationFamilies.includes("personal_collaboration_write")
    )
      throw new Error("SharedDispatchDesktopCredentialUnavailable");
    const url = new URL(
      `v1/managed-conversations/${encodeURIComponent(executionId)}/shared-dispatch-authority`,
      apiUrl.replace(/\/+$/, "/")
    );
    const response = await send(url, {
      method: "GET",
      redirect: "error",
      headers: {
        authorization: credential.authorization,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error("SharedDispatchAuthorityUnavailable");
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      (body as { allowed?: unknown }).allowed !== true
    )
      throw new Error("SharedDispatchAuthorityUnavailable");
  };
  const checkCommand = async (commandId: string): Promise<void> => {
    const command = await repository.getManagedConversationCommand(
      actor,
      commandId
    );
    if (!command) throw new Error("SharedDispatchCommandUnavailable");
    await check(command.executionId);
  };
  const publish = async (
    executionId: string,
    commandId: string
  ): Promise<void> => {
    const dispatch = await repository.getSharedWorkItemDispatchForExecution(
      actor,
      executionId
    );
    if (!dispatch) return;
    const desktop = resolveDesktopCredential(koedHome);
    const team = resolveTeamCredential(koedHome, dispatch.teamBackendId);
    if (
      !desktop?.operationFamilies.includes("managed_execution") ||
      !desktop.operationFamilies.includes("personal_collaboration_write") ||
      !team?.operationFamilies.includes("team_workspace_write")
    )
      throw new Error("SharedDispatchProgressCredentialUnavailable");
    const url = new URL(
      `v1/managed-conversations/${encodeURIComponent(executionId)}/shared-progress`,
      apiUrl.replace(/\/+$/, "/")
    );
    const response = await send(url, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: desktop.authorization,
        "x-koed-team-client-credential": team.authorization,
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ commandId }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok)
      throw new Error(
        [403, 404, 409].includes(response.status)
          ? "SharedDispatchProgressDenied"
          : "SharedDispatchProgressUnavailable"
      );
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      (body as { published?: unknown }).published !== true
    )
      throw new Error("SharedDispatchProgressUnavailable");
  };
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "claimManagedConversationCommands")
        return async (
          input: Parameters<
            MemorySourceRepository["claimManagedConversationCommands"]
          >[0]
        ) => {
          if (Date.now() >= nextDurableProgressScanAt) {
            nextDurableProgressScanAt = Date.now() + 30_000;
            try {
              const candidates =
                await target.listSharedDispatchProgressCandidates(actor, {
                  deploymentId: input.deploymentId,
                  deviceId: input.deviceId,
                  ...(progressCursor
                    ? { afterExecutionId: progressCursor }
                    : {}),
                  limit: 25
                });
              for (const candidate of candidates) {
                if (deniedProgress.has(candidate.executionId)) continue;
                try {
                  await publish(candidate.executionId, candidate.commandId);
                } catch (error) {
                  if (
                    error instanceof Error &&
                    error.message === "SharedDispatchProgressDenied"
                  )
                    deniedProgress.add(candidate.executionId);
                  // Revoked, stale, or offline Team state never replays work.
                }
              }
              progressCursor =
                candidates.length === 25
                  ? candidates.at(-1)!.executionId
                  : undefined;
            } catch {
              // Personal-only commands remain independent of Team recovery.
            }
          }
          for (const [executionId, commandId] of pendingProgress) {
            if (deniedProgress.has(executionId)) {
              pendingProgress.delete(executionId);
              continue;
            }
            try {
              await publish(executionId, commandId);
              pendingProgress.delete(executionId);
            } catch (error) {
              if (
                error instanceof Error &&
                error.message === "SharedDispatchProgressDenied"
              ) {
                deniedProgress.add(executionId);
                pendingProgress.delete(executionId);
              }
              // The private command remains durable; try again on the next poll.
            }
          }
          const claims = await target.claimManagedConversationCommands(input);
          const allowed: typeof claims = [];
          for (const command of claims) {
            try {
              await check(command.executionId);
              await publish(command.executionId, command.id);
              allowed.push(command);
            } catch {
              if (command.leaseToken)
                await target.failManagedConversationCommand({
                  commandId: command.id,
                  leaseToken: command.leaseToken,
                  state: "failed",
                  errorCode: "SharedDispatchAuthorityUnavailable"
                });
            }
          }
          return allowed;
        };
      if (property === "renewManagedConversationCommandLease")
        return async (
          input: Parameters<
            MemorySourceRepository["renewManagedConversationCommandLease"]
          >[0]
        ) => {
          await check(input.executionId);
          return target.renewManagedConversationCommandLease(input);
        };
      if (property === "renewManagedConversationExecutionLease")
        return async (
          input: Parameters<
            MemorySourceRepository["renewManagedConversationExecutionLease"]
          >[0]
        ) => {
          await check(input.executionId);
          return target.renewManagedConversationExecutionLease(input);
        };
      if (property === "acquireManagedConversationExecutionLease")
        return async (
          input: Parameters<
            MemorySourceRepository["acquireManagedConversationExecutionLease"]
          >[0]
        ) => {
          await check(input.executionId);
          return target.acquireManagedConversationExecutionLease(input);
        };
      if (property === "completeManagedConversationCommand")
        return async (
          input: Parameters<
            MemorySourceRepository["completeManagedConversationCommand"]
          >[0]
        ) => {
          await checkCommand(input.commandId);
          const command = await target.getManagedConversationCommand(
            actor,
            input.commandId
          );
          const result = await target.completeManagedConversationCommand(input);
          if (command) {
            try {
              await publish(command.executionId, command.id);
            } catch {
              pendingProgress.set(command.executionId, command.id);
            }
          }
          return result;
        };
      if (property === "failManagedConversationCommand")
        return async (
          input: Parameters<
            MemorySourceRepository["failManagedConversationCommand"]
          >[0]
        ) => {
          const command = await target.getManagedConversationCommand(
            actor,
            input.commandId
          );
          const result = await target.failManagedConversationCommand(input);
          if (command && input.state !== "queued" && !result.requeued) {
            try {
              await publish(command.executionId, command.id);
            } catch {
              pendingProgress.set(command.executionId, command.id);
            }
          }
          return result;
        };
      if (property === "getManagedConversationExecution")
        return async (
          ...args: Parameters<
            MemorySourceRepository["getManagedConversationExecution"]
          >
        ) => {
          const execution = await target.getManagedConversationExecution(
            ...args
          );
          if (execution) await check(execution.id);
          return execution;
        };
      if (property === "getManagedConversationCommand")
        return async (
          ...args: Parameters<
            MemorySourceRepository["getManagedConversationCommand"]
          >
        ) => {
          const command = await target.getManagedConversationCommand(...args);
          if (command) await check(command.executionId);
          return command;
        };
      if (property === "getLatestManagedConversationCommandForExecution")
        return async (
          ...args: Parameters<
            MemorySourceRepository["getLatestManagedConversationCommandForExecution"]
          >
        ) => {
          await check(args[1]);
          return target.getLatestManagedConversationCommandForExecution(
            ...args
          );
        };
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function"
        ? (...args: unknown[]): unknown =>
            Reflect.apply(value, target, args) as unknown
        : value;
    }
  });
};
