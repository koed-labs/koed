import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMemorySourceRepository,
  createWorkItemRepository,
  runDbMigrations
} from "@koed/db";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  readDesktopLocalCredentialAuthorization,
  readLocalEdgeClientCredentialAuthorization,
  storeDesktopLocalCredential,
  storeLocalEdgeClientCredential
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { registerManagedConversationRunnerRoutes } from "./runner-routes.js";
import { registerManagedConversationRoutes } from "./routes.js";

const testUrl = process.env.KOED_HQ712_SHARED_RUNNER_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)(
  "private shared Work Item runner HTTP with stored commands",
  () => {
    let admin: pg.Pool;
    let pool: pg.Pool;
    let database = "";
    let home = "";
    const owner = randomUUID();
    const personalProjectId = randomUUID();
    const workspaceProjectId = randomUUID();
    const teamPrincipalId = randomUUID();
    const agentId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const teamBackendId = "team-vps";

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: testUrl });
      database = `hq712_shared_runner_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`create database ${quote(database)}`);
      const child = new URL(testUrl!);
      child.pathname = `/${database}`;
      pool = new pg.Pool({ connectionString: child.toString() });
      await runDbMigrations(pool);
      await pool.query("insert into users(id,email) values($1,$2)", [
        owner,
        `${owner}@example.test`
      ]);
      await pool.query(
        `insert into projects(id,owner_user_id,name,key,
      team_backend_id,team_workspace_id,workspace_project_id)
      values($1,$2,'Private work','PRIVATE',$3,$4,$5)`,
        [
          personalProjectId,
          owner,
          teamBackendId,
          randomUUID(),
          workspaceProjectId
        ]
      );
      await pool.query(
        `insert into personal_workspace_project_principal_bindings
      (local_user_id,team_backend_id,team_principal_user_id,
       local_credential_key_id,team_credential_key_id)
      values($1,$2,$3,'local-key','team-key')`,
        [owner, teamBackendId, teamPrincipalId]
      );
      await pool.query(
        `insert into ai_client_instances
      (owner_user_id,instance_id,driver_id,display_name,enabled)
      values($1,'codex.shared','codex','Shared',true)`,
        [owner]
      );
      await pool.query(
        `insert into agents(id,owner_user_id,name,
      ai_client_instance_id,default_permission_mode)
      values($1,$2,'Quinn','codex.shared','supervised')`,
        [agentId, owner]
      );
      home = mkdtempSync(resolve(tmpdir(), "koed-shared-runner-"));
      writeFileSync(
        resolve(home, "team-backends.json"),
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
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
      if (admin && database)
        await admin.query(`drop database ${quote(database)}`);
      await admin?.end();
      if (home) rmSync(home, { recursive: true, force: true });
    });

    it("claims and completes only while the exact Team attempt remains authoritative", async () => {
      const encryption = createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      );
      const repository = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: encryption
      });
      let allowed = true;
      let currentItemId = "";
      let currentKey = "";
      const fetch = vi.fn(async (url: RequestInfo | URL) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/device-credentials/status"))
          return Response.json({
            ok: true,
            auth: "device_credential",
            user: { id: teamPrincipalId }
          });
        if (!allowed)
          return Response.json({ error: "revoked" }, { status: 409 });
        return Response.json({
          allowed: true,
          projectId: workspaceProjectId,
          itemId: currentItemId,
          dispatchKey: currentKey,
          workItemVersion: 8
        });
      });
      const app = Fastify({ logger: false });
      app.setErrorHandler((error, _request, reply) =>
        reply
          .code((error as Error & { statusCode?: number }).statusCode ?? 500)
          .send({
            error: error instanceof Error ? error.message : String(error)
          })
      );
      registerManagedConversationRunnerRoutes(app, {
        requireRepository: () => repository,
        auth: {
          authenticateDeviceCredential: async () => ({
            user: { id: owner },
            credential: {
              id: randomUUID(),
              ownerUserId: owner,
              deviceInstanceId: deviceId,
              operationFamilies: ["managed_execution"],
              metadata: { protocolDeploymentId: deploymentId }
            }
          })
        },
        rateLimit: {
          memoryRead: async () => undefined,
          memoryWrite: async () => undefined
        },
        localEdge: {
          upstreamBackendsPath: resolve(home, "team-backends.json"),
          remoteOperationsAllowed: () => true,
          resolveUpstreamAuthorization: () => "Koed-Device team:key",
          fetch
        }
      } as unknown as ApiRouteContext);
      await app.ready();
      const launch = async (itemId: string, version: number) => {
        const dispatchKey = `shared-work-item:${workspaceProjectId}:${itemId}:${version}`;
        const created = await repository.createManagedConversation(
          { userId: owner },
          {
            projectId: personalProjectId,
            contextKind: "project",
            provider: "codex",
            aiClientInstanceId: "codex.shared",
            model: "gpt-test",
            permissionMode: "supervised",
            runnerKind: "local_device",
            runnerDeploymentId: deploymentId,
            runnerDeviceId: deviceId,
            idempotencyKey: dispatchKey,
            initialPrompt: "Private Team goal",
            deferUntilRuntimeBinding: true,
            sharedWorkItemDispatch: {
              teamBackendId,
              teamPrincipalUserId: teamPrincipalId,
              workspaceProjectId,
              teamWorkItemId: itemId,
              teamWorkItemVersion: version,
              expectedProjectVersion: 9,
              expectedMemberVersion: 4,
              agentId
            }
          }
        );
        await repository.upsertManagedConversationRuntimeBinding(
          { userId: owner },
          {
            executionId: created.execution.id,
            deploymentId,
            deviceId,
            executionGeneration: created.execution.executionGeneration,
            projectPath: home
          }
        );
        await repository.releaseManagedConversationStartForRuntimeBinding({
          ownerUserId: owner,
          executionId: created.execution.id,
          executionGeneration: created.execution.executionGeneration,
          deploymentId,
          deviceId
        });
        return { created, dispatchKey };
      };
      const claim = () =>
        app.inject({
          method: "POST",
          url: "/v1/managed-conversation-runner/commands/claim",
          headers: { authorization: "Koed-Device runner-key:secret" },
          payload: { runnerId: "runner", limit: 1, leaseMs: 30_000 }
        });
      try {
        currentItemId = randomUUID();
        const first = await launch(currentItemId, 7);
        currentKey = first.dispatchKey;
        const claimed = await claim();
        expect(claimed.statusCode).toBe(200);
        const command = claimed.json().commands[0];
        expect(command.id).toBe(first.created.command.id);
        expect(command.payload.prompt).toContain("Private Team goal");
        const completed = await app.inject({
          method: "POST",
          url: `/v1/managed-conversation-runner/commands/${command.id}/complete`,
          headers: { authorization: "Koed-Device runner-key:secret" },
          payload: {
            leaseToken: command.leaseToken,
            result: { accepted: true }
          }
        });
        expect(completed.statusCode).toBe(200);
        expect(completed.json()).toEqual({ completed: true });
        currentItemId = randomUUID();
        const second = await launch(currentItemId, 8);
        currentKey = second.dispatchKey;
        allowed = false;
        const revoked = await claim();
        expect(revoked.statusCode).toBe(409);
        expect(revoked.body).not.toContain(second.created.command.id);
        const stored = await repository.getManagedConversationCommand(
          { userId: owner },
          second.created.command.id
        );
        expect(stored?.state).toBe("failed");
        allowed = true;
        currentItemId = randomUUID();
        const third = await launch(currentItemId, 9);
        currentKey = third.dispatchKey;
        const claimedBeforeRevocation = await claim();
        expect(claimedBeforeRevocation.statusCode).toBe(200);
        const inFlight = claimedBeforeRevocation.json().commands[0];
        expect(inFlight.id).toBe(third.created.command.id);
        allowed = false;
        const deniedCompletion = await app.inject({
          method: "POST",
          url: `/v1/managed-conversation-runner/commands/${inFlight.id}/complete`,
          headers: { authorization: "Koed-Device runner-key:secret" },
          payload: {
            leaseToken: inFlight.leaseToken,
            result: { accepted: true }
          }
        });
        expect(deniedCompletion.statusCode).toBe(409);
        expect(
          (
            await repository.getManagedConversationCommand(
              { userId: owner },
              inFlight.id
            )
          )?.state
        ).toBe("dispatching");
      } finally {
        await app.close();
      }
    }, 120_000);

    it.each(["generic", "explicit", "failed", "review"] as const)(
      "runs private %s outcome through authoritative Team progress without plaintext",
      async (outcome) => {
        const itemId = randomUUID();
        const dispatchKey = `shared-work-item:${workspaceProjectId}:${itemId}:12`;
        mkdirSync(resolve(home, "config"), { recursive: true });
        writeFileSync(
          resolve(home, "config", "projects.json"),
          JSON.stringify({
            schemaVersion: 3,
            projects: [
              {
                localProjectId: personalProjectId,
                path: { cwd: home, projectRoot: home }
              }
            ]
          })
        );
        const desktop = (
          readDesktopLocalCredentialAuthorization(home) ??
          storeDesktopLocalCredential(home, {
            ownerUserId: owner,
            operationFamilies: [
              "personal_collaboration_write",
              "managed_execution"
            ]
          })
        ).authorization;
        if (!readLocalEdgeClientCredentialAuthorization(home, teamBackendId))
          storeLocalEdgeClientCredential(home, {
            backendId: teamBackendId,
            secret: "team-write-secret",
            operationFamilies: ["team_workspace_write"]
          });
        const teamClient = readLocalEdgeClientCredentialAuthorization(
          home,
          teamBackendId
        )!.authorization;
        const encryption = createLocalTestKeyEnvelopeEncryptionProvider(
          randomBytes(32).toString("base64url")
        );
        const stored = createMemorySourceRepository(pool, {
          envelopeEncryptionProvider: encryption
        });
        const repository = {
          ...stored,
          listAiClientInstances: async () => [
            {
              instanceId: "codex.shared",
              driverId: "codex",
              displayName: "Codex",
              enabled: true,
              configIdentityHash: "f".repeat(64)
            }
          ],
          listCurrentAiClientCapabilitySnapshots: async () => [
            {
              instanceId: "codex.shared",
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
        let teamStatus: "todo" | "doing" | "done" | "blocked" = "todo";
        let teamVersion = 12;
        let teamStep = "Sent to Agent";
        let teamPrUrl: string | null = null;
        let teamPrState: string | null = null;
        const events: string[] = [];
        const fetch = vi.fn(
          async (url: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith("/device-credentials/status"))
              return Response.json({
                ok: true,
                auth: "device_credential",
                user: { id: teamPrincipalId }
              });
            if (path.endsWith("/dispatch-proof"))
              return Response.json({
                projectId: workspaceProjectId,
                itemId,
                projectVersion: 9,
                memberVersion: 4,
                workItemVersion: 12,
                title: "Shared ticket",
                goal: "Keep execution private",
                status: "todo"
              });
            if (path.endsWith("/dispatch-status") && init?.method === "GET")
              return Response.json({
                id: itemId,
                status: teamStatus,
                stepLabel: teamStep,
                prUrl: teamPrUrl,
                prState: teamPrState,
                version: teamVersion,
                dispatchKey
              });
            if (path.endsWith("/dispatch-receipt") && init?.method === "POST") {
              expect(JSON.parse(String(init.body))).toEqual({
                expectedVersion: 12,
                dispatchKey
              });
              teamStatus = "doing";
              teamVersion = 13;
              events.push("team-cas");
              return Response.json({
                id: itemId,
                status: "doing",
                dispatchKey
              });
            }
            if (
              path.endsWith("/dispatch-progress") &&
              init?.method === "PATCH"
            ) {
              const body = JSON.parse(String(init.body));
              expect(body).toEqual({
                expectedVersion: teamVersion,
                dispatchKey,
                status: events.includes("team-progress")
                  ? outcome === "explicit"
                    ? "done"
                    : outcome === "failed"
                      ? "blocked"
                      : "doing"
                  : "doing",
                stepLabel: events.includes("team-progress")
                  ? outcome === "explicit"
                    ? "Done"
                    : outcome === "failed"
                      ? "Execution stopped"
                      : "Agent finished this turn"
                  : "Working now"
              });
              teamVersion += 1;
              teamStatus = body.status;
              teamStep = body.stepLabel;
              events.push("team-progress");
              return Response.json({
                id: itemId,
                status: teamStatus,
                stepLabel: teamStep,
                prUrl: null,
                prState: null,
                version: teamVersion
              });
            }
            if (path.endsWith("/dispatch-authority")) {
              expect(teamStatus).toBe("doing");
              events.push("team-authority");
              return Response.json({
                allowed: true,
                projectId: workspaceProjectId,
                itemId,
                dispatchKey,
                workItemVersion: teamVersion
              });
            }
            throw new Error(`Unexpected Team request ${path}`);
          }
        );
        const runnerAuth = {
          authenticateDeviceCredential: async () => ({
            user: { id: owner },
            credential: {
              id: randomUUID(),
              ownerUserId: owner,
              deviceInstanceId: deviceId,
              operationFamilies: ["managed_execution"],
              metadata: { protocolDeploymentId: deploymentId }
            }
          })
        };
        const context = {
          config: { deploymentProfile: "local_personal", koedHome: home },
          encryption: { envelopeEncryptionProvider: encryption },
          requireRepository: () => repository,
          auth: {
            ...runnerAuth,
            authenticateSessionOrDeviceCredential: async () => {
              throw Object.assign(new Error("Desktop required"), {
                statusCode: 403
              });
            }
          },
          deploymentIdentity: {
            inspect: () => ({
              health: "healthy",
              deploymentId,
              deviceInstanceId: deviceId
            })
          },
          rateLimit: {
            memoryRead: async () => undefined,
            memoryWrite: async () => undefined
          },
          localEdge: {
            upstreamBackendsPath: resolve(home, "team-backends.json"),
            remoteOperationsAllowed: () => true,
            resolveUpstreamAuthorization: () => "Koed-Device team:key",
            fetch
          }
        } as unknown as ApiRouteContext;
        const app = Fastify({ logger: false });
        app.setErrorHandler((error, _request, reply) =>
          reply
            .code((error as Error & { statusCode?: number }).statusCode ?? 500)
            .send({
              error: error instanceof Error ? error.message : String(error)
            })
        );
        registerManagedConversationRoutes(
          app,
          context,
          {
            list: async () => [
              {
                id: agentId,
                aiClientInstanceId: "codex.shared",
                defaultModel: "gpt-test",
                defaultPermissionMode: "supervised"
              }
            ]
          } as never,
          createWorkItemRepository(pool)
        );
        registerManagedConversationRunnerRoutes(app, context);
        await app.ready();
        try {
          const dispatched = await app.inject({
            method: "POST",
            url: `/v1/projects/${personalProjectId}/shared-work-items/${itemId}/dispatch`,
            headers: {
              authorization: desktop,
              "x-koed-team-client-credential": teamClient
            },
            payload: {
              agentId,
              expectedProjectVersion: 9,
              expectedMemberVersion: 4,
              expectedWorkItemVersion: 12
            }
          });
          expect(dispatched.statusCode).toBe(202);
          const executionId = dispatched.json().executionId as string;
          expect(dispatched.json().dispatchKey).toBe(dispatchKey);
          expect(events.slice(0, 2)).toEqual(["team-cas", "team-authority"]);
          const ready = await app.inject({
            method: "POST",
            url: `/v1/managed-conversation-runner/executions/${executionId}/runtime-binding-ready`,
            headers: { authorization: "Koed-Device runner-key:secret" },
            payload: { executionGeneration: 1 }
          });
          expect(ready.statusCode).toBe(200);
          const claimed = await app.inject({
            method: "POST",
            url: "/v1/managed-conversation-runner/commands/claim",
            headers: { authorization: "Koed-Device runner-key:secret" },
            payload: { runnerId: "runner", limit: 1, leaseMs: 30_000 }
          });
          expect(claimed.statusCode).toBe(200);
          const command = claimed.json().commands[0];
          expect(command.executionId).toBe(executionId);
          expect(command.payload.prompt).toContain("Keep execution private");
          const working = await app.inject({
            method: "POST",
            url: `/v1/managed-conversations/${executionId}/shared-progress`,
            headers: {
              authorization: desktop,
              "x-koed-team-client-credential": teamClient
            },
            payload: { commandId: command.id }
          });
          expect(working.statusCode).toBe(200);
          if (outcome === "explicit")
            await repository.putManagedConversationRuntimeItem(
              { userId: owner },
              {
                executionId,
                executionGeneration: 1,
                providerRequestId: `shared-work-item-complete:${command.id}:provider-tool-1`,
                itemKind: "transient_output",
                payload: { sharedWorkItemCompletion: "accepted" }
              }
            );
          if (outcome === "review") {
            const remoteIdentityHash = "a".repeat(64);
            teamStatus = "doing";
            teamStep = "Pull request open";
            teamPrUrl = "https://github.com/acme/shared/pull/7";
            teamPrState = "open";
            await repository.putManagedConversationRuntimeItem(
              { userId: owner },
              {
                executionId,
                executionGeneration: 1,
                providerRequestId: `shared-review-created:${remoteIdentityHash}:7`,
                itemKind: "transient_output",
                payload: {
                  sharedReviewBinding: {
                    provider: "github.com",
                    number: 7,
                    url: teamPrUrl,
                    remoteIdentityHash
                  }
                }
              }
            );
          }
          const terminal = await app.inject({
            method: "POST",
            url: `/v1/managed-conversation-runner/commands/${command.id}/${outcome === "failed" ? "fail" : "complete"}`,
            headers: { authorization: "Koed-Device runner-key:secret" },
            payload:
              outcome === "failed"
                ? {
                    leaseToken: command.leaseToken,
                    state: "failed",
                    errorCode: "AgentStopped"
                  }
                : { leaseToken: command.leaseToken, result: { accepted: true } }
          });
          expect(terminal.statusCode).toBe(200);
          const recovery =
            await repository.listSharedDispatchProgressCandidates(
              { userId: owner },
              { deploymentId, deviceId, limit: 100 }
            );
          expect(recovery).toContainEqual({
            executionId,
            commandId: command.id
          });
          const finished = await app.inject({
            method: "POST",
            url: `/v1/managed-conversations/${executionId}/shared-progress`,
            headers: {
              authorization: desktop,
              "x-koed-team-client-credential": teamClient
            },
            payload: { commandId: command.id }
          });
          expect(finished.statusCode).toBe(200);
          const replay = await app.inject({
            method: "POST",
            url: `/v1/managed-conversations/${executionId}/shared-progress`,
            headers: {
              authorization: desktop,
              "x-koed-team-client-credential": teamClient
            },
            payload: { commandId: command.id }
          });
          expect(replay.statusCode).toBe(200);
          expect(
            events.filter((event) => event === "team-progress")
          ).toHaveLength(outcome === "review" ? 1 : 2);
          expect(JSON.stringify(fetch.mock.calls)).not.toContain(
            "Keep execution private"
          );
          const ciphertext = await pool.query<{ encrypted_payload: string }>(
            `select encrypted_payload::text from managed_conversation_commands
           where id=$1`,
            [command.id]
          );
          expect(ciphertext.rows[0]!.encrypted_payload).not.toContain(
            "Keep execution private"
          );
        } finally {
          await app.close();
        }
      },
      120_000
    );
  }
);
