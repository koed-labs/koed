import { isDeepStrictEqual } from "node:util";
import {
  canonicalConversationItemKey,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import { decryptAuthorizedEncryptedFieldPayloadWithClient } from "./encrypted-payload-repository.js";
import type pg from "pg";
import type {
  ActorContext,
  ConversationSourceArtifactRecord
} from "./types.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const invalid = (): never => {
  throw Object.assign(
    new Error("Managed terminal journal evidence is invalid"),
    {
      statusCode: 409,
      code: "managed_terminal_journal_invalid"
    }
  );
};

// Match the native adapters' display text so release also binds the text used by Projection.
const piText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(piText).filter(Boolean).join("\n");
  const block = record(value);
  return typeof block.text === "string"
    ? block.text
    : typeof block.thinking === "string"
      ? block.thinking
      : "";
};
const nativeText = (
  provider: "pi" | "claude",
  entry: Record<string, unknown>,
  value: unknown
): string | null => {
  if (provider === "claude" && typeof value === "string") return value || null;
  const block = record(value);
  if (provider === "pi") {
    const message = record(entry.message);
    if (message.role === "user") return piText(value) || null;
    if (message.role === "toolResult")
      return piText(message.content) || "Tool completed without text output.";
    if (message.role === "bashExecution")
      return `Command: ${typeof message.command === "string" ? message.command : ""}\n\n${typeof message.output === "string" ? message.output : ""}`;
    if (block.type === "toolCall")
      return `Tool call: ${typeof block.name === "string" ? block.name : "tool"}\n\nInput: ${JSON.stringify(block.arguments ?? {})}`;
    return piText(value) || null;
  }
  if (record(entry.origin).kind === "task-notification") return null;
  if (block.type === "tool_use")
    return `Tool call: ${typeof block.name === "string" && block.name.trim() ? block.name : "tool"}\n\nInput: ${JSON.stringify(block.input ?? {})}`;
  const text =
    typeof block.text === "string"
      ? block.text
      : typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content
              .map((value) =>
                typeof value === "string"
                  ? value
                  : typeof record(value).text === "string"
                    ? record(value).text
                    : ""
              )
              .filter(Boolean)
              .join("\n")
          : "";
  return (
    text ||
    (block.type === "tool_result"
      ? "Tool completed without text output."
      : null)
  );
};

type ItemIdentity = {
  turn: string;
  stable: string;
  block: unknown;
  text: string | null;
  source?: unknown;
};
type ControlBoundary = {
  turn: string;
  minimumOffset: number;
  maximumOffset: number;
  minimumLine: number;
  maximumLine: number;
};
/** Process-local capability, produced only after parsing digest-verified journal bytes. */
export interface VerifiedManagedJournalTerminal {
  readonly artifact: ConversationSourceArtifactRecord;
  readonly sourceOffset: number;
  readonly items: readonly ItemIdentity[];
  readonly controls: readonly ControlBoundary[];
}
const verified = new WeakSet<VerifiedManagedJournalTerminal>();

