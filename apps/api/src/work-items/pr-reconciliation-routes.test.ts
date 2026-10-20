import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  storeDesktopLocalCredential,
  type DesktopLocalCredentialOperationFamily,
  type WorkItem
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { registerMergeProposalDecisionRoutes } from "./merge-proposal-decision-routes.js";
import { registerWorkItemPrReconciliationRoutes } from "./pr-reconciliation-routes.js";

const owner = randomUUID();
const project = randomUUID();
const item = randomUUID();
const path = `/v1/projects/${project}/work-items/${item}/reconcile-pr`;
const value: WorkItem = {
  id: item,
  projectId: project,
  kind: "todo",
  key: null,
  title: "Review",
  goal: "Ship",
  origin: "manual",
  originRef: null,
  idempotencyKey: null,
  status: "review",
  blockedReason: null,
  assigneeAgentId: null,
  executionId: randomUUID(),
  dispatchKey: null,
  prProvider: "github.com",
  prNumber: 212,
  prUrl: "https://github.com/koed-labs/koed/pull/212",
  prState: "open",
  dueOn: null,
  doneAt: null,
  doneBy: null,
  createdBy: owner,
  createdAt: "2026-10-20T20:00:00Z",
  updatedAt: "2026-10-20T20:00:00Z",
  version: 1
};
describe("Work Item provider reconciliation authority", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  const fixture = (
    families: DesktopLocalCredentialOperationFamily[] = [
      "personal_collaboration_write",
      "managed_source_control"
    ],
    profile = "developer"
  ) => {
    const home = mkdtempSync(join(tmpdir(), "koed-hq405-route-"));
    const desktop = storeDesktopLocalCredential(home, {
      ownerUserId: owner,
      operationFamilies: families
    });
    const app = Fastify();
    const reconcile = vi.fn(async () => value);
    const authenticate = vi.fn(
      async (request: FastifyRequest, family: string) => {
        if (request.headers.authorization !== "Session fixture")
          throw Object.assign(
            new Error("Session or device credential required"),
            { statusCode: 401 }
          );
        if (
          family === "managed_source_control" &&
          request.headers["x-missing-source-authority"]
        )
          throw Object.assign(new Error("Source control denied"), {
            statusCode: 403
          });
        return { id: owner };
      }
    );
    const decline = vi.fn(async () => true);
    const context = {
      config: { koedHome: home, deploymentProfile: profile },
      auth: { authenticateSessionOrDeviceCredential: authenticate },
      requireRepository: () => ({ declineManagedMergeProposal: decline }),
      rateLimit: { memoryWrite: async () => undefined }
    } as unknown as ApiRouteContext;
    registerWorkItemPrReconciliationRoutes(app, context, reconcile);
    registerMergeProposalDecisionRoutes(app, context);
    cleanups.push(async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    });
    return { app, desktop, reconcile, authenticate, decline };
  };
  it("records only a bounded exact Native decline, never renderer approval or text", async () => {
    const { app, desktop, decline } = fixture();
    const executionId = value.executionId!;
    const url = `/v1/managed-conversations/${executionId}/merge-proposals/${item}/decline`;
    const headers = { authorization: desktop.authorization };
    const response = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { executionGeneration: 1 }
    });
    expect(response.statusCode).toBe(200);
    expect(decline).toHaveBeenCalledWith(
      { userId: owner },
      { executionId, itemId: item, executionGeneration: 1 }
    );
    decline.mockClear();
    for (const extra of [
      { approved: true },
      { number: 213 },
      { text: "please merge" }
    ]) {
      const spoof = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { executionGeneration: 1, ...extra }
      });
      expect(spoof.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(decline).not.toHaveBeenCalled();
    decline.mockResolvedValue(false);
    const stale = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { executionGeneration: 2 }
    });
    expect(stale.statusCode).toBe(409);
  });
  it("requires both explicit Desktop capabilities and uses only server-owned selectors", async () => {
    const { app, desktop, reconcile } = fixture();
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { authorization: desktop.authorization },
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ workItem: value });
    expect(reconcile).toHaveBeenCalledWith(owner, project, item);
    reconcile.mockClear();
    const spoof = await app.inject({
      method: "POST",
      url: path,
      headers: { authorization: desktop.authorization },
      payload: { state: "merged", executionGeneration: 1 }
    });
    expect(spoof.statusCode).toBeGreaterThanOrEqual(400);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it.each([
    ["personal_collaboration_write"],
    ["managed_source_control"]
  ] as DesktopLocalCredentialOperationFamily[][])(
    "rejects missing capability %s",
    async (...families) => {
      const { app, desktop, reconcile } = fixture(families);
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: desktop.authorization },
        payload: {}
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(reconcile).not.toHaveBeenCalled();
    }
  );
  it("rejects remote Desktop use, Team deployment and API Tokens", async () => {
    const local = fixture();
    const remote = await local.app.inject({
      method: "POST",
      url: path,
      remoteAddress: "192.0.2.8",
      headers: { authorization: local.desktop.authorization },
      payload: {}
    });
    expect(remote.statusCode).toBe(403);
    expect(local.reconcile).not.toHaveBeenCalled();
    const team = fixture(undefined, "team_backend");
    const response = await team.app.inject({
      method: "POST",
      url: path,
      headers: { authorization: team.desktop.authorization },
      payload: {}
    });
    expect(response.statusCode).toBe(403);
    expect(team.reconcile).not.toHaveBeenCalled();
    const token = await local.app.inject({
      method: "POST",
      url: path,
      headers: { authorization: "Bearer fixture-api-token" },
      payload: {}
    });
    expect(token.statusCode).toBe(401);
    expect(local.reconcile).not.toHaveBeenCalled();
  });
  it("checks source-control authority separately for session/device callers", async () => {
    const { app, reconcile, authenticate } = fixture();
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { authorization: "Session fixture" },
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    expect(authenticate.mock.calls.map(([, family]) => family)).toEqual([
      "personal_collaboration_write",
      "managed_source_control"
    ]);
    reconcile.mockClear();
    const denied = await app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: "Session fixture",
        "x-missing-source-authority": "yes"
      },
      payload: {}
    });
    expect(denied.statusCode).toBe(403);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
