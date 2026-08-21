import { randomBytes, randomUUID, createHash, createHmac } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  allPrivacyLabelsPolicy,
  createLocalTestKeyEnvelopeEncryptionProvider,
  noPrivacyLabelsPolicy,
  privacyClassifierHash,
  privacyContentPolicyHash,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type PrivacyClassificationResponse,
  type PrivacyLabelPolicy
} from "@koed/shared";
import {
  createPrivacyClassificationRepository,
  ownerScopedPrivacyContentFingerprint,
  PrivacyClassificationMismatchError,
  privacySourceFrontierHash,
  resolveMonotonicPrivacyPolicySet,
  type PrivacyClassifierGenerationRecord,
  type PrivacyContentPolicyRecord
} from "./privacy-classification-repository.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherOwnerId = "22222222-2222-4222-8222-222222222222";
const generationId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-08-12T10:00:00.000Z");
const fingerprintKey = "privacy-fingerprint-test-key-material-0001";

const generationComponents = {
  version: 1,
  modelKey: "openai-privacy-filter",
  modelRevision: "2026-08-01",
  artifactSha256: "a".repeat(64),
  tokenizerSha256: "b".repeat(64),
  decoderSha256: "c".repeat(64),
  calibrationSha256: "d".repeat(64),
  deterministicDetectorVersion: "structured-secrets-v1"
};

const classifierHash = privacyClassifierHash(generationComponents);

const classifierRow = (): Record<string, unknown> => ({
  id: generationId,
  version: 1,
  classifier_hash: classifierHash,
  model_key: generationComponents.modelKey,
  model_revision: generationComponents.modelRevision,
  artifact_sha256: generationComponents.artifactSha256,
  tokenizer_sha256: generationComponents.tokenizerSha256,
  decoder_sha256: generationComponents.decoderSha256,
  calibration_sha256: generationComponents.calibrationSha256,
  deterministic_detector_version:
    generationComponents.deterministicDetectorVersion,
  input_contract_version: "koed-privacy-classification-v1",
  status: "active",
  created_at: now,
  activated_at: now,
  retired_at: null,
  revoked_at: null,
  revocation_reason_code: null
});

const responseFor = (
  fields: Array<{ path: string; text: string }>
): PrivacyClassificationResponse => ({
  schemaVersion: 1,
  inputContractVersion: "koed-privacy-classification-v1",
  classifier: {
    classifierHash,
    modelKey: generationComponents.modelKey,
    modelRevision: generationComponents.modelRevision
  },
  fields: fields.map((field) => ({
    path: field.path,
    inputSha256: createHash("sha256").update(field.text).digest("hex"),
    inputByteLength: Buffer.byteLength(field.text),
    maskedText: field.text.replace("alice@example.test", "******************"),
    decodedTextMatchesInput: true,
    spans: field.text.includes("alice@example.test")
      ? [
          {
            label: "private_email" as const,
            startByte: Buffer.byteLength(
              field.text.split("alice@example.test")[0]!
            ),
            endByte:
              Buffer.byteLength(field.text.split("alice@example.test")[0]!) +
              Buffer.byteLength("alice@example.test"),
            detectors: ["privacy_filter" as const, "deterministic" as const]
          }
        ]
      : []
  }))
});

class PrivacyMemoryPool {
  result: Record<string, unknown> | null = null;
  encrypted: Record<string, unknown> | null = null;
  lastReadySql: string | null = null;
  lastReadyValues: unknown[] | null = null;

