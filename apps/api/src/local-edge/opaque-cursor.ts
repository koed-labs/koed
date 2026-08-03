import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CURSOR_BYTES = 8_192;
const MAX_PAYLOAD_BYTES = 4_096;

const cursorKey = (secret: Uint8Array | string, domain: string): Buffer =>
  createHash("sha256")
    .update("koed:opaque-cursor-key:v1\n", "utf8")
    .update(secret)
    .update(`\n${domain}`, "utf8")
    .digest();

const associatedData = (prefix: string, domain: string): Buffer =>
  Buffer.from(`koed:opaque-cursor:${prefix}:${domain}:v1`, "utf8");

export const sealOpaqueCursor = (input: {
  secret: Uint8Array | string;
  prefix: string;
  domain: string;
  payload: unknown;
}): string => {
  const plaintext = Buffer.from(JSON.stringify(input.payload), "utf8");
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error("Cursor payload exceeds the maximum size");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(
    "aes-256-gcm",
    cursorKey(input.secret, input.domain),
    nonce
  );
  cipher.setAAD(associatedData(input.prefix, input.domain));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const sealed = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  return `${input.prefix}.${sealed.toString("base64url")}`;
};

export const openOpaqueCursor = (input: {
  secret: Uint8Array | string;
  prefix: string;
  domain: string;
  cursor: string;
}): unknown | null => {
  const match = new RegExp(`^${input.prefix}\\.([A-Za-z0-9_-]+)$`).exec(
    input.cursor
  );
  if (!match || input.cursor.length > MAX_CURSOR_BYTES) return null;
  try {
    const encoded = match[1]!;
    const sealed = Buffer.from(encoded, "base64url");
    if (
      sealed.toString("base64url") !== encoded ||
      sealed.length <= NONCE_BYTES + TAG_BYTES
    ) {
      return null;
    }
    const nonce = sealed.subarray(0, NONCE_BYTES);
    const tag = sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ciphertext = sealed.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cursorKey(input.secret, input.domain),
      nonce
    );
    decipher.setAAD(associatedData(input.prefix, input.domain));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    if (plaintext.length > MAX_PAYLOAD_BYTES) return null;
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    return null;
  }
};
