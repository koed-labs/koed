import { createHash, verify } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  PDS_PROTOCOL,
  canonicalizePdsJson,
  decodePdsBase64url,
  parseCanonicalPdsJson,
  parsePdsRelayRequestProof,
  pdsRelayRequestNonceExpiresAt,
  verifyPdsRelayRequestProof
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";

const MAX_RAW_BYTES = 1024 * 1024;
type RawRequest = FastifyRequest & { pdsRelayRawBody?: Buffer };
const error = (message: string, statusCode = 400): Error =>
  Object.assign(new Error(message), { statusCode });
const unavailable = (): never => {
  throw error("PDS relay resource is unavailable", 404);
};
const rawBody = (request: RawRequest): Buffer =>
  request.pdsRelayRawBody ?? Buffer.alloc(0);
const requestTarget = (request: FastifyRequest): string => request.url;
const body = (request: RawRequest): Record<string, unknown> =>
  parseCanonicalPdsJson(rawBody(request).toString("utf8")) as Record<
    string,
    unknown
  >;
const headerValue = (request: FastifyRequest, name: string): string => {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length > MAX_RAW_BYTES * 2)
    throw unavailable();
  return Buffer.from(value, "base64url").toString("utf8");
};
const b64hash = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw error(`PDS relay ${label} is invalid`);
  decodePdsBase64url(value, 32);
  return value;
};

const authenticate = async (request: RawRequest, context: ApiRouteContext) => {
  if (
    request.headers["content-encoding"] &&
    request.headers["content-encoding"] !== "identity"
  )
    throw error("PDS relay compression is forbidden");
  const authorization =
    request.headers.authorization?.trim().toLowerCase() ?? "";
  if (
    authorization.startsWith("bearer ") ||
    authorization.startsWith("koed-device ")
  )
    throw error("PDS relay requires device request proof", 403);
  let proof;
  try {
    proof = parsePdsRelayRequestProof(
      headerValue(request, "x-pds-relay-proof")
    );
  } catch {
    throw error("PDS relay request proof is invalid", 403);
  }
  const certificate = headerValue(request, "x-pds-membership-certificate");
  const relay = context.requireRepository();
  let auth;
  try {
    auth = await relay.authenticatePdsRelayRequest({ certificate, proof });
  } catch {
    throw unavailable();
  }
  try {
    verifyPdsRelayRequestProof({
      proof,
      method: request.method,
      target: requestTarget(request),
      body: rawBody(request),
      signingPublicKey: auth.signingPublicKey
    });
  } catch {
    throw error("PDS relay request proof is invalid", 403);
  }
  await relay.consumePdsRelayRequestNonce({
    ...auth,
    nonce: proof.nonce,
    expiresAt: pdsRelayRequestNonceExpiresAt(proof.timestamp)
  });
  return { relay, auth };
};

const verifyAck = (
  ack: Record<string, unknown>,
  publicKey: string,
  signingKeyId: string
): void => {
  const expected = [
    "protocol",
    "groupId",
    "transportId",
    "packageId",
    "sourceManifestHash",
    "recipientDeviceId",
    "intendedRecipientSnapshotHash",
    "relayAcceptedAt",
    "ackedAt",
    "result",
    "signature"
  ].sort();
  const actual = Object.keys(ack).sort();
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index]) ||
    ack.protocol !== PDS_PROTOCOL ||
    ack.result !== "materialized"
  )
    throw error("PDS relay acknowledgement is invalid");
  for (const key of [
    "packageId",
    "sourceManifestHash",
    "intendedRecipientSnapshotHash"
  ])
    b64hash(ack[key], key);
  if (
    typeof ack.groupId !== "string" ||
    typeof ack.transportId !== "string" ||
    typeof ack.recipientDeviceId !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(ack.groupId) ||
    !/^[A-Za-z0-9_-]{22}$/.test(ack.transportId) ||
    !/^[A-Za-z0-9_-]{22}$/.test(ack.recipientDeviceId) ||
    typeof ack.relayAcceptedAt !== "string" ||
    typeof ack.ackedAt !== "string"
  )
    throw error("PDS relay acknowledgement is invalid");
  const signature = ack.signature as Record<string, unknown>;
  if (
    !signature ||
    signature.signerKeyId !== signingKeyId ||
    typeof signature.signature !== "string"
  )
    throw error("PDS relay acknowledgement is invalid");
  const unsigned = { ...ack };
  delete unsigned.signature;
  const valid = verify(
    null,
    Buffer.from(
      `${PDS_PROTOCOL}/package-ack\n${canonicalizePdsJson(unsigned)}`,
      "utf8"
    ),
    { key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" },
    Buffer.from(signature.signature, "base64url")
  );
  if (
    !valid ||
    !Number.isFinite(Date.parse(ack.relayAcceptedAt as string)) ||
    !Number.isFinite(Date.parse(ack.ackedAt as string))
  )
    throw error("PDS relay acknowledgement signature is invalid", 403);
};

export const registerPersonalDeviceSyncRelayRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (
      !new URL(request.url, "http://koed.local").pathname.startsWith(
        "/v1/personal-device-sync/relay/"
      )
    )
      return payload;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of payload) {
      const bytes = new Uint8Array(Buffer.from(chunk));
      size += bytes.length;
      if (size > MAX_RAW_BYTES)
        throw error("PDS relay request exceeds limit", 413);
      chunks.push(bytes);
    }
    const raw = Buffer.concat(chunks);
    (request as RawRequest).pdsRelayRawBody = raw;
    return Readable.from([new Uint8Array(raw)]);
  });

  const pre = { preHandler: context.rateLimit.memoryWrite };
  app.post(
    "/v1/personal-device-sync/relay/transports",
    pre,
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      const payload = body(request as RawRequest);
      return {
        transport: await input.relay.initializePdsRelayTransport({
          ...input.auth,
          requestHash: createHash("sha256")
            .update(rawBody(request as RawRequest))
            .digest("base64url"),
          transport: payload
        })
      };
    }
  );
  app.put(
    "/v1/personal-device-sync/relay/transports/:transportId/chunks/:chunkIndex",
    pre,
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      const params = request.params as {
        transportId: string;
        chunkIndex: string;
      };
      const payload = body(request as RawRequest);
      if (payload.chunkIndex !== params.chunkIndex)
        throw error("PDS relay chunk path is invalid");
      return input.relay.putPdsRelayChunk({
        ...input.auth,
        transportId: params.transportId,
        chunk: payload
      });
    }
  );
  app.post(
    "/v1/personal-device-sync/relay/transports/:transportId/commit",
    pre,
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      const payload = body(request as RawRequest);
      const packageDigest = b64hash(payload.packageDigest, "package digest");
      return {
        transport: await input.relay.commitPdsRelayTransport({
          ...input.auth,
          transportId: (request.params as { transportId: string }).transportId,
          packageDigest
        })
      };
    }
  );
  app.get(
    "/v1/personal-device-sync/relay/mailbox",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      const query = request.query as { cursor?: string; limit?: string };
      const parsed = Number(query.limit ?? "50");
      const limit =
        Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 50;
      return input.relay.listPdsRelayMailbox({
        ...input.auth,
        cursor: query.cursor,
        limit
      });
    }
  );
  app.get(
    "/v1/personal-device-sync/relay/transports/:transportId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      const value = await input.relay.getPdsRelayTransportMetadata({
        ...input.auth,
        transportId: (request.params as { transportId: string }).transportId
      });
      return {
        transport: value.transport,
        header: value.header,
        envelopes: value.envelopes
      };
    }
  );
  app.get(
    "/v1/personal-device-sync/relay/transports/:transportId/chunks/:chunkIndex",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      const params = request.params as {
        transportId: string;
        chunkIndex: string;
      };
      return {
        chunk: await input.relay.getPdsRelayChunk({
          ...input.auth,
          transportId: params.transportId,
          chunkIndex: params.chunkIndex
        })
      };
    }
  );
  app.post("/v1/personal-device-sync/relay/acks", pre, async (request) => {
    if (!context.personalDeviceSync.authoritySigner)
      throw error("Personal Device Sync relay is unavailable", 503);
    const input = await authenticate(request as RawRequest, context);
    const ack = body(request as RawRequest);
    verifyAck(ack, input.auth.signingPublicKey, input.auth.signingKeyId);
    await input.relay.acknowledgePdsRelayPackage({
      ...input.auth,
      ack,
      ackHash: createHash("sha256")
        .update(canonicalizePdsJson(ack))
        .digest("base64url")
    });
    return { accepted: true };
  });
  app.get(
    "/v1/personal-device-sync/relay/cursors",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      return { cursors: await input.relay.listPdsRelayCursors(input.auth) };
    }
  );
  app.put(
    "/v1/personal-device-sync/relay/cursors/:originDeviceId",
    pre,
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      const payload = body(request as RawRequest);
      if (
        typeof payload.sequence !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(payload.sequence) ||
        Object.keys(payload).length !== 1
      )
        throw error("PDS relay cursor is invalid");
      await input.relay.advancePdsRelayCursor({
        ...input.auth,
        originDeviceId: (request.params as { originDeviceId: string })
          .originDeviceId,
        sequence: payload.sequence
      });
      return { accepted: true };
    }
  );
};