  async connect(): Promise<pg.PoolClient> {
    return {
      query: this.query.bind(this),
      release: () => undefined
    } as unknown as pg.PoolClient;
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    const sql = text.replace(/\s+/g, " ").trim();
    let rows: Record<string, unknown>[] = [];

    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return { rows: [], rowCount: null } as unknown as pg.QueryResult<T>;
    }
    if (
      sql.includes("from privacy_classifier_generations") &&
      sql.includes("for share")
    ) {
      rows = values[0] === classifierHash ? [classifierRow()] : [];
    } else if (
      sql.includes("from privacy_classification_results r") &&
      sql.includes("where r.id=$1")
    ) {
      rows =
        this.result &&
        this.result.id === values[0] &&
        this.result.owner_user_id === values[1] &&
        this.result.status === "ready" &&
        this.result.invalidated_at === null
          ? [this.result]
          : [];
    } else if (
      sql.includes("from privacy_classification_results r") &&
      sql.includes("and r.owner_content_fingerprint = $3")
    ) {
      rows =
        this.result &&
        this.result.status === "ready" &&
        this.result.invalidated_at === null &&
        this.result.owner_user_id === values[0] &&
        this.result.classifier_hash === values[1] &&
        this.result.owner_content_fingerprint === values[2]
          ? [this.result]
          : [];
    } else if (sql.startsWith("insert into privacy_classification_results")) {
      if (!this.result || this.result.invalidated_at !== null) {
        this.result = {
          id: values[0],
          owner_user_id: values[1],
          classifier_generation_id: values[2],
          classifier_hash: values[3],
          owner_content_fingerprint: values[4],
          input_byte_length: values[5],
          payload_binding_hash: null,
          span_count: null,
          status: "pending",
          failure_code: null,
          created_at: now,
          ready_at: null,
          invalidated_at: null,
          invalidation_reason_code: null
        };
        rows = [this.result];
      }
    } else if (sql.startsWith("insert into encrypted_field_payloads")) {
      this.encrypted = {
        id: randomUUID(),
        owner_user_id: values[0],
        owner_principal_id: values[1],
        team_id: values[2],
        team_workspace_id: values[3],
        visibility: values[4],
        encryption_scope: values[5],
        source_table: values[6],
        source_id: values[7],
        source_column: values[8],
        plaintext_content_type: values[9],
        plaintext_encoding: values[10],
        envelope_version: values[11],
        provider_mode: values[12],
        key_id: values[13],
        key_version: values[14],
        scope: JSON.parse(String(values[15])),
        provenance: JSON.parse(String(values[16])),
        algorithm: values[17],
        ciphertext: values[18],
        nonce: values[19],
        tag: values[20],
        wrapped_dek: JSON.parse(String(values[21])),
        ciphertext_location: values[22],
        aad: JSON.parse(String(values[23])),
        envelope_created_at: new Date(String(values[24])),
        envelope_reencrypted_at: values[25],
        created_at: now,
        updated_at: now
      };
      rows = [this.encrypted];
    } else if (
      sql.startsWith("update privacy_classification_results") &&
      sql.includes("status='ready'")
    ) {
      this.lastReadySql = sql;
      this.lastReadyValues = values;
      const current = this.result;
      if (current && current.id === values[0] && current.status === "pending") {
        this.result = {
          ...current,
          status: "ready",
          payload_binding_hash: values[1],
          span_count: sql.includes("span_count=0") ? 0 : values[2],
          ready_at: now
        };
        rows = [this.result];
      }
    } else if (sql.includes("from encrypted_field_payloads")) {
      rows =
        this.encrypted &&
        this.encrypted.owner_user_id === values[0] &&
        this.encrypted.source_table === values[1] &&
        this.encrypted.source_id === values[2] &&
        this.encrypted.source_column === values[3]
          ? [this.encrypted]
          : [];
    } else if (
      sql.startsWith("update privacy_classification_results") &&
      sql.includes("status='invalidated'")
    ) {
      const current = this.result;
      if (
        current &&
        current.id === values[0] &&
        current.owner_user_id === values[1] &&
        current.invalidated_at === null
      ) {
        this.result = {
          ...current,
          status: "invalidated",
          invalidated_at: now,
          invalidation_reason_code: values[2]
        };
        rows = [{ id: this.result.id }];
      }
    } else if (
      sql.startsWith("update encrypted_field_payloads") &&
      this.encrypted
    ) {
      this.encrypted = {
        ...this.encrypted,
        invalidated_at: now,
        invalidation_reason: values[3]
      };
    } else {
      throw new Error(`Unexpected test SQL: ${sql}`);
    }

    return {
      rows: rows as T[],
      rowCount: rows.length
    } as unknown as pg.QueryResult<T>;
  }
}

const policyRecord = (
  scope: PrivacyContentPolicyRecord["scope"],
  labels: PrivacyLabelPolicy,
  version: number
): PrivacyContentPolicyRecord => ({
  id: randomUUID(),
  policyId: randomUUID(),
  version,
  scope,
  deploymentIdentityId: "44444444-4444-4444-8444-444444444444",
  sourceOwnerUserId:
    scope === "source_owner" ? "55555555-5555-4555-8555-555555555555" : null,
  teamId:
    scope === "team" || scope === "workspace"
      ? "66666666-6666-4666-8666-666666666666"
      : null,
  teamWorkspaceId:
    scope === "workspace" ? "77777777-7777-4777-8777-777777777777" : null,
  labels,
  replacementContractVersion: "koed-privacy-typed-placeholders-v1",
  policyHash: privacyContentPolicyHash({ labels }),
  status: "active",
  effectiveAt: now.toISOString(),
  createdAt: now.toISOString(),
  supersededAt: null,
  revokedAt: null,
  revocationReasonCode: null
});

const canonicalTestJson = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)])
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
};

const testKeyedHash = (
  domain: string,
  valueOwnerId: string,
  value: unknown
): string => {
  const hmac = createHmac("sha256", Buffer.from(fingerprintKey, "utf8"));
  hmac.update(`koed:${domain}:v1\0${valueOwnerId}\0`, "utf8");
  hmac.update(canonicalTestJson(value));
  return hmac.digest("hex");
};

const grantReadDeploymentPolicy = policyRecord(
  "deployment",
  allPrivacyLabelsPolicy(),
  1
);

