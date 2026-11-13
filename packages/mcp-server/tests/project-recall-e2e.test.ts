import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  personalSourceContextStateSchema
} from "@koed-labs/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "@koed-labs/db";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle
} from "@modelcontextprotocol/server/stdio";
import {
  createAuthHelpers,
  createHashSecret
} from "../../../apps/api/src/auth/session.js";
import type { ApiRouteContext } from "../../../apps/api/src/server/context.js";
import { registerPersonalProjectRoutes } from "../../../apps/api/src/memory/personal-project-routes.js";
import { registerPersonalSourceContextRoutes } from "../../../apps/api/src/memory/personal-source-context-routes.js";
import { registerRecallRoutes } from "../../../apps/api/src/memory/recall-routes.js";
import { registerQuestionRoutes } from "../../../apps/api/src/memory/questions-routes.js";
import { registerCaptureRoutes } from "../../../apps/api/src/memory/capture-routes.js";
import { MemoryApiClient } from "../src/index.js";
import { createKoedMcpServer } from "../src/mcp-server-factory.js";
import {
  MemoryToolExecutor,
  type MemoryToolExecutorServices
} from "../src/memory-tool-executor.js";

vi.mock("node-pty", () => ({
  spawn: () => {
    throw new Error("Unexpected terminal launch in Project recall fixture");
  }
}));

// Opt in to an isolated database. This fixture never creates or drops databases.
const databaseUrl = process.env.KOED_PROJECT_RECALL_TEST_DATABASE_URL;
const pepper = "synthetic-project-recall-e2e-pepper";
type Hit = { sourceId: string; summaryText: string };
// The integration exercises API dependencies without adding them to MCP runtime dependencies.
const apiRequire = createRequire(
  new URL("../../../apps/api/package.json", import.meta.url)
);
const Fastify = apiRequire("fastify") as unknown as () => Parameters<
  typeof registerRecallRoutes
>[0];
const cookie = apiRequire("@fastify/cookie") as unknown as Parameters<
  ReturnType<typeof Fastify>["register"]
>[0];

