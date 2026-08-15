import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { immutableHash } from "./core/hash.js";
import { normalizedImportSourceIdentity } from "./ingestion.js";
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

  it("requires a positive preparation API request timeout", () => {
    expect(() =>
      createLocalExperienceReplayProductAdapter({
        ...base,
        mode: "smoke",
        preparationRequestTimeoutMs: 0
      })
    ).toThrow("Preparation API request timeout must be positive");
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

  it("requires a complete, uniquely keyed campaign", async () => {
    const adapter = createLocalExperienceReplayProductAdapter({
      ...base,
      mode: "smoke"
    });
    const source = {
      taskDigest: `sha256:${"a".repeat(64)}`,
      corpusAttestationSha256: `sha256:${"c".repeat(64)}`,
      sourceAttemptId: "attempt-a",
      sanitizedSource: {} as never,
      recallQuery: "deployment decision"
    };
    try {
      const campaign = (sources: readonly (typeof source)[]) => ({
        corpusCollectionManifestSha256: `sha256:${"d".repeat(64)}`,
        sources
      });
      await expect(
        adapter.prepareCampaignTemplate(campaign([]))
      ).rejects.toThrow("at least one");
      await expect(
        adapter.prepareCampaignTemplate(
          campaign([source, { ...source, sourceAttemptId: "attempt-b" }])
        )
      ).rejects.toThrow("must be unique");
      await expect(
        adapter.prepareCampaignTemplate(
          campaign([
            source,
            {
              ...source,
              taskDigest: `sha256:${"b".repeat(64)}`,
              recallQuery: " "
            }
          ])
        )
      ).rejects.toThrow("incomplete");
    } finally {
      await adapter.close();
    }
  });

  it("requires clone selection by a campaign task digest before provisioning", async () => {
    const adapter = createLocalExperienceReplayProductAdapter({
      ...base,
      mode: "smoke"
    });
    const taskA = `sha256:${"a".repeat(64)}`;
    const taskB = `sha256:${"b".repeat(64)}`;
    const project = (taskDigest: string, suffix: string) => ({
      taskDigest,
      sourceAttemptId: `attempt-${suffix}`,
      projectId: `eval://experience-replay/project-${suffix}`,
      project: {
        id: `eval://experience-replay/project-${suffix}`,
        cwd: `/tmp/project-${suffix}`,
        anchorSessionId: `session-${suffix}`,
        ownerUserId: "user-1",
        visibility: "personal" as const
      },
      normalizedImport: {},
      readiness: {},
      scheduledLcmJobs: null
    });
    const attestation = {
      campaignProjects: [project(taskA, "a"), project(taskB, "b")]
    } as never;
    const template = {
      templateId: "koed_eval_campaign_template",
      sourceStateHash: `sha256:${"c".repeat(64)}`,
      attestation
    };
    (
      adapter as unknown as {
        registeredTemplates: Map<string, { attestationHash: string }>;
      }
    ).registeredTemplates.set(template.templateId, {
      attestationHash: immutableHash(attestation)
    });
    try {
      await expect(adapter.cloneForReplay(template as never)).rejects.toThrow(
        "requires a target task digest"
      );
      await expect(
        adapter.cloneForReplay(template as never, `sha256:${"d".repeat(64)}`)
      ).rejects.toThrow("not present in campaign template");
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
        lcmSummaryConfig: {
          model: "deterministic-smoke",
          promptVersion: "smoke-v1"
        },
        runScheduledLcmJobs: async ({ repository, actor }) => {
          const scopes = await repository.listPendingLcmDispatchScopes({
            ownerUserId: actor.userId
          });
          const nodeIds: string[] = [];
          for (const scope of scopes) {
            const created = await repository.createLcmNodes(actor, {
              visibility: scope.visibility,
              workClass: scope.workClass,
              force: true
            });
            nodeIds.push(
              ...created.leafNodeIds,
              ...(created.rollupNodeId ? [created.rollupNodeId] : [])
            );
          }
          for (const nodeId of nodeIds) {
            const node = await repository.getLcmNodeForSummarization(nodeId);
            if (!node) throw new Error("LCM node disappeared during test");
            const summaryText = node.sourceItems
              .map((item) => item.text ?? "")
              .filter(Boolean)
              .join(" ");
            await repository.updateLcmNodeSummary({
              nodeId,
              summaryText,
              summaryModel: "deterministic-smoke",
              summaryPromptVersion: "smoke-v1",
              summaryTokenEstimate: summaryText.split(/\s+/u).length,
              summaryStructuredJson: {
                schema_version: "lcm-semantic-summary-v1",
                title: "Deterministic campaign summary",
                summary_text: summaryText,
                lexical_anchors: []
              },
              summaryStructuredSchemaVersion: "lcm-semantic-summary-v1"
            });
          }
          return {
            nodeIds,
            model: "deterministic-smoke",
            promptVersion: "smoke-v1",
            inputTokens: 0,
            outputTokens: 0
          };
        },
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

    it("freezes multiple campaign Projects and scopes each clone to its target", async () => {
      const parsed = new URL(integrationUrl!);
      const user = decodeURIComponent(parsed.username);
      const password = decodeURIComponent(parsed.password);
      parsed.username = "";
      parsed.password = "";
      const adapter = createLocalExperienceReplayProductAdapter({
        runId: `campaign-${randomUUID()}`,
        mode: "smoke",
        postgres: { adminUrl: parsed.toString(), user, password },
        lcmSummaryConfig: {
          model: "deterministic-smoke",
          promptVersion: "smoke-v1"
        },
        runScheduledLcmJobs: async ({ repository, actor }) => {
          const scopes = await repository.listPendingLcmDispatchScopes({
            ownerUserId: actor.userId
          });
          const nodeIds: string[] = [];
          for (const scope of scopes) {
            const created = await repository.createLcmNodes(actor, {
              visibility: scope.visibility,
              workClass: scope.workClass,
              force: true
            });
            nodeIds.push(
              ...created.leafNodeIds,
              ...(created.rollupNodeId ? [created.rollupNodeId] : [])
            );
          }
          for (const nodeId of nodeIds) {
            const node = await repository.getLcmNodeForSummarization(nodeId);
            if (!node) throw new Error("LCM node disappeared during test");
            const summaryText = node.sourceItems
              .map((item) => item.text ?? "")
              .filter(Boolean)
              .join(" ");
            await repository.updateLcmNodeSummary({
              nodeId,
              summaryText,
              summaryModel: "deterministic-smoke",
              summaryPromptVersion: "smoke-v1",
              summaryTokenEstimate: summaryText.split(/\s+/u).length,
              summaryStructuredJson: {
                schema_version: "lcm-semantic-summary-v1",
                title: "Deterministic campaign summary",
                summary_text: summaryText,
                lexical_anchors: []
              },
              summaryStructuredSchemaVersion: "lcm-semantic-summary-v1"
            });
          }
          return {
            nodeIds,
            model: "deterministic-smoke",
            promptVersion: "smoke-v1",
            inputTokens: 0,
            outputTokens: 0
          };
        },
        readinessTimeoutMs: 30_000,
        readinessIntervalMs: 50
      });
      const taskA = `sha256:${"a".repeat(64)}`;
      const taskB = `sha256:${"b".repeat(64)}`;
      const cachedContentIdentity = `sha256:${"f".repeat(64)}`;
      const source = (taskDigest: string, marker: string) => ({
        taskDigest,
        corpusAttestationSha256: `sha256:${(marker === "cobalt"
          ? "c"
          : "d"
        ).repeat(64)}`,
        sourceAttemptId: `oracle:relevant_full:${taskDigest}`,
        recallQuery: `${marker} deployment checkpoint`,
        sanitizedSource: {
          normalizedItems: [
            {
              adapterName: "harbor-atif",
              adapterVersion: "1.0.0",
              sourceIdentity: normalizedImportSourceIdentity({
                taskDigest,
                sourceAttemptId: `oracle:relevant_full:${taskDigest}`,
                atifIdentity: `step:${marker}:0`,
                sequence: 0
              }),
              atifIdentity: `step:${marker}:0`,
              sequence: 0,
              stepId: 1,
              timestamp: null,
              type: "user_message",
              content: `${marker} deployment checkpoint is the accepted approach`
            },
            {
              adapterName: "harbor-atif",
              adapterVersion: "1.0.0",
              sourceIdentity: normalizedImportSourceIdentity({
                taskDigest,
                sourceAttemptId: `oracle:relevant_full:${taskDigest}`,
                atifIdentity: `step:${marker}:1`,
                sequence: 1
              }),
              atifIdentity: `step:${marker}:1`,
              sequence: 1,
              stepId: 2,
              timestamp: null,
              type: "user_message",
              content: "The shared verification message is complete."
            }
          ],
          manifest: {
            inputSha256: (marker === "cobalt" ? "1" : "2").repeat(64),
            outputSha256: (marker === "cobalt" ? "3" : "4").repeat(64),
            schemaVersion: "ATIF-v1.7",
            allowedFieldCounts: {},
            removedFieldCounts: {},
            redactionCounts: {},
            limitUsage: {},
            cutoffAttested: true,
            rejectionReason: null
          },
          trajectory: {},
          canonicalJson: "{}"
        } as never
      });
      let template:
        | Awaited<ReturnType<typeof adapter.prepareCampaignTemplate>>
        | undefined;
      try {
        template = await adapter.prepareCampaignTemplate({
          corpusCollectionManifestSha256: `sha256:${"e".repeat(64)}`,
          cachedContentIdentity,
          replaceOrphanedCachedTemplate: true,
          sources: [source(taskA, "cobalt"), source(taskB, "saffron")]
        });
        expect(template.attestation.campaignProjects).toHaveLength(2);
        expect(template.attestation.database.rows.users).toBe(1);

        for (const targetTaskDigest of [taskA, taskB]) {
          const selected = template.attestation.campaignProjects!.find(
            (project) => project.taskDigest === targetTaskDigest
          )!;
          const other = template.attestation.campaignProjects!.find(
            (project) => project.taskDigest !== targetTaskDigest
          )!;
          const replay = await adapter.cloneForReplay(
            template,
            targetTaskDigest
          );
          try {
            expect(replay.projectId).toBe(selected.projectId);
            const response = (await replay.api.request({
              method: "POST",
              path: "/v1/memory/search",
              headers: { authorization: replay.authorization },
              body: {
                query: selected.taskDigest === taskA ? "cobalt" : "saffron",
                retrieval_scope: "personal",
                search_domain: "project",
                project_id: selected.projectId,
                limit: 20,
                strict_limit: true
              }
            })) as { hits: Array<{ nodeId: string; sourceId: string }> };
            const selectedIds = new Set([
              ...selected.normalizedImport.projection.dispositions.map(
                (item) => item.eventId
              ),
              ...selected.readiness.summarizedLcmNodeIds
            ]);
            const otherIds = new Set([
              ...other.normalizedImport.projection.dispositions.map(
                (item) => item.eventId
              ),
              ...other.readiness.summarizedLcmNodeIds
            ]);
            expect(
              response.hits.some(
                (hit) =>
                  selectedIds.has(hit.sourceId) || selectedIds.has(hit.nodeId)
              )
            ).toBe(true);
            expect(
              response.hits.some(
                (hit) => otherIds.has(hit.sourceId) || otherIds.has(hit.nodeId)
              )
            ).toBe(false);
          } finally {
            await replay.close();
          }
        }
      } finally {
        if (template) {
          await adapter.evictCachedCampaignTemplate(
            template,
            cachedContentIdentity
          );
        }
        await adapter.close();
      }
    }, 180_000);
  }
);
