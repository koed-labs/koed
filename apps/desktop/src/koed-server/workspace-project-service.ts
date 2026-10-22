import type {
  ProjectsRequest,
  ProjectsResult,
  WorkspaceProjectShareContext
} from "../ipc/projects-protocol.js";
import { workspaceProjectMembersSchema } from "@koed/shared/workspace-project-contract";
import { createWorkspaceProjectClient } from "./workspace-project-client.js";
import { z } from "zod";
import { workspaceProjectRecordSchema } from "@koed/shared/workspace-project-contract";
import type { createWorkspaceProjectPersonalClient } from "./workspace-project-personal-client.js";
import type {
  ProjectPolicyInitialStage,
  ProjectPolicyReview
} from "./project-share-policy-client.js";

export const projectPolicyRendererProjection = (
  policy: ProjectPolicyReview,
  pendingAction: "enable" | "revoke" | null = null,
  reviewRequired = false
) => ({
  status: policy.status,
  pendingAction,
  reviewRequired,
  eligibleCount: policy.eligibleCount,
  reviewSources: policy.reviewSources.map(({ reviewLabel, eligible }) => ({
    reviewLabel,
    eligible
  }))
});

const leaveStageSchema = z
  .object({
    teamId: z.uuid(),
    expectedTeamVersion: z.number().int().positive(),
    expectedMembershipVersion: z.number().int().positive(),
    expectedOwnedWorkspaceProjects: z.array(
      z.object({ id: z.uuid(), version: z.number().int().positive() }).strict()
    ),
    ownedSetHash: z.string().regex(/^[a-f0-9]{64}$/),
    copyManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    pendingLeaveOperationId: z.uuid().nullable().optional(),
    stages: z.array(
      z
        .object({
          workspaceProjectId: z.uuid(),
          payloadHash: z.string().regex(/^[a-f0-9]{64}$/)
        })
        .strict()
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
const joinedMemberProofSchema = z
  .object({
    projectId: z.uuid(),
    workspaceId: z.uuid(),
    teamId: z.uuid(),
    memberTeamMemberId: z.uuid(),
    memberUserId: z.uuid(),
    projectVersion: z.number().int().positive(),
    memberVersion: z.number().int().positive()
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
  projectPolicyStatus?(personalProjectId: string): Promise<{
    policy: ProjectPolicyReview;
    pendingAction: "enable" | "revoke" | null;
    reviewRequired: boolean;
  }>;
  projectPolicyEnable?(personalProjectId: string): Promise<{
    policy: ProjectPolicyReview;
    initialStage: ProjectPolicyInitialStage;
  }>;
  projectPolicyRevoke?(personalProjectId: string): Promise<ProjectPolicyReview>;
  projectPolicyStageInitial?(personalProjectId: string): Promise<{
    policy: ProjectPolicyReview;
    initialStage: ProjectPolicyInitialStage;
  }>;
  projectChatMakePrivate?(
    personalProjectId: string,
    sessionId: string
  ): Promise<{ state: "private" }>;
  projectChatStatus?(
    personalProjectId: string,
    sessionId: string
  ): Promise<"private" | "pending" | "shared" | "unshared" | "ineligible">;
  projectChatOffer?(
    personalProjectId: string,
    sessionId: string,
    reason: "moved_in" | "share_again"
  ): Promise<{ state: "pending" | "activated" | "canceled" }>;
  identityKey(): Promise<string>;
  loadShareContext?(): Promise<WorkspaceProjectShareContext>;
  loadPendingShare?: ReturnType<
    typeof createWorkspaceProjectPersonalClient
  >["pendingShare"];
  cancelPendingShare?: ReturnType<
    typeof createWorkspaceProjectPersonalClient
  >["cancelPendingShare"];
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
  createJoinedProject: ReturnType<
    typeof createWorkspaceProjectPersonalClient
  >["createJoinedProject"];
  confirmJoinedProject: ReturnType<
    typeof createWorkspaceProjectPersonalClient
  >["confirmJoinedProject"];
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
      textActionId?: string;
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
          | "sharedJoinProject"
          | "sharedShareContext"
          | "sharedPendingShare"
          | "sharedCancelPendingShare"
          | "sharedMembers"
          | "sharedTeamLeaveStage"
          | "sharedTeamLeaveFinish"
          | "sharedAttachSource"
          | "sharedPatchSource"
          | "sharedUploadSource"
          | "sharedReadSource"
          | "sharedDispatchWorkItem"
          | "sharedDispatches"
          | "sharedPolicyStatus"
          | "sharedPolicyEnable"
          | "sharedPolicyRevoke"
          | "sharedPolicyStageInitial"
          | "sharedChatMakePrivate"
          | "sharedChatStatus"
          | "sharedChatOffer";
      }
    >
  ): Promise<ProjectsResult> => {
    const identityKey = await input.identityKey();
    if (request.operation === "sharedPolicyStatus") {
      if (!input.projectPolicyStatus)
        throw new Error("Project summary sharing is unavailable");
      const status = await checked(identityKey, () =>
        input.projectPolicyStatus!(request.personalProjectId)
      );
      return {
        operation: request.operation,
        policy: projectPolicyRendererProjection(
          status.policy,
          status.pendingAction,
          status.reviewRequired
        )
      };
    }
    if (request.operation === "sharedPolicyEnable") {
      if (!input.projectPolicyEnable)
        throw new Error("Project summary sharing is unavailable");
      const result = await checked(identityKey, () =>
        input.projectPolicyEnable!(request.personalProjectId)
      );
      return {
        operation: request.operation,
        policy: projectPolicyRendererProjection(result.policy),
        initialStage: result.initialStage
      };
    }
    if (request.operation === "sharedPolicyRevoke") {
      if (!input.projectPolicyRevoke)
        throw new Error("Project summary sharing is unavailable");
      return {
        operation: request.operation,
        policy: projectPolicyRendererProjection(
          await checked(identityKey, () =>
            input.projectPolicyRevoke!(request.personalProjectId)
          )
        )
      };
    }
    if (request.operation === "sharedPolicyStageInitial") {
      if (!input.projectPolicyStageInitial)
        throw new Error("Project summary sharing is unavailable");
      const result = await checked(identityKey, () =>
        input.projectPolicyStageInitial!(request.personalProjectId)
      );
      return {
        operation: request.operation,
        policy: projectPolicyRendererProjection(result.policy),
        initialStage: result.initialStage
      };
    }
    if (request.operation === "sharedChatMakePrivate") {
      if (!input.projectChatMakePrivate)
        throw new Error("Project chat privacy is unavailable");
      const result = await checked(identityKey, () =>
        input.projectChatMakePrivate!(
          request.personalProjectId,
          request.sessionId
        )
      );
      return { operation: request.operation, state: result.state };
    }
    if (request.operation === "sharedChatStatus") {
      if (!input.projectChatStatus)
        throw new Error("Project chat sharing status is unavailable");
      return {
        operation: request.operation,
        state: await checked(identityKey, () =>
          input.projectChatStatus!(request.personalProjectId, request.sessionId)
        )
      };
    }
    if (request.operation === "sharedChatOffer") {
      if (!input.projectChatOffer)
        throw new Error("Project chat summary offer is unavailable");
      const result = await checked(identityKey, () =>
        input.projectChatOffer!(
          request.personalProjectId,
          request.sessionId,
          request.reason
        )
      );
      return { operation: request.operation, state: result.state };
    }
    if (request.operation === "sharedShareContext") {
      if (!input.loadShareContext)
        throw new Error("Shared Project context is unavailable");
      const context = await checked(identityKey, input.loadShareContext);
      return { operation: request.operation, context };
    }
    if (request.operation === "sharedPendingShare") {
      if (!input.loadShareContext || !input.loadPendingShare)
        throw new Error("Pending Project share recovery is unavailable");
      const context = await checked(identityKey, input.loadShareContext);
      if (
        context.state !== "ready" ||
        !context.backendId ||
        !context.principalId
      )
        throw new Error("Team enrollment is required to recover this share");
      const attempt = await checked(identityKey, () =>
        input.loadPendingShare!(request.personalProjectId, context.backendId!)
      );
      if (
        attempt?.teamBackendId !== undefined &&
        attempt.teamBackendId !== context.backendId
      )
        throw new Error("Pending share backend changed");
      return { operation: request.operation, attempt };
    }
    if (request.operation === "sharedCancelPendingShare") {
      if (!input.loadShareContext || !input.cancelPendingShare)
        throw new Error("Pending Project share cancellation is unavailable");
      const context = await checked(identityKey, input.loadShareContext);
      if (
        context.state !== "ready" ||
        !context.backendId ||
        !context.principalId
      )
        throw new Error("Team enrollment is required to cancel this share");
      const result = await checked(identityKey, () =>
        input.cancelPendingShare!(request.personalProjectId, context.backendId!)
      );
      return { operation: request.operation, canceled: result.canceled };
    }
    if (request.operation === "sharedMembers") {
      if (!input.loadShareContext)
        throw new Error("Shared Project people are unavailable");
      const context = await checked(identityKey, input.loadShareContext);
      if (
        context.state !== "ready" ||
        context.backendId !== request.teamBackendId
      )
        throw new Error("Team context changed before member read");
      const members = workspaceProjectMembersSchema.parse(
        await checked(identityKey, () =>
          input.sendTeam(
            request.teamBackendId,
            `/v1/workspace-projects/${request.workspaceProjectId}/members`
          )
        )
      );
      if (members.projectId !== request.workspaceProjectId)
        throw new Error("Shared Project people identity changed");
      return { operation: request.operation, members };
    }
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
              expectedWorkItemVersion: request.expectedWorkItemVersion,
              ...(request.textActionId
                ? { textActionId: request.textActionId }
                : {})
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
      const shareContext = input.loadShareContext
        ? await checked(identityKey, input.loadShareContext)
        : null;
      const selectedTeam = shareContext?.teams.find(
        (team) => team.id === request.value.teamId
      );
      if (
        shareContext?.state !== "ready" ||
        shareContext.backendId !== request.teamBackendId ||
        !shareContext.principalId ||
        !selectedTeam?.workspaces.some(
          (workspace) =>
            workspace.id === request.value.workspaceId &&
            workspace.access === "write"
        )
      )
        throw new Error("Current Team sharing authority is unavailable");
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
    if (request.operation === "sharedJoinProject") {
      if (!input.loadShareContext)
        throw new Error("Current Team sharing authority is unavailable");
      const context = await checked(identityKey, input.loadShareContext);
      if (
        context.state !== "ready" ||
        context.backendId !== request.teamBackendId ||
        !context.principalId
      )
        throw new Error("Current Team sharing authority is unavailable");
      const teamProject = workspaceProjectRecordSchema.parse(
        await checked(identityKey, () =>
          input.sendTeam(
            request.teamBackendId,
            `/v1/workspace-projects/${request.workspaceProjectId}/join`,
            { method: "POST" }
          )
        )
      );
      if (
        teamProject.id !== request.workspaceProjectId ||
        teamProject.lifecycle !== "active" ||
        !teamProject.copiedAt ||
        !context.teams.some((team) =>
          team.workspaces.some(
            (workspace) =>
              workspace.id === teamProject.workspaceId &&
              workspace.access === "write"
          )
        )
      )
        throw new Error("Joined Team Project authority changed");
      const proof = joinedMemberProofSchema.parse(
        await checked(identityKey, () =>
          input.sendTeam(
            request.teamBackendId,
            `/v1/workspace-projects/${request.workspaceProjectId}/member-link-proof`
          )
        )
      );
      if (
        proof.projectId !== teamProject.id ||
        proof.teamId !== teamProject.teamId ||
        proof.workspaceId !== teamProject.workspaceId ||
        proof.memberUserId !== context.principalId
      )
        throw new Error("Joined Team member proof changed");
      const created = await checked(identityKey, () =>
        input.createJoinedProject(
          teamProject.id,
          request.teamBackendId,
          teamProject.name
        )
      );
      const project = await checked(identityKey, () =>
        input.confirmJoinedProject(
          created.id,
          teamProject.id,
          request.teamBackendId,
          created.version
        )
      );
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
