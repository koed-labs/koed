import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID
} from "node:crypto";
import { isPersonalDevicePairingUuid } from "./personal-device-pairing-link.js";

export const PERSONAL_DEVICE_PAIRING_PROTOCOL = "koed/pds-lan-pair/v1";
export const PERSONAL_DEVICE_PAIRING_MAX_PLAINTEXT_BYTES = 256 * 1_024;

export type PersonalDevicePairingEnvelope = {
  protocol: typeof PERSONAL_DEVICE_PAIRING_PROTOCOL;
  message_id: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const strictBase64url = (value: unknown, bytes?: number): Buffer => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Pairing message is invalid.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    (bytes !== undefined && decoded.length !== bytes) ||
    decoded.toString("base64url") !== value
  ) {
    throw new Error("Pairing message is invalid.");
  }
  return decoded;
};

const pairingKey = (invitationId: string, token: string): Buffer => {
  if (
    !isPersonalDevicePairingUuid(invitationId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(token)
  ) {
    throw new Error("Pairing credentials are invalid.");
  }
  const tokenBytes = strictBase64url(token, 32);
  const salt = createHash("sha256")
    .update(`${PERSONAL_DEVICE_PAIRING_PROTOCOL}\0${invitationId}`, "utf8")
    .digest();
  return Buffer.from(
    hkdfSync(
      "sha256",
      tokenBytes,
      salt,
      Buffer.from(`${PERSONAL_DEVICE_PAIRING_PROTOCOL}/transport-key`, "utf8"),
      32
    )
  );
};

const additionalData = (
  direction: "request" | "response",
  invitationId: string,
  messageId: string
): Buffer =>
  Buffer.from(
    `${PERSONAL_DEVICE_PAIRING_PROTOCOL}/${direction}\n${invitationId}\n${messageId}`,
    "utf8"
  );

const parseEnvelope = (value: unknown): PersonalDevicePairingEnvelope => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pairing message is invalid.");
  }
  const envelope = value as Record<string, unknown>;
  if (
    !exactKeys(envelope, [
      "protocol",
      "message_id",
      "nonce",
      "ciphertext",
      "tag"
    ]) ||
    envelope.protocol !== PERSONAL_DEVICE_PAIRING_PROTOCOL ||
    !isPersonalDevicePairingUuid(envelope.message_id)
  ) {
    throw new Error("Pairing message is invalid.");
  }
  strictBase64url(envelope.nonce, 12);
  strictBase64url(envelope.tag, 16);
  const ciphertext = strictBase64url(envelope.ciphertext);
  if (ciphertext.length > PERSONAL_DEVICE_PAIRING_MAX_PLAINTEXT_BYTES) {
    throw new Error("Pairing message is too large.");
  }
  return envelope as PersonalDevicePairingEnvelope;
};

export const encryptPersonalDevicePairingMessage = (
  input: Record<string, unknown>,
  options: {
    invitationId: string;
    token: string;
    direction: "request" | "response";
    messageId?: string;
  }
): PersonalDevicePairingEnvelope => {
  const plaintext = Buffer.from(JSON.stringify(input), "utf8");
  if (
    plaintext.length === 0 ||
    plaintext.length > PERSONAL_DEVICE_PAIRING_MAX_PLAINTEXT_BYTES
  ) {
    throw new Error("Pairing message is too large.");
  }
  const messageId = options.messageId ?? randomUUID();
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    pairingKey(options.invitationId, options.token),
    nonce
  );
  cipher.setAAD(
    additionalData(options.direction, options.invitationId, messageId)
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    protocol: PERSONAL_DEVICE_PAIRING_PROTOCOL,
    message_id: messageId,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
};

export const decryptPersonalDevicePairingMessage = (
  input: unknown,
  options: {
    invitationId: string;
    token: string;
    direction: "request" | "response";
  }
): { messageId: string; value: Record<string, unknown> } => {
  const envelope = parseEnvelope(input);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      pairingKey(options.invitationId, options.token),
      strictBase64url(envelope.nonce, 12)
    );
    decipher.setAAD(
      additionalData(
        options.direction,
        options.invitationId,
        envelope.message_id
      )
    );
    decipher.setAuthTag(strictBase64url(envelope.tag, 16));
    const plaintext = Buffer.concat([
      decipher.update(strictBase64url(envelope.ciphertext)),
      decipher.final()
    ]);
    if (
      plaintext.length === 0 ||
      plaintext.length > PERSONAL_DEVICE_PAIRING_MAX_PLAINTEXT_BYTES
    ) {
      throw new Error("Pairing message is too large.");
    }
    const value = JSON.parse(plaintext.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Pairing message is invalid.");
    }
    return {
      messageId: envelope.message_id,
      value: value as Record<string, unknown>
    };
  } catch {
    throw new Error("Pairing message authentication failed.");
  }
};
