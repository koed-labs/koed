import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  canonicalizePdsJson,
  decodePdsBase64url,
  parseCanonicalPdsJson,
  parsePdsRelayRequestProof,
  pdsRelayRequestNonceExpiresAt,
  verifyPdsRelayRequestProof,
  validatePdsPackageAck,
  validatePdsTombstoneAck
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

const authenticate = async (
  request: RawRequest,
  context: ApiRouteContext,
  allowStaleHead = false
) => {
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
    auth = await relay.authenticatePdsRelayRequest({
      certificate,
      proof,
      allowStaleHead
    });
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
  signingKeyId: string,
  groupId: string,
  deviceId: string
): void => {
  try {
    validatePdsPackageAck(ack, {
      signingPublicKey: publicKey,
      expectedSignerKeyId: signingKeyId,
      expectedGroupId: groupId,
      expectedDeviceId: deviceId
    });
  } catch {
    throw error("PDS relay acknowledgement signature is invalid", 403);
  }
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
    "/v1/personal-device-sync/relay/semantic-work/capabilities",
    pre,
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      const payload = body(request as RawRequest);
      if (
        payload.capability !== "projection" &&
        payload.capability !== "memory_embedding" &&
        payload.capability !== "lcm"
      ) {
        throw error("PDS device capability is invalid");
      }
      if (
        payload.readiness !== "ready" &&
        payload.readiness !== "busy" &&
        payload.readiness !== "unavailable"
      ) {
        throw error("PDS device readiness is invalid");
      }
      if (
        typeof payload.advertisedAt !== "string" ||
        typeof payload.expiresAt !== "string"
      ) {
        throw error("PDS device capability timestamp is invalid");
      }
      const advertisedAt = new Date(payload.advertisedAt);
      const expiresAt = new Date(payload.expiresAt);
      const now = Date.now();
      if (
        Number.isNaN(advertisedAt.getTime()) ||
        Number.isNaN(expiresAt.getTime()) ||
        Math.abs(advertisedAt.getTime() - now) > 60_000 ||
        expiresAt.getTime() <= now ||
        expiresAt.getTime() - advertisedAt.getTime() > 5 * 60_000
      ) {
        throw error("PDS device capability timestamp is invalid");
      }
      const canonicalRecord = rawBody(request as RawRequest).toString("utf8");
      return {
        accepted: await input.relay.advertisePdsRelayDeviceCapability({
          ...input.auth,
          capability: payload.capability,
          compatibilityContractHash: b64hash(
            payload.compatibilityContractHash,
            "compatibility contract hash"
          ),
          readiness: payload.readiness,
          canonicalRecord,
          recordHash: createHash("sha256")
            .update(canonicalRecord)
            .digest("base64url"),
          advertisedAt,
          expiresAt
        })
      };
    }
  );
  app.post(
    "/v1/personal-device-sync/relay/semantic-work/claims/acquire",
    pre,
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      const payload = body(request as RawRequest);
      const workClass = payload.workClass;
      if (
        workClass !== "projection" &&
        workClass !== "memory_embedding" &&
        workClass !== "lcm_leaf" &&
        workClass !== "lcm_rollup"
      ) {
        throw error("PDS semantic work class is invalid");
      }
      const leaseSeconds = Number(payload.leaseSeconds ?? 60);
      if (
        !Number.isSafeInteger(leaseSeconds) ||
        leaseSeconds < 5 ||
        leaseSeconds > 3600
      ) {
        throw error("PDS semantic work lease is invalid");
      }
      return {
        claim: await input.relay.acquirePdsRelaySemanticWorkClaim({
          ...input.auth,
          workIdentity: b64hash(payload.workIdentity, "work identity"),
          workClass,
          compatibilityContractHash: b64hash(
            payload.compatibilityContractHash,
            "compatibility contract hash"
          ),
          leaseSeconds
        })
      };
    }
  );
  app.post(
    "/v1/personal-device-sync/relay/semantic-work/claims/complete",
    pre,
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      const payload = body(request as RawRequest);
      if (
        typeof payload.claimGeneration !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(payload.claimGeneration)
      ) {
        throw error("PDS semantic work generation is invalid");
      }
      return {
        completed: await input.relay.completePdsRelaySemanticWorkClaim({
          ...input.auth,
          workIdentity: b64hash(payload.workIdentity, "work identity"),
          claimGeneration: payload.claimGeneration
        })
      };
    }
  );
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
    "/v1/personal-device-sync/relay/wake",
    { preHandler: context.rateLimit.memoryRead },
    async (request, reply) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context);
      const query = request.query as { transportId?: string | string[] };
      const transportIds = (
        Array.isArray(query.transportId)
          ? query.transportId
          : query.transportId
            ? [query.transportId]
            : []
      ).slice(0, 100);
      if (
        transportIds.some(
          (transportId) => !/^[A-Za-z0-9_-]{43}$/.test(transportId)
        )
      ) {
        throw error("PDS relay wake cursor is invalid", 400);
      }
      const pool = context.personalDeviceSync.wakePool;
      if (!pool) throw error("PDS relay wake is unavailable", 503);
      const client = await pool.connect();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let onReplyClose: (() => void) | null = null;
      try {
        await client.query("listen koed_pds_relay_wake");
        const pending = await input.relay.listPdsRelayMailbox({
          ...input.auth,
          limit: 1
        });
        if (
          pending.transports.length ||
          (await input.relay.hasPdsRelayAcknowledgement({
            ...input.auth,
            transportIds
          }))
        ) {
          return { wake: true };
        }
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          onReplyClose = done;
          client.on("notification", (message) => {
            if (
              message.channel === "koed_pds_relay_wake" &&
              message.payload === input.auth.groupId
            ) {
              done();
            }
          });
          reply.raw.once("close", done);
          timeout = setTimeout(done, 30 * 60_000);
          timeout.unref?.();
        });
        return { wake: true };
      } finally {
        if (timeout) clearTimeout(timeout);
        if (onReplyClose) reply.raw.off("close", onReplyClose);
        client.removeAllListeners("notification");
        await client
          .query("unlisten koed_pds_relay_wake")
          .catch(() => undefined);
        client.release();
      }
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
    verifyAck(
      ack,
      input.auth.signingPublicKey,
      input.auth.signingKeyId,
      input.auth.groupId,
      input.auth.deviceId
    );
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
    "/v1/personal-device-sync/relay/certificate",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context, true);
      return {
        certificate: parseCanonicalPdsJson(
          await input.relay.getPdsRelayCurrentCertificate(input.auth)
        )
      };
    }
  );
  app.get(
    "/v1/personal-device-sync/relay/lifecycle",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context, true);
      const query = request.query as { cursor?: string; limit?: string };
      const parsed = Number(query.limit ?? "50");
      const limit =
        Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 50;
      const lifecycle = await input.relay.getPdsLifecycleControl({
        ...input.auth,
        cursor:
          typeof query.cursor === "string" &&
          /^(0|[1-9][0-9]*)$/.test(query.cursor)
            ? query.cursor
            : "0",
        limit
      });
      return {
        authority_head: lifecycle.authorityHead,
        deletion_floors: lifecycle.deletionFloors,
        controls: lifecycle.controls.map((control) => ({
          sequence: control.sequence,
          kind: control.kind,
          record: parseCanonicalPdsJson(control.record),
          statement: parseCanonicalPdsJson(control.statement)
        })),
        next_cursor: lifecycle.nextCursor
      };
    }
  );
  app.post(
    "/v1/personal-device-sync/relay/tombstone-acks",
    pre,
    async (request) => {
      if (!context.personalDeviceSync.authoritySigner)
        throw error("Personal Device Sync relay is unavailable", 503);
      const input = await authenticate(request as RawRequest, context, true);
      const ack = body(request as RawRequest);
      if (typeof ack.tombstoneHash !== "string")
        throw error("PDS tombstone acknowledgement is invalid");
      const binding = await input.relay.getPdsTombstoneAckBinding({
        groupDbId: input.auth.groupDbId,
        tombstoneHash: ack.tombstoneHash
      });
      if (!binding) throw unavailable();
      validatePdsTombstoneAck(ack, {
        signingPublicKey: input.auth.signingPublicKey,
        expectedSignerKeyId: input.auth.signingKeyId,
        expectedGroupId: input.auth.groupId,
        expectedTombstoneHash: ack.tombstoneHash,
        expectedDeviceId: input.auth.deviceId,
        expectedStatementHash: binding.statement_hash
      });
      await input.relay.acknowledgePdsTombstone({
        groupId: input.auth.groupId,
        groupDbId: input.auth.groupDbId,
        tombstoneHash: ack.tombstoneHash,
        deviceId: input.auth.deviceId,
        canonicalAck: canonicalizePdsJson(ack),
        ackedAt: new Date(ack.ackedAt as string)
      });
      return { accepted: true };
    }
  );
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
