import type pg from "pg";
import {
  crossIdentitySyncDigest,
  syncProfileTransitionReceiptSchema,
  type SyncProfileTransitionRequest,
  type SyncProfileTransitionReceipt
} from "@koed/shared";
import type { CrossIdentitySyncRelationshipRecord } from "./cross-identity-sync-repository.js";

function conflict(): never {
  throw Object.assign(
    new Error("Sync profile transition conflicts with retained delivery state"),
    { statusCode: 409 }
  );
}

/** Caller holds the authenticated target relationship lock for the whole transaction. */
export const reconcileTargetSyncProfileWithClient = async (
  client: pg.PoolClient,
  relationship: CrossIdentitySyncRelationshipRecord,
  request: SyncProfileTransitionRequest
): Promise<SyncProfileTransitionReceipt> => {
  const digest = crossIdentitySyncDigest(request);
  const existing = await client.query<{
    request_digest: string;
    receipt: unknown;
  }>(
    "select request_digest,receipt from sync_profile_transition_receipts where sync_relationship_id=$1 and (protocol_package_id=$2 or source_sequence=$3)",
    [relationship.id, request.packageId, request.sourceSequence]
  );
  if (existing.rows.length) {
    if (
      existing.rows.length !== 1 ||
      existing.rows[0]!.request_digest !== digest
    )
      conflict();
    return syncProfileTransitionReceiptSchema.parse(existing.rows[0]!.receipt);
  }
  const found = await client.query<{
    id: string;
    state: string;
    protocol_package_id: string;
    source_sequence: string;
    from_cursor: string;
    to_cursor: string;
    request_hash: string;
    package_checksum: string;
    package_manifest: Record<string, unknown>;
  }>(
    "select * from sync_package_upload_sessions where sync_relationship_id=$1 and (protocol_package_id=$2 or source_sequence=$3) for update",
    [relationship.id, request.packageId, request.sourceSequence]
  );
  if (found.rows.length > 1) conflict();
  const upload = found.rows[0];
  if (
    upload &&
    (upload.protocol_package_id !== request.packageId ||
      Number(upload.source_sequence) !== request.sourceSequence ||
      Number(upload.from_cursor) !== request.fromCursor ||
      Number(upload.to_cursor) !== request.toCursor ||
      upload.request_hash !== request.requestHash ||
      upload.package_checksum !== request.packageChecksum ||
      crossIdentitySyncDigest(upload.package_manifest) !==
        request.manifestHash ||
      upload.package_manifest.format !== "koed.captured-session-sync/v1" ||
      upload.package_manifest.formatVersion !== 1)
  )
    conflict();
  let outcome: SyncProfileTransitionReceipt["outcome"];
  if (upload?.state === "completed") {
    if (
      relationship.packageSequence !== request.sourceSequence ||
      relationship.lastPackageId !== request.packageId ||
      relationship.targetProcessingCursor !== request.toCursor
    )
      conflict();
    outcome = "applied";
  } else {
    if (
      relationship.packageSequence + 1 !== request.sourceSequence ||
      relationship.targetProcessingCursor !== request.fromCursor
    )
      conflict();
    outcome = "superseded";
    if (upload) {
      await client.query(
        "update sync_package_upload_sessions set state='superseded',updated_at=now() where id=$1",
        [upload.id]
      );
    }
    await client.query(
      "update cross_identity_sync_relationships set package_sequence=$2,last_package_id=$3,state='stale',updated_at=now() where id=$1",
      [relationship.id, request.sourceSequence, request.packageId]
    );
  }
  if (upload)
    await client.query(
      "update sync_inbox_entries set state='cancelled',claim_token=null,lease_expires_at=null,updated_at=now() where upload_session_id=$1 and state in ('pending','processing','failed')",
      [upload.id]
    );
  if (outcome === "applied")
    await client.query(
      "update cross_identity_sync_relationships set state='stale',updated_at=now() where id=$1",
      [relationship.id]
    );
  await client.query(
    "update memory_replicas set freshness_status='stale',updated_at=now() where id=$1",
    [relationship.localReplicaId]
  );
  const receipt = syncProfileTransitionReceiptSchema.parse({
    request,
    outcome,
    sourceCursor: relationship.sourceCursor,
    targetProcessingCursor: relationship.targetProcessingCursor,
    packageSequence: request.sourceSequence,
    issuedAt: new Date().toISOString()
  });
  await client.query(
    "insert into sync_profile_transition_receipts (sync_relationship_id,protocol_package_id,source_sequence,request_digest,receipt) values ($1,$2,$3,$4,$5::jsonb)",
    [
      relationship.id,
      request.packageId,
      request.sourceSequence,
      digest,
      JSON.stringify(receipt)
    ]
  );
  return receipt;
};

