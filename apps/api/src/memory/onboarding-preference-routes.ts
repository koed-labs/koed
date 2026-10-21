import type { FastifyInstance } from "fastify";
import type { CollaborationRepository } from "@koed/db";
import {
  hqOnboardingPreferenceClaim,
  hqOnboardingPreferenceRequestSchema
} from "@koed/shared/hq-onboarding-contract";
import { authenticateProjectOperation } from "../projects/desktop-read-auth.js";
import type { ApiRouteContext } from "../server/context.js";

/** Desktop-only bridge from explicit User note consent to AI-reviewed Me Memory. */
export function registerOnboardingPreferenceRoutes(
  app: FastifyInstance,
  context: ApiRouteContext,
  notes: Pick<CollaborationRepository, "getPersonalNote"> | null
) {
  app.post(
    "/v1/memory/curated/onboarding-preference",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      if (!request.headers.authorization?.trim().startsWith("Koed-Desktop "))
        throw Object.assign(
          new Error("Onboarding preference requires Desktop owner authority"),
          { statusCode: 403 }
        );
      const authority = {
        deploymentProfile: context.config.deploymentProfile,
        koedHome: context.config.koedHome,
        auth: context.auth
      };
      const writer = await authenticateProjectOperation(
        request,
        authority,
        true
      );
      const reader = await authenticateProjectOperation(
        request,
        authority,
        false
      );
      if (writer.id !== reader.id)
        throw Object.assign(new Error("Desktop owner changed"), {
          statusCode: 409
        });
      if (!notes)
        throw Object.assign(new Error("Personal Notes are unavailable"), {
          statusCode: 503
        });
      const parsed = hqOnboardingPreferenceRequestSchema.safeParse(
        request.body
      );
      if (!parsed.success)
        throw Object.assign(
          new Error("Invalid onboarding preference request"),
          { statusCode: 400 }
        );
      const input = parsed.data;
      const note = await notes.getPersonalNote(
        { userId: writer.id },
        { noteId: input.noteId }
      );
      const claim = hqOnboardingPreferenceClaim(input.role);
      if (
        !note ||
        note.projectionState !== "available" ||
        note.memoryEventId !== input.memoryEventId ||
        note.body !== claim
      )
        throw Object.assign(
          new Error("Current Personal Note evidence is unavailable"),
          { statusCode: 409 }
        );
      const proposal = await context
        .requireRepository()
        .createOnboardingPreferenceProposal(
          { userId: writer.id },
          { noteId: input.noteId, memoryEventId: input.memoryEventId, claim }
        );
      return {
        proposalId: proposal.id,
        status: proposal.status,
        reviewedAssertionId: proposal.assertionId
      };
    }
  );
}
