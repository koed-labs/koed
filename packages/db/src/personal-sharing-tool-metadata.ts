import type pg from "pg";
import {
  resolvePiToolProvenance,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import { decryptAuthorizedEncryptedFieldPayloadWithClient } from "./encrypted-payload-repository.js";
import type { ActorContext } from "./types.js";

type Event = { id: string; metadata: Record<string, unknown> | null };
type Source = {
  id: string;
  memory_event_id: string;
  raw_json: unknown;
  source_kind: string;
  source_event_type: string | null;
};
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Owner-only, read-time normalization. Never rewrite captured rows, semantic
 * hashes or sync history to repair a sharing preview. */
export const personalSharingToolMetadata = async (
  pool: pg.Pool,
  provider: EnvelopeEncryptionProvider | undefined,
  actor: ActorContext,
  events: Event[]
): Promise<Map<string, Record<string, unknown>>> => {
  if (!events.length) return new Map();
  const rows = await pool.query<Source>(
    `select ci.id,mes.memory_event_id,ci.source_kind,ci.source_event_type,ci.raw_json
     from memory_event_sources mes
     join memory_events me on me.id=mes.memory_event_id
     join sessions s on s.id=me.session_id and s.owner_user_id=me.owner_user_id
     join conversation_items ci on ci.id=mes.conversation_item_id
       and ci.owner_user_id=me.owner_user_id and ci.session_id=me.session_id
     where me.id=any($1::uuid[]) and me.owner_user_id=$2 and me.visibility='personal'
       and me.invalidated_at is null and me.personal_deleted_at is null
       and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
       and ci.visibility='personal' and ci.personal_deleted_at is null and ci.memory_excluded_at is null
       and ci.source_kind='pi' and ci.projection_status='projected'
       and ci.source_event_type in ('tool_call','tool_result','bash_execution')
     order by ci.id limit 5001`,
    [events.map((event) => event.id), actor.userId]
  );
  if (rows.rows.length > 5000)
    throw new Error("Sharing tool metadata exceeds its bounded source limit");
  const sources = new Map<string, Source>();
  for (const row of rows.rows) {
    const decrypted = provider
      ? await decryptAuthorizedEncryptedFieldPayloadWithClient(
          pool,
          actor,
          provider,
          {
            sourceTable: "conversation_items",
            sourceId: row.id,
            sourceColumn: "raw_json"
          }
        )
      : null;
    sources.set(`${row.memory_event_id}:${row.id}`, {
      ...row,
      raw_json: decrypted?.plaintext ?? row.raw_json
    });
  }
  const result = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const metadata = event.metadata ?? {};
    if (!Array.isArray(metadata.semanticItemManifest)) continue;
    const manifest = metadata.semanticItemManifest.map((value: unknown) => {
      const entry = object(value);
      if (
        !entry ||
        !Array.isArray(entry.sourceIds) ||
        typeof entry.sourceIds[0] !== "string"
      )
        return value;
      const primary = sources.get(`${event.id}:${entry.sourceIds[0]}`);
      if (!primary) return value;
      const identity = resolvePiToolProvenance({
        sourceKind: primary.source_kind,
        sourceEventType: primary.source_event_type,
        rawJson: primary.raw_json,
        toolName: typeof entry.toolName === "string" ? entry.toolName : null,
        toolCallId:
          typeof entry.toolCallId === "string" ? entry.toolCallId : null
      });
      return { ...entry, ...identity };
    });
    result.set(event.id, { ...metadata, semanticItemManifest: manifest });
  }
  return result;
};
