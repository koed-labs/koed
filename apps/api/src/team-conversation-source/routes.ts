import { createHash } from "node:crypto";
import type {
  DecryptedPrivacySanitizedSourceChunk,
  DeviceCredentialAuthContext,
  PrivacyClassificationRepository,
  PrivacySanitizedSourceChunkRecord,
  PrivacySanitizedSourceManifest,
  TeamConversationSourceAccessRecord
} from "@koed/db";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import { defaultFreshAuthenticationMaxAgeMs } from "@koed/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  openOpaqueCursor,
  sealOpaqueCursor
} from "../local-edge/opaque-cursor.js";
import type { ApiRouteContext } from "../server/context.js";
import {
  teamConversationSourceForkSnapshotBodySchema,
  teamConversationSourceManifestQuerySchema,
  teamConversationSourceParamsSchema,
  teamConversationSourceSegmentParamsSchema,
  teamConversationSourceStreamQuerySchema
} from "./schemas.js";

const STREAM_HEARTBEAT_MS = 15_000;
// Leave processing headroom inside the five-second authorization-loss bound.
const STREAM_MAX_AUTHORIZATION_RECHECK_MS = 4_000;
const STREAM_MAX_CLIENTS = 1_000;
const STREAM_MAX_CLIENTS_PER_PRINCIPAL = 6;
const STREAM_MAX_EVENT_BYTES = 32 * 1024;
const STREAM_CURSOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FORK_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const FORK_SNAPSHOT_MAX_SEGMENTS = 256;
const cursorPrefix = "tcs1";
const cursorDomain = "team-conversation-source";

const forbidden = () =>
  Object.assign(new Error("Team Conversation source is not authorized"), {
    statusCode: 403
  });

const notFound = () =>
  Object.assign(new Error("Team Conversation source was not found"), {
    statusCode: 404
  });

const conflict = (message: string) =>
  Object.assign(new Error(message), { statusCode: 409 });

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const cursorSchema = z
  .object({
    version: z.literal(1),
    viewerHash: z.string().regex(/^[a-f0-9]{64}$/),
    shareGrantId: z.uuid(),
    sourceArtifactId: z.uuid(),
    segmentIndex: z.number().int().min(-1),
    sourceEndByte: z.number().int().min(0),
    classifierHash: z.string().regex(/^[a-f0-9]{64}$/),
    effectivePolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive()
  })
  .strict();

const viewerHash = (userId: string): string =>
  sha256(`koed:team-conversation-source-viewer:v1\n${userId}`);

const safeSegment = (segment: PrivacySanitizedSourceChunkRecord) => ({
  id: segment.id,
  artifactId: segment.artifactId,
  segmentIndex: segment.chunkIndex,
  sourceStartByte: segment.sourceStartByte,
  sourceEndByte: segment.sourceEndByte,
  sanitizedByteLength: segment.sanitizedByteLength
});

const safeManifest = (
  access: TeamConversationSourceAccessRecord,
  manifest: PrivacySanitizedSourceManifest,
  segments: PrivacySanitizedSourceChunkRecord[]
) => ({
  transcriptAccess: {
    shareGrantId: access.grant.shareGrantId,
    sessionId: access.grant.sessionId,
    teamId: access.grant.teamId,
    teamWorkspaceId: access.grant.teamWorkspaceId,
    mode: access.grant.mode,
    maximumSegmentIndex: access.grant.maximumSegmentIndex,
    maximumSourceOffset: access.grant.maximumSourceOffset,
    version: access.grant.version,
    lifecycle: access.grant.lifecycle
  },
  artifact: {
    id: manifest.record.id,
    format: manifest.record.format,
    formatVersion: manifest.record.formatVersion,
    classifierHash: manifest.record.classifierHash,
    effectivePolicyHash: manifest.record.effectivePolicyHash,
    sourceFrontierHash: manifest.record.sourceFrontierHash,
    sourceFrontierCursor: manifest.record.sourceFrontierCursor,
    sourceSegmentCount: manifest.record.sourceSegmentCount,
    chunkCount: manifest.record.chunkCount,
    sanitizedByteCount: manifest.record.sanitizedByteCount,
    readyAt: manifest.record.readyAt
  },
  segments: segments.map(safeSegment)
});