export function verifyManagedJournalTerminal(input: {
  artifact: ConversationSourceArtifactRecord;
  sourceOffset: number;
  bytes: Uint8Array;
}): VerifiedManagedJournalTerminal {
  const { artifact, sourceOffset } = input;
  if (
    !["claude-code", "pi"].includes(artifact.sourceKind) ||
    artifact.lifecycle === "deleted" ||
    artifact.journalStartOffset !== 0 ||
    artifact.journalStartLine !== 0 ||
    sourceOffset !== input.bytes.byteLength ||
    sourceOffset <= 0 ||
    sourceOffset > artifact.providerCursorOffset ||
    input.bytes.at(-1) !== 10
  )
    invalid();
  let entries: Record<string, unknown>[];
  const entryEnds: number[] = [];
  let parsedOffset = 0;
  try {
    entries = new TextDecoder("utf-8", { fatal: true })
      .decode(input.bytes)
      .split("\n")
      .slice(0, -1)
      .map((line) => {
        parsedOffset += Buffer.byteLength(line) + 1;
        entryEnds.push(parsedOffset);
        const entry = record(JSON.parse(line));
        if (typeof entry.type !== "string") invalid();
        return entry;
      });
  } catch {
    return invalid();
  }
  const proven = new Map<string, ItemIdentity>();
  const controls: ControlBoundary[] = [];
  const add = (items: ItemIdentity[]) => {
    for (const item of items) proven.set(JSON.stringify(item), item);
  };
  if (artifact.sourceKind === "claude-code") {
    let turn: string | undefined;
    let pending: ItemIdentity[] = [];
    let lastControl: ControlBoundary | undefined;
    for (const [entryIndex, entry] of entries.entries()) {
      if (
        entry.sessionId !== undefined &&
        entry.sessionId !== artifact.externalSessionId
      )
        invalid();
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      if (typeof entry.uuid !== "string" || !entry.uuid) invalid();
      const message = record(entry.message);
      const blocks: unknown[] = Array.isArray(message.content)
        ? message.content
        : [message.content ?? message];
      const human =
        entry.type === "user" &&
        blocks.some((block) => record(block).type !== "tool_result");
      if (human) {
        if (lastControl) {
          lastControl.maximumOffset = entryEnds[entryIndex - 1] ?? 0;
          lastControl.maximumLine = entryIndex;
          lastControl = undefined;
        }
        turn = String(entry.uuid);
        pending = [];
      }
      if (!turn) continue;
      pending.push(
        ...blocks.map((block, index) => ({
          block,
          text: nativeText("claude", entry, block),
          turn: turn!,
          stable: `${artifact.sourceComponentId}:${entry.uuid}:${index}`
        }))
      );
      if (
        entry.type === "assistant" &&
        ["end_turn", "stop_sequence", "max_tokens"].includes(
          String(message.stop_reason)
        )
      ) {
        add(pending);
        pending = [];
        if (artifact.sourceComponentId === "main") {
          lastControl = {
            turn,
            minimumOffset: entryEnds[entryIndex]!,
            maximumOffset: sourceOffset,
            minimumLine: entryIndex + 1,
            maximumLine: entries.length
          };
          controls.push(lastControl);
        }
      }
    }
    if (pending.length > 0) invalid();
  } else {
    const header = entries[0];
    if (
      header?.type !== "session" ||
      header.version !== 3 ||
      header.id !== artifact.externalSessionId
    )
      invalid();
    const nodes = new Map<string, Record<string, unknown>>();
    let terminal = false;
    for (const entry of entries.slice(1)) {
      if (typeof entry.id !== "string" || !entry.id || nodes.has(entry.id))
        invalid();
      nodes.set(String(entry.id), entry);
      const message = record(entry.message);
      if (entry.type === "message")
        terminal =
          message.role === "assistant" &&
          ["stop", "length", "error", "aborted"].includes(
            String(message.stopReason)
          );
      if (
        entry.type !== "message" ||
        message.role !== "assistant" ||
        !["stop", "length", "error", "aborted"].includes(
          String(message.stopReason)
        )
      )
        continue;
      const pending: ItemIdentity[] = [];
      let node: Record<string, unknown> | undefined = entry;
      const seen = new Set<string>();
      let foundUser = false;
      while (node) {
        const id = String(node.id);
        if (seen.has(id)) invalid();
        seen.add(id);
        const content = record(node.message);
        if (node.type === "message") {
          const blocks: unknown[] = Array.isArray(content.content)
            ? content.content
            : [content.content];
          pending.push(
            ...blocks.map((block, index) => ({
              block,
              text: nativeText("pi", node!, block),
              turn: typeof node!.parentId === "string" ? node!.parentId : id,
              stable: `${id}:${index}`,
              source:
                index === 0 || index === blocks.length - 1 ? node : undefined
            }))
          );
          if (content.role === "user") {
            foundUser = true;
            break;
          }
        }
        node =
          typeof node.parentId === "string"
            ? nodes.get(node.parentId)
            : undefined;
      }
      if (foundUser) add(pending);
    }
    if (!terminal) invalid();
  }
  if (proven.size === 0) invalid();
  const proof = Object.freeze({
    artifact: Object.freeze({ ...artifact }),
    sourceOffset,
    controls: Object.freeze(controls.map((control) => Object.freeze(control))),
    items: Object.freeze(
      [...proven.values()].map((item) => Object.freeze(item))
    )
  });
  verified.add(proof);
  return proof;
}

