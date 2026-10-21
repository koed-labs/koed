import { z } from "zod";
import {
  fetchBoundedJson,
  readLocalEdgeUpstreamRegistry,
  upstreamBackendById,
  workspaceProjectWorkItemCreateSchema,
  workspaceProjectWorkItemSchema
} from "@koed/shared";
import type {
  ManagedTextActionTeamAuthority,
  ManagedTextActionTeamReceipt,
  PersonalWorkspaceProjectRepository,
  ScheduledJobTeamAuthority
} from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { safeUpstreamProxyUrl } from "../local-edge/upstream-routing.js";

const itemProofSchema = z
  .object({
    projectId: z.uuid(),
    itemId: z.uuid(),
    projectVersion: z.number().int().positive(),
    memberVersion: z.number().int().positive(),
    workItemVersion: z.number().int().positive(),
    workItemTitle: z.string().min(1).max(160)
  })
  .strict();
const dispatchStatusSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    status: z.enum(["doing", "review", "done", "blocked"]),
    stepLabel: z.string().nullable(),
    dispatchKey: z.string(),
    prUrl: z.string().nullable(),
    prState: z.string().nullable()
  })
  .strict();
const teamTextEffectSchema = z
  .object({
    item: workspaceProjectWorkItemSchema,
    effectNonceHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

/** Current enrolled Team principal plus exact Personal link, never renderer Team IDs. */
export function createManagedTextActionTeamAdapter(
  context: ApiRouteContext,
  personal: PersonalWorkspaceProjectRepository,
  lifecycleAuthority: ScheduledJobTeamAuthority
): {
  authority: ManagedTextActionTeamAuthority;
  receipt: ManagedTextActionTeamReceipt;
  applyTodoAdd: (input: {
    ownerUserId: string;
    projectId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    actionId: string;
    effectNonce: string;
    title: string;
    goal: string;
    dueOn: string | null;
    expectedProjectVersion: number;
    expectedMemberVersion: number;
  }) => Promise<void>;
} {
  const requestTeam = async (
    input: {
      ownerUserId: string;
      projectId: string;
      teamBackendId: string;
      workspaceProjectId: string;
    },
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
    expected?: { projectVersion: number; memberVersion: number }
  ) => {
    if (!context.localEdge.remoteOperationsAllowed())
      throw new Error("Team authority unavailable");
    const link = await personal.getLink(input.ownerUserId, input.projectId);
    const principal = await personal.principalBinding(
      input.ownerUserId,
      input.teamBackendId
    );
    if (
      !link ||
      !principal ||
      link.teamBackendId !== input.teamBackendId ||
      link.workspaceProjectId !== input.workspaceProjectId
    )
      throw new Error("Personal Project Team binding changed");
    const backend = upstreamBackendById(
      readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
      input.teamBackendId
    );
    if (!backend) throw new Error("Team backend unavailable");
    const authorization =
      context.localEdge.resolveUpstreamAuthorization(backend);
    if (!authorization || !/^Koed-Device\s+[^:\s]+:[^\s]+$/.test(authorization))
      throw new Error("Sealed Team device credential unavailable");
    // The lifecycle reader verifies this same credential's Team principal and
    // exact link before the item read. The Team route checks membership again.
    const lifecycle = await lifecycleAuthority(input);
    if (
      expected &&
      (lifecycle.projectVersion !== expected.projectVersion ||
        lifecycle.memberVersion !== expected.memberVersion)
    )
      throw new Error("Team Project authority changed before text action");
    const result = await fetchBoundedJson(
      context.localEdge.fetch,
      safeUpstreamProxyUrl(backend, path),
      {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization,
          ...(body ? { "content-type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      },
      { timeoutMs: 15_000, maxBytes: 64_000 }
    );
    if (!result.response.ok) throw new Error("Team Work Item authority denied");
    const after = await personal.getLink(input.ownerUserId, input.projectId);
    if (
      !after ||
      after.teamBackendId !== input.teamBackendId ||
      after.workspaceProjectId !== input.workspaceProjectId ||
      (await personal.principalBinding(
        input.ownerUserId,
        input.teamBackendId
      )) !== principal
    )
      throw new Error("Team principal or Project binding changed");
    return { payload: result.payload, lifecycle };
  };
  const read = async (input: Parameters<typeof requestTeam>[0], path: string) =>
    (await requestTeam(input, path)).payload;
  return {
    applyTodoAdd: async (input) => {
      const { payload } = await requestTeam(
        input,
        `/v1/workspace-projects/${input.workspaceProjectId}/work-items`,
        "POST",
        workspaceProjectWorkItemCreateSchema.parse({
          idempotencyKey: input.actionId,
          textActionId: input.actionId,
          textActionNonce: input.effectNonce,
          kind: "todo",
          title: input.title,
          goal: input.goal,
          status: "todo",
          dueOn: input.dueOn,
          expectedProjectVersion: input.expectedProjectVersion,
          expectedMemberVersion: input.expectedMemberVersion
        }),
        {
          projectVersion: input.expectedProjectVersion,
          memberVersion: input.expectedMemberVersion
        }
      );
      const item = workspaceProjectWorkItemSchema.parse(payload);
      if (
        item.title !== input.title ||
        item.goal !== input.goal ||
        item.dueOn !== input.dueOn
      )
        throw new Error("Team text action result changed");
    },
    authority: async (input) => {
      const lifecycle = await lifecycleAuthority(input);
      if (!input.workItemId)
        return {
          teamProjectVersion: lifecycle.projectVersion,
          teamMemberVersion: lifecycle.memberVersion
        };
      const item = itemProofSchema.parse(
        await read(
          input,
          `/v1/workspace-projects/${input.workspaceProjectId}/work-items/${input.workItemId}/proposal-proof`
        )
      );
      if (
        item.projectId !== input.workspaceProjectId ||
        item.itemId !== input.workItemId ||
        item.projectVersion !== lifecycle.projectVersion ||
        item.memberVersion !== lifecycle.memberVersion
      )
        throw new Error("Team Work Item proposal changed");
      return {
        teamProjectVersion: item.projectVersion,
        teamMemberVersion: item.memberVersion,
        workItemId: item.itemId,
        workItemVersion: item.workItemVersion,
        workItemTitle: item.workItemTitle
      };
    },
    receipt: async (input) => {
      if (input.name === "koed_todo_add") {
        const effect = teamTextEffectSchema.parse(
          await read(
            input,
            `/v1/workspace-projects/${input.workspaceProjectId}/work-items/text-action-effects/${input.effectKey}`
          )
        );
        return {
          confirmed:
            effect.item.title === input.arguments.title &&
            effect.item.goal ===
              (input.arguments.goal ?? input.arguments.title) &&
            effect.item.dueOn === (input.arguments.dueOn ?? null),
          effectNonceHash: effect.effectNonceHash
        };
      }
      const key = `shared-work-item:${input.workspaceProjectId}:${input.arguments.workItemId}:${input.snapshot.workItemVersion}`;
      const privateDispatch = await context
        .requireRepository()
        .getSharedWorkItemDispatch(
          { userId: input.ownerUserId },
          {
            projectId: input.projectId,
            idempotencyKey: key
          }
        );
      if (
        !privateDispatch ||
        privateDispatch.textActionId !== input.effectKey ||
        privateDispatch.workspaceProjectId !== input.workspaceProjectId ||
        privateDispatch.teamBackendId !== input.teamBackendId ||
        privateDispatch.teamWorkItemId !== input.arguments.workItemId ||
        privateDispatch.teamWorkItemVersion !==
          input.snapshot.workItemVersion ||
        privateDispatch.agentId !== input.arguments.agentId
      )
        return { confirmed: false, effectNonceHash: null };
      const query = new URLSearchParams({ dispatchKey: key });
      const item = dispatchStatusSchema.parse(
        await read(
          input,
          `/v1/workspace-projects/${input.workspaceProjectId}/work-items/${input.arguments.workItemId}/dispatch-status?${query}`
        )
      );
      return {
        confirmed:
          item.id === input.arguments.workItemId && item.dispatchKey === key,
        effectNonceHash: null
      };
    }
  };
}
