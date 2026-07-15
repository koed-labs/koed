import { createHash } from "node:crypto";
import pg from "pg";
import {
  PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES,
  canonicalizePdsJson,
  decodePdsBase64url,
  certificateIsPdsValid,
  parseCanonicalPdsJson,
  pdsRelayNonceDigest,
  validatePdsRelayTransport,
  validatePdsSessionPackageChunk,
  type PdsRelayRequestProof,
  type PdsSessionPackageChunk,
  type PdsSessionPackageHeader
} from "@koed/shared";

const DAY = 24 * 60 * 60 * 1_000;
const MAX_SENDER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_GROUP_BYTES = 10 * 1024 * 1024 * 1024;
const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("base64url");
const row = <T extends Record<string, unknown>>(value: unknown): T =>
  value as T;
const publicError = (): Error =>
  Object.assign(new Error("PDS relay resource is unavailable"), {
    statusCode: 404
  });
const securityError = (message = "PDS relay integrity check failed"): Error =>
  Object.assign(new Error(message), { statusCode: 409 });
const number = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw publicError();
  return parsed;
};

export interface PdsRelayAuthContext {
  groupDbId: string;
  groupId: string;
  headHash: string;
  epoch: string;
  deviceId: string;
  signingKeyId: string;
  signingPublicKey: string;
  recipientDeviceIds: string[];
  certificate: Record<string, unknown>;
  /** Control plane alone accepts active same-epoch certificate at prior head. */
  allowStaleHead?: boolean;
}

export interface PdsRelayTransportRecord {
  transportId: string;
  packageId: string;
  sourceManifestHash: string;
  packageDigest: string | null;
  chunkCount: string;
  missingChunks: string[];
  state: "uploading" | "committed" | "expired" | "quarantined";
  expiresAt: string;
  relayAcceptedAt: string;
}

export interface PdsRelayOperationalStatus {
  transports: {
    uploading: number;
    committed: number;
    expired: number;
    ciphertextBytes: number;
    pendingRecipients: number;
    ackLagSeconds: number;
  };
  quota: { groupBytes: number; groupLimitBytes: number };
  retries: { uploading: number; expired: number };
  lifecycle: {
    tombstones: number;
    pendingTombstoneAcks: number;
    deletionFloors: number;
    oldestTombstoneAckLagSeconds: number;
  };
}

const transportRecord = (
  value: Record<string, unknown>
): PdsRelayTransportRecord => ({
  transportId: value.transport_id as string,
  packageId: value.package_id as string,
  sourceManifestHash: value.source_manifest_hash as string,
  packageDigest: (value.package_digest as string | null) ?? null,
  chunkCount: value.chunk_count as string,
  missingChunks: (value.missing_chunks as string[]) ?? [],
  state: value.state as PdsRelayTransportRecord["state"],
  expiresAt: new Date(value.expires_at as Date).toISOString(),
  relayAcceptedAt: new Date(value.relay_accepted_at as Date).toISOString()
});

/**
 * Locks current group state with every relay operation. Authentication result is
 * only an input hint; certificate, member, head, epoch, and recipient snapshot
 * are reread under same group advisory lock as governance transitions.
 */
const assertCurrentRelayAuth = async (
  client: pg.PoolClient,
  input: PdsRelayAuthContext
): Promise<PdsRelayAuthContext> => {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    input.groupId
  ]);
  const groups = await client.query(
    `select id,group_id,authority_public_key,current_epoch,head_hash,state,pending_epoch
     from personal_device_groups where id=$1 and group_id=$2 for share`,
    [input.groupDbId, input.groupId]
  );
  if (!groups.rowCount) throw publicError();
  const group = row<Record<string, unknown>>(groups.rows[0]);
  const certificate = input.certificate;
  if (
    group.state !== "active" ||
    group.pending_epoch !== null ||
    (!input.allowStaleHead && group.head_hash !== input.headHash) ||
    group.current_epoch !== input.epoch ||
    !certificateIsPdsValid(certificate, group.authority_public_key as string) ||
    certificate.groupId !== group.group_id ||
    (!input.allowStaleHead && certificate.statementHash !== group.head_hash) ||
    certificate.epoch !== group.current_epoch ||
    certificate.deviceId !== input.deviceId ||
    certificate.deviceSigningKeyId !== input.signingKeyId
  ) {
    throw publicError();
  }
  const members = await client.query(
    `select device_id,signing_key_id,signing_public_key from personal_device_group_members
     where group_id=$1 and device_id=$2 and signing_key_id=$3 and status='active' for share`,
    [group.id, input.deviceId, input.signingKeyId]
  );
  if (!members.rowCount) throw publicError();
  const member = row<Record<string, unknown>>(members.rows[0]);
  if (
    member.signing_public_key !== input.signingPublicKey ||
    member.signing_public_key !== certificate.deviceSigningPublicKey
  ) {
    throw publicError();
  }
  const recipients = await client.query(
    `select device_id from personal_device_group_members
     where group_id=$1 and status='active' order by device_id for share`,
    [group.id]
  );
  return {
    ...input,
    recipientDeviceIds: recipients.rows.map(
      (entry) => row<{ device_id: string }>(entry).device_id
    )
  };
};

