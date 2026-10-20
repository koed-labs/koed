import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readLocalEdgeClientCredentialAuthorization,
  storeDesktopLocalCredential,
  storeLocalEdgeClientCredential
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { registerManagedConversationRoutes } from "./routes.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("shared Work Item local dispatch route", () => {
  it("requires both Desktop and enrolled Team authority, then binds only after exact Team CAS receipt", async () => {
    const ownerUserId = randomUUID();
    const projectId = randomUUID();
    const workspaceProjectId = randomUUID();
    const teamPrincipalUserId = randomUUID();
    const itemId = randomUUID();
    const agentId = randomUUID();
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const teamBackendId = "team-vps";
    const dispatchKey = `shared-work-item:${workspaceProjectId}:${itemId}:7`;
    const home = mkdtempSync(resolve(tmpdir(), "koed-shared-route-"));
    homes.push(home);
    mkdirSync(resolve(home, "config"));
    writeFileSync(
      resolve(home, "config", "projects.json"),
      JSON.stringify({
        schemaVersion: 3,
        projects: [
          { localProjectId: projectId, path: { cwd: home, projectRoot: home } }
        ]
      })
    );
    const registry = resolve(home, "team-backends.json");
    writeFileSync(
      registry,
      JSON.stringify({
        schemaVersion: 2,
        activeBackendId: teamBackendId,
        backends: [
          {
            id: teamBackendId,
            baseUrl: "https://team.example.test/",
            routePolicy: { teamWorkspaceRead: "enabled" }
          }
        ]
      })
    );
    const desktopAuthorization = storeDesktopLocalCredential(home, {
      ownerUserId,
      operationFamilies: ["personal_collaboration_write", "managed_execution"]
    }).authorization;
    storeLocalEdgeClientCredential(home, {
      backendId: teamBackendId,
      secret: "sealed-team-client-secret",
      operationFamilies: ["team_workspace_write"]
    });
    const teamAuthorization = readLocalEdgeClientCredentialAuthorization(
      home,
      teamBackendId
    )!.authorization;
    const events: string[] = [];
    const create = vi.fn(async () => {
      events.push("private-created");
      return {
        execution: { id: executionId, executionGeneration: 1 },
        command: { id: randomUUID() },
        fencingToken: ""
      };
    });
    const bind = vi.fn(async () => {
      events.push("private-bound");
      return {};
    });
    const link = { teamBackendId, workspaceProjectId, teamPrincipalUserId };
    const repository = {
      getSharedWorkItemDispatch: vi.fn(async () => null),
      createManagedConversation: create,
      upsertManagedConversationRuntimeBinding: bind,
      listAiClientInstances: async () => [
        {
          instanceId: "codex.default",
          driverId: "codex",
          displayName: "Codex",
          enabled: true,
          configIdentityHash: "f".repeat(64)
        }
      ],
      listCurrentAiClientCapabilitySnapshots: async () => [
        {
          instanceId: "codex.default",
          installationIdentityHash: "f".repeat(64),
          authenticationState: "authenticated",
          healthState: "healthy",
          expiresAt: "2099-01-01T00:00:00.000Z",
          capabilities: {
            descriptors: {
              managed_conversation_start: {
                support: "supported",
                readiness: "ready"
              }
            }
          },
          models: [
            {
              id: "gpt-test",
              provenance: "reported",
              supportedReasoningEfforts: ["low"]
            }
          ]
        }
      ]
    };
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/device-credentials/status"))
        return Response.json({
          ok: true,
          auth: "device_credential",
          user: { id: teamPrincipalUserId }
        });
      if (path.endsWith("/dispatch-proof"))
        return Response.json({
          projectId: workspaceProjectId,
          itemId,
          projectVersion: 9,
          memberVersion: 4,
          workItemVersion: 7,
          title: "Team ticket",
          goal: "Private execution goal",
          status: "todo"
        });
      if (path.endsWith("/dispatch-receipt") && init?.method === "POST") {
        events.push("team-cas");
        expect(JSON.parse(String(init.body))).toEqual({
          expectedVersion: 7,
          dispatchKey
        });
        return Response.json({ id: itemId, status: "doing", dispatchKey });
      }
      if (path.endsWith("/dispatch-authority")) {
        events.push("team-confirmed");
        expect(new URL(String(url)).searchParams.get("dispatchKey")).toBe(
          dispatchKey
        );
        return Response.json({
          allowed: true,
          projectId: workspaceProjectId,
          itemId,
          dispatchKey,
          workItemVersion: 8
        });
      }
      throw new Error(`Unexpected Team request: ${path}`);
    });
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code((error as Error & { statusCode?: number }).statusCode ?? 500)
        .send({ error: error instanceof Error ? error.message : String(error) })
    );
    registerManagedConversationRoutes(
      app,
      {
        config: { deploymentProfile: "local_personal", koedHome: home },
        encryption: { envelopeEncryptionProvider: {} },
        auth: {
          authenticateSessionOrDeviceCredential: async () => {
            throw Object.assign(new Error("Desktop required"), {
              statusCode: 403
            });
          }
        },
        rateLimit: {
          memoryRead: async () => undefined,
          memoryWrite: async () => undefined
        },
        localEdge: {
          upstreamBackendsPath: registry,
          remoteOperationsAllowed: () => true,
          resolveUpstreamAuthorization: () => "Koed-Device team-key:secret",
          fetch
        },
        deploymentIdentity: {
          inspect: () => ({
            health: "healthy",
            deploymentId,
            deviceInstanceId: deviceId
          })
        },
        requireRepository: () => repository
      } as unknown as ApiRouteContext,
      {
        list: async () => [
          {
            id: agentId,
            aiClientInstanceId: "codex.default",
            defaultModel: "gpt-test",
            defaultPermissionMode: "supervised"
          }
        ]
      } as never,
      { getSharedDispatchLink: async () => link } as never
    );
    await app.ready();
    const url = `/v1/projects/${projectId}/shared-work-items/${itemId}/dispatch`;
    const payload = {
      agentId,
      expectedProjectVersion: 9,
      expectedMemberVersion: 4,
      expectedWorkItemVersion: 7
    };
    try {
      const denied = await app.inject({
        method: "POST",
        url,
        headers: { authorization: desktopAuthorization },
        payload
      });
      expect(denied.statusCode).toBe(403);
      expect(create).not.toHaveBeenCalled();
      const allowed = await app.inject({
        method: "POST",
        url,
        headers: {
          authorization: desktopAuthorization,
          "x-koed-team-client-credential": teamAuthorization
        },
        payload
      });
      expect(allowed.statusCode).toBe(202);
      expect(allowed.json()).toMatchObject({
        executionId,
        dispatchKey,
        teamBackendId,
        workspaceProjectId,
        reused: false
      });
      expect(events).toEqual([
        "private-created",
        "team-cas",
        "team-confirmed",
        "private-bound"
      ]);
      expect(bind).toHaveBeenCalledWith(
        { userId: ownerUserId },
        expect.objectContaining({ executionId, deploymentId, deviceId })
      );
    } finally {
      await app.close();
    }
  });
});
