import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  partitionPersonalInventory,
  personalSourceInventoryCursorSchema
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { graphThreadIndexResponseSchema } from "./graph-schemas.js";

const querySchema = z
  .object({
    cursor: z
      .string()
      .max(32768)
      .transform((value, ctx) => {
        try {
          return personalSourceInventoryCursorSchema.parse(JSON.parse(value));
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "Invalid source inventory cursor"
          });
          return z.NEVER;
        }
      })
      .optional()
  })
  .strict();

/** Source browsing has its own inventory. Loading it never discovers local
 * checkouts, creates a named Project, or changes membership. */
export const registerPersonalSourceInventoryRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  app.get(
    "/v1/personal/sources/inventory",
    { preHandler: context.rateLimit.memoryRead },
    async (request, reply) => {
      const user = await context.auth.authenticate(request);
      const { cursor } = querySchema.parse(request.query);
      if (cursor && cursor.ownerUserId !== user.id)
        return reply
          .code(404)
          .send({ error: "Source inventory cursor not found" });
      const repo = context.requireRepository();
      // Query one extra raw row. Filtering or logical deduplication must never
      // determine the next raw page boundary.
      const groups = await repo.listLcmGraphThreads(
        { userId: user.id },
        {
          limit: 101,
          offset: 0,
          includeInvalidated: false,
          groupBySession: true,
          inventoryOrder: true,
          ...(cursor ? { inventoryAfter: cursor.after } : {})
        }
      );
      // Repository order uses the C collation, independent of locale and recency.
      const compare = (a: string, b: string) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b));
      const rows = groups
        .flatMap((group) => group.threads)
        .sort(
          (a, b) =>
            compare(a.projectId, b.projectId) ||
            compare(a.id, b.id) ||
            compare(a.sessionId ?? "", b.sessionId ?? "")
        );
      const consumed = rows.slice(0, 100);
      const selected = new Set(consumed);
      const presentations = new Map(
        (
          await repo.listConversationPresentationStates(
            { userId: user.id },
            consumed.flatMap((thread) =>
              thread.sessionId ? [thread.sessionId] : []
            )
          )
        ).map((row) => [row.sessionId, row])
      );
      const projects = graphThreadIndexResponseSchema.parse({
        projects: groups
          .map((group) => ({
            ...group,
            ownerUserId: user.id,
            eventCount: group.threads
              .filter((thread) => selected.has(thread))
              .reduce((sum, thread) => sum + thread.eventCount, 0),
            threads: group.threads
              .filter((thread) => selected.has(thread))
              .map((thread) => {
                const state = thread.sessionId
                  ? presentations.get(thread.sessionId)
                  : undefined;
                return {
                  ...thread,
                  id:
                    thread.sourceReferences?.find(
                      (ref) => ref.sessionId === thread.sessionId
                    )?.logicalSessionId ??
                    thread.sessionId ??
                    thread.id,
                  sourceThreadId: thread.id,
                  sourceProject: {
                    id: thread.projectId,
                    name: thread.projectName,
                    path: thread.projectPath
                  },
                  logicalMemoryId: thread.logicalMemoryId ?? null,
                  presentation: state
                    ? {
                        pinnedAt: state.pinnedAt,
                        displayMode: state.displayMode,
                        snoozedAt: state.snoozedAt,
                        snoozedUntil: state.snoozedUntil,
                        version: state.version,
                        updatedAt: state.updatedAt
                      }
                    : null
                };
              })
          }))
          .filter((group) => group.threads.length)
      }).projects;
      const inventory = partitionPersonalInventory(projects);
      const last = consumed.at(-1);
      return {
        gitSources: inventory.gitSources,
        unresolved: inventory.unresolved,
        nextCursor:
          rows.length > 100 && last
            ? JSON.stringify(
                personalSourceInventoryCursorSchema.parse({
                  ownerUserId: user.id,
                  after: {
                    projectId: last.projectId,
                    threadId: last.id,
                    sessionId: last.sessionId ?? ""
                  }
                })
              )
            : null
      };
    }
  );
};
