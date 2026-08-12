import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConversationSourceArtifactRecord,
  ConversationSourceSegmentRecord,
  MemorySourceRepository,
  TeamConversationSourceGrantRecord,
  UserRecord
} from "@koed/db";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ApiRouteContext } from "../server/context.js";
import { sealOpaqueCursor } from "../local-edge/opaque-cursor.js";
import { createFilesystemConversationSourceStorage } from "../memory/conversation-source-storage.js";
import { createTeamConversationSourceService } from "./routes.js";

const iso = "2026-08-10T00:00:00.000Z";

const buildFixture = async (options?: {
  authorized?: boolean;
  credentialKind?: "session" | "device_credential";
  freshSession?: boolean;
  completeArtifact?: boolean;
  streaming?: boolean;
  successfulFork?: boolean;
  forkRecords?: string[];
  listenerConnectGate?: Promise<void>;
  authorizationRecheckMs?: number;
}) => {
  const ids = {
    owner: randomUUID(),
    viewer: randomUUID(),
    shareGrant: randomUUID(),
    team: randomUUID(),
    workspace: randomUUID(),
    session: randomUUID(),
    artifact: randomUUID(),
    logicalSource: randomUUID(),
    generation: randomUUID(),
    segment: randomUUID(),
    sourceGrant: randomUUID()
  };
  const viewer: UserRecord = {
    id: ids.viewer,
    email: "viewer@example.test",
    displayName: "Viewer",
    passwordHash: null
  };
  const grant: TeamConversationSourceGrantRecord = {
    id: ids.sourceGrant,
    shareGrantId: ids.shareGrant,
    artifactId: ids.artifact,
    logicalSourceId: ids.logicalSource,
    ownerUserId: ids.owner,
    sessionId: ids.session,
    teamId: ids.team,
    teamWorkspaceId: ids.workspace,
    mode: "continuous",
    maximumSegmentIndex: null,
    maximumSourceOffset: null,
    version: 1,
    lifecycle: "active",
    mutationId: randomUUID(),
    grantedByUserId: ids.owner,
    creatorAuthority: "browser_session:test",
    createdAt: iso,
    updatedAt: iso,
    revokedAt: null,
    revokedByUserId: null,
    revocationReason: null
  };
  const artifact: ConversationSourceArtifactRecord = {
    id: ids.artifact,
    ownerUserId: ids.owner,
    sessionId: ids.session,
    logicalSourceId: ids.logicalSource,
    sourceGenerationId: ids.generation,
    replicaRole: "origin_local",
    sourceKind: "codex",
    sourceRuntime: "codex",
    externalSessionId: "redacted-external-session",
    sourceFingerprint: "a".repeat(64),
    artifactFormat: "jsonl",
    artifactFormatVersion: 1,
    sourceAdapterVersion: "codex-transcript-v1",
    lifecycle: "active",
    journalStartOffset: options?.completeArtifact === false ? 128 : 0,
    journalStartLine: options?.completeArtifact === false ? 2 : 0,
    liveStartOffset: 0,
    liveStartLine: 0,
    providerCursorOffset: 128,
    providerCursorLine: 2,
    currentSourceLength: 128,
    currentJournalSequence: 0,
    sourceCreatedAt: iso,
    sourceModifiedAt: iso,
    storageProvider: "envelope_db",
    storagePrefix: "must-not-leak/storage-prefix",
    closureHash: null,
    closureManifest: null,
    closureSignature: null,
    originDeploymentId: "must-not-leak-deployment",
    originDeviceId: "must-not-leak-device",
    originKeyId: "must-not-leak-key",
    originPublicKey: "a".repeat(43),
    originKeyStatus: "active",
    priorGenerationClosure: null,
    redactedSourceLabel: "Codex session",
    createdAt: iso,
    updatedAt: iso,
    finalizedAt: null
  };
  const koedHome = mkdtempSync(join(tmpdir(), "koed-team-source-route-"));
  const forkRecords = options?.forkRecords ?? [
    JSON.stringify({
      type: "response_item",
      payload: { role: "user", content: "Fork me" }
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
  ];
  const forkBytes = Buffer.from(`${forkRecords.join("\n")}\n`);
  const forkDigest = createHash("sha256").update(forkBytes).digest("hex");
  const segment: ConversationSourceSegmentRecord = {
    id: ids.segment,
    artifactId: ids.artifact,
    segmentIndex: 0,
    sourceStartOffset: 0,
    sourceEndOffset: options?.successfulFork ? forkBytes.byteLength : 128,
    sourceStartLine: 0,
    sourceEndLine: 2,
    plaintextDigest: options?.successfulFork ? forkDigest : "b".repeat(64),
    ciphertextDigest: "c".repeat(64),
    plaintextSize: options?.successfulFork ? forkBytes.byteLength : 128,
    storedSize: options?.successfulFork ? forkBytes.byteLength : 256,
    storageKey: "must-not-leak-storage-key",
    storageProvider: "envelope_db",
    encryptionEnvelope: { ciphertext: "must-not-leak-ciphertext" },
    signedManifest: { private: "must-not-leak-manifest" },
    originSignature: "d".repeat(86),
    manifestDigest: "e".repeat(64),
    previousContentDigest: null,
    contentDigest: "f".repeat(64),
    createdAt: iso,
    sealedAt: iso
  };
  if (options?.successfulFork) {
    const stored = createFilesystemConversationSourceStorage(koedHome).put({
      artifactId: ids.artifact,
      plaintextDigest: forkDigest,
      bytes: forkBytes
    });
    segment.storageProvider = "filesystem";
    segment.storageKey = stored.storageKey;
    segment.storedSize = stored.storedSize;
    segment.encryptionEnvelope = null;
    artifact.storageProvider = "filesystem";
    artifact.providerCursorOffset = forkBytes.byteLength;
    artifact.currentSourceLength = forkBytes.byteLength;
  }
  let authorized = options?.authorized !== false;
  let consentActive = true;
  let credentialAuthorized = true;
  const sessionId = randomUUID();
  const deviceCredentialId = randomUUID();
  const credentialExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const segments = [segment];
  const auditActions: string[] = [];
  let accessReads = 0;
  let manifestReads = 0;
  const repository = {
    async getTeamConversationSourceAccess() {
      accessReads += 1;
      return authorized && consentActive ? { grant, artifact } : null;
    },
    async getTeamConversationSourceManifest(
      _actor: unknown,
      input: { afterSegmentIndex: number; limit: number }
    ) {
      manifestReads += 1;
      return authorized && consentActive
        ? {
            grant,
            artifact,
            segments: segments
              .filter(
                (candidate) => candidate.segmentIndex > input.afterSegmentIndex
              )
              .slice(0, input.limit)
          }
        : null;
    },
    async getTeamConversationSourceSegment() {
      return authorized && consentActive ? { grant, artifact, segment } : null;
    },
    async recordAuditEvent(input: { action: string }) {
      auditActions.push(input.action);
      return undefined;
    }
  } as unknown as MemorySourceRepository;
  let notificationListener:
    | ((message: { channel: string; payload?: string }) => void)
    | null = null;
  let listenerReleaseCount = 0;
  const listenClient = {
    async query() {
      return undefined;
    },
    on(event: "notification" | "error", callback: (value: never) => void) {
      if (event === "notification") {
        notificationListener = callback as typeof notificationListener;
      } else {
        void callback;
      }
    },
    release() {
      listenerReleaseCount += 1;
      notificationListener = null;
    }
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
    reply.status(statusCode).send({
      error: error instanceof Error ? error.message : String(error)
    });
  });
  const sessionUser = async (request: FastifyRequest) => {
    if (!credentialAuthorized) {
      throw Object.assign(new Error("Credential is no longer valid"), {
        statusCode: 401
      });
    }
    if (request.headers.authorization) {
      throw Object.assign(new Error("Session cookie required"), {
        statusCode: 401
      });
    }
    return viewer;
  };
  const context = {
    config: {
      koedHome,
      collaborationRealtime: { cursorSecret: "s".repeat(64) }
    },
    requireRepository: () => repository,
    auth: {
      authenticateSessionOrDeviceCredential: async (
        request: FastifyRequest
      ) => {
        if (/^Bearer /i.test(request.headers.authorization ?? "")) {
          throw Object.assign(
            new Error("API Tokens cannot read Team-shared transcripts"),
            { statusCode: 403 }
          );
        }
        if (options?.credentialKind === "device_credential") {
          if (!/^Koed-Device /i.test(request.headers.authorization ?? "")) {
            throw Object.assign(new Error("Device credential required"), {
              statusCode: 401
            });
          }
          if (!credentialAuthorized) {
            throw Object.assign(new Error("Invalid device credential"), {
              statusCode: 401
            });
          }
          return viewer;
        }
        return sessionUser(request);
      },
      resolveDeviceCredentialContext: async () =>
        credentialAuthorized && options?.credentialKind === "device_credential"
          ? {
              user: viewer,
              credential: {
                id: deviceCredentialId,
                operationFamilies: ["team_workspace_read"],
                expiresAt: credentialExpiresAt.toISOString()
              }
            }
          : null,
      authenticateSessionContext: async (request: FastifyRequest) => ({
        sessionId,
        createdAt: new Date(
          options?.freshSession === false
            ? Date.now() - 60 * 60 * 1000
            : Date.now()
        ),
        expiresAt: credentialExpiresAt,
        user: await sessionUser(request)
      })
    },
    rateLimit: { memoryRead: async () => undefined }
  } as unknown as ApiRouteContext;
  const service = createTeamConversationSourceService({
    app,
    context,
    pool: options?.streaming
      ? {
          async connect() {
            await options.listenerConnectGate;
            return listenClient;
          }
        }
      : null,
    authorizationRecheckMs: options?.authorizationRecheckMs
  });
  await app.ready();
  return {
    app,
    service,
    ids,
    auditActions,
    forkBytes,
    get listenerReleaseCount() {
      return listenerReleaseCount;
    },
    get sourceReadCounts() {
      return { accessReads, manifestReads };
    },
    cleanup() {
      rmSync(koedHome, { recursive: true, force: true });
    },
    appendSegment() {
      const next = {
        ...segment,
        id: randomUUID(),
        segmentIndex: 1,
        sourceStartOffset: 128,
        sourceEndOffset: 256,
        sourceStartLine: 2,
        sourceEndLine: 4,
        previousContentDigest: segment.contentDigest,
        contentDigest: "1".repeat(64)
      };
      segments.push(next);
      return next;
    },
    corruptDigest() {
      segment.plaintextDigest = "0".repeat(64);
    },
    appendBrokenChainSegment() {
      const next = this.appendSegment();
      next.sourceStartOffset += 1;
      return next;
    },
    revoke() {
      authorized = false;
    },
    expireConsent() {
      consentActive = false;
    },
    revokeCredential() {
      credentialAuthorized = false;
    },
    notify(input?: { logicalSourceId?: string; sourceGenerationId?: string }) {
      notificationListener?.({
        channel: "koed_conversation_source_replication",
        payload: JSON.stringify({
          logicalSourceId: input?.logicalSourceId ?? ids.logicalSource,
          sourceGenerationId: input?.sourceGenerationId ?? ids.generation
        })
      });
    },
    notifyTeam() {
      notificationListener?.({
        channel: "koed_collaboration_realtime",
        payload: JSON.stringify({ teamId: ids.team })
      });
    }
  };
};

describe("Team Conversation source routes", () => {
  it("releases a listener connection that completes during shutdown", async () => {
    let releaseConnect: (() => void) | null = null;
    const listenerConnectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const fixture = await buildFixture({
      streaming: true,
      listenerConnectGate
    });

    const closing = fixture.service.close();
    releaseConnect!();
    await closing;

    expect(fixture.listenerReleaseCount).toBe(1);
    await fixture.app.close();
    fixture.cleanup();
  });

  it("replays, pushes, and revokes a durable source stream without polling", async () => {
    const fixture = await buildFixture({ streaming: true });
    const baseUrl = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/stream`,
      { signal: controller.signal }
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 2_000;
      while (!received.includes(needle)) {
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for source stream event: ${needle}`
          );
        }
        const read = await reader.read();
        if (read.done) break;
        received += decoder.decode(read.value, { stream: true });
      }
      expect(received).toContain(needle);
    };

    await readUntil('"segmentIndex":0');
    fixture.appendSegment();
    fixture.notify();
    await readUntil('"segmentIndex":1');
    fixture.revoke();
    fixture.notifyTeam();
    await readUntil('"reason":"access_revoked"');
    expect(received).toContain("event: ready");
    expect(received).toContain("event: segment_available");
    expect(received).toContain("event: closed");
    expect(fixture.auditActions).toEqual([
      "team_conversation_source.stream_opened",
      "team_conversation_source.stream_authorization_lost"
    ]);

    controller.abort();
    await fixture.service.close();
    await fixture.app.close();
    fixture.cleanup();
  });

  it.each(["session", "device_credential"] as const)(
    "closes an idle source stream when its %s is revoked",
    async (credentialKind) => {
      const fixture = await buildFixture({
        streaming: true,
        credentialKind,
        authorizationRecheckMs: 10
      });
      const baseUrl = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
      const controller = new AbortController();
      const response = await fetch(
        `${baseUrl}/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/stream`,
        {
          signal: controller.signal,
          headers:
            credentialKind === "device_credential"
              ? { authorization: "Koed-Device fixture:secret" }
              : undefined
        }
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes('"segmentIndex":0')) {
        const read = await reader.read();
        if (read.done) break;
        received += decoder.decode(read.value, { stream: true });
      }

      fixture.revokeCredential();
      const deadline = Date.now() + 2_000;
      while (!received.includes('"reason":"access_revoked"')) {
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for credential revocation");
        }
        const read = await reader.read();
        if (read.done) break;
        received += decoder.decode(read.value, { stream: true });
      }
      expect(received).toContain('"reason":"access_revoked"');
      expect(fixture.auditActions).toEqual([
        "team_conversation_source.stream_opened",
        "team_conversation_source.stream_authorization_lost"
      ]);

      controller.abort();
      await fixture.service.close();
      await fixture.app.close();
      fixture.cleanup();
    }
  );

  it("closes an idle source stream after owner consent expires", async () => {
    const fixture = await buildFixture({
      streaming: true,
      authorizationRecheckMs: 10
    });
    const baseUrl = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/stream`,
      { signal: controller.signal }
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes('"segmentIndex":0')) {
      const read = await reader.read();
      if (read.done) break;
      received += decoder.decode(read.value, { stream: true });
    }

    fixture.expireConsent();
    const deadline = Date.now() + 2_000;
    while (!received.includes('"reason":"access_revoked"')) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for consent expiry");
      }
      const read = await reader.read();
      if (read.done) break;
      received += decoder.decode(read.value, { stream: true });
    }
    expect(received).toContain('"reason":"access_revoked"');

    controller.abort();
    await fixture.service.close();
    await fixture.app.close();
    fixture.cleanup();
  });

  it("routes source notifications without waking unrelated streams", async () => {
    const fixture = await buildFixture({ streaming: true });
    const baseUrl = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/stream`,
      { signal: controller.signal }
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes('"segmentIndex":0')) {
      const read = await reader.read();
      if (read.done) break;
      received += decoder.decode(read.value, { stream: true });
    }
    const before = fixture.sourceReadCounts;

    fixture.notify({
      logicalSourceId: randomUUID(),
      sourceGenerationId: randomUUID()
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.sourceReadCounts).toEqual(before);

    controller.abort();
    await fixture.service.close();
    await fixture.app.close();
    fixture.cleanup();
  });

  it("replays source changes committed before the listener is ready", async () => {
    let releaseConnect: (() => void) | null = null;
    const listenerConnectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const fixture = await buildFixture({
      streaming: true,
      listenerConnectGate
    });
    const baseUrl = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/stream`,
      { signal: controller.signal }
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes('"segmentIndex":0')) {
      const read = await reader.read();
      if (read.done) break;
      received += decoder.decode(read.value, { stream: true });
    }

    fixture.appendSegment();
    releaseConnect!();
    const deadline = Date.now() + 2_000;
    while (!received.includes('"segmentIndex":1') && Date.now() < deadline) {
      const read = await reader.read();
      if (read.done) break;
      received += decoder.decode(read.value, { stream: true });
    }
    expect(received).toContain('"segmentIndex":1');

    controller.abort();
    await fixture.service.close();
    await fixture.app.close();
    fixture.cleanup();
  });

  it("returns a redacted manifest to an authorized Team viewer", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/manifest`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      transcriptAccess: {
        shareGrantId: fixture.ids.shareGrant,
        mode: "continuous"
      },
      artifact: { id: fixture.ids.artifact },
      segments: [{ id: fixture.ids.segment, segmentIndex: 0 }]
    });
    for (const secret of [
      "storage-prefix",
      "storage-key",
      "ciphertext",
      "originDeploymentId",
      "originDeviceId",
      "originKeyId",
      "externalSessionId"
    ]) {
      expect(response.body).not.toContain(secret);
    }
    await fixture.service.close();
    await fixture.app.close();
    fixture.cleanup();
  });

  it("fails closed for API Tokens, unauthorized viewers, and unavailable streaming", async () => {
    const authorized = await buildFixture();
    const bearer = await authorized.app.inject({
      method: "GET",
      url: `/v1/shared-memory/share-grants/${authorized.ids.shareGrant}/transcript/manifest`,
      headers: { authorization: "Bearer personal-token" }
    });
    const stream = await authorized.app.inject({
      method: "GET",
      url: `/v1/shared-memory/share-grants/${authorized.ids.shareGrant}/transcript/stream`
    });
    const unauthorized = await buildFixture({ authorized: false });
    const absent = await unauthorized.app.inject({
      method: "GET",
      url: `/v1/shared-memory/share-grants/${unauthorized.ids.shareGrant}/transcript/manifest`
    });

    expect([bearer.statusCode, stream.statusCode, absent.statusCode]).toEqual([
      403, 503, 404
    ]);
    expect(unauthorized.auditActions).toEqual([
      "team_conversation_source.access_denied"
    ]);
    await authorized.service.close();
    await authorized.app.close();
    await unauthorized.service.close();
    await unauthorized.app.close();
    authorized.cleanup();
    unauthorized.cleanup();
  });

  it("binds opaque live cursors to the viewer and Share Grant", async () => {
    const fixture = await buildFixture({ streaming: true });
    const baseUrl = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/stream`,
      { signal: controller.signal }
    );
    const reader = response.body!.getReader();
    let body = "";
    while (!/^id: /m.test(body)) {
      const { value, done } = await reader.read();
      if (done) break;
      body += new TextDecoder().decode(value);
    }
    const cursor = /^id: (.+)$/m.exec(body)?.[1];
    expect(cursor).toBeTruthy();
    controller.abort();

    fixture.appendSegment();
    const resumeController = new AbortController();
    const resumed = await fetch(
      `${baseUrl}/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/stream?cursor=${encodeURIComponent(cursor!)}`,
      { signal: resumeController.signal }
    );
    const resumedReader = resumed.body!.getReader();
    let resumedBody = "";
    while (!resumedBody.includes('"segmentIndex":1')) {
      const { value, done } = await resumedReader.read();
      if (done) break;
      resumedBody += new TextDecoder().decode(value);
    }
    expect(resumedBody).toContain('"segmentIndex":1');
    expect(resumedBody).not.toContain('"segmentIndex":0');
    resumeController.abort();

    const expiredCursor = sealOpaqueCursor({
      secret: "s".repeat(64),
      prefix: "tcs1",
      domain: "team-conversation-source",
      payload: {
        version: 1,
        viewerHash: createHash("sha256")
          .update(
            `koed:team-conversation-source-viewer:v1\n${fixture.ids.viewer}`
          )
          .digest("hex"),
        shareGrantId: fixture.ids.shareGrant,
        artifactId: fixture.ids.artifact,
        segmentIndex: 0,
        contentDigest: "f".repeat(64),
        expiresAt: Date.now() - 1
      }
    });

    const tampered = await fixture.app.inject({
      method: "GET",
      url: `/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/stream?cursor=${encodeURIComponent(`${cursor}x`)}`
    });
    const crossGrant = await fixture.app.inject({
      method: "GET",
      url: `/v1/shared-memory/share-grants/${randomUUID()}/transcript/stream?cursor=${encodeURIComponent(cursor!)}`
    });
    const expired = await fixture.app.inject({
      method: "GET",
      url: `/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/stream?cursor=${encodeURIComponent(expiredCursor)}`
    });
    expect([
      tampered.statusCode,
      crossGrant.statusCode,
      expired.statusCode
    ]).toEqual([400, 400, 410]);

    await fixture.service.close();
    await fixture.app.close();
    fixture.cleanup();
  });

  it("requires a fresh browser session and POST for fork snapshot export", async () => {
    const stale = await buildFixture({
      freshSession: false,
      completeArtifact: false
    });
    const staleResponse = await stale.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${stale.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { throughSegmentIndex: 0 }
    });
    const getResponse = await stale.app.inject({
      method: "GET",
      url: `/v1/shared-memory/share-grants/${stale.ids.shareGrant}/transcript/fork-snapshot?throughSegmentIndex=0`
    });
    const fresh = await buildFixture({ completeArtifact: false });
    const incomplete = await fresh.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${fresh.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { throughSegmentIndex: 0 }
    });

    expect(staleResponse.statusCode).toBe(403);
    expect(getResponse.statusCode).toBe(404);
    expect(incomplete.statusCode).toBe(409);
    await stale.service.close();
    await stale.app.close();
    await fresh.service.close();
    await fresh.app.close();
    stale.cleanup();
    fresh.cleanup();
  });

  it("exports an exact verified snapshot through a completed turn", async () => {
    const fixture = await buildFixture({ successfulFork: true });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { throughSegmentIndex: 0 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(fixture.forkBytes);
    expect(response.headers["x-koed-parent-session-id"]).toBe(
      fixture.ids.session
    );
    expect(response.headers["x-koed-snapshot-digest"]).toBe(
      createHash("sha256").update(fixture.forkBytes).digest("hex")
    );
    expect(fixture.auditActions).toEqual([
      "team_conversation_source.fork_snapshot_exported"
    ]);
    await fixture.service.close();
    await fixture.app.close();
    fixture.cleanup();
  });

  it("rejects digest, JSONL, and source-chain integrity failures", async () => {
    const digest = await buildFixture({ successfulFork: true });
    digest.corruptDigest();
    const wrongDigest = await digest.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${digest.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { throughSegmentIndex: 0 }
    });

    const malformed = await buildFixture({
      successfulFork: true,
      forkRecords: [
        "not-json",
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete" }
        })
      ]
    });
    const malformedJsonl = await malformed.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${malformed.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { throughSegmentIndex: 0 }
    });

    const chain = await buildFixture({ successfulFork: true });
    chain.appendBrokenChainSegment();
    const reordered = await chain.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${chain.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { throughSegmentIndex: 1 }
    });

    expect([
      wrongDigest.statusCode,
      malformedJsonl.statusCode,
      reordered.statusCode
    ]).toEqual([409, 409, 409]);
    for (const fixture of [digest, malformed, chain]) {
      await fixture.service.close();
      await fixture.app.close();
      fixture.cleanup();
    }
  });
});
