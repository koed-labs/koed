import { createHash, timingSafeEqual } from "node:crypto";

import type { EncryptedPayloadEnvelope } from "@koed/shared";
import type pg from "pg";

import type { ActorContext } from "./types.js";

export const DEVELOPMENT_WORKSPACE_SNAPSHOT_PROTOCOL =
  "koed-development-workspace-snapshot-v1" as const;
export const DEVELOPMENT_WORKSPACE_SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
export const DEVELOPMENT_WORKSPACE_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
export const DEVELOPMENT_WORKSPACE_SNAPSHOT_MAX_CHUNKS =
  DEVELOPMENT_WORKSPACE_SNAPSHOT_MAX_BYTES /
  DEVELOPMENT_WORKSPACE_SNAPSHOT_CHUNK_BYTES;

export type DevelopmentWorkspaceSnapshotOperationKind = "handoff" | "fork";

export interface DevelopmentWorkspaceSnapshotRecord {
  id: string;
  ownerUserId: string;
  executionId: string;
  operationKind: DevelopmentWorkspaceSnapshotOperationKind;
  operationId: string;
  sourceGenerationId: string;
  sourceDeploymentId: string;
  sourceDeviceId: string;
  protocol: typeof DEVELOPMENT_WORKSPACE_SNAPSHOT_PROTOCOL;
  state:
    | "capturing"
    | "ready"
    | "materialized"
    | "environment_incomplete"
    | "incompatible"
    | "conflicted"
    | "revoked"
    | "deleted";
  manifestDigest: string | null;
  sourceStateDigest: string | null;
  storageProvider: string | null;
  packageDigest: string | null;
  packageByteCount: number | null;
  chunkCount: number | null;
  readinessEvidence: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
}

export interface DevelopmentWorkspaceSnapshotChunkRecord {
  snapshotId: string;
  ownerUserId: string;
  chunkIndex: number;
  chunkCount: number;
  plaintextDigest: string;
  plaintextByteCount: number;
  ciphertextDigest: string;
  encryptedByteCount: number;
  encryptionEnvelope: EncryptedPayloadEnvelope;
  createdAt: string;
}

type SnapshotRow = {
  id: string;
  owner_user_id: string;
  execution_id: string;
  operation_kind: DevelopmentWorkspaceSnapshotOperationKind;
  operation_id: string;
  source_generation_id: string;
  source_deployment_id: string;
  source_device_id: string;
  protocol: typeof DEVELOPMENT_WORKSPACE_SNAPSHOT_PROTOCOL;
  state: DevelopmentWorkspaceSnapshotRecord["state"];
  manifest_digest: string | null;
  source_state_digest: string | null;
  storage_provider: string | null;
  package_digest: string | null;
  package_byte_count: string | number | null;
  chunk_count: number | null;
  readiness_evidence: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  finalized_at: Date | null;
};

type ChunkRow = {
  snapshot_id: string;
  owner_user_id: string;
  chunk_index: number;
  chunk_count: number;
  plaintext_digest: string;
  plaintext_byte_count: number;
  ciphertext_digest: string;
  encrypted_byte_count: number;
  encryption_envelope: EncryptedPayloadEnvelope;
  created_at: Date;
};

const SNAPSHOT_COLUMNS = `
  id, owner_user_id, execution_id, operation_kind, operation_id,
  source_generation_id, source_deployment_id, source_device_id, protocol, state,
  manifest_digest, source_state_digest, storage_provider, package_digest,
  package_byte_count, chunk_count, readiness_evidence, created_at, updated_at,
  finalized_at
`;

const CHUNK_COLUMNS = `
  snapshot_id, owner_user_id, chunk_index, chunk_count, plaintext_digest,
  plaintext_byte_count, ciphertext_digest, encrypted_byte_count,
  encryption_envelope, created_at
`;
const QUALIFIED_CHUNK_COLUMNS = CHUNK_COLUMNS.split(",")
  .map((column) => `chunk.${column.trim()}`)
  .join(", ");

