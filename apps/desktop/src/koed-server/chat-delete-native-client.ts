import {
  personalDesktopChatDeleteReviewReservationSchema,
  personalDesktopChatDeleteStatusSchema
} from "@koed/shared/personal-desktop";
import type { ProjectsAuthority } from "./projects-client.js";

export type ChatDeleteReviewReservation = ReturnType<
  typeof personalDesktopChatDeleteReviewReservationSchema.parse
>;

export const createChatDeleteNativeClient = (input: {
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
      const reservation =
        personalDesktopChatDeleteReviewReservationSchema.parse(
          await input.requestJson(
            `${path(sessionId)}/delete-reviews/${encodeURIComponent(actionGrantId)}?batchId=${encodeURIComponent(batchId)}`,
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
        throw new Error("Conversation deletion review identity changed.");
      return { reservation, authorityKey: bound.key, ownerId: bound.ownerId };
    },
    async assertAuthority(key: string, ownerId: string) {
      const current = await input.authority();
      if (current.key !== key || current.ownerId !== ownerId)
        throw new Error("Conversation deletion review profile changed.");
    },
    async progress(sessionId: string, batchId: string) {
      const bound = await input.authority();
      const result = await input.requestJson(
        `${path(sessionId)}/delete-progress`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ batchId })
        },
        bound
      );
      if (!sameAuthority(bound, await input.authority()))
        throw new Error("Conversation deletion profile changed.");
      const parsed = personalDesktopChatDeleteStatusSchema.parse(result);
      if (parsed.sessionId !== sessionId || parsed.batchId !== batchId)
        throw new Error("Conversation deletion progress identity changed.");
      return parsed;
    }
  };
};
