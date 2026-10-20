import { workItemSchema } from "@koed/shared/work-item-contract";
import { z } from "zod";
import {
  projectsResultSchema,
  type ProjectsRequest
} from "../ipc/projects-protocol.js";

type WorkItemRequest = Extract<
  ProjectsRequest,
  { operation: "workItemList" | "workItemCreate" | "workItemPatch" }
>;
const pageSchema = z
  .object({
    items: z.array(workItemSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable()
  })
  .strict();

export const createProjectWorkItemClient =
  (
    send: (
      path: string,
      init?: RequestInit
    ) => Promise<Record<string, unknown>>,
    json: (method: string, body: unknown) => RequestInit
  ) =>
  async (request: WorkItemRequest) => {
    if (request.operation === "workItemList") {
      const items = [];
      const seenCursors = new Set<string>();
      const seenItems = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        pages += 1;
        if (pages > 50)
          throw new Error(
            "Work Item inventory exceeds the supported page limit."
          );
        const query = new URLSearchParams({ limit: "1000" });
        if (cursor) query.set("cursor", cursor);
        const page = pageSchema.parse(
          await send(
            `/v1/projects/${encodeURIComponent(request.projectId)}/work-items?${query}`
          )
        );
        for (const item of page.items) {
          if (item.projectId !== request.projectId || seenItems.has(item.id))
            throw new Error("Work Item list identity mismatch.");
          seenItems.add(item.id);
          items.push(item);
          if (items.length > 50_000)
            throw new Error(
              "Work Item inventory exceeds the supported item limit."
            );
        }
        if (page.hasMore !== Boolean(page.nextCursor))
          throw new Error("Invalid Work Item cursor state.");
        cursor = page.nextCursor;
        if (cursor && seenCursors.has(cursor))
          throw new Error("Repeated Work Item cursor.");
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      return projectsResultSchema.parse({
        operation: "workItemList",
        projectId: request.projectId,
        items
      });
    }
    if (request.operation === "workItemCreate") {
      const item = workItemSchema.parse(
        await send(
          `/v1/projects/${encodeURIComponent(request.projectId)}/work-items`,
          json("POST", request.value)
        )
      );
      if (item.projectId !== request.projectId)
        throw new Error("Work Item creation identity mismatch.");
      return projectsResultSchema.parse({
        operation: "workItemCreate",
        value: item
      });
    }
    const item = workItemSchema.parse(
      await send(
        `/v1/work-items/${encodeURIComponent(request.itemId)}`,
        json("PATCH", request.value)
      )
    );
    if (item.projectId !== request.projectId || item.id !== request.itemId)
      throw new Error("Work Item patch identity mismatch.");
    return projectsResultSchema.parse({
      operation: "workItemPatch",
      value: item
    });
  };
