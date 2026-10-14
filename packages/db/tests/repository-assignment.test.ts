import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepositoryIdentity } from "@koed/shared";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository,
  updateSessionRepositoryOverride,
  markPreCutoverRepositoryAssignmentsUnresolved
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const identity = (name: string, branch = "main"): RepositoryIdentity => ({
  kind: "portable_repository",
  key: `gr_${name}`,
  root: `/checkout/${name}`,
  branch,
  reason: "origin",
  checkoutId: `checkout_${name}`,
  originatingDeviceId: "fixture_device",
  selectedRemote: "origin",
  anchorDisplay: `example.test/team/${name}`
});

describe
  .skipIf(!databaseUrl)
  .each(["codex-cli", "codex", "claude-code", "pi"] as const)(
  "%s recorded repository assignments in PostgreSQL",
  (sourceRuntime) => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    }, 60_000);
    afterAll(() => pool?.end());
    const fixture = async () => {
      const repo = createMemorySourceRepository(pool);
      const user = await repo.createUser({
        email: `repo-assignment-${randomUUID()}@example.test`
      });
      return { repo, actor: { userId: user.id } };
    };
    it("records once and retains assignment, overrides, cwd and branch provenance across both upsert paths", async () => {
      const { repo, actor } = await fixture();
      const first = await repo.createCapturedSession(actor, {
        sourceRuntime,
        externalSessionId: randomUUID(),
        cwd: "/checkout/a/subdirectory",
        repositoryIdentity: identity("a"),
        idempotencyKey: randomUUID()
      });
      expect(first.repositoryAssignment).toMatchObject({
        state: "recorded",
        version: 1,
        automatic: identity("a"),
        effective: identity("a")
      });
      const continued = await repo.createCapturedSession(actor, {
        sourceRuntime,
        externalSessionId: first.externalSessionId!,
        repositoryIdentity: identity("b"),
        cwd: "/checkout/b"
      });
      expect(continued.repositoryAssignment).toEqual(
        first.repositoryAssignment
      );
      expect(continued.cwd).toBe(first.cwd);
      const override = await updateSessionRepositoryOverride(pool, {
        ownerUserId: actor.userId,
        sessionId: first.id,
        expectedVersion: 1,
        identity: identity("c")
      });
      expect(override?.effective?.key).toBe("gr_c");
      await repo.createCapturedSession(actor, {
        sourceRuntime,
        externalSessionId: first.externalSessionId!,
        repositoryIdentity: identity("b")
      });
      expect(
        (await repo.getCapturedSession(actor, first.id))?.repositoryAssignment
      ).toEqual(override);
      expect(
        await updateSessionRepositoryOverride(pool, {
          ownerUserId: actor.userId,
          sessionId: first.id,
          expectedVersion: 1,
          identity: null
        })
      ).toBeNull();
      const reset = await updateSessionRepositoryOverride(pool, {
        ownerUserId: actor.userId,
        sessionId: first.id,
        expectedVersion: 2,
        identity: null
      });
      expect(reset?.effective).toEqual(identity("a"));
      const key = randomUUID();
      const idempotent = await repo.createCapturedSession(actor, {
        sourceRuntime,
        idempotencyKey: key,
        repositoryIdentity: identity("a")
      });
      const duplicate = await repo.createCapturedSession(actor, {
        sourceRuntime,
        idempotencyKey: key,
        repositoryIdentity: identity("b")
      });
      expect(duplicate.id).toBe(idempotent.id);
      expect(duplicate.repositoryAssignment).toEqual(
        idempotent.repositoryAssignment
      );
      const observations = await pool.query<{ is_conflict: boolean }>(
        "select is_conflict from session_repository_observations where session_id = $1",
        [first.id]
      );
      expect(observations.rows.some((row) => row.is_conflict)).toBe(true);
      await repo.createCapturedSession(actor, {
        sourceRuntime,
        externalSessionId: first.externalSessionId!,
        repositoryIdentity: identity("a", "another-branch")
      });
      expect(
        (await repo.getCapturedSession(actor, first.id))?.repositoryAssignment
          ?.automatic?.branch
      ).toBe("main");
    });
    it("retains historical unresolved state through continued capture, reset, and re-ingestion", async () => {
      const { repo, actor } = await fixture();
      const original = await repo.createCapturedSession(actor, {
        sourceRuntime,
        externalSessionId: randomUUID(),
        repositoryIdentity: identity("a")
      });
      // Exercise the prepared cutover inside a rollback: normal capture never calls it.
      const client = await pool.connect();
      try {
        await client.query("begin");
        expect(
          await markPreCutoverRepositoryAssignmentsUnresolved(
            client,
            new Date().toISOString()
          )
        ).toBeGreaterThan(0);
        const snapshot = await client.query<{
          repository_assignment_state: string;
        }>("select repository_assignment_state from sessions where id = $1", [
          original.id
        ]);
        expect(snapshot.rows[0]?.repository_assignment_state).toBe(
          "historical_unresolved"
        );
        await client.query("rollback");
      } finally {
        client.release();
      }
      expect(
        (await repo.getCapturedSession(actor, original.id))
          ?.repositoryAssignment?.state
      ).toBe("recorded");
      // Model an existing pre-cutover row without assigning it from today's checkout.
      await pool.query(
        "update sessions set repository_assignment_state = 'historical_unresolved', repository_automatic_identity = null where id = $1",
        [original.id]
      );
      const continued = await repo.createCapturedSession(actor, {
        sourceRuntime,
        externalSessionId: original.externalSessionId!,
        repositoryIdentity: identity("a")
      });
      expect(continued.repositoryAssignment).toMatchObject({
        state: "historical_unresolved",
        automatic: null,
        effective: null
      });
      await updateSessionRepositoryOverride(pool, {
        ownerUserId: actor.userId,
        sessionId: original.id,
        expectedVersion: 1,
        identity: identity("b")
      });
      expect(
        (
          await updateSessionRepositoryOverride(pool, {
            ownerUserId: actor.userId,
            sessionId: original.id,
            expectedVersion: 2,
            identity: null
          })
        )?.effective
      ).toBeNull();
      await pool.query(
        "update sessions set invalidated_at = now() where id = $1",
        [original.id]
      );
      const reimport = await repo.createCapturedSession(actor, {
        sourceRuntime,
        externalSessionId: original.externalSessionId!,
        idempotencyKey: randomUUID(),
        logicalSessionId: randomUUID(),
        repositoryIdentity: identity("a")
      });
      expect(reimport.repositoryAssignment?.state).toBe(
        "historical_unresolved"
      );
      expect(reimport.repositoryAssignment?.effective).toBeNull();
    });
    it("rejects other-owner writes and lets unresolved overrides suppress portable automatic identity", async () => {
      const { repo, actor } = await fixture();
      const session = await repo.createCapturedSession(actor, {
        sourceRuntime,
        repositoryIdentity: identity("a")
      });
      const other = await fixture();
      expect(await repo.getCapturedSession(other.actor, session.id)).toBeNull();
      expect(
        await updateSessionRepositoryOverride(pool, {
          ownerUserId: other.actor.userId,
          sessionId: session.id,
          expectedVersion: 1,
          identity: identity("b")
        })
      ).toBeNull();
      const unresolved: RepositoryIdentity = {
        ...identity("local"),
        kind: "unresolved",
        key: null,
        reason: "selection_missing"
      };
      expect(
        (
          await updateSessionRepositoryOverride(pool, {
            ownerUserId: actor.userId,
            sessionId: session.id,
            expectedVersion: 1,
            identity: unresolved
          })
        )?.effective
      ).toEqual(unresolved);
    });
  }
);
