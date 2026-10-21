import {
  deckCommandChannel,
  deckRequestSchema,
  deckResultSchema,
  type DeckDesktopApi,
  type DeckRequest
} from "./deck-protocol.js";

export const createDeckPreloadApi = (
  invoke: (channel: string, request: DeckRequest) => Promise<unknown>
): DeckDesktopApi => {
  const command = async (request: DeckRequest) => {
    const result = deckResultSchema.parse(
      await invoke(deckCommandChannel, deckRequestSchema.parse(request))
    );
    if (
      result.operation !== request.operation ||
      result.projectId !== request.projectId ||
      ("deckId" in request &&
        (!("deckId" in result) || result.deckId !== request.deckId)) ||
      ("cardId" in request &&
        (!("cardId" in result) || result.cardId !== request.cardId))
    )
      throw new Error("Deck response identity changed.");
    return result;
  };
  return {
    list: async (projectId) => {
      const result = await command({ operation: "list", projectId });
      if (result.operation !== "list")
        throw new Error("Deck list response changed.");
      return result.value;
    },
    open: async (projectId, deckId) => {
      const result = await command({ operation: "open", projectId, deckId });
      if (result.operation !== "open")
        throw new Error("Deck open response changed.");
      return result.value;
    },
    progress: async (projectId, deckId) => {
      const result = await command({
        operation: "progress",
        projectId,
        deckId
      });
      if (result.operation !== "progress")
        throw new Error("Deck progress response changed.");
      return result.value;
    },
    learning: async (projectId, deckId, cardId) => {
      const result = await command({
        operation: "learning",
        projectId,
        deckId,
        cardId
      });
      if (result.operation !== "learning")
        throw new Error("Deck learning response changed.");
      return result.status;
    },
    grade: async (
      projectId,
      deckId,
      cardId,
      rating,
      expectedBox,
      expectedMisses,
      expectedDeckVersion,
      expectedCardVersion
    ) => {
      const result = await command({
        operation: "grade",
        projectId,
        deckId,
        cardId,
        rating,
        expectedBox,
        expectedMisses,
        expectedDeckVersion,
        expectedCardVersion
      });
      if (result.operation !== "grade")
        throw new Error("Deck grade response changed.");
      return { progress: result.value, learningStatus: result.learningStatus };
    }
  };
};
