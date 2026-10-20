import type pg from "pg";
import {
  decryptEnvelopeToUtf8,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider
} from "@koed/shared";

export type MergeJournalState =
  | "prepared"
  | "claimed"
  | "pending"
  | "merged"
  | "rejected"
  | "unknown";
export interface MergeJournalEntry<T = unknown> {
  id: string;
  ownerUserId: string;
  prKey: string;
  idempotencyKey: string;
  readinessDigest: string;
  prepared: T;
  state: MergeJournalState;
  providerOperationId: string | null;
  mergeCommitObjectId: string | null;
  expiresAt: Date;
  claimedAt: Date | null;
}

const envelopeFor = (
  row: Record<string, unknown>
): EncryptedPayloadEnvelope => {
  const envelope = row.prepared as EncryptedPayloadEnvelope;
  if (
    envelope.scope?.tenantId !== row.owner_user_id ||
    envelope.scope?.objectClass !== "source_control_merge_operation" ||
    envelope.provenance?.rowFamily !== "source_control_merge_operations" ||
    envelope.provenance?.sourceId !== row.id ||
    envelope.ciphertextLocation !==
      "source_control_merge_operations.prepared" ||
    envelope.aad?.ownerUserId !== row.owner_user_id ||
    envelope.aad?.operationId !== row.id ||
    envelope.aad?.readinessDigest !== row.readiness_digest
  )
    throw new Error("Source-control merge encrypted custody mismatch");
  return envelope;
};
const mapRow = async <T>(
  row: Record<string, unknown>,
  provider: EnvelopeEncryptionProvider
): Promise<MergeJournalEntry<T>> => ({
  id: String(row.id),
  ownerUserId: String(row.owner_user_id),
  prKey: String(row.pr_key),
  idempotencyKey: String(row.idempotency_key),
  readinessDigest: String(row.readiness_digest),
  prepared: JSON.parse(
    await decryptEnvelopeToUtf8(provider, envelopeFor(row))
  ) as T,
  state: row.state as MergeJournalState,
  providerOperationId:
    typeof row.provider_operation_id === "string"
      ? row.provider_operation_id
      : null,
  mergeCommitObjectId:
    typeof row.merge_commit_object_id === "string"
      ? row.merge_commit_object_id
      : null,
  expiresAt: row.expires_at as Date,
  claimedAt: (row.claimed_at as Date | null) ?? null
});
const columns =
  "id, owner_user_id, pr_key, idempotency_key, readiness_digest, prepared, state, provider_operation_id, merge_commit_object_id, expires_at, claimed_at";

