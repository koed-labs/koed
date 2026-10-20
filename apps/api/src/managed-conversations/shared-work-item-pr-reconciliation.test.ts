import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import {
  reconcileSharedWorkItemPr,
  sharedReviewBindingFromItem
} from "./shared-work-item-pr-reconciliation.js";

const owner = randomUUID();
const projectId = randomUUID();
const workspaceProjectId = randomUUID();
const itemId = randomUUID();
const executionId = randomUUID();
const agentId = randomUUID();
const teamPrincipal = randomUUID();
const prUrl = "https://github.com/koed-labs/koed/pull/212";
const remoteHash = "a".repeat(64);
const key = `shared-work-item:${workspaceProjectId}:${itemId}:7`;
const remote = {
  remoteName: "origin",
  provider: "github",
  host: "github.com",
  transport: "https",
  locator: { namespace: "koed-labs", repository: "koed", project: null },
  remoteIdentityHash: remoteHash,
  connectionId: randomUUID(),
  credentialGeneration: 1,
  connectionState: "connected",
  capabilities: ["review_request_read", "checks_read"]
};
const review = (state: "open" | "merged" | "closed") => ({
  id: "github:212",
  number: 212,
  title: "Review",
  state,
  draft: false,
  sourceBranch: "feature",
  targetBranch: "main",
  headObjectId: "b".repeat(40),
  author: "colleague",
  webUrl: prUrl,
  updatedAt: "2026-10-20T20:00:00Z"
});
const marker = {
  executionGeneration: 1,
  itemKind: "transient_output",
  providerRequestId: `shared-review-created:${remoteHash}:212`,
  payload: {
    sharedReviewBinding: {
      provider: "github.com",
      number: 212,
      url: prUrl,
      remoteIdentityHash: remoteHash
    }
  }
};

describe("shared Work Item provider-only PR reconciliation", () => {
  const homes: string[] = [];
  afterEach(() =>
    homes
      .splice(0)
      .forEach((home) => rmSync(home, { recursive: true, force: true }))
  );

  it("rejects freeform transient text and mismatched marker identity", () => {
    expect(
      sharedReviewBindingFromItem(
        {
          ...marker,
          providerRequestId: "shared-review-created:forged:212"
        } as never,
        1
      )
    ).toBeNull();
    expect(
      sharedReviewBindingFromItem(
        {
          ...marker,
          payload: { text: JSON.stringify(marker.payload.sharedReviewBinding) }
        } as never,
        1
      )
    ).toBeNull();
    expect(sharedReviewBindingFromItem(marker as never, 2)).toBeNull();
  });

  it.each(["open", "merged", "closed"] as const)(
    "publishes only provider-verified %s state with no private content sent to Team",
    async (state) => {
      const home = mkdtempSync(join(tmpdir(), "koed-shared-pr-"));
      homes.push(home);
      const registry = join(home, "backends.json");
      writeFileSync(
        registry,
        JSON.stringify({
          schemaVersion: 2,
          activeBackendId: "team-vps",
          backends: [
            {
              id: "team-vps",
              baseUrl: "https://team.example.test/",
              routePolicy: { teamWorkspaceRead: "enabled" }
            }
          ]
        })
      );
      const teamCalls: Array<{ path: string; body?: string }> = [];
      let teamStatus = "review";
      let teamStep = "Pull request open";
      let teamPrState = "open";
      const fetch = vi.fn(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(url)).pathname;
          teamCalls.push({
            path,
            ...(init?.body ? { body: String(init.body) } : {})
          });
          if (path.endsWith("/work-items"))
            return new Response("x".repeat(7_000_000), { status: 200 });
          if (path.endsWith("/device-credentials/status"))
            return Response.json({
              ok: true,
              auth: "device_credential",
              user: { id: teamPrincipal }
            });
          if (path.endsWith("/dispatch-authority"))
            return Response.json({
              allowed: true,
              projectId: workspaceProjectId,
              itemId,
              dispatchKey: key,
              workItemVersion: 13
            });
          if (path.endsWith("/dispatch-status") && init?.method === "GET")
            return Response.json({
              id: itemId,
              status: teamStatus,
              stepLabel: teamStep,
              prUrl,
              prState: teamPrState,
              version: 13,
              dispatchKey: key
            });
          if (path.endsWith("/dispatch-progress") && init?.method === "PATCH") {
            const body = JSON.parse(String(init.body));
            expect(body).toEqual({
              expectedVersion: 13,
              dispatchKey: key,
              status: state === "merged" ? "done" : "blocked",
              stepLabel:
                state === "merged"
                  ? "Pull request merged"
                  : "Pull request closed",
              prState: state
            });
            teamStatus = body.status;
            teamStep = body.stepLabel;
            teamPrState = body.prState;
            return Response.json({
              id: itemId,
              status: teamStatus,
              stepLabel: teamStep,
              prUrl,
              prState: teamPrState
            });
          }
          throw new Error(`Unexpected Team read ${path}`);
        }
      );
      const execution = {
        id: executionId,
        ownerUserId: owner,
        projectId,
        executionGeneration: 1,
        runnerDeviceId: randomUUID(),
        runnerDeploymentId: randomUUID(),
        logicalSessionId: randomUUID()
      };
      const repository = {
        getSharedDispatchLink: async () => ({
          teamBackendId: "team-vps",
          workspaceProjectId,
          teamPrincipalUserId: teamPrincipal
        }),
        listSharedWorkItemDispatches: async () => [
          { teamWorkItemId: itemId, executionId, agentId }
        ],
        getSharedWorkItemDispatchForExecution: async () => ({
          teamBackendId: "team-vps",
          workspaceProjectId,
          teamPrincipalUserId: teamPrincipal,
          teamWorkItemId: itemId,
          teamWorkItemVersion: 7
        }),
        getManagedConversationExecution: async () => execution,
        listManagedConversationRuntimeItems: async () => [marker]
      };
      const execute = vi.fn(
        async (_owner: string, operation: { kind: string }) =>
          operation.kind === "remotes"
            ? {
                kind: "remotes",
                remotes: [remote],
                headObjectId: review(state).headObjectId
              }
            : operation.kind === "checks"
              ? { kind: "checks", checks: [] }
              : { kind: "review_request", reviewRequest: review(state) }
      );
      const context = {
        requireRepository: () => repository,
        sourceControl: { runtime: { execute } },
        localEdge: {
          upstreamBackendsPath: registry,
          remoteOperationsAllowed: () => true,
          resolveUpstreamAuthorization: () => "Koed-Device upstream:secret",
          fetch
        }
      } as unknown as ApiRouteContext;
      expect(
        await reconcileSharedWorkItemPr(context, owner, projectId, itemId)
      ).toEqual({ state });
      expect(
        teamCalls.filter((call) => call.path.endsWith("/dispatch-progress"))
      ).toHaveLength(state === "open" ? 0 : 1);
      expect(teamCalls.some((call) => call.path.endsWith("/work-items"))).toBe(
        false
      );
      if (state !== "open")
        expect(
          teamCalls.some((call) => call.path.endsWith("/dispatch-status"))
        ).toBe(true);
      expect(JSON.stringify(teamCalls)).not.toContain(executionId);
      expect(JSON.stringify(teamCalls)).not.toContain(projectId);
      expect(JSON.stringify(teamCalls)).not.toContain("Private execution goal");
      expect(execute.mock.calls.map((call) => call[1].kind)).toEqual([
        "remotes",
        "review_request",
        "checks",
        "review_request",
        "remotes"
      ]);
    }
  );
});
