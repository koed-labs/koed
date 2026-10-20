import { z } from "zod";
import type { ManagedConversationRuntimeItemRecord } from "@koed/db";
import { sourceControlResultSchema } from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { workItemReviewRemoteMatches } from "../work-items/pr-reconciliation.js";
import {
  publishSharedWorkItemProgress,
  readSharedDispatchAttemptAuthority
} from "./shared-work-item-dispatch.js";

export const sharedReviewBindingSchema = z
  .object({
    provider: z.string().min(1).max(253),
    number: z.number().int().positive(),
    url: z.url(),
    remoteIdentityHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export const sharedReviewBindingFromItem = (
  item: ManagedConversationRuntimeItemRecord,
  executionGeneration: number
) => {
  if (
    item.executionGeneration !== executionGeneration ||
    item.itemKind !== "transient_output"
  )
    return null;
  const parsed = sharedReviewBindingSchema.safeParse(
    item.payload.sharedReviewBinding
  );
  if (
    !parsed.success ||
    item.providerRequestId !==
      `shared-review-created:${parsed.data.remoteIdentityHash}:${parsed.data.number}`
  )
    return null;
  return parsed.data;
};

export const isTrustedSharedCompletionMarker = (
  item: ManagedConversationRuntimeItemRecord,
  executionGeneration: number,
  commandId: string
): boolean =>
  item.executionGeneration === executionGeneration &&
  item.itemKind === "transient_output" &&
  item.providerRequestId.startsWith(
    `shared-work-item-complete:${commandId}:`
  ) &&
  item.providerRequestId.length <= 512 &&
  Object.keys(item.payload).length === 1 &&
  item.payload.sharedWorkItemCompletion === "accepted";
const conflict = (): never => {
  throw Object.assign(
    new Error("Shared PR binding or Team authority changed"),
    { statusCode: 409 }
  );
};

/** Only provider reads can finish an in-review shared Work Item. */
export async function reconcileSharedWorkItemPr(
  context: ApiRouteContext,
  ownerUserId: string,
  personalProjectId: string,
  teamWorkItemId: string
): Promise<{ state: "open" | "merged" | "closed" }> {
  const repository = context.requireRepository();
  const actor = { userId: ownerUserId };
  const link = await repository.getSharedDispatchLink(
    ownerUserId,
    personalProjectId
  );
  if (!link) return conflict();
  const dispatches = await repository.listSharedWorkItemDispatches(actor, {
    personalProjectId,
    teamBackendId: link.teamBackendId,
    workspaceProjectId: link.workspaceProjectId
  });
  let selected: { executionId: string; dispatchKey: string } | null = null;
  for (const candidate of dispatches.filter(
    (item) => item.teamWorkItemId === teamWorkItemId
  )) {
    const dispatch = await repository.getSharedWorkItemDispatchForExecution(
      actor,
      candidate.executionId
    );
    if (!dispatch) continue;
    const dispatchKey = `shared-work-item:${dispatch.workspaceProjectId}:${teamWorkItemId}:${dispatch.teamWorkItemVersion}`;
    try {
      await readSharedDispatchAttemptAuthority(context, link, {
        itemId: teamWorkItemId,
        dispatchKey
      });
      if (selected) return conflict();
      selected = { executionId: candidate.executionId, dispatchKey };
    } catch {
      // An older private execution is not the current Team attempt.
    }
  }
  if (!selected) return conflict();
  const execution = await repository.getManagedConversationExecution(
    actor,
    selected.executionId
  );
  if (
    !execution ||
    execution.projectId !== personalProjectId ||
    execution.ownerUserId !== ownerUserId
  )
    return conflict();
  const items = await repository.listManagedConversationRuntimeItems(actor, {
    executionId: execution.id,
    includeTerminal: true
  });
  const bindings = items
    .map((item) =>
      sharedReviewBindingFromItem(item, execution.executionGeneration)
    )
    .filter((item) => item !== null);
  const unique = new Map(bindings.map((item) => [JSON.stringify(item), item]));
  if (unique.size !== 1) return conflict();
  const binding = [...unique.values()][0]!;
  const base = {
    contractVersion: 1 as const,
    executionId: execution.id,
    executionGeneration: execution.executionGeneration
  };
  const remotes = sourceControlResultSchema.parse(
    await context.sourceControl.runtime.execute(ownerUserId, {
      ...base,
      kind: "remotes"
    })
  );
  if (remotes.kind !== "remotes") return conflict();
  const matches = remotes.remotes.filter(
    (remote) =>
      remote.remoteIdentityHash === binding.remoteIdentityHash &&
      workItemReviewRemoteMatches(remote, {
        prProvider: binding.provider,
        prNumber: binding.number,
        prUrl: binding.url
      })
  );
  if (matches.length !== 1) return conflict();
  const remote = matches[0]!;
  const request = { ...base, remoteIdentityHash: remote.remoteIdentityHash };
  const read = async () => {
    const result = sourceControlResultSchema.parse(
      await context.sourceControl.runtime.execute(ownerUserId, {
        ...request,
        kind: "review_request",
        number: binding.number
      })
    );
    if (
      result.kind !== "review_request" ||
      result.reviewRequest.number !== binding.number ||
      result.reviewRequest.webUrl !== binding.url
    )
      return conflict();
    return result.reviewRequest;
  };
  const first = await read();
  const checks = sourceControlResultSchema.parse(
    await context.sourceControl.runtime.execute(ownerUserId, {
      ...request,
      kind: "checks",
      objectId: first.headObjectId
    })
  );
  if (checks.kind !== "checks") return conflict();
  const review = await read();
  if (JSON.stringify(review) !== JSON.stringify(first)) return conflict();
  const currentRemotes = sourceControlResultSchema.parse(
    await context.sourceControl.runtime.execute(ownerUserId, {
      ...base,
      kind: "remotes"
    })
  );
  if (
    currentRemotes.kind !== "remotes" ||
    !currentRemotes.remotes.some(
      (item) => JSON.stringify(item) === JSON.stringify(remote)
    )
  )
    return conflict();
  const currentExecution = await repository.getManagedConversationExecution(
    actor,
    execution.id
  );
  if (
    !currentExecution ||
    currentExecution.executionGeneration !== execution.executionGeneration ||
    currentExecution.projectId !== execution.projectId ||
    currentExecution.runnerDeviceId !== execution.runnerDeviceId ||
    currentExecution.runnerDeploymentId !== execution.runnerDeploymentId ||
    currentExecution.logicalSessionId !== execution.logicalSessionId
  )
    return conflict();
  if (review.state === "open") return { state: "open" };
  await publishSharedWorkItemProgress(
    context,
    ownerUserId,
    execution,
    review.state === "merged"
      ? { kind: "review_merged" }
      : { kind: "review_closed" }
  );
  return { state: review.state };
}