const isCompletedTurnBoundary = (bytes: Uint8Array): boolean => {
  const lines = Buffer.from(bytes)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  try {
    const records = lines.map((line) => JSON.parse(line) as unknown);
    if (
      records.some(
        (record) =>
          !record || typeof record !== "object" || Array.isArray(record)
      )
    ) {
      return false;
    }
    const record = records.at(-1) as Record<string, unknown>;
    if (record.method === "turn/completed") return true;
    const payload = record.payload;
    const payloadType =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).type
        : null;
    return Boolean(
      record.type === "event_msg" &&
      typeof payloadType === "string" &&
      ["task_complete", "turn_aborted"].includes(payloadType)
    );
  } catch {
    return false;
  }
};

type AuthenticatedViewer = {
  id: string;
  email: string;
  displayName: string | null;
};

type StreamAuthentication = {
  viewer: AuthenticatedViewer;
  credentialKind: "session" | "device_credential";
  credentialId: string;
  expiresAt: number | null;
};

type StreamClient = {
  id: string;
  viewer: AuthenticatedViewer;
  reply: FastifyReply;
  shareGrantId: string;
  teamId: string;
  teamWorkspaceId: string;
  ownerUserId: string;
  sourceGrantId: string;
  artifactId: string;
  sourceArtifactId: string;
  classifierHash: string;
  effectivePolicyHash: string;
  segmentIndex: number;
  sourceEndByte: number;
  closed: boolean;
  flushing: boolean;
  pending: boolean;
  reauthenticate: () => Promise<StreamAuthentication>;
  authentication: StreamAuthentication;
  authorizationTimer: ReturnType<typeof setInterval> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  heartbeat: ReturnType<typeof setInterval>;
};

type ListenClient = {
  query(sql: string): Promise<unknown>;
  on(
    event: "notification",
    callback: (message: { channel: string; payload?: string }) => void
  ): void;
  on(event: "error", callback: (error: unknown) => void): void;
  release(): void;
};

type ListenPool = { connect(): Promise<ListenClient> };

