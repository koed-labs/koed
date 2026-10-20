import {
  personalDesktopChatMoveReviewReservationSchema,
  personalDesktopChatMoveStatusSchema
} from "@koed/shared/personal-desktop";
import type { ProjectsAuthority } from "./projects-client.js";

export type ChatMoveReviewReservation = ReturnType<
  typeof personalDesktopChatMoveReviewReservationSchema.parse
>;

export const createChatMoveNativeClient = (input: {
  authority: () => Promise<ProjectsAuthority>;
  requestJson: (
    path: string,
    init: RequestInit,
    authority: ProjectsAuthority
  ) => Promise<Record<string, unknown>>;
}) => {
  const sameAuthority = (a: ProjectsAuthority, b: ProjectsAuthority) =>
    a.key === b.key && a.ownerId === b.ownerId;
  const path = (sessionId: string) =>
    `/v1/memory/graph/sessions/${encodeURIComponent(sessionId)}`;
  return {
    async prepareReview(
      sessionId: string,
      batchId: string,
      actionGrantId: string
    ) {
      const bound = await input.authority();
      if (!sameAuthority(bound, await input.authority()))
        throw new Error("Conversation move review profile changed.");
      const reservation = personalDesktopChatMoveReviewReservationSchema.parse(
        await input.requestJson(
          `${path(sessionId)}/move-reviews/${encodeURIComponent(actionGrantId)}?batchId=${encodeURIComponent(batchId)}`,
          { method: "GET" },
          bound
        )
      );
      if (
        !sameAuthority(bound, await input.authority()) ||
        reservation.sessionId !== sessionId ||
        reservation.batchId !== batchId ||
        reservation.actionGrantId !== actionGrantId
      )
        throw new Error("Conversation move review identity changed.");
      return { reservation, authorityKey: bound.key, ownerId: bound.ownerId };
    },
    async assertAuthority(key: string, ownerId: string) {
      const current = await input.authority();
      if (current.key !== key || current.ownerId !== ownerId)
        throw new Error("Conversation move review profile changed.");
    },
    async progress(sessionId: string, batchId: string) {
      const bound = await input.authority();
      if (!bound.canWrite || !sameAuthority(bound, await input.authority()))
        throw new Error("Conversation move authority is unavailable.");
      const result = await input.requestJson(
        `${path(sessionId)}/move-progress`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ batchId })
        },
        bound
      );
      if (!sameAuthority(bound, await input.authority()))
        throw new Error("Conversation move profile changed.");
      const parsed = personalDesktopChatMoveStatusSchema.parse(result);
      if (parsed.sessionId !== sessionId || parsed.batchId !== batchId)
        throw new Error("Conversation move progress identity changed.");
      return parsed;
    }
  };
};
