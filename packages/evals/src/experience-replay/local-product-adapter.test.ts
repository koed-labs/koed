import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createLocalExperienceReplayProductAdapter } from "./local-product-adapter.js";

const base = {
  runId: "unit-test",
  postgres: {
    adminUrl: "postgresql://127.0.0.1:5432/postgres",
    user: "benchmark",
    password: "benchmark"
  }
} as const;

describe("local Experience Replay product adapter guards", () => {
  it("rejects remote or credential-bearing PostgreSQL targets", () => {
    expect(() =>
      createLocalExperienceReplayProductAdapter({
        ...base,
        mode: "smoke",
        postgres: {
          ...base.postgres,
          adminUrl: "postgresql://db.example/postgres"
        }
      })
    ).toThrow("exact loopback");
    expect(() =>
      createLocalExperienceReplayProductAdapter({
        ...base,
        mode: "smoke",
        postgres: {
          ...base.postgres,
          adminUrl: "postgresql://user:secret@127.0.0.1/postgres"
        }
      })
    ).toThrow("must not carry credentials");
  });

  it("fails closed on an unconfigured or wrongly configured embedding mode", () => {
    expect(() =>
      createLocalExperienceReplayProductAdapter({ ...base, mode: "recorded" })
    ).toThrow("require a configured Embedding Service");
    expect(() =>
      createLocalExperienceReplayProductAdapter({
        ...base,
        mode: "smoke",
        recordedEmbedding: {
          url: "http://127.0.0.1:8000",
          token: "token",
          model: "qwen3-0.6b",
          dimensions: 1024,
          modelArtifactHash: "sha256:test"
        }
      })
    ).toThrow("must use the deterministic HTTP Embedding Service");
  });

  it("rejects source/condition mismatches before provisioning PostgreSQL", async () => {
    const adapter = createLocalExperienceReplayProductAdapter({
      ...base,
      mode: "smoke"
    });
    try {
      await expect(
        adapter.prepareTemplate({
          condition: "relevant",
          taskDigest: `sha256:${"a".repeat(64)}`,
          sourceTaskDigest: null,
          sanitizedSource: null,
          recallQuery: "probe"
        })
      ).rejects.toThrow("condition and sanitized source do not agree");
    } finally {
      await adapter.close();
    }
  });

  it("rejects an internally inconsistent persisted handle before adoption", async () => {
    const adapter = createLocalExperienceReplayProductAdapter({
      ...base,
      mode: "smoke"
    });
    try {
      await expect(
        adapter.adoptTemplate({
          templateId: "koed_eval_persisted_template",
          sourceStateHash: `sha256:${"a".repeat(64)}`,
          attestation: {
            schema: "koed-experience-replay-local-product-template-v1",
            frozenDatabase: {
              name: "koed_eval_different_template",
              allowConnections: false,
              isTemplate: true
            }
          }
        } as never)
      ).rejects.toThrow("internally inconsistent");
    } finally {
      await adapter.close();
    }
  });
});

const integrationUrl = process.env.KOED_EXPERIENCE_REPLAY_DATABASE_URL;
(integrationUrl ? describe : describe.skip)(
  "local Experience Replay product adapter PostgreSQL integration",
  () => {
    it("migrates, authenticates, freezes empty state, and gives every replay a fresh clone", async () => {
      const parsed = new URL(integrationUrl!);
      expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
      const user = decodeURIComponent(parsed.username);
      const password = decodeURIComponent(parsed.password);
      parsed.username = "";
      parsed.password = "";
      const runId = `integration-${randomUUID()}`;
      const adapter = createLocalExperienceReplayProductAdapter({
        runId,
        mode: "smoke",
        postgres: { adminUrl: parsed.toString(), user, password },
        readinessTimeoutMs: 30_000,
        readinessIntervalMs: 50
      });
      let resumed:
        | ReturnType<typeof createLocalExperienceReplayProductAdapter>
        | undefined;
      try {
        const template = await adapter.prepareTemplate({
          condition: "empty",
          taskDigest: `sha256:${"a".repeat(64)}`,
          sourceTaskDigest: null,
          sanitizedSource: null,
          recallQuery: "experience replay sentinel"
        });
        expect(template.attestation).toMatchObject({
          database: {
            migrationsCurrent: true,
            rows: { users: 1, apiTokens: 1, capturedSessions: 1 }
          },
          project: {
            visibility: "personal"
          },
          readiness: { ready: true, condition: "empty" },
          frozenDatabase: { allowConnections: false, isTemplate: true },
          embedding: {
            transport: "loopback-http",
            provider: "deterministic-smoke",
            model: "qwen3-0.6b",
            dimensions: 1024
          }
        });
        expect(template.attestation.project.id).toMatch(
          /^eval:\/\/experience-replay\//
        );
        expect(template.attestation.project.ownerUserId).toBeTruthy();
        expect(JSON.stringify(template)).not.toContain("pepper");
        expect(JSON.stringify(template)).not.toContain("Bearer ");

        await adapter.close({ preserveTemplates: true });
        resumed = createLocalExperienceReplayProductAdapter({
          runId,
          mode: "smoke",
          postgres: { adminUrl: parsed.toString(), user, password },
          readinessTimeoutMs: 30_000,
          readinessIntervalMs: 50
        });
        await resumed.adoptTemplate(template);

        const first = await resumed.cloneForReplay(template);
        await expect(
          first.api.request({
            method: "POST",
            path: "/v1/memory/questions/final",
            headers: { authorization: first.authorization },
            body: {
              idempotency_key: "experience-replay-encrypted-question",
              query: "What was recalled?",
              origin: "mcp_memory_answer",
              retrieval_scope: "personal",
              search_domain: "project",
              project_id: template.attestation.project.id,
              status: "answered",
              answer_markdown: "A prior implementation was recalled."
            }
          })
        ).resolves.toMatchObject({
          question: {
            query: "What was recalled?",
            answerMarkdown: "A prior implementation was recalled."
          }
        });
        const firstPool = new pg.Pool({ connectionString: first.databaseUrl });
        await firstPool.query(
          "CREATE TABLE replay_clone_probe (value text NOT NULL)"
        );
        await firstPool.end();
        await first.close();

        const second = await resumed.cloneForReplay(template);
        expect(second.authorization).not.toBe(first.authorization);
        const secondPool = new pg.Pool({
          connectionString: second.databaseUrl
        });
        const absent = await secondPool.query<{ present: boolean }>(
          "SELECT to_regclass('public.replay_clone_probe') IS NOT NULL AS present"
        );
        expect(absent.rows[0]?.present).toBe(false);
        await secondPool.end();
        await second.close();
      } finally {
        if (resumed) await resumed.close();
        else await adapter.close();
      }
    }, 180_000);
  }
);