/** Caller holds an active source relationship lock; no legacy body is opened. */
export const adoptSourceSyncProfileWithClient = async (
  client: pg.PoolClient,
  relationship: CrossIdentitySyncRelationshipRecord,
  input: {
    receipt: SyncProfileTransitionReceipt;
    outboxId: string;
    claimToken: string;
  }
): Promise<boolean> => {
  const receipt = syncProfileTransitionReceiptSchema.parse(input.receipt);
  const request = receipt.request;
  if (request.relationshipId !== relationship.id) conflict();
  const existing = await client.query<{ receipt: unknown }>(
    "select receipt from sync_profile_transition_receipts where sync_relationship_id=$1 and (protocol_package_id=$2 or source_sequence=$3)",
    [relationship.id, request.packageId, request.sourceSequence]
  );
  if (existing.rows.length) {
    if (
      existing.rows.length !== 1 ||
      crossIdentitySyncDigest(existing.rows[0]!.receipt) !==
        crossIdentitySyncDigest(receipt)
    )
      conflict();
    return true;
  }
  const claim = await client.query(
    "select id from sync_outbox_entries where id=$1 and sync_relationship_id=$2 and state='processing' and claim_token=$3 and lease_expires_at>now() for update",
    [input.outboxId, relationship.id, input.claimToken]
  );
  if (!claim.rowCount) return false;
  const found = await client.query<{
    id: string;
    request_hash: string;
    package_checksum: string;
    package_manifest: Record<string, unknown>;
    from_cursor: string;
    to_cursor: string;
  }>(
    "select * from sync_package_upload_sessions where sync_relationship_id=$1 and protocol_package_id=$2 and source_sequence=$3 for update",
    [relationship.id, request.packageId, request.sourceSequence]
  );
  const upload = found.rows[0];
  if (
    !upload ||
    upload.request_hash !== request.requestHash ||
    upload.package_checksum !== request.packageChecksum ||
    crossIdentitySyncDigest(upload.package_manifest) !== request.manifestHash ||
    upload.package_manifest.format !== "koed.captured-session-sync/v1" ||
    upload.package_manifest.formatVersion !== 1 ||
    Number(upload.from_cursor) !== request.fromCursor ||
    Number(upload.to_cursor) !== request.toCursor ||
    relationship.packageSequence + 1 !== request.sourceSequence ||
    relationship.sourceCursor !== request.fromCursor ||
    relationship.targetProcessingCursor !== request.fromCursor
  )
    conflict();
  await client.query(
    "insert into sync_profile_transition_receipts (sync_relationship_id,protocol_package_id,source_sequence,request_digest,receipt) values ($1,$2,$3,$4,$5::jsonb)",
    [
      relationship.id,
      request.packageId,
      request.sourceSequence,
      crossIdentitySyncDigest(request),
      JSON.stringify(receipt)
    ]
  );
  await client.query(
    `update cross_identity_sync_relationships set source_cursor=$2,target_processing_cursor=$2,package_sequence=$3,last_package_id=$4,source_repository_snapshot_hash=null,state='stale',
    source_summary_revision_hash=case when $5::boolean then coalesce($6::text,source_summary_revision_hash) else source_summary_revision_hash end,updated_at=now() where id=$1`,
    [
      relationship.id,
      receipt.targetProcessingCursor,
      request.sourceSequence,
      request.packageId,
      receipt.outcome === "applied",
      typeof upload.package_manifest.summaryRevisionHash === "string"
        ? upload.package_manifest.summaryRevisionHash
        : null
    ]
  );
  await client.query(
    "update sync_package_upload_sessions set state=$2::text::sync_package_state,completed_at=case when $2::text='completed' then coalesce(completed_at,now()) else completed_at end,updated_at=now() where id=$1",
    [upload.id, receipt.outcome === "applied" ? "completed" : "superseded"]
  );
  await client.query(
    "update sync_outbox_entries set state='completed',processed_at=now(),locked_at=null,claim_token=null,lease_expires_at=null,updated_at=now() where id=$1",
    [input.outboxId]
  );
  await client.query(
    "update sync_outbox_entries set state='cancelled',locked_at=null,claim_token=null,lease_expires_at=null,updated_at=now() where sync_relationship_id=$1 and id<>$2 and state in ('pending','processing','failed') and payload_manifest->>'kind' is distinct from 'revocation'",
    [relationship.id, input.outboxId]
  );
  const work = {
    kind: "repository_snapshot",
    previousPackageId: request.packageId
  };
  await client.query(
    "insert into sync_outbox_entries (sync_relationship_id,idempotency_key,request_hash,payload_manifest) values ($1,$2,$3,$4::jsonb) on conflict (sync_relationship_id,idempotency_key) do nothing",
    [
      relationship.id,
      `profile-transition:${request.packageId}`,
      crossIdentitySyncDigest(work),
      JSON.stringify(work)
    ]
  );
  return true;
};
