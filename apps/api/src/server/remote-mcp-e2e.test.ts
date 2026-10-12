import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import {
  createDbPool,
  createMemoryAnswerTaskRepository,
  createRemoteMcpOAuthRepository,
  type MemorySourceRepository
} from "@koed/db";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthHelpers, createHashSecret } from "../auth/session.js";
import { createRemoteMcpOAuthProvider } from "../auth/remote-mcp-oauth.js";
import { registerRemoteMcpOAuthRoutes } from "../auth/remote-mcp-oauth-routes.js";
import { registerMemoryAnswerTaskRoutes } from "../memory/memory-answer-task-routes.js";
import type { ApiRouteContext } from "./context.js";
import { registerRemoteMcpRoutes } from "./remote-mcp.js";

const databaseUrl = process.env.KOED_OAUTH_TEST_DATABASE_URL;

// Only OAuth and task repositories are real here. User/session lookups use the
// isolated SQL tables below; no semantic recall or Team fixture is simulated.
describe.skipIf(!databaseUrl)(
  "remote MCP HTTP and durable local execution",
  () => {
    const schema = `mcp_e2e_${randomUUID().replaceAll("-", "")}`;
    const admin = createDbPool({
      connectionString: databaseUrl ?? "postgresql://localhost/postgres"
    });
    const scopedUrl = new URL(databaseUrl ?? "postgresql://localhost/postgres");
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const pool = createDbPool({ connectionString: scopedUrl.toString() });
    const ownerId = randomUUID();
    const otherId = randomUUID();
    const origin = "https://koed.example";
    const resource = new URL(`${origin}/mcp`);
    const oauth = createRemoteMcpOAuthProvider({
      store: createRemoteMcpOAuthRepository(pool),
      resourceUrl: resource
    });
    const encryptionProvider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64url")
    );
    const tasks = createMemoryAnswerTaskRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const hashSecret = createHashSecret("remote-mcp-e2e-only-pepper");
    const repository = {
      ...tasks,
      async getUser(id: string) {
        const { rows } = await pool.query(
          "select id,email from users where id=$1 and disabled_at is null and deleted_at is null",
          [id]
        );
        return rows[0] ? { ...rows[0], displayName: null } : null;
      },
      async getSessionUser(hash: string) {
        return hash === hashSecret("owner-session")
          ? repository.getUser(ownerId)
          : hash === hashSecret("other-session")
            ? repository.getUser(otherId)
            : null;
      },
      async getApiTokenUser() {
        return null;
      }
    } as unknown as MemorySourceRepository;
    const auth = createAuthHelpers(() => repository, {
      hashSecret,
      cookieSecure: true,
      resolveDelegatedPrincipal: oauth.resolvePrincipal
    });
    const app = Fastify();
    const clients: Client[] = [];
    let base: string;
    let clientId: string;

    const migration = async (name: string) =>
      readFile(
        new URL(`../../../../packages/db/drizzle/${name}`, import.meta.url),
        "utf8"
      );
    beforeAll(async () => {
      await admin.query(`create schema ${schema}`);
      await pool.query(
        "create type visibility_scope as enum ('personal','shared'); create table users(id uuid primary key,email text,disabled_at timestamptz,deleted_at timestamptz); create table audit_events(actor_user_id uuid,owner_user_id uuid,visibility text,action text,target_table text,target_id uuid,metadata jsonb)"
      );
      await pool.query(
        "insert into users(id,email) values($1,'owner@koed.example'),($2,'other@koed.example')",
        [ownerId, otherId]
      );
      const encryptionMigration = await migration("0008_mean_gressill.sql");
      const encryptedTable = encryptionMigration
        .split("--> statement-breakpoint")
        .find((statement) =>
          statement.includes('CREATE TABLE "encrypted_field_payloads"')
        )!;
      await pool.query(encryptedTable);
      await pool.query(
        "alter table encrypted_field_payloads add column owner_principal_id text; alter table encrypted_field_payloads drop constraint encrypted_field_payloads_source_table_check; create unique index on encrypted_field_payloads(source_table,source_id,source_column)"
      );
      const taskMigration = await migration("0038_tough_harpoon.sql");
      await pool.query(taskMigration.split("--> statement-breakpoint")[0]!);
      await pool.query(
        "create unique index on memory_answer_tasks(owner_user_id,origin,invocation_key) where invocation_key is not null"
      );
      await pool.query(
        (await migration("0043_remote_mcp_oauth.sql")).replaceAll(
          '"public".',
          `"${schema}".`
        )
      );
      await app.register(cookie);
      registerRemoteMcpOAuthRoutes(app, {
        oauth,
        issuerUrl: new URL(origin),
        auth,
        workosAvailable: false,
        publicOrigin: origin
      });
      registerMemoryAnswerTaskRoutes(app, {
        requireRepository: () => repository,
        auth,
        rateLimit: {
          memoryRead: async () => {},
          memoryWrite: async () => {},
          aiClientControl: async () => {}
        }
      } as unknown as ApiRouteContext);
      app.get("/v1/capabilities", async () => ({
        capabilitySchemaVersion: 4,
        capabilities: {}
      }));
      app.get("/v1/access/check", async (request) => ({
        userId: (await auth.authenticateApiToken(request)).id
      }));
      app.post("/v1/sessions", async (request) => {
        await auth.authenticateApiToken(request);
        return { accepted: true };
      });
      registerRemoteMcpRoutes(app, {
        resourceUrl: resource,
        auth,
        allowedOrigins: [origin],
        environment: {
          NODE_ENV: "test",
          MEMORY_EXPOSE_DIAGNOSTIC_MEMORY_TOOLS: "true"
        },
        teamCollaborationEnabled: false
      });
      base = await app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token_endpoint_auth_method: "none",
          redirect_uris: ["http://127.0.0.1:5555/callback"]
        })
      });
      expect(response.status).toBe(201);
      clientId = ((await response.json()) as { client_id: string }).client_id;
    });
    afterAll(async () => {
      await Promise.all(clients.map((client) => client.close()));
      await app.close();
      await pool.end();
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    });

    const authorize = async (scopes: string, session = "owner-session") => {
      const verifier = randomBytes(32).toString("base64url");
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:5555/callback",
        response_type: "code",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        resource: resource.toString(),
        scope: scopes
      });
      const pending = await fetch(`${base}/authorize?${query}`, {
        redirect: "manual"
      });
      expect(pending.status).toBe(302);
      const request = new URL(
        pending.headers.get("location")!
      ).searchParams.get("request")!;
      const view = await fetch(
        `${base}/auth/mcp/authorize?request=${request}`,
        { headers: { cookie: `cm_session=${session}` } }
      );
      const html = await view.text();
      const csrfToken = html.match(
        /name="csrfToken" value="([A-Za-z0-9_-]+)"/
      )?.[1];
      expect(csrfToken).toBeTruthy();
      const approved = await fetch(
        `${base}/auth/mcp/authorize?request=${request}`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin,
            cookie: `cm_session=${session}; ${view.headers.get("set-cookie")!.split(";")[0]}`
          },
          body: new URLSearchParams({
            csrfToken: csrfToken!,
            decision: "allow"
          })
        }
      );
      expect(approved.status).toBe(302);
      const code = new URL(approved.headers.get("location")!).searchParams.get(
        "code"
      )!;
      const token = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: "http://127.0.0.1:5555/callback",
          resource: resource.toString()
        })
      });
      expect(token.status).toBe(200);
      return ((await token.json()) as { access_token: string }).access_token;
    };
    const connect = async (token: string) => {
      const client = new Client({ name: "remote-mcp-e2e", version: "1.0.0" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          fetch: async (url, init) =>
            new Promise<Response>((resolve, reject) => {
              const headers = Object.fromEntries(new Headers(init?.headers));
              const request = httpRequest(
                String(url),
                {
                  method: init?.method,
                  headers: { ...headers, host: resource.host },
                  signal: init?.signal ?? undefined
                },
                (response) => {
                  const responseHeaders = new Headers();
                  for (const [name, value] of Object.entries(
                    response.headers
                  )) {
                    if (value !== undefined)
                      responseHeaders.set(
                        name,
                        Array.isArray(value) ? value.join(", ") : value
                      );
                  }
                  const status = response.statusCode!;
                  resolve(
                    new Response(
                      [204, 304].includes(status)
                        ? null
                        : (Readable.toWeb(
                            response
                          ) as ReadableStream<Uint8Array>),
                      { status, headers: responseHeaders }
                    )
                  );
                }
              );
              request.on("error", reject);
              request.end(init?.body);
            }),
          requestInit: {
            headers: { authorization: `Bearer ${token}`, host: resource.host }
          }
        })
      );
      return client;
    };
    const api = (token: string, path: string, body?: Record<string, unknown>) =>
      fetch(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });

    it("uses browser PKCE consent and SDK transport, enforcing scopes and revocation on each request", async () => {
      const token = await authorize("koed:memory:read");
      const client = await connect(token);
      expect(
        (await client.listTools()).tools.map((tool) => tool.name)
      ).toContain("memory_answer");
      const access = await client.callTool({
        name: "memory_access_check",
        arguments: {}
      });
      expect(JSON.stringify(access)).toContain(ownerId);
      expect((await api(token, "/v1/sessions", {})).status).toBe(403);
      expect(
        (
          await api(token, "/v1/memory/answer-tasks/claim", {
            lease_owner: "local-worker"
          })
        ).status
      ).toBe(403);
      const revoked = await fetch(`${base}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, token })
      });
      expect(revoked.status).toBe(200);
      await expect(client.listTools()).rejects.toThrow();
    });

    it("accepts an encrypted task over MCP and completes it through a separate local execution credential", async () => {
      const readerToken = await authorize("koed:memory:read");
      const workerToken = await authorize(
        "koed:memory:read koed:local-execution"
      );
      const otherToken = await authorize(
        "koed:memory:read koed:local-execution",
        "other-session"
      );
      const client = await connect(readerToken);
      const answer = client.callTool({
        name: "memory_answer",
        arguments: {
          query: "Recall the synthetic decision",
          search_domain: "global"
        }
      });
      void answer.catch(() => {});
      // Await the accept notification from PostgreSQL, not a recurring polling loop.
      const accepted = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("MCP task was not accepted")),
          5000
        );
        const original = repository.acceptMemoryAnswerTask.bind(repository);
        repository.acceptMemoryAnswerTask = async (...args) => {
          const task = await original(...args);
          clearTimeout(timeout);
          repository.acceptMemoryAnswerTask = original;
          resolve(task.id);
          return task;
        };
      });
      expect(
        (await api(otherToken, `/v1/memory/answer-tasks/${accepted}`)).status
      ).toBe(404);
      const otherClaim = await api(
        otherToken,
        "/v1/memory/answer-tasks/claim",
        { lease_owner: "other-local-worker", lease_ms: 30000 }
      );
      expect(await otherClaim.json()).toMatchObject({ task: null });
      const claim = await api(workerToken, "/v1/memory/answer-tasks/claim", {
        lease_owner: "owner-local-worker",
        lease_ms: 30000
      });
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as {
        task: { id: string; fenceGeneration: number };
        request: Record<string, unknown>;
      };
      expect(claimed.task.id).toBe(accepted);
      const result = {
        markdown: "Synthetic local AI Client result",
        citations: []
      };
      const completed = await api(
        workerToken,
        `/v1/memory/answer-tasks/${accepted}/complete`,
        {
          lease_owner: "owner-local-worker",
          fence_generation: claimed.task.fenceGeneration,
          question_id: randomUUID(),
          result
        }
      );
      expect(completed.status).toBe(200);
      expect(JSON.stringify(await answer)).toContain(result.markdown);
      const rows = await pool.query(
        "select request_snapshot,result_snapshot from memory_answer_tasks where id=$1",
        [accepted]
      );
      expect(JSON.stringify(rows.rows)).not.toContain(
        "Recall the synthetic decision"
      );
      expect(JSON.stringify(rows.rows)).not.toContain(result.markdown);
      const restartedTasks = createMemoryAnswerTaskRepository(pool, {
        envelopeEncryptionProvider: encryptionProvider
      });
      expect(
        await restartedTasks.getMemoryAnswerTask({ userId: otherId }, accepted)
      ).toBeNull();
      expect(
        await restartedTasks.getMemoryAnswerTask({ userId: ownerId }, accepted)
      ).toMatchObject({ status: "completed", result });
    }, 15000);
  }
);