const mapSnapshot = (row: SnapshotRow): DevelopmentWorkspaceSnapshotRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  executionId: row.execution_id,
  operationKind: row.operation_kind,
  operationId: row.operation_id,
  sourceGenerationId: row.source_generation_id,
  sourceDeploymentId: row.source_deployment_id,
  sourceDeviceId: row.source_device_id,
  protocol: row.protocol,
  state: row.state,
  manifestDigest: row.manifest_digest,
  sourceStateDigest: row.source_state_digest,
  storageProvider: row.storage_provider,
  packageDigest: row.package_digest,
  packageByteCount:
    row.package_byte_count === null ? null : Number(row.package_byte_count),
  chunkCount: row.chunk_count,
  readinessEvidence: row.readiness_evidence,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  finalizedAt: row.finalized_at?.toISOString() ?? null
});

const mapChunk = (row: ChunkRow): DevelopmentWorkspaceSnapshotChunkRecord => ({
  snapshotId: row.snapshot_id,
  ownerUserId: row.owner_user_id,
  chunkIndex: row.chunk_index,
  chunkCount: row.chunk_count,
  plaintextDigest: row.plaintext_digest,
  plaintextByteCount: row.plaintext_byte_count,
  ciphertextDigest: row.ciphertext_digest,
  encryptedByteCount: row.encrypted_byte_count,
  encryptionEnvelope: row.encryption_envelope,
  createdAt: row.created_at.toISOString()
});

const fail = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

const digestPattern = /^[0-9a-f]{64}$/;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const equalDigest = (left: string, right: string): boolean =>
  digestPattern.test(left) &&
  digestPattern.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

const validateChunk = (input: {
  snapshotId: string;
  ownerUserId: string;
  operationId: string;
  chunkIndex: number;
  chunkCount: number;
  plaintextDigest: string;
  plaintextByteCount: number;
  ciphertextDigest: string;
  encryptedByteCount: number;
  encryptionEnvelope: EncryptedPayloadEnvelope;
}): void => {
  if (
    !Number.isSafeInteger(input.chunkIndex) ||
    input.chunkIndex < 0 ||
    !Number.isSafeInteger(input.chunkCount) ||
    input.chunkCount < 1 ||
    input.chunkCount > DEVELOPMENT_WORKSPACE_SNAPSHOT_MAX_CHUNKS ||
    input.chunkIndex >= input.chunkCount ||
    !Number.isSafeInteger(input.plaintextByteCount) ||
    input.plaintextByteCount < 1 ||
    input.plaintextByteCount > DEVELOPMENT_WORKSPACE_SNAPSHOT_CHUNK_BYTES ||
    !Number.isSafeInteger(input.encryptedByteCount) ||
    input.encryptedByteCount < 1 ||
    !digestPattern.test(input.plaintextDigest) ||
    !digestPattern.test(input.ciphertextDigest)
  ) {
    throw fail("Development workspace snapshot chunk is invalid", 400);
  }
  const ciphertext = Buffer.from(input.encryptionEnvelope.ciphertext, "base64");
  if (
    ciphertext.toString("base64") !== input.encryptionEnvelope.ciphertext ||
    ciphertext.byteLength !== input.encryptedByteCount ||
    !equalDigest(sha256(ciphertext), input.ciphertextDigest) ||
    input.encryptionEnvelope.aad.ownerUserId !== input.ownerUserId ||
    input.encryptionEnvelope.aad.operationId !== input.operationId ||
    input.encryptionEnvelope.aad.snapshotId !== input.snapshotId ||
    input.encryptionEnvelope.aad.chunkIndex !== String(input.chunkIndex) ||
    input.encryptionEnvelope.aad.chunkCount !== String(input.chunkCount) ||
    input.encryptionEnvelope.aad.plaintextDigest !== input.plaintextDigest
  ) {
    throw fail("Development workspace snapshot chunk binding is invalid", 409);
  }
};

