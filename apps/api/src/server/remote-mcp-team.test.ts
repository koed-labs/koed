import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDbPool,
  createMemorySourceRepository,
  createRemoteMcpOAuthRepository,
  runDbMigrations
} from "@koed/db";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from "@modelcontextprotocol/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { createRemoteMcpOAuthProvider } from "../auth/remote-mcp-oauth.js";
import { embedTeamSemanticQuery } from "../memory/team-semantic-embedding.js";
import { buildServer } from "./build-server.js";
import { MemoryApiClient } from "../../../../packages/mcp-server/src/index.js";
import {
  MemoryToolExecutor,
  type MemoryToolExecutorServices
} from "../../../../packages/mcp-server/src/memory-tool-executor.js";
import type { MemoryAnswerWorkerResponse } from "../../../../packages/mcp-server/src/answer-worker.js";

const databaseUrl = process.env.KOED_OAUTH_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("remote MCP Team fixture authority", () => {
  const database = `mcp_team_${randomUUID().replaceAll("-", "")}`;
  const admin = createDbPool({
    connectionString: databaseUrl ?? "postgresql://localhost/postgres"
  });
  const isolatedUrl = new URL(databaseUrl ?? "postgresql://localhost/postgres");
  isolatedUrl.pathname = `/${database}`;
  const pool = createDbPool({ connectionString: isolatedUrl.toString() });
  const resource = new URL("https://memory.test/mcp");
  const store = createRemoteMcpOAuthRepository(pool);
  const oauth = createRemoteMcpOAuthProvider({ store, resourceUrl: resource });
  let home: string;
  const embeddingFetch = vi.fn(async () =>
    Response.json({
      model: "qwen3-0.6b",
      dimensions: 1024,
      vectors: [
        Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0))
      ]
    })
  );
  let app: Awaited<ReturnType<typeof buildServer>>;
  let fixture: {
    fixtureUsers: Record<string, { id: string }>;
    fixtureWorkspaces: Record<string, { id: string }>;
  };
  let decrypt: ReturnType<typeof vi.spyOn>;
  let personalDecrypt: ReturnType<typeof vi.spyOn>;
  let repository: ReturnType<typeof createMemorySourceRepository>;
  const taskIds = new Set<string>();

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "koed-mcp-team-"));
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("KOED_HOME", home);
    vi.stubEnv("API_TOKEN_PEPPER", randomUUID());
    vi.stubEnv("KOED_REMOTE_MCP_ENABLED", "true");
    vi.stubEnv("KOED_REMOTE_MCP_PUBLIC_URL", resource.href);
    vi.stubEnv("KOED_TEAM_COLLABORATION_ENABLED", "true");
    vi.stubEnv("KOED_DEVELOPER_TEAM_BACKEND_ENABLED", "true");
    vi.stubEnv("KOED_DEPLOYMENT_PROFILE", "developer");
    vi.stubEnv("EMBEDDING_MODEL", "qwen3-0.6b");
    vi.stubEnv("WORK_QUEUE_BACKEND", "memory");
    await admin.query(`create database ${database}`);
    await runDbMigrations(pool);
    const fixtureModule = await import(
      new URL("../../../../scripts/team-saas-fixture-lib.mjs", import.meta.url)
        .href
    );
    fixture = fixtureModule;
    const runtime = await fixtureModule.createFixtureRuntime(pool, {
      environment: { NODE_ENV: "test" }
    });
    await fixtureModule.seedFixture(pool, runtime);
    await fixtureModule.validateFixture(pool, runtime);
    const embedding = await embedTeamSemanticQuery("fixture", embeddingFetch);
    // Deterministic vectors exercise production retrieval, not semantic quality.
    const pending =
      await runtime.sharedMemoryRepository.listPendingSharedMemorySemanticItems(
        {
          limit: 200,
          model: embedding.model,
          dimensions: embedding.dimensions,
          version: embedding.version
        }
      );
    expect(pending.length).toBeGreaterThan(0);
    for (const item of pending) {
      expect(
        await runtime.sharedMemoryRepository.storeSharedMemorySemanticEmbedding(
          {
            semanticItemId: item.semanticItemId,
            contentHash: item.contentHash,
            ...embedding
          }
        )
      ).toBe(true);
    }
    repository = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: runtime.personalProvider,
      teamEnvelopeEncryptionProvider: runtime.teamProvider,
      ownerPrivateReplicaEnvelopeEncryptionProvider: runtime.ownerProvider
    });
    decrypt = vi.spyOn(runtime.teamProvider, "decrypt");
    personalDecrypt = vi.spyOn(runtime.personalProvider, "decrypt");
    app = await buildServer({
      repository,
      remoteMcpOAuthStore: store,
      envelopeEncryptionProvider: runtime.personalProvider,
      teamEnvelopeEncryptionProvider: runtime.teamProvider,
      ownerPrivateReplicaEnvelopeEncryptionProvider: runtime.ownerProvider,
      internalServiceFetch: embeddingFetch,
      inspectDeploymentIdentity: () => ({
        health: "healthy",
        deploymentId: randomUUID(),
        deviceInstanceId: randomUUID(),
        remoteOperationsAllowed: true,
        message: "Synthetic test deployment",
        platformProtection: "verified"
      })
    });
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    await pool.end();
    await admin.query(`drop database if exists ${database}`);
    await admin.end();
    vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
  }, 60000);
  beforeEach(async () => {
    await pool.query(
      "delete from memory_answer_tasks where id=any($1::uuid[])",
      [[...taskIds]]
    );
    await pool.query(
      "delete from memory_questions where idempotency_key=any($1::text[])",
      [[...taskIds].map((id) => `memory-answer-task:${id}`)]
    );
    taskIds.clear();
  });

  const issue = async (actor: string, teamRead = true, execution = false) => {
    const client = await oauth.provider.clientsStore.registerClient!({
      redirect_uris: ["http://127.0.0.1:5555/callback"],
      token_endpoint_auth_method: "none"
    });
    const verifier = "z".repeat(43);
    let consentUrl = "";
    const scopes = [
      "koed:memory:read",
      ...(teamRead ? ["koed:team:read"] : []),
      ...(execution ? ["koed:local-execution"] : [])
    ];
    await oauth.provider.authorize(
      client,
      {
        redirectUri: client.redirect_uris[0]!,
        resource,
        scopes,
        codeChallenge: createHash("sha256").update(verifier).digest("base64url")
      },
      {
        redirect: (_status: number, url: string) => {
          consentUrl = url;
        }
      } as never
    );
    const requestSecret = new URL(consentUrl).searchParams.get("request")!;
    expect(
      (await oauth.getAuthorizationRequest(requestSecret))?.scopes
    ).toEqual(scopes);
    const approved = await oauth.completeAuthorization({
      requestSecret,
      userId: fixture.fixtureUsers[actor]!.id,
      approved: true
    });
    const code = new URL(approved.redirectUrl).searchParams.get("code")!;
    return (
      await oauth.provider.exchangeAuthorizationCode(
        client,
        code,
        verifier,
        client.redirect_uris[0],
        resource
      )
    ).access_token;
  };

  const rpc = (
    token: string,
    name: string,
    args: Record<string, unknown> = {}
  ) =>
    app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: resource.host,
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": name
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "fixture-team", version: "1" },
            [CLIENT_CAPABILITIES_META_KEY]: {}
          }
        }
      }
    });
  const answer = (token: string, workspace: string) =>
    rpc(token, "memory_answer", {
      query: "Team decisions",
      search_domain: "global",
      team_backend_id: "remote",
      team_workspace_id: fixture.fixtureWorkspaces[workspace]!.id,
      limit: 20
    });

  const api = (token: string, url: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: payload ? "POST" : "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {})
    });
  const taskInput = (workspace: string) => ({
    query: "Team decisions",
    search_domain: "global",
    team_backend_id: "remote",
    team_workspace_id: fixture.fixtureWorkspaces[workspace]!.id,
    limit: 20
  });
  const accept = async (token: string, workspace = "cloud") => {
    const response = await api(token, "/v1/memory/answer-tasks", {
      origin: "mcp",
      max_queued: 100,
      request: { input: taskInput(workspace), caller: { cwd: "" } }
    });
    expect(response.statusCode, response.body).toBe(200);
    taskIds.add(response.json().task.id);
    return response.json().task;
  };
  const claim = async (token: string) => {
    const response = await api(token, "/v1/memory/answer-tasks/claim", {
      lease_owner: "fixture-local-helper",
      lease_ms: 180000,
      scope_filter: "team"
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().task;
  };
  const claimReady = async (token: string) => {
    // MCP observation briefly locks this row; match the helper's bounded retry.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const task = await claim(token);
      if (task) return task;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Local helper did not claim the accepted Team task");
  };
  const completion = (
    task: { fenceGeneration: number; teamWorkspaceId: string },
    markdown = "Local helper fixture synthesis"
  ) => ({
    lease_owner: "fixture-local-helper",
    fence_generation: task.fenceGeneration,
    final_question: {
      idempotency_key: randomUUID(),
      origin: "mcp_memory_answer",
      query: "Team decisions",
      retrieval_scope: "personal",
      search_domain: "global",
      team_workspace_id: task.teamWorkspaceId,
      status: "answered",
      answer_markdown: markdown,
      evidence: [],
      citations: []
    },
    result: { markdown, citations: [] }
  });
  const complete = async (
    token: string,
    task: { id: string; fenceGeneration: number; teamWorkspaceId: string }
  ) => {
    const response = await api(
      token,
      `/v1/memory/answer-tasks/${task.id}/complete`,
      completion(task)
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json().task;
  };
  const clearDecrypt = () => {
    decrypt.mockClear();
    personalDecrypt.mockClear();
  };
  const expectNoDecrypt = () => {
    expect(decrypt).not.toHaveBeenCalled();
    expect(personalDecrypt).not.toHaveBeenCalled();
  };

  it("requires explicit Team consent and never grants Personal API Tokens Team rights", async () => {
    const token = await issue("carol", false);
    decrypt.mockClear();
    const denied = await answer(token, "electron");
    expect(denied.json().result.isError).toBe(true);
    expect(decrypt).not.toHaveBeenCalled();
    const delegated = await api(token, "/v1/memory/answer-tasks", {
      origin: "mcp",
      max_queued: 100,
      request: { input: taskInput("electron"), caller: { cwd: "" } }
    });
    expect(delegated.statusCode).toBe(403);
    const user = fixture.fixtureUsers.carol!.id;
    const secret = `personal-${randomUUID()}`;
    await repository.createApiToken({
      ownerUserId: user,
      name: "Synthetic Personal token",
      tokenPrefix: secret.slice(0, 12),
      tokenHash: createHash("sha256")
        .update(`${process.env.API_TOKEN_PEPPER}${secret}`)
        .digest("hex")
    });
    const personal = await api(secret, "/v1/memory/answer-tasks", {
      origin: "mcp",
      max_queued: 100,
      request: { input: taskInput("electron"), caller: { cwd: "" } }
    });
    expect(personal.statusCode).toBe(403);
    expect(decrypt).not.toHaveBeenCalled();
    expect((await rpc(secret, "memory_workspaces")).statusCode).toBe(401);
  });

  it("discovers Workspaces and delivers the local execution result after atomic Team task completion", async () => {
    const token = await issue("alice");
    const helper = await issue("alice", true, true);
    const discovery = await rpc(token, "memory_workspaces");
    expect(discovery.statusCode).toBe(200);
    expect(JSON.stringify(discovery.json())).toContain("Electron Team App");
    const original = repository.acceptMemoryAnswerTask.bind(repository);
    let notify!: (task: Awaited<ReturnType<typeof original>>) => void;
    const accepted = new Promise<Awaited<ReturnType<typeof original>>>(
      (resolve) => {
        notify = resolve;
      }
    );
    repository.acceptMemoryAnswerTask = async (...args) => {
      try {
        const task = await original(...args);
        taskIds.add(task.id);
        notify(task);
        return task;
      } finally {
        repository.acceptMemoryAnswerTask = original;
      }
    };
    const remoteAnswer = answer(token, "electron");
    const acceptedTask = await Promise.race([
      accepted,
      Promise.resolve(remoteAnswer).then((response) => {
        if (response.json().result.isError) throw new Error(response.body);
        return accepted;
      })
    ]);
    const deniedClaim = await api(token, "/v1/memory/answer-tasks/claim", {
      lease_owner: "fixture-local-helper",
      lease_ms: 180000,
      scope_filter: "team"
    });
    expect(deniedClaim.statusCode).toBe(403);
    const authority = await repository.getMemoryAnswerTaskTeamAuthority(
      { userId: fixture.fixtureUsers.alice!.id, allowTeam: true },
      acceptedTask.id
    );
    expect(authority).toBeTruthy();
    const task = await claimReady(helper);
    expect(task.id).toBe(acceptedTask.id);
    expect(task.executionAuthority).toMatchObject({
      scope: "team",
      teamWorkspaceId: fixture.fixtureWorkspaces.electron!.id
    });
    clearDecrypt();
    class HelperMemoryApiClient extends MemoryApiClient {
      protected override async request<T>(
        method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
        pathname: string,
        body?: unknown
      ): Promise<T> {
        const response = await app.inject({
          method,
          url: pathname,
          headers: { authorization: `Bearer ${helper}` },
          ...(body === undefined
            ? {}
            : { payload: body as Record<string, unknown> })
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<T>();
      }
    }
    const client = new HelperMemoryApiClient({ apiUrl: resource.origin });
    const answerWorker = vi.fn<
      NonNullable<MemoryToolExecutorServices["answerWithMemoryWorker"]>
    >(async (payload, options) => {
      expect(payload.authorizationBoundary).toBe(
        task.executionAuthority.authorizationBoundary
      );
      const retrieved = await options!.client!.search({
        query: "Team decisions",
        search_domain: "global",
        retrieval_scope: "personal",
        limit: 20,
        team_workspace_id: randomUUID(),
        authorization_boundary: "untrusted-model-value"
      });
      const evidence = JSON.stringify(retrieved);
      expect(evidence).toContain("Workspace Memory Timeline");
      expect(evidence).not.toContain("Private DevOps Scratchpad");
      expect(evidence).not.toContain("Revoked Electron Experiment");
      const hits = Array.isArray(retrieved.hits) ? retrieved.hits : [];
      expect(hits.length).toBeGreaterThan(0);
      return {
        ...payload,
        markdown: "Local helper fixture synthesis",
        citations: [],
        retrieval: { evidenceCount: hits.length },
        evidenceBundle: {
          ...payload.evidenceBundle,
          evidence: hits,
          retrieval: { evidenceCount: hits.length }
        },
        localMemoryWorker: {
          provider: "codex",
          promptVersion: "fixture",
          jobId: task.id,
          model: "synthetic",
          usedFallback: false
        }
      } satisfies MemoryAnswerWorkerResponse;
    });
    const executor = new MemoryToolExecutor(
      client,
      {},
      { answerWithMemoryWorker: answerWorker }
    );
    const prepared = await executor.executeMemoryAnswerTask(
      task.request.input,
      task.request.caller,
      task.id,
      undefined,
      undefined,
      {
        getExecutionAuthority: () => task.executionAuthority,
        taskBackend: client
      }
    );
    expect(answerWorker).toHaveBeenCalledOnce();
    expect(decrypt).toHaveBeenCalled();
    expect(prepared.finalQuestion).toMatchObject({
      status: "answered",
      team_workspace_id: task.teamWorkspaceId,
      answer_markdown: "Local helper fixture synthesis"
    });
    const completionResponse = await api(
      helper,
      `/v1/memory/answer-tasks/${task.id}/complete`,
      {
        lease_owner: "fixture-local-helper",
        fence_generation: task.fenceGeneration,
        final_question: prepared.finalQuestion,
        result: prepared.result
      }
    );
    expect(completionResponse.statusCode, completionResponse.body).toBe(200);
    const completed = completionResponse.json().task;
    const result = await remoteAnswer;
    expect(result.statusCode).toBe(200);
    expect(result.json().result.isError, result.body).not.toBe(true);
    expect(result.body).toContain("Local helper fixture synthesis");
    expect(completed.questionId).toEqual(expect.any(String));
    const detail = await api(
      token,
      `/v1/memory/questions/${completed.questionId}`
    );
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.body).toContain("Local helper fixture synthesis");
    expect(detail.body).toContain("Workspace Memory Timeline");
    expect((await api(token, "/v1/memory/questions")).body).toContain(
      completed.questionId
    );
    const raw = await pool.query(
      "select request_snapshot,result_snapshot from memory_answer_tasks where id=$1",
      [task.id]
    );
    expect(JSON.stringify(raw.rows)).not.toContain(
      "Local helper fixture synthesis"
    );
    expect(JSON.stringify(raw.rows)).not.toContain("Team decisions");
    await pool.query("delete from memory_answer_tasks where id=$1", [task.id]);
    await pool.query("delete from memory_questions where id=$1", [
      completed.questionId
    ]);
  }, 180_000);

  it("denies disabled and removed members and Workspace access loss before decrypt", async () => {
    decrypt.mockClear();
    await expect(issue("dana")).rejects.toThrow();
    expect(decrypt).not.toHaveBeenCalled();
    for (const actor of ["frank", "bob"]) {
      const token = await issue(actor);
      decrypt.mockClear();
      embeddingFetch.mockClear();
      const result = await api(token, "/v1/memory/answer-tasks", {
        origin: "mcp",
        max_queued: 100,
        request: {
          input: taskInput(actor === "bob" ? "cloud" : "electron"),
          caller: { cwd: "" }
        }
      });
      expect(result.statusCode, actor).toBe(403);
      expect(decrypt, actor).not.toHaveBeenCalled();
      expect(embeddingFetch, actor).not.toHaveBeenCalled();
    }
  });

  it.each([
    "membership",
    "workspace_downgrade",
    "grant_revocation",
    "source_revision",
    "privacy_policy"
  ] as const)(
    "denies %s changes before task or completed history decryption",
    async (change) => {
      const token = await issue("alice");
      const helper = await issue("alice", true, true);
      const completedInput = await accept(token);
      const completed = await complete(helper, await claimReady(helper));
      const runningInput = await accept(token);
      const running = await claimReady(helper);
      const queued = await accept(token);
      expect(running.id).toBe(runningInput.id);
      const { rows } = await pool.query(
        "select team_authorization from memory_answer_tasks where id=$1",
        [completedInput.id]
      );
      const grantId =
        rows[0].team_authorization.recallBoundary.shareGrantIds[0];
      expect(grantId).toBeTruthy();
      let restore: () => Promise<unknown>;
      if (change === "membership") {
        const { rows: original } = await pool.query(
          "select status,version from team_memberships where user_id=$1",
          [fixture.fixtureUsers.alice!.id]
        );
        await pool.query(
          "update team_memberships set status='disabled',version=version+1 where user_id=$1",
          [fixture.fixtureUsers.alice!.id]
        );
        restore = () =>
          pool.query(
            "update team_memberships set status=$2,version=$3 where user_id=$1",
            [
              fixture.fixtureUsers.alice!.id,
              original[0].status,
              original[0].version
            ]
          );
      } else if (change === "workspace_downgrade") {
        const { rows: original } = await pool.query(
          "select access,version,can_share_owned_memory from team_workspace_access_grants where user_id=$1 and team_workspace_id=$2",
          [fixture.fixtureUsers.alice!.id, fixture.fixtureWorkspaces.cloud!.id]
        );
        expect(original[0].access).toBe("write");
        await pool.query(
          "update team_workspace_access_grants set access='read',can_share_owned_memory=false,version=version+1 where user_id=$1 and team_workspace_id=$2",
          [fixture.fixtureUsers.alice!.id, fixture.fixtureWorkspaces.cloud!.id]
        );
        restore = () =>
          pool.query(
            "update team_workspace_access_grants set access=$3,version=$4,can_share_owned_memory=$5 where user_id=$1 and team_workspace_id=$2",
            [
              fixture.fixtureUsers.alice!.id,
              fixture.fixtureWorkspaces.cloud!.id,
              original[0].access,
              original[0].version,
              original[0].can_share_owned_memory
            ]
          );
      } else if (change === "grant_revocation") {
        const { rows: original } = await pool.query(
          "select revoked_at,grant_version from team_memory_share_grants where id=$1",
          [grantId]
        );
        await pool.query(
          "update team_memory_share_grants set revoked_at=now(),grant_version=grant_version+1 where id=$1",
          [grantId]
        );
        restore = () =>
          pool.query(
            "update team_memory_share_grants set revoked_at=$2,grant_version=$3 where id=$1",
            [grantId, original[0].revoked_at, original[0].grant_version]
          );
      } else {
        const column =
          change === "source_revision"
            ? "source_revision_hash"
            : "effective_privacy_policy_hash";
        const { rows: original } = await pool.query(
          `select id,${column} from team_memory_representations where share_grant_id=$1`,
          [grantId]
        );
        await pool.query(
          `update team_memory_representations set ${column}=$2 where share_grant_id=$1`,
          [grantId, "f".repeat(64)]
        );
        restore = async () => {
          for (const row of original)
            await pool.query(
              `update team_memory_representations set ${column}=$2 where id=$1`,
              [row.id, row[column]]
            );
        };
      }
      try {
        clearDecrypt();
        const claimed = await claim(helper);
        expect(claimed).toBeNull();
        for (const id of [completed.id, running.id, queued.id]) {
          const response = await api(token, `/v1/memory/answer-tasks/${id}`);
          expect(response.statusCode, response.body).toBe(403);
        }
        const heartbeat = await api(
          helper,
          `/v1/memory/answer-tasks/${running.id}/heartbeat`,
          {
            lease_owner: "fixture-local-helper",
            fence_generation: running.fenceGeneration,
            lease_ms: 180000
          }
        );
        expect(heartbeat.statusCode, heartbeat.body).toBe(403);
        const terminal = await api(
          helper,
          `/v1/memory/answer-tasks/${running.id}/complete`,
          completion(running)
        );
        expect(terminal.statusCode, terminal.body).toBe(403);
        const detail = await api(
          token,
          `/v1/memory/questions/${completed.questionId}`
        );
        expect(detail.statusCode, detail.body).toBe(403);
        const history = await api(token, "/v1/memory/questions");
        expect(history.statusCode, history.body).toBe(200);
        expect(history.body).not.toContain(completed.questionId);
        expect(history.body).not.toContain("Local helper fixture synthesis");
        expectNoDecrypt();
        const persisted = await pool.query(
          "select status from memory_answer_tasks where id=$1",
          [running.id]
        );
        expect(persisted.rows[0].status).toBe("running");
      } finally {
        await restore();
        await pool.query(
          "delete from memory_answer_tasks where id=any($1::uuid[])",
          [[completed.id, running.id, queued.id]]
        );
        await pool.query("delete from memory_questions where id=$1", [
          completed.questionId
        ]);
      }
    },
    180_000
  );
});
