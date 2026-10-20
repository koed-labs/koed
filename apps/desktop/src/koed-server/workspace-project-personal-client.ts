import { z } from "zod";
import {
  workspaceProjectCopySchema,
  projectSourceSchema,
  projectSourceUploadSchema,
  projectSourceReadSchema
} from "@koed/shared";

const snapshotSchema = workspaceProjectCopySchema
  .omit({
    expectedVersion: true
  })
  .extend({
    personalProjectVersion: z.number().int().positive()
  })
  .strict();

export const createWorkspaceProjectPersonalClient = (
  sendPersonal: (path: string, init?: RequestInit) => Promise<unknown>,
  teamClientAuthorization: (
    teamBackendId: string,
    family?: "team_workspace_read" | "team_workspace_write"
  ) => string
) => ({
  async loadPersonalCopy(
    projectId: string,
    teamBackendId: string,
    shareAttemptKey: string
  ) {
    const prepared = z
      .object({
        snapshot: snapshotSchema,
        manifestHash: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-prepare`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-koed-team-client-credential":
                teamClientAuthorization(teamBackendId)
            },
            body: JSON.stringify({ teamBackendId, shareAttemptKey })
          }
        )
      );
    return prepared.snapshot;
  },
  async markPersonalMoved(
    projectId: string,
    workspaceProjectId: string,
    teamBackendId: string,
    _workspaceId: string,
    expectedPersonalProjectVersion: number
  ) {
    await sendPersonal(
      `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-confirm`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-koed-team-client-credential":
            teamClientAuthorization(teamBackendId)
        },
        body: JSON.stringify({
          expectedPersonalProjectVersion,
          teamBackendId,
          workspaceProjectId
        })
      }
    );
  },
  async reconcileInvalidation(projectId: string, teamBackendId: string) {
    await sendPersonal(
      `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-reconcile`,
      {
        method: "POST",
        headers: {
          "x-koed-team-client-credential":
            teamClientAuthorization(teamBackendId)
        }
      }
    );
  },
  async reconcileWorkspaceInvalidation(
    workspaceProjectId: string,
    teamBackendId: string
  ) {
    await sendPersonal(
      `/v1/local-edge/workspace-projects/${encodeURIComponent(workspaceProjectId)}/reconcile`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-koed-team-client-credential":
            teamClientAuthorization(teamBackendId)
        },
        body: JSON.stringify({ teamBackendId })
      }
    );
  },
  async stageTeamLeave(teamBackendId: string, teamId: string) {
    return sendPersonal("/v1/local-edge/workspace-project-team-leave-stage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-koed-team-client-credential": teamClientAuthorization(teamBackendId)
      },
      body: JSON.stringify({ teamBackendId, teamId })
    });
  },
  async sourceMetadata(
    projectId: string,
    sourceId: string,
    teamBackendId: string,
    workspaceProjectId: string
  ) {
    const query = new URLSearchParams({ teamBackendId, workspaceProjectId });
    return z
      .object({
        id: z.uuid(),
        name: z.string(),
        kind: z.string(),
        status: z.string(),
        personalNoteId: z.uuid().nullable(),
        personalNoteRevisionId: z.uuid().nullable()
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/projects/${encodeURIComponent(projectId)}/workspace-project-source-metadata/${encodeURIComponent(sourceId)}?${query}`
        )
      );
  },
  async uploadLinkedSource(
    projectId: string,
    workspaceProjectId: string,
    teamBackendId: string,
    upload: z.infer<typeof projectSourceUploadSchema>
  ) {
    return projectSourceSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-sources/upload`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-koed-team-client-credential": teamClientAuthorization(
              teamBackendId,
              "team_workspace_write"
            )
          },
          body: JSON.stringify({ teamBackendId, workspaceProjectId, upload })
        }
      )
    );
  },
  async linkedSourceMetadata(
    workspaceProjectId: string,
    teamBackendId: string,
    sourceId: string
  ) {
    const query = new URLSearchParams({ teamBackendId });
    return z
      .object({
        id: z.uuid(),
        name: z.string(),
        kind: z.string(),
        status: z.string(),
        personalNoteId: z.uuid().nullable(),
        personalNoteRevisionId: z.uuid().nullable()
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/local-edge/workspace-projects/${encodeURIComponent(workspaceProjectId)}/source-metadata/${encodeURIComponent(sourceId)}?${query}`
        )
      );
  },
  async linkedSourcesMetadata(
    workspaceProjectId: string,
    teamBackendId: string
  ) {
    const query = new URLSearchParams({ teamBackendId });
    return z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string(),
            kind: z.string(),
            status: z.string(),
            personalNoteId: z.uuid().nullable(),
            personalNoteRevisionId: z.uuid().nullable()
          })
          .strict()
      )
      .parse(
        await sendPersonal(
          `/v1/local-edge/workspace-projects/${encodeURIComponent(workspaceProjectId)}/source-metadata?${query}`
        )
      );
  },
  async readLinkedSource(
    projectId: string,
    workspaceProjectId: string,
    teamBackendId: string,
    teamSourceId: string
  ) {
    const query = new URLSearchParams({ teamBackendId, workspaceProjectId });
    return projectSourceReadSchema.parse(
      await sendPersonal(
        `/v1/local-edge/projects/${encodeURIComponent(projectId)}/workspace-project-sources/${encodeURIComponent(teamSourceId)}/content?${query}`,
        {
          method: "GET",
          headers: {
            "x-koed-team-client-credential":
              teamClientAuthorization(teamBackendId)
          }
        }
      )
    );
  },
  async dispatchSharedWorkItem(
    projectId: string,
    itemId: string,
    value: {
      agentId: string;
      expectedProjectVersion: number;
      expectedMemberVersion: number;
      expectedWorkItemVersion: number;
    },
    teamBackendId: string
  ) {
    return sendPersonal(
      `/v1/projects/${encodeURIComponent(projectId)}/shared-work-items/${encodeURIComponent(itemId)}/dispatch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-koed-team-client-credential": teamClientAuthorization(
            teamBackendId,
            "team_workspace_write"
          )
        },
        body: JSON.stringify(value)
      }
    );
  },
  async listSharedDispatches(projectId: string) {
    return z
      .object({
        items: z
          .array(
            z
              .object({
                teamWorkItemId: z.uuid(),
                executionId: z.uuid(),
                agentId: z.uuid()
              })
              .strict()
          )
          .max(500)
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/projects/${encodeURIComponent(projectId)}/shared-work-items/dispatches`
        )
      ).items;
  },
  async linkedProject(projectId: string) {
    return z
      .object({
        ownerUserId: z.uuid(),
        teamBackendId: z.string().min(1),
        workspaceProjectId: z.uuid()
      })
      .strict()
      .parse(
        await sendPersonal(
          `/v1/projects/${encodeURIComponent(projectId)}/workspace-project-link`
        )
      );
  },
  async finishTeamLeave(teamBackendId: string, stageIds: string[]) {
    return sendPersonal("/v1/local-edge/workspace-project-team-leave-finish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-koed-team-client-credential": teamClientAuthorization(teamBackendId)
      },
      body: JSON.stringify({ teamBackendId, stageIds })
    });
  }
});
