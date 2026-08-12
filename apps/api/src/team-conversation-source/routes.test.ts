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
  multiComponent?: boolean;
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
    auxiliaryArtifact: randomUUID(),
    logicalSource: randomUUID(),
    generation: randomUUID(),
    segment: randomUUID(),
    auxiliarySegment: randomUUID(),
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
    sourceGenerationId: ids.generation,
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
    sourceComponentId: "main",
    sourceComponentRole: "primary",
    parentSourceComponentId: null,
    contentFraming: "jsonl",
    replicaRole: "origin_local",
    sourceKind: "codex",
    sourceRuntime: "codex",
    externalSessionId: "redacted-external-session",
    sourceFingerprint: "a".repeat(64),
    artifactFormat: "jsonl",
    artifactFormatVersion: 1,
    sourceAdapterVersion: "codex-transcript-v1",
    lifecycle: "finalized",
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
    closureHash: "2".repeat(64),
    closureManifest: { protocol: "koed/source-component-closure/v1" },
    closureSignature: "3".repeat(86),
    sourceSetClosureHash: null,
    sourceSetClosureManifest: null,
    sourceSetClosureSignature: null,
    sourceSetFinalizedAt: null,
    originDeploymentId: "must-not-leak-deployment",
    originDeviceId: "must-not-leak-device",
    originKeyId: "must-not-leak-key",
    originPublicKey: "a".repeat(43),
    originKeyStatus: "active",
    priorGenerationClosure: null,
    redactedSourceLabel: "Codex session",
    createdAt: iso,
    updatedAt: iso,
    finalizedAt: iso
  };
  const koedHome = mkdtempSync(join(tmpdir(), "koed-team-source-route-"));
  const sourceStorage = createFilesystemConversationSourceStorage(koedHome);
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
    const stored = sourceStorage.put({
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
  if (options?.multiComponent) {
    artifact.sourceSetClosureHash = "9".repeat(64);
    artifact.sourceSetClosureManifest = { componentCount: 2 };
    artifact.sourceSetClosureSignature = "8".repeat(86);
    artifact.sourceSetFinalizedAt = iso;
  }
  const auxiliaryArtifact: ConversationSourceArtifactRecord | null =
    options?.multiComponent
      ? {
          ...artifact,
          id: ids.auxiliaryArtifact,
          sourceComponentId: "agent.worker-1",
          sourceComponentRole: "auxiliary",
          parentSourceComponentId: "main",
          contentFraming: "jsonl",
          sourceFingerprint: "7".repeat(64),
          storagePrefix: "must-not-leak/auxiliary-storage-prefix",
          closureHash: "6".repeat(64),
          sourceSetClosureHash: null,
          sourceSetClosureManifest: null,
          sourceSetClosureSignature: null,
          sourceSetFinalizedAt: null,
          redactedSourceLabel: "Claude auxiliary session"
        }
      : null;
  const auxiliarySegment: ConversationSourceSegmentRecord | null =
    auxiliaryArtifact
      ? {
          ...segment,
          id: ids.auxiliarySegment,
          artifactId: auxiliaryArtifact.id,
          plaintextDigest: "5".repeat(64),
          contentDigest: "4".repeat(64),
          storageKey: "must-not-leak-auxiliary-storage-key"
        }
      : null;
  if (auxiliaryArtifact && auxiliarySegment) {
    const bytes = Buffer.from('{"type":"assistant","message":"auxiliary"}\n');
    const digest = createHash("sha256").update(bytes).digest("hex");
    const stored = sourceStorage.put({
      artifactId: auxiliaryArtifact.id,
      plaintextDigest: digest,
      bytes
    });
    auxiliaryArtifact.storageProvider = "filesystem";
    auxiliaryArtifact.providerCursorOffset = bytes.byteLength;
    auxiliaryArtifact.currentSourceLength = bytes.byteLength;
    auxiliarySegment.storageProvider = "filesystem";
    auxiliarySegment.storageKey = stored.storageKey;
    auxiliarySegment.plaintextDigest = digest;
    auxiliarySegment.plaintextSize = bytes.byteLength;
    auxiliarySegment.storedSize = stored.storedSize;
    auxiliarySegment.sourceEndOffset = bytes.byteLength;
    auxiliarySegment.encryptionEnvelope = null;
  }
  let authorized = options?.authorized !== false;
  let consentActive = true;
  let credentialAuthorized = true;
  const sessionId = randomUUID();
  const deviceCredentialId = randomUUID();
  const credentialExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const components = auxiliaryArtifact
    ? [artifact, auxiliaryArtifact]
    : [artifact];
  const segments = auxiliarySegment ? [segment, auxiliarySegment] : [segment];
  const auditActions: string[] = [];
  let accessReads = 0;
  let manifestReads = 0;
  const repository = {
    async getTeamConversationSourceAccess() {
      accessReads += 1;
      return authorized && consentActive
        ? { grant, artifact, components }
        : null;
    },
    async getTeamConversationSourceManifest(
      _actor: unknown,
      input: {
        sourceComponentId?: string;
        afterSegmentIndex: number;
        limit: number;
      }
    ) {
      manifestReads += 1;
      return authorized && consentActive
        ? {
            grant,
            artifact,
            components,
            selectedComponent:
              components.find(
                (component) =>
                  component.sourceComponentId ===
                  (input.sourceComponentId ?? "main")
              ) ?? artifact,
            segments: segments
              .filter(
                (candidate) =>
                  candidate.artifactId ===
                    (components.find(
                      (component) =>
                        component.sourceComponentId ===
                        (input.sourceComponentId ?? "main")
                    )?.id ?? artifact.id) &&
                  candidate.segmentIndex > input.afterSegmentIndex
              )
              .slice(0, input.limit)
          }
        : null;
    },
    async getTeamConversationSourceSegment(
      _actor: unknown,
      input: { segmentId: string }
    ) {
      const selected = segments.find(
        (candidate) => candidate.id === input.segmentId
      );
      return authorized && consentActive
        ? { grant, artifact, components, segment: selected ?? segment }
        : null;
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
      artifact.currentJournalSequence = next.segmentIndex;
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

  it("serves every verified source component without exposing local custody", async () => {
    const fixture = await buildFixture({ multiComponent: true });
    const manifest = await fixture.app.inject({
      method: "GET",
      url: `/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/manifest?sourceComponentId=agent.worker-1`
    });

    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toMatchObject({
      artifact: {
        sourceGenerationId: fixture.ids.generation,
        sourceComponentId: "main"
      },
      components: [
        { sourceComponentId: "main", sourceComponentRole: "primary" },
        {
          sourceComponentId: "agent.worker-1",
          sourceComponentRole: "auxiliary",
          parentSourceComponentId: "main"
        }
      ],
      selectedComponent: {
        id: fixture.ids.auxiliaryArtifact,
        sourceComponentId: "agent.worker-1"
      },
      segments: [
        {
          id: fixture.ids.auxiliarySegment,
          artifactId: fixture.ids.auxiliaryArtifact
        }
      ]
    });
    for (const privateValue of [
      "auxiliary-storage-prefix",
      "auxiliary-storage-key",
      "must-not-leak-device",
      "redacted-external-session"
    ]) {
      expect(manifest.body).not.toContain(privateValue);
    }

    const segment = await fixture.app.inject({
      method: "GET",
      url: `/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/segments/${fixture.ids.auxiliarySegment}`
    });
    expect(segment.statusCode).toBe(200);
    expect(segment.body).toContain('"message":"auxiliary"');

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
        sourceGenerationId: fixture.ids.generation,
        componentPositions: { main: 0 },
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

  it("streams independent positions for every source component", async () => {
    const fixture = await buildFixture({
      streaming: true,
      multiComponent: true
    });
    const baseUrl = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/stream`,
      { signal: controller.signal }
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let body = "";
    while (!body.includes('"sourceComponentId":"agent.worker-1"')) {
      const { value, done } = await reader.read();
      if (done) break;
      body += new TextDecoder().decode(value);
    }
    expect(body).toContain('"sourceComponentId":"main"');
    expect(body).toContain('"sourceComponentId":"agent.worker-1"');
    expect((body.match(/^id: /gm) ?? []).length).toBe(2);
    controller.abort();
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
      payload: { expectedSourceGenerationId: stale.ids.generation }
    });
    const getResponse = await stale.app.inject({
      method: "GET",
      url: `/v1/shared-memory/share-grants/${stale.ids.shareGrant}/transcript/fork-snapshot`
    });
    const fresh = await buildFixture({ completeArtifact: false });
    const incomplete = await fresh.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${fresh.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { expectedSourceGenerationId: fresh.ids.generation }
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

  it("exports an exact verified source-generation snapshot", async () => {
    const fixture = await buildFixture({ successfulFork: true });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { expectedSourceGenerationId: fixture.ids.generation }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      protocol: "koed/team-conversation-source-snapshot/v1",
      parent: {
        sessionId: fixture.ids.session,
        shareGrantId: fixture.ids.shareGrant,
        sourceGenerationId: fixture.ids.generation
      },
      components: [
        {
          artifact: { sourceComponentId: "main" },
          verification: {
            originKeyId: "must-not-leak-key",
            originPublicKey: "a".repeat(43)
          }
        }
      ]
    });
    expect(
      Buffer.from(body.components[0].segments[0].bytes, "base64url")
    ).toEqual(fixture.forkBytes);
    expect(response.headers["x-koed-parent-session-id"]).toBe(
      fixture.ids.session
    );
    expect(response.headers["x-koed-snapshot-digest"]).toBe(
      createHash("sha256").update(response.body).digest("hex")
    );
    expect(fixture.auditActions).toEqual([
      "team_conversation_source.fork_snapshot_exported"
    ]);
    await fixture.service.close();
    await fixture.app.close();
    fixture.cleanup();
  });

  it("exports every verified component in a multi-component source set", async () => {
    const fixture = await buildFixture({
      successfulFork: true,
      multiComponent: true
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${fixture.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { expectedSourceGenerationId: fixture.ids.generation }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      parent: {
        logicalSourceId: fixture.ids.logicalSource,
        sourceGenerationId: fixture.ids.generation
      },
      sourceSetVerification: {
        closureHash: "9".repeat(64),
        closureManifest: { componentCount: 2 },
        closureSignature: "8".repeat(86)
      },
      components: [
        { artifact: { sourceComponentId: "main" } },
        {
          artifact: {
            sourceComponentId: "agent.worker-1",
            parentSourceComponentId: "main"
          }
        }
      ]
    });
    for (const privateValue of [
      "storage-prefix",
      "storage-key",
      "must-not-leak-device",
      "redacted-external-session"
    ]) {
      expect(response.body).not.toContain(privateValue);
    }

    await fixture.service.close();
    await fixture.app.close();
    fixture.cleanup();
  });

  it("rejects generation races, digest failures, and invalid source chains", async () => {
    const race = await buildFixture({ successfulFork: true });
    const wrongGeneration = await race.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${race.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { expectedSourceGenerationId: randomUUID() }
    });

    const digest = await buildFixture({ successfulFork: true });
    digest.corruptDigest();
    const wrongDigest = await digest.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${digest.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { expectedSourceGenerationId: digest.ids.generation }
    });

    const chain = await buildFixture({ successfulFork: true });
    chain.appendBrokenChainSegment();
    const reordered = await chain.app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${chain.ids.shareGrant}/transcript/fork-snapshot`,
      payload: { expectedSourceGenerationId: chain.ids.generation }
    });

    expect([
      wrongGeneration.statusCode,
      wrongDigest.statusCode,
      reordered.statusCode
    ]).toEqual([409, 409, 409]);
    for (const fixture of [race, digest, chain]) {
      await fixture.service.close();
      await fixture.app.close();
      fixture.cleanup();
    }
  });
});
