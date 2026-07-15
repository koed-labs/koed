import { createHash } from "node:crypto";
import pg from "pg";
import {
  canonicalizePdsJson,
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

export interface PdsRelayAuthContext {
  groupDbId: string;
  groupId: string;
  headHash: string;
  epoch: string;
  deviceId: string;
  signingKeyId: string;
  signingPublicKey: string;
  recipientDeviceIds: string[];
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
  expiresAt: new Date(value.expires_at as Date).toISOString()
});

export const createPersonalDeviceSyncRelayRepository = (pool: pg.Pool) => ({
  async authenticatePdsRelayRequest(input: {
    certificate: string;
    proof: PdsRelayRequestProof;
  }): Promise<PdsRelayAuthContext> {
    const certificate = parseCanonicalPdsJson(input.certificate) as Record<
      string,
      unknown
    >;
    const client = await pool.connect();
    try {
      const groupId = certificate.groupId;
      if (typeof groupId !== "string") throw publicError();
      const groupResult = await client.query(
        `select id,group_id,authority_public_key,current_epoch,head_hash,state,pending_epoch
         from personal_device_groups where group_id=$1`,
        [groupId]
      );
      if (!groupResult.rowCount) throw publicError();
      const group = row<Record<string, unknown>>(groupResult.rows[0]);
      if (
        group.state !== "active" ||
        group.pending_epoch !== null ||
        !certificateIsPdsValid(
          certificate,
          group.authority_public_key as string
        ) ||
        certificate.statementHash !== group.head_hash ||
        certificate.epoch !== group.current_epoch ||
        certificate.deviceId !== input.proof.deviceId ||
        certificate.deviceSigningKeyId !== input.proof.deviceSigningKeyId
      ) {
        throw publicError();
      }
      const memberResult = await client.query(
        `select device_id,signing_key_id,signing_public_key from personal_device_group_members
         where group_id=$1 and device_id=$2 and signing_key_id=$3 and status='active'`,
        [group.id, certificate.deviceId, certificate.deviceSigningKeyId]
      );
      if (!memberResult.rowCount) throw publicError();
      const member = row<Record<string, unknown>>(memberResult.rows[0]);
      if (member.signing_public_key !== certificate.deviceSigningPublicKey)
        throw publicError();
      const recipients = await client.query(
        `select device_id from personal_device_group_members where group_id=$1 and status='active' order by device_id`,
        [group.id]
      );
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
        )
      };
    } finally {
      client.release();
    }
  },

  async consumePdsRelayRequestNonce(
    input: PdsRelayAuthContext & { nonce: string; expiresAt: Date }
  ): Promise<void> {
    const result = await pool.query(
      `insert into pds_relay_request_nonces (group_id,device_id,nonce_digest,expires_at)
       values ($1,$2,$3,$4) on conflict do nothing returning id`,
      [
        input.groupDbId,
        input.deviceId,
        pdsRelayNonceDigest(input.nonce),
        input.expiresAt
      ]
    );
    if (!result.rowCount)
      throw securityError("PDS relay request nonce was already used");
  },

  async initializePdsRelayTransport(
    input: PdsRelayAuthContext & { requestHash: string; transport: unknown }
  ): Promise<PdsRelayTransportRecord> {
    const accepted = validatePdsRelayTransport(input.transport, {
      groupId: input.groupId,
      authorityHead: input.headHash,
      epoch: input.epoch,
      senderDeviceId: input.deviceId,
      senderSigningKeyId: input.signingKeyId,
      senderSigningPublicKey: input.signingPublicKey,
      recipientDeviceIds: input.recipientDeviceIds
    });
    const header = accepted.header;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        input.groupId
      ]);
      const existing = await client.query(
        `select * from pds_relay_transports where group_id=$1 and sender_device_id=$2 and transport_id=$3`,
        [input.groupDbId, input.deviceId, header.transportId]
      );
      if (existing.rowCount) {
        const item = row<Record<string, unknown>>(existing.rows[0]);
        if (item.request_hash !== input.requestHash) throw securityError();
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
      const headerExpiry = new Date(header.expiresAt);
      const acceptedAt = Date.now();
      if (
        headerExpiry.getTime() > acceptedAt + 30 * DAY ||
        headerExpiry.getTime() <= acceptedAt
      )
        throw securityError("PDS relay expiry is invalid");
      // Retention is fixed from acceptance. Header expiry can shorten serving,
      // but never extend encrypted-byte retention.
      const expiry = new Date(acceptedAt + 30 * DAY);
      const replay = await client.query(
        `select source_manifest_hash from pds_relay_transports where group_id=$1 and package_id=$2 limit 1`,
        [input.groupDbId, header.packageId]
      );
      if (
        replay.rowCount &&
        row<{ source_manifest_hash: string }>(replay.rows[0])
          .source_manifest_hash !== header.sourceManifestHash
      )
        throw securityError();
      const nonce = await client.query(
        `select id from pds_relay_transports where group_id=$1 and sender_device_id=$2 and payload_nonce=$3 limit 1`,
        [input.groupDbId, input.deviceId, header.payloadNonce]
      );
      if (nonce.rowCount)
        throw securityError("PDS relay payload nonce was reused");
      const groupUsage = await client.query(
        `select coalesce(sum(ciphertext_bytes::numeric),0)::text as bytes from pds_relay_transports where group_id=$1 and state in ('uploading','committed') and expires_at>now()`,
        [input.groupDbId]
      );
      const senderUsage = await client.query(
        `select coalesce(sum(ciphertext_bytes::numeric),0)::text as bytes from pds_relay_transports where group_id=$1 and sender_device_id=$2 and state in ('uploading','committed') and expires_at>now()`,
        [input.groupDbId, input.deviceId]
      );
      const expectedBytes = Number(header.plaintextByteCount);
      if (
        BigInt(row<{ bytes: string }>(groupUsage.rows[0]).bytes) +
          BigInt(expectedBytes) >
          BigInt(MAX_GROUP_BYTES) ||
        BigInt(row<{ bytes: string }>(senderUsage.rows[0]).bytes) +
          BigInt(expectedBytes) >
          BigInt(MAX_SENDER_BYTES)
      )
        throw Object.assign(new Error("PDS relay quota exceeded"), {
          statusCode: 429
        });
      const stored = await client.query(
        `insert into pds_relay_transports (group_id,transport_id,sender_device_id,origin_device_id,package_id,source_manifest_hash,version,content_epoch,recipient_epoch,authority_head,payload_nonce,payload_ciphertext_hash,payload_tag,plaintext_byte_count,chunk_count,ciphertext_bytes,expires_at,request_hash,canonical_header,canonical_envelopes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$14,$16,$17,$18,$19) returning *`,
        [
          input.groupDbId,
          header.transportId,
          input.deviceId,
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
          input.requestHash,
          canonicalizePdsJson(header),
          canonicalizePdsJson(accepted.envelopes)
        ]
      );
      const transport = row<Record<string, unknown>>(stored.rows[0]);
      for (const recipient of header.intendedRecipientSnapshot)
        await client.query(
          `insert into pds_relay_recipients (transport_id,recipient_device_id) values ($1,$2)`,
          [transport.id, recipient]
        );
      await client.query("commit");
      return transportRecord({
        ...transport,
        missing_chunks: Array.from(
          { length: Number(header.chunkCount) },
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
      const found = await client.query(
        `select * from pds_relay_transports where group_id=$1 and transport_id=$2 and sender_device_id=$3 for update`,
        [input.groupDbId, input.transportId, input.deviceId]
      );
      if (!found.rowCount) throw publicError();
      const transport = row<Record<string, unknown>>(found.rows[0]);
      if (
        transport.state !== "uploading" ||
        new Date(transport.expires_at as Date) <= new Date()
      )
        throw securityError("PDS relay transport is unavailable");
      const header = parseCanonicalPdsJson(
        transport.canonical_header as string
      ) as PdsSessionPackageHeader;
      const chunk = validatePdsSessionPackageChunk(input.chunk, header);
      const bytes = Buffer.from(chunk.ciphertext, "base64url");
      const existing = await client.query(
        `select chunk_hash from pds_relay_chunks where transport_id=$1 and chunk_index=$2`,
        [transport.id, chunk.chunkIndex]
      );
      if (
        existing.rowCount &&
        row<{ chunk_hash: string }>(existing.rows[0]).chunk_hash !==
          chunk.chunkHash
      )
        throw securityError();
      if (!existing.rowCount)
        await client.query(
          `insert into pds_relay_chunks (transport_id,chunk_index,chunk_hash,ciphertext,ciphertext_bytes) values ($1,$2,$3,$4,$5)`,
          [
            transport.id,
            chunk.chunkIndex,
            chunk.chunkHash,
            chunk.ciphertext,
            bytes.length
          ]
        );
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

  async getPdsRelayTransport(
    input: PdsRelayAuthContext & {
      transportId: string;
      recipientOnly?: boolean;
    }
  ): Promise<{
    transport: PdsRelayTransportRecord;
    header: unknown;
    envelopes: unknown;
    chunks?: PdsSessionPackageChunk[];
  }> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `select t.* from pds_relay_transports t ${input.recipientOnly ? "join pds_relay_recipients r on r.transport_id=t.id and r.recipient_device_id=$3" : ""} where t.group_id=$1 and t.transport_id=$2 and t.state='committed' and t.expires_at>now()`,
        input.recipientOnly
          ? [input.groupDbId, input.transportId, input.deviceId]
          : [input.groupDbId, input.transportId]
      );
      if (!result.rowCount) throw publicError();
      const transport = row<Record<string, unknown>>(result.rows[0]);
      const chunks = await client.query(
        `select chunk_index,chunk_hash,ciphertext from pds_relay_chunks where transport_id=$1 order by chunk_index::bigint`,
        [transport.id]
      );
      const header = parseCanonicalPdsJson(
        transport.canonical_header as string
      ) as PdsSessionPackageHeader;
      return {
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
        ),
        chunks: chunks.rows.map((item) => ({
          protocol: header.protocol,
          version: header.version,
          transportId: header.transportId,
          groupId: header.groupId,
          packageId: header.packageId,
          chunkIndex: row<{ chunk_index: string }>(item).chunk_index,
          chunkCount: header.chunkCount,
          ciphertext: row<{ ciphertext: string }>(item).ciphertext,
          chunkHash: row<{ chunk_hash: string }>(item).chunk_hash
        }))
      };
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
      const found = await client.query(
        `select * from pds_relay_transports where group_id=$1 and transport_id=$2 and sender_device_id=$3 for update`,
        [input.groupDbId, input.transportId, input.deviceId]
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
        `select chunk_index,chunk_hash,ciphertext from pds_relay_chunks where transport_id=$1 order by chunk_index::bigint`,
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
        payload.length !== Number(header.plaintextByteCount) ||
        hash(
          Buffer.concat([payload, Buffer.from(header.payloadTag, "base64url")])
        ) !== header.payloadCiphertextHash
      )
        throw securityError();
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
        `update pds_relay_transports set state='committed',package_digest=$1,committed_at=now() where id=$2`,
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
    const result = await pool.query(
      `select t.*,coalesce(array_agg(c.chunk_index order by c.chunk_index::bigint) filter (where c.chunk_index is not null),array[]::text[]) as received_chunks from pds_relay_transports t join pds_relay_recipients r on r.transport_id=t.id and r.recipient_device_id=$2 left join pds_relay_chunks c on c.transport_id=t.id where t.group_id=$1 and t.state='committed' and t.expires_at>now() and t.transport_id>$3 and r.acked_at is null and r.waived_at is null group by t.id order by t.transport_id limit $4`,
      [input.groupDbId, input.deviceId, cursor, input.limit + 1]
    );
    const values = result.rows.map((entry) => {
      const value = row<Record<string, unknown>>(entry);
      const have = new Set(value.received_chunks as string[]);
      return transportRecord({
        ...value,
        missing_chunks: Array.from(
          { length: Number(value.chunk_count) },
          (_, i) => String(i)
        ).filter((i) => !have.has(i))
      });
    });
    const more = values.length > input.limit;
    const visible = values.slice(0, input.limit);
    return {
      transports: visible,
      nextCursor: more ? (visible.at(-1)?.transportId ?? null) : null
    };
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
      const packageId = input.ack.packageId;
      const recipientDeviceId = input.ack.recipientDeviceId;
      if (typeof packageId !== "string" || recipientDeviceId !== input.deviceId)
        throw publicError();
      const result = await client.query(
        `select t.*,r.id as recipient_id,r.ack_hash,r.waived_at from pds_relay_transports t join pds_relay_recipients r on r.transport_id=t.id and r.recipient_device_id=$3 where t.group_id=$1 and t.package_id=$2 and t.state='committed' for update`,
        [input.groupDbId, packageId, input.deviceId]
      );
      if (!result.rowCount) throw publicError();
      const found = row<Record<string, unknown>>(result.rows[0]);
      const header = parseCanonicalPdsJson(
        found.canonical_header as string
      ) as PdsSessionPackageHeader;
      if (
        found.waived_at ||
        new Date(header.expiresAt) <= new Date() ||
        input.ack.sourceManifestHash !== header.sourceManifestHash ||
        input.ack.intendedRecipientSnapshotHash !==
          header.intendedRecipientSnapshotHash ||
        input.ack.relayAcceptedAt !==
          new Date(found.created_at as Date).toISOString() ||
        new Date(input.ack.ackedAt as string) > new Date() ||
        new Date(input.ack.ackedAt as string) <
          new Date(found.created_at as Date)
      )
        throw publicError();
      if (found.ack_hash && found.ack_hash !== input.ackHash)
        throw securityError();
      if (!found.ack_hash)
        await client.query(
          `update pds_relay_recipients set ack_hash=$1,acked_at=now() where id=$2`,
          [input.ackHash, found.recipient_id]
        );
      const pending = await client.query(
        `select count(*)::int as count from pds_relay_recipients where transport_id=$1 and acked_at is null and waived_at is null`,
        [found.id]
      );
      if (row<{ count: number }>(pending.rows[0]).count === 0)
        await client.query(
          `update pds_relay_transports set cleanup_after=now() + interval '7 days' where id=$1 and cleanup_after is null`,
          [found.id]
        );
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
    const result = await pool.query(
      `select origin_device_id,sequence from pds_relay_cursors where group_id=$1 and recipient_device_id=$2 order by origin_device_id`,
      [input.groupDbId, input.deviceId]
    );
    return result.rows.map((entry) => {
      const value = row<{ origin_device_id: string; sequence: string }>(entry);
      return {
        originDeviceId: value.origin_device_id,
        sequence: value.sequence
      };
    });
  },

  async advancePdsRelayCursor(
    input: PdsRelayAuthContext & { originDeviceId: string; sequence: string }
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `${input.groupId}:${input.deviceId}:${input.originDeviceId}`
      ]);
      const existing = await client.query(
        `select sequence from pds_relay_cursors where group_id=$1 and recipient_device_id=$2 and origin_device_id=$3 for update`,
        [input.groupDbId, input.deviceId, input.originDeviceId]
      );
      if (
        existing.rowCount &&
        BigInt(row<{ sequence: string }>(existing.rows[0]).sequence) >
          BigInt(input.sequence)
      )
        throw securityError("PDS relay cursor is not monotonic");
      await client.query(
        `insert into pds_relay_cursors (group_id,recipient_device_id,origin_device_id,sequence) values ($1,$2,$3,$4) on conflict (group_id,recipient_device_id,origin_device_id) do update set sequence=excluded.sequence,updated_at=now()`,
        [input.groupDbId, input.deviceId, input.originDeviceId, input.sequence]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async cleanupPdsRelay(
    now = new Date()
  ): Promise<{ expired: number; deleted: number }> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update pds_relay_recipients r set waived_at=now(),waiver_hash=s.statement_hash from pds_relay_transports t, personal_device_group_members m, personal_device_group_statements s where r.transport_id=t.id and m.group_id=t.group_id and m.device_id=r.recipient_device_id and s.group_id=m.group_id and s.sequence=m.revoked_sequence and r.acked_at is null and r.waived_at is null and m.status='revoked' and m.revoked_at > t.created_at`
      );
      await client.query(
        `update pds_relay_transports t set cleanup_after=now() + interval '7 days' where t.state='committed' and t.cleanup_after is null and not exists (select 1 from pds_relay_recipients r where r.transport_id=t.id and r.acked_at is null and r.waived_at is null)`
      );
      const expired = await client.query(
        `update pds_relay_transports set state='expired',expired_at=now(),canonical_envelopes='[]' where state in ('uploading','committed') and expires_at <= $1`,
        [now]
      );
      const deleted = await client.query(
        `delete from pds_relay_transports where cleanup_after <= $1 and state='committed'`,
        [now]
      );
      await client.query(
        `delete from pds_relay_request_nonces where expires_at <= $1`,
        [now]
      );
      await client.query("commit");
      return { expired: expired.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
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
  return Array.from({ length: Number(count) }, (_, index) =>
    String(index)
  ).filter((index) => !received.has(index));
};
export type PersonalDeviceSyncRelayRepository = ReturnType<
  typeof createPersonalDeviceSyncRelayRepository
>;
