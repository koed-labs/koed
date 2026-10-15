import type pg from "pg";
import {
  crossIdentitySyncDigest,
  syncProfileTransitionReceiptSchema,
  type SyncProfileTransitionRequest,
  type SyncProfileTransitionReceipt
} from "@koed/shared";
import type { CrossIdentitySyncRelationshipRecord } from "./cross-identity-sync-repository.js";

const conflict = (): never => {
  throw Object.assign(
    new Error("Sync profile transition conflicts with retained delivery state"),
    { statusCode: 409 }
  );
};

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
