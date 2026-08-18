import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  calculateConversationSourceReplicationContentDigest,
  calculateConversationSourceReplicationManifestDigest,
  calculateConversationSourceRootDigest,
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  generateConversationSourceReplicationOriginKeyPair,
  signConversationSourceClosureManifest,
  signConversationSourceReplicationManifest,
  type ConversationSourceOriginKeyPair,
  type ConversationSourcePriorGenerationClosure
} from "@koed/shared";
import {
  createDbPool,
  createEmbeddingCapacityRepository,
  createMemorySourceRepository,
  runDbMigrations,
  validateHistoricalImportTransition,
  type ConversationItemInput,
  type ConversationSourceArtifactRecord,
  type EmbeddingCapacityProfileInput,
  type MemorySourceRepository
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const sourceCreatedAt = "2026-07-01T00:00:00.000Z";

const sourceIdentity = (
  keys: ConversationSourceOriginKeyPair,
  sourceGenerationId = randomUUID()
) => ({
  logicalSourceId: randomUUID(),
  sourceGenerationId,
  replicaRole: "origin_local" as const,
  sourceRuntime: "codex-cli" as const,
  sourceAdapterVersion: "codex-transcript-v1",
  sourceCreatedAt,
  originDeploymentId: randomUUID(),
  originDeviceId: randomUUID(),
  originKeyId: keys.originKeyId,
  originPublicKey: keys.publicKeyBase64url
});

const signedSegment = (input: {
  artifact: {
    logicalSourceId: string;
    sourceGenerationId: string;
    originKeyId: string;
    artifactFormat: string;
    sourceAdapterVersion: string;
    sourceCreatedAt: string;
    sourceComponentId: string;
    sourceComponentRole: "primary" | "auxiliary";
    parentSourceComponentId: string | null;
    contentFraming: "jsonl" | "immutable_blob";
  };
  keys: ConversationSourceOriginKeyPair;
  segmentIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  sourceStartLine: number;
  sourceEndLine: number;
  plaintextDigest: string;
  previousContentDigest: string | null;
}) => {
  const signed = signConversationSourceReplicationManifest(
    {
      protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
      sourceComponentSchemaVersion: 1,
      sourceComponentId: input.artifact.sourceComponentId,
      sourceComponentRole: input.artifact.sourceComponentRole,
      parentSourceComponentId: input.artifact.parentSourceComponentId,
      contentFraming: input.artifact.contentFraming,
      logicalSourceId: input.artifact.logicalSourceId,
      sourceGenerationId: input.artifact.sourceGenerationId,
      originKeyId: input.artifact.originKeyId,
      segmentIndex: input.segmentIndex,
      startByteCursor: input.sourceStartOffset,
      endByteCursor: input.sourceEndOffset,
      startItemCursor: input.sourceStartLine,
      endItemCursor: input.sourceEndLine,
      previousContentDigest: input.previousContentDigest,
      plaintextDigest: input.plaintextDigest,
      sourceFormat: input.artifact.artifactFormat,
      adapterVersion: input.artifact.sourceAdapterVersion,
      sourceCreatedAt: input.artifact.sourceCreatedAt,
      priorGenerationClosure: null
    },
    input.keys.privateKey
  );
  return {
    signedManifest: signed.manifest as unknown as Record<string, unknown>,
    originSignature: signed.signature,
    manifestDigest: calculateConversationSourceReplicationManifestDigest(
      signed.manifest
    ),
    previousContentDigest: input.previousContentDigest,
    contentDigest: calculateConversationSourceReplicationContentDigest(signed)
  };
};

const sourceItem = (input: {
  externalSessionId: string;
  rawText?: string;
  byteOffset?: number;
}): ConversationItemInput => ({
  sourceKind: "codex",
  sourceAdapterVersion: "codex-transcript-v1",
  sourceTransport: "historical_import",
  externalSessionId: input.externalSessionId,
  externalThreadId: input.externalSessionId,
  externalTurnId: "turn-1",
  sourceRecordType: "event_msg",
  sourceEventType: "user_message",
  sourceLineNumber: 2,
  sourceSequence: 2,
  eventTime: "2026-07-01T12:00:00.000Z",
  rawJson: {
    timestamp: "2026-07-01T12:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "user_message",
      message: input.rawText ?? "Durable historical memory"
    }
  },
  rawText: input.rawText ?? "Durable historical memory",
  sourceHash: digest(`source:${input.externalSessionId}:${input.byteOffset}`),
  idempotencyKey: `item:${input.externalSessionId}:${input.byteOffset ?? 64}`,
  projectionStatus: "pending",
  projectionVersion: "codex-transcript-v1",
  metadata: {
    transcriptByteOffset: input.byteOffset ?? 64,
    transcriptItemDiscriminator: "primary:codex_transcript_user",
    transcriptType: "user_message",
    sourceEventTimeAccuracy: "source"
  }
});

interface JournalFixture {
  ownerId: string;
  sessionId: string;
  artifactId: string;
  externalSessionId: string;
  frontier: number;
  segmentIndex: number;
  segmentDigest: string;
  segmentContentDigest: string;
  artifact: ConversationSourceArtifactRecord;
  keys: ConversationSourceOriginKeyPair;
}

const createJournalFixture = async (
  repo: MemorySourceRepository,
  input: {
    ownerId: string;
    externalSessionId?: string;
    frontier?: number;
    sourceLength?: number;
  }
): Promise<JournalFixture> => {
  const externalSessionId =
    input.externalSessionId ?? `historical-${randomUUID()}`;
  const frontier = input.frontier ?? 128;
  const sourceLength = input.sourceLength ?? frontier;
  const keys = generateConversationSourceReplicationOriginKeyPair();
  const session = await repo.createCapturedSession(
    { userId: input.ownerId },
    {
      externalSessionId,
      sourceRuntime: "codex-cli",
      captureMethod: "api",
      sourceKind: "codex",
      sourceAdapterVersion: "codex-transcript-v1",
      sourceFingerprint: digest(`source:${externalSessionId}`),
      idempotencyKey: `session:${externalSessionId}`,
      projectId: `/projects/${externalSessionId}`,
      metadata: { projectName: "Historical Project" }
    }
  );
  const artifact = await repo.ensureConversationSourceArtifact(
    { userId: input.ownerId },
    {
      sessionId: session.id,
      ...sourceIdentity(keys),
      sourceKind: "codex",
      externalSessionId,
      sourceFingerprint: digest(`artifact:${externalSessionId}`),
      artifactFormat: "codex_rollout_jsonl",
      artifactFormatVersion: 1,
      journalStartOffset: 0,
      journalStartLine: 0,
      liveStartOffset: frontier,
      liveStartLine: 2,
      currentSourceLength: sourceLength,
      storageProvider: "test",
      storagePrefix: `artifact-${externalSessionId}`,
      redactedSourceLabel: "rollout.jsonl"
    }
  );
  const segmentDigest = digest(`segment:${externalSessionId}`);
  const segmentProof = signedSegment({
    artifact,
    keys,
    segmentIndex: 0,
    sourceStartOffset: 0,
    sourceEndOffset: sourceLength,
    sourceStartLine: 0,
    sourceEndLine: 2,
    plaintextDigest: segmentDigest,
    previousContentDigest: null
  });
  const appended = await repo.appendConversationSourceSegment(
    { userId: input.ownerId },
    {
      artifactId: artifact.id,
      expectedProviderOffset: 0,
      expectedProviderLine: 0,
      sourceEndOffset: sourceLength,
      sourceEndLine: 2,
      plaintextDigest: segmentDigest,
      plaintextSize: sourceLength,
      storedSize: sourceLength,
      storageKey: `test/${artifact.id}/${segmentDigest}`,
      storageProvider: "test",
      currentSourceLength: sourceLength,
      ...segmentProof
    }
  );
  return {
    ownerId: input.ownerId,
    sessionId: session.id,
    artifactId: artifact.id,
    externalSessionId,
    frontier,
    segmentIndex: appended.segment.segmentIndex,
    segmentDigest,
    segmentContentDigest: appended.segment.contentDigest,
    artifact: appended.artifact,
    keys
  };
};

