import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  MemorySourceRepository,
  ProjectSourceRepository,
  WorkItemRepository
} from "@koed/db";
import {
  ProjectCapabilityError,
  ProjectConflictError,
  ProjectNotFoundError,
  WorkItemConflictError,
  WorkItemGoneError,
  WorkItemUnavailableError
} from "@koed/db";
import {
  parseCanonicalDueDate,
  resolveDue,
  verifyDesktopLocalCredentialAuthorization,
  workItemsFromDocApplySchema,
  workItemsFromDocListPageSchema,
  workItemsFromDocListSchema,
  workItemsFromDocParamsSchema,
  workItemsFromDocPreviewSchema,
  workItemsFromDocPreviewResultSchema,
  workItemsFromDocReadPageSchema,
  workItemsFromDocReadSchema
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateProjectOperation } from "../projects/desktop-read-auth.js";

const readSchema = z
  .object({
    ...workItemsFromDocReadSchema.shape,
    cursor: z.coerce.number().int().nonnegative().default(0),
    executionGeneration: z.coerce.number().int().positive()
  })
  .strict();
const listSchema = z
  .object({
    ...workItemsFromDocListSchema.shape,
    cursor: z.coerce.number().int().nonnegative().default(0),
    executionGeneration: z.coerce.number().int().positive()
  })
  .strict();
export const applyDocumentItemsSchema = workItemsFromDocApplySchema;

const error = (message: string, statusCode: number): never => {
  throw Object.assign(new Error(message), { statusCode });
};

const documentError = (cause: unknown): never => {
  if (
    cause instanceof WorkItemConflictError ||
    cause instanceof ProjectConflictError
  )
    return error(cause.message, 409);
  if (
    cause instanceof WorkItemUnavailableError ||
    cause instanceof ProjectNotFoundError
  )
    return error(cause.message, 404);
  if (cause instanceof WorkItemGoneError) return error(cause.message, 410);
  if (cause instanceof ProjectCapabilityError) return error(cause.message, 503);
  throw cause;
};

const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
];
const resolveDocumentDue = (text: string, timeZone: string, now: Date) => {
  const iso = parseCanonicalDueDate(text.trim());
  if (iso) return iso;
  const explicit = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i.exec(text.trim());
  if (explicit) {
    const name = explicit[2]!.toLowerCase();
    const month =
      months.findIndex(
        (value) => value === name || value.slice(0, 3) === name
      ) + 1;
    if (!month) return null;
    return parseCanonicalDueDate(
      `${explicit[3]}-${String(month).padStart(2, "0")}-${String(Number(explicit[1])).padStart(2, "0")}`
    );
  }
  return resolveDue(text, { now, timeZone });
};

