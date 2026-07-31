import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  highRiskActionGrantCommitment
} from "@koed/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import {
  createDb,
  createDbPool,
  createHighRiskActionRepository,
  runDbMigrations
} from "../src/index.js";
import {
  deviceCredentials,
  highRiskBrowserConfirmations,
  highRiskDeviceActionGrants,
  userSessions,
  users
} from "../src/schema.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

describeDb("high-risk action grants", () => {
  let pool: pg.Pool;
  const receiptEncryptionProvider =
    createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );

  const createRepository = (
    options: Omit<
      Parameters<typeof createHighRiskActionRepository>[1],
      "envelopeEncryptionProvider"
    >
  ) =>
    createHighRiskActionRepository(createDb(pool), {
      ...options,
      envelopeEncryptionProvider: receiptEncryptionProvider
    });

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const createFixture = async (operationFamilies = ["action_grant"]) => {
    const db = createDb(pool);
    const [user] = await db
      .insert(users)
      .values({
        email: `high-risk-${randomUUID()}@example.com`,
        displayName: "High Risk Fixture"
      })
      .returning({ id: users.id });
    const [session] = await db
      .insert(userSessions)
      .values({
        userId: user!.id,
        sessionHash: hash(randomUUID()),
        expiresAt: new Date(Date.now() + 60_000)
      })
      .returning({ id: userSessions.id });
    const [credential] = await db
      .insert(deviceCredentials)
      .values({
        ownerUserId: user!.id,
        credentialKeyId: `high-risk-${randomUUID()}`,
        upstreamBackendId: `backend-${randomUUID()}`,
        deviceInstanceId: `device-${randomUUID()}`,
        lineageId: randomUUID(),
        verifierKind: "secret_hash",
        verifierHash: hash(randomUUID()),
        operationFamilies
      })
      .returning({
        id: deviceCredentials.id,
        upstreamBackendId: deviceCredentials.upstreamBackendId
      });

    return {
      userId: user!.id,
      userSessionId: session!.id,
      deviceCredentialId: credential!.id,
      upstreamBackendId: credential!.upstreamBackendId
    };
  };

  const binding = (fixture: Awaited<ReturnType<typeof createFixture>>) => ({
    ownerUserId: fixture.userId,
    deviceCredentialId: fixture.deviceCredentialId,
    upstreamBackendId: fixture.upstreamBackendId,
    teamId: null,
    operationFamily: "admin",
    action: "team.retention.delete_request",
    targetId: randomUUID(),
    scopeHash: hash("scope"),
    requestHash: hash("request")
  });

  const createGrantSecret = () => `hrg_${randomUUID().replace(/-/g, "")}`;

  const createGrant = async (
    repository: ReturnType<typeof createHighRiskActionRepository>,
    fixture: Awaited<ReturnType<typeof createFixture>>,
    operation: Omit<ReturnType<typeof binding>, "targetId"> & {
      targetId: string | null;
    } = binding(fixture),
    actionGrant = createGrantSecret()
  ) => {
    const clientRequestId = randomUUID();
    const created = await repository.createActionGrant({
      ...operation,
      clientRequestId,
      credentialOperationFamily: "action_grant",
      grantCommitment: highRiskActionGrantCommitment(actionGrant)
    });
    return {
      actionGrant,
      clientRequestId,
      created,
      operation,
      selector: created?.selector ?? null
    };
  };

  it("requires genuinely fresh browser authentication", async () => {
    const fixture = await createFixture();
    const repository = createRepository({
      freshAuthenticationMaxAgeMs: 1_000,
      pool
    });
    const { selector } = await createGrant(repository, fixture);

    await expect(
      repository.decideBrowserActivation({
        selector: selector!,
        ownerUserId: fixture.userId,
        userSessionId: fixture.userSessionId,
        freshlyAuthenticatedAt: new Date(Date.now() - 2_000),
        decision: "approve"
      })
    ).rejects.toThrow("Fresh authentication timestamp is too old");
  });

  it("returns a pending Action Grant when a bounded wait elapses", async () => {
    const fixture = await createFixture();
    const repository = createRepository({ pool });
    const { clientRequestId } = await createGrant(repository, fixture);

    const result = await repository.awaitActionGrant({
      clientRequestId,
      ownerUserId: fixture.userId,
      deviceCredentialId: fixture.deviceCredentialId,
      upstreamBackendId: fixture.upstreamBackendId,
      maxWaitMs: 10
    });

    expect(result?.state).toBe("pending");
  });

  it("wakes a bounded Action Grant wait when browser approval arrives", async () => {
    const fixture = await createFixture();
    const repository = createRepository({ pool });
    const { clientRequestId, selector } = await createGrant(
      repository,
      fixture
    );

    const waiting = repository.awaitActionGrant({
      clientRequestId,
      ownerUserId: fixture.userId,
      deviceCredentialId: fixture.deviceCredentialId,
      upstreamBackendId: fixture.upstreamBackendId,
      maxWaitMs: 1_000
    });
    await delay(20);
    await repository.decideBrowserActivation({
      selector: selector!,
      ownerUserId: fixture.userId,
      userSessionId: fixture.userSessionId,
      freshlyAuthenticatedAt: new Date(),
      decision: "approve"
    });

    await expect(waiting).resolves.toMatchObject({ state: "approved" });
  });

  it("returns one canonical confirmation for concurrent idempotent creation", async () => {
    const fixture = await createFixture();
    const repository = createRepository({ pool });
    const operation = binding(fixture);
    const clientRequestId = randomUUID();
    const grantCommitment = highRiskActionGrantCommitment(createGrantSecret());
    const input = {
      ...operation,
      clientRequestId,
      credentialOperationFamily: "action_grant" as const,
      grantCommitment
    };

    const [first, second] = await Promise.all([
      repository.createActionGrant(input),
      repository.createActionGrant(input)
    ]);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    const count = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from high_risk_browser_confirmations
        where device_credential_id = $1
          and client_request_id = $2`,
      [fixture.deviceCredentialId, clientRequestId]
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("rejects commitment reuse under a different request", async () => {
    const fixture = await createFixture();
    const repository = createRepository({ pool });
    const operation = binding(fixture);
    const grantCommitment = highRiskActionGrantCommitment(createGrantSecret());
    const createInput = (clientRequestId: string) => ({
      ...operation,
      clientRequestId,
      credentialOperationFamily: "action_grant" as const,
      grantCommitment
    });

    await expect(
      repository.createActionGrant(createInput(randomUUID()))
    ).resolves.not.toBeNull();
    await expect(
      repository.createActionGrant(createInput(randomUUID()))
    ).resolves.toBeNull();
  });

  it("allows only one concurrent browser decision to win", async () => {
    const fixture = await createFixture();
    const repository = createRepository({ pool });
    const { selector } = await createGrant(repository, fixture);
    const decisionInput = {
      selector: selector!,
      ownerUserId: fixture.userId,
      userSessionId: fixture.userSessionId,
      freshlyAuthenticatedAt: new Date()
    };

    const [approved, denied] = await Promise.all([
      repository.decideBrowserActivation({
        ...decisionInput,
        decision: "approve"
      }),
      repository.decideBrowserActivation({
        ...decisionInput,
        decision: "deny"
      })
    ]);

    expect([approved, denied].filter(Boolean)).toHaveLength(1);
    const db = createDb(pool);
    const confirmations = await db
      .select({
        id: highRiskBrowserConfirmations.id,
        state: highRiskBrowserConfirmations.state
      })
      .from(highRiskBrowserConfirmations)
      .where(eq(highRiskBrowserConfirmations.selector, decisionInput.selector));
    expect(confirmations).toHaveLength(1);
    const grants = await db
      .select({ id: highRiskDeviceActionGrants.id })
      .from(highRiskDeviceActionGrants)
      .where(
        eq(highRiskDeviceActionGrants.confirmationId, confirmations[0]!.id)
      );
    expect(grants).toHaveLength(confirmations[0]!.state === "approved" ? 1 : 0);
  });

  it("binds a one-use grant to the exact request, device, session, and backend", async () => {
    const fixture = await createFixture();
    const db = createDb(pool);
    const [otherDevice] = await db
      .insert(deviceCredentials)
      .values({
        ownerUserId: fixture.userId,
        credentialKeyId: `high-risk-${randomUUID()}`,
        upstreamBackendId: fixture.upstreamBackendId,
        deviceInstanceId: `device-${randomUUID()}`,
        lineageId: randomUUID(),
        verifierKind: "secret_hash",
        verifierHash: hash(randomUUID()),
        operationFamilies: ["action_grant"]
      })
      .returning({ id: deviceCredentials.id });
    const repository = createRepository({ pool });
    const { actionGrant, clientRequestId, operation, created } =
      await createGrant(repository, fixture);
    expect(created?.selector).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(created?.selector).not.toBe(clientRequestId);
    expect(created?.state).toBe("pending");
    expect(
      await repository.getActionGrant({
        clientRequestId,
        ownerUserId: fixture.userId,
        deviceCredentialId: fixture.deviceCredentialId,
        upstreamBackendId: fixture.upstreamBackendId
      })
    ).toMatchObject({
      selector: created?.selector,
      state: "pending",
      requestHash: operation.requestHash
    });

    const approved = await repository.decideBrowserActivation({
      selector: created!.selector,
      ownerUserId: fixture.userId,
      userSessionId: fixture.userSessionId,
      freshlyAuthenticatedAt: new Date(),
      decision: "approve"
    });
    expect(approved?.state).toBe("approved");
    await expect(
      repository.decideBrowserActivation({
        selector: created!.selector,
        ownerUserId: fixture.userId,
        userSessionId: fixture.userSessionId,
        freshlyAuthenticatedAt: new Date(),
        decision: "approve"
      })
    ).resolves.toBeNull();

    const mutate = vi.fn(async () => ({
      statusCode: 202,
      body: { ok: true }
    }));

    await expect(
      repository.executeActionGrant({
        ...operation,
        requestHash: hash("altered request"),
        actionGrant,
        execute: async ({ team }) => {
          void team;
          return mutate();
        }
      })
    ).resolves.toBeNull();
    for (const alteredBinding of [
      { deviceCredentialId: otherDevice!.id },
      { upstreamBackendId: `other-backend-${randomUUID()}` },
      { teamId: randomUUID() },
      { operationFamily: "team.read" },
      { action: "team.delete.confirm" },
      { targetId: randomUUID() }
    ]) {
      await expect(
        repository.executeActionGrant({
          ...operation,
          ...alteredBinding,
          actionGrant,
          execute: async ({ team }) => {
            void team;
            return mutate();
          }
        })
      ).resolves.toBeNull();
    }

    const consumed = await repository.executeActionGrant({
      ...operation,
      actionGrant,
      execute: async ({ team }) => {
        void team;
        return mutate();
      }
    });
    expect(consumed).toEqual({
      statusCode: 202,
      body: { ok: true },
      replayed: false
    });

    const replay = await repository.executeActionGrant({
      ...operation,
      actionGrant,
      execute: async () => {
        throw new Error("replay should not invoke mutation");
      }
    });
    expect(replay).toEqual({
      statusCode: 202,
      body: { ok: true },
      replayed: true
    });
    expect(mutate).toHaveBeenCalledTimes(1);

    const storedReceipt = await pool.query<{
      id: string;
      receipt_body: {
        encoding: string;
        envelope: { ciphertext: string };
      };
    }>(
      `select id, receipt_body
         from high_risk_action_grant_execution_receipts
        where owner_user_id = $1
        order by created_at desc
        limit 1`,
      [fixture.userId]
    );
    const stored = storedReceipt.rows[0]!;
    expect(stored.receipt_body.encoding).toBe("envelope");
    expect(JSON.stringify(stored.receipt_body)).not.toContain('"ok":true');

    stored.receipt_body.envelope.ciphertext = `${
      stored.receipt_body.envelope.ciphertext.startsWith("A") ? "B" : "A"
    }${stored.receipt_body.envelope.ciphertext.slice(1)}`;
    await pool.query(
      `update high_risk_action_grant_execution_receipts
          set receipt_body = $2::jsonb
        where id = $1`,
      [stored.id, JSON.stringify(stored.receipt_body)]
    );
    await expect(
      repository.executeActionGrant({
        ...operation,
        actionGrant,
        execute: async () => {
          throw new Error("tampered replay should not invoke mutation");
        }
      })
    ).rejects.toThrow();
  });

  it("serializes concurrent consumption and returns a replay receipt", async () => {
    const fixture = await createFixture();
    const repository = createRepository({ pool });
    const { actionGrant, operation, selector } = await createGrant(
      repository,
      fixture
    );
    await repository.decideBrowserActivation({
      selector: selector!,
      ownerUserId: fixture.userId,
      userSessionId: fixture.userSessionId,
      freshlyAuthenticatedAt: new Date(),
      decision: "approve"
    });

    const mutate = vi.fn(async () => {
      await delay(20);
      return {
        statusCode: 200,
        body: { result: "ok" }
      };
    });

    const [first, second] = await Promise.all([
      repository.executeActionGrant({
        ...operation,
        actionGrant,
        execute: async () => mutate()
      }),
      repository.executeActionGrant({
        ...operation,
        actionGrant,
        execute: async () => mutate()
      })
    ]);

    expect([first, second]).toContainEqual({
      statusCode: 200,
      body: { result: "ok" },
      replayed: false
    });
    expect([first, second]).toContainEqual({
      statusCode: 200,
      body: { result: "ok" },
      replayed: true
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("provisions a Team and reads its default Workspace inside one grant transaction", async () => {
    const fixture = await createFixture();
    const repository = createRepository({ pool });
    const operation = {
      ...binding(fixture),
      action: "team.create",
      targetId: null
    };
    const { actionGrant, created } = await createGrant(
      repository,
      fixture,
      operation
    );
    await repository.decideBrowserActivation({
      selector: created!.selector,
      ownerUserId: fixture.userId,
      userSessionId: fixture.userSessionId,
      freshlyAuthenticatedAt: new Date(),
      decision: "approve"
    });

    const result = await repository.executeActionGrant({
      ...operation,
      actionGrant,
      execute: async ({ team }) => {
        const createdTeam = await team.createTeam(
          { userId: fixture.userId },
          { name: "Action Grant Team", idempotencyKey: randomUUID() }
        );
        const defaultWorkspace = await team.getTeamDefaultWorkspace(
          { userId: fixture.userId },
          createdTeam.id
        );
        return defaultWorkspace
          ? {
              statusCode: 200,
              body: {
                teamId: createdTeam.id,
                defaultWorkspaceId: defaultWorkspace.id
              }
            }
          : null;
      }
    });

    expect(result?.statusCode).toBe(200);
    expect(result?.replayed).toBe(false);
    expect(typeof result?.body.teamId).toBe("string");
    expect(typeof result?.body.defaultWorkspaceId).toBe("string");
  });

  it("rejects the wrong operation family and revoked credentials", async () => {
    const fixture = await createFixture(["team.read"]);
    const repository = createRepository({ pool });
    const created = await repository.createActionGrant({
      ...binding(fixture),
      clientRequestId: randomUUID(),
      credentialOperationFamily: "action_grant",
      grantCommitment: `v1:${hash(createGrantSecret())}`
    });
    expect(created).toBeNull();

    await pool.query(
      "update device_credentials set revoked_at = now() where id = $1",
      [fixture.deviceCredentialId]
    );
    await expect(
      repository.createActionGrant({
        ...binding(fixture),
        clientRequestId: randomUUID(),
        credentialOperationFamily: "action_grant",
        grantCommitment: `v1:${hash(createGrantSecret())}`
      })
    ).resolves.toBeNull();
  });

  it("expires and revokes unused confirmations and grants", async () => {
    const fixture = await createFixture();
    const confirmationRepository = createRepository({
      confirmationTtlMs: 20,
      actionGrantTtlMs: 20,
      pool
    });

    const first = await createGrant(confirmationRepository, fixture);
    expect(
      await confirmationRepository.cancelActionGrant({
        clientRequestId: first.clientRequestId,
        ownerUserId: fixture.userId,
        deviceCredentialId: fixture.deviceCredentialId,
        upstreamBackendId: fixture.upstreamBackendId,
        reasonCode: "user_cancelled"
      })
    ).toBe(true);
    expect(
      await confirmationRepository.decideBrowserActivation({
        selector: first.selector!,
        ownerUserId: fixture.userId,
        userSessionId: fixture.userSessionId,
        freshlyAuthenticatedAt: new Date(),
        decision: "approve"
      })
    ).toBeNull();

    const second = await createGrant(confirmationRepository, fixture, {
      ...binding(fixture),
      targetId: randomUUID(),
      requestHash: hash("second request")
    });
    await delay(30);
    expect(
      await confirmationRepository.expireBrowserConfirmations()
    ).toBeGreaterThan(0);
    expect(
      await confirmationRepository.decideBrowserActivation({
        selector: second.selector!,
        ownerUserId: fixture.userId,
        userSessionId: fixture.userSessionId,
        freshlyAuthenticatedAt: new Date(),
        decision: "approve"
      })
    ).toBeNull();

    const grantRepository = createRepository({
      confirmationTtlMs: 1_000,
      actionGrantTtlMs: 20,
      pool
    });
    const thirdOperation = {
      ...binding(fixture),
      targetId: randomUUID(),
      requestHash: hash("third request")
    };
    const third = await createGrant(
      grantRepository,
      fixture,
      thirdOperation,
      createGrantSecret()
    );
    await expect(
      grantRepository.decideBrowserActivation({
        selector: third.selector!,
        ownerUserId: fixture.userId,
        userSessionId: fixture.userSessionId,
        freshlyAuthenticatedAt: new Date(),
        decision: "approve"
      })
    ).resolves.not.toBeNull();
    await delay(30);
    expect(await grantRepository.expireActionGrants()).toBeGreaterThan(0);
    expect(
      await grantRepository.executeActionGrant({
        ...thirdOperation,
        actionGrant: third.actionGrant,
        execute: async () => ({
          statusCode: 200,
          body: { expired: false }
        })
      })
    ).toBeNull();
  });
});