export async function releaseVerifiedManagedJournalItems(
  client: pg.PoolClient,
  actor: ActorContext,
  sessionId: string,
  proof: VerifiedManagedJournalTerminal,
  encryptionProvider?: EnvelopeEncryptionProvider
): Promise<{ conversationItemIds: string[] }> {
  if (
    !verified.has(proof) ||
    proof.artifact.ownerUserId !== actor.userId ||
    proof.artifact.sessionId !== sessionId
  )
    invalid();
  const artifact = proof.artifact;
  // Recheck authorization and generation after source I/O, in the release transaction.
  const locked = await client.query(
    `select id from conversation_source_artifacts
    where id = $1 and owner_user_id = $2 and session_id = $3
      and source_generation_id = $4 and source_kind = $5 and external_session_id = $6
      and lifecycle <> 'deleted' and provider_cursor_offset >= $7
    for share`,
    [
      artifact.id,
      actor.userId,
      sessionId,
      artifact.sourceGenerationId,
      artifact.sourceKind,
      artifact.externalSessionId,
      proof.sourceOffset
    ]
  );
  if (locked.rowCount !== 1) invalid();
  if (proof.items.length === 0) return { conversationItemIds: [] };
  const adapter =
    artifact.sourceKind === "pi"
      ? "pi-session-v1"
      : "claude-code-transcript-v1";
  const candidates = await client.query<{
    id: string;
    observation_id: string;
    raw_json: unknown;
    expected_block: unknown;
    expected_source: unknown;
    expected_text: string | null;
    raw_text: string | null;
    canonical_raw_json: unknown;
    canonical_raw_text: string | null;
  }>(
    `
    select ci.id, cio.id as observation_id, cio.raw_json, cio.raw_text, ci.raw_json as canonical_raw_json, ci.raw_text as canonical_raw_text, proof.block as expected_block, proof.source as expected_source, proof.text as expected_text
    from conversation_items ci
    join conversation_item_observations cio on cio.conversation_item_id = ci.id
      and cio.owner_user_id = ci.owner_user_id and cio.session_id = ci.session_id
      and cio.visibility = ci.visibility
    join jsonb_to_recordset($6::jsonb) as proof(turn text, stable text, block jsonb, source jsonb, text text)
      on cio.external_turn_id = proof.turn and cio.canonical_stable_item_id = proof.stable
    where ci.owner_user_id = $1 and ci.session_id = $2 and ci.visibility = 'personal'
      and ci.personal_deleted_at is null and ci.projection_status in ('pending', 'held')
      and ci.source_kind = $3 and ci.external_thread_id = $4
      and cio.external_thread_id = $4 and cio.source_adapter_version = $5
      and cio.source_transport = 'transcript' and cio.observation_kind = 'reconciliation'
      and cio.ingestion_status = 'persisted'
      and ci.external_turn_id = proof.turn and ci.canonical_stable_item_id = proof.stable
      and ci.canonical_item_key = cio.canonical_item_key
    for update of ci`,
    [
      actor.userId,
      sessionId,
      artifact.sourceKind,
      artifact.externalSessionId,
      adapter,
      JSON.stringify(proof.items)
    ]
  );
  const ids = new Set<string>();
  for (const candidate of candidates.rows) {
    const payloads: Array<{ raw: Record<string, unknown>; text: unknown }> = [];
    for (const row of [
      {
        table: "conversation_item_observations" as const,
        id: candidate.observation_id,
        raw: candidate.raw_json,
        text: candidate.raw_text
      },
      {
        table: "conversation_items" as const,
        id: candidate.id,
        raw: candidate.canonical_raw_json,
        text: candidate.canonical_raw_text
      }
    ]) {
      const read = async (
        column: "raw_json" | "raw_text",
        fallback: unknown
      ) => {
        const decrypted = encryptionProvider
          ? await decryptAuthorizedEncryptedFieldPayloadWithClient(
              client,
              actor,
              encryptionProvider,
              {
                sourceTable: row.table,
                sourceId: row.id,
                sourceColumn: column
              }
            )
          : null;
        return decrypted?.plaintext ?? fallback;
      };
      payloads.push({
        raw: record(await read("raw_json", row.raw)),
        text: await read("raw_text", row.text)
      });
    }
    const expectedType =
      artifact.sourceKind === "pi"
        ? "pi_session_record"
        : "claude_session_message";
    if (
      payloads.every(
        ({ raw, text }) =>
          raw.type === expectedType &&
          isDeepStrictEqual(raw.contentBlock, candidate.expected_block) &&
          (text || null) === candidate.expected_text &&
          (artifact.sourceKind !== "pi" ||
            raw.sourceRecord === undefined ||
            isDeepStrictEqual(raw.sourceRecord, candidate.expected_source))
      )
    )
      ids.add(candidate.id);
  }

  if (candidates.rows.some((row) => !ids.has(row.id))) invalid();
  for (const boundary of proof.controls) {
    const stable = `turn:${boundary.turn}:completed`;
    const key = canonicalConversationItemKey({
      provider: "claude-code",
      externalThreadId: artifact.externalSessionId,
      externalTurnId: boundary.turn,
      stableItemId: stable,
      component: "control"
    });
    const controls = await client.query<{
      id: string;
      observation_id: string;
      raw_json: unknown;
    }>(
      `
      select ci.id, cio.id as observation_id, cio.raw_json
      from conversation_items ci join conversation_item_observations cio on cio.conversation_item_id = ci.id
      where ci.owner_user_id = $1 and ci.session_id = $2 and ci.visibility = 'personal'
        and ci.personal_deleted_at is null and ci.projection_status in ('pending','held')
        and ci.canonical_item_key = $3 and ci.canonical_stable_item_id = $4
        and ci.external_turn_id = $5 and ci.external_thread_id = $6
        and cio.owner_user_id = ci.owner_user_id and cio.session_id = ci.session_id and cio.visibility = ci.visibility
        and cio.source_adapter_version = 'claude-code-hook-signal-v1' and cio.source_transport = 'hook_signal'
        and cio.source_event_type = 'turn_completed' and cio.observation_component = 'control'
        and cio.raw_text is null and cio.ingestion_status = 'persisted'
        and cio.canonical_item_key = ci.canonical_item_key and cio.canonical_stable_item_id = ci.canonical_stable_item_id
      for update of ci`,
      [
        actor.userId,
        sessionId,
        key,
        stable,
        boundary.turn,
        artifact.externalSessionId
      ]
    );
    for (const control of controls.rows) {
      const decrypted = encryptionProvider
        ? await decryptAuthorizedEncryptedFieldPayloadWithClient(
            client,
            actor,
            encryptionProvider,
            {
              sourceTable: "conversation_item_observations",
              sourceId: control.observation_id,
              sourceColumn: "raw_json"
            }
          )
        : null;
      const raw = record(decrypted?.plaintext ?? control.raw_json);
      const payload = record(raw.payload);
      if (
        raw.type !== "hook_signal" ||
        payload.type !== "turn_completed" ||
        !Number.isSafeInteger(payload.sourceFrontierOffset) ||
        !Number.isSafeInteger(payload.sourceFrontierLine) ||
        Number(payload.sourceFrontierOffset) < boundary.minimumOffset ||
        Number(payload.sourceFrontierOffset) > boundary.maximumOffset ||
        Number(payload.sourceFrontierLine) < boundary.minimumLine ||
        Number(payload.sourceFrontierLine) > boundary.maximumLine
      )
        invalid();
      ids.add(control.id);
    }
  }
  if (ids.size === 0) return { conversationItemIds: [] };
  const result = await client.query<{ id: string }>(
    `
    update conversation_items set projection_status = 'pending', projection_error = null, projected_at = null
    where id = any($1::uuid[]) and owner_user_id = $2 and session_id = $3
      and visibility = 'personal' and personal_deleted_at is null
      and projection_status in ('pending', 'held') returning id`,
    [[...ids], actor.userId, sessionId]
  );
  return { conversationItemIds: result.rows.map((row) => row.id) };
}