/** Source text is read only for a live, local, owner-bound Agent command. */
export function registerWorkItemsFromDocumentRoutes(
  app: FastifyInstance,
  input: {
    managed: MemorySourceRepository | null;
    sources: ProjectSourceRepository | null;
    items: WorkItemRepository | null;
    auth: ApiRouteContext["auth"];
    deploymentProfile: string;
    koedHome: string;
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  }
) {
  const authorize = async (request: FastifyRequest, write: boolean) => {
    const authorization = request.headers.authorization?.trim();
    if (!authorization?.startsWith("Koed-Desktop "))
      return error("Local Desktop credential required", 403);
    const actor = await authenticateProjectOperation(request, input, write);
    if (
      !verifyDesktopLocalCredentialAuthorization(
        input.koedHome,
        authorization,
        {
          ownerUserId: actor.id,
          operationFamily: "managed_execution"
        }
      )
    )
      return error("Managed execution credential required", 403);
    if (!input.managed || !input.sources || !input.items)
      return error("Document Work Items are unavailable", 503);
    return {
      actor,
      managed: input.managed,
      sources: input.sources,
      items: input.items
    };
  };
  const current = async (
    managed: MemorySourceRepository,
    ownerUserId: string,
    executionId: string,
    expectedGeneration?: number
  ) => {
    const actor = { userId: ownerUserId };
    const [execution, command] = await Promise.all([
      managed.getManagedConversationExecution(actor, executionId),
      managed.getLatestManagedConversationCommandForExecution(
        actor,
        executionId
      )
    ]);
    if (
      !execution ||
      !command ||
      execution.ownerUserId !== ownerUserId ||
      command.ownerUserId !== ownerUserId ||
      command.executionId !== executionId ||
      command.state !== "dispatching" ||
      !command.leaseToken ||
      !command.leaseExpiresAt ||
      Date.parse(command.leaseExpiresAt) <= Date.now() ||
      command.executionGeneration !== execution.executionGeneration ||
      (expectedGeneration !== undefined &&
        execution.executionGeneration !== expectedGeneration) ||
      !["starting", "running", "reconciling"].includes(execution.state)
    )
      return error("Managed Agent command is no longer active", 409);
    return { execution, command };
  };

  app.get(
    "/v1/managed-conversations/:executionId/work-items-from-doc/list",
    { preHandler: input.readRateLimit },
    async (request) => {
      const { actor, managed, sources } = await authorize(request, false);
      const { executionId } = workItemsFromDocParamsSchema.parse(
        request.params
      );
      const { cursor, executionGeneration } = listSchema.parse(request.query);
      const { execution, command } = await current(
        managed,
        actor.id,
        executionId,
        executionGeneration
      );
      const selectedSourceId =
        typeof command.payload?.selectedDocumentSourceId === "string"
          ? z.uuid().parse(command.payload.selectedDocumentSourceId)
          : null;
      const documents = (
        await sources.list(actor.id, execution.projectId).catch(documentError)
      ).filter(
        (source) =>
          source.kind === "doc" &&
          source.status === "ready" &&
          source.currentRevisionId !== null &&
          source.deletedAt === null &&
          (!selectedSourceId || source.id === selectedSourceId)
      );
      const afterList = await current(
        managed,
        actor.id,
        executionId,
        executionGeneration
      );
      if (
        afterList.command.id !== command.id ||
        afterList.command.leaseToken !== command.leaseToken ||
        afterList.command.payload?.selectedDocumentSourceId !==
          command.payload?.selectedDocumentSourceId ||
        afterList.execution.projectId !== execution.projectId
      )
        return error(
          "Managed Agent command changed during document discovery",
          409
        );
      const page = documents.slice(cursor, cursor + 30);
      return workItemsFromDocListPageSchema.parse({
        documents: page.map((source) => ({
          sourceId: source.id,
          name: source.name,
          noteRevisionId: source.currentRevisionId
        })),
        nextCursor: cursor + 30 < documents.length ? cursor + 30 : null
      });
    }
  );

  app.get(
    "/v1/managed-conversations/:executionId/work-items-from-doc/read",
    { preHandler: input.readRateLimit },
    async (request) => {
      const { actor, managed, sources } = await authorize(request, false);
      const { executionId } = workItemsFromDocParamsSchema.parse(
        request.params
      );
      const { sourceId, cursor, executionGeneration } = readSchema.parse(
        request.query
      );
      const { execution, command } = await current(
        managed,
        actor.id,
        executionId,
        executionGeneration
      );
      const selectedSourceId =
        typeof command.payload?.selectedDocumentSourceId === "string"
          ? z.uuid().parse(command.payload.selectedDocumentSourceId)
          : null;
      if (selectedSourceId && sourceId && sourceId !== selectedSourceId)
        return error("Selected Project Source cannot be changed", 409);
      const resolvedSourceId = selectedSourceId ?? sourceId;
      if (!resolvedSourceId) return error("Project Source is required", 400);
      const source = await sources
        .readDocument(actor.id, execution.projectId, resolvedSourceId)
        .catch(documentError);
      const lines = source.text.replace(/\r\n?/g, "\n").split("\n");
      if (lines.some((line) => line.length > 4_000))
        return error(
          "A document line exceeds the 4,000-character evidence limit",
          413
        );
      if (cursor >= lines.length)
        return error("Document page cursor is invalid", 400);
      let end = cursor;
      let size = 0;
      while (
        end < lines.length &&
        size + lines[end]!.length <= 32_000 &&
        end - cursor < 200
      ) {
        size += lines[end]!.length + 1;
        end += 1;
      }
      const afterRead = await current(
        managed,
        actor.id,
        executionId,
        executionGeneration
      );
      if (
        afterRead.command.id !== command.id ||
        afterRead.command.leaseToken !== command.leaseToken ||
        afterRead.command.payload?.selectedDocumentSourceId !==
          command.payload?.selectedDocumentSourceId ||
        afterRead.execution.projectId !== execution.projectId
      )
        return error("Managed Agent command changed during document read", 409);
      return workItemsFromDocReadPageSchema.parse({
        sourceId: source.sourceId,
        sourceRevisionId: source.sourceRevisionId,
        noteRevisionId: source.noteRevisionId,
        name: source.name,
        lines: lines
          .slice(cursor, end)
          .map((text, offset) => ({ lineNumber: cursor + offset + 1, text })),
        nextCursor: end < lines.length ? end : null,
        remaining: end < lines.length
      });
    }
  );

  app.post(
    "/v1/managed-conversations/:executionId/work-items-from-doc/preview",
    { preHandler: input.readRateLimit },
    async (request) => {
      const { actor, managed, sources, items } = await authorize(
        request,
        false
      );
      const { executionId } = workItemsFromDocParamsSchema.parse(
        request.params
      );
      const body = workItemsFromDocPreviewSchema.parse(request.body);
      const before = await current(
        managed,
        actor.id,
        executionId,
        body.executionGeneration
      );
      if (
        before.command.payload?.selectedDocumentSourceId &&
        before.command.payload.selectedDocumentSourceId !== body.sourceId
      )
        return error("Selected Project Source cannot be changed", 409);
      const source = await sources
        .readDocument(actor.id, before.execution.projectId, body.sourceId)
        .catch(documentError);
      if (
        source.sourceRevisionId !== body.sourceRevisionId ||
        source.noteRevisionId !== body.noteRevisionId
      )
        return error("Project Source revision changed", 409);
      const preview = await items
        .previewFromDocument({
          ownerUserId: actor.id,
          projectId: before.execution.projectId,
          sourceId: body.sourceId,
          sourceRevisionId: body.sourceRevisionId,
          noteRevisionId: body.noteRevisionId,
          sourceText: source.text,
          proposals: body.proposals.map((proposal) => ({
            lineNumber: proposal.lineNumber,
            sourceLine: proposal.sourceLine,
            title: proposal.title
          }))
        })
        .catch(documentError);
      const after = await current(
        managed,
        actor.id,
        executionId,
        body.executionGeneration
      );
      if (
        after.command.id !== before.command.id ||
        after.command.leaseToken !== before.command.leaseToken ||
        after.command.payload?.selectedDocumentSourceId !==
          before.command.payload?.selectedDocumentSourceId
      )
        return error("Managed Agent command changed", 409);
      return workItemsFromDocPreviewResultSchema.parse(preview);
    }
  );

  app.post(
    "/v1/managed-conversations/:executionId/work-items-from-doc/apply",
    { preHandler: input.writeRateLimit },
    async (request) => {
      const { actor, managed, sources, items } = await authorize(request, true);
      const { executionId } = workItemsFromDocParamsSchema.parse(
        request.params
      );
      const body = applyDocumentItemsSchema.parse(request.body);
      const { execution, command } = await current(
        managed,
        actor.id,
        executionId,
        body.executionGeneration
      );
      if (command.commandKind !== "start" && command.commandKind !== "prompt")
        return error("Document Work Item apply needs a User command", 409);
      if (
        command.id !== body.commandId ||
        command.leaseToken !== body.leaseToken
      )
        return error("Managed Agent command changed", 409);
      if (
        command.payload?.selectedDocumentSourceId &&
        command.payload.selectedDocumentSourceId !== body.sourceId
      )
        return error("Selected Project Source cannot be changed", 409);
      const source = await sources
        .readDocument(actor.id, execution.projectId, body.sourceId)
        .catch(documentError);
      if (
        source.sourceRevisionId !== body.sourceRevisionId ||
        source.noteRevisionId !== body.noteRevisionId
      )
        return error("Project Source revision changed", 409);
      let now: Date;
      try {
        new Intl.DateTimeFormat("en", { timeZone: body.timeZone });
        now = new Date();
      } catch {
        return error("Invalid local date context", 400);
      }
      const proposals = body.proposals.map((proposal) => {
        if (proposal.dueText && !proposal.sourceLine.includes(proposal.dueText))
          return error("Due date lacks exact source evidence", 409);
        const dueOn = proposal.dueText
          ? resolveDocumentDue(proposal.dueText, body.timeZone, now)
          : null;
        if (proposal.dueText && !dueOn)
          return error("Due date evidence is ambiguous", 409);
        return {
          lineNumber: proposal.lineNumber,
          sourceLine: proposal.sourceLine,
          title: proposal.title,
          goal: proposal.goal,
          dueOn
        };
      });
      return await items
        .createFromDocument({
          ownerUserId: actor.id,
          projectId: execution.projectId,
          sourceId: body.sourceId,
          sourceRevisionId: body.sourceRevisionId,
          noteRevisionId: body.noteRevisionId,
          sourceText: source.text,
          executionId,
          executionGeneration: body.executionGeneration,
          commandId: command.id,
          leaseToken: body.leaseToken!,
          proposals
        })
        .catch(documentError);
    }
  );
}