const writeSse = async (
  client: StreamClient,
  event: string,
  payload: unknown,
  eventId?: string
): Promise<void> => {
  if (client.closed) return;
  const serialized = `${eventId ? `id: ${eventId}\n` : ""}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  if (Buffer.byteLength(serialized, "utf8") > STREAM_MAX_EVENT_BYTES) {
    throw conflict("Team Conversation source stream event is too large");
  }
  if (client.reply.raw.write(serialized)) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(conflict("Team Conversation source stream backpressure")),
      5_000
    );
    client.reply.raw.once("drain", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
};

export const createTeamConversationSourceService = (options: {
  app: FastifyInstance;
  context: ApiRouteContext;
  pool: ListenPool | null;
  privacyRepository: PrivacyClassificationRepository | null;
  teamEncryptionProvider?: EnvelopeEncryptionProvider;
  authorizationRecheckMs?: number;
}) => {
  const { app, context, pool } = options;
  const cursorSecret = context.config.collaborationRealtime.cursorSecret;
  const clients = new Map<string, StreamClient>();
  let listener: ListenClient | null = null;
  let listenerConnection: Promise<void> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const authorizationRecheckMs = Math.min(
    Math.max(
      Math.trunc(
        options.authorizationRecheckMs ?? STREAM_MAX_AUTHORIZATION_RECHECK_MS
      ),
      1
    ),
    STREAM_MAX_AUTHORIZATION_RECHECK_MS
  );

  const requirePrivacyBoundary = (): {
    repository: PrivacyClassificationRepository;
    provider: EnvelopeEncryptionProvider;
  } => {
    if (!options.privacyRepository || !options.teamEncryptionProvider) {
      throw Object.assign(
        new Error("Sanitized Team Conversation source is unavailable"),
        { statusCode: 503 }
      );
    }
    return {
      repository: options.privacyRepository,
      provider: options.teamEncryptionProvider
    };
  };

  const readSanitizedManifest = async (
    viewerId: string,
    shareGrantId: string
  ): Promise<PrivacySanitizedSourceManifest | null> => {
    const privacy = requirePrivacyBoundary();
    return privacy.repository.readLatestSanitizedSourceManifestByGrant({
      actor: { userId: viewerId },
      shareGrantId
    });
  };

  const readSanitizedChunk = async (input: {
    viewerId: string;
    shareGrantId: string;
    sanitizedArtifactId: string;
    chunkId: string;
  }): Promise<DecryptedPrivacySanitizedSourceChunk | null> => {
    const privacy = requirePrivacyBoundary();
    return privacy.repository.readSanitizedSourceChunkByGrant({
      actor: { userId: input.viewerId },
      provider: privacy.provider,
      shareGrantId: input.shareGrantId,
      sanitizedArtifactId: input.sanitizedArtifactId,
      chunkId: input.chunkId
    });
  };

  const authenticateViewer = async (
    request: FastifyRequest
  ): Promise<AuthenticatedViewer> =>
    context.auth.authenticateSessionOrDeviceCredential(
      request,
      "team_workspace_read",
      { apiTokenError: "API Tokens cannot read Team-shared transcripts" }
    );

  const authenticateStream = async (
    request: FastifyRequest
  ): Promise<StreamAuthentication> => {
    const viewer = await authenticateViewer(request);
    const scheme =
      request.headers.authorization?.trim().split(/\s+/, 1)[0]?.toLowerCase() ??
      "";
    if (scheme === "koed-device") {
      const auth: DeviceCredentialAuthContext | null =
        await context.auth.resolveDeviceCredentialContext(request);
      if (
        !auth ||
        auth.user.id !== viewer.id ||
        !auth.credential.operationFamilies.includes("team_workspace_read")
      ) {
        throw forbidden();
      }
      return {
        viewer: auth.user,
        credentialKind: "device_credential",
        credentialId: auth.credential.id,
        expiresAt: auth.credential.expiresAt
          ? new Date(auth.credential.expiresAt).getTime()
          : null
      };
    }
    const auth = await context.auth.authenticateSessionContext(request);
    if (auth.user.id !== viewer.id) throw forbidden();
    return {
      viewer: auth.user,
      credentialKind: "session",
      credentialId: auth.sessionId,
      expiresAt: auth.expiresAt.getTime()
    };
  };

  const createStreamReauthenticator = (
    request: FastifyRequest
  ): (() => Promise<StreamAuthentication>) => {
    const headers = { ...request.headers };
    const cookies = { ...request.cookies };
    return () => {
      const freshRequest = Object.create(request) as FastifyRequest;
      Object.defineProperties(freshRequest, {
        headers: { value: headers, enumerable: true },
        cookies: { value: cookies, enumerable: true }
      });
      return authenticateStream(freshRequest);
    };
  };

  const auditDenied = async (input: {
    viewerId: string;
    shareGrantId: string;
    operation: "manifest" | "segment" | "stream" | "fork_snapshot";
  }): Promise<void> => {
    await context.requireRepository().recordAuditEvent({
      actorUserId: input.viewerId,
      action: "team_conversation_source.access_denied",
      targetTable: "team_memory_share_grants",
      targetId: input.shareGrantId,
      metadata: { operation: input.operation }
    });
  };

  const auditStreamAuthorizationLoss = async (
    client: StreamClient
  ): Promise<void> => {
    await context.requireRepository().recordAuditEvent({
      actorUserId: client.viewer.id,
      ownerUserId: client.ownerUserId,
      visibility: "personal",
      action: "team_conversation_source.stream_authorization_lost",
      targetTable: "team_conversation_source_grants",
      targetId: client.sourceGrantId,
      metadata: {
        teamId: client.teamId,
        teamWorkspaceId: client.teamWorkspaceId,
        shareGrantId: client.shareGrantId
      }
    });
  };

  const closeClient = (
    client: StreamClient,
    reason: "access_revoked" | "server_shutdown" | "backpressure"
  ): void => {
    if (client.closed) return;
    client.closed = true;
    if (client.authorizationTimer) clearInterval(client.authorizationTimer);
    if (client.expiryTimer) clearTimeout(client.expiryTimer);
    client.authorizationTimer = null;
    client.expiryTimer = null;
    clearInterval(client.heartbeat);
    clients.delete(client.id);
    if (!client.reply.raw.destroyed) {
      client.reply.raw.write(
        `event: closed\ndata: ${JSON.stringify({ reason })}\n\n`
      );
      client.reply.raw.end();
    }
  };

  const closeForAuthorizationLoss = async (
    client: StreamClient
  ): Promise<void> => {
    if (client.closed) return;
    await auditStreamAuthorizationLoss(client).catch(() => undefined);
    closeClient(client, "access_revoked");
  };

  const flush = async (client: StreamClient): Promise<void> => {
    if (client.closed) return;
    if (client.flushing) {
      client.pending = true;
      return;
    }
    client.flushing = true;
    try {
      do {
        client.pending = false;
        let authentication: StreamAuthentication;
        try {
          authentication = await client.reauthenticate();
        } catch {
          await closeForAuthorizationLoss(client);
          return;
        }
        if (
          authentication.viewer.id !== client.viewer.id ||
          authentication.credentialKind !==
            client.authentication.credentialKind ||
          authentication.credentialId !== client.authentication.credentialId ||
          (authentication.expiresAt !== null &&
            authentication.expiresAt <= Date.now())
        ) {
          await closeForAuthorizationLoss(client);
          return;
        }
        client.authentication = authentication;
        const access = await context
          .requireRepository()
          .getTeamConversationSourceAccess(
            { userId: client.viewer.id },
            { shareGrantId: client.shareGrantId }
          );
        if (!access) {
          await closeForAuthorizationLoss(client);
          return;
        }
        const manifest = await readSanitizedManifest(
          client.viewer.id,
          client.shareGrantId
        );
        if (!manifest) {
          await closeForAuthorizationLoss(client);
          return;
        }
        const sameGeneration =
          manifest.record.sourceArtifactId === client.sourceArtifactId &&
          manifest.record.classifierHash === client.classifierHash &&
          manifest.record.effectivePolicyHash === client.effectivePolicyHash;
        if (!sameGeneration) {
          await writeSse(client, "generation_changed", {
            previousArtifactId: client.artifactId,
            artifactId: manifest.record.id,
            resumedAfterSourceByte: 0
          });
          client.segmentIndex = -1;
          client.sourceEndByte = 0;
        }
        client.artifactId = manifest.record.id;
        client.sourceArtifactId = manifest.record.sourceArtifactId;
        client.classifierHash = manifest.record.classifierHash;
        client.effectivePolicyHash = manifest.record.effectivePolicyHash;
        const page = manifest.chunks
          .filter((chunk) => chunk.sourceEndByte > client.sourceEndByte)
          .slice(0, 100);
        for (const segment of page) {
          const cursor = sealOpaqueCursor({
            secret: cursorSecret!,
            prefix: cursorPrefix,
            domain: cursorDomain,
            payload: {
              version: 1,
              viewerHash: viewerHash(client.viewer.id),
              shareGrantId: client.shareGrantId,
              sourceArtifactId: client.sourceArtifactId,
              segmentIndex: segment.chunkIndex,
              sourceEndByte: segment.sourceEndByte,
              classifierHash: client.classifierHash,
              effectivePolicyHash: client.effectivePolicyHash,
              expiresAt: Date.now() + STREAM_CURSOR_TTL_MS
            }
          });
          await writeSse(
            client,
            "segment_available",
            {
              cursor,
              segment: safeSegment(segment)
            },
            cursor
          );
          client.segmentIndex = segment.chunkIndex;
          client.sourceEndByte = segment.sourceEndByte;
        }
        if (page.length === 100) client.pending = true;
      } while (client.pending && !client.closed);
    } catch {
      closeClient(client, "backpressure");
    } finally {
      client.flushing = false;
    }
  };

  const wakeClients = (shareGrantId?: string): void => {
    for (const client of clients.values()) {
      if (!shareGrantId || client.shareGrantId === shareGrantId) {
        void flush(client);
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectListener();
    }, 500);
  };

  const connectListener = (): Promise<void> => {
    if (!pool || closed || listener) return Promise.resolve();
    if (listenerConnection) return listenerConnection;

    const establishListener = async (): Promise<void> => {
      let next: ListenClient | null = null;
      try {
        next = await pool.connect();
        if (closed) {
          next.release();
          return;
        }
        await next.query("listen koed_team_conversation_source");
        await next.query("listen koed_collaboration_realtime");
        if (closed) {
          await next.query("unlisten *").catch(() => undefined);
          next.release();
          return;
        }
        const activeListener = next;
        activeListener.on("notification", (message) => {
          if (message.channel === "koed_team_conversation_source") {
            try {
              const payload = JSON.parse(message.payload ?? "{}") as {
                shareGrantId?: unknown;
              };
              wakeClients(
                typeof payload.shareGrantId === "string"
                  ? payload.shareGrantId
                  : undefined
              );
            } catch {
              wakeClients();
            }
            return;
          }
          if (message.channel === "koed_collaboration_realtime") {
            try {
              const payload = JSON.parse(message.payload ?? "{}") as {
                teamId?: unknown;
              };
              const teamId =
                typeof payload.teamId === "string" ? payload.teamId : null;
              for (const client of clients.values()) {
                if (!teamId || client.teamId === teamId) void flush(client);
              }
            } catch {
              wakeClients();
            }
            return;
          }
          wakeClients();
        });
        activeListener.on("error", () => {
          if (listener === activeListener) {
            listener = null;
            activeListener.release();
            scheduleReconnect();
          }
        });
        listener = activeListener;
        next = null;
        // PostgreSQL is the durable source; replay anything committed while LISTEN was absent.
        wakeClients();
      } catch {
        next?.release();
        scheduleReconnect();
      }
    };
    const connection = establishListener();
    listenerConnection = connection;
    void connection.then(() => {
      if (listenerConnection === connection) listenerConnection = null;
    });
    return connection;
  };

  app.get(
    "/v1/shared-memory/share-grants/:shareGrantId/transcript/manifest",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const viewer = await authenticateViewer(request);
      const params = teamConversationSourceParamsSchema.parse(request.params);
      const query = teamConversationSourceManifestQuerySchema.parse(
        request.query
      );
      const access = await context
        .requireRepository()
        .getTeamConversationSourceAccess(
          { userId: viewer.id },
          { shareGrantId: params.shareGrantId }
        );
      if (!access) {
        await auditDenied({
          viewerId: viewer.id,
          shareGrantId: params.shareGrantId,
          operation: "manifest"
        });
        throw notFound();
      }
      const manifest = await readSanitizedManifest(
        viewer.id,
        params.shareGrantId
      );
      if (!manifest) {
        throw Object.assign(
          new Error("Sanitized Team Conversation source is not ready"),
          { statusCode: 503 }
        );
      }
      if (manifest.record.sourceArtifactId !== access.artifact.id) {
        throw conflict("Conversation Source changed before manifest read");
      }
      const segments = manifest.chunks
        .filter((chunk) => chunk.chunkIndex > query.afterSegmentIndex)
        .slice(0, query.limit);
      return safeManifest(access, manifest, segments);
    }
  );

  app.get(
    "/v1/shared-memory/share-grants/:shareGrantId/transcript/segments/:segmentId",
    { preHandler: context.rateLimit.memoryRead },
    async (request, reply) => {
      const viewer = await authenticateViewer(request);
      const params = teamConversationSourceSegmentParamsSchema.parse(
        request.params
      );
      const access = await context
        .requireRepository()
        .getTeamConversationSourceAccess(
          { userId: viewer.id },
          { shareGrantId: params.shareGrantId }
        );
      if (!access) {
        await auditDenied({
          viewerId: viewer.id,
          shareGrantId: params.shareGrantId,
          operation: "segment"
        });
        throw notFound();
      }
      const manifest = await readSanitizedManifest(
        viewer.id,
        params.shareGrantId
      );
      if (!manifest) {
        throw Object.assign(
          new Error("Sanitized Team Conversation source is not ready"),
          { statusCode: 503 }
        );
      }
      const sanitized = await readSanitizedChunk({
        viewerId: viewer.id,
        shareGrantId: params.shareGrantId,
        sanitizedArtifactId: manifest.record.id,
        chunkId: params.segmentId
      });
      if (!sanitized) throw notFound();
      const bytes = Buffer.from(sanitized.chunk.text, "utf8");
      const contentDigest = sha256(bytes);
      await context.requireRepository().recordAuditEvent({
        actorUserId: viewer.id,
        ownerUserId: access.grant.ownerUserId,
        visibility: "personal",
        action: "team_conversation_source.segment_read",
        targetTable: "team_conversation_source_grants",
        targetId: access.grant.id,
        metadata: {
          teamId: access.grant.teamId,
          teamWorkspaceId: access.grant.teamWorkspaceId,
          shareGrantId: access.grant.shareGrantId,
          segmentIndex: sanitized.chunk.record.chunkIndex,
          byteCount: bytes.byteLength,
          contentDigest
        }
      });
      return reply
        .header("cache-control", "no-store")
        .header("content-type", "application/x-ndjson")
        .header("x-koed-content-digest", contentDigest)
        .header(
          "x-koed-privacy-classifier-hash",
          manifest.record.classifierHash
        )
        .header(
          "x-koed-privacy-policy-hash",
          manifest.record.effectivePolicyHash
        )
        .send(bytes);
    }
  );

  app.post(
    "/v1/shared-memory/share-grants/:shareGrantId/transcript/fork-snapshot",
    { preHandler: context.rateLimit.memoryRead },
    async (request, reply) => {
      const session = await context.auth.authenticateSessionContext(request);
      const sessionAgeMs = Date.now() - session.createdAt.getTime();
      if (
        !Number.isFinite(sessionAgeMs) ||
        sessionAgeMs < 0 ||
        sessionAgeMs > defaultFreshAuthenticationMaxAgeMs
      ) {
        throw forbidden();
      }
      const viewer = session.user;
      const params = teamConversationSourceParamsSchema.parse(request.params);
      const input = teamConversationSourceForkSnapshotBodySchema.parse(
        request.body
      );
      const first = await context
        .requireRepository()
        .getTeamConversationSourceAccess(
          { userId: viewer.id },
          { shareGrantId: params.shareGrantId }
        );
      if (!first) {
        await auditDenied({
          viewerId: viewer.id,
          shareGrantId: params.shareGrantId,
          operation: "fork_snapshot"
        });
        throw notFound();
      }
      if (
        first.artifact.sourceGenerationId !== input.expectedSourceGenerationId
      ) {
        throw conflict("Conversation Source generation changed before export");
      }
      if (
        first.artifact.journalStartOffset !== 0 ||
        first.artifact.journalStartLine !== 0
      ) {
        throw conflict(
          "Fork snapshot requires a complete Conversation Source Artifact"
        );
      }
      const manifest = await readSanitizedManifest(
        viewer.id,
        params.shareGrantId
      );
      if (!manifest) {
        throw Object.assign(
          new Error("Sanitized Team Conversation source is not ready"),
          { statusCode: 503 }
        );
      }
      if (manifest.record.sourceArtifactId !== first.artifact.id) {
        throw conflict("Conversation Source changed before export");
      }
      const segments = manifest.chunks;
      if (segments.length > FORK_SNAPSHOT_MAX_SEGMENTS) {
        throw conflict("Fork snapshot exceeds the segment limit");
      }
      if (
        segments.length === 0 ||
        segments.at(-1)?.chunkIndex !== manifest.record.chunkCount - 1 ||
        segments[0]?.chunkIndex !== 0 ||
        segments.some((segment, index) => segment.chunkIndex !== index)
      ) {
        throw conflict("Fork snapshot source range is incomplete");
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for (const segment of segments) {
        const sanitized = await readSanitizedChunk({
          viewerId: viewer.id,
          shareGrantId: params.shareGrantId,
          sanitizedArtifactId: manifest.record.id,
          chunkId: segment.id
        });
        if (!sanitized) throw notFound();
        const bytes = Buffer.from(sanitized.chunk.text, "utf8");
        totalBytes += bytes.byteLength;
        if (totalBytes > FORK_SNAPSHOT_MAX_BYTES) {
          throw conflict("Fork snapshot exceeds the byte limit");
        }
        chunks.push(bytes);
      }
      const snapshot = Buffer.concat(chunks);
      if (!isCompletedTurnBoundary(snapshot)) {
        throw conflict("Fork snapshot must end at a completed turn boundary");
      }
      const snapshotDigest = sha256(snapshot);
      await context.requireRepository().recordAuditEvent({
        actorUserId: viewer.id,
        ownerUserId: first.grant.ownerUserId,
        visibility: "personal",
        action: "team_conversation_source.fork_snapshot_exported",
        targetTable: "team_conversation_source_grants",
        targetId: first.grant.id,
        metadata: {
          teamId: first.grant.teamId,
          teamWorkspaceId: first.grant.teamWorkspaceId,
          shareGrantId: first.grant.shareGrantId,
          parentSessionId: first.grant.sessionId,
          parentSanitizedArtifactId: manifest.record.id,
          throughSegmentIndex: segments.at(-1)?.chunkIndex ?? -1,
          sourceEndByte: segments.at(-1)?.sourceEndByte ?? 0,
          byteCount: snapshot.byteLength,
          snapshotDigest
        }
      });
      return reply
        .header("cache-control", "no-store")
        .header("content-type", "application/x-ndjson")
        .header("x-koed-parent-session-id", first.grant.sessionId)
        .header("x-koed-parent-sanitized-artifact-id", manifest.record.id)
        .header(
          "x-koed-parent-segment-index",
          segments.at(-1)?.chunkIndex ?? -1
        )
        .header("x-koed-snapshot-digest", snapshotDigest)
        .header(
          "x-koed-privacy-classifier-hash",
          manifest.record.classifierHash
        )
        .header(
          "x-koed-privacy-policy-hash",
          manifest.record.effectivePolicyHash
        )
        .send(snapshot);
    }
  );

  app.get(
    "/v1/shared-memory/share-grants/:shareGrantId/transcript/stream",
    { preHandler: context.rateLimit.memoryRead },
    async (request, reply) => {
      if (!pool || !cursorSecret) {
        throw Object.assign(
          new Error("Team Conversation source streaming is unavailable"),
          { statusCode: 503 }
        );
      }
      const authentication = await authenticateStream(request);
      const viewer = authentication.viewer;
      const params = teamConversationSourceParamsSchema.parse(request.params);
      const query = teamConversationSourceStreamQuerySchema.parse(
        request.query
      );
      const access = await context
        .requireRepository()
        .getTeamConversationSourceAccess(
          { userId: viewer.id },
          { shareGrantId: params.shareGrantId }
        );
      if (!access) {
        await auditDenied({
          viewerId: viewer.id,
          shareGrantId: params.shareGrantId,
          operation: "stream"
        });
        throw notFound();
      }
      const manifest = await readSanitizedManifest(
        viewer.id,
        params.shareGrantId
      );
      if (!manifest) {
        throw Object.assign(
          new Error("Sanitized Team Conversation source is not ready"),
          { statusCode: 503 }
        );
      }
      if (clients.size >= STREAM_MAX_CLIENTS) {
        throw Object.assign(new Error("Too many source stream clients"), {
          statusCode: 503
        });
      }
      const principalStreams = [...clients.values()].filter(
        (client) => client.viewer.id === viewer.id
      ).length;
      if (principalStreams >= STREAM_MAX_CLIENTS_PER_PRINCIPAL) {
        throw Object.assign(new Error("Too many source streams for User"), {
          statusCode: 429
        });
      }
      let segmentIndex = -1;
      let sourceEndByte = 0;
      const lastEventIdHeader = request.headers["last-event-id"];
      const lastEventId = Array.isArray(lastEventIdHeader)
        ? lastEventIdHeader[0]
        : lastEventIdHeader;
      const requestedCursor = query.cursor ?? lastEventId;
      if (requestedCursor) {
        const parsed = cursorSchema.safeParse(
          openOpaqueCursor({
            secret: cursorSecret,
            prefix: cursorPrefix,
            domain: cursorDomain,
            cursor: requestedCursor
          })
        );
        if (
          !parsed.success ||
          parsed.data.viewerHash !== viewerHash(viewer.id) ||
          parsed.data.shareGrantId !== params.shareGrantId
        ) {
          throw Object.assign(new Error("Source stream cursor is invalid"), {
            statusCode: 400
          });
        }
        if (parsed.data.expiresAt <= Date.now()) {
          throw Object.assign(new Error("Source stream cursor has expired"), {
            statusCode: 410
          });
        }
        const sameGeneration =
          parsed.data.sourceArtifactId === manifest.record.sourceArtifactId &&
          parsed.data.classifierHash === manifest.record.classifierHash &&
          parsed.data.effectivePolicyHash ===
            manifest.record.effectivePolicyHash;
        if (
          sameGeneration &&
          parsed.data.sourceEndByte > manifest.record.sourceFrontierCursor
        ) {
          throw Object.assign(new Error("Source stream cursor is invalid"), {
            statusCode: 400
          });
        }
        if (sameGeneration) {
          segmentIndex = parsed.data.segmentIndex;
          sourceEndByte = parsed.data.sourceEndByte;
        }
      }
      await context.requireRepository().recordAuditEvent({
        actorUserId: viewer.id,
        ownerUserId: access.grant.ownerUserId,
        visibility: "personal",
        action: "team_conversation_source.stream_opened",
        targetTable: "team_conversation_source_grants",
        targetId: access.grant.id,
        metadata: {
          teamId: access.grant.teamId,
          teamWorkspaceId: access.grant.teamWorkspaceId,
          shareGrantId: access.grant.shareGrantId,
          sanitizedArtifactId: manifest.record.id
        }
      });
      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      });
      const id = `${viewer.id}:${params.shareGrantId}:${Date.now()}:${Math.random()}`;
      const client: StreamClient = {
        id,
        viewer,
        reply,
        shareGrantId: params.shareGrantId,
        teamId: access.grant.teamId,
        teamWorkspaceId: access.grant.teamWorkspaceId,
        ownerUserId: access.grant.ownerUserId,
        sourceGrantId: access.grant.id,
        artifactId: manifest.record.id,
        sourceArtifactId: manifest.record.sourceArtifactId,
        classifierHash: manifest.record.classifierHash,
        effectivePolicyHash: manifest.record.effectivePolicyHash,
        segmentIndex,
        sourceEndByte,
        closed: false,
        flushing: false,
        pending: false,
        reauthenticate: createStreamReauthenticator(request),
        authentication,
        authorizationTimer: null,
        expiryTimer: null,
        heartbeat: setInterval(() => {
          if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
        }, STREAM_HEARTBEAT_MS)
      };
      clients.set(id, client);
      request.raw.once("close", () => closeClient(client, "server_shutdown"));
      await writeSse(client, "ready", {
        shareGrantId: params.shareGrantId,
        artifactId: manifest.record.id,
        afterSegmentIndex: segmentIndex,
        afterSourceByte: sourceEndByte
      });
      await flush(client);
      if (!client.closed) {
        client.authorizationTimer = setInterval(() => {
          void flush(client);
        }, authorizationRecheckMs);
        client.authorizationTimer.unref?.();
        if (authentication.expiresAt !== null) {
          const delay = Math.min(
            Math.max(authentication.expiresAt - Date.now(), 1),
            2_147_483_647
          );
          client.expiryTimer = setTimeout(() => {
            void flush(client);
          }, delay);
          client.expiryTimer.unref?.();
        }
      }
    }
  );

  void connectListener();

  return {
    async close(): Promise<void> {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      for (const client of [...clients.values()]) {
        closeClient(client, "server_shutdown");
      }
      await listenerConnection;
      if (listener) {
        const current = listener;
        listener = null;
        await current.query("unlisten *").catch(() => undefined);
        current.release();
      }
    }
  };
};
