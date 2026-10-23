import {
  curatedMemoryCommandChannel,
  curatedMemoryRequestSchema,
  curatedMemoryResultSchema,
  type CuratedMemoryDesktopApi,
  type CuratedMemoryRequest,
  type MemoryCursor
} from "./curated-memory-protocol.js";

export const createCuratedMemoryPreloadApi = (
  invoke: (channel: string, request: CuratedMemoryRequest) => Promise<unknown>
): CuratedMemoryDesktopApi => {
  const command = async (request: CuratedMemoryRequest) => {
    const result = curatedMemoryResultSchema.parse(
      await invoke(
        curatedMemoryCommandChannel,
        curatedMemoryRequestSchema.parse(request)
      )
    );
    if (result.operation !== request.operation)
      throw new Error("Invalid memory operation correlation.");
    return result;
  };
  return Object.freeze({
    teamContributions: async (projectId: string) => {
      const result = await command({
        operation: "teamContributions",
        projectId
      });
      if (
        result.operation !== "teamContributions" ||
        result.projectId !== projectId
      )
        throw new Error("Invalid Team contribution identity.");
      return result.contributions;
    },
    proposeOnboardingPreference: async (
      input: Parameters<
        NonNullable<CuratedMemoryDesktopApi["proposeOnboardingPreference"]>
      >[0]
    ) => {
      const result = await command({
        operation: "onboardingPreference",
        ...input
      });
      if (result.operation !== "onboardingPreference")
        throw new Error("Invalid onboarding preference result.");
      return result;
    },
    page: async (
      scope: "project" | "me" | "unscoped",
      projectId?: string,
      cursor?: MemoryCursor,
      since?: string
    ) => {
      const result = await command({
        operation: "list",
        scope,
        projectId,
        cursor,
        since
      });
      if (
        result.operation !== "list" ||
        result.assertions.some(
          (a) =>
            a.scope !== scope ||
            a.projectId !== (scope === "project" ? projectId : null)
        )
      )
        throw new Error("Invalid memory list identity.");
      return { assertions: result.assertions, nextCursor: result.nextCursor };
    },
    list: async (scope: "project" | "me" | "unscoped", projectId?: string) => {
      const result = await command({ operation: "list", scope, projectId });
      if (
        result.operation !== "list" ||
        result.assertions.some(
          (a) =>
            a.scope !== scope ||
            a.projectId !== (scope === "project" ? projectId : null)
        )
      )
        throw new Error("Invalid memory list identity.");
      return result.assertions;
    },
    detail: async (assertionId: string) => {
      const result = await command({ operation: "detail", assertionId });
      if (result.operation !== "detail" || result.assertion.id !== assertionId)
        throw new Error("Invalid memory detail identity.");
      return result.assertion;
    },
    forget: async (assertionId: string) => {
      const result = await command({ operation: "forget", assertionId });
      if (result.operation !== "forget" || result.assertion.id !== assertionId)
        throw new Error("Invalid memory Forget identity.");
      return result.assertion;
    },
    undo: async (assertionId: string, suppressionToken: string) => {
      const result = await command({
        operation: "undo",
        assertionId,
        suppressionToken
      });
      if (result.operation !== "undo" || result.assertion.id !== assertionId)
        throw new Error("Invalid memory Undo identity.");
      return result.assertion;
    },
    move: async (
      assertionId: string,
      scope: "project" | "me",
      expectedVersion: number,
      projectId?: string
    ) => {
      const result = await command({
        operation: "move",
        assertionId,
        scope,
        expectedVersion,
        projectId
      });
      if (
        result.operation !== "move" ||
        (result.assertion &&
          (result.assertion.id !== assertionId ||
            result.assertion.scope !== scope))
      )
        throw new Error("Invalid memory move identity.");
      return { assertion: result.assertion, pending: result.pending };
    }
  });
};
