import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import {
  Client,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import {
  createDbPool,
  createMemorySourceRepository,
  createRemoteMcpOAuthRepository,
  runDbMigrations
} from "@koed/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workosAgentTestEnvironment } from "../../test-fixtures/workos-agent-auth.js";
import { buildServer } from "./build-server.js";

const databaseUrl = process.env.KOED_OAUTH_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "WorkOS delegated Personal and Team authority",
  () => {
    const database = `workos_agent_${randomUUID().replaceAll("-", "")}`;
    const admin = createDbPool({ connectionString: databaseUrl });
    const url = new URL(databaseUrl ?? "postgresql://localhost/postgres");
    url.pathname = `/${database}`;
    const pool = createDbPool({ connectionString: url.toString() });
    const { privateKey: signingKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048
    });
    let app: Awaited<ReturnType<typeof buildServer>>;
    let createServer: () => ReturnType<typeof buildServer>;
    let repository: ReturnType<typeof createMemorySourceRepository>;
    let home: string;
    let origin: string;
    let userId: string;
    let teamId: string;
    let workspaceId: string;
    let otherTeamId: string;
    let otherWorkspaceId: string;
    let decrypt: ReturnType<typeof vi.spyOn>;
    let teamDecrypt: ReturnType<typeof vi.spyOn>;
    let candidateId: string;
    let revoked = false;
    const resource = workosAgentTestEnvironment.KOED_REMOTE_MCP_PUBLIC_URL;
    const issuer =
      workosAgentTestEnvironment.WORKOS_AGENT_REGISTRATION_ISSUER_URL;
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      const endpoint = String(input);
      if (endpoint === `${issuer}/oauth2/jwks`)
        return Response.json({
          keys: [
            {
              ...publicKey.export({ format: "jwk" }),
              kid: "key-one",
              alg: "RS256",
              use: "sig"
            }
          ]
        });
      if (endpoint === "https://api.workos.com/agents/credentials/validate") {
        const body = JSON.parse(String(init?.body));
        expect(body.audience).toBe(resource);
        let registrationId: string;
        try {
          const { payload } = await jwtVerify(body.credential, publicKey, {
            issuer,
            audience: resource
          });
          registrationId = payload.sub!;
        } catch {
          return Response.json({ valid: false });
        }
        return Response.json({
          valid: !revoked,
          registration_id: registrationId
        });
      }
      if (
        ["agent_reg_fixture", "agent_reg_other", "agent_reg_second"].some(
          (id) =>
            endpoint === `https://api.workos.com/agents/registrations/${id}`
        )
      )
        return Response.json({
          id: endpoint.split("/").at(-1),
          organization_id: endpoint.endsWith("agent_reg_other")
            ? "org_other"
            : "org_test",
          status: "verified",
          kind: "service_auth"
        });
      throw new Error("Unexpected external request");
    });
    const issue = (
      team = true,
      execution = false,
      otherOrganization = false,
      providerUserId = "user_fixture",
      registrationId = otherOrganization
        ? "agent_reg_other"
        : "agent_reg_fixture"
    ) =>
      new SignJWT({
        sub: registrationId,
        act: { sub: providerUserId },
        org_id: otherOrganization ? "org_other" : "org_test",
        scope: [
          "koed:memory:read",
          ...(team ? ["koed:team:read"] : []),
          ...(execution ? ["koed:local-execution"] : [])
        ].join(" ")
      })
        .setProtectedHeader({ alg: "RS256", kid: "key-one" })
        .setIssuer(issuer)
        .setAudience(resource)
        .setExpirationTime("5m")
        .sign(signingKey);
    const request = async (
      token: string,
      path: string,
      body?: Record<string, unknown>
    ) => {
      const response = await fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const text = await response.text();
      return {
        statusCode: response.status,
        body: text,
        json: () => JSON.parse(text),
        headers: Object.fromEntries(response.headers)
      };
    };
    const accept = (token: string, workspace?: string) =>
      request(token, "/v1/memory/answer-tasks", {
        origin: "mcp",
        max_queued: 100,
        request: {
          input: {
            query: "Team decisions",
            search_domain: "global",
            ...(workspace
              ? { team_workspace_id: workspace, team_backend_id: "remote" }
              : {})
          },
          caller: { cwd: "" }
        }
      });

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), "koed-workos-test-"));
      for (const [key, value] of Object.entries(workosAgentTestEnvironment))
        vi.stubEnv(key, value);
      vi.stubEnv("KOED_HOME", home);
      vi.stubEnv("API_TOKEN_PEPPER", randomUUID());
      vi.stubEnv("WORK_QUEUE_BACKEND", "memory");
      vi.stubEnv("KOED_TEAM_COLLABORATION_ENABLED", "true");
      vi.stubEnv(
        "WORKOS_AGENT_REGISTRATION_SCOPES",
        "koed:memory:read,koed:team:read,koed:local-execution"
      );
      vi.stubEnv("WORKOS_AGENT_REGISTRATION_REQUESTS_PER_MINUTE", "10000");
      vi.stubEnv(
        "WORKOS_AGENT_REGISTRATION_ALLOWED_ORGANIZATIONS",
        "org_test,org_other"
      );
      await admin.query(`create database ${database}`);
      await runDbMigrations(pool);
      const fixture = await import(
        new URL(
          "../../../../scripts/team-saas-fixture-lib.mjs",
          import.meta.url
        ).href
      );
      const runtime = await fixture.createFixtureRuntime(pool, {
        environment: { NODE_ENV: "test" }
      });
      await fixture.seedFixture(pool, runtime);
      await fixture.validateFixture(pool, runtime);
      const pending =
        await runtime.sharedMemoryRepository.listPendingSharedMemorySemanticItems(
          {
            limit: 200,
            model: "qwen3-0.6b",
            dimensions: 1024,
            version: "workos-fixture"
          }
        );
      expect(pending.length).toBeGreaterThan(0);
      const vector = Array<number>(1024).fill(0);
      vector[0] = 1;
      for (const item of pending)
        expect(
          await runtime.sharedMemoryRepository.storeSharedMemorySemanticEmbedding(
            {
              semanticItemId: item.semanticItemId,
              contentHash: item.contentHash,
              model: "qwen3-0.6b",
              dimensions: 1024,
              version: "workos-fixture",
              vector
            }
          )
        ).toBe(true);
      userId = fixture.fixtureUsers.alice.id;
      workspaceId = fixture.fixtureWorkspaces.cloud.id;
      teamId = (
        await pool.query("select team_id from team_workspaces where id=$1", [
          workspaceId
        ])
      ).rows[0].team_id;
      otherTeamId = (
        await pool.query(
          "insert into teams(name,entitlement_status) values('Other organisation','active') returning id"
        )
      ).rows[0].id;
      otherWorkspaceId = (
        await pool.query(
          "insert into team_workspaces(team_id,name) values($1,'Other organisation workspace') returning id",
          [otherTeamId]
        )
      ).rows[0].id;
      await pool.query(
        "insert into team_memberships(team_id,user_id,role,status,accepted_at) values($1,$2,'owner','enabled',now())",
        [otherTeamId, userId]
      );
      await pool.query(
        "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,granted_by_user_id) values($1,$2,$3,'write',$3)",
        [otherWorkspaceId, otherTeamId, userId]
      );
      await pool.query(
        "insert into external_auth_identities(provider,provider_environment,provider_user_id,user_id,email,email_verified,status) select 'workos_authkit','staging','user_fixture',id,email,true,'linked' from users where id=$1",
        [userId]
      );
      await pool.query(
        "insert into external_auth_identities(provider,provider_environment,provider_user_id,user_id,email,email_verified,status) select 'workos_authkit','staging','user_second',id,email,true,'linked' from users where id=$1",
        [fixture.fixtureUsers.bob.id]
      );
      await pool.query(
        "insert into external_auth_organizations(provider,provider_environment,provider_organization_id,team_id,status) values('workos_authkit','staging','org_test',$1,'linked')",
        [teamId]
      );
      await pool.query(
        "insert into external_auth_organizations(provider,provider_environment,provider_organization_id,team_id,status) values('workos_authkit','staging','org_other',$1,'linked')",
        [otherTeamId]
      );
      candidateId = (
        await pool.query(
          "select id from team_memory_semantic_items where team_workspace_id=$1 and embedding_state='embedded' order by id limit 1",
          [workspaceId]
        )
      ).rows[0].id;
      repository = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: runtime.personalProvider,
        teamEnvelopeEncryptionProvider: runtime.teamProvider,
        ownerPrivateReplicaEnvelopeEncryptionProvider: runtime.ownerProvider
      });
      decrypt = vi.spyOn(runtime.personalProvider, "decrypt");
      teamDecrypt = vi.spyOn(runtime.teamProvider, "decrypt");
      createServer = () =>
        buildServer({
          repository,
          remoteMcpOAuthStore: createRemoteMcpOAuthRepository(pool),
          envelopeEncryptionProvider: runtime.personalProvider,
          teamEnvelopeEncryptionProvider: runtime.teamProvider,
          ownerPrivateReplicaEnvelopeEncryptionProvider: runtime.ownerProvider,
          fetch: providerFetch,
          inspectDeploymentIdentity: () => ({
            health: "healthy",
            deploymentId: randomUUID(),
            deviceInstanceId: randomUUID(),
            remoteOperationsAllowed: true,
            message: "Synthetic test deployment",
            platformProtection: "verified"
          })
        });
      app = await createServer();
      origin = await app.listen({ host: "127.0.0.1", port: 0 });
      expect(
        (await request(await issue(true, true), "/v1/access/check")).statusCode
      ).toBe(200);
    }, 120_000);

    afterAll(async () => {
      if (app) await app.close();
      await pool.end();
      await admin.query(`drop database if exists ${database}`);
      await admin.end();
      vi.unstubAllEnvs();
      if (home) rmSync(home, { recursive: true, force: true });
    }, 60_000);

    it("advertises both issuers and serves bounded onboarding instructions", async () => {
      const guide = await request("", "/auth.md");
      expect(guide.statusCode).toBe(200);
      expect(guide.body).toContain("koed:team:read");
      expect(guide.headers["cache-control"]).toBe("no-store");
      const metadata = await request(
        "",
        "/.well-known/oauth-protected-resource/mcp"
      );
      expect(metadata.statusCode, metadata.body).toBe(200);
      expect(metadata.json().authorization_servers).toContain(issuer);
      expect(metadata.json().authorization_servers).toHaveLength(2);
      const authorizationMetadata = await request(
        "",
        "/.well-known/oauth-authorization-server"
      );
      expect(metadata.json().authorization_servers[0]).toBe(
        authorizationMetadata.json().issuer
      );
      expect(metadata.json().authorization_servers[0]).toBe(
        new URL("/", resource).href
      );
    });

    it("throttles one transport peer before spending the shared provider budget", async () => {
      vi.stubEnv("WORKOS_AGENT_REGISTRATION_REQUESTS_PER_MINUTE", "12");
      vi.stubEnv("WORKOS_AGENT_REGISTRATION_PEER_REQUESTS_PER_MINUTE", "3");
      const limited = await createServer();
      try {
        const token = await issue();
        const forged = `${token.split(".").slice(0, 2).join(".")}.invalid_signature`;
        const countProviderCalls = () =>
          providerFetch.mock.calls.filter(([url]) =>
            String(url).startsWith("https://api.workos.com/")
          ).length;
        const calls = countProviderCalls();
        for (let attempt = 0; attempt < 3; attempt++) {
          const denied = await limited.inject({
            method: "GET",
            url: "/v1/access/check",
            remoteAddress: "192.0.2.10",
            headers: { authorization: `Bearer ${forged}` }
          });
          expect(denied.statusCode).toBe(401);
        }
        expect(countProviderCalls() - calls).toBe(0);
        for (const path of ["/v1/access/check", "/mcp"]) {
          const denied = await limited.inject({
            method: "GET",
            url: path,
            remoteAddress: "192.0.2.10",
            headers: {
              authorization: `Bearer ${token}`,
              "x-forwarded-for": "198.51.100.20"
            }
          });
          expect(denied.statusCode).toBe(429);
          expect(denied.headers["retry-after"]).toBeDefined();
        }
        expect(countProviderCalls() - calls).toBe(0);
        const allowed = await limited.inject({
          method: "GET",
          url: "/v1/access/check",
          remoteAddress: "192.0.2.11",
          headers: { authorization: `Bearer ${token}` }
        });
        expect(allowed.statusCode, allowed.body).toBe(200);
        expect(countProviderCalls() - calls).toBe(2);
      } finally {
        await limited.close();
        vi.stubEnv("WORKOS_AGENT_REGISTRATION_REQUESTS_PER_MINUTE", "10000");
        vi.stubEnv(
          "WORKOS_AGENT_REGISTRATION_PEER_REQUESTS_PER_MINUTE",
          undefined
        );
      }
    });

    it("keeps verified Users behind one peer independent and does not charge forged identities", async () => {
      vi.stubEnv("WORKOS_AGENT_REGISTRATION_USER_REQUESTS_PER_MINUTE", "1");
      vi.stubEnv(
        "WORKOS_AGENT_REGISTRATION_REGISTRATION_REQUESTS_PER_MINUTE",
        "1"
      );
      const limited = await createServer();
      const inject = (token: string) =>
        limited.inject({
          method: "GET",
          url: "/v1/access/check",
          remoteAddress: "192.0.2.42",
          headers: { authorization: `Bearer ${token}` }
        });
      const countProviderCalls = () =>
        providerFetch.mock.calls.filter(([url]) =>
          String(url).startsWith("https://api.workos.com/")
        ).length;
      try {
        const first = await issue();
        const calls = countProviderCalls();
        expect((await inject(first)).statusCode).toBe(200);
        expect((await inject(first)).statusCode).toBe(429);
        const [header, encoded, signature] = first.split(".");
        const payload = JSON.parse(
          Buffer.from(encoded!, "base64url").toString("utf8")
        );
        payload.act = { sub: "user_second" };
        const forged = `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
        expect((await inject(forged)).statusCode).toBe(401);
        expect(countProviderCalls() - calls).toBe(2);
        const second = await issue(
          true,
          false,
          false,
          "user_second",
          "agent_reg_second"
        );
        const allowed = await inject(second);
        expect(allowed.statusCode, allowed.body).toBe(200);
        expect(countProviderCalls() - calls).toBe(4);
      } finally {
        await limited.close();
        vi.stubEnv(
          "WORKOS_AGENT_REGISTRATION_USER_REQUESTS_PER_MINUTE",
          undefined
        );
        vi.stubEnv(
          "WORKOS_AGENT_REGISTRATION_REGISTRATION_REQUESTS_PER_MINUTE",
          undefined
        );
      }
    });

    it("expands Shared Memory only within the credential's mapped Team", async () => {
      const path = `/v1/memory/nodes/${candidateId}/expand?${new URLSearchParams({ team_workspace_id: workspaceId, search_domain: "global" })}`;
      const allowed = await request(await issue(), path);
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(allowed.json().expanded).not.toBeNull();
      expect(
        await repository.getTeamWorkspaceContext({ userId }, workspaceId)
      ).not.toBeNull();
      const otherToken = await issue(true, false, true);
      teamDecrypt.mockClear();
      const denied = await request(otherToken, path);
      expect(denied.statusCode, denied.body).toBe(200);
      expect(denied.json().expanded).toBeNull();
      expect(teamDecrypt).not.toHaveBeenCalled();
    });

    it("retains Personal task access and requires explicit Team consent", async () => {
      const personal = await issue(false);
      expect((await accept(personal)).statusCode).toBe(200);
      expect((await accept(personal, workspaceId)).statusCode).toBe(403);
      expect((await request(personal, "/v1/team-context")).statusCode).toBe(
        403
      );
    });

    it("limits discovery and admission even when the User belongs to both Teams", async () => {
      const token = await issue();
      const contexts = await request(token, "/v1/team-context");
      expect(contexts.statusCode, contexts.body).toBe(200);
      expect(contexts.body).toContain(workspaceId);
      expect(contexts.body).not.toContain(otherWorkspaceId);
      expect(
        (
          await request(
            token,
            `/v1/team-workspaces/${otherWorkspaceId}/context`
          )
        ).statusCode
      ).toBe(403);
      expect((await accept(token, workspaceId)).statusCode).toBe(200);
      expect((await accept(token, otherWorkspaceId)).statusCode).toBe(403);
      expect(
        await repository.getTeamWorkspaceContext({ userId }, otherWorkspaceId)
      ).not.toBeNull();
    });

    it("does not read, claim, cancel or prune another organisation's tasks", async () => {
      const actor = { userId, allowTeam: true };
      const outside = await repository.acceptMemoryAnswerTask(actor, {
        origin: "mcp",
        maxQueued: 100,
        teamWorkspaceId: otherWorkspaceId,
        request: {
          input: {
            query: "other organisation secret",
            team_workspace_id: otherWorkspaceId
          }
        }
      });
      const token = await issue(true, true);
      decrypt.mockClear();
      expect(
        (await request(token, `/v1/memory/answer-tasks/${outside.id}`))
          .statusCode
      ).toBe(403);
      expect(
        (
          await request(
            token,
            `/v1/memory/answer-tasks/${outside.id}/cancel`,
            {}
          )
        ).statusCode
      ).toBe(403);
      expect(decrypt).not.toHaveBeenCalled();
      const scoped = { ...actor, teamBoundaryId: teamId };
      const claimed = await repository.claimMemoryAnswerTask(scoped, {
        leaseOwner: "bounded-helper",
        leaseMs: 30000,
        allowTeam: true,
        scopeFilter: "team"
      });
      expect(claimed.task?.id).not.toBe(outside.id);
      expect(
        (await repository.getMemoryAnswerTask(actor, outside.id))?.status
      ).toBe("accepted");
      await repository.cancelMemoryAnswerTask(actor, outside.id);
      await pool.query(
        "update memory_answer_tasks set expires_at=now()-interval '1 hour' where id=$1",
        [outside.id]
      );
      await repository.deleteExpiredMemoryAnswerTasks(scoped);
      expect(
        (
          await pool.query("select id from memory_answer_tasks where id=$1", [
            outside.id
          ])
        ).rowCount
      ).toBe(1);
    });

    it("applies the organisation ceiling to retrieval and encrypted answer history", async () => {
      const token = await issue(true, true);
      const actor = { userId, allowTeam: true };
      const scoped = { ...actor, teamBoundaryId: teamId };
      const boundary =
        await repository.freezeSharedMemorySemanticRecallBoundary(scoped, {
          teamWorkspaceId: workspaceId,
          maximumGrantCount: 128
        });
      expect(boundary.shareGrantIds.length).toBeGreaterThan(0);
      for (const path of ["/v1/memory/search", "/v1/memory/answer"])
        expect(
          (
            await request(token, path, {
              query: "decisions",
              search_domain: "global",
              team_workspace_id: otherWorkspaceId
            })
          ).statusCode
        ).toBe(403);
      const input = {
        teamWorkspaceId: workspaceId,
        queryVector: Array(1024).fill(0),
        model: "qwen3-0.6b",
        dimensions: 1024 as const,
        version: "test",
        limit: 20,
        searchDomain: "global" as const
      };
      // Even a caller-supplied frozen boundary cannot broaden credential authority.
      const outsideActor = { ...actor, teamBoundaryId: otherTeamId };
      expect(
        await repository.scanAuthorizedSharedMemorySemanticItems(outsideActor, {
          ...input,
          authorizationBoundary: boundary
        })
      ).toEqual([]);
      expect(
        await repository.searchAuthorizedSharedMemorySemanticItems(
          outsideActor,
          {
            ...input,
            authorizationBoundary: boundary
          }
        )
      ).toEqual([]);
      const question = await repository.createFinalMemoryQuestion(actor, {
        idempotencyKey: randomUUID(),
        query: "Other Team question",
        searchDomain: "global",
        teamWorkspaceId: otherWorkspaceId,
        status: "answered",
        answerMarkdown: "Other Team private answer"
      });
      decrypt.mockClear();
      expect(
        (await request(token, `/v1/memory/questions/${question.id}`)).statusCode
      ).toBe(403);
      expect(decrypt).not.toHaveBeenCalled();
      const personalOnly = await issue(false);
      expect(
        (await request(personalOnly, `/v1/memory/questions/${question.id}`))
          .statusCode
      ).toBe(403);
      const historyCalls = providerFetch.mock.calls.length;
      const personalHistory = await request(
        personalOnly,
        "/v1/memory/questions"
      );
      expect(personalHistory.statusCode).toBe(200);
      expect(personalHistory.body).not.toContain("Other Team private answer");
      expect(providerFetch.mock.calls.length - historyCalls).toBe(2);
      expect(
        (await request(personalOnly, "/v1/memory/questions")).statusCode
      ).toBe(200);
      expect(providerFetch.mock.calls.length - historyCalls).toBe(4);
      await expect(
        repository.createFinalMemoryQuestion(scoped, {
          idempotencyKey: randomUUID(),
          query: "Wrong Team write",
          searchDomain: "global",
          teamWorkspaceId: otherWorkspaceId,
          status: "answered",
          answerMarkdown: "Not allowed"
        })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("collects a local helper's Team answer over the real MCP HTTP transport", async () => {
      const token = await issue(true, true);
      const client = new Client({ name: "workos-mcp-test", version: "1" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
            fetch: async (url, init) =>
              new Promise<Response>((resolve, reject) => {
                const request = httpRequest(
                  String(url),
                  {
                    method: init?.method,
                    signal: init?.signal ?? undefined,
                    headers: {
                      ...Object.fromEntries(new Headers(init?.headers)),
                      host: new URL(resource).host
                    }
                  },
                  (response) => {
                    const headers = new Headers();
                    for (const [name, value] of Object.entries(
                      response.headers
                    ))
                      if (value !== undefined)
                        headers.set(
                          name,
                          Array.isArray(value) ? value.join(", ") : value
                        );
                    resolve(
                      new Response(
                        response.statusCode === 204
                          ? null
                          : (Readable.toWeb(
                              response
                            ) as ReadableStream<Uint8Array>),
                        {
                          status: response.statusCode,
                          headers
                        }
                      )
                    );
                  }
                );
                request.on("error", reject);
                request.end(init?.body);
              })
          })
        );
        const workspaces = await client.callTool({
          name: "memory_workspaces",
          arguments: {}
        });
        expect(JSON.stringify(workspaces)).toContain(workspaceId);
        expect(JSON.stringify(workspaces)).not.toContain(otherWorkspaceId);
        const receipt = await client.callTool({
          name: "memory_answer",
          arguments: {
            query: "Team decisions",
            delivery_mode: "non_blocking",
            search_domain: "global",
            team_workspace_id: workspaceId,
            team_backend_id: "remote"
          }
        });
        expect(receipt.isError, JSON.stringify(receipt)).not.toBe(true);
        const { task_id: taskId } = z
          .object({ task_id: z.string().uuid() })
          .parse(receipt.structuredContent);
        // Use the existing helper contract, not a separate WorkOS answer service.
        const actor = { userId, allowTeam: true, teamBoundaryId: teamId };
        await pool.query(
          "update memory_answer_tasks set available_at=now()-interval '1 hour' where id=$1",
          [taskId]
        );
        const claimed = await repository.claimMemoryAnswerTask(actor, {
          leaseOwner: "workos-test-helper",
          leaseMs: 30000,
          allowTeam: true,
          scopeFilter: "team"
        });
        expect(claimed.task?.id).toBe(taskId);
        const answer = "Answer from the User-owned Local AI Runtime";
        expect(
          await repository.completeMemoryAnswerTask(actor, {
            taskId,
            leaseOwner: claimed.task!.leaseOwner!,
            fenceGeneration: claimed.task!.fenceGeneration,
            finalQuestion: {
              idempotencyKey: randomUUID(),
              query: "Team decisions",
              searchDomain: "global",
              teamWorkspaceId: workspaceId,
              status: "answered",
              answerMarkdown: answer
            },
            result: { markdown: answer, citations: [] }
          })
        ).toMatchObject({ status: "completed" });
        const result = await client.callTool({
          name: "memory_answer_result",
          arguments: { task_id: taskId }
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(JSON.stringify(result.content)).toContain(answer);
      } finally {
        await client.close();
      }
    });

    it("rechecks organisation mapping and registration revocation on the next request", async () => {
      const token = await issue();
      await pool.query(
        "update external_auth_organizations set status='disabled' where provider_organization_id='org_test'"
      );
      expect((await request(token, "/v1/team-context")).statusCode).toBe(401);
      await pool.query(
        "update external_auth_organizations set status='linked' where provider_organization_id='org_test'"
      );
      expect((await request(token, "/v1/team-context")).statusCode).toBe(200);
      revoked = true;
      expect((await request(token, "/v1/team-context")).statusCode).toBe(401);
      revoked = false;
    });

    it("withdraws Personal, Team, task and MCP access from old and replacement credentials until owner reapproval", async () => {
      const token = await issue(true, true);
      const personal = await accept(token);
      const personalTaskId = personal.json().task.id;
      const team = await accept(token, workspaceId);
      const teamTaskId = team.json().task.id;
      const store = createRemoteMcpOAuthRepository(pool);
      const grant = (await store.listConnections(userId, resource)).find(
        (g) => g.registrationId === "agent_reg_fixture"
      )!;
      expect(grant).toBeDefined();
      expect(
        await store.updateConnection({
          userId,
          resource,
          id: grant.id,
          version: grant.authorizationVersion,
          action: "disconnect",
          now: new Date(),
          expiresAt: new Date(Date.now() + 86400_000)
        })
      ).toBe(true);
      await store.pruneExpired(new Date());
      for (const credential of [token, await issue(true, true)]) {
        for (const path of [
          "/v1/access/check",
          "/v1/team-context",
          `/v1/memory/answer-tasks/${personalTaskId}`,
          `/v1/memory/answer-tasks/${teamTaskId}`
        ])
          expect((await request(credential, path)).statusCode).toBe(401);
        expect((await accept(credential)).statusCode).toBe(401);
        expect((await accept(credential, workspaceId)).statusCode).toBe(401);
        const mcp = await app.inject({
          method: "POST",
          url: "/mcp",
          headers: {
            authorization: `Bearer ${credential}`,
            host: new URL(resource).host,
            accept: "application/json, text/event-stream",
            "content-type": "application/json"
          },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "disconnected", version: "1" }
            }
          }
        });
        expect(mcp.statusCode).toBe(401);
      }
      expect(
        await store.updateConnection({
          userId,
          resource,
          id: grant.id,
          version: grant.authorizationVersion + 1,
          action: "approve",
          now: new Date(),
          expiresAt: new Date(Date.now() + 86400_000)
        })
      ).toBe(true);
      expect(
        (await request(await issue(), "/v1/team-context")).statusCode
      ).toBe(200);
      await pool.query(
        "update remote_mcp_oauth_grants set expires_at=now()-interval '1 second' where id=$1",
        [grant.id]
      );
      expect(
        (await request(await issue(), "/v1/access/check")).statusCode
      ).toBe(401);
    });
  }
);
