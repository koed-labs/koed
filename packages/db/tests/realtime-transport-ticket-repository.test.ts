import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createRealtimeTransportTicketRepository,
  runDbMigrations,
  type RealtimeTransportTicketRepository
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const digest = (value: string): string =>
  Buffer.from(value.padEnd(32, "x")).toString("hex").slice(0, 64);

describeDb("realtime transport ticket repository", () => {
  let pool: pg.Pool;
  let repository: RealtimeTransportTicketRepository;
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const sessionId = randomUUID();
  const deviceCredentialId = randomUUID();

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
    await pool.query(`insert into users (id, email) values ($1,$2),($3,$4)`, [
      userId,
      `ticket-${userId}@example.test`,
      otherUserId,
      `ticket-${otherUserId}@example.test`
    ]);
    await pool.query(
      `insert into user_sessions (id, user_id, session_hash, expires_at)
       values ($1,$2,$3,now() + interval '1 hour')`,
      [sessionId, userId, digest("session")]
    );
    await pool.query(
      `insert into device_credentials (
         id, owner_user_id, credential_key_id, upstream_backend_id,
         device_instance_id, verifier_kind, verifier_hash, operation_families
       ) values ($1,$2,$3,$4,$5,'secret_hash',$6,$7)`,
      [
        deviceCredentialId,
        userId,
        `credential-${deviceCredentialId}`,
        "backend-a",
        "device-a",
        digest("credential"),
        ["team_chat_read"]
      ]
    );
    repository = createRealtimeTransportTicketRepository(pool);
  });

  afterAll(async () => {
    await pool.query(`delete from users where id = any($1::uuid[])`, [
      [userId, otherUserId]
    ]);
    await pool.end();
  });

  const createSessionTicket = async (
    overrides: {
      id?: string;
      secretHash?: string;
      expiresAt?: Date;
    } = {}
  ) => {
    const id = overrides.id ?? randomUUID();
    await repository.createTicket({
      id,
      secretHash: overrides.secretHash ?? digest(id),
      ticketVersion: 1,
      transport: "webtransport",
      protocolVersion: 1,
      ownerUserId: userId,
      authKind: "session",
      userSessionId: sessionId,
      deviceCredentialId: null,
      backendIdentityHash: digest("backend"),
      clientInstanceHash: digest("client"),
      clientKind: "browser",
      originHash: digest("origin"),
      nativeBindingHash: null,
      operationFamilies: ["team_chat_read"],
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 30_000)
    });
    return id;
  };

  const consume = (id: string, overrides: Record<string, unknown> = {}) =>
    repository.consumeTicket({
      id,
      secretHash: digest(id),
      transport: "webtransport",
      protocolVersion: 1,
      backendIdentityHash: digest("backend"),
      clientInstanceHash: digest("client"),
      clientKind: "browser",
      originHash: digest("origin"),
      nativeBindingHash: null,
      connectionIdHash: digest(`connection-${randomUUID()}`),
      ...overrides
    });

  it("consumes an exact ticket atomically and rejects replay or binding drift", async () => {
    const id = await createSessionTicket();
    await expect(consume(id)).resolves.toMatchObject({
      ticketId: id,
      ownerUserId: userId,
      userSessionId: sessionId,
      operationFamilies: ["team_chat_read"]
    });
    await expect(consume(id)).resolves.toBeNull();
    const audit = await pool.query<{ action: string }>(
      `select action from audit_events where target_id=$1 order by audit_sequence`,
      [id]
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "realtime.transport_ticket.issued",
      "realtime.transport_ticket.consumed"
    ]);

    const originBound = await createSessionTicket();
    await expect(
      consume(originBound, { originHash: digest("other-origin") })
    ).resolves.toBeNull();
  });

  it("rejects cross-owner references at the database boundary", async () => {
    await expect(
      repository.createTicket({
        id: randomUUID(),
        secretHash: digest(randomUUID()),
        ticketVersion: 1,
        transport: "webtransport",
        protocolVersion: 1,
        ownerUserId: otherUserId,
        authKind: "session",
        userSessionId: sessionId,
        deviceCredentialId: null,
        backendIdentityHash: digest("backend"),
        clientInstanceHash: digest("client"),
        clientKind: "browser",
        originHash: digest("origin"),
        nativeBindingHash: null,
        operationFamilies: ["team_chat_read"],
        expiresAt: new Date(Date.now() + 30_000)
      })
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("revalidates the consumed principal without retaining reusable credentials", async () => {
    const sessionTicket = await createSessionTicket();
    const sessionAdmission = await consume(sessionTicket);
    expect(sessionAdmission).not.toBeNull();
    await expect(
      repository.resolveActivePrincipal(sessionAdmission!)
    ).resolves.toMatchObject({
      user: { id: userId },
      operationFamilies: null
    });
    await pool.query(`update user_sessions set revoked_at=now() where id=$1`, [
      sessionId
    ]);
    await expect(
      repository.resolveActivePrincipal(sessionAdmission!)
    ).resolves.toBeNull();
    await pool.query(`update user_sessions set revoked_at=null where id=$1`, [
      sessionId
    ]);

    const nativeTicket = randomUUID();
    await repository.createTicket({
      id: nativeTicket,
      secretHash: digest(nativeTicket),
      ticketVersion: 1,
      transport: "webtransport",
      protocolVersion: 1,
      ownerUserId: userId,
      authKind: "device_credential",
      userSessionId: null,
      deviceCredentialId,
      backendIdentityHash: digest("backend"),
      clientInstanceHash: digest("client"),
      clientKind: "native",
      originHash: null,
      nativeBindingHash: digest("device-a"),
      operationFamilies: ["team_chat_read"],
      expiresAt: new Date(Date.now() + 30_000)
    });
    const nativeAdmission = await repository.consumeTicket({
      id: nativeTicket,
      secretHash: digest(nativeTicket),
      transport: "webtransport",
      protocolVersion: 1,
      backendIdentityHash: digest("backend"),
      clientInstanceHash: digest("client"),
      clientKind: "native",
      originHash: null,
      nativeBindingHash: digest("device-a"),
      connectionIdHash: digest("native-periodic-connection")
    });
    expect(nativeAdmission).not.toBeNull();
    await expect(
      repository.resolveActivePrincipal(nativeAdmission!)
    ).resolves.toMatchObject({
      user: { id: userId },
      operationFamilies: ["team_chat_read"]
    });
    await pool.query(
      `update device_credentials set operation_families=$2 where id=$1`,
      [deviceCredentialId, ["sync"]]
    );
    await expect(
      repository.resolveActivePrincipal(nativeAdmission!)
    ).resolves.toBeNull();
    await pool.query(
      `update device_credentials set operation_families=$2 where id=$1`,
      [deviceCredentialId, ["team_chat_read"]]
    );
  });

  it("fails closed after session revocation, ticket expiry, or device-scope reduction", async () => {
    const sessionTicket = await createSessionTicket();
    await pool.query(`update user_sessions set revoked_at=now() where id=$1`, [
      sessionId
    ]);
    await expect(consume(sessionTicket)).resolves.toBeNull();
    await pool.query(`update user_sessions set revoked_at=null where id=$1`, [
      sessionId
    ]);

    const expiredTicket = await createSessionTicket();
    await pool.query(
      `update realtime_transport_tickets
          set issued_at=now() - interval '2 minutes',
              expires_at=now() - interval '1 second'
        where id=$1`,
      [expiredTicket]
    );
    await expect(consume(expiredTicket)).resolves.toBeNull();

    const nativeTicket = randomUUID();
    await repository.createTicket({
      id: nativeTicket,
      secretHash: digest(nativeTicket),
      ticketVersion: 1,
      transport: "webtransport",
      protocolVersion: 1,
      ownerUserId: userId,
      authKind: "device_credential",
      userSessionId: null,
      deviceCredentialId,
      backendIdentityHash: digest("backend"),
      clientInstanceHash: digest("client"),
      clientKind: "native",
      originHash: null,
      nativeBindingHash: digest("device-a"),
      operationFamilies: ["team_chat_read"],
      expiresAt: new Date(Date.now() + 30_000)
    });
    await pool.query(
      `update device_credentials set operation_families=$2 where id=$1`,
      [deviceCredentialId, ["sync"]]
    );
    await expect(
      repository.consumeTicket({
        id: nativeTicket,
        secretHash: digest(nativeTicket),
        transport: "webtransport",
        protocolVersion: 1,
        backendIdentityHash: digest("backend"),
        clientInstanceHash: digest("client"),
        clientKind: "native",
        originHash: null,
        nativeBindingHash: digest("device-a"),
        connectionIdHash: digest("native-connection")
      })
    ).resolves.toBeNull();

    await expect(repository.deleteExpiredTickets()).resolves.toBeGreaterThan(0);
    expect(
      (
        await pool.query(
          `select 1 from realtime_transport_tickets where id=$1`,
          [expiredTicket]
        )
      ).rowCount
    ).toBe(0);
  });
});
