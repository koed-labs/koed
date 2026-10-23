import {
  curatedMemoryRequestSchema,
  curatedMemoryResultSchema,
  curatedAssertionSchema,
  type CuratedMemoryRequest,
  type CuratedMemoryResult
} from "../ipc/curated-memory-protocol.js";
import type { ProjectsAuthority } from "./projects-client.js";

type RequestJson = (
  path: string,
  init: RequestInit,
  authority: ProjectsAuthority
) => Promise<Record<string, unknown>>;
export const createCuratedMemoryClient =
  (requestJson: RequestJson, authority: () => Promise<ProjectsAuthority>) =>
  async (value: CuratedMemoryRequest): Promise<CuratedMemoryResult> => {
    const request = curatedMemoryRequestSchema.parse(value);
    const bound = await authority();
    const send = async (
      path: string,
      init: RequestInit = { method: "GET" }
    ) => {
      if (init.method !== "GET" && !bound.canWrite)
        throw new Error("Memory write authority is unavailable.");
      if ((await authority()).key !== bound.key)
        throw new Error("Memory profile changed before request.");
      const payload = await requestJson(path, init, bound);
      if ((await authority()).key !== bound.key)
        throw new Error("Memory profile changed during request.");
      return payload;
    };
    const path = (id: string) =>
      `/v1/memory/curated/assertions/${encodeURIComponent(id)}`;
    const json = (method: string, body: unknown): RequestInit => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (request.operation === "onboardingPreference") {
      const payload = await send(
        "/v1/memory/curated/onboarding-preference",
        json("POST", {
          role: request.role,
          noteId: request.noteId,
          memoryEventId: request.memoryEventId
        })
      );
      return curatedMemoryResultSchema.parse({
        operation: "onboardingPreference",
        proposalId: payload.proposalId,
        status: payload.status,
        reviewedAssertionId: payload.reviewedAssertionId
      });
    }
    if (request.operation === "list") {
      if (request.scope === "project" && !request.projectId)
        throw new Error("Project is required for Project memory.");
      const query = new URLSearchParams({
        scope: request.scope,
        status: "current",
        include_sources: "true",
        limit: "249"
      });
      if (request.scope === "project")
        query.set("project_id", request.projectId!);
      if (request.since) query.set("since", request.since);
      if (request.cursor) {
        query.set("before_updated_at", request.cursor.updatedAt);
        query.set("before_id", request.cursor.id);
      }
      const payload = await send(`/v1/memory/curated/assertions?${query}`);
      const assertions = curatedAssertionSchema
        .array()
        .parse(payload.assertions);
      if (
        assertions.some(
          (a) =>
            a.ownerUserId !== bound.ownerId ||
            a.visibility !== "personal" ||
            a.status !== "current" ||
            (request.since &&
              (!Number.isFinite(Date.parse(a.createdAt)) ||
                Date.parse(a.createdAt) < Date.parse(request.since))) ||
            a.scope !== request.scope ||
            a.projectId !==
              (request.scope === "project" ? request.projectId : null)
        )
      )
        throw new Error("Memory list crossed owner or scope.");
      const rawCursor = payload.next_cursor;
      const nextCursor =
        rawCursor == null
          ? null
          : {
              updatedAt: (rawCursor as { updated_at: string }).updated_at,
              id: (rawCursor as { id: string }).id
            };
      const result = curatedMemoryResultSchema.parse({
        operation: "list",
        assertions,
        nextCursor
      });
      if (
        result.operation === "list" &&
        result.nextCursor &&
        (!assertions.length ||
          result.nextCursor.id !== assertions.at(-1)?.id ||
          result.nextCursor.updatedAt !== assertions.at(-1)?.updatedAt ||
          (request.cursor &&
            (result.nextCursor.updatedAt > request.cursor.updatedAt ||
              (result.nextCursor.updatedAt === request.cursor.updatedAt &&
                result.nextCursor.id >= request.cursor.id))))
      )
        throw new Error("Memory list cursor did not advance.");
      return result;
    }
    if (request.operation === "detail") {
      const payload = await send(path(request.assertionId));
      const assertion = curatedAssertionSchema.parse(payload.assertion);
      if (
        assertion.id !== request.assertionId ||
        assertion.ownerUserId !== bound.ownerId ||
        assertion.visibility !== "personal"
      )
        throw new Error("Memory detail crossed owner.");
      return { operation: "detail", assertion };
    }
    if (request.operation === "forget" || request.operation === "undo") {
      const payload = await send(
        `${path(request.assertionId)}/${request.operation === "forget" ? "suppress" : "unsuppress"}`,
        json(
          "POST",
          request.operation === "forget"
            ? { status: "suppressed" }
            : { suppression_token: request.suppressionToken }
        )
      );
      const assertion = curatedAssertionSchema.parse({
        ...(payload.assertion as Record<string, unknown>),
        replaces: []
      });
      if (
        assertion.id !== request.assertionId ||
        assertion.ownerUserId !== bound.ownerId ||
        assertion.visibility !== "personal" ||
        assertion.status !==
          (request.operation === "forget" ? "suppressed" : "current") ||
        (request.operation === "forget" && !assertion.suppressionToken) ||
        (request.operation === "undo" && assertion.suppressionToken !== null)
      )
        throw new Error("Memory mutation crossed owner.");
      return { operation: request.operation, assertion };
    }
    if (request.operation === "teamContributions")
      throw new Error("Team contributions require the linked Team backend.");
    if (request.scope === "project" && !request.projectId)
      throw new Error("Destination Project is required.");
    const payload = await send(
      path(request.assertionId),
      json("PATCH", {
        scope: request.scope,
        expected_version: request.expectedVersion,
        ...(request.scope === "project"
          ? { project_id: request.projectId }
          : {})
      })
    );
    const operation = payload.operation as Record<string, unknown> | undefined;
    if (
      !operation ||
      operation.assertionId !== request.assertionId ||
      operation.ownerUserId !== bound.ownerId ||
      operation.scope !== request.scope ||
      operation.projectId !==
        (request.scope === "project" ? request.projectId : null) ||
      operation.expectedVersion !== request.expectedVersion ||
      operation.nextVersion !== request.expectedVersion + 1
    )
      throw new Error("Memory move operation crossed owner or destination.");
    const pending = operation.state !== "complete";
    const assertion = pending
      ? null
      : curatedAssertionSchema.parse({
          ...(payload.assertion as Record<string, unknown>),
          replaces: []
        });
    if (
      assertion &&
      (assertion.ownerUserId !== bound.ownerId ||
        assertion.visibility !== "personal" ||
        assertion.id !== request.assertionId ||
        assertion.scope !== request.scope ||
        assertion.projectId !==
          (request.scope === "project" ? request.projectId : null) ||
        assertion.classificationVersion !== request.expectedVersion + 1)
    )
      throw new Error("Memory move crossed owner.");
    return { operation: "move", assertion, pending };
  };
