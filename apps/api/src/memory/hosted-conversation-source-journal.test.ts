import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign
} from "node:crypto";
import Fastify from "fastify";
import {
  createDbPool,
  createMemorySourceRepository,
  createRemoteMcpOAuthRepository,
  runDbMigrations
} from "@koed/db";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  exportConversationSourceReplicationPublicKey
} from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { createAuthHelpers, createHashSecret } from "../auth/session.js";
import { createRemoteMcpOAuthProvider } from "../auth/remote-mcp-oauth.js";
import { registerConversationSourceJournalRoutes } from "./conversation-source-journal-routes.js";

const databaseUrl = process.env.KOED_OAUTH_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "hosted delegated conversation source journaling",
  () => {
    const admin = createDbPool({
      connectionString: databaseUrl ?? "postgresql://localhost/postgres"
    });
    const name = `hosted_journal_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(databaseUrl ?? "postgresql://localhost/postgres");
    url.pathname = `/${name}`;
    const pool = createDbPool({ connectionString: url.toString() });
    const encryption = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
    const repo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: encryption
    });
    const resourceUrl = new URL("https://koed.example/mcp");
    const oauth = createRemoteMcpOAuthProvider({
      store: createRemoteMcpOAuthRepository(pool),
      resourceUrl
    });
    const auth = createAuthHelpers(() => repo, {
      hashSecret: createHashSecret("journal-test"),
      cookieSecure: true,
      resolveDelegatedPrincipal: oauth.resolvePrincipal
    });
    const key = generateKeyPairSync("ed25519");
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const storage = {
      provider: "filesystem" as const,
      put: vi.fn(() => {
        throw new Error("Filesystem writes not allowed");
      }),
      read: vi.fn(() => {
        throw new Error("Filesystem reads not allowed");
      })
    };
    const context = {
      config: {
        deploymentProfile: "team_self_hosted",
        remoteMcp: { enabled: true },
        koedHome: "/unused-hosted-source-home"
      },
      auth,
      requireRepository: () => repo,
      encryption: { envelopeEncryptionProvider: encryption },
      rateLimit: { sourceJournal: async () => {} },
      capture: {
        resolveCapturePolicyForRequest: vi
          .fn()
          .mockResolvedValue({ captureState: "enabled", paused: false }),
        rejectUnsupportedCapturePolicy: vi.fn()
      }
    } as unknown as ApiRouteContext;
    const app = Fastify();
    let owner: string;
    let other: string;
    let ownerToken: string;
    let otherToken: string;
    let readToken: string;
    let personalToken: string;
    beforeAll(async () => {
      await admin.query(`create database ${name}`);
      await runDbMigrations(pool);
      owner = (await repo.createUser({ email: "owner@koed.example" })).id;
      other = (await repo.createUser({ email: "other@koed.example" })).id;
      const client = await oauth.provider.clientsStore.registerClient!({
        client_name: "Authorized capture test",
        redirect_uris: ["http://127.0.0.1:5555/callback"],
        token_endpoint_auth_method: "none"
      });
      const mint = async (userId: string, scopes: string[]) => {
        let location = "";
        await oauth.provider.authorize(
          client,
          {
            redirectUri: client.redirect_uris[0]!,
            codeChallenge: createHash("sha256")
              .update("z".repeat(43))
              .digest("base64url"),
            resource: resourceUrl,
            scopes
          },
          {
            redirect: (_status: number, destination: string) => {
              location = destination;
            }
          } as unknown as Parameters<typeof oauth.provider.authorize>[2]
        );
        const requestSecret = new URL(location).searchParams.get("request")!;
        const completion = await oauth.completeAuthorization({
          userId,
          requestSecret,
          approved: true
        });
        const code = new URL(completion.redirectUrl).searchParams.get("code")!;
        return (
          await oauth.provider.exchangeAuthorizationCode(
            client,
            code,
            undefined,
            client.redirect_uris[0],
            resourceUrl
          )
        ).access_token;
      };
      ownerToken = await mint(owner, ["koed:capture"]);
      otherToken = await mint(other, ["koed:capture"]);
      readToken = await mint(owner, ["koed:memory:read"]);
      personalToken = randomBytes(32).toString("base64url");
      await repo.createApiToken({
        ownerUserId: owner,
        name: "Personal compatibility",
        tokenHash: auth.hashSecret(personalToken),
        tokenPrefix: "test"
      });
      registerConversationSourceJournalRoutes(
        app,
        context,
        storage,
        ({ originKeyId }) => ({
          deploymentId,
          deviceInstanceId: deviceId,
          keyId: originKeyId,
          publicKey: exportConversationSourceReplicationPublicKey(
            key.publicKey
          ),
          sign: (payload) =>
            sign(null, payload, key.privateKey).toString("base64url")
        })
      );
      await app.ready();
    }, 30_000);
    afterAll(async () => {
      await app.close();
      await pool.end();
      await admin.query(`drop database if exists ${name}`);
      await admin.end();
    }, 30_000);

    const sourcePayload = () => {
      const externalSessionId = randomUUID();
      return {
        sourceSession: {
          externalSessionId,
          sourceRuntime: "codex",
          captureMethod: "api",
          idempotencyKey: externalSessionId,
          metadata: {}
        },
        sourceKind: "codex",
        externalSessionId,
        sourceFingerprint: "a".repeat(64),
        artifactFormat: "codex_rollout_jsonl",
        artifactFormatVersion: 1,
        journalStartOffset: 0,
        journalStartLine: 0,
        liveStartOffset: 0,
        liveStartLine: 0,
        currentSourceLength: 0,
        sourceCreatedAt: new Date().toISOString(),
        redactedSourceLabel: "Authorized future source"
      };
    };
    const create = (token: string) =>
      app.inject({
        method: "POST",
        url: "/v1/conversation-source-artifacts",
        headers: { authorization: `Bearer ${token}` },
        payload: sourcePayload()
      });

    it("persists encrypted signed segments and reads only for the source owner", async () => {
      const created = await create(ownerToken);
      expect(created.statusCode).toBe(200);
      const artifact = created.json().artifact as {
        id: string;
        storageProvider: string;
      };
      expect(artifact.storageProvider).toBe("envelope_db");
      const bytes = Buffer.from(
        `${JSON.stringify({ type: "session_meta", payload: { id: "synthetic-future-source" } })}\n`
      );
      const response = await app.inject({
        method: "POST",
        url: `/v1/conversation-source-artifacts/${artifact.id}/segments`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          expectedProviderOffset: 0,
          expectedProviderLine: 0,
          sourceEndOffset: bytes.length,
          sourceEndLine: 1,
          plaintextDigest: createHash("sha256").update(bytes).digest("hex"),
          plaintextSize: bytes.length,
          bytesBase64: bytes.toString("base64"),
          currentSourceLength: bytes.length
        }
      });
      expect(response.statusCode, response.body).toBe(200);
      const segment = response.json().segment as {
        id: string;
        storageProvider: string;
      };
      expect(segment.storageProvider).toBe("envelope_db");
      const persisted = await pool.query(
        "select storage_provider,encryption_envelope,ciphertext_digest from conversation_source_segments where id=$1",
        [segment.id]
      );
      expect(persisted.rows[0]).toMatchObject({
        storage_provider: "envelope_db",
        ciphertext_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        encryption_envelope: { ciphertext: expect.any(String) }
      });
      const encryptedBytes = Buffer.from(
        persisted.rows[0].encryption_envelope.ciphertext,
        "base64"
      );
      expect(encryptedBytes.includes(bytes)).toBe(false);
      const contentUrl = `/v1/conversation-source-artifacts/${artifact.id}/segments/${segment.id}/content`;
      const ownRead = await app.inject({
        method: "GET",
        url: contentUrl,
        headers: { authorization: `Bearer ${ownerToken}` }
      });
      expect(ownRead.statusCode, ownRead.body).toBe(200);
      expect(Buffer.from(ownRead.json().bytesBase64, "base64")).toEqual(bytes);
      const denied = await app.inject({
        method: "GET",
        url: contentUrl,
        headers: { authorization: `Bearer ${otherToken}` }
      });
      expect(denied.statusCode).toBe(404);
      expect(storage.put).not.toHaveBeenCalled();
      expect(storage.read).not.toHaveBeenCalled();
    });

    it("blocks paused or disabled hosted source writes while preserving retained owner reads", async () => {
      const payload = sourcePayload();
      const headers = { authorization: `Bearer ${ownerToken}` };
      const created = await app.inject({
        method: "POST",
        url: "/v1/conversation-source-artifacts",
        headers,
        payload
      });
      expect(created.statusCode).toBe(200);
      const artifact = created.json().artifact as { id: string };
      const bytes = Buffer.from(
        `${JSON.stringify({ type: "session_meta", payload: { id: "retained-before-pause" } })}\n`
      );
      const segmentPayload = {
        expectedProviderOffset: 0,
        expectedProviderLine: 0,
        sourceEndOffset: bytes.length,
        sourceEndLine: 1,
        plaintextDigest: createHash("sha256").update(bytes).digest("hex"),
        plaintextSize: bytes.length,
        bytesBase64: bytes.toString("base64"),
        currentSourceLength: bytes.length
      };
      const appended = await app.inject({
        method: "POST",
        url: `/v1/conversation-source-artifacts/${artifact.id}/segments`,
        headers,
        payload: segmentPayload
      });
      expect(appended.statusCode).toBe(200);
      const segment = appended.json().segment as { id: string };
      const encrypt = vi.spyOn(encryption, "encrypt");
      const policy = vi.mocked(context.capture.resolveCapturePolicyForRequest);
      try {
        for (const changed of [
          { captureState: "enabled", paused: true },
          { captureState: "disabled", paused: false }
        ]) {
          policy.mockResolvedValue(
            changed as Awaited<ReturnType<typeof policy>>
          );
          const write = await app.inject({
            method: "POST",
            url: `/v1/conversation-source-artifacts/${artifact.id}/segments`,
            headers,
            payload: {
              ...segmentPayload,
              expectedProviderOffset: bytes.length,
              expectedProviderLine: 1,
              sourceEndOffset: bytes.length * 2,
              sourceEndLine: 2,
              currentSourceLength: bytes.length * 2
            }
          });
          expect(write.statusCode).toBe(409);
          const existing = await app.inject({
            method: "POST",
            url: "/v1/conversation-source-artifacts",
            headers,
            payload
          });
          expect(existing.statusCode).toBe(409);
          expect((await create(ownerToken)).statusCode).toBe(409);
          const successor = await app.inject({
            method: "POST",
            url: `/v1/conversation-source-artifacts/${artifact.id}/successor`,
            headers,
            payload: {
              expectedParentClosureHash: "c".repeat(64),
              sourceGenerationId: randomUUID(),
              originKeyId: randomUUID()
            }
          });
          expect(successor.statusCode).toBe(409);
          const read = await app.inject({
            method: "GET",
            url: `/v1/conversation-source-artifacts/${artifact.id}/segments/${segment.id}/content`,
            headers
          });
          expect(read.statusCode).toBe(200);
          expect(Buffer.from(read.json().bytesBase64, "base64")).toEqual(bytes);
        }
        const persisted = await pool.query(
          "select count(*)::int as count from conversation_source_segments where artifact_id=$1",
          [artifact.id]
        );
        expect(persisted.rows[0]?.count).toBe(1);
        expect(encrypt).not.toHaveBeenCalled();
        expect(storage.put).not.toHaveBeenCalled();
      } finally {
        encrypt.mockRestore();
        policy.mockResolvedValue({
          captureState: "enabled",
          paused: false
        } as Awaited<ReturnType<typeof policy>>);
      }
    });

    it("requires hosted delegated capture consent and fail-closes without encryption", async () => {
      expect((await create(personalToken)).statusCode).toBe(403);
      expect((await create(readToken)).statusCode).toBe(403);
      const provider = context.encryption.envelopeEncryptionProvider;
      context.encryption.envelopeEncryptionProvider = undefined;
      try {
        expect((await create(ownerToken)).statusCode).toBe(503);
      } finally {
        context.encryption.envelopeEncryptionProvider = provider;
      }
      context.config.remoteMcp.enabled = false;
      try {
        expect((await create(ownerToken)).statusCode).toBe(404);
      } finally {
        context.config.remoteMcp.enabled = true;
      }
      expect(storage.put).not.toHaveBeenCalled();
    });
  }
);