const policyRow = (): Record<string, unknown> => {
  const policy = grantReadDeploymentPolicy;
  return {
    id: policy.id,
    policy_id: policy.policyId,
    version: policy.version,
    scope: policy.scope,
    deployment_identity_id: policy.deploymentIdentityId,
    source_owner_user_id: null,
    team_id: null,
    team_workspace_id: null,
    labels: policy.labels,
    replacement_contract_version: policy.replacementContractVersion,
    policy_hash: policy.policyHash,
    status: policy.status,
    effective_at: policy.effectiveAt,
    created_at: policy.createdAt,
    superseded_at: null,
    revoked_at: null,
    revocation_reason_code: null
  };
};

const effectiveDeploymentPolicyHash = (): string =>
  resolveMonotonicPrivacyPolicySet([grantReadDeploymentPolicy])
    .effectivePolicyHash;

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sanitizedArtifactId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sourceArtifactId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const chunkIds = [
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  "ffffffff-ffff-4fff-8fff-ffffffffffff"
] as const;
const shareGrantId = "88888888-8888-4888-8888-888888888888";

const encryptedFieldRow = (
  envelope: EncryptedPayloadEnvelope,
  sourceId: string,
  sourceColumn: string,
  plaintextContentType = "text/plain"
): Record<string, unknown> => ({
  id: randomUUID(),
  owner_user_id: ownerId,
  owner_principal_id: null,
  team_id: teamId,
  team_workspace_id: workspaceId,
  visibility: "personal",
  encryption_scope: "team",
  source_table: "privacy_sanitized_source_chunks",
  source_id: sourceId,
  source_column: sourceColumn,
  plaintext_content_type: plaintextContentType,
  plaintext_encoding: "utf8",
  envelope_version: envelope.version,
  provider_mode: envelope.providerMode,
  key_id: envelope.keyId,
  key_version: envelope.keyVersion,
  scope: envelope.scope,
  provenance: envelope.provenance,
  algorithm: envelope.algorithm,
  ciphertext: envelope.ciphertext,
  nonce: envelope.nonce,
  tag: envelope.tag,
  wrapped_dek: envelope.wrappedDek,
  ciphertext_location: envelope.ciphertextLocation,
  aad: envelope.aad,
  envelope_created_at: new Date(envelope.createdAt),
  envelope_reencrypted_at: envelope.reencryptedAt
    ? new Date(envelope.reencryptedAt)
    : null,
  created_at: now,
  updated_at: now
});