export const createSourceControlMergeRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider: EnvelopeEncryptionProvider }
) => {
  const provider = options.envelopeEncryptionProvider;
  return {
    async prepare<T>(
      input: Omit<
        MergeJournalEntry<T>,
        "state" | "providerOperationId" | "mergeCommitObjectId" | "claimedAt"
      >
    ): Promise<MergeJournalEntry<T>> {
      const encrypted = await provider.encrypt({
        plaintext: JSON.stringify(input.prepared),
        scope: {
          tenantId: input.ownerUserId,
          objectClass: "source_control_merge_operation"
        },
        provenance: {
          rowFamily: "source_control_merge_operations",
          sourceId: input.id
        },
        ciphertextLocation: "source_control_merge_operations.prepared",
        aad: {
          ownerUserId: input.ownerUserId,
          operationId: input.id,
          readinessDigest: input.readinessDigest
        }
      });
      const result = await pool.query<Record<string, unknown>>(
        `insert into source_control_merge_operations
       (id, owner_user_id, pr_key, idempotency_key, readiness_digest, prepared, state, expires_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,'prepared',$7)
       returning ${columns}`,
        [
          input.id,
          input.ownerUserId,
          input.prKey,
          input.idempotencyKey,
          input.readinessDigest,
          JSON.stringify(encrypted),
          input.expiresAt
        ]
      );
      return mapRow<T>(result.rows[0]!, provider);
    },
    async get<T>(
      ownerUserId: string,
      id: string
    ): Promise<MergeJournalEntry<T> | null> {
      const result = await pool.query<Record<string, unknown>>(
        `select ${columns} from source_control_merge_operations where owner_user_id=$1 and id=$2`,
        [ownerUserId, id]
      );
      return result.rows[0] ? mapRow<T>(result.rows[0], provider) : null;
    },
    async unresolved(
      ownerUserId: string,
      prKey: string
    ): Promise<MergeJournalEntry | null> {
      const result = await pool.query<Record<string, unknown>>(
        `select ${columns} from source_control_merge_operations
       where owner_user_id=$1 and pr_key=$2 and state in ('claimed','pending','unknown')
       order by created_at desc limit 1`,
        [ownerUserId, prKey]
      );
      return result.rows[0] ? mapRow(result.rows[0], provider) : null;
    },
    /** A transaction advisory lock fences the same provider PR across owners and processes. */
    async claim(
      ownerUserId: string,
      id: string
    ): Promise<MergeJournalEntry | null> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const candidate = await client.query<{ pr_key: string }>(
          `select pr_key from source_control_merge_operations
         where owner_user_id=$1 and id=$2 and state='prepared' and expires_at>now()`,
          [ownerUserId, id]
        );
        if (!candidate.rows[0]) {
          await client.query("commit");
          return null;
        }
        const prKey = candidate.rows[0].pr_key;
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [prKey]
        );
        const predecessor = await client.query(
          `select 1 from source_control_merge_operations
         where pr_key=$1 and id<>$2 and state in ('claimed','pending','unknown')
         limit 1`,
          [prKey, id]
        );
        if (predecessor.rows.length > 0) {
          await client.query("commit");
          return null;
        }
        const result = await client.query<Record<string, unknown>>(
          `update source_control_merge_operations set state='claimed', claimed_at=now()
         where owner_user_id=$1 and id=$2 and pr_key=$3
           and state='prepared' and expires_at>now()
         returning ${columns}`,
          [ownerUserId, id, prKey]
        );
        await client.query("commit");
        return result.rows[0] ? mapRow(result.rows[0], provider) : null;
      } catch (error) {
        await client.query("rollback");
        if ((error as { code?: string }).code === "23505") return null;
        throw error;
      } finally {
        client.release();
      }
    },
    async setOutcome(
      ownerUserId: string,
      id: string,
      state: Exclude<MergeJournalState, "prepared" | "claimed">,
      providerOperationId: string | null,
      mergeCommitObjectId: string | null
    ): Promise<MergeJournalEntry | null> {
      const result = await pool.query<Record<string, unknown>>(
        `update source_control_merge_operations
       set state=$3, provider_operation_id=coalesce($4, provider_operation_id),
           merge_commit_object_id=coalesce($5, merge_commit_object_id)
       where owner_user_id=$1 and id=$2 and state in ('claimed','pending','unknown')
         and ($3 <> 'unknown' or state in ('claimed','unknown'))
       returning ${columns}`,
        [ownerUserId, id, state, providerOperationId, mergeCommitObjectId]
      );
      return result.rows[0] ? mapRow(result.rows[0], provider) : null;
    },
    async rewrapSourceControlMergeBatch(
      rewrapProvider: EnvelopeEncryptionProvider,
      input: {
        ownerUserId?: string;
        batchSize?: number;
        afterId?: string;
        dryRun?: boolean;
        force?: boolean;
      } = {}
    ): Promise<{
      processedRows: number;
      rewrappedRows: number;
      done: boolean;
      nextCursorId: string | null;
    }> {
      if (!rewrapProvider.rewrap)
        throw new Error("Merge encryption provider cannot rewrap");
      const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
      const result = await pool.query<Record<string, unknown>>(
        `select ${columns} from source_control_merge_operations
       where (prepared->>'providerMode')=$1 and (prepared->>'keyId')=$2
         and ($3::uuid is null or owner_user_id=$3)
         and ($4::uuid is null or id>$4)
         and ($5::boolean or (prepared->>'keyVersion')<>$6)
       order by id limit $7`,
        [
          rewrapProvider.mode,
          rewrapProvider.keyId,
          input.ownerUserId ?? null,
          input.afterId ?? null,
          input.force ?? false,
          rewrapProvider.keyVersion,
          batchSize
        ]
      );
      if (input.dryRun)
        return {
          processedRows: result.rows.length,
          rewrappedRows: 0,
          done: result.rows.length < batchSize,
          nextCursorId:
            typeof result.rows.at(-1)?.id === "string"
              ? (result.rows.at(-1)!.id as string)
              : null
        };
      let rewrappedRows = 0;
      for (const row of result.rows) {
        const envelope = envelopeFor(row);
        await decryptEnvelopeToUtf8(rewrapProvider, envelope);
        const rewrapped = await rewrapProvider.rewrap(envelope);
        const updated = await pool.query(
          `update source_control_merge_operations set prepared=$2::jsonb
         where id=$1 and owner_user_id=$3 and prepared=$4::jsonb`,
          [
            row.id,
            JSON.stringify(rewrapped),
            row.owner_user_id,
            JSON.stringify(envelope)
          ]
        );
        rewrappedRows += updated.rowCount ?? 0;
      }
      return {
        processedRows: result.rows.length,
        rewrappedRows,
        done: result.rows.length < batchSize,
        nextCursorId:
          typeof result.rows.at(-1)?.id === "string"
            ? (result.rows.at(-1)!.id as string)
            : null
      };
    }
  };
};
export type SourceControlMergeRepository = ReturnType<
  typeof createSourceControlMergeRepository
>;
