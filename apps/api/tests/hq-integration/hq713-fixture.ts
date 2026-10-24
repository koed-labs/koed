import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  highRiskActionGrantCommitment,
  sharedMemoryPendingShareActionGrantBinding,
  crossIdentitySyncDeterministicUuid,
  COLLABORATION_CONTRACT_VERSION,
  createEnvelopeEncryptionProviderFromEnvironment,
  createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment,
  derivePrivacyFingerprintKey,
  noPrivacyLabelsPolicy,
  createPrivacyServiceClient,
  PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT,
  PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES,
  PRIVACY_CLASSIFICATION_MAX_REQUEST_FIELD_BYTES,
  PRIVACY_CLASSIFICATION_MAX_REQUEST_BODY_BYTES,
  PRIVACY_WINDOW_CORE_TOKENS,
  PRIVACY_WINDOW_CONTEXT_TOKENS,
  PRIVACY_WINDOW_MAX_TOKENS,
  PRIVACY_MAX_FIELD_TOKENS,
  PRIVACY_MAX_CONCURRENT_REQUESTS,
  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_FIELDS,
  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_BYTES,
  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ENCODED_BYTES,
  createTeamMemoryEnvelopeEncryptionProviderFromEnvironment,
  createDeviceBoundSourceSigner,
  inspectDeviceIdentityAtKoedHome,
  readLocalEdgeUpstreamEnrollmentBinding,
  readUpstreamCredentialAuthorization,
  readLocalEdgeClientCredentialAuthorization,
  teamCollaborationV2CapabilitiesSchema,
  storeDesktopLocalCredential,
  storeLocalEdgeClientCredential,
  storeUpstreamCredentialSecret
} from "@koed/shared";
import {
  createCollaborationSharedMemoryAuthorityStore,
  createCrossIdentitySyncRepository,
  createMemorySourceRepository,
  createPrivacyClassificationRepository,
  createSharedMemoryRepository
} from "@koed/db";
import { LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION } from "@koed/core";
import { buildServer } from "../../src/server/build-server.js";
import { createPendingShareSchema } from "../../src/shared-memory/schemas.js";
import { createCrossIdentitySyncService } from "../../../worker/src/cross-identity-sync-service.js";
import { createSharedMemoryPrivacyMaterializationService } from "../../../worker/src/shared-memory-privacy-materialization-service.js";
import { createSharedMemoryEmbeddingService } from "../../../worker/src/shared-memory-embedding-service.js";
import { createEmbeddingWorkflow } from "../../../worker/src/embedding-workflow.js";
import { resolveWorkerEnv } from "../../../worker/src/env-config.js";
import { ensureDeviceIdentity } from "../../../../packages/koed-server/src/device-identity.js";
import { resolveKoedServerPaths } from "../../../../packages/koed-server/src/paths.js";
import { associateCapturedSession } from "./hq713-capture-association.js";
import { enrollHq713TeamSource } from "./hq713-source-enrollment.js";
import {
  seedHq713CuratedAssertion,
  makeHq713CapturedChatPrivate,
  attemptHq713OtherOwnerShare,
  type Hq713CuratedInput
} from "./hq713-curated-input.js";
import { shareHq713CapturedSessionViaProjectPolicy } from "./hq713-policy.js";

const databaseUrl =
  process.env.KOED_HQ713_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
const teamBackendId = "hq713-team";
const browserOrigin = "http://127.0.0.1:5174";
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const hashSecret = (pepper: string, secret: string) =>
  createHash("sha256").update(`${pepper}${secret}`).digest("hex");
const reserveLoopbackPort = async (): Promise<number> => {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve)
  );
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
};

export interface Hq713HttpResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface Hq713RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  expectedStatus?: number | readonly number[];
}

export interface Hq713HttpClient {
  readonly baseUrl: string;
  request<T = unknown>(
    method: string,
    path: string,
    options?: Hq713RequestOptions
  ): Promise<Hq713HttpResponse<T>>;
}

export interface Hq713Actor {
  readonly name: "alice" | "bob";
  readonly koedHome: string;
  readonly id: string;
  readonly teamUserId: string;
  readonly email: string;
  readonly deviceId: string;
  readonly deviceAuthorization: string;
  readonly sessionCookie: string;
  readonly personalTokenAuthorization: string;
  readonly team: Hq713HttpClient;
  readonly teamBrowser: Hq713HttpClient;
  readonly personal: Hq713HttpClient;
  readonly personalEdge: Hq713HttpClient;
  readonly personalBrowser: Hq713HttpClient;
  readonly personalTokenClient: Hq713HttpClient;
  readonly personalRunner: Hq713HttpClient;
  readonly aiClientInstanceId: string;
  readonly managedLaunch: { instanceId: string; model: string };
  readonly deploymentId: string;
}

export interface Hq713Ids {
  teamId: string;
  workspaceId: string;
  workspaceProjectId: string;
  alicePersonalProjectId: string;
  bobPersonalProjectId: string;
}

export interface Hq713ResultRegistry {
  record(id: string, evidence: Record<string, unknown>): void;
  entries(): ReadonlyArray<{ id: string; evidence: Record<string, unknown> }>;
}

export interface Hq713Fixture {
  readonly alice: Hq713Actor;
  readonly bob: Hq713Actor;
  readonly ids: Hq713Ids;
  readonly teamBackendId: string;
  readonly team: { baseUrl: string; db: pg.Pool };
  personalDb(actor: Hq713Actor): pg.Pool;
  personalDatabaseUrl(actor: Hq713Actor): string;
  readonly results: Hq713ResultRegistry;
  apiErrors(): ReadonlyArray<{
    server: string;
    path: string;
    errorName: string;
    message: string;
    stack: string | null;
  }>;
  futureFailures(): ReadonlyArray<{
    server: string;
    failureStage: string | null;
    reason: string | null;
    errorClass: string | null;
    errorCode: string | null;
    statusCode: number | null;
  }>;
  assertNoWorkerErrors(): void;
  readonly home: string;
  readonly personalEncryptionProvider: NonNullable<
    ReturnType<typeof createEnvelopeEncryptionProviderFromEnvironment>
  >;
  invalidateTeamSemanticPreview(input: {
    ownerTeamUserId: string;
    semanticPreviewId: string;
  }): Promise<boolean>;
  blockTeamPath(method: string, path: string): void;
  resumeTeamPath(method: string, path: string): void;
  blockTeamCuratedWithdrawal(): void;
  resumeTeamCuratedWithdrawal(): void;
  dropNextTeamCuratedUpdateResponse(): void;
  teamCuratedUpdateResponseDrops(): number;
  localCommand(
    actor: Hq713Actor,
    command: string,
    input: Record<string, unknown>,
    options?: { personal?: boolean; requestId?: string }
  ): Promise<Record<string, unknown>>;
  localActionGrant(
    actor: Hq713Actor,
    intent: Record<string, unknown>
  ): Promise<{
    reference: { id: string };
    intent: Record<string, unknown>;
  }>;
  shareCapturedSession(
    actor: Hq713Actor,
    input: {
      sessionId: string;
      workspaceProjectId?: string;
      projectBoundCuratedDenialProjectId?: string;
      teamWorkspaceId: string;
      summaryText: string;
      mutationId?: string;
      includeCuratedMemory: boolean;
      expiresAt?: string | null;
    }
  ): Promise<{
    grantId: string;
    logicalMemoryId: string;
    projectBoundCuratedRejected: boolean;
  }>;
  sharePersonalNote(
    actor: Hq713Actor,
    input: {
      noteId: string;
      noteRevision: number;
      memoryEventId: string;
      logicalMemoryId: string;
      teamWorkspaceId: string;
      noteText: string;
    }
  ): Promise<{ grantId: string; logicalMemoryId: string }>;
  shareCapturedSessionViaProjectPolicy(
    actor: Hq713Actor,
    input: {
      sessionId: string;
      workspaceProjectId: string;
      teamWorkspaceId: string;
      summaryText: string;
    }
  ): Promise<{ grantId: string; logicalMemoryId: string }>;
  makeChatPrivate(
    actor: Hq713Actor,
    input: { sessionId: string; grantId: string; projectId: string }
  ): Promise<void>;
  attemptShareCapturedSessionAs(
    actor: Hq713Actor,
    input: {
      ownerActor: Hq713Actor;
      sessionId: string;
      workspaceProjectId: string;
      teamWorkspaceId: string;
    }
  ): Promise<Hq713HttpResponse<Record<string, unknown>>>;
  seedCuratedAssertion(
    actor: Hq713Actor,
    input: Hq713CuratedInput
  ): Promise<{ assertionId: string }>;
  approveActionGrant(
    actor: Hq713Actor,
    intent: Record<string, unknown>
  ): Promise<{
    secret: string;
    status: Record<string, unknown>;
    clientRequestId: string;
  }>;
  createPersonalProject(
    actor: Hq713Actor,
    input: { name: string }
  ): Promise<{ projectId: string }>;
  seedCapturedSession(
    actor: Hq713Actor,
    input: {
      projectId: string;
      sessionLabel: string;
      sourceItemCount?: number;
      prepareAssociationBeforeCreate?: boolean;
    }
  ): Promise<{
    sessionId: string;
    externalSessionId: string;
    logicalMemoryId: string;
    sourceItemIds: string[];
    sourceRevision: number;
  }>;
  advanceCapturedSession(
    actor: Hq713Actor,
    input: { sessionId: string; projectId: string; sessionLabel: string }
  ): Promise<{
    laterText: string;
    laterSummaryText: string;
    rawSourceItemId: string;
    canonicalEventId: string;
    canonicalNodeId: string;
    canonicalSourceItemCount: number;
    sourceCursor: number | null;
  }>;
  restartPersonal(actor: Hq713Actor): Promise<void>;
  close(): Promise<void>;
}

type FixtureDatabase = { name: string; url: string; pool: pg.Pool };
type ActorSeed = {
  name: "alice" | "bob";
  id: string;
  teamUserId: string;
  email: string;
  deviceId: string;
  deviceKeyId: string;
  deviceCredentialId: string;
  deviceSecret: string;
  sessionSecret: string;
  apiTokenSecret: string;
  runnerKeyId: string;
  runnerSecret: string;
};

const createClient = (
  baseUrl: string,
  defaultHeaders: Record<string, string>
): Hq713HttpClient => ({
  baseUrl,
  async request<T>(
    method: string,
    path: string,
    options: Hq713RequestOptions = {}
  ) {
    assert.match(path, /^\//, "HQ-713 HTTP path must be absolute");
    const response = await fetch(new URL(path, baseUrl), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        ...defaultHeaders,
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...options.headers
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) })
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    const expected = options.expectedStatus;
    if (
      expected !== undefined &&
      !(Array.isArray(expected)
        ? expected.includes(response.status)
        : response.status === expected)
    ) {
      assert.fail(
        `${method} ${path}: expected ${String(expected)}, got ${response.status}: ${JSON.stringify(body)}`
      );
    }
    return {
      status: response.status,
      body: body as T,
      headers: response.headers
    };
  }
});

