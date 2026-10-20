import { createHmac } from "node:crypto";
import {
  sourceControlV2ResultSchema,
  type SourceControlV2Result
} from "@koed/shared/source-control-v2";

type Prepared = Extract<
  SourceControlV2Result,
  { kind: "review_request_merge_prepared" }
>;
export type SourceControlMergeSelector = {
  executionId: string;
  executionGeneration: number;
  remoteIdentityHash: string;
  reviewRequestNumber: number;
  mergeMethod: "merge" | "squash" | "rebase";
};

/** The renderer never receives the prepared receipt key or approval proof. */
export const reviewAndDispatchSourceControlMerge = async (input: {
  selector: SourceControlMergeSelector;
  access(): Promise<{ authorization: string }>;
  request(
    path: string,
    init: RequestInit,
    maximumResponseBytes: number
  ): Promise<Record<string, unknown>>;
  confirm(prepared: Prepared): Promise<boolean>;
}): Promise<SourceControlV2Result | null> => {
  const initial = await input.access();
  const { selector } = input;
  const path = `/v2/managed-conversations/${encodeURIComponent(selector.executionId)}/source-control`;
  const base = {
    contractVersion: 2,
    executionId: selector.executionId,
    executionGeneration: selector.executionGeneration,
    remoteIdentityHash: selector.remoteIdentityHash
  } as const;
  const prepared = sourceControlV2ResultSchema.parse(
    await input.request(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...base,
          kind: "review_request_merge_prepare",
          reviewRequestNumber: selector.reviewRequestNumber,
          mergeMethod: selector.mergeMethod
        })
      },
      256 * 1_024
    )
  );
  if (prepared.kind !== "review_request_merge_prepared")
    throw new Error("Merge preparation returned an invalid result");
  const readiness = prepared.readiness;
  if (
    readiness.executionId !== selector.executionId ||
    readiness.executionGeneration !== selector.executionGeneration ||
    readiness.remoteIdentityHash !== selector.remoteIdentityHash ||
    readiness.reviewRequestNumber !== selector.reviewRequestNumber ||
    readiness.mergeMethod !== selector.mergeMethod
  )
    throw new Error("Merge preparation does not match the requested review");
  const beforeReview = await input.access();
  if (beforeReview.authorization !== initial.authorization)
    throw new Error("Desktop credential changed before merge review");
  if (!(await input.confirm(prepared))) return null;
  const current = await input.access();
  if (current.authorization !== initial.authorization)
    throw new Error("Desktop credential changed during merge review");
  const approvalProof = createHmac("sha256", current.authorization)
    .update(
      JSON.stringify([
        prepared.operationId,
        prepared.readinessSnapshotDigest,
        prepared.expiresAt
      ])
    )
    .digest("hex");
  try {
    return sourceControlV2ResultSchema.parse(
      await input.request(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...base,
            kind: "review_request_merge",
            operationId: prepared.operationId,
            approvalProof
          })
        },
        256 * 1_024
      )
    );
  } catch (error) {
    // A lost dispatch response may follow a successful provider mutation.
    // Return the prepared journal identity so callers can only reconcile read-only.
    if (
      error &&
      typeof error === "object" &&
      "retryable" in error &&
      error.retryable === false
    )
      throw error;
    return sourceControlV2ResultSchema.parse({
      kind: "review_request_merge_result",
      operationId: prepared.operationId,
      outcome: "unknown",
      providerOperationId: null,
      mergeCommitObjectId: null
    });
  }
};
