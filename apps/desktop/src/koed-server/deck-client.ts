import { projectHqSchema } from "@koed/shared/project-contract";
import { z } from "zod";
import {
  deckListSchema,
  deckSchema,
  deckProgressListSchema,
  deckProgressSchema
} from "@koed/shared/flashcard-deck-contract";
import {
  deckRequestSchema,
  deckResultSchema,
  type DeckRequest,
  type DeckResult
} from "../ipc/deck-protocol.js";
import type { ProjectsAuthority } from "./projects-client.js";
import { nextDeckProgress } from "./deck-scheduler.js";

type FetchJson = (path: string, init?: RequestInit) => Promise<unknown>;

/** All Deck reads and grades re-resolve the Personal Project and live Team gate. */
export const createDeckClient =
  (input: {
    authority: () => Promise<ProjectsAuthority>;
    sendPersonal: FetchJson;
    sendTeam: (backendId: string, path: string) => Promise<unknown>;
    teamCredential: (backendId: string) => string;
    now?: () => Date;
  }) =>
  async (value: DeckRequest): Promise<DeckResult> => {
    const request = deckRequestSchema.parse(value);
    const bound = await input.authority();
    if (
      !bound.canWrite &&
      (request.operation === "grade" || request.operation === "learning")
    )
      throw new Error("Deck study authority is unavailable.");
    const guard = async () => {
      const currentAuthority = await input.authority();
      if (currentAuthority.key !== bound.key)
        throw new Error("Desktop profile changed during Deck study.");
      if (
        (request.operation === "grade" || request.operation === "learning") &&
        !currentAuthority.canWrite
      )
        throw new Error("Deck study authority is unavailable.");
      const hq = projectHqSchema.parse(
        await input.sendPersonal(`/v1/projects/${request.projectId}/hq`)
      );
      const project = hq.project;
      if (
        project.id !== request.projectId ||
        project.lifecycle !== "active" ||
        project.deletionPhase !== null ||
        project.deleteBatchId !== null
      )
        throw new Error("Project is unavailable.");
      return project;
    };
    const project = await guard();
    const backendId = project.teamBackendId;
    const workspaceId = project.workspaceProjectId;
    if (Boolean(backendId) !== Boolean(workspaceId))
      throw new Error("Project link is incomplete.");
    const linked = Boolean(backendId && workspaceId);
    const deckBase = linked
      ? `/v1/workspace-projects/${workspaceId}/decks`
      : `/v1/projects/${request.projectId}/decks`;
    const content = async (path: string) =>
      linked ? input.sendTeam(backendId!, path) : input.sendPersonal(path);
    const check = async () => {
      const current = await guard();
      if (
        current.teamBackendId !== backendId ||
        current.workspaceProjectId !== workspaceId ||
        current.version !== project.version
      )
        throw new Error("Project binding changed during Deck study.");
    };
    if (request.operation === "list") {
      const decks = deckListSchema.parse(await content(deckBase));
      if (
        decks.decks.some(
          (deck) =>
            deck.projectId !== (linked ? workspaceId : request.projectId)
        )
      )
        throw new Error("Deck list crossed Project.");
      await check();
      return deckResultSchema.parse({
        operation: "list",
        projectId: request.projectId,
        value: decks
      });
    }
    const deckPath = `${deckBase}/${request.deckId}`;
    const deck = deckSchema.parse(await content(deckPath));
    if (
      deck.id !== request.deckId ||
      deck.projectId !== (linked ? workspaceId : request.projectId) ||
      deck.cards.some((card) => card.deckId !== deck.id)
    )
      throw new Error("Deck content crossed Project.");
    await check();
    if (
      request.operation === "grade" &&
      (deck.version !== request.expectedDeckVersion ||
        deck.cards.find((card) => card.id === request.cardId)?.version !==
          request.expectedCardVersion)
    )
      throw new Error(
        "Deck Card changed since it was shown. Refresh this Deck."
      );
    if (request.operation === "open")
      return deckResultSchema.parse({
        operation: "open",
        projectId: request.projectId,
        deckId: request.deckId,
        value: deck
      });
    const progressPath = linked
      ? `/v1/local-edge/projects/${request.projectId}/decks/${request.deckId}/progress`
      : `/v1/projects/${request.projectId}/deck-progress`;
    const rawProgress = deckProgressListSchema.parse(
      await input.sendPersonal(progressPath)
    );
    const active = new Set(deck.cards.map((card) => card.id));
    const progress = {
      progress: rawProgress.progress.filter((row) => active.has(row.cardId))
    };
    await check();
    if (request.operation === "progress")
      return deckResultSchema.parse({
        operation: "progress",
        projectId: request.projectId,
        deckId: request.deckId,
        value: progress
      });
    const ensureLearning = async (mode: "begin" | "reconcile") => {
      const card = deck.cards.find((item) => item.id === request.cardId);
      if (!card) throw new Error("Card is unavailable.");
      const path = linked
        ? `/v1/local-edge/projects/${request.projectId}/decks/${request.deckId}/cards/${request.cardId}/learning`
        : `${deckPath}/cards/${request.cardId}/learning`;
      const payload = await input.sendPersonal(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(linked
            ? {
                "x-koed-team-client-credential": input.teamCredential(
                  backendId!
                )
              }
            : {})
        },
        body: JSON.stringify({
          mode,
          expectedDeckVersion: deck.version,
          expectedCardVersion: card.version
        })
      });
      const status = z
        .object({
          status: z.enum([
            "projection_pending",
            "pending",
            "stored",
            "merged",
            "superseded",
            "conflicted",
            "skipped",
            "retry_needed"
          ])
        })
        .parse(payload).status;
      await check();
      return status;
    };
    if (request.operation === "learning") {
      if (
        !deck.cards.some((card) => card.id === request.cardId) ||
        !progress.progress.some(
          (row) => row.cardId === request.cardId && row.misses > 0
        )
      )
        throw new Error("First Again has not been recorded.");
      const status = await ensureLearning("reconcile");
      return deckResultSchema.parse({
        operation: "learning",
        projectId: request.projectId,
        deckId: request.deckId,
        cardId: request.cardId,
        status
      });
    }
    if (!active.has(request.cardId)) throw new Error("Card is unavailable.");
    const existing = progress.progress.find(
      (row) => row.cardId === request.cardId
    );
    if (
      (existing?.box ?? 0) !== request.expectedBox ||
      (existing?.misses ?? 0) !== request.expectedMisses
    )
      throw new Error("Card progress changed. Refresh this Deck.");
    const updated = nextDeckProgress(
      { box: request.expectedBox, misses: request.expectedMisses },
      request.rating,
      input.now?.()
    );
    await check();
    const learningStatus =
      request.rating === "again"
        ? await ensureLearning("begin")
        : "not_applicable";
    if (
      learningStatus === "retry_needed" ||
      learningStatus === "conflicted" ||
      learningStatus === "skipped"
    )
      throw new Error("First Again learning could not be proposed.");
    const currentDeck = deckSchema.parse(await content(deckPath));
    if (
      currentDeck.id !== deck.id ||
      currentDeck.projectId !== deck.projectId ||
      currentDeck.version !== deck.version ||
      currentDeck.cards.find((card) => card.id === request.cardId)?.version !==
        deck.cards.find((card) => card.id === request.cardId)?.version
    )
      throw new Error("Deck Card changed during study.");
    await check();
    const writePath = linked
      ? `/v1/local-edge/projects/${request.projectId}/decks/${request.deckId}/cards/${request.cardId}/progress`
      : `${deckPath}/cards/${request.cardId}/progress`;
    const saved = deckProgressSchema.parse(
      await input.sendPersonal(writePath, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updated)
      })
    );
    if (
      saved.cardId !== request.cardId ||
      saved.box !== updated.box ||
      saved.misses !== updated.misses ||
      saved.nextAt !== updated.nextAt
    )
      throw new Error("Card progress response changed.");
    await check();
    return deckResultSchema.parse({
      operation: "grade",
      projectId: request.projectId,
      deckId: request.deckId,
      cardId: request.cardId,
      value: saved,
      learningStatus
    });
  };