describe.skipIf(!databaseUrl)(
  "authenticated current-Conversation Project recall",
  () => {
    const pool = createDbPool({ connectionString: databaseUrl });
    const repositoryOptions = {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 117).toString("base64")
      )
    };
    let home: string;
    let app: ReturnType<typeof Fastify>;
    let base: string;
    const finalResponses: Array<{ status: number; body: unknown }> = [];
    const connections: Array<{ client: Client; server: StdioServerHandle }> =
      [];
    const fetchHttp = globalThis.fetch;
    const vector = Array<number>(1024).fill(0);
    vector[0] = 1;

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), "koed-project-recall-e2e-"));
      vi.stubEnv("DATABASE_URL", databaseUrl!);
      vi.stubEnv("KOED_HOME", home);
      vi.stubEnv("KOED_DEPLOYMENT_PROFILE", "developer");
      vi.stubEnv("API_TOKEN_PEPPER", pepper);
      vi.stubEnv(
        "EMBEDDING_SERVICE_URL",
        "http://embedding.project-recall.fixture"
      );
      vi.stubEnv("EMBEDDING_MODEL", "qwen3-0.6b");
      vi.stubGlobal(
        "fetch",
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (
            String(input).startsWith("http://embedding.project-recall.fixture")
          )
            return Promise.resolve(
              Response.json({
                model: "qwen3-0.6b",
                dimensions: 1024,
                vectors: [vector],
                measuredTokens: 5
              })
            );
          return fetchHttp(input, init);
        }
      );
      await runDbMigrations(pool);
      const repo = createMemorySourceRepository(pool, repositoryOptions);
      app = Fastify();
      app.addHook("onSend", async (request, reply, payload) => {
        if (request.url === "/v1/memory/questions/final")
          finalResponses.push({
            status: reply.statusCode,
            body:
              typeof payload === "string"
                ? (JSON.parse(payload) as unknown)
                : payload
          });
        return payload;
      });
      app.setErrorHandler((error, _request, reply) => {
        const failure = error as Error & { statusCode?: number };
        return reply
          .status(failure.statusCode ?? 500)
          .send({ error: failure.message });
      });
      await app.register(cookie);
      const context = {
        requireRepository: () => repo,
        auth: createAuthHelpers(() => repo, {
          hashSecret: createHashSecret(pepper),
          cookieSecure: false
        }),
        config: {
          embeddingModel: "qwen3-0.6b",
          apiTokenPepper: pepper,
          teamCollaborationEnabled: false
        },
        capture: {},
        internalServices: { fetch: globalThis.fetch },
        rateLimit: {
          memoryRead: async () => {},
          memoryWrite: async () => {},
          memoryRecall: async () => {},
          aiClientControl: async () => {}
        }
      } as unknown as ApiRouteContext;
      registerPersonalProjectRoutes(app, context);
      registerPersonalSourceContextRoutes(app, context);
      registerRecallRoutes(app, context);
      registerQuestionRoutes(app, context);
      registerCaptureRoutes(app, context);
      app.get("/v1/memory/local-agent-settings", async (request) => {
        await context.auth.authenticateApiToken(request);
        return { settings: [] };
      });
      base = await app.listen({ host: "127.0.0.1", port: 0 });
    }, 120_000);

    afterAll(async () => {
      for (const pair of connections) {
        await pair.client.close();
        await pair.server.close();
      }
      await app?.close();
      await pool.end();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      if (home) rmSync(home, { recursive: true, force: true });
    });

    it.each(["missing", "reused"] as const)(
      "recovers %s-folder history through organization, recalls a nonrecursive union, and retains exclusions and original facts",
      async (folderLifetime) => {
        const repo = createMemorySourceRepository(pool, repositoryOptions);
        const capturedPath = join(home, randomUUID(), "original-checkout");
        const identity = async () => {
          const user = await repo.createUser({
            email: `project-e2e-${randomUUID()}@example.test`
          });
          const token = `synthetic-${randomUUID()}`;
          await repo.createApiToken({
            ownerUserId: user.id,
            name: "Synthetic Project recall",
            tokenHash: createHash("sha256")
              .update(`${pepper}${token}`)
              .digest("hex"),
            tokenPrefix: token.slice(0, 12)
          });
          return { actor: { userId: user.id }, token };
        };
        const owner = await identity(),
          foreign = await identity();
        const request = async (
          method: "GET" | "POST",
          path: string,
          body?: Record<string, unknown>,
          token = owner.token
        ) =>
          app.inject({
            method,
            url: path,
            headers: { authorization: `Bearer ${token}` },
            ...(body === undefined ? {} : { payload: body })
          });
        const json = async (
          method: "GET" | "POST",
          path: string,
          body?: Record<string, unknown>
        ) => {
          const response = await request(method, path, body);
          expect(response.statusCode, response.body).toBe(200);
          return response.json<unknown>();
        };
        const readContext = async (sessionId: string) =>
          z
            .object({ context: personalSourceContextStateSchema })
            .parse(
              await json(
                "GET",
                `/v1/personal/sessions/${sessionId}/source-context`
              )
            ).context;
        // Historical admission uses the production repository, not a synthetic SQL identity.
        const source = async (
          content: string,
          externalSessionId = randomUUID(),
          actor = owner.actor
        ) => {
          const session = await repo.createCapturedSession(actor, {
            externalSessionId,
            sourceRuntime: "codex-cli",
            importObservedAt: new Date().toISOString(),
            cwd: capturedPath
          });
          const event = await repo.createMemoryEvent(actor, {
            sessionId: session.id,
            projectId: "unassigned",
            actor: "user",
            visibility: "personal",
            eventType: "captured",
            rawEventType: "user_message",
            content,
            idempotencyKey: randomUUID()
          });
          const embeddable = await repo.getEmbeddableSource(
            "memory_event",
            event.id
          );
          expect(embeddable).not.toBeNull();
          await repo.replaceSourceEmbeddings({
            source: embeddable!,
            model: "qwen3-0.6b",
            dimensions: 1024,
            version: "qwen3-0.6b",
            modelArtifactHash: "a".repeat(64),
            tokenizer: "qwen3-embedding-0.6b-gguf",
            inputTransform: "qwen3-retrieval-document-v1",
            pooling: "last",
            normalization: "l2",
            chunks: [
              {
                vector,
                chunkIndex: 0,
                chunkCount: 1,
                inputTokenCount: 8,
                sourceText: content
              }
            ]
          });
          return { session, event };
        };
        const nativeId = randomUUID();
        const caller = await source("CALLER_ONLY", nativeId);
        const intended = await source("RECOVERED_DECISION_ORCHID_42");
        const bridge = await source("OVERLAPPING_DECISION_MAPLE_17");
        const unrelated = await source("UNRELATED_DECISION_CEDAR_99");
        const foreignSource = await source(
          "FOREIGN_DECISION",
          randomUUID(),
          foreign.actor
        );
        const empty = await source("UNASSIGNED_DECISION");
        const projects = await Promise.all(
          ["A", "B", "C"].map((name) =>
            repo.createNamedPersonalProject(owner.actor, { name })
          )
        );
        const [a, b, c] = projects;
        const organize = async (
          sessionId: string,
          edits: Array<{
            projectId: string;
            direct: boolean;
            excluded: boolean;
          }>
        ) => {
          const context = await readContext(sessionId);
          const current = await repo.listNamedPersonalProjects(owner.actor);
          return json(
            "POST",
            `/v1/personal/sessions/${sessionId}/organization`,
            {
              expectedContext: context,
              reviewedProjects: current
                .filter((p) => edits.some((e) => e.projectId === p.projectId))
                .map((p) => ({
                  projectId: p.projectId,
                  expectedVersion: p.version
                })),
              memberships: edits,
              corrections: []
            }
          );
        };
        const add = (projectId: string) => ({
          projectId,
          direct: true,
          excluded: false
        });
        const original = await readContext(intended.session.id);
        const originalEvent = await repo.getEmbeddableSource(
          "memory_event",
          intended.event.id
        );
        if (folderLifetime === "reused") {
          mkdirSync(capturedPath, { recursive: true });
          writeFileSync(
            join(capturedPath, "README.md"),
            "Unrelated replacement Folder.\n"
          );
        }
        await organize(caller.session.id, [
          add(a!.projectId),
          add(b!.projectId)
        ]);
        await organize(intended.session.id, [add(a!.projectId)]);
        await organize(bridge.session.id, [
          add(b!.projectId),
          add(c!.projectId)
        ]);
        await organize(unrelated.session.id, [add(c!.projectId)]);
        expect(await readContext(intended.session.id)).toEqual(original);
        expect(original.git.original).toMatchObject({
          state: "unresolved",
          reason: "historical_unresolved"
        });
        expect(original.folder.original).toMatchObject({
          state: "unresolved",
          reason: "historical_unresolved"
        });

        const client = new MemoryApiClient({
          apiUrl: base,
          apiToken: owner.token
        });
        const resolution = await client.resolvePersonalProjectRecall({
          externalSessionId: nativeId,
          sourceRuntime: "codex-cli"
        });
        expect(resolution.sessionId).toBe(caller.session.id);
        expect(
          resolution.target.projects.map((p) => p.projectId).sort()
        ).toEqual([a!.projectId, b!.projectId].sort());
        expect(
          await client.resolvePersonalProjectRecall({
            sessionId: caller.session.id
          })
        ).toEqual(resolution);
        await expect(
          client.resolvePersonalProjectRecall({ sessionId: empty.session.id })
        ).rejects.toThrow();
        await expect(
          client.resolvePersonalProjectRecall({
            sessionId: foreignSource.session.id
          })
        ).rejects.toThrow();
        const forged = await request(
          "POST",
          "/v1/personal/projects/resolve-recall",
          { sessionId: caller.session.id, ownerUserId: foreign.actor.userId }
        );
        expect(forged.statusCode).toBeGreaterThanOrEqual(400);
        expect(
          (
            await request(
              "POST",
              "/v1/personal/projects/resolve-recall",
              { externalSessionId: nativeId, sourceRuntime: "codex-cli" },
              foreign.token
            )
          ).statusCode
        ).toBeGreaterThanOrEqual(400);

        const observed: Hit[][] = [];
        // Replace only AI Client synthesis. Retrieval, selection and persistence use HTTP.
        const synthesize: NonNullable<
          MemoryToolExecutorServices["answerWithMemoryWorker"]
        > = async (payload, options) => {
          if (!options?.client)
            throw new Error("Expected production retrieval client");
          const result = await options.client.search({
            query: "decision",
            search_domain: "project",
            retrieval_stage: "raw_fallback_search",
            include_event_context: true,
            limit: 20
          });
          const hits = result.hits as Hit[];
          observed.push(hits);
          return {
            ...payload,
            markdown: hits.map((hit) => hit.summaryText).join("\n"),
            evidenceBundle: {
              ...payload.evidenceBundle,
              evidence: hits,
              retrieval: { evidenceCount: hits.length }
            },
            citations: [],
            retrieval: { evidenceCount: hits.length },
            localMemoryWorker: {
              jobId: randomUUID(),
              model: "deterministic-fixture",
              provider: "codex",
              promptVersion: "fixture",
              usedFallback: false
            }
          };
        };
        const executor = new MemoryToolExecutor(
          client,
          {},
          { answerWithMemoryWorker: synthesize }
        );
        let activeSessionId = caller.session.id;
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        const mcpServer = serveStdio(
          (context) =>
            createKoedMcpServer(context, {
              environment: {},
              callerContextResolver: () => ({
                cwd: home,
                conversation: { sessionId: activeSessionId }
              }),
              runtimeClient: {
                capabilities: async () => ({
                  protocolVersion: 1,
                  supportedTools: ["memory_answer"],
                  curatedMemoryIntakeAvailable: false
                }),
                callTool: (name, input, context, signal) =>
                  executor.execute(name, input, context, signal),
                startMemoryAnswerTask: async () => {
                  throw new Error("Unexpected asynchronous submission");
                },
                getMemoryAnswerTask: async () => {
                  throw new Error("Unexpected task polling");
                },
                cancelMemoryAnswerTask: async () => {
                  throw new Error("Unexpected task cancellation");
                }
              }
            }),
          { transport: serverTransport, legacy: "reject" }
        );
        const mcp = new Client(
          { name: "synthetic-project-recall-e2e", version: "1" },
          {
            capabilities: {},
            versionNegotiation: { mode: { pin: "2026-07-28" } }
          }
        );
        connections.push({ client: mcp, server: mcpServer });
        await mcp.connect(clientTransport);
        const ask = () =>
          mcp.callTool({
            name: "memory_answer",
            arguments: {
              query: "decision",
              search_domain: "project",
              response_detail: "with_evidence"
            }
          });
        const answer = await ask();
        expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
        expect(
          finalResponses.at(-1)?.status,
          JSON.stringify(finalResponses.at(-1))
        ).toBe(200);
        const ids = observed.at(-1)!.map((hit) => hit.sourceId);
        expect(ids).toContain(intended.event.id);
        expect(ids).toContain(bridge.event.id);
        expect(ids).not.toContain(unrelated.event.id);
        expect(ids).not.toContain(foreignSource.event.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(JSON.stringify(answer)).toContain(
          "RECOVERED_DECISION_ORCHID_42"
        );
        const history = z
          .object({
            questions: z.array(z.object({ id: z.uuid(), query: z.string() }))
          })
          .parse(await json("GET", "/v1/memory/questions"));
        const question = history.questions.find(
          (q: { query: string }) => q.query === "decision"
        );
        expect(question).toBeDefined();
        if (!question) throw new Error("Expected persisted Memory Answer");
        const persisted = await client.getQuestion(question.id);
        expect(JSON.stringify(persisted)).toContain(
          "RECOVERED_DECISION_ORCHID_42"
        );
        expect(JSON.stringify(persisted)).toContain(intended.event.id);
        expect(JSON.stringify(persisted)).toContain(bridge.event.id);
        expect(JSON.stringify(persisted)).not.toContain(
          "UNRELATED_DECISION_CEDAR_99"
        );
        expect(persisted).toMatchObject({
          question: {
            retrieval: {
              personal_selection: {
                version: 1,
                ownerUserId: owner.actor.userId,
                target: resolution.target
              }
            }
          }
        });
        for (const unavailable of [
          empty.session.id,
          foreignSource.session.id
        ]) {
          activeSessionId = unavailable;
          const searchesBefore = observed.length;
          expect((await ask()).isError).toBe(true);
          expect(observed).toHaveLength(searchesBefore);
        }
        activeSessionId = caller.session.id;

        await organize(intended.session.id, [
          { projectId: a!.projectId, direct: false, excluded: true },
          add(c!.projectId)
        ]);
        expect((await ask()).isError).not.toBe(true);
        expect(finalResponses.at(-1)?.status).toBe(200);
        expect(observed.at(-1)!.map((hit) => hit.sourceId)).not.toContain(
          intended.event.id
        );
        const currentA = (
          await repo.listNamedPersonalProjects(owner.actor)
        ).find((p) => p.projectId === a!.projectId)!;
        const blocked = await request(
          "POST",
          `/v1/personal/projects/${a!.projectId}/memberships`,
          { sessionId: intended.session.id, expectedVersion: currentA.version }
        );
        expect(blocked.statusCode).toBe(409);
        expect(await readContext(intended.session.id)).toEqual(original);
        expect(
          await repo.getEmbeddableSource("memory_event", intended.event.id)
        ).toEqual(originalEvent);
      },
      120_000
    );
  }
);
