import {
  createHash,
  timingSafeEqual,
  verify,
  type KeyObject
} from "node:crypto";
import {
  PDS_PROTOCOL,
  decodePdsBase64url,
  pdsEd25519PublicKey
} from "./personal-device-sync.js";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson
} from "./personal-device-sync-jcs.js";

export const PDS_RELAY_REQUEST_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const PDS_RELAY_REQUEST_NONCE_BYTES = 32;

type JsonRecord = Record<string, unknown>;

export interface PdsRelayRequestProof {
  protocol: typeof PDS_PROTOCOL;
  deviceId: string;
  deviceSigningKeyId: string;
  timestamp: string;
  nonce: string;
  bodyDigest: string;
  signature: string;
}

const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new TypeError(`PDS relay ${label} is invalid`);
  }
  decodePdsBase64url(value, 16);
  return value;
};

const timestamp = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError("PDS relay timestamp is invalid");
  }
  return value;
};

const base64 = (value: unknown, bytes: number, label: string): string => {
  if (typeof value !== "string")
    throw new TypeError(`PDS relay ${label} is invalid`);
  decodePdsBase64url(value, bytes);
  return value;
};

export const pdsRelayBodyDigest = (body: Uint8Array): string =>
  createHash("sha256").update(body).digest("base64url");

export const pdsRelayNonceDigest = (nonce: string): string => {
  base64(nonce, PDS_RELAY_REQUEST_NONCE_BYTES, "nonce");
  return createHash("sha256").update(nonce, "utf8").digest("hex");
};

const encodeTargetPart = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );

/** Canonical path plus sorted, percent-normalized query for request signatures. */
export const canonicalizePdsRelayRequestTarget = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value, "http://koed.local");
  } catch (error) {
    throw new TypeError("PDS relay request target is invalid", {
      cause: error
    });
  }
  const path = parsed.pathname
    .split("/")
    .map((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch (error) {
        throw new TypeError("PDS relay request target is invalid", {
          cause: error
        });
      }
      if (decoded.includes("/") || decoded.includes("\\")) {
        throw new TypeError("PDS relay request target is invalid");
      }
      return encodeTargetPart(decoded);
    })
    .join("/");
  const query = [...parsed.searchParams.entries()]
    .map(
      ([key, queryValue]) =>
        [encodeTargetPart(key), encodeTargetPart(queryValue)] as const
    )
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue.localeCompare(rightValue)
        : leftKey.localeCompare(rightKey)
    );
  return query.length
    ? `${path}?${query.map(([key, queryValue]) => `${key}=${queryValue}`).join("&")}`
    : path;
};

export const pdsRelayRequestSigningBytes = (
  input: Omit<PdsRelayRequestProof, "protocol" | "signature"> & {
    method: string;
    target: string;
  }
): Buffer => {
  if (!/^[A-Z]+$/.test(input.method)) {
    throw new TypeError("PDS relay request target is invalid");
  }
  return Buffer.from(
    `${PDS_PROTOCOL}/relay-request\n${canonicalizePdsJson({
      method: input.method,
      target: canonicalizePdsRelayRequestTarget(input.target),
      bodyDigest: base64(input.bodyDigest, 32, "body digest"),
      timestamp: timestamp(input.timestamp),
      nonce: base64(input.nonce, PDS_RELAY_REQUEST_NONCE_BYTES, "nonce"),
      deviceId: id(input.deviceId, "device ID"),
      deviceSigningKeyId: id(input.deviceSigningKeyId, "signing key ID")
    })}`,
    "utf8"
  );
};

export const parsePdsRelayRequestProof = (
  raw: string | Uint8Array
): PdsRelayRequestProof => {
  const bytes =
    typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
  const parsed = parseCanonicalPdsJson(bytes.toString("utf8")) as JsonRecord;
  const fields = Object.keys(parsed).sort();
  const expected = [
    "protocol",
    "deviceId",
    "deviceSigningKeyId",
    "timestamp",
    "nonce",
    "bodyDigest",
    "signature"
  ].sort();
  if (
    fields.length !== expected.length ||
    fields.some((field, index) => field !== expected[index])
  ) {
    throw new TypeError("PDS relay request proof fields are invalid");
  }
  if (parsed.protocol !== PDS_PROTOCOL)
    throw new TypeError("PDS relay request protocol is invalid");
  return {
    protocol: PDS_PROTOCOL,
    deviceId: id(parsed.deviceId, "device ID"),
    deviceSigningKeyId: id(parsed.deviceSigningKeyId, "signing key ID"),
    timestamp: timestamp(parsed.timestamp),
    nonce: base64(parsed.nonce, PDS_RELAY_REQUEST_NONCE_BYTES, "nonce"),
    bodyDigest: base64(parsed.bodyDigest, 32, "body digest"),
    signature: base64(parsed.signature, 64, "signature")
  };
};

export const pdsRelayRequestNonceExpiresAt = (
  proofTimestamp: string,
  now = new Date()
): Date => {
  const requestTime = new Date(timestamp(proofTimestamp)).getTime();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("PDS relay clock is invalid");
  }
  return new Date(
    Math.min(
      requestTime + PDS_RELAY_REQUEST_CLOCK_SKEW_MS,
      now.getTime() + PDS_RELAY_REQUEST_CLOCK_SKEW_MS
    )
  );
};

export const verifyPdsRelayRequestProof = (input: {
  proof: PdsRelayRequestProof;
  method: string;
  target: string;
  body: Uint8Array;
  signingPublicKey: string | Buffer | KeyObject;
  now?: Date;
}): void => {
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new TypeError("PDS relay clock is invalid");
  const proof = input.proof;
  const actualDigest = pdsRelayBodyDigest(input.body);
  if (
    !timingSafeEqual(Buffer.from(actualDigest), Buffer.from(proof.bodyDigest))
  ) {
    throw new TypeError("PDS relay request body digest is invalid");
  }
  const requestTime = new Date(proof.timestamp).getTime();
  if (Math.abs(now.getTime() - requestTime) > PDS_RELAY_REQUEST_CLOCK_SKEW_MS) {
    throw new TypeError("PDS relay request timestamp is outside allowed skew");
  }
  const key =
    input.signingPublicKey instanceof Object && "type" in input.signingPublicKey
      ? input.signingPublicKey
      : pdsEd25519PublicKey(input.signingPublicKey as string | Buffer);
  if (
    !verify(
      null,
      pdsRelayRequestSigningBytes({
        ...proof,
        method: input.method,
        target: input.target
      }),
      key,
      decodePdsBase64url(proof.signature, 64)
    )
  ) {
    throw new TypeError("PDS relay request proof signature is invalid");
  }
};
