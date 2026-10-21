import type { MemorySourceRepository } from "@koed/db";
import {
  readDesktopLocalCredentialAuthorization,
  scheduledJobLocalApiUrl,
  scheduledJobRuntimeAuthoritySchema,
  scheduledJobRuntimeLeaseRequestSchema,
  scheduledJobRuntimeLeaseResultSchema
} from "@koed/shared";

type Input = {
  repository: MemorySourceRepository;
  ownerUserId: string;
  apiUrl: string;
  koedHome: string;
  fetch?: typeof fetch;
};

/** Local worker direct-DB claims must pass the same trusted API gate as HTTP runners. */
export function guardLocalScheduledJobRepository({
  repository,
  ownerUserId,
  apiUrl,
  koedHome,
  fetch: send = fetch
}: Input): MemorySourceRepository {
  const credential = () => {
    const current = readDesktopLocalCredentialAuthorization(koedHome);
    if (
      current?.ownerUserId !== ownerUserId ||
      !current.operationFamilies.includes("managed_execution") ||
      !current.operationFamilies.includes("personal_collaboration_write")
    )
      throw new Error("ScheduledJobRuntimeCredentialUnavailable");
    return current.authorization;
  };
  const check = async (kind: "commands" | "executions", id: string) => {
    const endpoint = new URL(
      `v1/scheduled-jobs/runtime/${kind}/${encodeURIComponent(id)}/authority`,
      scheduledJobLocalApiUrl(apiUrl).href.replace(/\/+$/, "/")
    );
    const response = await send(endpoint, {
      method: "GET",
      redirect: "error",
      headers: { authorization: credential(), accept: "application/json" },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok)
      throw new Error("ScheduledJobRuntimeAuthorityUnavailable");
    if (
      !scheduledJobRuntimeAuthoritySchema.parse(await response.json()).scheduled
    )
      throw new Error("ScheduledJobRuntimeAuthorityUnavailable");
  };
  const actor = { userId: ownerUserId };
  const checkCommand = async (id: string) => {
    if (await repository.hasScheduledJobDispatchForCommand(actor, id))
      await check("commands", id);
  };
  const checkExecution = async (id: string) => {
    if (await repository.hasActiveScheduledJobDispatchForExecution(actor, id))
      await check("executions", id);
  };
  const recordLease = async (
    commandId: string,
    leaseToken: string,
    runnerId: string
  ) => {
    if (!(await repository.hasScheduledJobDispatchForCommand(actor, commandId)))
      return;
    const endpoint = new URL(
      `v1/scheduled-jobs/runtime/commands/${encodeURIComponent(commandId)}/lease`,
      scheduledJobLocalApiUrl(apiUrl).href.replace(/\/+$/, "/")
    );
    const response = await send(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: credential(),
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(
        scheduledJobRuntimeLeaseRequestSchema.parse({ leaseToken, runnerId })
      ),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error("ScheduledJobLeaseUnavailable");
    scheduledJobRuntimeLeaseResultSchema.parse(await response.json());
  };
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "claimManagedConversationCommands")
        return async (
          input: Parameters<
            MemorySourceRepository["claimManagedConversationCommands"]
          >[0]
        ) => {
          const allowedScheduledCommandIds: string[] = [];
          for (const id of await target.listQueuedScheduledJobCommands(actor, {
            deviceId: input.deviceId,
            deploymentId: input.deploymentId,
            limit: 100
          })) {
            try {
              await check("commands", id);
              allowedScheduledCommandIds.push(id);
            } catch {
              // The SQL allowlist below keeps this command queued. No lease or
              // AI Client launch is created from unavailable authority.
            }
          }
          const claims = await target.claimManagedConversationCommands({
            ...input,
            allowedScheduledCommandIds
          });
          const allowed: typeof claims = [];
          for (const command of claims) {
            try {
              await checkCommand(command.id);
              if (command.leaseToken)
                await recordLease(
                  command.id,
                  command.leaseToken,
                  input.runnerId
                );
              allowed.push(command);
            } catch {
              if (command.leaseToken)
                await target.failManagedConversationCommand({
                  commandId: command.id,
                  leaseToken: command.leaseToken,
                  state: "failed",
                  errorCode: "ScheduledJobAuthorityUnavailable"
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
          await checkCommand(input.commandId);
          const renewed =
            await target.renewManagedConversationCommandLease(input);
          if (renewed)
            await recordLease(
              input.commandId,
              input.leaseToken,
              input.runnerId
            );
          return renewed;
        };
      if (property === "renewManagedConversationExecutionLease")
        return async (
          input: Parameters<
            MemorySourceRepository["renewManagedConversationExecutionLease"]
          >[0]
        ) => {
          await checkExecution(input.executionId);
          return target.renewManagedConversationExecutionLease(input);
        };
      if (property === "acquireManagedConversationExecutionLease")
        return async (
          input: Parameters<
            MemorySourceRepository["acquireManagedConversationExecutionLease"]
          >[0]
        ) => {
          await checkExecution(input.executionId);
          return target.acquireManagedConversationExecutionLease(input);
        };
      if (property === "completeManagedConversationCommand")
        return async (
          input: Parameters<
            MemorySourceRepository["completeManagedConversationCommand"]
          >[0]
        ) => {
          await checkCommand(input.commandId);
          return target.completeManagedConversationCommand(input);
        };
      if (property === "failManagedConversationCommand")
        return async (
          input: Parameters<
            MemorySourceRepository["failManagedConversationCommand"]
          >[0]
        ) => {
          await checkCommand(input.commandId);
          return target.failManagedConversationCommand(input);
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
          if (execution) await checkExecution(execution.id);
          return execution;
        };
      if (property === "getManagedConversationCommand")
        return async (
          ...args: Parameters<
            MemorySourceRepository["getManagedConversationCommand"]
          >
        ) => {
          const command = await target.getManagedConversationCommand(...args);
          if (command) await checkCommand(command.id);
          return command;
        };
      if (property === "getLatestManagedConversationCommandForExecution")
        return async (
          ...args: Parameters<
            MemorySourceRepository["getLatestManagedConversationCommandForExecution"]
          >
        ) => {
          await checkExecution(args[1]);
          return target.getLatestManagedConversationCommandForExecution(
            ...args
          );
        };
      if (property === "putManagedConversationRuntimeItem")
        return async (
          ...args: Parameters<
            MemorySourceRepository["putManagedConversationRuntimeItem"]
          >
        ) => {
          await checkExecution(args[1].executionId);
          return target.putManagedConversationRuntimeItem(...args);
        };
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function"
        ? (...args: unknown[]): unknown =>
            Reflect.apply(value, target, args) as unknown
        : value;
    }
  });
}
