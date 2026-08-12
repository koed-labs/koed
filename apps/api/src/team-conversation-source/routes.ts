import { createHash } from "node:crypto";
import type {
  ConversationSourceSegmentRecord,
  DeviceCredentialAuthContext,
  TeamConversationSourceAccessRecord
} from "@koed/db";
import { defaultFreshAuthenticationMaxAgeMs } from "@koed/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  openOpaqueCursor,
  sealOpaqueCursor
} from "../local-edge/opaque-cursor.js";
import { readConversationSourceSegmentBytes } from "../memory/conversation-source-journal-routes.js";
import { createFilesystemConversationSourceStorage } from "../memory/conversation-source-storage.js";
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
    artifactId: z.uuid(),
    segmentIndex: z.number().int().min(-1),
    contentDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    expiresAt: z.number().int().positive()
  })
  .strict();

const viewerHash = (userId: string): string =>
  sha256(`koed:team-conversation-source-viewer:v1\n${userId}`);

const safeSegment = (segment: ConversationSourceSegmentRecord) => ({
  id: segment.id,
  artifactId: segment.artifactId,
  segmentIndex: segment.segmentIndex,
  sourceStartOffset: segment.sourceStartOffset,
  sourceEndOffset: segment.sourceEndOffset,
  sourceStartLine: segment.sourceStartLine,
  sourceEndLine: segment.sourceEndLine,
  plaintextDigest: segment.plaintextDigest,
  plaintextSize: segment.plaintextSize,
  manifestDigest: segment.manifestDigest,
  previousContentDigest: segment.previousContentDigest,
  contentDigest: segment.contentDigest,
  sealedAt: segment.sealedAt
});

