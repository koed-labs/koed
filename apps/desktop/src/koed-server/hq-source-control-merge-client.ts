import type {
  ManagedProjectRequest,
  ManagedProjectResult
} from "../ipc/managed-project-protocol.js";
import { reviewAndDispatchSourceControlMerge } from "./source-control-merge-native-client.js";
type UncorrelatedResult<T = ManagedProjectResult> =
  T extends ManagedProjectResult ? Omit<T, "requestId"> : never;
type MergeRequest = Extract<
  ManagedProjectRequest,
  {
    operation:
      | "source_control_merge"
      | "source_control_merge_capability"
      | "source_control_merge_status";
  }
>;
const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
/** HQ merge orchestration stays outside the server manager; Native authority is unchanged. */
export const handleHqSourceControlMerge = async (input: {
  request: MergeRequest;
  requestJson: Parameters<
    typeof reviewAndDispatchSourceControlMerge
  >[0]["request"];
  access: Parameters<typeof reviewAndDispatchSourceControlMerge>[0]["access"];
  confirm?: Parameters<
    typeof reviewAndDispatchSourceControlMerge
  >[0]["confirm"];
}): Promise<UncorrelatedResult> => {
  const { request } = input;
  if (request.operation === "source_control_merge") {
    if (request.proposalItemId) {
      const runtime = await input.requestJson(
        `/v1/managed-conversations/${encodeURIComponent(request.executionId)}/runtime`,
        { method: "GET" },
        2 * 1_024 * 1_024
      );
      const items = Array.isArray(runtime.items) ? runtime.items : [];
      const proposal = items.find(
        (item) => objectValue(item)?.id === request.proposalItemId
      );
      const proposalRecord = objectValue(proposal);
      const selector = objectValue(
        objectValue(proposalRecord?.payload)?.mergeProposal
      );
      if (
        proposalRecord?.executionGeneration !== request.executionGeneration ||
        proposalRecord?.providerRequestId === undefined ||
        !String(proposalRecord.providerRequestId).startsWith(
          "review-request-merge-propose:"
        ) ||
        selector?.reviewRequestNumber !== request.reviewRequestNumber
      )
        throw new Error("Merge proposal no longer matches this pull request");
    }
    const result = await reviewAndDispatchSourceControlMerge({
      selector: request,
      access: input.access,
      request: input.requestJson,
      confirm: input.confirm ?? (async () => false)
    });
    if (!result) {
      if (request.proposalItemId) {
        await input.requestJson(
          `/v1/managed-conversations/${encodeURIComponent(request.executionId)}/merge-proposals/${encodeURIComponent(request.proposalItemId)}/decline`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              executionGeneration: request.executionGeneration
            })
          },
          256 * 1_024
        );
      }
      return {
        operation: "source_control_merge",
        executionId: request.executionId,
        result: { kind: "declined" }
      };
    }
    return {
      operation: "source_control_merge",
      executionId: request.executionId,
      result
    };
  }

  if (
    request.operation === "source_control_merge_capability" ||
    request.operation === "source_control_merge_status"
  ) {
    const payload = await input.requestJson(
      `/v2/managed-conversations/${encodeURIComponent(request.executionId)}/source-control`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractVersion: 2,
          executionId: request.executionId,
          executionGeneration: request.executionGeneration,
          remoteIdentityHash: request.remoteIdentityHash,
          kind:
            request.operation === "source_control_merge_capability"
              ? "review_request_merge_capability"
              : "review_request_merge_status",
          ...(request.operation === "source_control_merge_capability"
            ? { reviewRequestNumber: request.reviewRequestNumber }
            : { operationId: request.operationId })
        })
      },
      256 * 1_024
    );
    return {
      operation: request.operation,
      executionId: request.executionId,
      result: payload as never
    };
  }

  throw new Error("Unsupported merge operation");
};
