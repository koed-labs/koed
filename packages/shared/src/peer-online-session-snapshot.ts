import { z } from "zod";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson
} from "./personal-device-sync-jcs.js";

/**
 * Decrypted plaintext of one peer-online checkpoint: the full append-only source
 * history of one origin Session. Only source facts travel; the receiver derives
 * local identifiers, transport, visibility and idempotency itself, so a peer
 * cannot choose them.
 */
export const PEER_ONLINE_SESSION_SNAPSHOT_PROTOCOL =
  "koed/peer-online-session-snapshot/v1";
export const PEER_ONLINE_SESSION_SNAPSHOT_MAX_ITEMS = 10000;

const text = (max: number) => z.string().min(1).max(max);
const optionalText = (max: number) => text(max).optional();
const instant = z.iso.datetime({ offset: true }).optional();
// PDS canonical JSON carries no JSON numbers, so integers travel as canonical
// decimal strings and raw source JSON travels as JSON text.
const safeInteger = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const jsonText = z
  .string()
  .min(1)
  .max(4 * 1024 * 1024)
  .refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  });

const itemSchema = z
  .object({
    sourceRecordType: text(200),
    sourceEventType: optionalText(200),
    sourceSequence: safeInteger.optional(),
    sourceLineNumber: safeInteger.optional(),
    externalThreadId: optionalText(500),
    externalTurnId: optionalText(500),
    externalItemId: optionalText(500),
    parentExternalItemId: optionalText(500),
    canonicalStableItemId: optionalText(500),
    eventTime: instant,
    observedAt: instant,
    observationKind: z
      .enum([
        "snapshot",
        "lifecycle_started",
        "lifecycle_completed",
        "control",
        "reconciliation"
      ])
      .optional(),
    observationComponent: optionalText(200),
    rawJson: jsonText,
    rawText: z
      .string()
      .max(4 * 1024 * 1024)
      .optional(),
    sourceHash: text(200)
  })
  .strict();

const snapshotSchema = z
  .object({
    protocol: z.literal(PEER_ONLINE_SESSION_SNAPSHOT_PROTOCOL),
    sourceSession: z
      .object({
        sourceKind: text(100),
        sourceAdapterVersion: text(100),
        externalSessionId: text(500)
      })
      .strict(),
    items: z.array(itemSchema).max(PEER_ONLINE_SESSION_SNAPSHOT_MAX_ITEMS)
  })
  .strict();

export type PeerOnlineSessionSnapshot = z.infer<typeof snapshotSchema>;
export type PeerOnlineSessionSnapshotItem = z.infer<typeof itemSchema>;

export function encodePeerOnlineSessionSnapshot(
  snapshot: Omit<PeerOnlineSessionSnapshot, "protocol">
): Buffer {
  const value = snapshotSchema.parse({
    protocol: PEER_ONLINE_SESSION_SNAPSHOT_PROTOCOL,
    ...snapshot
  });
  return Buffer.from(canonicalizePdsJson(value));
}

/** Returns undefined for anything that is not canonical, well-formed v1 plaintext. */
export function parsePeerOnlineSessionSnapshot(
  plaintext: Uint8Array
): PeerOnlineSessionSnapshot | undefined {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const parsed = snapshotSchema.safeParse(parseCanonicalPdsJson(decoded));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