const safeManifest = (
  access: TeamConversationSourceAccessRecord,
  segments: ConversationSourceSegmentRecord[]
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
    id: access.artifact.id,
    logicalSourceId: access.artifact.logicalSourceId,
    sourceGenerationId: access.artifact.sourceGenerationId,
    sourceKind: access.artifact.sourceKind,
    sourceRuntime: access.artifact.sourceRuntime,
    artifactFormat: access.artifact.artifactFormat,
    artifactFormatVersion: access.artifact.artifactFormatVersion,
    lifecycle: access.artifact.lifecycle,
    journalStartOffset: access.artifact.journalStartOffset,
    journalStartLine: access.artifact.journalStartLine,
    providerCursorOffset: access.artifact.providerCursorOffset,
    providerCursorLine: access.artifact.providerCursorLine,
    currentJournalSequence: access.artifact.currentJournalSequence,
    closureHash: access.artifact.closureHash,
    createdAt: access.artifact.createdAt,
    updatedAt: access.artifact.updatedAt,
    finalizedAt: access.artifact.finalizedAt
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

const readVerifiedSourceSegment = async (
  context: ApiRouteContext,
  storage: ReturnType<typeof createFilesystemConversationSourceStorage>,
  segment: ConversationSourceSegmentRecord
): Promise<Uint8Array> => {
  try {
    return await readConversationSourceSegmentBytes(context, storage, segment);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 503
    ) {
      throw error;
    }
    throw conflict("Conversation Source segment integrity check failed");
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
  mode: "snapshot" | "continuous";
  artifactId: string;
  logicalSourceId: string;
  sourceGenerationId: string;
  segmentIndex: number;
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
  authorizationRecheckMs?: number;
}) => {
  const { app, context, pool } = options;
  const storage = createFilesystemConversationSourceStorage(
    context.config.koedHome
  );
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
      targetTable: "team_session_share_grants",
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
        if (access.artifact.id !== client.artifactId) {
          await writeSse(client, "generation_changed", {
            previousArtifactId: client.artifactId,
            artifactId: access.artifact.id,
            sourceGenerationId: access.artifact.sourceGenerationId
          });
          client.artifactId = access.artifact.id;
          client.logicalSourceId = access.artifact.logicalSourceId;
          client.sourceGenerationId = access.artifact.sourceGenerationId;
          client.segmentIndex = -1;
        }
        const page = await context
          .requireRepository()
          .getTeamConversationSourceManifest(
            { userId: client.viewer.id },
            {
              shareGrantId: client.shareGrantId,
              afterSegmentIndex: client.segmentIndex,
              limit: 100,
              recordAudit: false
            }
          );
        if (!page || page.artifact.id !== client.artifactId) {
          await closeForAuthorizationLoss(client);
          return;
        }
        for (const segment of page.segments) {
          const cursor = sealOpaqueCursor({
            secret: cursorSecret!,
            prefix: cursorPrefix,
            domain: cursorDomain,
            payload: {
              version: 1,
              viewerHash: viewerHash(client.viewer.id),
              shareGrantId: client.shareGrantId,
              artifactId: client.artifactId,
              segmentIndex: segment.segmentIndex,
              contentDigest: segment.contentDigest,
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
          client.segmentIndex = segment.segmentIndex;
        }
        if (page.segments.length === 100) client.pending = true;
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

  const wakeSourceClients = (input: {
    logicalSourceId?: string;
    sourceGenerationId?: string;
  }): void => {
    if (!input.logicalSourceId && !input.sourceGenerationId) return;
    for (const client of clients.values()) {
      const sameGeneration =
        input.sourceGenerationId === client.sourceGenerationId;
      const continuousSuccessor =
        client.mode === "continuous" &&
        input.logicalSourceId === client.logicalSourceId;
      if (sameGeneration || continuousSuccessor) void flush(client);
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
        await next.query("listen koed_conversation_source_replication");
        await next.query("listen koed_team_conversation_source");
        await next.query("listen koed_collaboration_realtime");
        if (closed) {
          await next.query("unlisten *").catch(() => undefined);
          next.release();
          return;
        }
        const activeListener = next;
        activeListener.on("notification", (message) => {
          if (message.channel === "koed_conversation_source_replication") {
            try {
              const payload = JSON.parse(message.payload ?? "{}") as {
                logicalSourceId?: unknown;
                sourceGenerationId?: unknown;
              };
              wakeSourceClients({
                logicalSourceId:
                  typeof payload.logicalSourceId === "string"
                    ? payload.logicalSourceId
                    : undefined,
                sourceGenerationId:
                  typeof payload.sourceGenerationId === "string"
                    ? payload.sourceGenerationId
                    : undefined
              });
            } catch {
              // Identity-less replication work cannot be routed to a source stream.
            }
            return;
          }
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
      const manifest = await context
        .requireRepository()
        .getTeamConversationSourceManifest(
          { userId: viewer.id },
          { shareGrantId: params.shareGrantId, ...query }
        );
      if (!manifest) {
        await auditDenied({
          viewerId: viewer.id,
          shareGrantId: params.shareGrantId,
          operation: "manifest"
        });
        throw notFound();
      }
      return safeManifest(manifest, manifest.segments);
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
        .getTeamConversationSourceSegment({ userId: viewer.id }, params);
      if (!access) {
        await auditDenied({
          viewerId: viewer.id,
          shareGrantId: params.shareGrantId,
          operation: "segment"
        });
        throw notFound();
      }
      const bytes = await readVerifiedSourceSegment(
        context,
        storage,
        access.segment
      );
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
          segmentIndex: access.segment.segmentIndex,
          byteCount: bytes.byteLength,
          contentDigest: access.segment.contentDigest
        }
      });
      return reply
        .header("cache-control", "no-store")
        .header("content-type", "application/x-ndjson")
        .header("x-koed-content-digest", access.segment.contentDigest)
        .send(Buffer.from(bytes));
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
        first.artifact.journalStartOffset !== 0 ||
        first.artifact.journalStartLine !== 0
      ) {
        throw conflict(
          "Fork snapshot requires a complete Conversation Source Artifact"
        );
      }
      if (
        first.grant.maximumSegmentIndex !== null &&
        input.throughSegmentIndex > first.grant.maximumSegmentIndex
      ) {
        throw notFound();
      }
      const segments: ConversationSourceSegmentRecord[] = [];
      let after = -1;
      while (after < input.throughSegmentIndex) {
        const page = await context
          .requireRepository()
          .getTeamConversationSourceManifest(
            { userId: viewer.id },
            {
              shareGrantId: params.shareGrantId,
              afterSegmentIndex: after,
              limit: Math.min(100, input.throughSegmentIndex - after),
              recordAudit: false
            }
          );
        if (!page || page.artifact.id !== first.artifact.id) throw notFound();
        if (page.segments.length === 0) throw notFound();
        for (const segment of page.segments) {
          if (segment.segmentIndex > input.throughSegmentIndex) break;
          segments.push(segment);
          after = segment.segmentIndex;
        }
        if (segments.length > FORK_SNAPSHOT_MAX_SEGMENTS) {
          throw conflict("Fork snapshot exceeds the segment limit");
        }
      }
      if (
        segments.at(-1)?.segmentIndex !== input.throughSegmentIndex ||
        segments[0]?.sourceStartOffset !== 0
      ) {
        throw conflict("Fork snapshot source range is incomplete");
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let priorDigest: string | null = null;
      let priorOffset = 0;
      for (const segment of segments) {
        if (
          segment.sourceStartOffset !== priorOffset ||
          segment.previousContentDigest !== priorDigest
        ) {
          throw conflict("Fork snapshot source chain is invalid");
        }
        const bytes = await readVerifiedSourceSegment(
          context,
          storage,
          segment
        );
        totalBytes += bytes.byteLength;
        if (totalBytes > FORK_SNAPSHOT_MAX_BYTES) {
          throw conflict("Fork snapshot exceeds the byte limit");
        }
        chunks.push(Buffer.from(bytes));
        priorDigest = segment.contentDigest;
        priorOffset = segment.sourceEndOffset;
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
          parentArtifactId: first.artifact.id,
          parentSourceGenerationId: first.artifact.sourceGenerationId,
          throughSegmentIndex: input.throughSegmentIndex,
          sourceEndOffset: priorOffset,
          byteCount: snapshot.byteLength,
          snapshotDigest
        }
      });
      return reply
        .header("cache-control", "no-store")
        .header("content-type", "application/x-ndjson")
        .header("x-koed-parent-session-id", first.grant.sessionId)
        .header(
          "x-koed-parent-source-generation-id",
          first.artifact.sourceGenerationId
        )
        .header("x-koed-parent-segment-index", input.throughSegmentIndex)
        .header("x-koed-snapshot-digest", snapshotDigest)
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
        segmentIndex =
          parsed.data.artifactId === access.artifact.id
            ? parsed.data.segmentIndex
            : -1;
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
          artifactId: access.artifact.id
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
        mode: access.grant.mode,
        artifactId: access.artifact.id,
        logicalSourceId: access.artifact.logicalSourceId,
        sourceGenerationId: access.artifact.sourceGenerationId,
        segmentIndex,
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
        artifactId: access.artifact.id,
        afterSegmentIndex: segmentIndex
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