export interface DevelopmentWorkspaceSnapshotRepository {
  beginDevelopmentWorkspaceSnapshot(
    actor: ActorContext,
    input: {
      id: string;
      executionId: string;
      operationKind: DevelopmentWorkspaceSnapshotOperationKind;
      operationId: string;
      sourceGenerationId: string;
      sourceDeploymentId: string;
      sourceDeviceId: string;
    }
  ): Promise<DevelopmentWorkspaceSnapshotRecord>;
  putDevelopmentWorkspaceSnapshotChunk(
    actor: ActorContext,
    input: {
      snapshotId: string;
      operationKind: DevelopmentWorkspaceSnapshotOperationKind;
      operationId: string;
      chunkIndex: number;
      chunkCount: number;
      plaintextDigest: string;
      plaintextByteCount: number;
      ciphertextDigest: string;
      encryptedByteCount: number;
      encryptionEnvelope: EncryptedPayloadEnvelope;
    }
  ): Promise<{ stored: boolean; replayed: boolean }>;
  finalizeDevelopmentWorkspaceSnapshot(
    actor: ActorContext,
    input: {
      snapshotId: string;
      operationKind: DevelopmentWorkspaceSnapshotOperationKind;
      operationId: string;
      manifestDigest: string;
      sourceStateDigest: string;
      packageDigest: string;
      packageByteCount: number;
      chunkCount: number;
      readinessEvidence: Record<string, unknown>;
    }
  ): Promise<DevelopmentWorkspaceSnapshotRecord>;
  getDevelopmentWorkspaceSnapshot(
    actor: ActorContext,
    input: {
      snapshotId: string;
      operationKind: DevelopmentWorkspaceSnapshotOperationKind;
      operationId: string;
    }
  ): Promise<DevelopmentWorkspaceSnapshotRecord | null>;
  getDevelopmentWorkspaceSnapshotChunk(
    actor: ActorContext,
    input: {
      snapshotId: string;
      operationKind: DevelopmentWorkspaceSnapshotOperationKind;
      operationId: string;
      chunkIndex: number;
    }
  ): Promise<DevelopmentWorkspaceSnapshotChunkRecord | null>;
}

