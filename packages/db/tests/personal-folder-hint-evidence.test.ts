import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  personalFolderHintEvidenceSchema,
  type RepositoryIdentity
} from "@koed-labs/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const options = {
  envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 94).toString("base64")
  )
};
const portable = {
  kind: "portable_repository",
  key: "gr_folder_hint",
  root: "/repo",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout",
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/repo"
} as const satisfies RepositoryIdentity;
const local = {
  ...portable,
  kind: "device_local_repository",
  reason: "local_fallback",
  selectedRemote: null,
  anchorDisplay: null
} as const satisfies RepositoryIdentity;
const unresolved = {
  ...local,
  kind: "unresolved",
  key: null,
  reason: "probe_failed"
} as const satisfies RepositoryIdentity;
const nonGit = {
  ...local,
  kind: "non_git_project",
  reason: "non_git"
} as const satisfies RepositoryIdentity;

describe.skipIf(!databaseUrl)("Folder hint evidence in PostgreSQL", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("returns only proposed owned Folder references that correction preview can resolve", async () => {
    const repo = createMemorySourceRepository(pool, options);
    const user = async () => ({
      userId: (
        await repo.createUser({ email: `hint-${randomUUID()}@example.test` })
      ).id
    });
    const actor = await user();
    const other = await user();
    const source = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID()
    });
    const observation = {
      identity: {
        folderId: "folder",
        originatingDeploymentId: "deployment",
        originatingDeviceId: "device",
        originatingProfileId: "profile",
        directoryIncarnationId: "recorded"
      },
      normalizedPath: "/work/recorded",
      capturedPath: "/work/recorded",
      observedAt: new Date().toISOString()
    };
    await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      currentFolderObservation: observation
    });
    const unproposed = {
      ...observation.identity,
      directoryIncarnationId: "unproposed"
    };
    await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      currentFolderObservation: { ...observation, identity: unproposed }
    });
    const foreignIdentity = {
      ...observation.identity,
      directoryIncarnationId: "foreign-only"
    };
    const foreign = await repo.createCapturedSession(other, {
      externalSessionId: randomUUID(),
      currentFolderObservation: { ...observation, identity: foreignIdentity }
    });
    const folder = { ...observation.identity, ownerUserId: actor.userId };
    const unknown = { ...folder, directoryIncarnationId: "registry-only" };
    const result = await repo.getPersonalFolderHintEvidence(actor, {
      sessionIds: [source.id, foreign.id],
      proposedFolders: [
        folder,
        folder,
        unknown,
        { ...folder, ownerUserId: other.userId },
        { ...foreignIdentity, ownerUserId: actor.userId }
      ]
    });
    expect(
      (
        await repo.getPersonalFolderHintEvidence(actor, {
          sessionIds: [foreign.id],
          proposedFolders: [folder]
        })
      ).knownFolders
    ).toEqual([]);
    expect(personalFolderHintEvidenceSchema.parse(result).knownFolders).toEqual(
      [folder]
    );
    expect(result.evidence.map(({ sessionId }) => sessionId)).toEqual([
      source.id
    ]);
    const preview = (target: typeof folder) =>
      repo.previewPersonalSourceCorrection(actor, source.id, {
        axis: "folder",
        action: "set",
        expectedVersion: 1,
        folder: target
      });
    expect(
      (await preview(folder)).preview.after.folder.correction
    ).toMatchObject({
      state: "corrected",
      value: { state: "known", value: { reference: folder } }
    });
    await expect(preview(unknown)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("uses native historical start and rechecks restricted reviews before writing", async () => {
    const repo = createMemorySourceRepository(pool, options);
    const actor = {
      userId: (await repo.createUser({ email: `${randomUUID()}@example.test` }))
        .id
    };
    const externalSessionId = randomUUID();
    const source = await repo.createCapturedSession(actor, {
      externalSessionId,
      importObservedAt: "2025-03-01T00:00:00.000Z",
      repositoryIdentity: {
        kind: "unresolved",
        key: null,
        root: null,
        branch: null,
        reason: "probe_ambiguous",
        checkoutId: null,
        originatingDeviceId: "historical_unknown_device",
        selectedRemote: null,
        anchorDisplay: null
      }
    });
    const event = await repo.createMemoryEvent(actor, {
      sessionId: source.id,
      projectId: "legacy",
      actor: "user",
      visibility: "personal",
      eventType: "captured",
      rawEventType: "user_message",
      content: "Not a Conversation start",
      idempotencyKey: randomUUID()
    });
    await pool.query(
      "update memory_events set source_event_time=$2 where id=$1",
      [event.id, "2024-08-01T00:00:00.000Z"]
    );
    const evidence = async () =>
      (
        await repo.getPersonalFolderHintEvidence(actor, {
          sessionIds: [source.id]
        })
      ).evidence[0];
    let importBasis:
      | {
          artifactId: string;
          importSourceId: string;
          deploymentId: string;
          deviceId: string;
          startedAt: string;
        }
      | undefined;
    const preview = (
      inferenceIntent:
        | "recording-device"
        | "user-confirmed-unknown"
        | "assumed-local-import"
    ) => {
      const correction = {
        axis: "git",
        action: "set",
        repository: portable,
        expectedVersion: 1,
        inferenceIntent,
        ...(inferenceIntent === "assumed-local-import" && importBasis
          ? { localImportBasis: importBasis }
          : {})
      } as const;
      return repo.previewPersonalSourceCorrection(actor, source.id, correction);
    };
    expect(await evidence()).toMatchObject({
      firstConversationAt: null,
      capturedOnThisDevice: false,
      recordingDeviceProvenance: "unknown",
      gitInferenceEligibility: false
    });
    await expect(preview("user-confirmed-unknown")).rejects.toMatchObject({
      statusCode: 409
    });

    const nativeStart = "2024-07-01T00:00:00.000Z";
    const addArtifact = async (role: "origin_local" | "hosted_personal") =>
      (
        await pool.query<{ id: string }>(
          `insert into conversation_source_artifacts
          (owner_user_id,session_id,logical_source_id,source_generation_id,replica_role,source_kind,
           source_runtime,external_session_id,source_fingerprint,artifact_format,artifact_format_version,
           source_adapter_version,live_start_offset,live_start_line,current_source_length,source_created_at,
           storage_provider,storage_prefix,origin_deployment_id,origin_device_id,origin_key_id,origin_public_key,redacted_source_label)
         values($1,$2,$3,$4,$5,'codex','codex-cli',$6,repeat('a',64),'codex_rollout_jsonl',1,
           'codex-transcript-v1',100,2,100,$7,'test',$4::uuid::text,'deployment','device','test-key',repeat('a',43),'rollout') returning id`,
          [
            actor.userId,
            source.id,
            randomUUID(),
            randomUUID(),
            role,
            externalSessionId,
            nativeStart
          ]
        )
      ).rows[0]!.id;
    const artifactId = await addArtifact("origin_local");
    expect(await evidence()).toMatchObject({
      firstConversationAt: nativeStart,
      gitInferenceEligibility: false
    });
    await expect(preview("assumed-local-import")).rejects.toMatchObject({
      statusCode: 409
    });
    const run = await repo.createHistoricalImportRun(actor);
    const {
      rows: [importRecord]
    } = await pool.query<{ id: string }>(
      `insert into historical_import_sources(run_id,owner_user_id,artifact_id,ai_client,raw_ingested_record_count)
       values($1,$2,$3,'codex',1) returning id`,
      [run.id, actor.userId, artifactId]
    );
    const correctBasis = {
      artifactId,
      importSourceId: importRecord!.id,
      startedAt: "2024-07-01T00:00:00.000000Z",
      deploymentId: "deployment",
      deviceId: "device"
    };
    expect(await evidence()).toMatchObject({
      firstConversationAt: nativeStart,
      capturedOnThisDevice: false,
      recordingDeviceProvenance: "assumed-local-import",
      importAuthority: correctBasis,
      gitInferenceEligibility: true,
      gitUnknownReviewEligible: true,
      gitRevision: 1
    });
    await expect(preview("recording-device")).rejects.toMatchObject({
      statusCode: 409
    });
    await expect(preview("user-confirmed-unknown")).rejects.toMatchObject({
      statusCode: 404
    });
    await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      repositoryIdentity: portable
    });
    await expect(preview("user-confirmed-unknown")).rejects.toMatchObject({
      statusCode: 409,
      message: "Git inference requires an active Project Git Anchor rule."
    });
    const created = await repo.createNamedPersonalProject(actor, {
      name: "Reviewed destination"
    });
    const { project, rule } = await repo.addPersonalProjectRepositoryRule(
      actor,
      created.projectId,
      {
        expectedVersion: created.version,
        repository: portable
      }
    );
    for (const mismatch of [
      undefined,
      { ...correctBasis, artifactId: randomUUID() },
      { ...correctBasis, importSourceId: randomUUID() },
      { ...correctBasis, startedAt: "2024-07-01T00:00:00.000001Z" },
      { ...correctBasis, deploymentId: "elsewhere" },
      { ...correctBasis, deviceId: "elsewhere" }
    ]) {
      importBasis = mismatch;
      await expect(preview("assumed-local-import")).rejects.toMatchObject({
        statusCode: 409
      });
    }
    importBasis = correctBasis;
    const legacyOriginal = { state: "unresolved", reason: "unreliable" };
    const legacyAssignment = {
      revision: 1,
      original: legacyOriginal,
      correction: { state: "original" }
    };
    const {
      rows: [legacy]
    } = await pool.query<{ binding_id: string }>(
      `insert into personal_source_bindings (
        owner_user_id, local_session_id, source_logical_session_id,
        originating_deployment_id, originating_device_id, context_version,
        availability, git_state, folder_state, git_original, git_frontier, git_assignment
      ) values ($1, $2::uuid, $2::uuid::text, $3, $4, 1, 'available', 'available', 'available',
        $5, array['git_original'], $6) returning binding_id`,
      [
        actor.userId,
        source.id,
        correctBasis.deploymentId,
        correctBasis.deviceId,
        legacyOriginal,
        legacyAssignment
      ]
    );
    await pool.query(
      `insert into personal_source_context_revisions (binding_id, axis, revision_id, replaces, assignment)
       values ($1, 'git', 'git_original', '{}', $2)`,
      [legacy!.binding_id, legacyAssignment]
    );
    expect(await evidence()).toMatchObject({
      gitInferenceEligibility: true,
      gitUnknownReviewEligible: false,
      importAuthority: correctBasis
    });
    await expect(preview("user-confirmed-unknown")).rejects.toMatchObject({
      statusCode: 409,
      message: "Conversation is not eligible for Git inference."
    });
    await expect(preview("assumed-local-import")).resolves.toHaveProperty(
      "preview"
    );
    await pool.query(
      "delete from personal_source_bindings where binding_id=$1",
      [legacy!.binding_id]
    );

    const staleReview = (await preview("assumed-local-import")).preview;
    expect(staleReview.projects).toContainEqual(
      expect.objectContaining({
        projectId: project.projectId,
        version: project.version,
        beforeIncluded: false,
        afterIncluded: true
      })
    );
    const apply = (reviewId: string) =>
      repo.applyPersonalSourceCorrection(actor, source.id, reviewId, {
        expectedVersion: 1
      });
    const removed = await repo.removePersonalProjectRule(
      actor,
      project.projectId,
      rule.inclusionId,
      { expectedVersion: project.version }
    );
    await expect(apply(staleReview.reviewId)).rejects.toMatchObject({
      statusCode: 409,
      message: "Git inference requires an active Project Git Anchor rule."
    });
    expect(await evidence()).toMatchObject({
      gitRevision: 1,
      gitInferenceEligibility: true
    });
    await repo.addPersonalProjectRepositoryRule(actor, project.projectId, {
      expectedVersion: removed.project.version,
      repository: portable
    });
    const review = (await preview("assumed-local-import")).preview;
    expect(review).toMatchObject({ inferenceIntent: "assumed-local-import" });
    const setImportCount = (count: number) =>
      pool.query(
        "update historical_import_sources set raw_ingested_record_count=$2 where artifact_id=$1",
        [artifactId, count]
      );
    await setImportCount(0);
    await expect(apply(review.reviewId)).rejects.toMatchObject({
      statusCode: 409
    });
    await setImportCount(1);
    const setImportingDevice = (device: string) =>
      pool.query(
        "update conversation_source_artifacts set origin_device_id=$2 where id=$1",
        [artifactId, device]
      );
    await setImportingDevice("different-device");
    await expect(apply(review.reviewId)).rejects.toMatchObject({
      statusCode: 409
    });
    await setImportingDevice("device");
    const setImportSourceId = (id: string) =>
      pool.query(
        "update historical_import_sources set id=$2 where artifact_id=$1",
        [artifactId, id]
      );
    await setImportSourceId(randomUUID());
    await expect(apply(review.reviewId)).rejects.toMatchObject({
      statusCode: 409
    });
    await setImportSourceId(correctBasis.importSourceId);
    const copyId = await addArtifact("hosted_personal");
    await expect(preview("assumed-local-import")).rejects.toMatchObject({
      statusCode: 409
    });
    expect(await evidence()).toMatchObject({
      recordingDeviceProvenance: "known-copy",
      gitInferenceEligibility: false
    });
    await expect(apply(review.reviewId)).rejects.toMatchObject({
      statusCode: 409
    });
    await pool.query("delete from conversation_source_artifacts where id=$1", [
      copyId
    ]);
    const competing = (await preview("assumed-local-import")).preview;
    const outcomes = await Promise.allSettled([
      apply(review.reviewId),
      apply(competing.reviewId)
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected"
    ]);
    expect(await evidence()).toMatchObject({
      gitAnchorKnown: true,
      gitRevision: 2,
      recordingDeviceProvenance: "assumed-local-import",
      gitInferenceEligibility: false
    });
    const reset = (
      await repo.previewPersonalSourceCorrection(actor, source.id, {
        axis: "git",
        action: "reset",
        expectedVersion: 2
      })
    ).preview;
    await repo.applyPersonalSourceCorrection(actor, source.id, reset.reviewId, {
      expectedVersion: 2
    });
    expect(await evidence()).toMatchObject({
      gitRevision: 3,
      gitInferenceEligibility: false
    });
    const afterReset = {
      axis: "git",
      action: "set",
      repository: portable,
      expectedVersion: 3,
      localImportBasis: correctBasis,
      inferenceIntent: "assumed-local-import"
    } as const;
    await expect(
      repo.previewPersonalSourceCorrection(actor, source.id, afterReset)
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reports known Git Anchors from effective identity without invalidating a mixed batch", async () => {
    const repo = createMemorySourceRepository(pool, options);
    const actor = {
      userId: (
        await repo.createUser({ email: `hint-${randomUUID()}@example.test` })
      ).id
    };
    const cases = [
      { automatic: null, override: null, known: false },
      { automatic: unresolved, override: null, known: false },
      { automatic: null, override: unresolved, known: false },
      { automatic: portable, override: unresolved, known: false },
      { automatic: portable, override: nonGit, known: false },
      { automatic: portable, override: null, known: true },
      { automatic: local, override: null, known: true },
      { automatic: unresolved, override: portable, known: true },
      { automatic: unresolved, override: local, known: true }
    ];
    const anchors = new Map<string, boolean>();
    for (const { automatic, override, known } of cases) {
      const session = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        ...(automatic ? { repositoryIdentity: automatic } : {})
      });
      if (override)
        await pool.query(
          "update sessions set repository_override_identity=$2 where id=$1",
          [session.id, override]
        );
      anchors.set(session.id, known);
    }
    const deleted = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID()
    });
    const invalidated = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID()
    });
    await pool.query(
      "update sessions set personal_deleted_at=now() where id=$1",
      [deleted.id]
    );
    await pool.query("update sessions set invalidated_at=now() where id=$1", [
      invalidated.id
    ]);

    const result = await repo.getPersonalFolderHintEvidence(actor, {
      sessionIds: [...anchors.keys(), deleted.id, invalidated.id]
    });
    const bySession = new Map(
      result.evidence.map((row) => [row.sessionId, row.gitAnchorKnown])
    );
    expect(bySession.get(anchors.keys().next().value!)).toBe(false);
    expect(personalFolderHintEvidenceSchema.parse(result).ownerUserId).toBe(
      actor.userId
    );
    expect(bySession).toEqual(anchors);
  });
});
