import { randomUUID } from "node:crypto";
import { z } from "zod";
import { associatedSelectionFromPdsState } from "@koed/shared";
import type { PdsProjectSelectionState } from "@koed/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const inspection = (state: PdsProjectSelectionState) => ({
  ...state,
  revisions: state.revisions.filter((revision) =>
    state.heads.includes(revision.revisionId)
  )
});
const scopeSchema = z
  .object({ groupId: id, associationId: id, selectionId: id })
  .strict();
const writeSchema = scopeSchema
  .extend({
    reviewedHeads: z.array(id).max(1024),
    operation: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("set"),
          anchorFingerprint: z.string().min(4).max(512).startsWith("gr_")
        })
        .strict(),
      z.object({ kind: z.literal("delete") }).strict()
    ])
  })
  .strict();

export const registerPersonalProjectSelectionRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext,
  authenticate: (request: FastifyRequest) => Promise<{ id: string }>
): void => {
  const checkoutSchema = z
    .object({ originatingDeviceId: id, checkoutId: id })
    .strict();
  app.get(
    "/v1/memory/repository-selection",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const user = await context.auth.authenticate(request);
      const accepted = await context
        .requireRepository()
        .personalProjectSelections.readAccepted({
          userId: user.id,
          ...checkoutSchema.parse(request.query)
        });
      return {
        association: accepted
          ? {
              groupId: accepted.groupId,
              associationId: accepted.associationId,
              selectionId: accepted.selectionId,
              selection:
                associatedSelectionFromPdsState(
                  accepted.associationId,
                  accepted.state
                )?.selection ?? null
            }
          : null
      };
    }
  );
  app.get(
    "/v1/pds/project-associations",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const user = await authenticate(request);
      const { groupId } = z
        .object({ groupId: id })
        .strict()
        .parse(request.query);
      return {
        associations: (
          await context
            .requireRepository()
            .personalProjectSelections.listAssociations({
              userId: user.id,
              groupId
            })
        ).map((entry) => ({ ...entry, state: inspection(entry.state) }))
      };
    }
  );
  app.post(
    "/v1/pds/project-associations/accept",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const user = await authenticate(request);
      const input = scopeSchema
        .extend({
          originatingDeviceId: id,
          checkoutId: id,
          localProjectId: z.string().regex(/^lp_[0-9a-f]{32}$/)
        })
        .strict()
        .parse(request.body);
      return {
        selection: inspection(
          await context
            .requireRepository()
            .personalProjectSelections.accept({ userId: user.id, ...input })
        )
      };
    }
  );
  app.delete(
    "/v1/pds/project-associations/accept",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const user = await authenticate(request);
      await context
        .requireRepository()
        .personalProjectSelections.forgetAcceptance({
          userId: user.id,
          ...checkoutSchema.parse(request.body)
        });
      return { ok: true };
    }
  );
  app.get(
    "/v1/pds/project-selections",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const user = await authenticate(request);
      const scope = scopeSchema.parse(request.query);
      return {
        selection: inspection(
          await context
            .requireRepository()
            .personalProjectSelections.read({ userId: user.id, ...scope })
        )
      };
    }
  );
  app.post(
    "/v1/pds/project-selections",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const user = await authenticate(request);
      const input = writeSchema.parse(request.body);
      const keyContext =
        await context.personalDeviceSync.secureKeyProvider?.getSourceContext({
          userId: user.id,
          groupId: input.groupId
        });
      if (!keyContext?.signProjectSelection)
        throw Object.assign(
          new Error("Personal Device Sync signing is unavailable"),
          { statusCode: 503 }
        );
      const record = keyContext.signProjectSelection({
        associationId: input.associationId,
        selectionId: input.selectionId,
        revisionId: randomUUID(),
        replaces: input.reviewedHeads,
        operation: input.operation
      });
      try {
        return {
          selection: inspection(
            (
              await context
                .requireRepository()
                .personalProjectSelections.appendVerified({
                  userId: user.id,
                  record,
                  reviewedHeads: input.reviewedHeads
                })
            ).state
          )
        };
      } catch (error) {
        if (
          error instanceof Error &&
          /changed|reviewed|incomplete|identity differs/.test(error.message)
        )
          throw Object.assign(new Error(error.message), { statusCode: 409 });
        throw error;
      }
    }
  );
};