export const createDevelopmentWorkspaceSnapshotRepository = (
  pool: pg.Pool
): DevelopmentWorkspaceSnapshotRepository => ({
  async beginDevelopmentWorkspaceSnapshot(actor, input) {
    const result = await pool.query<SnapshotRow>(
      `insert into development_workspace_snapshots (
         id, owner_user_id, execution_id, operation_kind, operation_id,
         source_generation_id, source_deployment_id, source_device_id,
         protocol, state
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'capturing')
       on conflict (owner_user_id, id) do nothing
       returning ${SNAPSHOT_COLUMNS}`,
      [
        input.id,
        actor.userId,
        input.executionId,
        input.operationKind,
        input.operationId,
        input.sourceGenerationId,
        input.sourceDeploymentId,
        input.sourceDeviceId,
        DEVELOPMENT_WORKSPACE_SNAPSHOT_PROTOCOL
      ]
    );
    let row = result.rows[0];
    if (!row) {
      row = (
        await pool.query<SnapshotRow>(
          `select ${SNAPSHOT_COLUMNS}
             from development_workspace_snapshots
            where owner_user_id = $1 and id = $2`,
          [actor.userId, input.id]
        )
      ).rows[0];
    }
    if (
      !row ||
      row.execution_id !== input.executionId ||
      row.operation_kind !== input.operationKind ||
      row.operation_id !== input.operationId ||
      row.source_generation_id !== input.sourceGenerationId ||
      row.source_deployment_id !== input.sourceDeploymentId ||
      row.source_device_id !== input.sourceDeviceId ||
      row.protocol !== DEVELOPMENT_WORKSPACE_SNAPSHOT_PROTOCOL
    ) {
      throw fail("Development workspace snapshot identity conflicted", 409);
    }
    return mapSnapshot(row);
  },

  async putDevelopmentWorkspaceSnapshotChunk(actor, input) {
    validateChunk({ ...input, ownerUserId: actor.userId });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const snapshot = (
        await client.query<SnapshotRow>(
          `select ${SNAPSHOT_COLUMNS}
             from development_workspace_snapshots
            where owner_user_id = $1 and id = $2
            for update`,
          [actor.userId, input.snapshotId]
        )
      ).rows[0];
      if (
        !snapshot ||
        snapshot.operation_kind !== input.operationKind ||
        snapshot.operation_id !== input.operationId ||
        !["capturing", "ready"].includes(snapshot.state)
      ) {
        throw fail("Development workspace snapshot is not writable", 409);
      }
      const inserted = await client.query<ChunkRow>(
        `insert into development_workspace_snapshot_chunks (
           snapshot_id, owner_user_id, chunk_index, chunk_count,
           plaintext_digest, plaintext_byte_count, ciphertext_digest,
           encrypted_byte_count, encryption_envelope
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         on conflict (snapshot_id, chunk_index) do nothing
         returning ${CHUNK_COLUMNS}`,
        [
          input.snapshotId,
          actor.userId,
          input.chunkIndex,
          input.chunkCount,
          input.plaintextDigest,
          input.plaintextByteCount,
          input.ciphertextDigest,
          input.encryptedByteCount,
          input.encryptionEnvelope
        ]
      );
      if (inserted.rows[0]) {
        await client.query("commit");
        return { stored: true, replayed: false };
      }
      const existing = (
        await client.query<ChunkRow>(
          `select ${CHUNK_COLUMNS}
             from development_workspace_snapshot_chunks
            where snapshot_id = $1 and chunk_index = $2`,
          [input.snapshotId, input.chunkIndex]
        )
      ).rows[0];
      if (
        !existing ||
        existing.owner_user_id !== actor.userId ||
        existing.chunk_count !== input.chunkCount ||
        existing.plaintext_digest !== input.plaintextDigest ||
        existing.plaintext_byte_count !== input.plaintextByteCount ||
        existing.ciphertext_digest !== input.ciphertextDigest ||
        existing.encrypted_byte_count !== input.encryptedByteCount
      ) {
        throw fail("Development workspace snapshot chunk conflicted", 409);
      }
      await client.query("commit");
      return { stored: true, replayed: true };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async finalizeDevelopmentWorkspaceSnapshot(actor, input) {
    if (
      !digestPattern.test(input.manifestDigest) ||
      !digestPattern.test(input.sourceStateDigest) ||
      !digestPattern.test(input.packageDigest) ||
      !Number.isSafeInteger(input.packageByteCount) ||
      input.packageByteCount < 1 ||
      input.packageByteCount > DEVELOPMENT_WORKSPACE_SNAPSHOT_MAX_BYTES ||
      !Number.isSafeInteger(input.chunkCount) ||
      input.chunkCount < 1 ||
      input.chunkCount > DEVELOPMENT_WORKSPACE_SNAPSHOT_MAX_CHUNKS
    ) {
      throw fail("Development workspace snapshot finalization is invalid", 400);
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const snapshot = (
        await client.query<SnapshotRow>(
          `select ${SNAPSHOT_COLUMNS}
             from development_workspace_snapshots
            where owner_user_id = $1 and id = $2
            for update`,
          [actor.userId, input.snapshotId]
        )
      ).rows[0];
      if (
        !snapshot ||
        snapshot.operation_kind !== input.operationKind ||
        snapshot.operation_id !== input.operationId
      ) {
        throw fail("Development workspace snapshot is unavailable", 404);
      }
      if (snapshot.state === "ready") {
        if (
          snapshot.manifest_digest !== input.manifestDigest ||
          snapshot.source_state_digest !== input.sourceStateDigest ||
          snapshot.package_digest !== input.packageDigest ||
          Number(snapshot.package_byte_count) !== input.packageByteCount ||
          snapshot.chunk_count !== input.chunkCount
        ) {
          throw fail(
            "Development workspace snapshot finalization conflicted",
            409
          );
        }
        await client.query("commit");
        return mapSnapshot(snapshot);
      }
      if (snapshot.state !== "capturing") {
        throw fail("Development workspace snapshot is not finalizable", 409);
      }
      const chunks = await client.query<{
        chunk_index: number;
        chunk_count: number;
        plaintext_byte_count: number;
      }>(
        `select chunk_index, chunk_count, plaintext_byte_count
           from development_workspace_snapshot_chunks
          where snapshot_id = $1 and owner_user_id = $2
          order by chunk_index`,
        [input.snapshotId, actor.userId]
      );
      if (
        chunks.rows.length !== input.chunkCount ||
        chunks.rows.some(
          (chunk, index) =>
            chunk.chunk_index !== index ||
            chunk.chunk_count !== input.chunkCount
        ) ||
        chunks.rows.reduce(
          (total, chunk) => total + chunk.plaintext_byte_count,
          0
        ) !== input.packageByteCount
      ) {
        throw fail("Development workspace snapshot chunks are incomplete", 409);
      }
      const updated = (
        await client.query<SnapshotRow>(
          `update development_workspace_snapshots
              set state = 'ready',
                  manifest_digest = $3,
                  source_state_digest = $4,
                  storage_provider = 'postgres_encrypted_chunks_v1',
                  package_digest = $5,
                  package_byte_count = $6,
                  chunk_count = $7,
                  readiness_evidence = $8::jsonb,
                  finalized_at = now(),
                  updated_at = now()
            where owner_user_id = $1 and id = $2 and state = 'capturing'
          returning ${SNAPSHOT_COLUMNS}`,
          [
            actor.userId,
            input.snapshotId,
            input.manifestDigest,
            input.sourceStateDigest,
            input.packageDigest,
            input.packageByteCount,
            input.chunkCount,
            input.readinessEvidence
          ]
        )
      ).rows[0];
      if (!updated) {
        throw fail(
          "Development workspace snapshot finalization conflicted",
          409
        );
      }
      await client.query("commit");
      return mapSnapshot(updated);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getDevelopmentWorkspaceSnapshot(actor, input) {
    const row = (
      await pool.query<SnapshotRow>(
        `select ${SNAPSHOT_COLUMNS}
           from development_workspace_snapshots
          where owner_user_id = $1
            and id = $2
            and operation_kind = $3
            and operation_id = $4
            and revoked_at is null
            and deleted_at is null`,
        [actor.userId, input.snapshotId, input.operationKind, input.operationId]
      )
    ).rows[0];
    return row ? mapSnapshot(row) : null;
  },

  async getDevelopmentWorkspaceSnapshotChunk(actor, input) {
    const row = (
      await pool.query<ChunkRow>(
        `select ${QUALIFIED_CHUNK_COLUMNS}
           from development_workspace_snapshot_chunks chunk
           join development_workspace_snapshots snapshot
             on snapshot.id = chunk.snapshot_id
            and snapshot.owner_user_id = chunk.owner_user_id
          where chunk.owner_user_id = $1
            and chunk.snapshot_id = $2
            and chunk.chunk_index = $3
            and snapshot.operation_kind = $4
            and snapshot.operation_id = $5
            and snapshot.state = 'ready'
            and snapshot.revoked_at is null
            and snapshot.deleted_at is null`,
        [
          actor.userId,
          input.snapshotId,
          input.chunkIndex,
          input.operationKind,
          input.operationId
        ]
      )
    ).rows[0];
    return row ? mapChunk(row) : null;
  }
});
