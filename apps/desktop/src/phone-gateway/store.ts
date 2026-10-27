/**
 * What the phone gateway keeps between restarts, in the Desktop's encrypted
 * secret store: whether phone access is on, the paired phones (only a hash of
 * each phone's token), their push tokens, and which Chat is the phone's
 * conversation with the Chief of Staff.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PdsDesktopSecretStore } from "../pds-secure-provider.js";

export const PHONE_GATEWAY_SECRET_REFERENCE = "koed-phone-gateway.v1";
export const DEFAULT_PHONE_GATEWAY_PORT = 47917;
const MAXIMUM_PHONES = 8;

const phoneSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(80),
    platform: z.enum(["ios", "android", "web", "other"]),
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/u),
    createdAt: z.string(),
    lastSeenAt: z.string().nullable(),
    expoPushToken: z.string().max(200).nullable()
  })
  .strict();

const chiefConversationSchema = z
  .object({
    projectId: z.string().min(1).max(512),
    threadId: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(512).nullable(),
    executionId: z.string().min(1).max(512),
    title: z.string().max(512),
    agentId: z.uuid()
  })
  .strict();

const stateSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    port: z.number().int().min(1024).max(65_535),
    phones: z.array(phoneSchema).max(MAXIMUM_PHONES),
    chiefConversation: chiefConversationSchema.nullable()
  })
  .strict();

export type PairedPhone = z.infer<typeof phoneSchema>;
export type PhoneChiefConversation = z.infer<typeof chiefConversationSchema>;
export type PhoneGatewayState = z.infer<typeof stateSchema>;

const emptyState = (): PhoneGatewayState => ({
  version: 1,
  enabled: false,
  port: DEFAULT_PHONE_GATEWAY_PORT,
  phones: [],
  chiefConversation: null
});

export const hashPhoneToken = (token: string): string =>
  createHash("sha256").update(`koed-phone-token:${token}`).digest("hex");

/** A new bearer token for a phone: 256 random bits, base64url. Only its hash is stored. */
export const newPhoneToken = (): string =>
  randomBytes(32).toString("base64url");

const sameHash = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

export interface PhoneGatewayStore {
  read(): Promise<PhoneGatewayState>;
  update(
    change: (state: PhoneGatewayState) => PhoneGatewayState
  ): Promise<PhoneGatewayState>;
  /** The paired phone that owns this bearer token, if any. */
  phoneForToken(token: string): Promise<PairedPhone | null>;
}

export const createPhoneGatewayStore = (
  secrets: PdsDesktopSecretStore,
  reference = PHONE_GATEWAY_SECRET_REFERENCE
): PhoneGatewayStore => {
  let cached: PhoneGatewayState | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<PhoneGatewayState> => {
    if (cached) return cached;
    const raw = await secrets.get(reference);
    if (!raw) return (cached = emptyState());
    try {
      cached = stateSchema.parse(JSON.parse(raw));
    } catch {
      // A damaged record never grants access: start over with phone access off.
      cached = emptyState();
    }
    return cached;
  };

  const read = () => load().then((state) => structuredClone(state));

  const update: PhoneGatewayStore["update"] = (change) => {
    const next = queue.then(async () => {
      const current = await load();
      const candidate = stateSchema.parse(change(structuredClone(current)));
      await secrets.put(reference, JSON.stringify(candidate));
      cached = candidate;
      return structuredClone(candidate);
    });
    queue = next.catch(() => undefined);
    return next;
  };

  const phoneForToken = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    const hash = hashPhoneToken(token);
    const state = await load();
    return (
      state.phones.find((phone) => sameHash(phone.tokenHash, hash)) ?? null
    );
  };

  return { read, update, phoneForToken };
};

export const MAXIMUM_PAIRED_PHONES = MAXIMUM_PHONES;