describe("historical import transitions", () => {
  it("accepts resumable transitions and rejects invalid terminal edges", () => {
    expect(() =>
      validateHistoricalImportTransition("discovered", "eligible")
    ).not.toThrow();
    expect(() =>
      validateHistoricalImportTransition("paused", "importing")
    ).not.toThrow();
    expect(() =>
      validateHistoricalImportTransition("failed", "queued")
    ).not.toThrow();
    expect(() =>
      validateHistoricalImportTransition("completed", "queued")
    ).toThrow("Invalid historical import transition");
    expect(() =>
      validateHistoricalImportTransition("discovered", "completed")
    ).toThrow("Invalid historical import transition");
  });
});

describeDb("journal-backed historical import repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl! });
    await runDbMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates, reads, and touches a hosted Personal source authorization", async () => {
    const repository = createMemorySourceRepository(pool);
    const owner = await repository.createUser({
      email: `source-download-${randomUUID()}@example.com`
    });
    const fixture = await createJournalFixture(repository, {
      ownerId: owner.id
    });
    await pool.query(
      `update conversation_source_artifacts
          set replica_role = 'hosted_personal'
        where owner_user_id = $1 and id = $2`,
      [owner.id, fixture.artifactId]
    );
    const challengeHash = digest(`challenge:${randomUUID()}`);
    await repository.createDeviceEnrollmentChallenge({
      challengeHash,
      upstreamBackendId: "source-download-test",
      deviceInstanceId: randomUUID(),
      requestedOperationFamilies: ["sync"],
      expiresAt: new Date(Date.now() + 60_000)
    });
    const credential = await repository.redeemDeviceEnrollmentChallenge(
      { userId: owner.id },
      {
        challengeHash,
        credentialKeyId: `source-download-${randomUUID()}`,
        verifierKind: "secret_hash",
        verifierHash: digest(`verifier:${randomUUID()}`)
      }
    );
    expect(credential).not.toBeNull();
    const capabilityHash = digest(`capability:${randomUUID()}`);
    const authorization =
      await repository.createConversationSourceDownloadAuthorization(
        { userId: owner.id },
        {
          deviceCredentialId: credential!.id,
          artifactId: fixture.artifactId,
          recipientKey: { targetDeploymentId: randomUUID() },
          capabilityHash,
          firstSegmentIndex: 0,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
        }
      );

    await expect(
      repository.getConversationSourceDownloadAuthorization(
        { userId: owner.id },
        {
          deviceCredentialId: credential!.id,
          authorizationId: authorization.id,
          capabilityHash
        }
      )
    ).resolves.toMatchObject({
      id: authorization.id,
      artifactId: fixture.artifactId,
      firstSegmentIndex: 0,
      lastSegmentIndex: 0
    });
    await expect(
      repository.touchConversationSourceDownloadAuthorization(
        { userId: owner.id },
        authorization.id
      )
    ).resolves.toBe(true);
    await expect(
      repository.listConversationSourceSegmentsByIndex(
        { userId: owner.id },
        {
          artifactId: fixture.artifactId,
          afterSegmentIndex: -1,
          throughSegmentIndex: authorization.lastSegmentIndex,
          limit: 100
        }
      )
    ).resolves.toEqual([
      expect.objectContaining({
        artifactId: fixture.artifactId,
        segmentIndex: 0,
        plaintextDigest: fixture.segmentDigest
      })
    ]);

    const closedAt = new Date().toISOString();
    await repository.finalizeConversationSourceArtifact(
      { userId: owner.id },
      {
        artifactId: fixture.artifactId,
        signedClosure: signConversationSourceClosureManifest(
          {
            protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
            sourceComponentSchemaVersion: 1,
            sourceComponentId: fixture.artifact.sourceComponentId,
            sourceComponentRole: fixture.artifact.sourceComponentRole,
            parentSourceComponentId: fixture.artifact.parentSourceComponentId,
            contentFraming: fixture.artifact.contentFraming,
            logicalSourceId: fixture.artifact.logicalSourceId,
            sourceGenerationId: fixture.artifact.sourceGenerationId,
            originKeyId: fixture.artifact.originKeyId,
            segmentCount: 1,
            endByteCursor: fixture.artifact.providerCursorOffset,
            endItemCursor: fixture.artifact.providerCursorLine,
            chainHeadDigest: fixture.segmentContentDigest,
            sourceRootDigest: calculateConversationSourceRootDigest([
              fixture.segmentContentDigest
            ]),
            sourceCreatedAt: fixture.artifact.sourceCreatedAt,
            closedAt,
            priorGenerationClosure: null
          },
          fixture.keys.privateKey
        )
      }
    );

    const finalizedCapabilityHash = digest(`sealed-capability:${randomUUID()}`);
    const finalizedAuthorization =
      await repository.createConversationSourceDownloadAuthorization(
        { userId: owner.id },
        {
          deviceCredentialId: credential!.id,
          artifactId: fixture.artifactId,
          recipientKey: { targetDeploymentId: randomUUID() },
          capabilityHash: finalizedCapabilityHash,
          firstSegmentIndex: 0,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
        }
      );
    expect(finalizedAuthorization).toMatchObject({
      artifactId: fixture.artifactId,
      firstSegmentIndex: 0,
      lastSegmentIndex: 0
    });
    await expect(
      repository.getConversationSourceDownloadAuthorization(
        { userId: owner.id },
        {
          deviceCredentialId: credential!.id,
          authorizationId: finalizedAuthorization.id,
          capabilityHash: finalizedCapabilityHash
        }
      )
    ).resolves.toMatchObject({
      artifactId: fixture.artifactId,
      id: finalizedAuthorization.id
    });

    const successorKeys = generateConversationSourceReplicationOriginKeyPair();
    const successor =
      await repository.createConversationSourceSuccessorGeneration(
        { userId: owner.id },
        {
          parentArtifactId: fixture.artifactId,
          expectedParentClosureHash:
            (await repository.getConversationSourceArtifact(
              { userId: owner.id },
              fixture.artifactId
            ))!.closureHash!,
          sourceGenerationId: randomUUID(),
          originDeploymentId: randomUUID(),
          originDeviceId: randomUUID(),
          originKeyId: successorKeys.originKeyId,
          originPublicKey: successorKeys.publicKeyBase64url,
          sourceCreatedAt: new Date().toISOString(),
          storageProvider: "postgres",
          storagePrefix: `test/${randomUUID()}`
        }
      );
    const successorClosedAt = new Date().toISOString();
    const finalizedSuccessor =
      await repository.finalizeConversationSourceArtifact(
        { userId: owner.id },
        {
          artifactId: successor.artifact.id,
          signedClosure: signConversationSourceClosureManifest(
            {
              protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
              sourceComponentSchemaVersion: 1,
              sourceComponentId: successor.artifact.sourceComponentId,
              sourceComponentRole: successor.artifact.sourceComponentRole,
              parentSourceComponentId:
                successor.artifact.parentSourceComponentId,
              contentFraming: successor.artifact.contentFraming,
              logicalSourceId: successor.artifact.logicalSourceId,
              sourceGenerationId: successor.artifact.sourceGenerationId,
              originKeyId: successor.artifact.originKeyId,
              segmentCount: 0,
              endByteCursor: successor.artifact.providerCursorOffset,
              endItemCursor: successor.artifact.providerCursorLine,
              chainHeadDigest: null,
              sourceRootDigest: calculateConversationSourceRootDigest([]),
              sourceCreatedAt: successor.artifact.sourceCreatedAt,
              closedAt: successorClosedAt,
              priorGenerationClosure: successor.artifact
                .priorGenerationClosure as ConversationSourcePriorGenerationClosure | null
            },
            successorKeys.privateKey
          )
        }
      );
    await pool.query(
      `update conversation_source_artifacts
          set replica_role = 'hosted_personal'
        where owner_user_id = $1 and id = $2`,
      [owner.id, finalizedSuccessor.artifact.id]
    );
    const emptyAuthorization =
      await repository.createConversationSourceDownloadAuthorization(
        { userId: owner.id },
        {
          deviceCredentialId: credential!.id,
          artifactId: finalizedSuccessor.artifact.id,
          recipientKey: { targetDeploymentId: randomUUID() },
          capabilityHash: digest(`empty-capability:${randomUUID()}`),
          firstSegmentIndex: 0,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
        }
      );
    expect(emptyAuthorization).toMatchObject({
      artifactId: finalizedSuccessor.artifact.id,
      firstSegmentIndex: 0,
      lastSegmentIndex: -1
    });
  });

  it("atomically registers a Captured Session with its source artifact", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `journal-registration-${randomUUID()}@example.com`
    });
    const externalSessionId = `journal-${randomUUID()}`;
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const session = {
      externalSessionId,
      sourceRuntime: "codex-cli" as const,
      captureMethod: "api" as const,
      cwd: `/projects/${externalSessionId}`,
      idempotencyKey: `journal-session:${externalSessionId}`,
      metadata: { sourceTransport: "transcript" }
    };
    const artifact = {
      ...sourceIdentity(keys),
      sourceKind: "codex",
      externalSessionId,
      sourceFingerprint: digest(`artifact:${externalSessionId}`),
      artifactFormat: "codex_rollout_jsonl",
      artifactFormatVersion: 1,
      journalStartOffset: 0,
      journalStartLine: 0,
      liveStartOffset: 128,
      liveStartLine: 2,
      currentSourceLength: 128,
      storageProvider: "test",
      storagePrefix: `artifact-${externalSessionId}`,
      redactedSourceLabel: "rollout.jsonl"
    };

    const registered =
      await repo.ensureConversationSourceArtifactForCapturedSession(
        { userId: owner.id },
        { session, artifact }
      );
    expect(registered.artifact.sessionId).toBe(registered.session.id);
    expect(registered.artifact).toMatchObject({
      sourceComponentId: "main",
      sourceComponentRole: "primary",
      parentSourceComponentId: null,
      contentFraming: "jsonl"
    });

    const auxiliaryKeys = generateConversationSourceReplicationOriginKeyPair();
    const auxiliary = await repo.ensureConversationSourceArtifact(
      { userId: owner.id },
      {
        ...artifact,
        sessionId: registered.session.id,
        sourceComponentId: "attachment.notes",
        sourceComponentRole: "auxiliary",
        parentSourceComponentId: "main",
        contentFraming: "immutable_blob",
        artifactFormat: "claude_attachment_blob",
        originKeyId: auxiliaryKeys.originKeyId,
        originPublicKey: auxiliaryKeys.publicKeyBase64url,
        storagePrefix: `${artifact.storagePrefix}-attachment`
      }
    );
    expect(auxiliary.sourceGenerationId).toBe(
      registered.artifact.sourceGenerationId
    );
    await expect(
      repo.getConversationSourceArtifactByIdentity(
        { userId: owner.id },
        {
          logicalSourceId: registered.artifact.logicalSourceId,
          sourceGenerationId: registered.artifact.sourceGenerationId,
          sourceComponentId: "attachment.notes"
        }
      )
    ).resolves.toMatchObject({ id: auxiliary.id });

    const invalidExternalSessionId = `invalid-${randomUUID()}`;
    await expect(
      repo.ensureConversationSourceArtifactForCapturedSession(
        { userId: owner.id },
        {
          session: {
            ...session,
            externalSessionId: invalidExternalSessionId,
            idempotencyKey: `journal-session:${invalidExternalSessionId}`
          },
          artifact: {
            ...artifact,
            externalSessionId: `mismatch-${randomUUID()}`
          }
        }
      )
    ).rejects.toThrow("Captured Session not found for source artifact");
    const rolledBack = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from sessions
        where owner_user_id = $1 and external_session_id = $2`,
      [owner.id, invalidExternalSessionId]
    );
    expect(rolledBack.rows[0]?.count).toBe("0");
  });

  it("registers only owner-scoped journal artifacts on writable runs", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `historical-owner-${randomUUID()}@example.com`
    });
    const outsider = await repo.createUser({
      email: `historical-outsider-${randomUUID()}@example.com`
    });
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });
    const run = await repo.createHistoricalImportRun({ userId: owner.id });

    await expect(
      repo.createHistoricalImportSource(
        { userId: outsider.id },
        {
          runId: run.id,
          artifactId: fixture.artifactId,
          aiClient: "codex"
        }
      )
    ).resolves.toBeNull();

    const source = await repo.createHistoricalImportSource(
      { userId: owner.id },
      {
        runId: run.id,
        artifactId: fixture.artifactId,
        aiClient: "codex",
        discoveredRecordCount: 2,
        detectedProject: {
          projectId: `/projects/${fixture.externalSessionId}`,
          name: "Historical Project",
          path: `/private/${fixture.externalSessionId}`
        }
      }
    );
    expect(source).toMatchObject({
      artifactId: fixture.artifactId,
      sessionId: fixture.sessionId,
      sourceSessionId: fixture.externalSessionId,
      registrationFrontierOffset: fixture.frontier,
      historicalCursorOffset: 0,
      providerCursorOffset: fixture.frontier,
      redactedSourceLabel: "rollout.jsonl"
    });
    expect(
      await repo.getHistoricalImportSourceByIdentity(
        { userId: owner.id },
        { artifactId: fixture.artifactId }
      )
    ).toMatchObject({ id: source!.id });

    const auxiliaryKeys = generateConversationSourceReplicationOriginKeyPair();
    const {
      id: persistedArtifactId,
      sourceModifiedAt,
      priorGenerationClosure,
      ...artifactWithoutId
    } = fixture.artifact;
    expect(persistedArtifactId).toBe(fixture.artifactId);
    const auxiliaryArtifact = await repo.ensureConversationSourceArtifact(
      { userId: owner.id },
      {
        ...artifactWithoutId,
        sourceModifiedAt: sourceModifiedAt ?? undefined,
        priorGenerationClosure: priorGenerationClosure ?? undefined,
        sourceComponentId: "subagent.researcher",
        sourceComponentRole: "auxiliary",
        parentSourceComponentId: "main",
        contentFraming: "jsonl",
        sourceFingerprint: digest(
          `artifact:${fixture.externalSessionId}:subagent.researcher`
        ),
        originKeyId: auxiliaryKeys.originKeyId,
        originPublicKey: auxiliaryKeys.publicKeyBase64url,
        storagePrefix: `${fixture.artifact.storagePrefix}-subagent-researcher`,
        redactedSourceLabel: "agent-researcher.jsonl"
      }
    );
    const auxiliarySource = await repo.createHistoricalImportSource(
      { userId: owner.id },
      {
        runId: run.id,
        artifactId: auxiliaryArtifact.id,
        aiClient: "codex"
      }
    );
    expect(
      await repo.getHistoricalImportSourceByIdentity(
        { userId: owner.id },
        { artifactId: auxiliaryArtifact.id }
      )
    ).toMatchObject({ id: auxiliarySource!.id });
    expect(
      await repo.getHistoricalImportSourceByIdentity(
        { userId: owner.id },
        { artifactId: fixture.artifactId }
      )
    ).toMatchObject({ id: source!.id });
    expect(
      await repo.getHistoricalImportSource({ userId: outsider.id }, source!.id)
    ).toBeNull();

    await repo.transitionHistoricalImportRun(
      { userId: owner.id },
      {
        runId: run.id,
        expectedState: "discovered",
        state: "failed",
        failureReason: "test.closed"
      }
    );
    const secondFixture = await createJournalFixture(repo, {
      ownerId: owner.id
    });
    expect(
      await repo.createHistoricalImportSource(
        { userId: owner.id },
        {
          runId: run.id,
          artifactId: secondFixture.artifactId,
          aiClient: "codex"
        }
      )
    ).toBeNull();
  });

  it("allows repeated content-addressed bytes at different source ranges", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `journal-repeated-segment-${randomUUID()}@example.com`
    });
    const externalSessionId = `journal-repeated-segment-${randomUUID()}`;
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId,
        sourceRuntime: "codex-cli",
        captureMethod: "api",
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        sourceFingerprint: digest(`source:${externalSessionId}`),
        idempotencyKey: `session:${externalSessionId}`,
        projectId: `/projects/${externalSessionId}`
      }
    );
    const artifact = await repo.ensureConversationSourceArtifact(
      { userId: owner.id },
      {
        sessionId: session.id,
        ...sourceIdentity(keys),
        sourceKind: "codex",
        externalSessionId,
        sourceFingerprint: digest(`artifact:${externalSessionId}`),
        artifactFormat: "codex_rollout_jsonl",
        artifactFormatVersion: 1,
        journalStartOffset: 0,
        journalStartLine: 0,
        liveStartOffset: 0,
        liveStartLine: 0,
        currentSourceLength: 64,
        storageProvider: "test",
        storagePrefix: `artifact-${externalSessionId}`,
        redactedSourceLabel: "rollout.jsonl"
      }
    );
    const plaintextDigest = digest("identical-valid-jsonl-segment");
    const storageKey = `test/${artifact.id}/${plaintextDigest}`;
    const firstProof = signedSegment({
      artifact,
      keys,
      segmentIndex: 0,
      sourceStartOffset: 0,
      sourceEndOffset: 32,
      sourceStartLine: 0,
      sourceEndLine: 1,
      plaintextDigest,
      previousContentDigest: null
    });

    const first = await repo.appendConversationSourceSegment(
      { userId: owner.id },
      {
        artifactId: artifact.id,
        expectedProviderOffset: 0,
        expectedProviderLine: 0,
        sourceEndOffset: 32,
        sourceEndLine: 1,
        plaintextDigest,
        plaintextSize: 32,
        storedSize: 32,
        storageKey,
        storageProvider: "test",
        currentSourceLength: 64,
        ...firstProof
      }
    );
    const secondProof = signedSegment({
      artifact,
      keys,
      segmentIndex: 1,
      sourceStartOffset: 32,
      sourceEndOffset: 64,
      sourceStartLine: 1,
      sourceEndLine: 2,
      plaintextDigest,
      previousContentDigest: first.segment.contentDigest
    });
    const second = await repo.appendConversationSourceSegment(
      { userId: owner.id },
      {
        artifactId: artifact.id,
        expectedProviderOffset: 32,
        expectedProviderLine: 1,
        sourceEndOffset: 64,
        sourceEndLine: 2,
        plaintextDigest,
        plaintextSize: 32,
        storedSize: 32,
        storageKey,
        storageProvider: "test",
        currentSourceLength: 64,
        ...secondProof
      }
    );

    expect(first.segment.storageKey).toBe(storageKey);
    expect(second.segment.storageKey).toBe(storageKey);
    expect(second.segment.segmentIndex).toBe(first.segment.segmentIndex + 1);
  });

  it("claims a newly appended segment for an enabled Personal replica", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `source-replication-claim-${randomUUID()}@example.com`
    });
    const targetUpstreamId = `up_${randomUUID().replaceAll("-", "")}`;
    await repo.upsertPersonalSourceReplicationPolicy(
      { userId: owner.id },
      {
        enabled: true,
        targetUpstreamId,
        mode: "hosted_personal",
        effectiveFrom: "2026-06-01T00:00:00.000Z"
      }
    );
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });

    await expect(
      repo.listConversationSourceReplicationActors({
        direction: "upload",
        limit: 25
      })
    ).resolves.toContainEqual({ userId: owner.id });
    const claims = await repo.claimConversationSourceReplicationOutbox(
      { userId: owner.id },
      {
        workerId: "source-replication-claim-test",
        leaseMs: 180_000,
        limit: 8
      }
    );
    expect(claims).toMatchObject([
      {
        ownerUserId: owner.id,
        artifactId: fixture.artifactId,
        operationKind: "registration",
        targetUpstreamId,
        mode: "hosted_personal",
        state: "in_flight",
        attempts: 1,
        artifact: {
          id: fixture.artifactId,
          replicaRole: "origin_local"
        },
        segment: null
      }
    ]);
    await repo.completeConversationSourceReplicationOutbox(
      { userId: owner.id },
      {
        outboxId: claims[0]!.id,
        leaseToken: claims[0]!.leaseToken!
      }
    );
    const segmentClaims = await repo.claimConversationSourceReplicationOutbox(
      { userId: owner.id },
      {
        workerId: "source-replication-claim-test",
        leaseMs: 180_000,
        limit: 8
      }
    );
    expect(segmentClaims).toMatchObject([
      {
        operationKind: "segment",
        segment: {
          segmentIndex: fixture.segmentIndex
        }
      }
    ]);
    await expect(
      repo.failConversationSourceReplicationOutbox(
        { userId: owner.id },
        {
          outboxId: segmentClaims[0]!.id,
          leaseToken: segmentClaims[0]!.leaseToken!,
          errorCode: "SourceReplicationGapError",
          retryAt: new Date(Date.now() + 60_000).toISOString()
        }
      )
    ).resolves.toMatchObject({
      state: "failed",
      lastErrorCode: "SourceReplicationGapError"
    });
  });

  it("publishes a finalized peer source for execution transfer without a Personal sync policy", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `source-transfer-publish-${randomUUID()}@example.com`
    });
    const targetUpstreamId = `up_${randomUUID().replaceAll("-", "")}`;
    await repo.upsertPersonalSourceReplicationPolicy(
      { userId: owner.id },
      {
        enabled: true,
        targetUpstreamId,
        mode: "hosted_personal",
        effectiveFrom: "2026-06-01T00:00:00.000Z"
      }
    );
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });
    await repo.finalizeConversationSourceArtifact(
      { userId: owner.id },
      {
        artifactId: fixture.artifactId,
        signedClosure: signConversationSourceClosureManifest(
          {
            protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
            sourceComponentSchemaVersion: 1,
            sourceComponentId: fixture.artifact.sourceComponentId,
            sourceComponentRole: fixture.artifact.sourceComponentRole,
            parentSourceComponentId: fixture.artifact.parentSourceComponentId,
            contentFraming: fixture.artifact.contentFraming,
            logicalSourceId: fixture.artifact.logicalSourceId,
            sourceGenerationId: fixture.artifact.sourceGenerationId,
            originKeyId: fixture.artifact.originKeyId,
            segmentCount: 1,
            endByteCursor: fixture.artifact.providerCursorOffset,
            endItemCursor: fixture.artifact.providerCursorLine,
            chainHeadDigest: fixture.segmentContentDigest,
            sourceRootDigest: calculateConversationSourceRootDigest([
              fixture.segmentContentDigest
            ]),
            sourceCreatedAt: fixture.artifact.sourceCreatedAt,
            closedAt: new Date().toISOString(),
            priorGenerationClosure: null
          },
          fixture.keys.privateKey
        )
      }
    );
    await repo.upsertPersonalSourceReplicationPolicy(
      { userId: owner.id },
      { enabled: false, mode: "hosted_personal" }
    );
    await pool.query(
      `update conversation_source_artifacts
          set replica_role = 'peer_personal'
        where owner_user_id = $1 and id = $2`,
      [owner.id, fixture.artifactId]
    );

    await expect(
      repo.enqueueConversationSourceArtifactReplication(
        { userId: owner.id },
        {
          artifactId: fixture.artifactId,
          targetUpstreamId,
          mode: "hosted_personal"
        }
      )
    ).resolves.toBe(3);
    await expect(
      repo.enqueueConversationSourceArtifactReplication(
        { userId: owner.id },
        {
          artifactId: fixture.artifactId,
          targetUpstreamId,
          mode: "hosted_personal"
        }
      )
    ).resolves.toBe(3);
    await expect(
      repo.listConversationSourceReplicationActors({
        direction: "upload",
        limit: 25
      })
    ).resolves.toContainEqual({ userId: owner.id });

    const claims = await repo.claimConversationSourceReplicationOutbox(
      { userId: owner.id },
      {
        workerId: "source-transfer-publish-test",
        leaseMs: 180_000,
        limit: 8
      }
    );
    expect(claims).toMatchObject([
      {
        operationKind: "registration",
        authorizationBasis: "execution_transfer",
        state: "in_flight",
        artifact: {
          id: fixture.artifactId,
          replicaRole: "peer_personal"
        }
      }
    ]);
    await repo.completeConversationSourceReplicationOutbox(
      { userId: owner.id },
      {
        outboxId: claims[0]!.id,
        leaseToken: claims[0]!.leaseToken!
      }
    );
    const segmentClaims = await repo.claimConversationSourceReplicationOutbox(
      { userId: owner.id },
      {
        workerId: "source-transfer-publish-test",
        leaseMs: 180_000,
        limit: 8
      }
    );
    expect(segmentClaims).toMatchObject([
      {
        operationKind: "segment",
        authorizationBasis: "execution_transfer",
        state: "in_flight",
        artifact: {
          id: fixture.artifactId,
          replicaRole: "peer_personal"
        }
      }
    ]);
    await repo.completeConversationSourceReplicationOutbox(
      { userId: owner.id },
      {
        outboxId: segmentClaims[0]!.id,
        leaseToken: segmentClaims[0]!.leaseToken!
      }
    );
    const closureClaims = await repo.claimConversationSourceReplicationOutbox(
      { userId: owner.id },
      {
        workerId: "source-transfer-publish-test",
        leaseMs: 180_000,
        limit: 8
      }
    );
    expect(closureClaims).toMatchObject([
      {
        operationKind: "closure",
        authorizationBasis: "execution_transfer",
        state: "in_flight",
        artifact: {
          id: fixture.artifactId,
          replicaRole: "peer_personal"
        }
      }
    ]);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count
           from conversation_source_replication_outbox
          where owner_user_id = $1
            and artifact_id = $2
            and target_upstream_id = $3`,
        [owner.id, fixture.artifactId, targetUpstreamId]
      )
    ).resolves.toMatchObject({ rows: [{ count: "3" }] });
  });

  it("publishes an active successor registration before any source payload", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `source-transfer-registration-${randomUUID()}@example.com`
    });
    const targetUpstreamId = `up_${randomUUID().replaceAll("-", "")}`;
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });

    await expect(
      repo.enqueueConversationSourceGenerationRegistration(
        { userId: owner.id },
        {
          artifactId: fixture.artifactId,
          targetUpstreamId,
          mode: "hosted_personal"
        }
      )
    ).resolves.toBe(true);
    await expect(
      repo.enqueueConversationSourceGenerationRegistration(
        { userId: owner.id },
        {
          artifactId: fixture.artifactId,
          targetUpstreamId,
          mode: "hosted_personal"
        }
      )
    ).resolves.toBe(true);

    const claims = await repo.claimConversationSourceReplicationOutbox(
      { userId: owner.id },
      {
        workerId: "source-transfer-registration-test",
        leaseMs: 180_000,
        limit: 8
      }
    );
    expect(claims).toMatchObject([
      {
        operationKind: "registration",
        segment: null,
        authorizationBasis: "execution_transfer",
        state: "in_flight",
        targetUpstreamId,
        artifact: {
          id: fixture.artifactId,
          lifecycle: "active",
          replicaRole: "origin_local"
        }
      }
    ]);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count
           from conversation_source_replication_outbox
          where owner_user_id = $1
            and artifact_id = $2
            and target_upstream_id = $3
            and operation_kind = 'registration'`,
        [owner.id, fixture.artifactId, targetUpstreamId]
      )
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("does not enqueue a source created before future-session sync consent", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `source-replication-future-only-${randomUUID()}@example.com`
    });
    await repo.upsertPersonalSourceReplicationPolicy(
      { userId: owner.id },
      {
        enabled: true,
        targetUpstreamId: `up_${randomUUID().replaceAll("-", "")}`,
        mode: "hosted_personal",
        effectiveFrom: "2026-07-02T00:00:00.000Z"
      }
    );

    await createJournalFixture(repo, { ownerId: owner.id });

    await expect(
      repo.listConversationSourceReplicationActors({
        direction: "upload",
        limit: 25
      })
    ).resolves.not.toContainEqual({ userId: owner.id });
  });

  it("advances canonical historical ingestion and source counters atomically", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `historical-batch-${randomUUID()}@example.com`
    });
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });
    const run = await repo.createHistoricalImportRun({ userId: owner.id });
    const source = await repo.createHistoricalImportSource(
      { userId: owner.id },
      {
        runId: run.id,
        artifactId: fixture.artifactId,
        aiClient: "codex",
        discoveredRecordCount: 2,
        detectedProject: {
          projectId: `/projects/${fixture.externalSessionId}`,
          name: "Historical Project"
        }
      }
    );
    await repo.transitionHistoricalImportRun(
      { userId: owner.id },
      { runId: run.id, expectedState: "discovered", state: "eligible" }
    );
    await repo.transitionHistoricalImportRun(
      { userId: owner.id },
      { runId: run.id, expectedState: "eligible", state: "queued" }
    );
    await repo.transitionHistoricalImportSource(
      { userId: owner.id },
      {
        sourceId: source!.id,
        expectedState: "discovered",
        state: "eligible"
      }
    );
    await repo.transitionHistoricalImportSource(
      { userId: owner.id },
      {
        sourceId: source!.id,
        expectedState: "eligible",
        state: "queued"
      }
    );

    const batch = {
      sourceId: source!.id,
      expectedSourceOffset: 0,
      sourceOffset: fixture.frontier,
      sourceLine: 2,
      segmentIndex: fixture.segmentIndex,
      lastVerifiedDigest: fixture.segmentDigest,
      items: [
        sourceItem({
          externalSessionId: fixture.externalSessionId,
          byteOffset: 64
        })
      ]
    };
    const result = await repo.ingestHistoricalImportBatch(
      { userId: owner.id },
      batch
    );
    expect(result.replayed).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.sessionId).toBe(fixture.sessionId);
    expect(result.source).toMatchObject({
      state: "importing",
      historicalCursorOffset: fixture.frontier,
      importedRecordCount: 1,
      rawIngested: true
    });
    const runDetail = await repo.getHistoricalImportRun(
      { userId: owner.id },
      run.id
    );
    expect(runDetail).toMatchObject({
      sourceCount: 1,
      discoveredRecordCount: 2,
      importedRecordCount: 1,
      scannedByteCount: fixture.frontier
    });
  });

  it("reports historical pending cost and a capacity-derived ETA range", async () => {
    const repo = createMemorySourceRepository(pool);
    const capacity = createEmbeddingCapacityRepository(pool);
    const owner = await repo.createUser({
      email: `historical-eta-${randomUUID()}@example.com`
    });
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });
    const run = await repo.createHistoricalImportRun({ userId: owner.id });
    const source = await repo.createHistoricalImportSource(
      { userId: owner.id },
      { runId: run.id, artifactId: fixture.artifactId, aiClient: "codex" }
    );
    await repo.transitionHistoricalImportRun(
      { userId: owner.id },
      { runId: run.id, expectedState: "discovered", state: "eligible" }
    );
    await repo.transitionHistoricalImportRun(
      { userId: owner.id },
      { runId: run.id, expectedState: "eligible", state: "queued" }
    );
    await repo.transitionHistoricalImportSource(
      { userId: owner.id },
      {
        sourceId: source!.id,
        expectedState: "discovered",
        state: "eligible"
      }
    );
    await repo.transitionHistoricalImportSource(
      { userId: owner.id },
      { sourceId: source!.id, expectedState: "eligible", state: "queued" }
    );
    const profileKey = createHash("sha256").update(randomUUID()).digest("hex");
    const capacityProfile: EmbeddingCapacityProfileInput = {
      poolKey: "test-pool",
      profileKey,
      profileVersion: "koed-embedding-capacity-v1",
      capacityContractRevision: "embedding-capacity-v1",
      state: "usable",
      calibrationMode: "refined",
      modelKey: "qwen3-0.6b",
      modelArtifactHash: "a".repeat(64),
      embeddingDimensions: 1024,
      tokenizer: "qwen3",
      inputTransform: "query-document-v1",
      pooling: "last-token",
      normalization: "l2",
      runtimeKind: "llama-server",
      runtimeVersion: "test",
      backendClass: "cpu",
      hardwareFingerprint: "b".repeat(64),
      settingsFingerprint: "c".repeat(64),
      runtimeSettings: {},
      sampleMeasurements: [],
      testedConcurrency: 1,
      sampleCount: 1,
      measuredTokenCount: 1_000,
      durationMs: 1_000,
      measuredTokensPerSecond: 1_000,
      p50LatencyMs: 100,
      p95LatencyMs: 100
    };
    await capacity.invalidateProfilesExcept(
      "test-pool",
      profileKey,
      "test_identity"
    );
    await capacity.replaceActiveProfile(capacityProfile, "test_replaced");
    const incompatibleProfileKey = createHash("sha256")
      .update(randomUUID())
      .digest("hex");
    await capacity.replaceActiveProfile(
      {
        ...capacityProfile,
        poolKey: "incompatible-pool",
        profileKey: incompatibleProfileKey,
        modelKey: "incompatible-model",
        embeddingDimensions: 384,
        measuredTokensPerSecond: 1_000_000
      },
      "incompatible_test_profile"
    );

    const imported = await repo.ingestHistoricalImportBatch(
      { userId: owner.id },
      {
        sourceId: source!.id,
        expectedSourceOffset: 0,
        sourceOffset: fixture.frontier,
        sourceLine: 3,
        segmentIndex: fixture.segmentIndex,
        lastVerifiedDigest: fixture.segmentDigest,
        items: [
          sourceItem({
            externalSessionId: fixture.externalSessionId,
            rawText: "Embedded historical event",
            byteOffset: 64
          }),
          sourceItem({
            externalSessionId: fixture.externalSessionId,
            rawText: "Pending historical event ".repeat(500),
            byteOffset: 96
          })
        ]
      }
    );
    expect(imported.items).toHaveLength(2);
    const itemRows = await pool.query<{ id: string }>(
      `select item.id
         from conversation_items item
         join conversation_item_observations observation
           on observation.conversation_item_id = item.id
        where item.session_id = $1
          and observation.source_transport = 'historical_import'
        order by item.created_at asc, item.id asc`,
      [fixture.sessionId]
    );
    expect(itemRows.rows).toHaveLength(2);
    const embeddedEvent = await repo.createMemoryEvent(
      { userId: owner.id },
      {
        sessionId: fixture.sessionId,
        projectId: "historical-capacity",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_turn",
        visibility: "personal",
        content: "Embedded historical event",
        sourceEventTime: "2026-01-01T00:00:00.000Z",
        sourceHash: digest(`historical-event:${fixture.externalSessionId}:1`),
        metadata: { rawConversationItemId: itemRows.rows[0]!.id }
      }
    );
    const pendingEvent = await repo.createMemoryEvent(
      { userId: owner.id },
      {
        sessionId: fixture.sessionId,
        projectId: "historical-capacity",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_turn",
        visibility: "personal",
        content: "Pending historical event ".repeat(500),
        sourceEventTime: "2026-01-02T00:00:00.000Z",
        sourceHash: digest(`historical-event:${fixture.externalSessionId}:2`),
        metadata: { rawConversationItemId: itemRows.rows[1]!.id }
      }
    );
    const embeddable = await repo.getEmbeddableSource(
      "memory_event",
      embeddedEvent.id
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
          vector: Array<number>(1024).fill(0.01),
          chunkIndex: 0,
          chunkCount: 1,
          inputTokenCount: 3_750,
          sourceText: "Embedded historical event"
        }
      ]
    });
    if (embeddedEvent.tokenCount == null || pendingEvent.tokenCount == null) {
      throw new Error("Expected historical Memory Event token estimates");
    }
    const eligibleEstimatedTokens =
      embeddedEvent.tokenCount + pendingEvent.tokenCount;
    const pendingEstimatedTokens = pendingEvent.tokenCount;

    const initialStatus = await repo.getHistoricalImportSource(
      { userId: owner.id },
      source!.id
    );
    expect(initialStatus).toMatchObject({
      embeddingEligibleEstimatedTokenCount: eligibleEstimatedTokens,
      embeddedMeasuredTokenCount: 3_750,
      pendingEmbeddingEstimatedTokenCount: pendingEstimatedTokens,
      embeddingQueueAheadEstimatedTokenCount: 0,
      embeddingEtaLowerSeconds: Math.ceil(pendingEstimatedTokens / 1_000),
      embeddingEtaUpperSeconds: Math.ceil(
        pendingEstimatedTokens / (1_000 * 0.6)
      ),
      embeddingEtaConfidence: "medium"
    });

    const liveFixture = await createJournalFixture(repo, {
      ownerId: owner.id
    });
    const liveEvent = await repo.createMemoryEvent(
      { userId: owner.id },
      {
        sessionId: liveFixture.sessionId,
        projectId: "live-capacity",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_turn",
        visibility: "personal",
        content: "Higher priority live event ".repeat(100),
        sourceHash: digest(`live-event:${liveFixture.externalSessionId}`),
        metadata: {}
      }
    );
    if (liveEvent.tokenCount == null) {
      throw new Error("Expected live Memory Event token estimate");
    }
    const liveEventTokenCount = liveEvent.tokenCount;
    const queuedStatus = await repo.getHistoricalImportSource(
      { userId: owner.id },
      source!.id
    );
    expect(queuedStatus?.embeddingQueueAheadEstimatedTokenCount).toBe(
      liveEventTokenCount
    );
    expect(queuedStatus?.embeddingEtaLowerSeconds).toBe(
      Math.ceil((pendingEstimatedTokens + liveEventTokenCount) / 1_000)
    );

    const liveEmbeddable = await repo.getEmbeddableSource(
      "memory_event",
      liveEvent.id
    );
    await repo.replaceSourceEmbeddings({
      source: liveEmbeddable!,
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
          vector: Array<number>(1024).fill(0.01),
          chunkIndex: 0,
          chunkCount: 1,
          inputTokenCount: liveEventTokenCount,
          sourceText: "Higher priority live event"
        }
      ]
    });
    await expect(
      repo.getHistoricalImportSource({ userId: owner.id }, source!.id)
    ).resolves.toMatchObject({
      embeddingQueueAheadEstimatedTokenCount: 0,
      embeddingEtaLowerSeconds: Math.ceil(pendingEstimatedTokens / 1_000)
    });

    await pool.query(
      "delete from embedding_capacity_profiles where profile_key = $1",
      [profileKey]
    );
    await expect(
      repo.getHistoricalImportSource({ userId: owner.id }, source!.id)
    ).resolves.toMatchObject({
      embeddingQueueAheadEstimatedTokenCount: 0,
      embeddingEtaConfidence: "conservative"
    });

    const futureLiveEvent = await repo.createMemoryEvent(
      { userId: owner.id },
      {
        sessionId: fixture.sessionId,
        projectId: "historical-capacity",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_turn",
        visibility: "personal",
        content: "Later live event in the same captured session",
        sourceEventTime: "2099-01-01T00:00:00.000Z",
        sourceHash: digest(`future-live:${fixture.externalSessionId}`),
        metadata: {}
      }
    );
    const futureLiveEmbeddable = await repo.getEmbeddableSource(
      "memory_event",
      futureLiveEvent.id
    );
    await repo.replaceSourceEmbeddings({
      source: futureLiveEmbeddable!,
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
          vector: Array<number>(1024).fill(0.01),
          chunkIndex: 0,
          chunkCount: 1,
          inputTokenCount: 9,
          sourceText: "Later live event in the same captured session"
        }
      ]
    });
    await expect(
      repo.getHistoricalImportSource({ userId: owner.id }, source!.id)
    ).resolves.toMatchObject({
      oldestEmbeddedSourceTime: "2026-01-01T00:00:00.000Z",
      newestEmbeddedSourceTime: "2026-01-01T00:00:00.000Z"
    });

    const pendingEmbeddable = await repo.getEmbeddableSource(
      "memory_event",
      pendingEvent.id
    );
    await repo.replaceSourceEmbeddings({
      source: pendingEmbeddable!,
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
          vector: Array<number>(1024).fill(0.01),
          chunkIndex: 0,
          chunkCount: 1,
          inputTokenCount: pendingEstimatedTokens,
          sourceText: "Pending historical event"
        }
      ]
    });
    await expect(
      repo.getHistoricalImportSource({ userId: owner.id }, source!.id)
    ).resolves.toMatchObject({
      pendingEmbeddingEstimatedTokenCount: 0,
      embeddingEtaLowerSeconds: 0,
      embeddingEtaUpperSeconds: 0,
      fullyEmbedded: true,
      newestEmbeddedSourceTime: "2026-01-02T00:00:00.000Z"
    });
  });

  it("completes ready historical sources and runs during worker reconciliation", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `historical-completion-${randomUUID()}@example.com`
    });
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });
    const run = await repo.createHistoricalImportRun({ userId: owner.id });
    const source = await repo.createHistoricalImportSource(
      { userId: owner.id },
      {
        runId: run.id,
        artifactId: fixture.artifactId,
        aiClient: "codex"
      }
    );
    for (const [expectedState, state] of [
      ["discovered", "eligible"],
      ["eligible", "queued"]
    ] as const) {
      await repo.transitionHistoricalImportRun(
        { userId: owner.id },
        { runId: run.id, expectedState, state }
      );
      await repo.transitionHistoricalImportSource(
        { userId: owner.id },
        { sourceId: source!.id, expectedState, state }
      );
    }
    await repo.transitionHistoricalImportRun(
      { userId: owner.id },
      { runId: run.id, expectedState: "queued", state: "importing" }
    );
    const rawOnly = {
      ...sourceItem({ externalSessionId: fixture.externalSessionId }),
      sourceEventType: "provider_internal_record",
      rawJson: { type: "provider_internal_record", retained: true },
      rawText: "",
      metadata: {
        transcriptByteOffset: 64,
        transcriptItemDiscriminator: "primary:provider_internal_record",
        transcriptType: "provider_internal_record",
        sourceEventTimeAccuracy: "source"
      }
    };
    await repo.ingestHistoricalImportBatch(
      { userId: owner.id },
      {
        sourceId: source!.id,
        expectedSourceOffset: 0,
        sourceOffset: fixture.frontier,
        sourceLine: 2,
        segmentIndex: fixture.segmentIndex,
        lastVerifiedDigest: fixture.segmentDigest,
        items: [rawOnly]
      }
    );
    await repo.projectPendingConversationItems(
      { userId: owner.id },
      { limit: 10 }
    );

    await expect(repo.reconcileHistoricalImportCompletion()).resolves.toEqual({
      sourcesCompleted: 1,
      runsCompleted: 1
    });
    await expect(
      repo.getHistoricalImportSource({ userId: owner.id }, source!.id)
    ).resolves.toMatchObject({ state: "completed", lcmComplete: true });
    await expect(
      repo.getHistoricalImportRun({ userId: owner.id }, run.id)
    ).resolves.toMatchObject({ state: "completed", completedSourceCount: 1 });
    await expect(repo.reconcileHistoricalImportCompletion()).resolves.toEqual({
      sourcesCompleted: 0,
      runsCompleted: 0
    });
  });

  it("replays an acknowledged batch without duplicate rows", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `historical-replay-${randomUUID()}@example.com`
    });
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });
    const run = await repo.createHistoricalImportRun({ userId: owner.id });
    const source = await repo.createHistoricalImportSource(
      { userId: owner.id },
      {
        runId: run.id,
        artifactId: fixture.artifactId,
        aiClient: "codex"
      }
    );
    for (const [expectedState, state] of [
      ["discovered", "eligible"],
      ["eligible", "queued"]
    ] as const) {
      await repo.transitionHistoricalImportRun(
        { userId: owner.id },
        { runId: run.id, expectedState, state }
      );
      await repo.transitionHistoricalImportSource(
        { userId: owner.id },
        { sourceId: source!.id, expectedState, state }
      );
    }
    const input = {
      sourceId: source!.id,
      expectedSourceOffset: 0,
      sourceOffset: fixture.frontier,
      sourceLine: 2,
      segmentIndex: fixture.segmentIndex,
      lastVerifiedDigest: fixture.segmentDigest,
      parserState: {
        currentTurnId: "turn-before-resume",
        rawTranscript: "must-not-be-presented"
      },
      items: [
        sourceItem({
          externalSessionId: fixture.externalSessionId,
          byteOffset: 64
        })
      ]
    };
    const first = await repo.ingestHistoricalImportBatch(
      { userId: owner.id },
      input
    );
    const replay = await repo.ingestHistoricalImportBatch(
      { userId: owner.id },
      input
    );
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, items: [] });
    const resumedSource = await repo.getHistoricalImportSourceByIdentity(
      { userId: owner.id },
      { artifactId: fixture.artifactId }
    );
    expect(resumedSource).toMatchObject({
      historicalCursorOffset: fixture.frontier,
      historicalCursorLine: 2,
      historicalCursorCurrentTurnId: "turn-before-resume"
    });
    expect(JSON.stringify(resumedSource)).not.toContain(
      "must-not-be-presented"
    );
    const stored = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from conversation_items
        where session_id = $1`,
      [fixture.sessionId]
    );
    expect(Number(stored.rows[0]?.count)).toBe(1);
  });

  it("fails closed on wrong segment, cursor, ownership, or Capture Policy", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `historical-security-${randomUUID()}@example.com`
    });
    const outsider = await repo.createUser({
      email: `historical-security-outsider-${randomUUID()}@example.com`
    });
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });
    const run = await repo.createHistoricalImportRun({ userId: owner.id });
    const source = await repo.createHistoricalImportSource(
      { userId: owner.id },
      {
        runId: run.id,
        artifactId: fixture.artifactId,
        aiClient: "codex"
      }
    );
    for (const [expectedState, state] of [
      ["discovered", "eligible"],
      ["eligible", "queued"]
    ] as const) {
      await repo.transitionHistoricalImportRun(
        { userId: owner.id },
        { runId: run.id, expectedState, state }
      );
      await repo.transitionHistoricalImportSource(
        { userId: owner.id },
        { sourceId: source!.id, expectedState, state }
      );
    }
    const input = {
      sourceId: source!.id,
      expectedSourceOffset: 0,
      sourceOffset: fixture.frontier,
      sourceLine: 2,
      segmentIndex: fixture.segmentIndex,
      lastVerifiedDigest: fixture.segmentDigest,
      items: [sourceItem({ externalSessionId: fixture.externalSessionId })]
    };
    await expect(
      repo.ingestHistoricalImportBatch({ userId: outsider.id }, input)
    ).rejects.toThrow("not found");
    await expect(
      repo.ingestHistoricalImportBatch(
        { userId: owner.id },
        { ...input, lastVerifiedDigest: digest("wrong") }
      )
    ).rejects.toThrow("segment verification");
    await expect(
      repo.ingestHistoricalImportBatch(
        { userId: owner.id },
        { ...input, sourceOffset: fixture.frontier + 1 }
      )
    ).rejects.toThrow("cursor conflict");

    await repo.upsertCapturePolicy(
      { userId: owner.id },
      {
        targetType: "global",
        captureState: "disabled",
        visibility: "personal"
      }
    );
    await expect(
      repo.ingestHistoricalImportBatch({ userId: owner.id }, input)
    ).rejects.toThrow("Capture Policy");
    const cursor = await repo.getConversationSourceConsumerCursor(
      { userId: owner.id },
      {
        artifactId: fixture.artifactId,
        consumerKind: "canonical_historical"
      }
    );
    expect(cursor).toBeNull();
  });

  it("advances consumer cursors only through exact owner-visible journal segments", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `journal-cursor-owner-${randomUUID()}@example.com`
    });
    const outsider = await repo.createUser({
      email: `journal-cursor-outsider-${randomUUID()}@example.com`
    });
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });
    const input = {
      artifactId: fixture.artifactId,
      consumerKind: "canonical_historical" as const,
      expectedSourceOffset: 0,
      sourceOffset: fixture.frontier,
      sourceLine: 2,
      segmentIndex: fixture.segmentIndex,
      lastVerifiedDigest: fixture.segmentDigest
    };

    await expect(
      repo.advanceConversationSourceConsumerCursor(
        { userId: outsider.id },
        input
      )
    ).rejects.toThrow("cursor conflict");
    await expect(
      repo.advanceConversationSourceConsumerCursor(
        { userId: owner.id },
        { ...input, lastVerifiedDigest: "0".repeat(64) }
      )
    ).rejects.toThrow("cursor conflict");
    await expect(
      repo.advanceConversationSourceConsumerCursor(
        { userId: owner.id },
        { ...input, segmentIndex: fixture.segmentIndex + 1 }
      )
    ).rejects.toThrow("cursor conflict");
    await expect(
      repo.advanceConversationSourceConsumerCursor(
        { userId: owner.id },
        { ...input, sourceLine: 3 }
      )
    ).rejects.toThrow("cursor conflict");

    await expect(
      repo.advanceConversationSourceConsumerCursor({ userId: owner.id }, input)
    ).resolves.toMatchObject({
      artifactId: fixture.artifactId,
      sourceOffset: fixture.frontier,
      sourceLine: 2,
      segmentIndex: fixture.segmentIndex,
      lastVerifiedDigest: fixture.segmentDigest
    });
  });

  it("resumes from a verified line boundary inside a sealed segment", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `journal-mid-segment-owner-${randomUUID()}@example.com`
    });
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });
    const firstCheckpoint = {
      artifactId: fixture.artifactId,
      consumerKind: "canonical_historical" as const,
      expectedSourceOffset: 0,
      sourceOffset: Math.floor(fixture.frontier / 2),
      sourceLine: 1,
      segmentIndex: fixture.segmentIndex,
      lastVerifiedDigest: fixture.segmentDigest
    };

    await expect(
      repo.advanceConversationSourceConsumerCursor(
        { userId: owner.id },
        firstCheckpoint
      )
    ).resolves.toMatchObject({
      sourceOffset: firstCheckpoint.sourceOffset,
      sourceLine: 1,
      segmentIndex: fixture.segmentIndex
    });

    await expect(
      repo.advanceConversationSourceConsumerCursor(
        { userId: owner.id },
        {
          ...firstCheckpoint,
          expectedSourceOffset: firstCheckpoint.sourceOffset,
          sourceOffset: fixture.frontier,
          sourceLine: 2
        }
      )
    ).resolves.toMatchObject({
      sourceOffset: fixture.frontier,
      sourceLine: 2,
      segmentIndex: fixture.segmentIndex
    });
  });

  it("converges historical and live observations onto one canonical item", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `historical-convergence-${randomUUID()}@example.com`
    });
    const fixture = await createJournalFixture(repo, { ownerId: owner.id });
    const canonical = sourceItem({
      externalSessionId: fixture.externalSessionId,
      byteOffset: 64
    });
    const live = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            ...canonical,
            sessionId: fixture.sessionId,
            sourceTransport: "transcript"
          }
        ]
      }
    );
    const run = await repo.createHistoricalImportRun({ userId: owner.id });
    const source = await repo.createHistoricalImportSource(
      { userId: owner.id },
      {
        runId: run.id,
        artifactId: fixture.artifactId,
        aiClient: "codex"
      }
    );
    for (const [expectedState, state] of [
      ["discovered", "eligible"],
      ["eligible", "queued"]
    ] as const) {
      await repo.transitionHistoricalImportRun(
        { userId: owner.id },
        { runId: run.id, expectedState, state }
      );
      await repo.transitionHistoricalImportSource(
        { userId: owner.id },
        { sourceId: source!.id, expectedState, state }
      );
    }
    const imported = await repo.ingestHistoricalImportBatch(
      { userId: owner.id },
      {
        sourceId: source!.id,
        expectedSourceOffset: 0,
        sourceOffset: fixture.frontier,
        sourceLine: 2,
        segmentIndex: fixture.segmentIndex,
        lastVerifiedDigest: fixture.segmentDigest,
        items: [canonical]
      }
    );
    expect(imported.items[0]?.id).toBe(live[0]?.id);
    const observations = await pool.query<{ source_transport: string }>(
      `select source_transport
         from conversation_item_observations
        where conversation_item_id = $1
        order by source_transport`,
      [live[0]!.id]
    );
    expect(observations.rows.map((row) => row.source_transport)).toEqual([
      "historical_import",
      "transcript"
    ]);
  });
});
