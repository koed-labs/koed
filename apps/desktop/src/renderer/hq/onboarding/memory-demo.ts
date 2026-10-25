import type {
  PersonalDesktopApi,
  PersonalDesktopAskTurn
} from "@koed/shared/personal-desktop";

export type OnboardingMemoryDemoResult = {
  noteId: string;
  status: "saved" | "pending" | "answered" | "failed";
  answer?: string;
  error?: string;
  /** Personal Ask does not expose structured citations. */
  citations?: string[];
};

type Clock = { sleep: (milliseconds: number) => Promise<void> };
const defaultClock: Clock = {
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
};
const recallQuestion =
  "Suggest a name for the setting that controls webhook retries. Use my work preferences from retrieved Koed memory, and briefly explain how they affect your suggestion. Do not invent preferences; identify the source when available.";

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim()
    ? error.message
    : "Your AI could not answer from Memory. Try again.";

/** Uses only the existing Personal Note and local AI Desktop Ask APIs. */
export const createOnboardingMemoryDemoApi = (
  api: PersonalDesktopApi,
  current: () => boolean = () => true,
  clock: Clock = defaultClock
): {
  run: (
    text: string,
    idempotencyKey: string
  ) => Promise<OnboardingMemoryDemoResult>;
} => {
  const guard = () => {
    if (!current())
      throw new Error("Personal Memory profile changed during onboarding.");
  };
  const wait = async (milliseconds: number) => {
    guard();
    await clock.sleep(milliseconds);
    guard();
  };
  const settle = (
    noteId: string,
    turn: PersonalDesktopAskTurn
  ): OnboardingMemoryDemoResult => {
    if (turn.status === "error") {
      return {
        noteId,
        status: "failed",
        error: turn.errorMessage || "Your AI could not answer from Memory."
      };
    }
    if (turn.status === "answered") {
      return turn.answerMarkdown?.trim()
        ? { noteId, status: "answered", answer: turn.answerMarkdown }
        : { noteId, status: "failed", error: "Your AI returned no answer." };
    }
    return { noteId, status: "pending" };
  };
  return {
    async run(text, idempotencyKey) {
      if (!api.createNote) throw new Error("Personal Notes are unavailable.");
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text !== text.trim() ||
        text.length > 32_768
      )
        throw new Error("Enter the exact preference you want to remember.");
      if (!/^[A-Za-z0-9._:-]{1,450}$/u.test(idempotencyKey))
        throw new Error("Memory demo request key is invalid.");
      guard();
      let note = await api.createNote({
        body: text,
        idempotencyKey: `hq-onboarding-note:${idempotencyKey}`
      });
      guard();
      if (note.body !== text)
        throw new Error("Personal Note retry returned different content.");
      const noteId = note.noteId;
      if (note.projectionState === "failed") {
        return {
          noteId,
          status: "failed",
          error: "Memory could not prepare this note for recall."
        };
      }
      if (note.projectionState !== "available" || !note.memoryEventId) {
        if (!api.loadNote) return { noteId, status: "pending" };
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (attempt > 0) await wait(250 * attempt);
          guard();
          note = await api.loadNote({ noteId });
          guard();
          if (note.noteId !== noteId || note.body !== text)
            throw new Error("Personal Note changed during onboarding.");
          if (note.projectionState === "failed")
            return {
              noteId,
              status: "failed",
              error: "Memory could not prepare this note for recall."
            };
          if (note.projectionState === "available" && note.memoryEventId) break;
        }
        if (note.projectionState !== "available" || !note.memoryEventId)
          return { noteId, status: "pending" };
      }
      if (!api.submitAsk) return { noteId, status: "saved" };
      let turn: PersonalDesktopAskTurn;
      try {
        guard();
        turn = await api.submitAsk({
          query: recallQuestion,
          idempotencyKey: `hq-onboarding-ask:${idempotencyKey}`
        });
        guard();
      } catch (error) {
        guard();
        return { noteId, status: "failed", error: errorMessage(error) };
      }
      if (turn.query !== recallQuestion) {
        return {
          noteId,
          status: "failed",
          error: "Your AI returned a different Memory request. Try again."
        };
      }
      if (turn.status !== "pending") return settle(noteId, turn);
      if (!api.loadAskThread) return { noteId, status: "pending" };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (attempt > 0) await wait(250 * attempt);
        try {
          guard();
          const turns = await api.loadAskThread({
            askThreadId: turn.askThreadId
          });
          guard();
          const matching = turns.find(
            (candidate) =>
              candidate.id === turn.id &&
              candidate.askThreadId === turn.askThreadId &&
              candidate.query === turn.query
          );
          if (!matching) continue;
          turn = matching;
          if (turn.status !== "pending") return settle(noteId, turn);
        } catch (error) {
          guard();
          return { noteId, status: "failed", error: errorMessage(error) };
        }
      }
      return { noteId, status: "pending" };
    }
  };
};
