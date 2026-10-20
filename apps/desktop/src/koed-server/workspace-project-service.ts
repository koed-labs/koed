import type {
  ProjectsRequest,
  ProjectsResult
} from "../ipc/projects-protocol.js";
import { createWorkspaceProjectClient } from "./workspace-project-client.js";
import { z } from "zod";
import { workspaceProjectRecordSchema } from "@koed/shared/workspace-project-contract";
import type { createWorkspaceProjectPersonalClient } from "./workspace-project-personal-client.js";

const leaveStageSchema = z
  .object({
    teamId: z.uuid(),
    expectedTeamVersion: z.number().int().positive(),
    expectedMembershipVersion: z.number().int().positive(),
    expectedOwnedWorkspaceProjects: z.array(
      z.object({ id: z.uuid(), version: z.number().int().positive() }).strict()
    ),
    ownedSetHash: z.string().regex(/^[a-f0-9]{64}$/),
    stages: z.array(
      z.object({ workspaceProjectId: z.uuid(), stageId: z.uuid() }).strict()
    )
  })
  .strict();
const leaveFinishSchema = z
  .object({
    completed: z.array(
      z
        .object({
          stageId: z.uuid(),
          projectId: z.uuid().optional(),
          copied: z.number().int().nonnegative().optional(),
          alreadyApplied: z.boolean().optional()
        })
        .strict()
    )
  })
  .strict();
const sharedDispatchSchema = z
  .object({
    executionId: z.uuid(),
    reused: z.boolean(),
    dispatchKey: z.string().min(1),
    progress: z
      .object({ state: z.literal("dispatching"), stepLabel: z.string() })
      .strict(),
    teamBackendId: z.string().min(1),
    workspaceProjectId: z.uuid(),
    teamWorkItemVersion: z.number().int().positive()
  })
  .strict();

export class WorkspaceProjectRemoteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export const createWorkspaceProjectDesktopService = (input: {
  identityKey(): Promise<string>;
  sendTeam(
    teamBackendId: string,
    path: string,
    init?: RequestInit
  ): Promise<unknown>;
  loadPersonalCopy: ReturnType<
    typeof createWorkspaceProjectPersonalClient
  >["loadPersonalCopy"];
  loadPersonalSource(
    projectId: string,
    sourceId: string,
    teamBackendId: string,
    workspaceProjectId: string
  ): ReturnType<
    ReturnType<typeof createWorkspaceProjectPersonalClient>["sourceMetadata"]
  >;
  loadLinkedPersonalSources(
    workspaceProjectId: string,
    teamBackendId: string
  ): ReturnType<
    ReturnType<
      typeof createWorkspaceProjectPersonalClient
    >["linkedSourcesMetadata"]
  >;
  markPersonalMoved(
    projectId: string,
    workspaceProjectId: string,
    teamBackendId: string,
    workspaceId: string,
    expectedPersonalProjectVersion: number
  ): Promise<void>;
  stageTeamLeave(teamBackendId: string, teamId: string): Promise<unknown>;
  finishTeamLeave(teamBackendId: string, stageIds: string[]): Promise<unknown>;
  dispatchLocal(
    personalProjectId: string,
    itemId: string,
    value: {
      agentId: string;
      expectedProjectVersion: number;
      expectedMemberVersion: number;
      expectedWorkItemVersion: number;
    },
    teamBackendId: string
  ): Promise<unknown>;
  loadDispatches: ReturnType<
    typeof createWorkspaceProjectPersonalClient
  >["listSharedDispatches"];
  loadPersonalLink: ReturnType<
    typeof createWorkspaceProjectPersonalClient
  >["linkedProject"];
  uploadLinkedSource: ReturnType<
    typeof createWorkspaceProjectPersonalClient
  >["uploadLinkedSource"];
  readLinkedSource: ReturnType<
    typeof createWorkspaceProjectPersonalClient
  >["readLinkedSource"];
  onInvalidation?(
    teamBackendId: string,
    workspaceProjectId: string
  ): Promise<void>;
}) => {
  const clients = new Map<
    string,
    ReturnType<typeof createWorkspaceProjectClient>
  >();
  let activeIdentityKey: string | null = null;
  const checked = async <T>(
    identityKey: string,
    run: () => Promise<T>
  ): Promise<T> => {
    if ((await input.identityKey()) !== identityKey)
      throw new Error(
        "Projects profile changed during shared Project operation"
      );
    const result = await run();
    if ((await input.identityKey()) !== identityKey)
      throw new Error(
        "Projects profile changed during shared Project operation"
      );
    return result;
  };
  const clientFor = (teamBackendId: string, identityKey: string) => {
    let client = clients.get(teamBackendId);
    if (!client) {
      client = createWorkspaceProjectClient({
        sendTeam: (path, init) =>
          checked(identityKey, () => input.sendTeam(teamBackendId, path, init)),
        loadPersonalCopy: (...args) =>
          checked(identityKey, () => input.loadPersonalCopy(...args)),
        loadPersonalSource: (personalProjectId, sourceId, workspaceProjectId) =>
          checked(identityKey, () =>
            input.loadPersonalSource(
              personalProjectId,
              sourceId,
              teamBackendId,
              workspaceProjectId
            )
          ),
        loadLinkedPersonalSources: (workspaceProjectId) =>
          checked(identityKey, () =>
            input.loadLinkedPersonalSources(workspaceProjectId, teamBackendId)
          ),
        markPersonalMoved: (...args) =>
          checked(identityKey, () => input.markPersonalMoved(...args)),
        onAuthoritativeInvalidation: async (projectId) => {
          await checked(identityKey, async () => {
            await input.onInvalidation?.(teamBackendId, projectId);
          });
        }
      });
      clients.set(teamBackendId, client);
    }
    return client;
  };
  return async (
    request: Extract<
      ProjectsRequest,
      {
        operation:
          | "sharedRefresh"
          | "sharedCreateWorkItem"
          | "sharedPatchWorkItem"
          | "sharedFirstShare"
          | "sharedTeamLeaveStage"
          | "sharedTeamLeaveFinish"
          | "sharedAttachSource"
          | "sharedPatchSource"
          | "sharedUploadSource"
          | "sharedReadSource"
          | "sharedDispatchWorkItem"
          | "sharedDispatches";
      }
    >
  ): Promise<ProjectsResult> => {
    const identityKey = await input.identityKey();
    if (
      request.operation === "sharedUploadSource" &&
      request.expectedProfileKey &&
      request.expectedProfileKey !== identityKey
    )
      throw new Error("Projects profile changed before shared Source upload");
    if (activeIdentityKey !== identityKey) {
      clients.clear();
      activeIdentityKey = identityKey;
    }
    if (request.operation === "sharedDispatches") {
      const items = await checked(identityKey, () =>
        input.loadDispatches(request.personalProjectId)
      );
      return { operation: request.operation, items };
    }
    if (request.operation === "sharedDispatchWorkItem") {
      const link = await checked(identityKey, () =>
        input.loadPersonalLink(request.personalProjectId)
      );
      const dispatch = sharedDispatchSchema.parse(
        await checked(identityKey, () =>
          input.dispatchLocal(
            request.personalProjectId,
            request.itemId,
            {
              agentId: request.agentId,
              expectedProjectVersion: request.expectedProjectVersion,
              expectedMemberVersion: request.expectedMemberVersion,
              expectedWorkItemVersion: request.expectedWorkItemVersion
            },
            link.teamBackendId
          )
        )
      );
      if (
        dispatch.teamBackendId !== link.teamBackendId ||
        dispatch.workspaceProjectId !== link.workspaceProjectId
      )
        throw new Error("Private shared dispatch link changed");
      return {
        operation: request.operation,
        executionId: dispatch.executionId,
        reused: dispatch.reused,
        dispatchKey: dispatch.dispatchKey,
        progress: dispatch.progress
      };
    }
    const client = clientFor(request.teamBackendId, identityKey);
    if (request.operation === "sharedUploadSource") {
      const uploaded = await checked(identityKey, () =>
        input.uploadLinkedSource(
          request.personalProjectId,
          request.workspaceProjectId,
          request.teamBackendId,
          request.upload
        )
      );
      const source = await client.attachSource(
        request.workspaceProjectId,
        request.personalProjectId,
        uploaded.id
      );
      return { operation: request.operation, source };
    }
    if (request.operation === "sharedReadSource") {
      const content = await checked(identityKey, () =>
        input.readLinkedSource(
          request.personalProjectId,
          request.workspaceProjectId,
          request.teamBackendId,
          request.sourceId
        )
      );
      return { operation: request.operation, content };
    }
    if (request.operation === "sharedFirstShare") {
      const project = workspaceProjectRecordSchema.parse(
        await client.firstShare({
          ...request.value,
          personalProjectId: request.personalProjectId,
          teamBackendId: request.teamBackendId
        })
      );
      if ((await input.identityKey()) !== identityKey)
        throw new Error("Projects profile changed during first share");
      return { operation: request.operation, project };
    }
    if (request.operation === "sharedTeamLeaveStage") {
      const review = leaveStageSchema.parse(
        await checked(identityKey, () =>
          input.stageTeamLeave(request.teamBackendId, request.teamId)
        )
      );
      if ((await input.identityKey()) !== identityKey)
        throw new Error("Projects profile changed during Team leave stage");
      return { operation: request.operation, review };
    }
    if (request.operation === "sharedTeamLeaveFinish") {
      const finished = leaveFinishSchema.parse(
        await checked(identityKey, () =>
          input.finishTeamLeave(request.teamBackendId, request.stageIds)
        )
      );
      if ((await input.identityKey()) !== identityKey)
        throw new Error("Projects profile changed during Team leave finish");
      return { operation: request.operation, ...finished };
    }
    if (request.operation === "sharedAttachSource") {
      const source = await client.attachSource(
        request.workspaceProjectId,
        request.personalProjectId,
        request.sourceId
      );
      if ((await input.identityKey()) !== identityKey)
        throw new Error("Projects profile changed during Source attach");
      return { operation: request.operation, source };
    }
    if (request.operation === "sharedPatchSource") {
      const source = await client.patchSource(
        request.workspaceProjectId,
        request.sourceId,
        request.value
      );
      if ((await input.identityKey()) !== identityKey)
        throw new Error("Projects profile changed during Source edit");
      return { operation: request.operation, source };
    }
    if (request.operation === "sharedRefresh") {
      const state = await client.refresh(request.workspaceProjectId);
      if ((await input.identityKey()) !== identityKey) {
        clients.clear();
        activeIdentityKey = null;
        throw new Error("Projects profile changed during shared Project read");
      }
      return { operation: request.operation, state };
    }
    try {
      const item =
        request.operation === "sharedCreateWorkItem"
          ? await client.createWorkItem(
              request.workspaceProjectId,
              request.value
            )
          : await client.patchWorkItem(
              request.workspaceProjectId,
              request.itemId,
              request.value
            );
      if ((await input.identityKey()) !== identityKey) {
        clients.clear();
        activeIdentityKey = null;
        throw new Error("Projects profile changed during shared Project write");
      }
      return { operation: request.operation, outcome: { status: "ok", item } };
    } catch (error) {
      if (
        !(error instanceof WorkspaceProjectRemoteError) ||
        error.statusCode !== 409
      )
        throw error;
      const state = await client.refresh(request.workspaceProjectId);
      if ((await input.identityKey()) !== identityKey)
        throw new Error(
          "Projects profile changed during shared Project conflict refresh",
          { cause: error }
        );
      return {
        operation: request.operation,
        outcome: { status: "conflict", state }
      };
    }
  };
};
