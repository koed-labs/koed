import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "@koed-labs/db";
import {
  personalFolderHintEvidenceSchema,
  personalFolderHintSchema
} from "@koed-labs/shared";
import {
  personalSourceContextCommandResultSchema,
  type PersonalDesktopApi
} from "@koed-labs/shared/personal-desktop";
import { preparePersonalSourceContextSnapshot } from "../../../../packages/db/src/personal-source-context-export.js";
import type { DesktopProject } from "../../../desktop/src/project-memory-ui.js";
import { recordInferredGitAnchors } from "../../../desktop/src/renderer/v1/project-management/infer-git-anchor.js";
import type { ApiRouteContext } from "../server/context.js";
import { registerPersonalSourceContextRoutes } from "./personal-source-context-routes.js";

const databaseUrl = process.env.DATABASE_URL;
const marker = {
  kind: "unresolved",
  key: null,
  root: null,
  branch: null,
  reason: "probe_ambiguous",
  originatingDeviceId: "historical_unknown_device",
  checkoutId: null,
  selectedRemote: null,
  anchorDisplay: null
} as const;
const repository = {
  ...marker,
  kind: "portable_repository",
  key: "gr_inferred_import",
  reason: "origin",
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/repo"
} as const;
const startedAt = "2024-07-01T00:00:00.000Z";

