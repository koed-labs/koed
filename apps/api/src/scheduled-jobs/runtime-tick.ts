import { randomBytes, randomUUID } from "node:crypto";
import {
  bindScheduledJobManagedPromptWithClient,
  ScheduledJobConflict,
  ScheduledJobAuthorityUnavailable,
  type AgentsRepository,
  type MemorySourceRepository,
  type ScheduledJobRepository,
  type ScheduledJobTeamAuthority
} from "@koed/db";
import { nextScheduledJobOccurrence } from "@koed/shared";

type Dependencies = {
  jobs: ScheduledJobRepository;
  managed: Pick<
    MemorySourceRepository,
    | "getManagedConversationExecutionForSession"
    | "getManagedConversationRuntimeBinding"
    | "enqueueManagedConversationPrompt"
  >;
  agents: AgentsRepository;
  teamAuthority: ScheduledJobTeamAuthority;
};
type Runner = { ownerUserId: string; deviceId: string; deploymentId: string };

/** A tick is device-scoped. It does no provider work: the supervised worker owns AI Client execution. */
export async function tickScheduledJobs(
  deps: Dependencies,
  runner: Runner,
  now = new Date()
) {
  const actor = { userId: runner.ownerUserId };
  let materialized = 0;
  let dispatched = 0;
  let needsReview = 0;
  let reconciled = 0;
  for (const commandId of await deps.jobs.listExpiredManagedCommands(
    runner.ownerUserId,
    runner.deviceId,
    100
  )) {
    try {
      if (
        await deps.jobs.interruptExpiredManagedCommand(
          runner.ownerUserId,
          commandId,
          runner.deviceId
        )
      )
        needsReview++;
    } catch (error) {
      if (
        !(error instanceof ScheduledJobConflict) &&
        !(error instanceof ScheduledJobAuthorityUnavailable)
      )
        throw error;
    }
  }
  for (const commandId of await deps.jobs.listActiveManagedCommands(
    runner.ownerUserId,
    runner.deviceId,
    100
  )) {
    try {
      await deps.jobs.assertManagedCommandAuthority(
        runner.ownerUserId,
        commandId,
        runner.deviceId,
        ["queued", "dispatching"]
      );
    } catch (error) {
      if (
        error instanceof ScheduledJobConflict ||
        error instanceof ScheduledJobAuthorityUnavailable
      ) {
        // A queued command with valid authority has no approval state yet.
        // A changed binding or unavailable Team proof is terminal for this
        // attempt, and never a license to launch after access is restored.
        try {
          await deps.jobs.interruptScheduledAuthorityLoss(
            runner.ownerUserId,
            commandId,
            runner.deviceId,
            error instanceof ScheduledJobAuthorityUnavailable
              ? "unavailable"
              : "changed"
          );
        } catch (interruptionError) {
          if (!(interruptionError instanceof ScheduledJobConflict))
            throw interruptionError;
        }
        continue;
      }
      throw error;
    }
    try {
      await deps.jobs.syncManagedApprovalWait(
        runner.ownerUserId,
        commandId,
        runner.deviceId
      );
    } catch (error) {
      if (
        !(error instanceof ScheduledJobConflict) &&
        !(error instanceof ScheduledJobAuthorityUnavailable)
      )
        throw error;
    }
  }
  for (const commandId of await deps.jobs.listTerminalManagedCommands(
    runner.ownerUserId,
    runner.deviceId,
    100
  )) {
    try {
      if (
        await deps.jobs.interruptScheduledAuthorityLoss(
          runner.ownerUserId,
          commandId,
          runner.deviceId,
          "unavailable"
        )
      ) {
        needsReview++;
        continue;
      }
      if (
        await deps.jobs.reconcileManagedCommandOutcome(
          runner.ownerUserId,
          commandId,
          runner.deviceId
        )
      )
        reconciled++;
    } catch (error) {
      if (
        !(error instanceof ScheduledJobConflict) &&
        !(error instanceof ScheduledJobAuthorityUnavailable)
      )
        throw error;
    }
  }
  for (const commandId of await deps.jobs.listInterruptedManagedCommandsAwaitingProviderAck(
    runner.ownerUserId,
    runner.deviceId,
    100
  )) {
    await deps.jobs.releaseInterruptedManagedCommandAfterProviderAck(
      runner.ownerUserId,
      commandId,
      runner.deviceId
    );
  }
  let cursor: string | null = null;
  // Keyset pages prevent a large owner catalogue from starving later Jobs.
  for (let page = 0; page < 100; page++) {
    const candidates = await deps.jobs.listRuntimeCandidates(
      runner.ownerUserId,
      runner.deviceId,
      cursor,
      100
    );
    for (const { job, lastScheduledFor } of candidates) {
      cursor = job.id;
      if (job.paused) continue;
      let after = new Date(lastScheduledFor ?? job.createdAt);
      // Drain bounded missed history in the same tick. The current occurrence
      // must not wait for one 30-second tick per day the device was offline.
      for (let occurrence = 0; occurrence < 2048; occurrence++) {
        const due = nextScheduledJobOccurrence(job.schedule, after);
        if (due > now) break;
        try {
          const result = await deps.jobs.materializeScheduledOccurrence(
            runner.ownerUserId,
            job.id,
            due,
            job.version
          );
          if (result.created) materialized++;
          after = due;
          if (result.run.status === "scheduled") break;
        } catch (error) {
          if (
            !(error instanceof ScheduledJobConflict) &&
            !(error instanceof ScheduledJobAuthorityUnavailable)
          )
            throw error;
          // A concurrent tick, lifecycle change, or offline Team authority is
          // never a reason to bypass the current authoritative check.
          break;
        }
      }
    }
    if (candidates.length < 100) break;
  }
  const pending = await deps.jobs.listPendingRuntimeRuns(
    runner.ownerUserId,
    runner.deviceId,
    100
  );
  const enabledInstances = new Set(
    (
      await deps.agents.bootstrapContext(runner.ownerUserId)
    ).enabledInstances.map((instance) => instance.instanceId)
  );
  for (const candidate of pending) {
    const { run } = candidate;
    const job = await deps.jobs.get(runner.ownerUserId, run.jobId);
    if (
      job.version !== candidate.jobVersion ||
      job.runnerDeviceId !== runner.deviceId
    )
      continue;
    try {
      const settled = await deps.jobs.settleUnlaunchableRun(
        runner.ownerUserId,
        job.id,
        run.id,
        job.version,
        runner.deviceId
      );
      if (settled) continue;
    } catch (error) {
      if (
        error instanceof ScheduledJobConflict ||
        error instanceof ScheduledJobAuthorityUnavailable
      )
        continue;
      throw error;
    }
    const agent = (await deps.agents.list(runner.ownerUserId)).find(
      (value) => value.id === job.agentId
    );
    const execution =
      await deps.managed.getManagedConversationExecutionForSession(
        actor,
        job.conversationSessionId
      );
    const binding = execution
      ? await deps.managed.getManagedConversationRuntimeBinding(
          actor,
          execution.id
        )
      : null;
    const eligible = Boolean(
      agent &&
      enabledInstances.has(agent.aiClientInstanceId) &&
      execution &&
      binding &&
      execution.state === "running" &&
      execution.runnerDeploymentId === runner.deploymentId &&
      execution.runnerDeviceId === runner.deviceId &&
      binding.deploymentId === runner.deploymentId &&
      binding.deviceId === runner.deviceId &&
      binding.executionGeneration === execution.executionGeneration &&
      execution.aiClientInstanceId === agent.aiClientInstanceId &&
      (!job.projectId || execution.projectId === job.projectId)
    );
    if (!eligible || !execution || !agent) {
      // An arbitrary captured Conversation is not an attested, resumable
      // Managed execution. Record a visible no-effect failure for review.
      try {
        const fenceToken = randomBytes(32).toString("base64url");
        const failed = await deps.jobs.failUnsupportedRuntimeRun(
          runner.ownerUserId,
          job.id,
          run.id,
          {
            expectedJobVersion: job.version,
            runnerDeviceId: runner.deviceId,
            fenceToken
          }
        );
        if (failed.status === "failed") needsReview++;
      } catch (error) {
        if (
          !(error instanceof ScheduledJobConflict) &&
          !(error instanceof ScheduledJobAuthorityUnavailable)
        )
          throw error;
      }
      continue;
    }
    const fenceToken = randomBytes(32).toString("base64url");
    const currentSettings = {
      model: execution.model,
      reasoningEffort: execution.reasoningEffort,
      permissionMode: execution.permissionMode
    };
    const desiredSettings = {
      model: agent.defaultModel ?? execution.model,
      reasoningEffort: execution.reasoningEffort,
      permissionMode: agent.defaultPermissionMode
    };
    let attempt:
      | Extract<
          Awaited<ReturnType<typeof deps.jobs.startAttemptWithClient>>,
          { started: true }
        >
      | undefined;
    try {
      await deps.managed.enqueueManagedConversationPrompt(actor, {
        executionId: execution.id,
        executionGeneration: execution.executionGeneration,
        idempotencyKey: `scheduled-job:${run.id}:${run.attempt + 1}`,
        clientUserMessageId: randomUUID(),
        prompt: job.instruction,
        settingsChange:
          JSON.stringify(currentSettings) === JSON.stringify(desiredSettings)
            ? undefined
            : { expected: currentSettings, next: desiredSettings },
        scheduledDispatch: {
          start: async (client) => {
            const started = await deps.jobs.startAttemptWithClient(
              client,
              runner.ownerUserId,
              job.id,
              run.id,
              {
                expectedJobVersion: job.version,
                runnerDeviceId: runner.deviceId,
                fenceToken
              }
            );
            if (!started.started)
              throw new ScheduledJobConflict(
                "Occurrence was skipped or missed"
              );
            attempt = started;
          },
          bind: async (client, commandId) => {
            if (!attempt)
              throw new ScheduledJobConflict(
                "Scheduled attempt was not started"
              );
            await bindScheduledJobManagedPromptWithClient(client, {
              ownerUserId: runner.ownerUserId,
              attemptId: attempt.attemptId,
              attemptExecutionId: attempt.executionId,
              fenceToken,
              managedExecutionId: execution.id,
              managedCommandId: commandId,
              teamAuthority: deps.teamAuthority
            });
          }
        }
      });
      dispatched++;
    } catch (error) {
      if (
        !(error instanceof ScheduledJobConflict) &&
        !(error instanceof ScheduledJobAuthorityUnavailable) &&
        !(
          error instanceof Error &&
          "statusCode" in error &&
          error.statusCode === 409
        )
      )
        throw error;
      // The transaction rolls back the attempt when prompt enqueue or exact
      // binding fails. The next tick may retry only the still-scheduled run.
    }
  }
  return { materialized, dispatched, needsReview, reconciled };
}