const withEnvironment = async <T>(
  patch: Record<string, string>,
  run: () => Promise<T>
): Promise<T> => {
  const previous = new Map(
    Object.keys(patch).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, patch);
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const insertIdentity = async (
  db: pg.Pool,
  actor: ActorSeed,
  pepper: string,
  isTeam: boolean,
  deploymentId: string
) => {
  const localUserId = isTeam ? actor.teamUserId : actor.id;
  await db.query("insert into users(id,email,display_name) values($1,$2,$3)", [
    localUserId,
    actor.email,
    actor.name === "alice" ? "Alice" : "Bob"
  ]);
  await db.query(
    "insert into user_sessions(id,user_id,session_hash,expires_at) values($1,$2,$3,now()+interval '1 day')",
    [randomUUID(), localUserId, hashSecret(pepper, actor.sessionSecret)]
  );
  await db.query(
    `insert into external_auth_identities
      (id,provider,provider_environment,provider_user_id,user_id,email,email_verified,status)
      values($1,'workos_authkit','hq713',$2,$3,$4,true,'linked')`,
    [randomUUID(), `hq713-${actor.id}`, localUserId, actor.email]
  );
  // Team credentials and source-principal links are established by the
  // browser-approved production enrollment below.
  if (!isTeam) {
    await db.query(
      `insert into api_tokens(id,owner_user_id,token_hash,token_prefix,name)
       values($1,$2,$3,$4,'HQ-713 test owner token')`,
      [
        randomUUID(),
        actor.id,
        hashSecret(pepper, actor.apiTokenSecret),
        actor.apiTokenSecret.slice(0, 12)
      ]
    );
    await db.query(
      `insert into device_credentials
       (id,owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,
        lineage_id,verifier_kind,verifier_hash,operation_families,metadata)
       values($1,$2,$3,'hq713-personal',$4,$5,'secret_hash',$6,$7::text[],$8::jsonb)`,
      [
        randomUUID(),
        actor.id,
        actor.runnerKeyId,
        actor.deviceId,
        randomUUID(),
        hashSecret(pepper, actor.runnerSecret),
        ["managed_execution", "managed_file_read", "sync"],
        JSON.stringify({ protocolDeploymentId: deploymentId })
      ]
    );
    await db.query(
      `insert into ai_client_instances
       (owner_user_id,instance_id,driver_id,display_name,config_identity_hash,enabled)
       values($1,'codex.hq713','codex','HQ-713 Codex',$2,true)`,
      [
        actor.id,
        createHash("sha256").update(`${actor.id}:hq713-codex`).digest("hex")
      ]
    );
    await db.query(
      `insert into ai_client_capability_snapshots
       (id,owner_user_id,instance_id,installation_identity_hash,client_version,
        authentication_state,health_state,models,capabilities,expires_at)
       values($1,$2,'codex.hq713',$3,'hq713','authenticated','healthy',$4::jsonb,$5::jsonb,
              now()+interval '1 day')`,
      [
        randomUUID(),
        actor.id,
        createHash("sha256").update(`${actor.id}:hq713-codex`).digest("hex"),
        JSON.stringify([
          {
            id: "gpt-6.1-sol",
            provenance: "reported",
            supportedReasoningEfforts: []
          }
        ]),
        JSON.stringify({
          descriptors: {
            managed_conversation_start: {
              id: "managed_conversation_start",
              support: "supported",
              readiness: "ready",
              diagnostics: []
            }
          }
        })
      ]
    );
  }
};

export const createHq713Fixture = async (): Promise<Hq713Fixture> => {
  assert.ok(
    databaseUrl,
    "KOED_HQ713_TEST_DATABASE_URL is required for the real HTTP suite"
  );
  assert.equal(
    process.env.NODE_ENV,
    "test",
    "HQ-713 may only run under NODE_ENV=test"
  );
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const fixtureStartedAt = Date.now();
  const syncErrorOrigins = new Map<
    string,
    {
      errorClass: string;
      operation: string;
      originFrames: string[];
      recordedAt: number;
    }
  >();
  const normalizedOriginFrames = (error: Error): string[] =>
    (error.stack?.split("\n").slice(1) ?? [])
      .flatMap((frame) => {
        const match = frame.match(
          /(?:^|[\\/])((?:apps|packages)[\\/][\w.\\/-]+\.(?:ts|js)):(\d+):\d+/
        );
        return match ? [`${match[1]!.replaceAll("\\", "/")}:${match[2]}`] : [];
      })
      .slice(0, 4);
  const workerErrors: Array<{
    component: string;
    event: string;
    errorClass: string;
    attempt?: number;
    elapsedMs?: number;
    operation?: string;
    originFrames?: string[];
  }> = [];
  const apiErrors: Array<{
    server: string;
    path: string;
    errorName: string;
    message: string;
    stack: string | null;
  }> = [];
  const collectWorkerError = (component: string, data: unknown) => {
    const details =
      data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const event =
      details.event && typeof details.event === "object"
        ? (details.event as Record<string, unknown>)
        : {};
    const eventName = typeof event.name === "string" ? event.name : "unknown";
    const errorClass =
      typeof details.errorClass === "string" ? details.errorClass : "unknown";
    const origin = syncErrorOrigins.get(component);
    const matchedOrigin =
      eventName === "sync.outbox.failed" &&
      origin?.errorClass === errorClass &&
      Date.now() - origin.recordedAt < 10_000
        ? origin
        : null;
    if (matchedOrigin) syncErrorOrigins.delete(component);
    workerErrors.push({
      component,
      event: eventName,
      errorClass,
      ...(Number.isSafeInteger(details.attempt) && Number(details.attempt) >= 0
        ? { attempt: Number(details.attempt) }
        : {}),
      elapsedMs: Date.now() - fixtureStartedAt,
      ...(matchedOrigin
        ? {
            operation: matchedOrigin.operation,
            originFrames: matchedOrigin.originFrames
          }
        : {})
    });
  };
  const createDriverServer = (
    handler: (
      request: IncomingMessage,
      response: ServerResponse
    ) => Promise<void>
  ) =>
    createHttpServer((request, response) => {
      void handler(request, response).catch((error: unknown) => {
        workerErrors.push({
          component: "fixture-driver",
          event: "request-failed",
          errorClass: error instanceof Error ? error.name : "unknown"
        });
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
  const semanticEmbeddingWorkers: Array<
    ReturnType<typeof createSharedMemoryEmbeddingService>
  > = [];
  let teamSemanticEmbeddingWorker: ReturnType<
    typeof createSharedMemoryEmbeddingService
  > | null = null;
  const activationFailures: Array<Record<string, string | null>> = [];
  const futureFailures: Array<{
    server: string;
    failureStage: string | null;
    reason: string | null;
    errorClass: string | null;
    errorCode: string | null;
    statusCode: number | null;
  }> = [];
  const previousEmbeddingServiceUrl = process.env.EMBEDDING_SERVICE_URL;
  const embeddingService = createDriverServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/embed") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      texts: string[];
    };
    assert.ok(Array.isArray(payload.texts) && payload.texts.length > 0);
    const vector = [1, ...Array<number>(1023).fill(0)];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: "qwen3-0.6b",
        dimensions: 1024,
        measuredTokens: payload.texts.reduce(
          (total, value) =>
            total + Math.max(1, value.trim().split(/\s+/).length),
          0
        ),
        vectors: payload.texts.map(() => vector),
        chunks: payload.texts.map((value, inputIndex) => ({
          inputIndex,
          chunkIndex: 0,
          chunkCount: 1,
          tokenCount: Math.max(1, value.trim().split(/\s+/).length),
          text: value,
          vector
        }))
      })
    );
  });
  await new Promise<void>((resolve) =>
    embeddingService.listen(0, "127.0.0.1", resolve)
  );
  const embeddingAddress = embeddingService.address();
  assert.ok(embeddingAddress && typeof embeddingAddress !== "string");
  const embeddingServiceUrl = `http://127.0.0.1:${embeddingAddress.port}`;
  process.env.EMBEDDING_SERVICE_URL = embeddingServiceUrl;
  const namePrefix = `hq713_${randomUUID().replaceAll("-", "")}`;
  const databases: FixtureDatabase[] = [];
  const servers: FastifyInstance[] = [];
  const syncWorkers: Array<{ stop(): Promise<void> }> = [];
  const privacyWorkers: Array<{ stop(): Promise<void> }> = [];
  let privacyService: ReturnType<typeof createHttpServer> | null = null;
  const runtimeEnvironments = new Map<string, NodeJS.ProcessEnv>();
  const deploymentIds = new Map<string, string>();
  const repositoryRoot = fileURLToPath(
    new URL("../../../../", import.meta.url)
  );
  const fixtureScratch = join(repositoryRoot, "scratch", "hq713-test-homes");
  await mkdir(fixtureScratch, { recursive: true });
  const home = await mkdtemp(join(fixtureScratch, "koed-hq713-"));
  const pepper = randomBytes(32).toString("base64url");
  const personalKey = randomBytes(32).toString("base64");
  const personalEncryptionProvider =
    createEnvelopeEncryptionProviderFromEnvironment({
      environment: { API_DATA_ENCRYPTION_KEY: personalKey }
    });
  assert.ok(personalEncryptionProvider);
  const teamKey = randomBytes(32).toString("base64");
  const ownerKey = randomBytes(32).toString("base64");
  let teamCuratedWithdrawalBlocked = false;
  let dropNextTeamCuratedUpdateResponse = false;
  let teamCuratedUpdateResponseDrops = 0;
  const blockedTeamPaths = new Set<string>();
  const actors: ActorSeed[] = (["alice", "bob"] as const).map((name) => ({
    name,
    id: randomUUID(),
    teamUserId: randomUUID(),
    email: `${name}.${namePrefix}@example.test`,
    deviceId: randomUUID(),
    deviceKeyId: `hq713-${name}-${randomUUID()}`,
    deviceCredentialId: "",
    deviceSecret: `cmd_${randomBytes(32).toString("base64url")}`,
    sessionSecret: `cms_${randomBytes(32).toString("base64url")}`,
    apiTokenSecret: `cmt_${randomBytes(32).toString("base64url")}`,
    runnerKeyId: `hq713-runner-${name}-${randomUUID()}`,
    runnerSecret: `cmd_${randomBytes(32).toString("base64url")}`
  }));
  const createDatabase = async (suffix: string): Promise<FixtureDatabase> => {
    const name = `${namePrefix}_${suffix}`;
    await admin.query(`create database ${quoteIdentifier(name)}`);
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    const result = {
      name,
      url: url.toString(),
      pool: new pg.Pool({ connectionString: url.toString(), max: 5 })
    };
    databases.push(result);
    return result;
  };
  const apiInstances = new Map<
    string,
    {
      db: FixtureDatabase;
      profile: string;
      port: number;
      app: FastifyInstance;
    }
  >();
  const start = async (
    db: FixtureDatabase,
    profile: string,
    suffix: string,
    fixedPort?: number
  ) => {
    const koedHome = join(home, suffix);
    const port = fixedPort ?? (await reserveLoopbackPort());
    const serverOrigin = `http://127.0.0.1:${port}`;
    const identity = await ensureDeviceIdentity(
      resolveKoedServerPaths({ NODE_ENV: "test", KOED_HOME: koedHome }),
      { environment: { NODE_ENV: "test", KOED_HOME: koedHome } }
    );
    assert.equal(
      identity.health,
      "healthy",
      `${suffix} device identity initialization`
    );
    assert.ok(identity.deploymentId);
    deploymentIds.set(suffix, identity.deploymentId);
    const enrolledActor = actors.find((actor) => actor.name === suffix);
    if (enrolledActor) {
      assert.ok(identity.deviceInstanceId);
      enrolledActor.deviceId = identity.deviceInstanceId;
    }
    const serverEnvironment = {
      DATABASE_URL: db.url,
      KOED_DEPLOYMENT_PROFILE: profile,
      KOED_TEAM_COLLABORATION_ENABLED: "true",
      COLLABORATION_REALTIME_CURSOR_SECRET: pepper,
      // Personal services own the real Desktop realtime broker. The Team
      // backend remains external and receives only enrolled device traffic.
      KOED_RUNTIME_MODE: suffix === "team" ? "external" : "local-personal",
      COLLABORATION_LOCAL_BROKER_SECRET:
        suffix === "team" ? "" : randomBytes(32).toString("hex"),
      KOED_HOME: koedHome,
      KOED_DEVICE_PROOF_DIR: join(`${koedHome}-proof-root`, "proof"),
      API_TOKEN_PEPPER: pepper,
      API_DATA_ENCRYPTION_KEY: personalKey,
      TEAM_MEMORY_DATA_ENCRYPTION_KEY: teamKey,
      OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY: ownerKey,
      WORKOS_AUTHKIT_ENABLED: "true",
      WORKOS_PROVIDER_ENVIRONMENT: "hq713",
      CORS_ORIGINS: `${browserOrigin},${serverOrigin}`,
      COOKIE_SECURE: "false",
      EMBEDDING_SERVICE_URL: embeddingServiceUrl
    };
    runtimeEnvironments.set(suffix, { ...process.env, ...serverEnvironment });
    const app = await withEnvironment(serverEnvironment, () =>
      buildServer({
        conversationSourceSignerFactory:
          suffix === "team"
            ? undefined
            : (input) =>
                createDeviceBoundSourceSigner({
                  ...input,
                  environment: serverEnvironment
                }),
        inspectDeploymentIdentity: () =>
          inspectDeviceIdentityAtKoedHome({
            koedHome,
            environment: {
              NODE_ENV: "test",
              KOED_DEVICE_PROOF_DIR: join(`${koedHome}-proof-root`, "proof")
            }
          })
      })
    );
    // Capture only the production worker's bounded diagnostic fields. This
    // observes logging; it supplies no successful response or business state.
    const originalWarn = app.log.warn;
    app.log.warn = ((data: unknown, ...args: unknown[]) => {
      if (data && typeof data === "object" && activationFailures.length < 30) {
        const fields = data as Record<string, unknown>;
        const event = fields.event as Record<string, unknown> | undefined;
        if (
          event?.name === "shared_memory_control_failed" &&
          apiErrors.length < 30
        ) {
          apiErrors.push({
            server: suffix,
            path: "shared_memory_control",
            errorName: String(event.error_class),
            message: JSON.stringify(event),
            stack: null
          });
        }
        if (event?.name === "pending_share.activation.failed") {
          const bounded = (key: string) =>
            typeof fields[key] === "string"
              ? String(fields[key]).slice(0, 160)
              : null;
          activationFailures.push({
            server: suffix,
            pendingShareId: bounded("pendingShareId"),
            failureStage: bounded("failureStage"),
            errorClass: bounded("errorClass"),
            errorCode: bounded("errorCode")
          });
        }
        if (
          event?.name === "project_share_policy.future.failed" &&
          futureFailures.length < 20
        ) {
          const bounded = (key: string) =>
            typeof fields[key] === "string"
              ? String(fields[key]).slice(0, 80)
              : null;
          futureFailures.push({
            server: suffix,
            failureStage: bounded("failureStage"),
            reason: bounded("reason"),
            errorClass: bounded("errorClass"),
            errorCode: bounded("errorCode"),
            statusCode:
              typeof fields.statusCode === "number" &&
              Number.isInteger(fields.statusCode)
                ? fields.statusCode
                : null
          });
        }
        if (
          event?.name === "shared_memory_action_grant_binding_failed" &&
          apiErrors.length < 30
        ) {
          apiErrors.push({
            server: suffix,
            path: "/v1/shared-memory/pending-shares",
            errorName: "TeamActionGrantBindingFailed",
            message: `stage=${String(event.failure_stage ?? "unknown").slice(0, 40)};operation=${String(event.operation ?? "unknown").slice(0, 100)}`,
            stack: null
          });
        }
      }
      Reflect.apply(originalWarn, app.log, [data, ...args]);
    }) as typeof app.log.warn;
    const originalError = app.log.error;
    app.log.error = function (
      this: typeof app.log,
      data: unknown,
      ...args: unknown[]
    ) {
      if (data && typeof data === "object" && apiErrors.length < 30) {
        const validation = (
          data as { validation?: { schema?: unknown; issues?: unknown } }
        ).validation;
        if (
          validation?.schema === "collaboration_snapshot" &&
          Array.isArray(validation.issues)
        ) {
          apiErrors.push({
            server: suffix,
            path: "collaboration_snapshot",
            errorName: "SnapshotValidation",
            message: JSON.stringify(
              validation.issues.slice(0, 6).map((issue: unknown) => {
                const item = issue as {
                  code?: unknown;
                  path?: unknown;
                  message?: unknown;
                };
                return {
                  code: item.code,
                  path: item.path,
                  message:
                    typeof item.message === "string"
                      ? item.message.slice(0, 200)
                      : null
                };
              })
            ),
            stack: null
          });
        }
      }
      Reflect.apply(originalError, this, [data, ...args]);
    } as typeof app.log.error;
    app.addHook("onError", async (request, _reply, error) => {
      if (apiErrors.length >= 30) return;
      apiErrors.push({
        server: suffix,
        path: new URL(request.url, "http://koed.local").pathname,
        errorName: error.name.slice(0, 120),
        message: error.message.slice(0, 500),
        stack: error.stack?.slice(0, 2_000) ?? null
      });
    });
    app.addHook("onSend", async (request, reply, payload) => {
      const path = new URL(request.url, "http://koed.local").pathname;
      if (
        suffix === "team" &&
        reply.statusCode >= 400 &&
        path === "/v1/shared-memory/pending-shares" &&
        apiErrors.length < 30
      ) {
        let bindingComparison = "unavailable";
        try {
          const parsed = createPendingShareSchema.safeParse(request.body);
          const authorization = request.headers.authorization;
          const credentialKeyId =
            typeof authorization === "string"
              ? /^Koed-Device ([^:]+):/.exec(authorization)?.[1]
              : undefined;
          const suppliedActionGrant = request.headers["x-koed-action-grant"];
          const actionGrantSecret = Array.isArray(suppliedActionGrant)
            ? suppliedActionGrant[0]
            : suppliedActionGrant;
          if (parsed.success && credentialKeyId) {
            const input = parsed.data;
            if (input.authority.source === "device_action_grant") {
              const binding = sharedMemoryPendingShareActionGrantBinding({
                referenceId: input.authority.referenceId,
                source: input.source,
                sourceCapabilities: input.sourceCapabilities,
                activationRepresentation: input.activationRepresentation,
                mutationId: input.mutationId,
                logicalGrantId: input.logicalGrantId,
                consentId: input.consentId,
                logicalMemoryId: input.logicalMemoryId,
                teamId: input.teamId,
                teamWorkspaceId: input.teamWorkspaceId,
                ...(input.workspaceProjectId
                  ? { workspaceProjectId: input.workspaceProjectId }
                  : {}),
                previewId: input.preview.previewId,
                previewRevision: input.previewRevision,
                previewHash: input.preview.previewHash,
                mode: input.mode,
                maximumFidelity: input.maximumFidelity,
                includeCuratedMemory: input.includeCuratedMemory,
                expiresAt: input.expiresAt
              });
              const comparison = await db.pool.query<{
                action_match: boolean;
                scope_match: boolean;
                request_match: boolean;
                target_match: boolean;
                team_match: boolean;
                credential_match: boolean;
                secret_match: boolean;
                credential_active: boolean;
                workspace_share_allowed: boolean;
                grant_state: string;
                use_count: number;
                approval_tier: string;
                confirmation_state: string;
                unexpired: boolean;
              }>(
                `select grant_row.action=$2 as action_match,
                      grant_row.scope_hash=$3 as scope_match,
                      grant_row.request_hash=$4 as request_match,
                      grant_row.target_id=$5 as target_match,
                      grant_row.team_id=$6 as team_match,
                      credential.credential_key_id=$7
                        and credential.id=grant_row.device_credential_id as credential_match,
                      grant_row.secret_commitment=$8 as secret_match,
                      credential.revoked_at is null
                        and (credential.expires_at is null or credential.expires_at>now())
                        and 'share_grant_management'=any(credential.operation_families)
                        as credential_active,
                      exists (
                        select 1 from teams team
                        join team_memberships member
                          on member.team_id=team.id
                         and member.user_id=grant_row.owner_user_id
                         and member.status='enabled' and member.disabled_at is null
                        join users owner_user
                          on owner_user.id=member.user_id
                         and owner_user.disabled_at is null
                         and owner_user.deleted_at is null
                        join team_workspaces workspace
                          on workspace.team_id=team.id and workspace.id=$9
                         and workspace.lifecycle='active'
                         and workspace.archived_at is null
                        join team_workspace_access_grants access_grant
                          on access_grant.team_id=team.id
                         and access_grant.team_workspace_id=workspace.id
                         and access_grant.user_id=member.user_id
                         and access_grant.access='write'
                         and access_grant.can_share_owned_memory=true
                         and access_grant.disabled_at is null
                        where team.id=$6 and team.lifecycle='active'
                          and team.entitlement_status in ('active','grace')
                      ) as workspace_share_allowed,
                      grant_row.state as grant_state,grant_row.use_count,
                      confirmation.approval_tier,
                      confirmation.state as confirmation_state,
                      grant_row.expires_at>now() as unexpired
                 from high_risk_browser_confirmations confirmation
                 join high_risk_device_action_grants grant_row
                   on grant_row.confirmation_id=confirmation.id
                 join device_credentials credential
                   on credential.id=grant_row.device_credential_id
                where confirmation.client_request_id=$1
                limit 1`,
                [
                  input.authority.referenceId,
                  binding.action,
                  binding.scopeHash,
                  binding.requestHash,
                  binding.targetId,
                  binding.teamId,
                  credentialKeyId,
                  typeof actionGrantSecret === "string" &&
                  /^hrg_[A-Za-z0-9_-]{20,124}$/.test(actionGrantSecret)
                    ? highRiskActionGrantCommitment(actionGrantSecret)
                    : null,
                  input.teamWorkspaceId
                ]
              );
              bindingComparison = JSON.stringify(comparison.rows[0] ?? null);
            }
          }
        } catch {
          // A read-only diagnostic must never alter the production response.
        }
        let errorCode = "unknown";
        if (typeof payload === "string") {
          try {
            const parsed = JSON.parse(payload) as { code?: unknown };
            if (typeof parsed.code === "string")
              errorCode = parsed.code.slice(0, 80);
          } catch {
            // The HTTP status remains sufficient for this bounded diagnostic.
          }
        }
        apiErrors.push({
          server: suffix,
          path,
          errorName: "TeamPendingShareRejection",
          message: `status=${reply.statusCode};code=${errorCode};binding=${bindingComparison}`,
          stack: null
        });
      }
      if (
        suffix === "team" &&
        reply.statusCode >= 400 &&
        path.endsWith("/share-policy/initial-bundles") &&
        apiErrors.length < 30
      ) {
        apiErrors.push({
          server: suffix,
          path,
          errorName: "TeamHttpRejection",
          message:
            typeof payload === "string"
              ? payload.slice(0, 500)
              : "Non-text Team rejection",
          stack: null
        });
      }
      if (
        suffix === "team" &&
        dropNextTeamCuratedUpdateResponse &&
        request.method === "PUT" &&
        /^\/v1\/shared-memory\/pending-shares\/[0-9a-f-]{36}\/curated-source\/updates$/i.test(
          path
        ) &&
        reply.statusCode >= 200 &&
        reply.statusCode < 300
      ) {
        // onSend runs after the production handler's transaction commits.
        // Lose only the reply so the Personal worker must discover the real
        // Team receipt through its normal idempotent retry.
        dropNextTeamCuratedUpdateResponse = false;
        teamCuratedUpdateResponseDrops += 1;
        reply.hijack();
        reply.raw.destroy();
      }
      return payload;
    });
    if (suffix === "team") {
      app.addHook("onRequest", async (request, reply) => {
        if (
          blockedTeamPaths.has(
            `${request.method.toUpperCase()} ${new URL(request.url, "http://koed.local").pathname}`
          ) ||
          (teamCuratedWithdrawalBlocked &&
            request.method === "POST" &&
            new URL(request.url, "http://koed.local").pathname ===
              "/v1/shared-memory/curated-withdrawals")
        ) {
          await reply
            .status(503)
            .send({ error: "HQ-713 temporary Team outage" });
        }
      });
    }
    servers.push(app);
    const origin = await app.listen({ host: "127.0.0.1", port });
    apiInstances.set(suffix, { db, profile, port, app });
    return origin;
  };
  let closed = false;
  const waitForDisconnectedBackends = async (database: string) => {
    const deadline = Date.now() + 1_000;
    while (true) {
      const active = await admin.query<{ count: number }>(
        "select count(*)::int as count from pg_stat_activity where datname=$1",
        [database]
      );
      const count = active.rows[0]?.count;
      assert.equal(typeof count, "number");
      if (count === 0) return;
      if (Date.now() >= deadline)
        throw new Error(
          `Fixture database ${database} retained ${count} backend connection(s) after pool shutdown.`
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const worker of syncWorkers) await worker.stop();
    for (const worker of privacyWorkers) await worker.stop();
    for (const worker of semanticEmbeddingWorkers) await worker.stop();
    for (const server of servers.reverse()) await server.close();
    if (privacyService)
      await new Promise<void>((resolve, reject) =>
        privacyService!.close((error) => (error ? reject(error) : resolve()))
      );
    await new Promise<void>((resolve, reject) =>
      embeddingService.close((error) => (error ? reject(error) : resolve()))
    );
    for (const db of databases.reverse()) {
      await db.pool.end();
      // Pool.end() can resolve before PostgreSQL retires its backend. A
      // forced drop would interrupt that still-closing client with 57P01.
      await waitForDisconnectedBackends(db.name);
      await admin.query(`drop database if exists ${quoteIdentifier(db.name)}`);
    }
    await admin.end();
    if (previousEmbeddingServiceUrl === undefined)
      delete process.env.EMBEDDING_SERVICE_URL;
    else process.env.EMBEDDING_SERVICE_URL = previousEmbeddingServiceUrl;
    await rm(home, { recursive: true, force: true });
  };
  try {
    const teamDb = await createDatabase("team");
    const aliceDb = await createDatabase("alice");
    const bobDb = await createDatabase("bob");
    const teamUrl = await start(teamDb, "team_self_hosted", "team");
    const aliceUrl = await start(aliceDb, "local_personal", "alice");
    const bobUrl = await start(bobDb, "local_personal", "bob");
    for (const actor of actors) {
      await insertIdentity(
        teamDb.pool,
        actor,
        pepper,
        true,
        deploymentIds.get(actor.name)!
      );
      await insertIdentity(
        actor.name === "alice" ? aliceDb.pool : bobDb.pool,
        actor,
        pepper,
        false,
        deploymentIds.get(actor.name)!
      );
    }
    for (const [actorName, db] of [
      ["alice", aliceDb],
      ["bob", bobDb]
    ] as const) {
      const localDeployment = await db.pool.query<{
        protocol_deployment_id: string;
        profile: string;
      }>(
        `select protocol_deployment_id,profile from deployment_identities where locality='local'`
      );
      assert.equal(localDeployment.rows.length, 1);
      assert.equal(
        localDeployment.rows[0]?.protocol_deployment_id,
        deploymentIds.get(actorName)
      );
      assert.equal(localDeployment.rows[0]?.profile, "local_personal");
    }
    const privacyRepository = createPrivacyClassificationRepository(
      teamDb.pool,
      {
        fingerprintKey: derivePrivacyFingerprintKey(personalKey)
      }
    );
    const classifierComponentHash = (value: string) =>
      createHash("sha256").update(`hq713:${value}`).digest("hex");
    const classifier = await privacyRepository.registerClassifierGeneration({
      version: 1,
      modelKey: "hq713-deterministic-local-input",
      modelRevision: "hq713-test-v1",
      artifactSha256: classifierComponentHash("artifact"),
      tokenizerSha256: classifierComponentHash("tokenizer"),
      decoderSha256: classifierComponentHash("decoder"),
      calibrationSha256: classifierComponentHash("calibration"),
      deterministicDetectorVersion: "structured-secrets-v1"
    });
    await privacyRepository.activateClassifierGeneration(classifier.id);
    const teamDeployment = await teamDb.pool.query<{ id: string }>(
      `insert into deployment_identities(protocol_deployment_id,locality,profile,display_name)
       values($1,'local','team_self_hosted','HQ-713 Team fixture')
       on conflict(protocol_deployment_id) do update
       set display_name=excluded.display_name returning id`,
      [deploymentIds.get("team")]
    );
    assert.equal(teamDeployment.rowCount, 1);
    await privacyRepository.createContentPolicyVersion({
      scope: "deployment",
      subject: { deploymentIdentityId: teamDeployment.rows[0]!.id },
      labels: noPrivacyLabelsPolicy(),
      expectedPreviousVersion: 0
    });
    const privacyToken = `hq713-privacy-${randomBytes(24).toString("base64url")}`;
    privacyService = createDriverServer(async (request, response) => {
      if (request.headers["x-koed-privacy-token"] !== privacyToken) {
        response.writeHead(401).end();
        return;
      }
      const sendJson = (body: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "GET" && request.url === "/v1/capabilities") {
        sendJson({
          schemaVersion: 1,
          inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
          tokenizerSha256: classifierComponentHash("tokenizer"),
          tokenizerNormalization: "none",
          maximumFieldsPerRequest: PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT,
          maximumFieldBytes: PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES,
          maximumRequestFieldBytes:
            PRIVACY_CLASSIFICATION_MAX_REQUEST_FIELD_BYTES,
          maximumRequestBodyBytes:
            PRIVACY_CLASSIFICATION_MAX_REQUEST_BODY_BYTES,
          windowCoreTokens: PRIVACY_WINDOW_CORE_TOKENS,
          windowContextTokens: PRIVACY_WINDOW_CONTEXT_TOKENS,
          windowMaximumTokens: PRIVACY_WINDOW_MAX_TOKENS,
          maximumFieldTokens: PRIVACY_MAX_FIELD_TOKENS,
          maximumSemanticPreviewFields:
            SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_FIELDS,
          maximumSemanticPreviewBytes: SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_BYTES,
          maximumSemanticPreviewEncodedBytes:
            SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ENCODED_BYTES,
          maximumConcurrentRequests: PRIVACY_MAX_CONCURRENT_REQUESTS
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/classify") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          fields: Array<{ path: string; text: string }>;
        };
        assert.ok(Array.isArray(payload.fields) && payload.fields.length > 0);
        sendJson({
          schemaVersion: 1,
          inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
          classifier: {
            classifierHash: classifier.classifierHash,
            modelKey: classifier.modelKey,
            modelRevision: classifier.modelRevision
          },
          fields: payload.fields.map((field) => ({
            path: field.path,
            inputSha256: createHash("sha256").update(field.text).digest("hex"),
            inputByteLength: Buffer.byteLength(field.text, "utf8"),
            maskedText: field.text,
            spans: [],
            decodedTextMatchesInput: true
          }))
        });
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      privacyService!.listen(0, "127.0.0.1", resolve)
    );
    const privacyAddress = privacyService.address();
    assert.ok(privacyAddress && typeof privacyAddress !== "string");
    const teamEnvironment = runtimeEnvironments.get("team");
    assert.ok(teamEnvironment);
    const teamEncryptionProvider =
      createTeamMemoryEnvelopeEncryptionProviderFromEnvironment({
        environment: teamEnvironment
      });
    const ownerPrivateProvider =
      createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
        environment: teamEnvironment
      });
    assert.ok(teamEncryptionProvider && ownerPrivateProvider);
    const sharedMemoryRepository = createSharedMemoryRepository(teamDb.pool, {
      resolvePersonalEncryptionProvider: () => personalEncryptionProvider,
      resolveTeamEncryptionProvider: () => teamEncryptionProvider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerPrivateProvider
    });
    const privacyMaterializer = createSharedMemoryPrivacyMaterializationService(
      {
        sharedMemoryRepository,
        privacyRepository,
        privacyService: createPrivacyServiceClient({
          baseUrl: `http://127.0.0.1:${privacyAddress.port}`,
          token: privacyToken
        }),
        classificationEncryptionProvider: personalEncryptionProvider,
        wakePool: teamDb.pool,
        logger: {
          info() {},
          warn(data) {
            collectWorkerError("privacy", data);
          }
        }
      }
    );
    privacyMaterializer.start();
    privacyWorkers.push(privacyMaterializer);
    const startRealSyncWorker = async (db: FixtureDatabase, suffix: string) => {
      const environment = runtimeEnvironments.get(suffix);
      assert.ok(environment);
      const envelopeEncryptionProvider =
        createEnvelopeEncryptionProviderFromEnvironment({ environment });
      assert.ok(envelopeEncryptionProvider);
      const repository = createMemorySourceRepository(db.pool, {
        envelopeEncryptionProvider,
        teamEnvelopeEncryptionProvider:
          createTeamMemoryEnvelopeEncryptionProviderFromEnvironment({
            environment
          }),
        ownerPrivateReplicaEnvelopeEncryptionProvider:
          createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
            environment
          })
      });
      // The production logger emits only an error class. Observe repository
      // boundaries in this fixture so a worker failure identifies its source
      // line without recording the error message or synchronized content.
      for (const operation of [
        "claimSyncQueueEntry",
        "renewSyncQueueLease",
        "readCapturedSessionSyncDelta",
        "getSyncTransportContext",
        "getSyncPackageBySequence",
        "deleteIncompleteSourceSyncPackage",
        "createSyncPackageUploadSession",
        "recordSyncPackageChunk",
        "getSyncPackageForService",
        "refreshSourceSyncHeartbeat",
        "completeSyncQueueEntry",
        "markSourceSyncUploadCommitted",
        "markSourceSyncProcessing",
        "deferSyncQueueEntry",
        "acknowledgeSourceSyncPackage"
      ] as const) {
        const original = repository[operation];
        Object.defineProperty(repository, operation, {
          value: async (...args: unknown[]) => {
            try {
              return await Reflect.apply(original, repository, args);
            } catch (error) {
              if (error instanceof Error)
                syncErrorOrigins.set(`${suffix}-sync`, {
                  errorClass: error.name.slice(0, 120),
                  operation,
                  originFrames: normalizedOriginFrames(error),
                  recordedAt: Date.now()
                });
              throw error;
            }
          }
        });
      }
      // Observe the real publication method without changing its result or
      // authority. Keep only an error class and source location, never content.
      const advanceContinuous =
        repository.advanceContinuousGrantRepresentations;
      repository.advanceContinuousGrantRepresentations = async (input) => {
        try {
          return await advanceContinuous(input);
        } catch (error) {
          if (apiErrors.length < 30)
            apiErrors.push({
              server: suffix,
              path: "continuous-publication",
              errorName:
                error instanceof Error ? error.name.slice(0, 120) : "unknown",
              message:
                error instanceof Error
                  ? (error.stack
                      ?.split("\n")
                      .find((line) =>
                        line.includes("shared-memory-repository.ts:")
                      )
                      ?.trim()
                      .slice(0, 500) ?? "No source location")
                  : "No source location",
              stack: null
            });
          throw error;
        }
      };
      const embeddingWorkflow = createEmbeddingWorkflow({
        env: resolveWorkerEnv(environment),
        repository: () => repository
      });
      if (suffix === "team") {
        const semanticEmbeddings = createSharedMemoryEmbeddingService({
          embeddingWorkflow,
          wakePool: db.pool,
          logger: {
            info() {},
            error(data) {
              collectWorkerError("team-semantic-embedding", data);
            }
          }
        });
        await semanticEmbeddings.processOnce();
        semanticEmbeddings.start();
        semanticEmbeddingWorkers.push(semanticEmbeddings);
        teamSemanticEmbeddingWorker = semanticEmbeddings;
      }
      const koedHome = join(home, suffix);
      const service = createCrossIdentitySyncService({
        repository,
        recipientKeyEncryptionProvider: envelopeEncryptionProvider,
        embeddingWorkflow,
        koedHome,
        isSourceIdentityHealthy: () =>
          inspectDeviceIdentityAtKoedHome({
            koedHome,
            environment: {
              NODE_ENV: "test",
              KOED_DEVICE_PROOF_DIR: join(`${koedHome}-proof-root`, "proof")
            }
          }).remoteOperationsAllowed,
        intervalMs: 250,
        staleAfterSeconds: 3600,
        logger: {
          info() {},
          warn(data) {
            collectWorkerError(`${suffix}-sync`, data);
          },
          error(data) {
            collectWorkerError(`${suffix}-sync`, data);
          }
        }
      });
      syncErrorOrigins.delete(`${suffix}-sync`);
      await service.processOnce();
      let running = true;
      let timer: NodeJS.Timeout | null = null;
      let active: Promise<void> | null = null;
      const schedule = () => {
        if (!running) return;
        timer = setTimeout(() => {
          timer = null;
          syncErrorOrigins.delete(`${suffix}-sync`);
          active = service
            .processOnce()
            .then(() => undefined)
            .catch((error: unknown) => {
              collectWorkerError(`${suffix}-sync`, {
                event: { name: "sync.service.failed" },
                errorClass: error instanceof Error ? error.name : "UnknownError"
              });
            })
            .finally(() => {
              active = null;
              schedule();
            });
        }, 250);
      };
      schedule();
      syncWorkers.push({
        async stop() {
          running = false;
          if (timer) clearTimeout(timer);
          await active;
        }
      });
    };
    await startRealSyncWorker(teamDb, "team");
    await startRealSyncWorker(aliceDb, "alice");
    await startRealSyncWorker(bobDb, "bob");
    const actorClient = (seed: ActorSeed, personalUrl: string): Hq713Actor => {
      const deviceAuthorization = `Koed-Device ${seed.deviceKeyId}:${seed.deviceSecret}`;
      const sessionCookie = `cm_session=${seed.sessionSecret}`;
      const personalHome = join(home, seed.name);
      const desktopAuthorization = storeDesktopLocalCredential(personalHome, {
        ownerUserId: seed.id,
        operationFamilies: [
          "personal_collaboration_read",
          "personal_collaboration_write",
          "managed_execution"
        ]
      }).authorization;
      storeLocalEdgeClientCredential(personalHome, {
        backendId: teamBackendId,
        secret: `hle_${randomBytes(32).toString("base64url")}`,
        operationFamilies: [
          "team_workspace_read",
          "team_workspace_write",
          "share_grant_management",
          "memory_answer_execution"
        ]
      });
      const teamClientAuthorization =
        readLocalEdgeClientCredentialAuthorization(
          personalHome,
          teamBackendId
        )?.authorization;
      assert.ok(teamClientAuthorization);
      const browserHeaders = {
        cookie: sessionCookie,
        origin: browserOrigin,
        "sec-fetch-site": "same-site"
      };
      return {
        name: seed.name,
        koedHome: personalHome,
        deploymentId: deploymentIds.get(seed.name)!,
        id: seed.id,
        teamUserId: seed.teamUserId,
        email: seed.email,
        deviceId: seed.deviceId,
        deviceAuthorization,
        sessionCookie,
        personalTokenAuthorization: `Bearer ${seed.apiTokenSecret}`,
        team: createClient(teamUrl, { authorization: deviceAuthorization }),
        teamBrowser: createClient(teamUrl, {
          cookie: sessionCookie,
          origin: new URL(teamUrl).origin,
          "sec-fetch-site": "same-origin"
        }),
        personal: createClient(personalUrl, browserHeaders),
        personalEdge: createClient(personalUrl, {
          authorization: desktopAuthorization,
          "x-koed-team-client-credential": teamClientAuthorization
        }),
        personalBrowser: createClient(personalUrl, {
          cookie: sessionCookie,
          origin: new URL(personalUrl).origin,
          "sec-fetch-site": "same-origin"
        }),
        personalTokenClient: createClient(personalUrl, {
          authorization: `Bearer ${seed.apiTokenSecret}`
        }),
        personalRunner: createClient(personalUrl, {
          authorization: `Koed-Device ${seed.runnerKeyId}:${seed.runnerSecret}`
        }),
        aiClientInstanceId: "codex.hq713",
        managedLaunch: { instanceId: "codex.hq713", model: "gpt-6.1-sol" }
      };
    };
    const alice = actorClient(actors[0]!, aliceUrl);
    const bob = actorClient(actors[1]!, bobUrl);
    for (const [actor, seed] of [
      [alice, actors[0]!],
      [bob, actors[1]!]
    ] as const) {
      seed.deviceCredentialId = await enrollHq713TeamSource({
        actor,
        seed,
        teamBackendId
      });
    }
    const advertised = await alice.team.request<Record<string, unknown>>(
      "GET",
      "/v1/capabilities",
      { expectedStatus: 200 }
    );
    const advertisedCapabilities = advertised.body.capabilities as
      | Record<string, { availability?: string }>
      | undefined;
    assert.equal(
      advertisedCapabilities?.["memory.answerTasks"]?.availability,
      "available",
      "Team must actually advertise Memory Answer Tasks"
    );
    assert.equal(
      advertisedCapabilities?.["memory.crossIdentitySync"]?.availability,
      "available",
      "Team must actually advertise Cross Identity Sync"
    );
    const advertisedV2 = teamCollaborationV2CapabilitiesSchema.parse(
      (
        await alice.team.request("GET", "/v2/capabilities", {
          expectedStatus: 200
        })
      ).body
    );
    assert.equal(
      advertisedV2.teamCollaboration.availability,
      "available",
      "Team must actually advertise Collaboration v2"
    );
    for (const seed of actors) {
      const personalHome = join(home, seed.name);
      const credential = storeUpstreamCredentialSecret(personalHome, {
        backendId: teamBackendId,
        credentialKeyId: seed.deviceKeyId,
        secret: seed.deviceSecret
      });
      await mkdir(join(personalHome, "config"), { recursive: true });
      await writeFile(
        join(personalHome, "config", "upstream-backends.json"),
        JSON.stringify({
          schemaVersion: 2,
          activeBackendId: teamBackendId,
          backends: [
            {
              id: teamBackendId,
              baseUrl: teamUrl,
              profile: "team_self_hosted",
              credential: {
                status: "configured",
                reference: credential.reference
              },
              routePolicy: {
                teamWorkspaceRead: "enabled",
                admin: "enabled",
                shareGrantManagement: "enabled",
                memoryAnswerExecution: "enabled",
                sync: "enabled"
              },
              capabilities: {
                state: "validated",
                schemaVersion: advertised.body.capabilitySchemaVersion,
                expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                payload: advertised.body,
                teamCollaborationV2: {
                  state: "validated",
                  checkedAt: new Date().toISOString(),
                  expiresAt: new Date(
                    Date.now() + 60 * 60 * 1000
                  ).toISOString(),
                  schemaVersion: advertisedV2.capabilitySchemaVersion,
                  payload: advertisedV2
                }
              }
            }
          ]
        })
      );
      const enrollmentPath = join(
        personalHome,
        "run",
        "upstream-enrollments.json"
      );
      await mkdir(join(personalHome, "run"), { recursive: true });
      await writeFile(
        enrollmentPath,
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          enrollments: [
            {
              backendId: teamBackendId,
              requestId: randomUUID(),
              state: "exchanged",
              activationUrl: null,
              requestedOperationFamilies: [
                "action_grant",
                "team_workspace_read",
                "team_workspace_write",
                "share_grant_management",
                "sync",
                "managed_execution",
                "memory_answer_execution"
              ],
              deviceCredentialId: seed.deviceCredentialId,
              principalUserId: seed.teamUserId,
              sourceOwnerPrincipalId: seed.id,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              expiresAt: null,
              credential: {
                status: "configured",
                reference: credential.reference
              }
            }
          ]
        })
      );
      const enrollment = readLocalEdgeUpstreamEnrollmentBinding(
        enrollmentPath,
        teamBackendId
      );
      assert.equal(enrollment?.deviceCredentialId, seed.deviceCredentialId);
      assert.equal(enrollment?.principalUserId, seed.teamUserId);
      assert.equal(enrollment?.sourceOwnerPrincipalId, seed.id);
      assert.equal(
        readUpstreamCredentialAuthorization(personalHome, credential.reference),
        `Koed-Device ${seed.deviceKeyId}:${seed.deviceSecret}`,
        "Active enrollment must use the verified Team device credential"
      );
    }
    const recorded = new Map<string, Record<string, unknown>>();
    const results: Hq713ResultRegistry = {
      record(id, evidence) {
        assert.ok(!recorded.has(id), `Duplicate HQ-713 assertion: ${id}`);
        assert.ok(
          Object.keys(evidence).length,
          `HQ-713 ${id} needs concrete evidence`
        );
        recorded.set(id, evidence);
      },
      entries: () => [...recorded].map(([id, evidence]) => ({ id, evidence }))
    };
    const localCommand: Hq713Fixture["localCommand"] = async (
      actor,
      command,
      input,
      options = {}
    ) => {
      const response = await actor.personalEdge.request<
        Record<string, unknown>
      >("POST", "/v1/local-edge/collaboration/command", {
        body: {
          ...(options.personal ? {} : { upstream_backend_id: teamBackendId }),
          command: {
            contractVersion: COLLABORATION_CONTRACT_VERSION,
            requestId: options.requestId ?? randomUUID(),
            command,
            input
          }
        },
        expectedStatus: 200
      });
      let enrollmentDiagnostics: unknown = null;
      if (
        response.body.ok !== true &&
        command === "collaboration.preview_shared_memory"
      ) {
        const diagnostics = await teamDb.pool.query(
          `select
            (select count(*)::int from device_credentials credential
              where credential.owner_user_id=$1 and credential.revoked_at is null
                and credential.upstream_backend_id=$2
                and credential.metadata->>'protocolDeploymentId'=$3
                and credential.metadata->>'sourceOwnerPrincipalId'=$4
                and 'share_grant_management'=any(credential.operation_families)) as current_source_credentials,
            (select count(*)::int from deployment_identities deployment
              join sync_external_user_identities identity on identity.deployment_identity_id=deployment.id
              join sync_principal_links link on link.external_user_identity_id=identity.id
              join device_credentials credential on credential.lineage_id::text=link.proof_reference
               and credential.owner_user_id=$1 and credential.revoked_at is null
              where deployment.protocol_deployment_id=$3::uuid
                and deployment.disabled_at is null
                and identity.external_subject_id=$4 and identity.status='active'
                and identity.revoked_at is null and link.local_user_id=$1
                and link.revoked_at is null) as current_source_principal_links`,
          [actor.teamUserId, teamBackendId, actor.deploymentId, actor.id]
        );
        enrollmentDiagnostics = diagnostics.rows[0];
      }
      assert.equal(
        response.body.ok,
        true,
        `${command}: ${JSON.stringify(response.body)}; enrollmentDiagnostics=${JSON.stringify(enrollmentDiagnostics)}; snapshotDiagnostics=${JSON.stringify(apiErrors.filter((error) => error.path === "collaboration_snapshot"))}; pendingShareErrors=${JSON.stringify(
          apiErrors
            .filter(
              (error) => error.path === "/v1/shared-memory/pending-shares"
            )
            .slice(-5)
            .map((error) => ({
              errorName: error.errorName,
              message: error.message,
              stack: error.stack?.split("\n").slice(0, 4)
            }))
        )}; controlDiagnostics=${JSON.stringify(apiErrors.filter((error) => error.path === "shared_memory_control").slice(-5))}; pendingShareRejections=${JSON.stringify(
          apiErrors
            .filter(
              (error) =>
                error.errorName === "TeamPendingShareRejection" ||
                error.errorName === "TeamActionGrantBindingFailed"
            )
            .slice(-5)
            .map((error) => `${error.errorName}:${error.message}`)
        )}`
      );
      return response.body;
    };
    const commandData = (result: Record<string, unknown>, label: string) => {
      assert.ok(
        result.data && typeof result.data === "object",
        `${label} data`
      );
      return result.data as Record<string, unknown>;
    };
    const localActionGrant: Hq713Fixture["localActionGrant"] = async (
      actor,
      intent
    ) => {
      const asked = await localCommand(
        actor,
        "collaboration.request_action_grant",
        {
          intent
        }
      );
      let status = commandData(asked, "Action Grant").status as Record<
        string,
        unknown
      >;
      assert.ok(status && typeof status === "object", "Action Grant status");
      const reference = status.actionGrant as { id: string };
      assert.match(reference.id, /^[0-9a-f-]{36}$/i);
      const curatedConsent =
        intent.intent === "collaboration.share_memory" &&
        intent.includeCuratedMemory === true;
      if (
        intent.intent === "collaboration.preview_shared_memory" &&
        intent.includeCuratedMemory === true
      ) {
        assert.equal(status.approvalTier, "direct");
      }
      if (curatedConsent) {
        assert.equal(
          status.approvalTier,
          "step_up",
          "Curated Memory needs separate Step-up consent"
        );
        assert.ok(status.review, "Curated Step-up must show an exact review");
      }
      if (status.state === "review_required") {
        assert.equal(
          status.approvalTier,
          "native_review",
          "Exact Native review tier"
        );
        assert.ok(status.review, "Native review must contain decision details");
        const current = await localCommand(
          actor,
          "collaboration.await_action_grant",
          {
            actionGrant: reference
          }
        );
        const currentStatus = commandData(current, "Current Action Grant")
          .status as Record<string, unknown>;
        assert.deepEqual(
          currentStatus.review,
          status.review,
          "Review must remain exact"
        );
        const confirmed = await localCommand(
          actor,
          "collaboration.confirm_action_grant",
          {
            actionGrant: reference,
            decision: "approve"
          }
        );
        status = commandData(confirmed, "Approved Action Grant")
          .status as Record<string, unknown>;
      } else if (status.state === "pending") {
        assert.equal(status.approvalTier, "step_up");
        const activationUrl = status.activationUrl;
        assert.equal(typeof activationUrl, "string");
        const selector = new URL(
          activationUrl as string,
          actor.team.baseUrl
        ).pathname
          .split("/")
          .at(-1);
        assert.ok(selector);
        const browserReview = await actor.teamBrowser.request<{
          status: { review?: unknown };
        }>("GET", `/v1/high-risk/browser-activations/${selector}`, {
          expectedStatus: 200
        });
        assert.deepEqual(
          browserReview.body.status.review,
          status.review,
          "Step-up browser review must bind the same exact intent"
        );
        await actor.teamBrowser.request(
          "POST",
          `/v1/high-risk/browser-activations/${selector}/decision`,
          {
            body: { decision: "approve" },
            expectedStatus: 200
          }
        );
        const refreshed = await localCommand(
          actor,
          "collaboration.await_action_grant",
          {
            actionGrant: reference
          }
        );
        const approvedStatus = commandData(refreshed, "Step-up Action Grant")
          .status as Record<string, unknown>;
        assert.deepEqual(
          approvedStatus.review,
          status.review,
          "Approved Step-up must preserve the exact review"
        );
        status = approvedStatus;
      }
      assert.equal(
        status.state,
        "approved",
        `${String(intent.intent)} approval`
      );
      return { reference, intent };
    };
    const localApprovedCommand = async (
      actor: Hq713Actor,
      command:
        | "collaboration.preview_shared_memory"
        | "collaboration.share_memory",
      input: Record<string, unknown>
    ) => {
      const requestId = randomUUID();
      const { reference } = await localActionGrant(actor, {
        intent: command,
        commandRequestId: requestId,
        ...input
      });
      return localCommand(
        actor,
        command,
        { ...input, actionGrant: reference },
        { requestId }
      );
    };
    const approveActionGrant: Hq713Fixture["approveActionGrant"] = async (
      actor,
      intent
    ) => {
      const secret = `hrg_${randomBytes(32).toString("base64url")}`;
      const clientRequestId = randomUUID();
      const created = await actor.team.request<{
        status: Record<string, unknown>;
      }>("POST", "/v1/high-risk/action-grants", {
        body: {
          version: 1,
          clientRequestId,
          grantCommitment: highRiskActionGrantCommitment(secret),
          intent
        },
        expectedStatus: 201
      });
      const status = created.body.status;
      if (status.approvalTier === "direct") {
        assert.equal(status.state, "approved");
        return { secret, status, clientRequestId };
      }
      if (status.approvalTier === "native_review") {
        const decision = await actor.team.request<{
          status: Record<string, unknown>;
        }>(
          "POST",
          `/v1/high-risk/action-grants/${clientRequestId}/native-decision`,
          { body: { decision: "approve" }, expectedStatus: 200 }
        );
        assert.equal(decision.body.status.state, "approved");
        return { secret, status: decision.body.status, clientRequestId };
      }
      assert.equal(status.approvalTier, "step_up");
      const activationPath = status.activationPath;
      assert.equal(typeof activationPath, "string");
      const selector = (activationPath as string).split("/").at(-1);
      assert.ok(selector);
      const review = await actor.teamBrowser.request(
        "GET",
        `/v1/high-risk/browser-activations/${selector}`,
        { expectedStatus: 200 }
      );
      assert.equal(review.status, 200);
      const decision = await actor.teamBrowser.request<{
        status: Record<string, unknown>;
      }>("POST", `/v1/high-risk/browser-activations/${selector}/decision`, {
        body: { decision: "approve" },
        expectedStatus: 200
      });
      assert.equal(decision.body.status.state, "approved");
      return { secret, status: decision.body.status, clientRequestId };
    };
    // The shared Project is established by the story runner through production
    // Team and Personal HTTP routes; these IDs are filled after that sequence.
    const ids: Hq713Ids = {
      teamId: "",
      workspaceId: "",
      workspaceProjectId: "",
      alicePersonalProjectId: "",
      bobPersonalProjectId: ""
    };
    const teamName = `HQ-713 ${namePrefix}`;
    const teamGrant = await approveActionGrant(alice, {
      action: "team.create",
      body: { name: teamName }
    });
    const teamCreated = await alice.team.request<{
      team: { id: string };
      defaultWorkspace: { id: string };
    }>("POST", "/v1/teams", {
      body: { name: teamName },
      headers: {
        "x-koed-action-grant": teamGrant.secret,
        "idempotency-key": randomUUID()
      },
      expectedStatus: 200
    });
    ids.teamId = teamCreated.body.team.id;
    ids.workspaceId = teamCreated.body.defaultWorkspace.id;
    const aliceProject = await alice.personal.request<{
      id: string;
      version: number;
    }>("POST", "/v1/projects", {
      body: { name: "landing", idempotencyKey: randomUUID() },
      expectedStatus: 201
    });
    ids.alicePersonalProjectId = aliceProject.body.id;
    const bobProject = await bob.personal.request<{
      id: string;
      version: number;
    }>("POST", "/v1/projects", {
      body: { name: "landing", idempotencyKey: randomUUID() },
      expectedStatus: 201
    });
    ids.bobPersonalProjectId = bobProject.body.id;
    for (const [actorName, projectId] of [
      ["alice", ids.alicePersonalProjectId],
      ["bob", ids.bobPersonalProjectId]
    ] as const) {
      const projectRoot = join(home, actorName);
      await writeFile(
        join(projectRoot, "config", "projects.json"),
        JSON.stringify({
          schemaVersion: 3,
          projects: [
            {
              localProjectId: projectId,
              path: { cwd: projectRoot, projectRoot }
            }
          ]
        })
      );
    }
    const shareAttemptKey = randomUUID();
    await alice.team.request(
      "GET",
      `/v1/teams/${ids.teamId}/workspaces/${ids.workspaceId}/share-target?shareAttemptKey=${shareAttemptKey}`,
      { expectedStatus: 200 }
    );
    const prepared = await alice.personalEdge.request<{
      snapshot: {
        personalProjectVersion: number;
        workItems: unknown[];
        sources: unknown[];
        decks: unknown[];
      };
      manifestHash: string;
    }>(
      "POST",
      `/v1/local-edge/projects/${ids.alicePersonalProjectId}/workspace-project-prepare`,
      {
        body: {
          teamBackendId,
          shareAttemptKey,
          targetTeamId: ids.teamId,
          targetWorkspaceId: ids.workspaceId
        },
        expectedStatus: 200
      }
    );
    const workspaceProject = await alice.team.request<{
      id: string;
      version: number;
    }>("POST", "/v1/workspace-projects", {
      body: {
        teamId: ids.teamId,
        workspaceId: ids.workspaceId,
        name: "landing",
        key: "LANDING",
        shareAttemptKey
      },
      expectedStatus: 201
    });
    ids.workspaceProjectId = workspaceProject.body.id;
    const snapshot = prepared.body.snapshot;
    const copied = await alice.team.request<{
      version: number;
      copiedAt: string | null;
    }>(
      "POST",
      `/v1/workspace-projects/${ids.workspaceProjectId}/first-share-copy`,
      {
        body: {
          expectedVersion: workspaceProject.body.version,
          personalProjectVersion: snapshot.personalProjectVersion,
          workItems: snapshot.workItems,
          sources: snapshot.sources,
          decks: snapshot.decks
        },
        expectedStatus: 200
      }
    );
    assert.ok(
      copied.body.copiedAt,
      "First Project copy must complete over HTTP"
    );
    await alice.personalEdge.request(
      "POST",
      `/v1/local-edge/projects/${ids.alicePersonalProjectId}/workspace-project-confirm`,
      {
        body: {
          expectedPersonalProjectVersion: snapshot.personalProjectVersion,
          teamBackendId,
          workspaceProjectId: ids.workspaceProjectId
        },
        expectedStatus: 200
      }
    );
    const inviteBody = {
      defaultTeamWorkspaceId: ids.workspaceId,
      workspaceProjectId: ids.workspaceProjectId,
      expectedWorkspaceProjectVersion: copied.body.version,
      defaultWorkspaceAccess: "write",
      email: bob.email,
      role: "member",
      ttlHours: 24
    };
    const inviteGrant = await approveActionGrant(alice, {
      action: "team.invite.create",
      teamId: ids.teamId,
      body: inviteBody
    });
    const invited = await alice.team.request<{ inviteToken: string }>(
      "POST",
      `/v1/teams/${ids.teamId}/invites`,
      {
        body: inviteBody,
        headers: { "x-koed-action-grant": inviteGrant.secret },
        expectedStatus: 200
      }
    );
    const acceptBody = { inviteToken: invited.body.inviteToken };
    const acceptGrant = await approveActionGrant(bob, {
      action: "team.invite.accept",
      body: acceptBody
    });
    await bob.team.request("POST", "/v1/team-invites/accept", {
      body: acceptBody,
      headers: { "x-koed-action-grant": acceptGrant.secret },
      expectedStatus: 200
    });
    await bob.team.request(
      "POST",
      `/v1/workspace-projects/${ids.workspaceProjectId}/join`,
      {
        expectedStatus: 200
      }
    );
    await bob.team.request(
      "GET",
      `/v1/workspace-projects/${ids.workspaceProjectId}/member-link-proof`,
      { expectedStatus: 200 }
    );
    await bob.personalEdge.request(
      "POST",
      `/v1/local-edge/projects/${ids.bobPersonalProjectId}/workspace-project-join-confirm`,
      {
        body: {
          teamBackendId,
          workspaceProjectId: ids.workspaceProjectId,
          expectedPersonalProjectVersion: bobProject.body.version
        },
        expectedStatus: 200
      }
    );
    const createPersonalProject: Hq713Fixture["createPersonalProject"] = async (
      actor,
      input
    ) => {
      const response = await actor.personal.request<{ id: string }>(
        "POST",
        "/v1/projects",
        {
          body: { name: input.name, idempotencyKey: randomUUID() },
          expectedStatus: 201
        }
      );
      return { projectId: response.body.id };
    };
    // A fixture supplies deterministic AI-client output, but must publish it
    // through the production completion transaction and summary-sync outbox.
    const publishFixtureLeaf = async (
      actor: Hq713Actor,
      input: {
        sessionId: string;
        eventId: string;
        sourceText: string;
        summaryText: string;
        title: string;
        lexicalAnchor: string;
        sourceHash: string;
      }
    ) => {
      const personalDb = actor.name === "alice" ? aliceDb.pool : bobDb.pool;
      const repository = createMemorySourceRepository(personalDb, {
        envelopeEncryptionProvider: personalEncryptionProvider
      });
      const node = await repository.createMemoryNode(
        { userId: actor.id },
        {
          visibility: "personal",
          summaryText: input.summaryText,
          sourceHash: input.sourceHash,
          lcmAlgorithmVersion: "depth0-source-items-v1"
        }
      );
      // Keep summary_model null until all provenance is attached. The source
      // reader must never see a supposedly complete leaf without its links.
      const client = await personalDb.connect();
      try {
        await client.query("begin");
        await client.query(
          `update memory_nodes set session_id=$2,source_event_count=1,
             source_token_estimate=$4 where id=$1 and owner_user_id=$3`,
          [
            node.id,
            input.sessionId,
            actor.id,
            input.sourceText.split(/\s+/).length
          ]
        );
        await client.query(
          `insert into memory_node_sources(memory_node_id,memory_event_id,source_order)
             values($1,$2,0)`,
          [node.id, input.eventId]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      await repository.updateLcmNodeSummary({
        nodeId: node.id,
        summaryText: input.summaryText,
        summaryModel: "hq713-deterministic-local-input",
        summaryPromptVersion: "hq713-source-v1",
        summaryTokenEstimate: input.summaryText.split(/\s+/).length,
        summaryStructuredSchemaVersion: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
        summaryStructuredJson: {
          schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
          title: input.title,
          summary_text: input.summaryText,
          lexical_anchors: [input.lexicalAnchor]
        }
      });
      return node;
    };
    const seedCapturedSession: Hq713Fixture["seedCapturedSession"] = async (
      actor,
      input
    ) => {
      const policy = await actor.personal.request(
        "PUT",
        "/v1/capture-policies",
        {
          body: {
            targetType: "project",
            projectId: input.projectId,
            captureState: "enabled",
            visibility: "personal"
          },
          expectedStatus: 200
        }
      );
      assert.ok(policy.body);
      const externalSessionId = `hq713-${randomUUID()}`;
      const createSession = async () => {
        const created = await actor.personalTokenClient.request<{
          session: { id: string };
        }>("POST", "/v1/sessions", {
          body: {
            projectId: input.projectId,
            externalSessionId,
            sourceRuntime: "codex",
            captureMethod: "mcp",
            metadata: { fixture: "hq713", sessionLabel: input.sessionLabel }
          },
          expectedStatus: 200
        });
        return created.body.session.id;
      };
      const personalDb = actor.name === "alice" ? aliceDb.pool : bobDb.pool;
      const existingSessionId = input.prepareAssociationBeforeCreate
        ? undefined
        : await createSession();
      const sessionId = await associateCapturedSession(
        {
          personalDb: (owner) =>
            owner.name === "alice" ? aliceDb.pool : bobDb.pool,
          personalDatabaseUrl: (owner) =>
            owner.name === "alice" ? aliceDb.url : bobDb.url
        },
        actor,
        { sessionId: existingSessionId, externalSessionId },
        input.projectId,
        input.prepareAssociationBeforeCreate ? createSession : undefined
      );
      const sourceItemIds: string[] = [];
      for (let index = 0; index < (input.sourceItemCount ?? 1); index++) {
        const content = `${input.sessionLabel} source ${index + 1}`;
        const raw = await actor.personalTokenClient.request<{
          items: Array<{ id: string }>;
        }>("POST", "/v1/memory/conversation-items", {
          body: {
            items: [
              {
                sessionId,
                sourceKind: "codex",
                sourceAdapterVersion: "codex-app-server-v1",
                sourceTransport: "app_server",
                externalThreadId: externalSessionId,
                externalTurnId: `hq713-turn-${index + 1}`,
                externalItemId: `hq713-item-${index + 1}`,
                sourceRecordType: "app_server_notification",
                sourceEventType: "user_message",
                sourceSequence: index,
                rawJson: { type: "message", role: "user", content },
                rawText: content,
                sourceHash: createHash("sha256").update(content).digest("hex"),
                idempotencyKey: `hq713-${sessionId}-${index}`,
                metadata: { projectId: input.projectId }
              }
            ]
          },
          expectedStatus: 200
        });
        assert.equal(raw.body.items.length, 1);
        const sourceItemId = raw.body.items[0]!.id;
        sourceItemIds.push(sourceItemId);
        await personalDb.query(
          `update conversation_items
             set projection_status='projected',projection_version='hq713-source-v1',
                 projection_policy_revision=1
           where id=$1 and owner_user_id=$2`,
          [sourceItemId, actor.id]
        );
        const item = await actor.personal.request<{ event: { id: string } }>(
          "POST",
          `/v1/sessions/${sessionId}/events`,
          {
            body: {
              projectId: input.projectId,
              actor: "user",
              eventType: "user_message",
              content,
              metadata: {
                fixture: "hq713",
                sourceItemIndex: index,
                rawConversationItemIds: [sourceItemId],
                semanticItemManifest: [
                  {
                    sourceIds: [sourceItemId],
                    actor: "user",
                    kind: "user_message",
                    toolName: null,
                    toolCallId: null,
                    sourceSequence: index,
                    sourceEventTime: null,
                    offsetStart: 0,
                    offsetEnd: content.length
                  }
                ]
              }
            },
            expectedStatus: 200
          }
        );
        const eventId = item.body.event.id;
        assert.ok(eventId);
        const summaryText = `${input.sessionLabel} summarized source ${index + 1}`;
        await publishFixtureLeaf(actor, {
          sessionId,
          eventId,
          sourceText: content,
          summaryText,
          title: `${input.sessionLabel} leaf ${index + 1}`,
          lexicalAnchor: input.sessionLabel,
          sourceHash: createHash("sha256")
            .update(`${sessionId}:${index}:${summaryText}`)
            .digest("hex")
        });
      }
      const sourceRevision = await createCrossIdentitySyncRepository(
        personalDb
      ).prepareCapturedSessionSyncCandidateRevision(
        { userId: actor.id },
        sessionId
      );
      assert.ok(
        sourceRevision !== null &&
          Number.isSafeInteger(sourceRevision) &&
          sourceRevision > 0,
        "Captured Session must have a real positive canonical source cursor"
      );
      return {
        sessionId,
        externalSessionId,
        logicalMemoryId: crossIdentitySyncDeterministicUuid({
          protocol: "koed.captured-session-sync/v1",
          sourceDeploymentId: actor.deploymentId,
          sourceUserId: actor.id,
          originSessionId: sessionId,
          identity: "logical-memory"
        }),
        sourceItemIds,
        sourceRevision
      };
    };
    const advanceCapturedSession: Hq713Fixture["advanceCapturedSession"] =
      async (actor, input) => {
        const personalDb = actor.name === "alice" ? aliceDb.pool : bobDb.pool;
        const session = await personalDb.query<{
          external_session_id: string;
          automatic_personal_project_id: string | null;
        }>(
          `select external_session_id,automatic_personal_project_id from sessions
          where id=$1 and owner_user_id=$2 and personal_deleted_at is null`,
          [input.sessionId, actor.id]
        );
        assert.equal(
          session.rowCount,
          1,
          "Later source must be an active owner Session"
        );
        assert.equal(
          session.rows[0]!.automatic_personal_project_id,
          input.projectId
        );
        const count = await personalDb.query<{ count: number }>(
          `select count(*)::int as count from conversation_items
          where session_id=$1 and owner_user_id=$2 and personal_deleted_at is null`,
          [input.sessionId, actor.id]
        );
        const index = count.rows[0]!.count;
        const laterText = `${input.sessionLabel} later source ${index + 1}`;
        const raw = await actor.personalTokenClient.request<{
          items: Array<{ id: string }>;
        }>("POST", "/v1/memory/conversation-items", {
          body: {
            items: [
              {
                sessionId: input.sessionId,
                sourceKind: "codex",
                sourceAdapterVersion: "codex-app-server-v1",
                sourceTransport: "app_server",
                externalThreadId: session.rows[0]!.external_session_id,
                externalTurnId: `hq713-later-turn-${index + 1}`,
                externalItemId: `hq713-later-item-${index + 1}`,
                sourceRecordType: "app_server_notification",
                sourceEventType: "user_message",
                sourceSequence: index,
                rawJson: { type: "message", role: "user", content: laterText },
                rawText: laterText,
                sourceHash: createHash("sha256")
                  .update(laterText)
                  .digest("hex"),
                idempotencyKey: `hq713-later-${input.sessionId}-${index}`,
                metadata: { projectId: input.projectId }
              }
            ]
          },
          expectedStatus: 200
        });
        assert.equal(raw.body.items.length, 1);
        const sourceItemId = raw.body.items[0]!.id;
        await personalDb.query(
          `update conversation_items
            set projection_status='projected',projection_version='hq713-source-v1',
                projection_policy_revision=1
          where id=$1 and owner_user_id=$2`,
          [sourceItemId, actor.id]
        );
        const event = await actor.personal.request<{ event: { id: string } }>(
          "POST",
          `/v1/sessions/${input.sessionId}/events`,
          {
            body: {
              projectId: input.projectId,
              actor: "user",
              eventType: "user_message",
              content: laterText,
              metadata: {
                fixture: "hq713",
                rawConversationItemIds: [sourceItemId],
                semanticItemManifest: [
                  {
                    sourceIds: [sourceItemId],
                    actor: "user",
                    kind: "user_message",
                    toolName: null,
                    toolCallId: null,
                    sourceSequence: index,
                    sourceEventTime: null,
                    offsetStart: 0,
                    offsetEnd: laterText.length
                  }
                ]
              }
            },
            expectedStatus: 200
          }
        );
        const eventId = event.body.event.id;
        const summaryText = `${input.sessionLabel} later summary ${index + 1}`;
        const node = await publishFixtureLeaf(actor, {
          sessionId: input.sessionId,
          eventId,
          sourceText: laterText,
          summaryText,
          title: `${input.sessionLabel} later leaf ${index + 1}`,
          lexicalAnchor: input.sessionLabel,
          sourceHash: createHash("sha256")
            .update(`${input.sessionId}:${index}:${summaryText}`)
            .digest("hex")
        });
        const canonicalSourceItemCount = await personalDb.query<{
          count: number;
        }>(
          `select count(*)::int as count from conversation_items
          where session_id=$1 and owner_user_id=$2 and personal_deleted_at is null`,
          [input.sessionId, actor.id]
        );
        const sourceCursor = await createCrossIdentitySyncRepository(
          personalDb
        ).prepareCapturedSessionSyncCandidateRevision(
          { userId: actor.id },
          input.sessionId
        );
        return {
          laterText,
          laterSummaryText: summaryText,
          rawSourceItemId: sourceItemId,
          canonicalEventId: eventId,
          canonicalNodeId: node.id,
          canonicalSourceItemCount: canonicalSourceItemCount.rows[0]!.count,
          sourceCursor
        };
      };
    const shareMemorySource = async (
      actor: Hq713Actor,
      input: Omit<
        Parameters<Hq713Fixture["shareCapturedSession"]>[1],
        "sessionId"
      > & {
        sessionId?: string;
        noteSource?: {
          noteId: string;
          noteRevision: number;
          memoryEventId: string;
          logicalMemoryId: string;
        };
      }
    ) => {
      const note = input.noteSource;
      if (!note) assert.ok(input.sessionId);
      const logicalMemoryId = note
        ? note.logicalMemoryId
        : crossIdentitySyncDeterministicUuid({
            protocol: "koed.captured-session-sync/v1",
            sourceDeploymentId: actor.deploymentId,
            sourceUserId: actor.id,
            originSessionId: input.sessionId!,
            identity: "logical-memory"
          });
      const source = note
        ? { kind: "personal_note" as const, ...note }
        : {
            kind: "captured_session" as const,
            sessionId: input.sessionId!,
            logicalMemoryId
          };
      const activationRepresentation = note ? "memory_events" : "lcm_leaves";
      if (!note)
        await localCommand(
          actor,
          "collaboration.prepare_shared_memory_source",
          {
            sessionId: input.sessionId!,
            consentedAt: new Date().toISOString()
          }
        );
      const candidateResult = await localCommand(
        actor,
        "collaboration.preview_shared_memory_candidate",
        {
          source,
          activationRepresentation,
          mode: "continuous",
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          ...(input.includeCuratedMemory
            ? {
                curatedTarget: {
                  includeCuratedMemory: true,
                  teamBackendId,
                  teamId: ids.teamId,
                  teamWorkspaceId: input.teamWorkspaceId
                }
              }
            : {})
        },
        { personal: !input.includeCuratedMemory }
      );
      const candidate = commandData(candidateResult, "Source candidate")
        .candidate as Record<string, unknown>;
      assert.ok(candidate && typeof candidate === "object", "Source candidate");
      assert.equal(candidate.logicalMemoryId, logicalMemoryId);
      assert.ok(Number(candidate.itemCount) > 0, "Candidate needs a real item");
      const candidateItems = candidate.items as Array<{
        summaryText?: string;
        sourceItems?: Array<{ sourceKind?: string; body?: string }>;
      }>;
      assert.ok(
        candidateItems.some((item) =>
          note
            ? item.sourceItems?.some(
                (sourceItem) =>
                  sourceItem.sourceKind === "user_message" &&
                  sourceItem.body?.includes(input.summaryText)
              )
            : item.summaryText?.includes(input.summaryText)
        ),
        "Candidate must contain the exact reviewed content marker"
      );
      if (input.includeCuratedMemory) {
        assert.match(
          String(candidate.curatedMaterialCommitmentHash),
          /^[a-f0-9]{64}$/,
          "Owner-local Curated candidate must bind a complete material commitment"
        );
        assert.match(
          String(candidate.curatedSourceAttestationKeyId),
          /^[a-f0-9-]{36}$/,
          "Owner-local Curated candidate must identify the enrolled source signer"
        );
        assert.match(
          String(candidate.curatedSourceAttestationFingerprint),
          /^[a-f0-9]{64}$/,
          "Owner-local Curated candidate must bind the enrolled signer fingerprint"
        );
      }
      const sourceCapabilities = candidate.sourceCapabilities;
      const candidateBinding = {
        source,
        sourceCapabilities,
        activationRepresentation,
        candidateHash: candidate.candidateHash,
        sourceRevision: candidate.sourceRevision,
        itemCount: candidate.itemCount,
        excludedItemCount: candidate.excludedItemCount,
        manifest: candidate.manifest,
        byteCount: candidate.byteCount,
        mode: "continuous",
        expiresAt: candidate.expiresAt,
        ...(input.includeCuratedMemory
          ? {
              curatedMaterialCommitmentHash:
                candidate.curatedMaterialCommitmentHash,
              curatedSourceAttestationKeyId:
                candidate.curatedSourceAttestationKeyId,
              curatedSourceAttestationFingerprint:
                candidate.curatedSourceAttestationFingerprint
            }
          : {})
      };
      const previewInput = {
        source,
        logicalMemoryId,
        teamId: ids.teamId,
        workspaceId: input.teamWorkspaceId,
        sourceCapabilities,
        activationRepresentation,
        maximumFidelity: activationRepresentation,
        includeCuratedMemory: input.includeCuratedMemory,
        ...(input.includeCuratedMemory
          ? {
              curatedMaterialCommitmentHash:
                candidate.curatedMaterialCommitmentHash
            }
          : {}),
        mode: "continuous",
        candidate: candidateBinding
      };
      const previewResult = await localApprovedCommand(
        actor,
        "collaboration.preview_shared_memory",
        previewInput
      );
      const preview = commandData(previewResult, "Authoritative preview")
        .preview as Record<string, unknown>;
      assert.ok(
        preview && typeof preview === "object",
        "Authoritative preview"
      );
      assert.equal(preview.logicalMemoryId, logicalMemoryId);
      assert.equal(preview.sourceRevision, candidate.sourceRevision);
      assert.equal(preview.includeCuratedMemory, input.includeCuratedMemory);
      if (input.includeCuratedMemory) {
        assert.equal(
          preview.curatedMaterialCommitmentHash,
          candidate.curatedMaterialCommitmentHash,
          "Team preview must preserve the exact owner-local Curated commitment"
        );
      }
      assert.equal(preview.maximumFidelity, activationRepresentation);
      assert.deepEqual(preview.sourceCapabilities, sourceCapabilities);
      const localAuthority = createCollaborationSharedMemoryAuthorityStore(
        actor.name === "alice" ? aliceDb.pool : bobDb.pool,
        { envelopeEncryptionProvider: personalEncryptionProvider }
      );
      const persistedPreview = await localAuthority.readAuthoritativePreview({
        backendId: teamBackendId,
        localOwnerUserId: actor.id,
        upstreamUserId: actor.teamUserId,
        previewHash: String(preview.previewHash)
      });
      assert.ok(
        persistedPreview,
        "Exact local authoritative preview must remain available for consent"
      );
      assert.equal(persistedPreview.previewRevision, preview.previewRevision);
      assert.equal(
        persistedPreview.includeCuratedMemory,
        input.includeCuratedMemory
      );
      assert.deepEqual(persistedPreview.sourceCapabilities, sourceCapabilities);
      const shareInput = {
        source,
        sourceCapabilities,
        activationRepresentation,
        mutationId: input.mutationId ?? randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: randomUUID(),
        logicalMemoryId,
        teamId: ids.teamId,
        workspaceId: input.teamWorkspaceId,
        ...(input.workspaceProjectId
          ? { workspaceProjectId: input.workspaceProjectId }
          : {}),
        mode: "continuous",
        maximumFidelity: activationRepresentation,
        includeCuratedMemory: input.includeCuratedMemory,
        previewRevision: preview.previewRevision,
        previewHash: preview.previewHash,
        expiresAt: input.expiresAt ?? null
      };
      if (input.projectBoundCuratedDenialProjectId) {
        assert.equal(
          input.includeCuratedMemory,
          true,
          "Project-bound Curated denial requires separate Curated consent"
        );
        assert.equal(
          input.workspaceProjectId,
          undefined,
          "The approved Workspace Curated share must have its own scope"
        );
        const deniedMutationId = randomUUID();
        const deniedInput = {
          ...shareInput,
          mutationId: deniedMutationId,
          logicalGrantId: randomUUID(),
          consentId: randomUUID(),
          workspaceProjectId: input.projectBoundCuratedDenialProjectId
        };
        const deniedRequestId = randomUUID();
        const { reference: deniedGrant } = await localActionGrant(actor, {
          intent: "collaboration.share_memory",
          commandRequestId: deniedRequestId,
          ...deniedInput
        });
        const deniedResponse = await actor.personalEdge.request<
          Record<string, unknown>
        >("POST", "/v1/local-edge/collaboration/command", {
          body: {
            upstream_backend_id: teamBackendId,
            command: {
              contractVersion: COLLABORATION_CONTRACT_VERSION,
              requestId: deniedRequestId,
              command: "collaboration.share_memory",
              input: { ...deniedInput, actionGrant: deniedGrant }
            }
          },
          expectedStatus: 200
        });
        assert.equal(deniedResponse.body.ok, false);
        const denial = deniedResponse.body.error as Record<string, unknown>;
        assert.equal(
          denial?.code,
          "permission_denied",
          "Project-bound Curated share must be rejected by Team policy"
        );
        const deniedWork = await teamDb.pool.query<{
          pending_count: number;
          grant_count: number;
        }>(
          `select
             (select count(*)::int from pending_share_operations
               where logical_memory_id=$1 and owner_user_id=$2) as pending_count,
             (select count(*)::int from team_memory_share_grants
               where logical_memory_id=$1 and owner_user_id=$2) as grant_count`,
          [logicalMemoryId, actor.teamUserId]
        );
        assert.equal(deniedWork.rows[0]?.pending_count, 0);
        assert.equal(deniedWork.rows[0]?.grant_count, 0);
        const deniedGrantState = await teamDb.pool.query<{
          grant_state: string;
          use_count: number;
          approval_tier: string;
          confirmation_state: string;
        }>(
          `select action_grant.state as grant_state,action_grant.use_count,
                  confirmation.approval_tier,
                  confirmation.state as confirmation_state
             from high_risk_browser_confirmations confirmation
             join high_risk_device_action_grants action_grant
               on action_grant.confirmation_id=confirmation.id
            where confirmation.client_request_id=$1
              and confirmation.owner_user_id=$2`,
          [deniedGrant.id, actor.teamUserId]
        );
        assert.deepEqual(deniedGrantState.rows, [
          {
            grant_state: "active",
            use_count: 0,
            approval_tier: "step_up",
            confirmation_state: "approved"
          }
        ]);
      }
      const shareResult = await localApprovedCommand(
        actor,
        "collaboration.share_memory",
        shareInput
      );
      const pending = commandData(shareResult, "Pending Share")
        .pendingShare as Record<string, unknown>;
      assert.ok(
        pending && typeof pending === "object",
        "Actual Team Pending Share"
      );
      assert.equal(pending.logicalMemoryId, logicalMemoryId);
      const pendingId = String(pending.id);
      let lastPendingState: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 60; attempt++) {
        const row = await teamDb.pool.query<{
          state: string;
          grant_id: string | null;
          stage: string;
          redacted_failure_code: string | null;
        }>(
          `select state,grant_id,stage,redacted_failure_code from pending_share_operations where id=$1`,
          [pendingId]
        );
        lastPendingState = row.rows[0] ?? null;
        if (row.rows[0]?.state === "activated" && row.rows[0].grant_id) {
          const grantId = row.rows[0].grant_id;
          assert.ok(teamSemanticEmbeddingWorker);
          for (
            let embeddingAttempt = 0;
            embeddingAttempt < 30;
            embeddingAttempt++
          ) {
            await teamSemanticEmbeddingWorker.processOnce();
            const embedded = await teamDb.pool.query<{
              total: number;
              ready: number;
              failed: number;
            }>(
              `select count(*)::int as total,
                      count(*) filter (where embedding_state='embedded')::int as ready,
                      count(*) filter (where embedding_state='failed')::int as failed
                 from team_memory_semantic_items where share_grant_id=$1`,
              [grantId]
            );
            const state = embedded.rows[0]!;
            assert.equal(
              state.failed,
              0,
              `Team semantic embedding failed for ${grantId}`
            );
            if (state.total > 0 && state.ready === state.total) {
              return {
                grantId,
                logicalMemoryId,
                projectBoundCuratedRejected: Boolean(
                  input.projectBoundCuratedDenialProjectId
                )
              };
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.fail(`Team semantic embedding did not finish for ${grantId}`);
        }
        if (
          row.rows[0]?.state === "failed" ||
          row.rows[0]?.state === "needs_attention"
        ) {
          assert.fail(
            `Pending Share ${pendingId} stopped: ${JSON.stringify({
              state: row.rows[0],
              workerErrors: workerErrors.slice(-5),
              activationFailures: activationFailures.filter(
                (failure) => failure.pendingShareId === pendingId
              ),
              apiErrors: apiErrors
                .slice(-5)
                .map(({ server, path, errorName, message }) => ({
                  server,
                  path,
                  errorName,
                  message
                }))
            })}`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const semantic = await teamDb.pool.query<{
        status: string;
        attempt_count: number;
        failure_code: string | null;
        last_error_class: string | null;
        due: boolean;
        completed_chunk_count: number;
      }>(
        `select status,attempt_count,failure_code,last_error_class,
                coalesce(next_attempt_at<=now(),true) as due,
                completed_chunk_count
           from shared_source_semantic_previews
          where logical_memory_id=$1 order by created_at desc limit 5`,
        [logicalMemoryId]
      );
      const outbox = await teamDb.pool.query<{
        state: string;
        due: boolean;
      }>(
        `select state,available_at<=now() as due from pending_share_outbox
          where pending_share_id=$1`,
        [pendingId]
      );
      assert.fail(
        `Pending Share ${pendingId} did not activate: ${JSON.stringify({
          state: lastPendingState,
          semantic: semantic.rows,
          outbox: outbox.rows,
          workerErrors: workerErrors.slice(-5),
          activationFailures: activationFailures.filter(
            (failure) => failure.pendingShareId === pendingId
          )
        })}`
      );
    };
    const shareCapturedSession: Hq713Fixture["shareCapturedSession"] = (
      actor,
      input
    ) => shareMemorySource(actor, input);
    const sharePersonalNote: Hq713Fixture["sharePersonalNote"] = async (
      actor,
      input
    ) => {
      const shared = await shareMemorySource(actor, {
        noteSource: {
          noteId: input.noteId,
          noteRevision: input.noteRevision,
          memoryEventId: input.memoryEventId,
          logicalMemoryId: input.logicalMemoryId
        },
        teamWorkspaceId: input.teamWorkspaceId,
        summaryText: input.noteText,
        includeCuratedMemory: false
      });
      return {
        grantId: shared.grantId,
        logicalMemoryId: shared.logicalMemoryId
      };
    };
    const fixture: Hq713Fixture = {
      restartPersonal: async (actor) => {
        assert.ok(!closed, "Fixture must be live for an API restart");
        assert.ok(
          actors.some(
            (seed) => seed.name === actor.name && seed.id === actor.id
          )
        );
        const previous = apiInstances.get(actor.name);
        assert.ok(previous, "Personal API instance must exist");
        // Drain the owned sync drivers before restarting their live endpoint.
        // All operation/attempt state remains in the same real databases.
        for (const worker of syncWorkers.splice(0)) await worker.stop();
        await previous.app.close();
        const index = servers.indexOf(previous.app);
        assert.ok(index >= 0);
        servers.splice(index, 1);
        const origin = await start(
          previous.db,
          previous.profile,
          actor.name,
          previous.port
        );
        assert.equal(origin, actor.personal.baseUrl);
        for (const [suffix, instance] of apiInstances) {
          await startRealSyncWorker(instance.db, suffix);
        }
      },
      alice,
      bob,
      ids,
      teamBackendId,
      team: { baseUrl: teamUrl, db: teamDb.pool },
      personalDb: (actor) =>
        actor.name === "alice" ? aliceDb.pool : bobDb.pool,
      personalDatabaseUrl: (actor) =>
        actor.name === "alice" ? aliceDb.url : bobDb.url,
      results,
      apiErrors: () => apiErrors.slice(),
      futureFailures: () => futureFailures.slice(),
      assertNoWorkerErrors: () =>
        assert.deepEqual(workerErrors, [], "Production worker failures"),
      home,
      personalEncryptionProvider,
      invalidateTeamSemanticPreview: ({ ownerTeamUserId, semanticPreviewId }) =>
        sharedMemoryRepository.invalidateSemanticPreview(
          { userId: ownerTeamUserId },
          { semanticPreviewId, reasonCode: "privacy_material_invalidated" }
        ),
      blockTeamPath: (method, path) => {
        blockedTeamPaths.add(`${method.toUpperCase()} ${path}`);
      },
      resumeTeamPath: (method, path) => {
        blockedTeamPaths.delete(`${method.toUpperCase()} ${path}`);
      },
      blockTeamCuratedWithdrawal: () => {
        teamCuratedWithdrawalBlocked = true;
      },
      resumeTeamCuratedWithdrawal: () => {
        teamCuratedWithdrawalBlocked = false;
      },
      dropNextTeamCuratedUpdateResponse: () => {
        assert.equal(
          dropNextTeamCuratedUpdateResponse,
          false,
          "Curated response loss is already armed"
        );
        dropNextTeamCuratedUpdateResponse = true;
      },
      teamCuratedUpdateResponseDrops: () => teamCuratedUpdateResponseDrops,
      localCommand,
      localActionGrant,
      approveActionGrant,
      createPersonalProject,
      seedCapturedSession,
      advanceCapturedSession,
      shareCapturedSession,
      sharePersonalNote,
      shareCapturedSessionViaProjectPolicy: (actor, input) =>
        shareHq713CapturedSessionViaProjectPolicy(fixture, actor, input),
      makeChatPrivate: (actor, input) =>
        makeHq713CapturedChatPrivate(fixture, actor, input),
      attemptShareCapturedSessionAs: (actor, input) =>
        attemptHq713OtherOwnerShare(fixture, actor, input),
      seedCuratedAssertion: (actor, input) =>
        seedHq713CuratedAssertion(fixture, actor, input),
      close
    };
    return fixture;
  } catch (error) {
    await close();
    throw error;
  }
};

export const withHq713Fixture = async (
  run: (fixture: Hq713Fixture) => Promise<void>
) => {
  const fixture = await createHq713Fixture();
  try {
    await run(fixture);
    fixture.assertNoWorkerErrors();
  } finally {
    await fixture.close();
  }
};