const grantReadFixture = async (
  options: {
    authorized?: boolean;
    activeClassifier?: boolean;
    currentPolicy?: boolean;
    currentArtifact?: boolean;
  } = {}
) => {
  const realProvider = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64")
  );
  const provider: EnvelopeEncryptionProvider = {
    ...realProvider,
    decrypt: vi.fn(realProvider.decrypt.bind(realProvider))
  };
  const texts = ["first sanitized record\n", "second sanitized record\n"];
  const chunks = await Promise.all(
    texts.map(async (text, chunkIndex) => {
      const id = chunkIds[chunkIndex]!;
      const classificationResultId = randomUUID();
      const ownerChunkFingerprint = testKeyedHash(
        "privacy-sanitized-chunk",
        ownerId,
        { chunkIndex, text }
      );
      const sourceStartByte = chunkIndex * 100;
      const sourceEndByte = sourceStartByte + 100;
      const sanitizedByteLength = Buffer.byteLength(text);
      const payloadBindingHash = testKeyedHash(
        "privacy-sanitized-chunk-binding",
        ownerId,
        {
          artifactId: sanitizedArtifactId,
          id,
          chunkIndex,
          classificationResultId,
          sourceStartByte,
          sourceEndByte,
          sanitizedByteLength,
          ownerChunkFingerprint,
          text
        }
      );
      const envelope = await realProvider.encrypt({
        plaintext: text,
        scope: {
          teamId,
          workspaceId,
          objectClass: "privacy_sanitized_source_chunk"
        },
        provenance: {
          rowFamily: "privacy_sanitized_source_chunks",
          sourceTable: "privacy_sanitized_source_chunks",
          sourceId: id,
          sourceColumn: "sanitized_text"
        },
        ciphertextLocation: "encrypted_field_payloads",
        aad: {
          encryptionScope: "team",
          teamId,
          teamWorkspaceId: workspaceId,
          sourceTable: "privacy_sanitized_source_chunks",
          sourceId: id,
          sourceColumn: "sanitized_text"
        }
      });
      return {
        row: {
          id,
          artifact_id: sanitizedArtifactId,
          classification_result_id: classificationResultId,
          chunk_index: chunkIndex,
          source_start_byte: sourceStartByte,
          source_end_byte: sourceEndByte,
          sanitized_byte_length: sanitizedByteLength,
          owner_chunk_fingerprint: ownerChunkFingerprint,
          payload_binding_hash: payloadBindingHash
        },
        encrypted: encryptedFieldRow(envelope, id, "sanitized_text")
      };
    })
  );
  const metadataBindingHash = "9".repeat(64);
  const ownerManifestFingerprint = "8".repeat(64);
  const artifactBindingHash = testKeyedHash(
    "privacy-sanitized-artifact",
    ownerId,
    {
      artifactId: sanitizedArtifactId,
      ownerManifestFingerprint,
      metadataBindingHash,
      chunkBindings: chunks.map((chunk) => chunk.row.payload_binding_hash)
    }
  );
  const artifactRow = {
    id: sanitizedArtifactId,
    share_grant_id: shareGrantId,
    source_artifact_id: sourceArtifactId,
    owner_user_id: ownerId,
    team_id: teamId,
    team_workspace_id: workspaceId,
    classifier_generation_id: generationId,
    classifier_hash: classifierHash,
    effective_policy_hash: effectiveDeploymentPolicyHash(),
    source_frontier_hash: "7".repeat(64),
    source_frontier_cursor: 200,
    source_segment_count: 2,
    source_closure_hash: null,
    owner_manifest_fingerprint: ownerManifestFingerprint,
    metadata_binding_hash: metadataBindingHash,
    artifact_binding_hash: artifactBindingHash,
    chunk_count: chunks.length,
    sanitized_byte_count: chunks.reduce(
      (sum, chunk) => sum + Number(chunk.row.sanitized_byte_length),
      0
    ),
    format: "codex_sanitized_ndjson",
    format_version: 1,
    status: "ready",
    failure_code: null,
    created_at: now,
    ready_at: now,
    invalidated_at: null,
    invalidation_reason_code: null
  };
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const query = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<pg.QueryResult<T>> => {
    const sql = text.replace(/\s+/g, " ").trim();
    queries.push({ sql, values });
    let rows: Record<string, unknown>[] = [];
    if (sql.startsWith("select source_grant.owner_user_id")) {
      rows =
        options.authorized === false
          ? []
          : [
              {
                owner_user_id: ownerId,
                team_id: teamId,
                team_workspace_id: workspaceId
              }
            ];
    } else if (sql.includes("from privacy_classifier_generations")) {
      rows = options.activeClassifier === false ? [] : [classifierRow()];
    } else if (sql.includes("from privacy_content_policies policy")) {
      rows = options.currentPolicy === false ? [] : [policyRow()];
    } else if (sql.includes("from privacy_sanitized_source_artifacts a")) {
      const requestedId = values[4];
      rows =
        options.currentArtifact === false ||
        (requestedId !== null && requestedId !== sanitizedArtifactId)
          ? []
          : [artifactRow];
    } else if (sql.includes("from privacy_sanitized_source_chunks")) {
      rows = chunks.map((chunk) => chunk.row);
    } else if (sql.includes("from encrypted_field_payloads")) {
      rows = chunks
        .filter((chunk) => chunk.row.id === values[3])
        .map((chunk) => chunk.encrypted);
    }
    return {
      rows: rows as T[],
      rowCount: rows.length
    } as unknown as pg.QueryResult<T>;
  };
  const pool = {
    query,
    async connect() {
      return { query, release: () => undefined } as unknown as pg.PoolClient;
    }
  } as unknown as pg.Pool;
  return {
    provider,
    queries,
    repository: createPrivacyClassificationRepository(pool, { fingerprintKey })
  };
};

