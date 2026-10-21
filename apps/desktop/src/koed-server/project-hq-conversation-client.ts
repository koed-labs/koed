import {
  projectHqSchema,
  projectHqConversationSchema,
  projectHqConversationReadSchema
} from "@koed/shared/project-contract";
import { z } from "zod";
import {
  projectHqConversationRequestSchema,
  projectHqConversationResultSchema,
  type ProjectHqConversationRequest,
  type ProjectHqConversationResult
} from "../ipc/project-hq-conversation-protocol.js";

export type ProjectHqAuthority = Readonly<{
  key: string;
  ownerId: string;
  apiOrigin: string;
  authorization: string;
  operationFamilies: readonly string[];
}>;

const startResponseSchema = z
  .object({
    execution: z.object({ id: z.uuid(), projectId: z.uuid() }).passthrough(),
    command: z
      .object({
        id: z.uuid(),
        state: z.enum(["blocked", "queued", "dispatching", "completed"])
      })
      .passthrough()
  })
  .passthrough();

const catchUpResponseSchema = z
  .object({
    status: z.enum([
      "nothing",
      "starting",
      "waiting",
      "queued",
      "recovered",
      "retry_available",
      "reconciliation_required"
    ]),
    executionId: z.uuid().optional(),
    commandId: z.uuid().optional()
  })
  .strict();

const retryCatchUpResponseSchema = z
  .object({
    status: z.enum(["queued", "completed"]),
    executionId: z.uuid(),
    commandId: z.uuid(),
    commandState: z.enum([
      "queued",
      "blocked",
      "dispatching",
      "completed",
      "failed",
      "indeterminate",
      "canceled"
    ])
  })
  .strict();

export const createProjectHqConversationClient =
  (input: {
    authority: () => Promise<ProjectHqAuthority>;
    teamCredential?: (backendId: string) => string;
    requestJson: (
      path: string,
      init: RequestInit,
      authority: ProjectHqAuthority
    ) => Promise<Record<string, unknown>>;
  }) =>
  async (
    value: ProjectHqConversationRequest
  ): Promise<ProjectHqConversationResult> => {
    const request = projectHqConversationRequestSchema.parse(value);
    const authority = await input.authority();
    const required =
      request.operation === "start" ||
      request.operation === "catch_up" ||
      request.operation === "retry_catch_up"
        ? ["personal_collaboration_write", "managed_execution"]
        : [
            request.operation === "read"
              ? "personal_collaboration_read"
              : "personal_collaboration_write"
          ];
    if (
      !required.every((family) => authority.operationFamilies.includes(family))
    )
      throw new Error("Project HQ Conversation authority is unavailable.");
    const current = async () => {
      if ((await input.authority()).key !== authority.key)
        throw new Error("Project HQ profile changed during request.");
    };
    const path = `/v1/projects/${encodeURIComponent(request.projectId)}/hq/conversation`;
    let teamAuthorization: string | null = null;
    if (
      request.operation === "catch_up" ||
      request.operation === "retry_catch_up"
    ) {
      await current();
      const hq = projectHqSchema.parse(
        await input.requestJson(
          `/v1/projects/${encodeURIComponent(request.projectId)}/hq`,
          { method: "GET" },
          authority
        )
      );
      await current();
      if (hq.project.id !== request.projectId)
        throw new Error("Project HQ identity mismatch.");
      if (hq.project.teamBackendId || hq.project.workspaceProjectId) {
        if (
          !hq.project.teamBackendId ||
          !hq.project.workspaceProjectId ||
          !input.teamCredential
        )
          throw new Error("Linked Team Project authority is unavailable.");
        teamAuthorization = input.teamCredential(hq.project.teamBackendId);
        if (!/^Koed-Device\s+[^:\s]+:[^\s]+$/i.test(teamAuthorization))
          throw new Error("Linked Team Project authority is unavailable.");
      }
    }
    await current();
    const payload = await input.requestJson(
      request.operation === "start"
        ? `${path}:start`
        : request.operation === "catch_up"
          ? `/v1/projects/${encodeURIComponent(request.projectId)}/hq/catch-up`
          : request.operation === "retry_catch_up"
            ? `/v1/projects/${encodeURIComponent(request.projectId)}/hq/catch-up/retry`
            : path,
      {
        method: request.operation === "read" ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(teamAuthorization
            ? { "x-koed-team-client-credential": teamAuthorization }
            : {})
        },
        ...(request.operation === "read"
          ? {}
          : {
              body: JSON.stringify(
                request.operation === "start"
                  ? {
                      prompt: request.prompt,
                      ...(request.selectedDocumentSourceId
                        ? {
                            selectedDocumentSourceId:
                              request.selectedDocumentSourceId
                          }
                        : {}),
                      ...(request.permissionMode
                        ? { permissionMode: request.permissionMode }
                        : {})
                    }
                  : request.operation === "retry_catch_up"
                    ? {
                        failedCommandId: request.failedCommandId,
                        retryRequestId: request.retryRequestId
                      }
                    : {}
              )
            })
      },
      authority
    );
    await current();
    if (request.operation === "read") {
      const value = projectHqConversationReadSchema.parse(payload);
      if (
        value.conversation &&
        value.conversation.projectId !== request.projectId
      )
        throw new Error("Project HQ Conversation identity mismatch.");
      return projectHqConversationResultSchema.parse({
        operation: "read",
        value
      });
    }
    if (request.operation === "reserve") {
      const conversation = projectHqConversationSchema.parse(payload);
      if (conversation.projectId !== request.projectId)
        throw new Error("Project HQ Conversation identity mismatch.");
      return projectHqConversationResultSchema.parse({
        operation: "reserve",
        value: conversation
      });
    }
    if (request.operation === "catch_up") {
      const result = catchUpResponseSchema.parse(payload);
      return projectHqConversationResultSchema.parse({
        operation: "catch_up",
        projectId: request.projectId,
        status: result.status,
        executionId: result.executionId ?? null,
        commandId: result.commandId ?? null
      });
    }
    if (request.operation === "retry_catch_up") {
      const result = retryCatchUpResponseSchema.parse(payload);
      return projectHqConversationResultSchema.parse({
        operation: "retry_catch_up",
        projectId: request.projectId,
        ...result
      });
    }
    const started = startResponseSchema.parse(payload);
    if (started.execution.projectId !== request.projectId)
      throw new Error("Project HQ execution Project identity mismatch.");
    return projectHqConversationResultSchema.parse({
      operation: "start",
      projectId: request.projectId,
      executionId: started.execution.id,
      commandId: started.command.id,
      commandState: started.command.state
    });
  };
