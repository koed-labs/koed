import {
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

export const createProjectHqConversationClient =
  (input: {
    authority: () => Promise<ProjectHqAuthority>;
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
      request.operation === "start"
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
    await current();
    const payload = await input.requestJson(
      request.operation === "start" ? `${path}:start` : path,
      {
        method: request.operation === "read" ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(request.operation === "read"
          ? {}
          : {
              body: JSON.stringify(
                request.operation === "start"
                  ? {
                      prompt: request.prompt,
                      ...(request.permissionMode
                        ? { permissionMode: request.permissionMode }
                        : {})
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
