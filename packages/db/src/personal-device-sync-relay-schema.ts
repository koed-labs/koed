import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { personalDeviceGroups } from "./schema.js";

const id = () => uuid("id").defaultRandom().primaryKey();
const now = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const pdsRelayTransports = pgTable(
  "pds_relay_transports",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    transportId: text("transport_id").notNull(),
    senderDeviceId: text("sender_device_id").notNull(),
    originDeviceId: text("origin_device_id").notNull(),
    packageId: text("package_id").notNull(),
    sourceManifestHash: text("source_manifest_hash").notNull(),
    version: text("version").notNull(),
    contentEpoch: text("content_epoch").notNull(),
    recipientEpoch: text("recipient_epoch").notNull(),
    authorityHead: text("authority_head").notNull(),
    payloadNonce: text("payload_nonce").notNull(),
    payloadCiphertextHash: text("payload_ciphertext_hash").notNull(),
    payloadTag: text("payload_tag").notNull(),
    plaintextByteCount: text("plaintext_byte_count").notNull(),
    chunkCount: text("chunk_count").notNull(),
    ciphertextBytes: text("ciphertext_bytes").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    requestHash: text("request_hash").notNull(),
    canonicalHeader: text("canonical_header").notNull(),
    canonicalEnvelopes: text("canonical_envelopes").notNull(),
    packageDigest: text("package_digest"),
    state: text("state").notNull().default("uploading"),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    cleanupAfter: timestamp("cleanup_after", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    createdAt: now()
  },
  (table) => [
    unique("pds_relay_transport_sender_unique").on(
      table.groupId,
      table.senderDeviceId,
      table.transportId
    ),
    index("pds_relay_transport_mailbox_idx").on(
      table.groupId,
      table.state,
      table.expiresAt
    ),
    check(
      "pds_relay_transport_state_check",
      sql`${table.state} in ('uploading','committed','expired','quarantined')`
    ),
    check(
      "pds_relay_transport_count_check",
      sql`${table.chunkCount} ~ '^(0|[1-9][0-9]*)$' and ${table.plaintextByteCount} ~ '^(0|[1-9][0-9]*)$' and ${table.ciphertextBytes} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);
export const pdsRelayChunks = pgTable(
  "pds_relay_chunks",
  {
    id: id(),
    transportId: uuid("transport_id")
      .notNull()
      .references(() => pdsRelayTransports.id, { onDelete: "cascade" }),
    chunkIndex: text("chunk_index").notNull(),
    chunkHash: text("chunk_hash").notNull(),
    ciphertext: text("ciphertext").notNull(),
    ciphertextBytes: text("ciphertext_bytes").notNull(),
    createdAt: now()
  },
  (table) => [
    unique("pds_relay_chunk_unique").on(table.transportId, table.chunkIndex),
    check(
      "pds_relay_chunk_index_check",
      sql`${table.chunkIndex} ~ '^(0|[1-9][0-9]*)$' and ${table.ciphertextBytes} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);
export const pdsRelayRecipients = pgTable(
  "pds_relay_recipients",
  {
    id: id(),
    transportId: uuid("transport_id")
      .notNull()
      .references(() => pdsRelayTransports.id, { onDelete: "cascade" }),
    recipientDeviceId: text("recipient_device_id").notNull(),
    ackHash: text("ack_hash"),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    waiverHash: text("waiver_hash"),
    waivedAt: timestamp("waived_at", { withTimezone: true }),
    createdAt: now()
  },
  (table) => [
    unique("pds_relay_recipient_unique").on(
      table.transportId,
      table.recipientDeviceId
    ),
    index("pds_relay_recipient_mailbox_idx").on(
      table.recipientDeviceId,
      table.ackedAt
    )
  ]
);
export const pdsRelayRequestNonces = pgTable(
  "pds_relay_request_nonces",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    nonceDigest: text("nonce_digest").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: now()
  },
  (table) => [
    unique("pds_relay_nonce_unique").on(
      table.groupId,
      table.deviceId,
      table.nonceDigest
    ),
    index("pds_relay_nonce_expiry_idx").on(table.expiresAt)
  ]
);
export const pdsRelayCursors = pgTable(
  "pds_relay_cursors",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => personalDeviceGroups.id, { onDelete: "cascade" }),
    recipientDeviceId: text("recipient_device_id").notNull(),
    originDeviceId: text("origin_device_id").notNull(),
    sequence: text("sequence").notNull(),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    unique("pds_relay_cursor_unique").on(
      table.groupId,
      table.recipientDeviceId,
      table.originDeviceId
    ),
    check(
      "pds_relay_cursor_sequence_check",
      sql`${table.sequence} ~ '^(0|[1-9][0-9]*)$'`
    )
  ]
);
