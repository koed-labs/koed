import {
  normalizePersonalSelection,
  personalSelectionLegacyScope,
  type PersonalSelectionSnapshot
} from "@koed/shared";
import type { MemoryApiClient } from "./index.js";
import {
  memoryAnswerInputSchema,
  memoryAnswerRequestSchema,
  type MemoryAnswerToolInput
} from "./memory-tool-schemas.js";

/** Pin explicit Personal grouping before cwd discovery or Team routing. */
export const pinPersonalRecallRequest = async (
  raw: unknown,
  client: Pick<MemoryApiClient, "accessCheck">
): Promise<{
  input: MemoryAnswerToolInput;
  selection?: PersonalSelectionSnapshot;
}> => {
  const { recall_target, ...request } = memoryAnswerRequestSchema.parse(raw);
  if (!recall_target) return { input: memoryAnswerInputSchema.parse(request) };
  const selection = normalizePersonalSelection(
    { recall_target, repository_context: request.repository_context },
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
