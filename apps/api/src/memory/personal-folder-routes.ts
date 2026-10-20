import type { FastifyInstance } from "fastify";
import {
  personalFolderScopeId,
  type PersonalSelectionSnapshot
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { listSelectedPersonalThreads } from "./personal-selection-inventory.js";
import { graphThreadIndexResponseSchema } from "./graph-schemas.js";

export const registerPersonalFolderRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  app.get(
    "/v1/personal/folders/inventory",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const user = await context.auth.authenticate(request);
      const actor = { userId: user.id },
        repo = context.requireRepository();
      const folders = await repo.listPersonalFolders(actor);
      const projects = [];
      for (const folder of folders) {
        const id = personalFolderScopeId(folder.reference);
        const name =
          folder.normalizedPath.split(/[\\/]/).filter(Boolean).at(-1) ??
          folder.normalizedPath;
        const personalSelection: PersonalSelectionSnapshot = {
          version: 1,
          ownerUserId: user.id,
          target: { kind: "folder", folder: folder.reference },
          callerRepositoryContext: null
        };
        const threads = await listSelectedPersonalThreads(
          repo,
          actor,
          personalSelection,
          "Folder"
        );
        const logicalBySession = new Map(
          threads
            .flatMap((thread) => thread.sourceReferences ?? [])
            .map((ref) => [ref.sessionId, ref.logicalSessionId])
        );
        const presentations = new Map(
          (
            await repo.listConversationPresentationStates(
              actor,
              threads.flatMap((thread) =>
                thread.sessionId ? [thread.sessionId] : []
              )
            )
          ).map((row) => [row.sessionId, row])
        );
        projects.push({
          id,
          name,
          folder,
          path: folder.normalizedPath,
          eventCount: threads.reduce(
            (total, thread) => total + thread.eventCount,
            0
          ),
          threads: threads.map((thread) => {
            const logicalId = thread.sessionId
              ? logicalBySession.get(thread.sessionId)
              : undefined;
            if (!logicalId)
              throw new Error(
                "Folder Conversation source binding is unavailable"
              );
            return {
              ...thread,
              id: logicalId,
              sourceThreadId: thread.id,
              folderSelection: folder.reference,
              presentation: (() => {
                const row = thread.sessionId
                  ? presentations.get(thread.sessionId)
                  : undefined;
                return row
                  ? {
                      pinnedAt: row.pinnedAt,
                      displayMode: row.displayMode,
                      snoozedAt: row.snoozedAt,
                      snoozedUntil: row.snoozedUntil,
                      version: row.version,
                      updatedAt: row.updatedAt
                    }
                  : null;
              })(),
              sourceProject: {
                id: thread.projectId,
                name: thread.projectName,
                path: thread.projectPath
              },
              projectId: id,
              projectName: name,
              projectPath: folder.normalizedPath,
              parentThreadId: thread.parentSessionId
                ? (logicalBySession.get(thread.parentSessionId) ??
                  thread.parentThreadId)
                : thread.parentThreadId
            };
          })
        });
      }
      return graphThreadIndexResponseSchema.parse({ projects });
    }
  );
};