const getRecipientTransport = async (
  client: pg.PoolClient,
  input: PdsRelayAuthContext,
  transportId: string,
  lock = false
): Promise<Record<string, unknown>> => {
  const result = await client.query(
    `select t.* from pds_relay_transports t
     join pds_relay_recipients r on r.transport_id=t.id and r.recipient_device_id=$3
     where t.group_id=$1 and t.transport_id=$2 and t.state='committed' and t.expires_at>now()${lock ? " for update of t,r" : ""}`,
    [input.groupDbId, transportId, input.deviceId]
  );
  if (!result.rowCount) throw publicError();
  const transport = row<Record<string, unknown>>(result.rows[0]);
  const header = parseCanonicalPdsJson(
    transport.canonical_header as string
  ) as PdsSessionPackageHeader;
  if (
    !header.intendedRecipientSnapshot.includes(input.deviceId) ||
    header.groupId !== input.groupId ||
    header.authorityHead !== input.headHash ||
    header.recipientEpoch !== input.epoch
  ) {
    throw publicError();
  }
  return transport;
};

const redactedReceipt = (input: {
  groupId: string;
  transportId: string;
  packageId: string;
  sourceManifestHash: string;
  relayAcceptedAt: string;
  ciphertextBytes: string;
  recipientCount: number;
}): string =>
  canonicalizePdsJson({
    receiptVersion: 1,
    groupHash: hash(input.groupId),
    transportHash: hash(input.transportId),
    packageHash: hash(input.packageId),
    sourceManifestHash: input.sourceManifestHash,
    relayAcceptedAt: input.relayAcceptedAt,
    ciphertextBytes: input.ciphertextBytes,
    recipientCount: input.recipientCount
  });

