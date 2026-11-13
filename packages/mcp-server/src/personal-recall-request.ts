import {
  normalizePersonalSelection,
  personalProjectRecallResolutionInputSchema,
  personalProjectRecallResolutionSchema,
  personalSelectionCompatibilityError,
  personalSelectionLegacyScope,
  type PersonalRecallTarget,
  type PersonalSelectionSnapshot
} from "@koed-labs/shared";
import type { MemoryApiClient } from "./index.js";
import type { LocalRuntimeCallerContext } from "./local-runtime-protocol.js";
import {
  memoryAnswerInputSchema,
  memoryAnswerRequestSchema,
  type MemoryAnswerToolInput
} from "./memory-tool-schemas.js";

export const isImplicitPersonalProjectRecallRequest = (
  raw: unknown
): boolean => {
  if (!raw || typeof raw !== "object") return false;
  const input = raw as Record<string, unknown>;
  return (
    input.recall_target === undefined &&
    (input.search_domain === undefined || input.search_domain === "project") &&
    input.project_id === undefined &&
    input.team_workspace_id === undefined &&
    input.team_backend_id === undefined
  );
};

/** Pin Personal grouping before cwd discovery or Team routing. */
export const pinPersonalRecallRequest = async (
  raw: unknown,
  client: Pick<MemoryApiClient, "accessCheck"> &
    Partial<Pick<MemoryApiClient, "resolvePersonalProjectRecall">>,
  caller?: Pick<LocalRuntimeCallerContext, "conversation">
): Promise<{
  input: MemoryAnswerToolInput;
  selection?: PersonalSelectionSnapshot;
}> => {
  const { recall_target, ...request } = memoryAnswerRequestSchema.parse(raw);
  let target: PersonalRecallTarget | undefined = recall_target;
  if (isImplicitPersonalProjectRecallRequest(raw)) {
    const binding = personalProjectRecallResolutionInputSchema.safeParse(
      caller?.conversation
    );
    if (!binding.success)
      throw personalSelectionCompatibilityError(
        "Project recall requires the current Conversation binding"
      );
    if (!client.resolvePersonalProjectRecall)
      throw personalSelectionCompatibilityError(
        "Project recall requires Conversation Project resolution support"
      );
    const resolution = personalProjectRecallResolutionSchema.parse(
      await client.resolvePersonalProjectRecall(binding.data)
    );
    if (
      resolution.sessionId !== resolution.target.callerSessionId ||
      ("sessionId" in binding.data &&
        resolution.sessionId !== binding.data.sessionId)
    )
      throw personalSelectionCompatibilityError(
        "Project recall resolution does not match the current Conversation"
      );
    target = resolution.target;
  }
  if (!target) return { input: memoryAnswerInputSchema.parse(request) };
  const selection = normalizePersonalSelection(
    {
      recall_target: target,
      repository_context: recall_target ? request.repository_context : undefined
    },
    (await client.accessCheck()).user.id
  );
  const scope = personalSelectionLegacyScope(selection);
  const input = memoryAnswerInputSchema.parse({
    ...request,
    search_domain: scope.searchDomain,
    project_id: scope.projectId,
    repository_context: undefined
  });
  return { input: { ...input, repository_context: null }, selection };
};