describe("privacy classification repository", () => {
  it("does not expose a globally correlatable content fingerprint", () => {
    const text = "same sensitive content";
    const first = ownerScopedPrivacyContentFingerprint({
      fingerprintKey,
      ownerUserId: ownerId,
      text
    });
    const second = ownerScopedPrivacyContentFingerprint({
      fingerprintKey,
      ownerUserId: otherOwnerId,
      text
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toBe(createHash("sha256").update(text).digest("hex"));
  });

  it("binds continuous source material to a committed frontier without a closure", () => {
    const openFrontier = privacySourceFrontierHash({
      sourceArtifactId: "88888888-8888-4888-8888-888888888888",
      sourceFrontierCursor: 2048,
      sourceSegmentCount: 3,
      headContentDigest: "e".repeat(64)
    });
    const advancedFrontier = privacySourceFrontierHash({
      sourceArtifactId: "88888888-8888-4888-8888-888888888888",
      sourceFrontierCursor: 4096,
      sourceSegmentCount: 4,
      headContentDigest: "f".repeat(64)
    });

    expect(openFrontier).toMatch(/^[a-f0-9]{64}$/);
    expect(openFrontier).not.toBe(advancedFrontier);
  });

  it("resolves all policy scopes as a monotonic union", () => {
    const deployment = noPrivacyLabelsPolicy();
    deployment.secret = true;
    const owner = noPrivacyLabelsPolicy();
    owner.private_email = true;
    const team = noPrivacyLabelsPolicy();
    team.private_phone = true;
    const workspace = noPrivacyLabelsPolicy();
    workspace.private_person = true;

    const effective = resolveMonotonicPrivacyPolicySet([
      policyRecord("workspace", workspace, 4),
      policyRecord("deployment", deployment, 1),
      policyRecord("team", team, 3),
      policyRecord("source_owner", owner, 2)
    ]);

    expect(effective.labels).toMatchObject({
      secret: true,
      private_email: true,
      private_phone: true,
      private_person: true,
      private_address: false
    });
    expect(effective.policies.map((policy) => policy.scope)).toEqual([
      "deployment",
      "source_owner",
      "team",
      "workspace"
    ]);
    expect(effective.effectivePolicyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when a stored policy hash does not bind its labels", () => {
    const policy = policyRecord("deployment", allPrivacyLabelsPolicy(), 1);
    expect(() =>
      resolveMonotonicPrivacyPolicySet([
        { ...policy, policyHash: "0".repeat(64) }
      ])
    ).toThrow(PrivacyClassificationMismatchError);
  });

  it("stores and reads encrypted results, caches them, invalidates them, and rejects source mismatch", async () => {
    const pool = new PrivacyMemoryPool();
    const repository = createPrivacyClassificationRepository(
      pool as unknown as pg.Pool,
      { fingerprintKey }
    );
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
    const fields = [
      { path: "$.message.content", text: "Email alice@example.test today" }
    ];

    await expect(
      repository.findCachedClassification({
        actor: { userId: ownerId },
        classifierHash,
        fields
      })
    ).resolves.toBeNull();

    const stored = await repository.storeClassificationResult({
      actor: { userId: ownerId },
      provider,
      fields,
      response: responseFor(fields)
    });
    expect(stored).toMatchObject({ status: "ready", spanCount: 1 });
    expect(pool.result).not.toHaveProperty("spans");
    expect(pool.encrypted?.ciphertext).not.toContain("alice@example.test");

    await expect(
      repository.findCachedClassification({
        actor: { userId: ownerId },
        classifierHash,
        fields
      })
    ).resolves.toMatchObject({ id: stored.id, status: "ready" });

    await expect(
      repository.readClassificationResult({
        actor: { userId: ownerId },
        provider,
        resultId: stored.id,
        expectedFields: fields
      })
    ).resolves.toMatchObject({
      fields: [
        { path: "$.message.content", spans: [{ label: "private_email" }] }
      ]
    });

    await expect(
      repository.readClassificationResult({
        actor: { userId: ownerId },
        provider,
        resultId: stored.id,
        expectedFields: [{ ...fields[0]!, text: "different source" }]
      })
    ).rejects.toThrow(PrivacyClassificationMismatchError);

    await expect(
      repository.invalidateClassificationResult({
        actor: { userId: ownerId },
        resultId: stored.id,
        reasonCode: "policy_generation_revoked"
      })
    ).resolves.toBe(true);
    await expect(
      repository.findCachedClassification({
        actor: { userId: ownerId },
        classifierHash,
        fields
      })
    ).resolves.toBeNull();
  });

  it("rejects classifier component/hash drift before persistence", async () => {
    const repository = createPrivacyClassificationRepository(
      new PrivacyMemoryPool() as unknown as pg.Pool,
      { fingerprintKey }
    );
    await expect(
      repository.registerClassifierGeneration({
        ...generationComponents,
        classifierHash: "f".repeat(64)
      })
    ).rejects.toThrow(PrivacyClassificationMismatchError);
  });

  it("creates a cached encrypted binding for structural-only source", async () => {
    const pool = new PrivacyMemoryPool();
    const repository = createPrivacyClassificationRepository(
      pool as unknown as pg.Pool,
      { fingerprintKey }
    );
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );

    const first = await repository.getOrCreateStructuralClassificationBinding({
      actor: { userId: ownerId },
      provider,
      classifierHash
    });
    const replay = await repository.getOrCreateStructuralClassificationBinding({
      actor: { userId: ownerId },
      provider,
      classifierHash
    });

    expect(first).toMatchObject({ status: "ready", spanCount: 0 });
    expect(replay.id).toBe(first.id);
    expect(pool.lastReadySql).toContain("owner_user_id=$3");
    expect(pool.lastReadyValues).toEqual([
      first.id,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      ownerId
    ]);
    await expect(
      repository.readClassificationResult({
        actor: { userId: ownerId },
        provider,
        resultId: first.id,
        expectedClassifierHash: classifierHash
      })
    ).resolves.toMatchObject({ fields: [] });
  });

  it("scopes ready sanitized lookup to a current active source grant", async () => {
    const queries: string[] = [];
    const pool = {
      async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
        text: string
      ) {
        queries.push(text.replace(/\s+/g, " ").trim());
        return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
      }
    } as unknown as pg.Pool;
    const repository = createPrivacyClassificationRepository(pool, {
      fingerprintKey
    });

    await expect(
      repository.findReadySanitizedSourceArtifact({
        actor: { userId: ownerId },
        shareGrantId: "88888888-8888-4888-8888-888888888888",
        sourceArtifactId: "99999999-9999-4999-8999-999999999999",
        teamId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        teamWorkspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        classifierHash,
        effectivePolicyHash: "e".repeat(64),
        sourceFrontierHash: "f".repeat(64)
      })
    ).resolves.toBeNull();

    expect(queries[0]).toContain("join team_conversation_source_grants");
    expect(queries[0]).toContain("share_grant.lifecycle='active'");
    expect(queries[0]).toContain("consent.state='active'");
    expect(queries[0]).toContain("membership.status='enabled'");
    expect(queries[0]).toContain("workspace_access.access in ('read','write')");
    expect(queries[0]).toContain("source_grant.mode='snapshot'");
    expect(queries[0]).toContain("source_grant.mode='continuous'");
    expect(queries[0]).toContain("candidate.source_component_id='main'");
    expect(queries[0]).toContain("candidate.source_component_role='primary'");
    expect(queries[0]).toContain("candidate.lifecycle='finalized'");
  });

  it("selects only supported finalized primary source targets", async () => {
    const queries: string[] = [];
    const pool = {
      async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
        text: string
      ) {
        queries.push(text.replace(/\s+/g, " ").trim());
        return { rows: [], rowCount: 0 } as unknown as pg.QueryResult<T>;
      }
    } as unknown as pg.Pool;
    const repository = createPrivacyClassificationRepository(pool, {
      fingerprintKey
    });

    await expect(
      repository.listSourceMaterializationTargets({ limit: 10 })
    ).resolves.toEqual([]);

    expect(queries[0]).toContain("candidate.source_component_id='main'");
    expect(queries[0]).toContain("candidate.source_component_role='primary'");
    expect(queries[0]).toContain("candidate.lifecycle='finalized'");
    expect(queries[0]).toContain("supported.source_kind=candidate.source_kind");
  });

  it("reads a current grant-scoped manifest without decrypting chunk content", async () => {
    const state = await grantReadFixture();

    await expect(
      state.repository.readLatestSanitizedSourceManifestByGrant({
        actor: { userId: otherOwnerId },
        shareGrantId
      })
    ).resolves.toMatchObject({
      record: { id: sanitizedArtifactId, status: "ready" },
      chunks: [
        { id: chunkIds[0], chunkIndex: 0 },
        { id: chunkIds[1], chunkIndex: 1 }
      ]
    });

    expect(state.provider.decrypt).not.toHaveBeenCalled();
    expect(state.queries[1]?.sql).toBe(
      "set transaction isolation level repeatable read"
    );
    const accessSql = state.queries.find(({ sql }) =>
      sql.startsWith("select source_grant.owner_user_id")
    )?.sql;
    expect(accessSql).toContain("source_grant.lifecycle='active'");
    expect(accessSql).toContain("source_grant.revoked_at is null");
    expect(accessSql).toContain("share_grant.lifecycle='active'");
    expect(accessSql).toContain("share_grant.revoked_at is null");
    expect(accessSql).toContain("share_grant.personal_deleted_at is null");
    expect(accessSql).toContain("consent.expires_at > now()");
    expect(accessSql).toContain("membership.status='enabled'");
    expect(accessSql).toContain("workspace_access.access in ('read','write')");
    const artifactSql = state.queries.find(({ sql }) =>
      sql.includes("from privacy_sanitized_source_artifacts a")
    )?.sql;
    expect(artifactSql).toContain("source_grant.mode='snapshot'");
    expect(artifactSql).toContain(
      "a.source_frontier_cursor=source_grant.maximum_source_offset"
    );
    expect(artifactSql).toContain(
      "a.source_segment_count=source_grant.maximum_segment_index + 1"
    );
    expect(artifactSql).toContain("source_grant.mode='continuous'");
    expect(artifactSql).toContain(
      "candidate.logical_source_id=source_grant.logical_source_id"
    );
    expect(artifactSql).toContain("candidate.source_component_id='main'");
    expect(artifactSql).toContain("candidate.source_component_role='primary'");
    expect(artifactSql).toContain("candidate.lifecycle='finalized'");
    expect(artifactSql).toContain(
      "order by candidate.source_created_at desc, candidate.id desc"
    );
  });

  it("fails closed for unauthorized, revoked, inactive-policy, and stale artifact reads", async () => {
    for (const options of [
      { authorized: false },
      { activeClassifier: false },
      { currentPolicy: false },
      { currentArtifact: false }
    ]) {
      const state = await grantReadFixture(options);
      await expect(
        state.repository.readLatestSanitizedSourceManifestByGrant({
          actor: { userId: otherOwnerId },
          shareGrantId
        })
      ).resolves.toBeNull();
      expect(state.provider.decrypt).not.toHaveBeenCalled();
    }
  });

  it("decrypts exactly one chunk after exact grant, artifact, and chunk binding", async () => {
    const state = await grantReadFixture();

    await expect(
      state.repository.readSanitizedSourceChunkByGrant({
        actor: { userId: otherOwnerId },
        provider: state.provider,
        shareGrantId,
        sanitizedArtifactId,
        chunkId: chunkIds[1]
      })
    ).resolves.toMatchObject({
      artifact: { id: sanitizedArtifactId },
      chunk: {
        record: { id: chunkIds[1], chunkIndex: 1 },
        text: "second sanitized record\n"
      }
    });
    expect(state.provider.decrypt).toHaveBeenCalledTimes(1);

    const encryptedLookup = state.queries.find(({ sql }) =>
      sql.includes("from encrypted_field_payloads")
    );
    expect(encryptedLookup?.values[3]).toBe(chunkIds[1]);
  });

  it("does not decrypt arbitrary or stale artifact/chunk identifiers", async () => {
    const staleArtifact = await grantReadFixture();
    await expect(
      staleArtifact.repository.readSanitizedSourceChunkByGrant({
        actor: { userId: otherOwnerId },
        provider: staleArtifact.provider,
        shareGrantId,
        sanitizedArtifactId: randomUUID(),
        chunkId: chunkIds[0]
      })
    ).resolves.toBeNull();
    expect(staleArtifact.provider.decrypt).not.toHaveBeenCalled();

    const arbitraryChunk = await grantReadFixture();
    await expect(
      arbitraryChunk.repository.readSanitizedSourceChunkByGrant({
        actor: { userId: otherOwnerId },
        provider: arbitraryChunk.provider,
        shareGrantId,
        sanitizedArtifactId,
        chunkId: randomUUID()
      })
    ).resolves.toBeNull();
    expect(arbitraryChunk.provider.decrypt).not.toHaveBeenCalled();
  });

  it("notifies the source grant after READY is stored in the committing transaction", async () => {
    const queryLog: Array<{ sql: string; values: unknown[] }> = [];
    const classificationResultId = randomUUID();
    const headContentDigest = "6".repeat(64);
    const sourceFrontierHash = privacySourceFrontierHash({
      sourceArtifactId,
      sourceFrontierCursor: 100,
      sourceSegmentCount: 1,
      headContentDigest
    });
    let pendingArtifact: Record<string, unknown> | null = null;
    const query = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      values: unknown[] = []
    ): Promise<pg.QueryResult<T>> => {
      const sql = text.replace(/\s+/g, " ").trim();
      queryLog.push({ sql, values });
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("from privacy_content_policies policy")) {
        rows = [policyRow()];
      } else if (
        sql.includes("from conversation_source_artifacts source") &&
        sql.includes("source_grant.share_grant_id=$7")
      ) {
        rows = [
          {
            classifier_generation_id: generationId,
            closure_hash: null,
            source_frontier_cursor: 100,
            source_segment_count: 1,
            head_content_digest: headContentDigest
          }
        ];
      } else if (sql.includes("from privacy_classification_results")) {
        rows = [{ valid_count: 1 }];
      } else if (
        sql.startsWith("insert into privacy_sanitized_source_artifacts")
      ) {
        pendingArtifact = {
          id: values[0],
          share_grant_id: values[1],
          source_artifact_id: values[2],
          owner_user_id: values[3],
          team_id: values[4],
          team_workspace_id: values[5],
          classifier_generation_id: values[6],
          classifier_hash: values[7],
          effective_policy_hash: values[8],
          source_frontier_hash: values[9],
          source_frontier_cursor: values[10],
          source_segment_count: values[11],
          source_closure_hash: values[12],
          owner_manifest_fingerprint: values[13],
          metadata_binding_hash: null,
          artifact_binding_hash: null,
          chunk_count: 0,
          sanitized_byte_count: 0,
          format: values[14],
          format_version: values[15],
          status: "pending",
          failure_code: null,
          created_at: now,
          ready_at: null,
          invalidated_at: null,
          invalidation_reason_code: null
        };
        rows = [pendingArtifact];
      } else if (sql.startsWith("insert into encrypted_field_payloads")) {
        rows = [
          {
            id: randomUUID(),
            owner_user_id: values[0],
            owner_principal_id: values[1],
            team_id: values[2],
            team_workspace_id: values[3],
            visibility: values[4],
            encryption_scope: values[5],
            source_table: values[6],
            source_id: values[7],
            source_column: values[8],
            plaintext_content_type: values[9],
            plaintext_encoding: values[10],
            envelope_version: values[11],
            provider_mode: values[12],
            key_id: values[13],
            key_version: values[14],
            scope: JSON.parse(String(values[15])),
            provenance: JSON.parse(String(values[16])),
            algorithm: values[17],
            ciphertext: values[18],
            nonce: values[19],
            tag: values[20],
            wrapped_dek: JSON.parse(String(values[21])),
            ciphertext_location: values[22],
            aad: JSON.parse(String(values[23])),
            envelope_created_at: new Date(String(values[24])),
            envelope_reencrypted_at: values[25],
            created_at: now,
            updated_at: now
          }
        ];
      } else if (
        sql.startsWith("update privacy_sanitized_source_artifacts") &&
        sql.includes("set status='ready'")
      ) {
        rows = [
          {
            ...pendingArtifact!,
            metadata_binding_hash: values[1],
            artifact_binding_hash: values[2],
            chunk_count: values[3],
            sanitized_byte_count: values[4],
            status: "ready",
            ready_at: now
          }
        ];
      }
      return {
        rows: rows as T[],
        rowCount: rows.length
      } as unknown as pg.QueryResult<T>;
    };
    const pool = {
      query,
      async connect() {
        return { query, release: () => undefined } as unknown as pg.PoolClient;
      }
    } as unknown as pg.Pool;
    const repository = createPrivacyClassificationRepository(pool, {
      fingerprintKey
    });
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );

    await expect(
      repository.storeSanitizedSourceArtifact({
        actor: { userId: ownerId },
        provider,
        shareGrantId,
        sourceArtifactId,
        teamId,
        teamWorkspaceId: workspaceId,
        classifierHash,
        effectivePolicyHash: effectiveDeploymentPolicyHash(),
        sourceFrontierHash,
        sourceFrontierCursor: 100,
        sourceSegmentCount: 1,
        format: "codex_sanitized_ndjson",
        formatVersion: 1,
        metadata: { version: 1 },
        chunks: [
          {
            classificationResultId,
            sourceStartByte: 0,
            sourceEndByte: 100,
            text: "sanitized\n"
          }
        ]
      })
    ).resolves.toMatchObject({ status: "ready" });

    const readyIndex = queryLog.findIndex(({ sql }) =>
      sql.includes("set status='ready'")
    );
    const notifyIndex = queryLog.findIndex(({ sql }) =>
      sql.includes("pg_notify( 'koed_team_conversation_source'")
    );
    const commitIndex = queryLog.findIndex(({ sql }) => sql === "commit");
    expect(readyIndex).toBeGreaterThan(-1);
    expect(notifyIndex).toBeGreaterThan(readyIndex);
    expect(commitIndex).toBeGreaterThan(notifyIndex);
    expect(queryLog[notifyIndex]?.values).toEqual([shareGrantId]);
    expect(queryLog[notifyIndex]?.sql).toContain("'reason', 'sanitized_ready'");
  });

  it("resolves API sanitized reads through current grant, consent, policy, and classifier state", async () => {
    const queries: string[] = [];
    const deploymentPolicy = policyRecord(
      "deployment",
      allPrivacyLabelsPolicy(),
      1
    );
    const query = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string
    ): Promise<pg.QueryResult<T>> => {
      const sql = text.replace(/\s+/g, " ").trim();
      queries.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.startsWith("select source_grant.owner_user_id")) {
        rows = [
          {
            owner_user_id: ownerId,
            team_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            team_workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          }
        ];
      } else if (sql.includes("from privacy_classifier_generations")) {
        rows = [classifierRow()];
      } else if (sql.includes("from privacy_content_policies policy")) {
        rows = [
          {
            id: deploymentPolicy.id,
            policy_id: deploymentPolicy.policyId,
            version: deploymentPolicy.version,
            scope: deploymentPolicy.scope,
            deployment_identity_id: deploymentPolicy.deploymentIdentityId,
            source_owner_user_id: null,
            team_id: null,
            team_workspace_id: null,
            labels: deploymentPolicy.labels,
            replacement_contract_version:
              deploymentPolicy.replacementContractVersion,
            policy_hash: deploymentPolicy.policyHash,
            status: deploymentPolicy.status,
            effective_at: deploymentPolicy.effectiveAt,
            created_at: deploymentPolicy.createdAt,
            superseded_at: null,
            revoked_at: null,
            revocation_reason_code: null
          }
        ];
      }
      return {
        rows: rows as T[],
        rowCount: rows.length
      } as unknown as pg.QueryResult<T>;
    };
    const pool = {
      query,
      async connect() {
        return {
          query,
          release: () => undefined
        } as unknown as pg.PoolClient;
      }
    } as unknown as pg.Pool;
    const repository = createPrivacyClassificationRepository(pool, {
      fingerprintKey
    });

    await expect(
      repository.readLatestSanitizedSourceArtifactByGrant({
        actor: { userId: otherOwnerId },
        provider: createLocalTestKeyEnvelopeEncryptionProvider(
          randomBytes(32).toString("base64")
        ),
        shareGrantId: "88888888-8888-4888-8888-888888888888"
      })
    ).resolves.toBeNull();

    const accessSql = queries.find((sql) =>
      sql.startsWith("select source_grant.owner_user_id")
    );
    expect(accessSql).toContain("source_grant.lifecycle='active'");
    expect(accessSql).toContain("share_grant.personal_deleted_at is null");
    expect(accessSql).toContain("consent.expires_at > now()");
    expect(accessSql).toContain("membership.status='enabled'");
    expect(accessSql).toContain("workspace_access.access in ('read','write')");
    const artifactSql = queries.find((sql) =>
      sql.includes("from privacy_sanitized_source_artifacts a")
    );
    expect(artifactSql).toContain("source_grant.mode='snapshot'");
    expect(artifactSql).toContain("source_grant.mode='continuous'");
    expect(artifactSql).toContain("a.classifier_generation_id=$2");
    expect(artifactSql).toContain("a.effective_policy_hash=$4");
  });
});

const _classifierTypeCheck: PrivacyClassifierGenerationRecord["status"] =
  "active";
void _classifierTypeCheck;