export const createPersonalDeviceSyncRelayRepository = (pool: pg.Pool) => ({
  async authenticatePdsRelayRequest(input: {
    certificate: string;
    proof: PdsRelayRequestProof;
    allowStaleHead?: boolean;
  }): Promise<PdsRelayAuthContext> {
    const certificate = parseCanonicalPdsJson(input.certificate) as Record<
      string,
      unknown
    >;
    const groupId = certificate.groupId;
    if (typeof groupId !== "string") throw publicError();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        groupId
      ]);
      const groups = await client.query(
        `select id,group_id,authority_public_key,current_epoch,head_hash,state,pending_epoch
         from personal_device_groups where group_id=$1 for share`,
        [groupId]
      );
      if (!groups.rowCount) throw publicError();
      const group = row<Record<string, unknown>>(groups.rows[0]);
      if (
        group.state !== "active" ||
        group.pending_epoch !== null ||
        !certificateIsPdsValid(
          certificate,
          group.authority_public_key as string
        ) ||
        (!input.allowStaleHead &&
          certificate.statementHash !== group.head_hash) ||
        certificate.epoch !== group.current_epoch ||
        certificate.deviceId !== input.proof.deviceId ||
        certificate.deviceSigningKeyId !== input.proof.deviceSigningKeyId
      ) {
        throw publicError();
      }
      const members = await client.query(
        `select device_id,signing_key_id,signing_public_key from personal_device_group_members
         where group_id=$1 and device_id=$2 and signing_key_id=$3 and status='active' for share`,
        [group.id, certificate.deviceId, certificate.deviceSigningKeyId]
      );
      if (!members.rowCount) throw publicError();
      const member = row<Record<string, unknown>>(members.rows[0]);
      if (member.signing_public_key !== certificate.deviceSigningPublicKey) {
        throw publicError();
      }
      const recipients = await client.query(
        `select device_id from personal_device_group_members
         where group_id=$1 and status='active' order by device_id for share`,
        [group.id]
      );
      await client.query("commit");
      return {
        groupDbId: group.id as string,
        groupId: group.group_id as string,
        headHash: group.head_hash as string,
        epoch: group.current_epoch as string,
        deviceId: member.device_id as string,
        signingKeyId: member.signing_key_id as string,
        signingPublicKey: member.signing_public_key as string,
        recipientDeviceIds: recipients.rows.map(
          (entry) => row<{ device_id: string }>(entry).device_id
        ),
        certificate,
        allowStaleHead: input.allowStaleHead === true
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async consumePdsRelayRequestNonce(
    input: PdsRelayAuthContext & { nonce: string; expiresAt: Date }
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await assertCurrentRelayAuth(client, input);
      if (input.expiresAt <= new Date()) throw publicError();
      const result = await client.query(
        `insert into pds_relay_request_nonces (group_id,device_id,nonce_digest,expires_at)
         values ($1,$2,$3,$4) on conflict do nothing returning id`,
        [
          auth.groupDbId,
          auth.deviceId,
          pdsRelayNonceDigest(input.nonce),
          input.expiresAt
        ]
      );
      if (!result.rowCount) {
        throw securityError("PDS relay request nonce was already used");
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async getPdsRelayCurrentCertificate(
    input: PdsRelayAuthContext
  ): Promise<string> {
    const result = await pool.query<{ canonical_certificate: string }>(
      `select c.canonical_certificate from personal_device_membership_certificates c
       join personal_device_group_members m on m.id=c.member_id
       join personal_device_groups g on g.id=c.group_id
       where c.group_id=$1 and m.device_id=$2 and m.status='active'
         and c.epoch=g.current_epoch and c.statement_hash=g.head_hash
         and c.revoked_at is null and c.expires_at>now()`,
      [input.groupDbId, input.deviceId]
    );
    if (!result.rowCount) throw publicError();
    return result.rows[0]!.canonical_certificate;
  },

  async initializePdsRelayTransport(
    input: PdsRelayAuthContext & { requestHash: string; transport: unknown }
  ): Promise<PdsRelayTransportRecord> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await assertCurrentRelayAuth(client, input);
      const accepted = validatePdsRelayTransport(input.transport, {
        groupId: auth.groupId,
        authorityHead: auth.headHash,
        epoch: auth.epoch,
        senderDeviceId: auth.deviceId,
        senderSigningKeyId: auth.signingKeyId,
        senderSigningPublicKey: auth.signingPublicKey,
        recipientDeviceIds: auth.recipientDeviceIds
      });
      const header = accepted.header;
      const existing = await client.query(
        `select * from pds_relay_transports where group_id=$1 and transport_id=$2 for update`,
        [auth.groupDbId, header.transportId]
      );
      if (existing.rowCount) {
        const item = row<Record<string, unknown>>(existing.rows[0]);
        if (
          item.request_hash !== input.requestHash ||
          item.sender_device_id !== auth.deviceId
        ) {
          throw securityError();
        }
        await client.query("commit");
        return transportRecord({
          ...item,
          missing_chunks: await missingChunks(
            client,
            item.id as string,
            item.chunk_count as string
          )
        });
      }
      const acceptedAt = new Date();
      const headerExpiry = new Date(header.expiresAt);
      if (
        headerExpiry.getTime() > acceptedAt.getTime() + 30 * DAY ||
        headerExpiry <= acceptedAt
      ) {
        throw securityError("PDS relay expiry is invalid");
      }
      const replay = await client.query(
        `select source_manifest_hash from pds_relay_transports
         where group_id=$1 and package_id=$2 limit 1`,
        [auth.groupDbId, header.packageId]
      );
      if (
        replay.rowCount &&
        row<{ source_manifest_hash: string }>(replay.rows[0])
          .source_manifest_hash !== header.sourceManifestHash
      ) {
        throw securityError();
      }
      const nonce = await client.query(
        `select id from pds_relay_transports
         where group_id=$1 and sender_device_id=$2 and payload_nonce=$3 limit 1`,
        [auth.groupDbId, auth.deviceId, header.payloadNonce]
      );
      if (nonce.rowCount)
        throw securityError("PDS relay payload nonce was reused");
      const usage = await client.query(
        `select
          coalesce(sum(ciphertext_bytes::numeric),0)::text as group_bytes,
          coalesce(sum(ciphertext_bytes::numeric) filter (where sender_device_id=$2),0)::text as sender_bytes
         from pds_relay_transports
         where group_id=$1 and state in ('uploading','committed') and expires_at>now()`,
        [auth.groupDbId, auth.deviceId]
      );
      const used = row<{ group_bytes: string; sender_bytes: string }>(
        usage.rows[0]
      );
      const expectedBytes = BigInt(header.plaintextByteCount);
      if (
        BigInt(used.group_bytes) + expectedBytes > BigInt(MAX_GROUP_BYTES) ||
        BigInt(used.sender_bytes) + expectedBytes > BigInt(MAX_SENDER_BYTES)
      ) {
        throw Object.assign(new Error("PDS relay quota exceeded"), {
          statusCode: 429
        });
      }
      const expiry = headerExpiry;
      const stored = await client.query(
        `insert into pds_relay_transports (group_id,transport_id,sender_device_id,origin_device_id,package_id,source_manifest_hash,version,content_epoch,recipient_epoch,authority_head,payload_nonce,payload_ciphertext_hash,payload_tag,plaintext_byte_count,chunk_count,ciphertext_bytes,expires_at,relay_accepted_at,request_hash,canonical_header,canonical_envelopes,receipt_metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$14,$16,$17,$18,$19,$20,$21) returning *`,
        [
          auth.groupDbId,
          header.transportId,
          auth.deviceId,
          header.originDeviceId,
          header.packageId,
          header.sourceManifestHash,
          header.version,
          header.contentEpoch,
          header.recipientEpoch,
          header.authorityHead,
          header.payloadNonce,
          header.payloadCiphertextHash,
          header.payloadTag,
          header.plaintextByteCount,
          header.chunkCount,
          expiry,
          acceptedAt,
          input.requestHash,
          canonicalizePdsJson(header),
          canonicalizePdsJson(accepted.envelopes),
          redactedReceipt({
            groupId: auth.groupId,
            transportId: header.transportId,
            packageId: header.packageId,
            sourceManifestHash: header.sourceManifestHash,
            relayAcceptedAt: acceptedAt.toISOString(),
            ciphertextBytes: header.plaintextByteCount,
            recipientCount: header.intendedRecipientSnapshot.length
          })
        ]
      );
      const transport = row<Record<string, unknown>>(stored.rows[0]);
      for (const recipient of header.intendedRecipientSnapshot) {
        await client.query(
          `insert into pds_relay_recipients (transport_id,recipient_device_id) values ($1,$2)`,
          [transport.id, recipient]
        );
      }
      await client.query("commit");
      return transportRecord({
        ...transport,
        missing_chunks: Array.from(
          { length: number(header.chunkCount) },
          (_, i) => String(i)
        )
      });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async putPdsRelayChunk(
    input: PdsRelayAuthContext & { transportId: string; chunk: unknown }
  ): Promise<{ missingChunks: string[] }> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await assertCurrentRelayAuth(client, input);
      const found = await client.query(
        `select * from pds_relay_transports
         where group_id=$1 and transport_id=$2 and sender_device_id=$3 for update`,
        [auth.groupDbId, input.transportId, auth.deviceId]
      );
      if (!found.rowCount) throw publicError();
      const transport = row<Record<string, unknown>>(found.rows[0]);
      if (
        transport.state !== "uploading" ||
        new Date(transport.expires_at as Date) <= new Date()
      ) {
        throw securityError("PDS relay transport is unavailable");
      }
      const header = parseCanonicalPdsJson(
        transport.canonical_header as string
      ) as PdsSessionPackageHeader;
      const chunk = validatePdsSessionPackageChunk(input.chunk, header);
      const bytes = Buffer.from(chunk.ciphertext, "base64url");
      if (bytes.length > PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES)
        throw publicError();
      const existing = await client.query(
        `select chunk_hash from pds_relay_chunks where transport_id=$1 and chunk_index=$2`,
        [transport.id, chunk.chunkIndex]
      );
      if (
        existing.rowCount &&
        row<{ chunk_hash: string }>(existing.rows[0]).chunk_hash !==
          chunk.chunkHash
      ) {
        throw securityError();
      }
      if (!existing.rowCount) {
        await client.query(
          `insert into pds_relay_chunks (transport_id,chunk_index,chunk_hash,ciphertext,ciphertext_bytes)
           values ($1,$2,$3,$4,$5)`,
          [
            transport.id,
            chunk.chunkIndex,
            chunk.chunkHash,
            chunk.ciphertext,
            bytes.length
          ]
        );
      }
      const missing = await missingChunks(
        client,
        transport.id as string,
        transport.chunk_count as string
      );
      await client.query("commit");
      return { missingChunks: missing };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async getPdsRelayTransportMetadata(
    input: PdsRelayAuthContext & { transportId: string }
  ): Promise<{
    transport: PdsRelayTransportRecord;
    header: unknown;
    envelopes: unknown;
  }> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await assertCurrentRelayAuth(client, input);
      const transport = await getRecipientTransport(
        client,
        auth,
        input.transportId
      );
      const header = parseCanonicalPdsJson(
        transport.canonical_header as string
      ) as PdsSessionPackageHeader;
      const response = {
        transport: transportRecord({
          ...transport,
          missing_chunks: await missingChunks(
            client,
            transport.id as string,
            transport.chunk_count as string
          )
        }),
        header,
        envelopes: parseCanonicalPdsJson(
          transport.canonical_envelopes as string
        )
      };
      await client.query("commit");
      return response;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async getPdsRelayChunk(
    input: PdsRelayAuthContext & { transportId: string; chunkIndex: string }
  ): Promise<PdsSessionPackageChunk> {
    if (!/^(0|[1-9][0-9]*)$/.test(input.chunkIndex)) throw publicError();
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await assertCurrentRelayAuth(client, input);
      const transport = await getRecipientTransport(
        client,
        auth,
        input.transportId
      );
      const header = parseCanonicalPdsJson(
        transport.canonical_header as string
      ) as PdsSessionPackageHeader;
      if (BigInt(input.chunkIndex) >= BigInt(header.chunkCount))
        throw publicError();
      const chunks = await client.query(
        `select chunk_index,chunk_hash,ciphertext,ciphertext_bytes from pds_relay_chunks
         where transport_id=$1 and chunk_index=$2 and ciphertext_bytes::numeric <= $3 limit 1`,
        [transport.id, input.chunkIndex, PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES]
      );
      if (!chunks.rowCount) throw publicError();
      const chunk = row<{
        chunk_index: string;
        chunk_hash: string;
        ciphertext: string;
        ciphertext_bytes: string;
      }>(chunks.rows[0]);
      if (
        number(chunk.ciphertext_bytes) > PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES
      ) {
        throw publicError();
      }
      const result = validatePdsSessionPackageChunk(
        {
          protocol: header.protocol,
          version: header.version,
          transportId: header.transportId,
          groupId: header.groupId,
          packageId: header.packageId,
          chunkIndex: chunk.chunk_index,
          chunkCount: header.chunkCount,
          ciphertext: chunk.ciphertext,
          chunkHash: chunk.chunk_hash
        },
        header
      );
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async commitPdsRelayTransport(
    input: PdsRelayAuthContext & { transportId: string; packageDigest: string }
  ): Promise<PdsRelayTransportRecord> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await assertCurrentRelayAuth(client, input);
      const found = await client.query(
        `select * from pds_relay_transports
         where group_id=$1 and transport_id=$2 and sender_device_id=$3 for update`,
        [auth.groupDbId, input.transportId, auth.deviceId]
      );
      if (!found.rowCount) throw publicError();
      const transport = row<Record<string, unknown>>(found.rows[0]);
      if (transport.state === "committed") {
        if (transport.package_digest !== input.packageDigest)
          throw securityError();
        await client.query("commit");
        return transportRecord({ ...transport, missing_chunks: [] });
      }
      const missing = await missingChunks(
        client,
        transport.id as string,
        transport.chunk_count as string
      );
      if (missing.length)
        throw securityError("PDS relay chunks are incomplete");
      const header = parseCanonicalPdsJson(
        transport.canonical_header as string
      ) as PdsSessionPackageHeader;
      const chunks = await client.query(
        `select chunk_index,chunk_hash,ciphertext from pds_relay_chunks
         where transport_id=$1 order by chunk_index::bigint`,
        [transport.id]
      );
      const payload = Buffer.concat(
        chunks.rows.map((entry) =>
          Buffer.from(
            row<{ ciphertext: string }>(entry).ciphertext,
            "base64url"
          )
        )
      );
      if (
        payload.length !== number(header.plaintextByteCount) ||
        hash(
          Buffer.concat([payload, Buffer.from(header.payloadTag, "base64url")])
        ) !== header.payloadCiphertextHash
      ) {
        throw securityError();
      }
      const actualDigest = hash(
        canonicalizePdsJson({
          header,
          envelopes: parseCanonicalPdsJson(
            transport.canonical_envelopes as string
          ),
          chunks: chunks.rows.map((entry) => {
            const item = row<{
              chunk_index: string;
              chunk_hash: string;
              ciphertext: string;
            }>(entry);
            return {
              protocol: header.protocol,
              version: header.version,
              transportId: header.transportId,
              groupId: header.groupId,
              packageId: header.packageId,
              chunkIndex: item.chunk_index,
              chunkCount: header.chunkCount,
              ciphertext: item.ciphertext,
              chunkHash: item.chunk_hash
            };
          })
        })
      );
      if (actualDigest !== input.packageDigest) throw securityError();
      await client.query(
        `update pds_relay_transports set state='committed',package_digest=$1,committed_at=now()
         where id=$2`,
        [input.packageDigest, transport.id]
      );
      await client.query("commit");
      return transportRecord({
        ...transport,
        package_digest: input.packageDigest,
        state: "committed",
        missing_chunks: []
      });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async listPdsRelayMailbox(
    input: PdsRelayAuthContext & { cursor?: string; limit: number }
  ): Promise<{
    transports: PdsRelayTransportRecord[];
    nextCursor: string | null;
  }> {
    const cursor = input.cursor ?? "";
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await assertCurrentRelayAuth(client, input);
      const result = await client.query(
        `select t.*,coalesce(array_agg(c.chunk_index order by c.chunk_index::bigint) filter (where c.chunk_index is not null),array[]::text[]) as received_chunks
         from pds_relay_transports t
         join pds_relay_recipients r on r.transport_id=t.id and r.recipient_device_id=$2
         left join pds_relay_chunks c on c.transport_id=t.id
         where t.group_id=$1 and t.state='committed' and t.expires_at>now() and t.transport_id>$3
           and r.acked_at is null and r.waived_at is null
         group by t.id order by t.transport_id limit $4`,
        [auth.groupDbId, auth.deviceId, cursor, input.limit + 1]
      );
      const values = result.rows.map((entry) => {
        const value = row<Record<string, unknown>>(entry);
        const have = new Set(value.received_chunks as string[]);
        return transportRecord({
          ...value,
          missing_chunks: Array.from(
            { length: number(value.chunk_count as string) },
            (_, index) => String(index)
          ).filter((index) => !have.has(index))
        });
      });
      const visible = values.slice(0, input.limit);
      await client.query("commit");
      return {
        transports: visible,
        nextCursor:
          values.length > input.limit
            ? (visible.at(-1)?.transportId ?? null)
            : null
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async acknowledgePdsRelayPackage(
    input: PdsRelayAuthContext & {
      ack: Record<string, unknown>;
      ackHash: string;
    }
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await assertCurrentRelayAuth(client, input);
      const { groupId, transportId, packageId, recipientDeviceId } = input.ack;
      if (
        groupId !== auth.groupId ||
        typeof transportId !== "string" ||
        typeof packageId !== "string" ||
        recipientDeviceId !== auth.deviceId
      ) {
        throw publicError();
      }
      const result = await client.query(
        `select t.*,r.id as recipient_id,r.ack_hash,r.waived_at
         from pds_relay_transports t
         join pds_relay_recipients r on r.transport_id=t.id and r.recipient_device_id=$4
         where t.group_id=$1 and t.transport_id=$2 and t.package_id=$3 and t.state='committed'
         for update of t,r`,
        [auth.groupDbId, transportId, packageId, auth.deviceId]
      );
      if (!result.rowCount) throw publicError();
      const found = row<Record<string, unknown>>(result.rows[0]);
      const header = parseCanonicalPdsJson(
        found.canonical_header as string
      ) as PdsSessionPackageHeader;
      if (
        found.waived_at ||
        new Date(header.expiresAt) <= new Date() ||
        found.sender_device_id !== header.servingDeviceId ||
        header.groupId !== auth.groupId ||
        header.transportId !== transportId ||
        header.packageId !== packageId ||
        !header.intendedRecipientSnapshot.includes(auth.deviceId) ||
        input.ack.sourceManifestHash !== header.sourceManifestHash ||
        input.ack.intendedRecipientSnapshotHash !==
          header.intendedRecipientSnapshotHash ||
        input.ack.relayAcceptedAt !==
          new Date(found.relay_accepted_at as Date).toISOString() ||
        new Date(input.ack.ackedAt as string) > new Date() ||
        new Date(input.ack.ackedAt as string) <
          new Date(found.relay_accepted_at as Date)
      ) {
        throw publicError();
      }
      if (found.ack_hash && found.ack_hash !== input.ackHash)
        throw securityError();
      if (!found.ack_hash) {
        await client.query(
          `update pds_relay_recipients set ack_hash=$1,acked_at=now() where id=$2`,
          [input.ackHash, found.recipient_id]
        );
      }
      const pending = await client.query(
        `select count(*)::int as count from pds_relay_recipients
         where transport_id=$1 and acked_at is null and waived_at is null`,
        [found.id]
      );
      if (row<{ count: number }>(pending.rows[0]).count === 0) {
        await client.query(
          `update pds_relay_transports set cleanup_after=now() + interval '7 days'
           where id=$1 and cleanup_after is null`,
          [found.id]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async listPdsRelayCursors(
    input: PdsRelayAuthContext
  ): Promise<Array<{ originDeviceId: string; sequence: string }>> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await assertCurrentRelayAuth(client, input);
      const result = await client.query(
        `select origin_device_id,sequence from pds_relay_cursors
         where group_id=$1 and recipient_device_id=$2 order by origin_device_id`,
        [auth.groupDbId, auth.deviceId]
      );
      await client.query("commit");
      return result.rows.map((entry) => {
        const value = row<{ origin_device_id: string; sequence: string }>(
          entry
        );
        return {
          originDeviceId: value.origin_device_id,
          sequence: value.sequence
        };
      });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async advancePdsRelayCursor(
    input: PdsRelayAuthContext & { originDeviceId: string; sequence: string }
  ): Promise<void> {
    if (
      !/^[A-Za-z0-9_-]{22}$/.test(input.originDeviceId) ||
      !/^(0|[1-9][0-9]*)$/.test(input.sequence)
    ) {
      throw publicError();
    }
    try {
      decodePdsBase64url(input.originDeviceId, 16);
    } catch {
      throw publicError();
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await assertCurrentRelayAuth(client, input);
      const origin = await client.query(
        `select 1 from personal_device_group_members
         where group_id=$1 and device_id=$2 and status='active' for share`,
        [auth.groupDbId, input.originDeviceId]
      );
      if (!origin.rowCount) throw publicError();
      const existing = await client.query(
        `select sequence from pds_relay_cursors
         where group_id=$1 and recipient_device_id=$2 and origin_device_id=$3 for update`,
        [auth.groupDbId, auth.deviceId, input.originDeviceId]
      );
      if (
        existing.rowCount &&
        BigInt(row<{ sequence: string }>(existing.rows[0]).sequence) >
          BigInt(input.sequence)
      ) {
        throw securityError("PDS relay cursor is not monotonic");
      }
      await client.query(
        `insert into pds_relay_cursors (group_id,recipient_device_id,origin_device_id,sequence)
         values ($1,$2,$3,$4)
         on conflict (group_id,recipient_device_id,origin_device_id)
         do update set sequence=excluded.sequence,updated_at=now()`,
        [auth.groupDbId, auth.deviceId, input.originDeviceId, input.sequence]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async getPdsLifecycleOperationalStatus(): Promise<
    PdsRelayOperationalStatus["lifecycle"]
  > {
    const result = await pool.query(
      `select
        (select count(*)::int from pds_tombstone_ledger) as tombstones,
        (select count(*)::int from pds_tombstone_acks where acked_at is null and waived_at is null) as pending_acks,
        (select count(*)::int from pds_deletion_floors) as floors,
        coalesce((select extract(epoch from now()-min(t.created_at))::int
          from pds_tombstone_ledger t join pds_tombstone_acks a on a.tombstone_id=t.id
          where a.acked_at is null and a.waived_at is null),0) as lag`
    );
    const value = row<Record<string, unknown>>(result.rows[0]);
    return {
      tombstones: Number(value.tombstones ?? 0),
      pendingTombstoneAcks: Number(value.pending_acks ?? 0),
      deletionFloors: Number(value.floors ?? 0),
      oldestTombstoneAckLagSeconds: Number(value.lag ?? 0)
    };
  },

  async getPdsRelayOperationalStatus(): Promise<PdsRelayOperationalStatus> {
    const result = await pool.query(
      `select
        count(*) filter (where state='uploading')::int as uploading,
        count(*) filter (where state='committed')::int as committed,
        count(*) filter (where state='expired')::int as expired,
        coalesce(sum(ciphertext_bytes::numeric) filter (where state in ('uploading','committed') and expires_at>now()),0)::bigint as ciphertext_bytes,
        (select count(*) from pds_relay_recipients r join pds_relay_transports t on t.id=r.transport_id where t.state='committed' and r.acked_at is null and r.waived_at is null)::int as pending_recipients,
        coalesce((select extract(epoch from now()-min(t.relay_accepted_at))::int from pds_relay_recipients r join pds_relay_transports t on t.id=r.transport_id where t.state='committed' and r.acked_at is null and r.waived_at is null),0) as ack_lag_seconds
       from pds_relay_transports`
    );
    const value = row<Record<string, unknown>>(result.rows[0]);
    const count = (key: string) => Number(value[key] ?? 0);
    return {
      transports: {
        uploading: count("uploading"),
        committed: count("committed"),
        expired: count("expired"),
        ciphertextBytes: count("ciphertext_bytes"),
        pendingRecipients: count("pending_recipients"),
        ackLagSeconds: count("ack_lag_seconds")
      },
      quota: {
        groupBytes: count("ciphertext_bytes"),
        groupLimitBytes: MAX_GROUP_BYTES
      },
      retries: { uploading: count("uploading"), expired: count("expired") },
      lifecycle: await this.getPdsLifecycleOperationalStatus()
    };
  },

  async cleanupPdsRelay(
    now = new Date()
  ): Promise<{ expired: number; deleted: number }> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update pds_tombstone_acks a set waived_at=now(),waiver_statement_hash=s.statement_hash
         from pds_tombstone_ledger t join personal_device_groups g on g.id=t.group_id
         join personal_device_group_members m on m.group_id=g.id and m.device_id=a.device_id
         join personal_device_group_statements s on s.group_id=g.id and s.sequence=m.revoked_sequence
         where a.tombstone_id=t.id and a.acked_at is null and a.waived_at is null
           and a.device_id=any(t.active_device_snapshot) and m.status='revoked'
           and s.kind in ('revoke-device','recover') and m.revoked_sequence::numeric>t.statement_sequence::numeric`
      );
      await client.query(
        `update pds_tombstone_ledger t set quorum_completed_at=coalesce(t.quorum_completed_at,now()),
          retain_until=coalesce(t.retain_until,now()+interval '30 days')
         where t.quorum_completed_at is null and not exists (
           select 1 from unnest(t.active_device_snapshot) d(device_id)
           left join pds_tombstone_acks a on a.tombstone_id=t.id and a.device_id=d.device_id
           where a.acked_at is null and a.waived_at is null
         )`
      );
      await client.query(
        `update pds_tombstone_ledger set encrypted_record='{}'::jsonb
         where retain_until is not null and retain_until <= $1 and encrypted_record <> '{}'::jsonb`,
        [now]
      );
      await client.query(
        `update pds_relay_recipients r set waived_at=now(),waiver_hash=s.statement_hash
         from pds_relay_transports t, personal_device_group_members m, personal_device_group_statements s
         where r.transport_id=t.id and m.group_id=t.group_id and m.device_id=r.recipient_device_id
           and s.group_id=m.group_id and s.sequence=m.revoked_sequence and r.acked_at is null
           and r.waived_at is null and m.status='revoked' and m.revoked_at > t.created_at`
      );
      await client.query(
        `update pds_relay_transports t set cleanup_after=now() + interval '7 days'
         where t.state='committed' and t.cleanup_after is null
           and not exists (select 1 from pds_relay_recipients r where r.transport_id=t.id and r.acked_at is null and r.waived_at is null)`
      );
      await client.query(
        `delete from pds_relay_chunks c using pds_relay_transports t
         where c.transport_id=t.id and t.state in ('uploading','committed') and t.expires_at <= $1`,
        [now]
      );
      const expired = await client.query(
        `update pds_relay_transports set state='expired',expired_at=coalesce(expired_at,now()),canonical_header=null,canonical_envelopes=null
         where state in ('uploading','committed') and expires_at <= $1`,
        [now]
      );
      await client.query(
        `delete from pds_relay_chunks c using pds_relay_transports t
         where c.transport_id=t.id and t.state='committed' and t.cleanup_after <= $1`,
        [now]
      );
      const deleted = await client.query(
        `update pds_relay_transports set state='expired',expired_at=coalesce(expired_at,now()),canonical_header=null,canonical_envelopes=null
         where state='committed' and cleanup_after <= $1`,
        [now]
      );
      await client.query(
        `delete from pds_relay_request_nonces where expires_at <= $1`,
        [now]
      );
      await client.query("commit");
      return {
        expired: expired.rowCount ?? 0,
        deleted: deleted.rowCount ?? 0
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
});

const missingChunks = async (
  client: pg.PoolClient,
  transportId: string,
  count: string
): Promise<string[]> => {
  const rows = await client.query(
    `select chunk_index from pds_relay_chunks where transport_id=$1`,
    [transportId]
  );
  const received = new Set(
    rows.rows.map((entry) => row<{ chunk_index: string }>(entry).chunk_index)
  );
  return Array.from({ length: number(count) }, (_, index) =>
    String(index)
  ).filter((index) => !received.has(index));
};
export type PersonalDeviceSyncRelayRepository = ReturnType<
  typeof createPersonalDeviceSyncRelayRepository
>;