async function addCodexArtifact(
  pool: ReturnType<typeof createDbPool>,
  userId: string,
  sessionId: string,
  externalSessionId: string
) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into conversation_source_artifacts
    (owner_user_id,session_id,logical_source_id,source_generation_id,replica_role,source_kind,
     source_runtime,external_session_id,source_fingerprint,artifact_format,artifact_format_version,
     source_adapter_version,live_start_offset,live_start_line,current_source_length,source_created_at,
     storage_provider,storage_prefix,origin_deployment_id,origin_device_id,origin_key_id,origin_public_key,redacted_source_label)
    values($1,$2,$3,$4,'origin_local','codex','codex-cli',$5,repeat('a',64),'codex_rollout_jsonl',1,
      'codex-transcript-v1',100,2,100,$6,'test',$4::uuid::text,'deployment','device','test-key',repeat('a',43),'rollout') returning id`,
    [
      userId,
      sessionId,
      randomUUID(),
      randomUUID(),
      externalSessionId,
      startedAt
    ]
  );
  return rows[0]!.id;
}

async function recordImport(
  pool: ReturnType<typeof createDbPool>,
  userId: string,
  runId: string,
  artifactId: string
) {
  await pool.query(
    `insert into historical_import_sources(run_id,owner_user_id,artifact_id,ai_client,raw_ingested_record_count)
     values($1,$2,$3,'codex',1)`,
    [runId, userId, artifactId]
  );
}

describe.skipIf(!databaseUrl)(
  "Codex import Git inference through source context",
  () => {
    const pool = createDbPool({ connectionString: databaseUrl });
    beforeAll(() => runDbMigrations(pool), 120_000);
    afterAll(() => pool.end());

    it.each(["unbound", "published"] as const)(
      "records an eligible %s import without changing its original",
      async (binding) => {
        const repo = createMemorySourceRepository(pool);
        const user = await repo.createUser({
          email: `${randomUUID()}@example.test`
        });
        const actor = { userId: user.id };
        const externalSessionId = randomUUID();
        const source = await repo.createCapturedSession(actor, {
          externalSessionId,
          importObservedAt: "2025-03-01T00:00:00.000Z",
          repositoryIdentity: marker
        });
        const artifactId = await addCodexArtifact(
          pool,
          user.id,
          source.id,
          externalSessionId
        );
        const app = Fastify();
        registerPersonalSourceContextRoutes(app, {
          requireRepository: () => repo,
          auth: { authenticate: async () => user },
          rateLimit: { memoryRead: async () => {}, memoryWrite: async () => {} }
        } as ApiRouteContext);
        const base = `/v1/personal/sessions/${source.id}/source-context`;
        const readGit = async () => {
          const response = await app.inject({ method: "GET", url: base });
          expect(response.statusCode, response.body).toBe(200);
          return personalSourceContextCommandResultSchema.parse(response.json())
            .context.git;
        };
        try {
          // The watcher can emit the same sentinel for delayed live capture.
          expect((await readGit()).original).toEqual({
            state: "unresolved",
            reason: "unreliable"
          });
          const run = await repo.createHistoricalImportRun(actor);
          if (binding === "unbound")
            await recordImport(pool, user.id, run.id, artifactId);
          const setAutomatic = (identity: object) =>
            pool.query(
              "update sessions set repository_automatic_identity=$2 where id=$1",
              [source.id, identity]
            );
          await setAutomatic({
            ...marker,
            kind: "non_git_project",
            reason: "non_git"
          });
          expect((await readGit()).original).toEqual({
            state: "unresolved",
            reason: "unreliable"
          });
          await setAutomatic({ ...marker, originatingDeviceId: "device" });
          expect((await readGit()).original).toEqual({
            state: "unresolved",
            reason: "unreliable"
          });
          await setAutomatic(marker);
          const snapshot = async () => {
            const client = await pool.connect();
            try {
              await client.query("begin");
              const result = await preparePersonalSourceContextSnapshot(
                client,
                {
                  ownerUserId: user.id,
                  localSessionId: source.id,
                  originatingDeploymentId: "deployment",
                  originatingDeviceId: "device"
                }
              );
              await client.query("commit");
              return result;
            } catch (error) {
              await client.query("rollback");
              throw error;
            } finally {
              client.release();
            }
          };
          // Publication before proof produces the same original as pre-fix publication of the import.
          const published = binding === "published" ? await snapshot() : null;
          if (published) {
            expect(published.context.git.original).toEqual({
              state: "unresolved",
              reason: "unreliable"
            });
            await recordImport(pool, user.id, run.id, artifactId);
          }

          await repo.createCapturedSession(actor, {
            externalSessionId: randomUUID(),
            repositoryIdentity: repository
          });
          const project = await repo.createNamedPersonalProject(actor, {
            name: "Inference target"
          });
          await repo.addPersonalProjectRepositoryRule(
            actor,
            project.projectId,
            {
              expectedVersion: project.version,
              repository
            }
          );
          const response = await app.inject({
            method: "POST",
            url: "/v1/personal/sessions/folder-hint-evidence",
            payload: { sessionIds: [source.id] }
          });
          expect(response.statusCode, response.body).toBe(200);
          const [evidence] = personalFolderHintEvidenceSchema.parse(
            response.json()
          ).evidence;
          expect(evidence).toMatchObject({
            recordingDeviceProvenance: "assumed-local-import",
            gitInferenceEligibility: true,
            gitRevision: 1
          });
          const scope = "inference-test-scope";
          const manageSourceContext: NonNullable<
            PersonalDesktopApi["manageSourceContext"]
          > = async (input) => {
            if (input.action === "organize")
              throw new Error("Unexpected organization");
            expect(input.expectedScopeKey).toBe(scope);
            // Bridge IPC to the real routes; local scoring is supplied as a qualifying hint.
            const result = await app.inject(
              input.action === "get"
                ? { method: "GET", url: base }
                : input.action === "preview"
                  ? {
                      method: "POST",
                      url: `${base}/reviews`,
                      payload: {
                        ...input.correction,
                        localImportBasis: evidence!.importAuthority
                      }
                    }
                  : {
                      method: "POST",
                      url: `${base}/reviews/${input.reviewId}/apply`,
                      payload: { expectedVersion: input.expectedVersion }
                    }
            );
            expect(result.statusCode, result.body).toBe(200);
            return personalSourceContextCommandResultSchema.parse(
              result.json()
            );
          };
          const api = { manageSourceContext } as PersonalDesktopApi;
          const projects: DesktopProject[] = [
            {
              id: project.projectId,
              name: "Inference target",
              repository,
              path: null,
              threads: [],
              eventCount: 0,
              catalogued: false,
              discoveredAt: null,
              lastSeenAt: null,
              localProjectId: null,
              branch: null,
              remoteDisplay: null,
              isWorktree: false
            }
          ];
          const hint = personalFolderHintSchema.parse({
            sessionId: source.id,
            kind: "repository",
            tier: "medium",
            score: 4,
            repositoryKey: repository.key,
            recordingDeviceProvenance: evidence!.recordingDeviceProvenance,
            gitInferenceEligibility: evidence!.gitInferenceEligibility,
            gitRevision: evidence!.gitRevision,
            reasons: [
              { code: "recorded-cwd", outcome: "agrees" },
              { code: "local-directory", outcome: "agrees" },
              { code: "origin-device", outcome: "unavailable" },
              { code: "directory-birthtime", outcome: "agrees" },
              { code: "directory-remote", outcome: "agrees" }
            ]
          });
          if (published) {
            expect((await readGit()).original).toEqual(
              published.context.git.original
            );
            const setArtifactDevice = (deviceId: string) =>
              pool.query(
                "update conversation_source_artifacts set origin_device_id=$2 where id=$1",
                [artifactId, deviceId]
              );
            await setArtifactDevice("wrong-device");
            expect(
              (
                await repo.getPersonalFolderHintEvidence(actor, {
                  sessionIds: [source.id]
                })
              ).evidence[0]?.gitInferenceEligibility
            ).toBe(false);
            await setArtifactDevice("device");
            for (const proof of [
              { inferenceIntent: "user-confirmed-unknown" },
              {
                inferenceIntent: "assumed-local-import",
                localImportBasis: {
                  ...evidence!.importAuthority,
                  deviceId: "wrong-device"
                }
              }
            ]) {
              const denied = await app.inject({
                method: "POST",
                url: `${base}/reviews`,
                payload: {
                  axis: "git",
                  action: "set",
                  repository,
                  expectedVersion: 1,
                  ...proof
                }
              });
              expect(denied.statusCode, denied.body).toBe(409);
            }
          }
          expect(
            await recordInferredGitAnchors(
              api,
              projects,
              new Map([[source.id, [hint]]]),
              scope
            )
          ).toEqual({ recorded: [source.id], failed: 0 });
          if (published) {
            const after = await snapshot();
            expect(after.git.revisions).toContainEqual(
              published.git.revisions[0]
            );
            expect(
              after.git.revisions.find(
                (revision) => revision.revisionId === after.git.head
              )?.replaces
            ).toEqual([published.git.head]);
          }
          const git = await readGit();
          expect(git).toMatchObject({
            revision: 2,
            original: {
              state: "unresolved",
              reason: published ? "unreliable" : "historical_unresolved"
            },
            correction: {
              state: "corrected",
              value: { state: "known", value: { key: repository.key } }
            }
          });
        } finally {
          await app.close();
        }
      }
    );

    it("preserves a prior explicit Git correction and its recorded original", async () => {
      const repo = createMemorySourceRepository(pool);
      const user = await repo.createUser({
        email: `${randomUUID()}@example.test`
      });
      const actor = { userId: user.id };
      const externalSessionId = randomUUID();
      const source = await repo.createCapturedSession(actor, {
        externalSessionId,
        importObservedAt: "2025-03-01T00:00:00.000Z",
        repositoryIdentity: marker
      });
      const { preview } = await repo.previewPersonalSourceCorrection(
        actor,
        source.id,
        {
          axis: "git",
          action: "unresolved",
          expectedVersion: 1
        }
      );
      const { context } = await repo.applyPersonalSourceCorrection(
        actor,
        source.id,
        preview.reviewId,
        {
          expectedVersion: 1
        }
      );
      expect(context.git).toMatchObject({
        original: { state: "unresolved", reason: "unreliable" },
        correction: {
          state: "corrected",
          value: { state: "unresolved", reason: "explicit_unresolved" }
        }
      });
      const artifactId = await addCodexArtifact(
        pool,
        user.id,
        source.id,
        externalSessionId
      );
      const run = await repo.createHistoricalImportRun(actor);
      await recordImport(pool, user.id, run.id, artifactId);
      expect(
        (await repo.getPersonalSourceContext(actor, source.id)).context.git
      ).toEqual(context.git);
    });
  }
);
