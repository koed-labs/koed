import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RepositoryIdentity } from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations,
  updateSessionRepositoryOverride
} from "../src/index.js";

const databaseUrl = process.env.PROJECT_CUTOVER_TEST_DATABASE_URL;
const identity: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_cutover_fixture",
  root: "/synthetic/checkout",
  branch: "main",
  reason: "origin",
  checkoutId: "synthetic_checkout",
  originatingDeviceId: "synthetic_device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/team/project"
};

describe.skipIf(!databaseUrl)("one-time Project assignment cutover", () => {
  it("marks existing Personal Sessions unresolved once and preserves capture and explicit reassignment behavior", async () => {
    const pool = createDbPool({ connectionString: databaseUrl });
    const folder = await mkdtemp(
      fileURLToPath(
        new URL("../../../scratch/project-cutover-", import.meta.url)
      )
    );
    try {
      expect(
        (
          await pool.query<{ existing: string | null }>(
            "select to_regclass('public.sessions') as existing"
          )
        ).rows[0]!.existing
      ).toBeNull();
      const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
      const journal = JSON.parse(
        await readFile(join(migrations, "meta/_journal.json"), "utf8")
      ) as { entries: Array<{ idx: number; tag: string }> };
      const prior = journal.entries.filter((entry) => entry.idx < 46);
      await mkdir(join(folder, "meta"));
      for (const entry of prior)
        await copyFile(
          join(migrations, `${entry.tag}.sql`),
          join(folder, `${entry.tag}.sql`)
        );
      await writeFile(
        join(folder, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: prior })
      );
      await runDbMigrations(pool, { migrationsFolder: folder });
      const repo = createMemorySourceRepository(pool);
      const owner = await repo.createUser({
        email: `cutover-${randomUUID()}@example.test`
      });
      const actor = { userId: owner.id };
      const sessions = [];
      for (const sourceRuntime of [
        "codex-cli",
        "codex",
        "claude-code",
        "pi"
      ] as const) {
        const externalSessionId = randomUUID();
        // Seed main's schema directly. Project assignment columns do not exist yet.
        const session = (
          await pool.query<{ id: string; externalSessionId: string }>(
            `insert into sessions
             (owner_user_id,source_runtime,capture_method,external_session_id,idempotency_key,metadata)
             values ($1,$2,'transcript',$3,$3,$4::jsonb)
             returning id,external_session_id as "externalSessionId"`,
            [
              owner.id,
              sourceRuntime,
              externalSessionId,
              JSON.stringify({ retainedProvenance: "synthetic-cutover" })
            ]
          )
        ).rows[0]!;
        await repo.createMemoryEvent(actor, {
          sessionId: session.id,
          projectId: "legacy-cutover-project",
          actor: "user",
          visibility: "personal",
          eventType: "captured",
          rawEventType: "user_message",
          content: "Keep the violet ledger and nine checks.",
          idempotencyKey: randomUUID()
        });
        sessions.push(session);
      }
      // Preserve legacy display overrides as provenance, without resolving them.
      await pool.query(
        "update sessions set project_override_id='legacy-project', project_override_name='Legacy Project', project_override_at=now(), project_override_by_user_id=owner_user_id where id=$1",
        [sessions[0]!.id]
      );
      // Include old, newly captured, invalidated and future-dated retained rows.
      await pool.query(
        "update sessions set created_at='2020-01-01', invalidated_at=now() where id=$1",
        [sessions[1]!.id]
      );
      await pool.query(
        "update sessions set created_at='2035-01-01' where id=$1",
        [sessions[2]!.id]
      );
      const before = (
        await pool.query<{ id: string; row: Record<string, unknown> }>(
          "select id,to_jsonb(s) as row from sessions s order by id"
        )
      ).rows;
      const eventsBefore = (
        await pool.query<{ row: unknown }>(
          "select to_jsonb(e) as row from memory_events e order by id"
        )
      ).rows;
      await runDbMigrations(pool);
      const after = (
        await pool.query<{ id: string; row: Record<string, unknown> }>(
          "select id,to_jsonb(s) as row from sessions s order by id"
        )
      ).rows;
      for (const old of before) {
        const current = after.find((row) => row.id === old.id)!.row;
        expect(current).toEqual({
          ...old.row,
          folder_assignment: {
            revision: 1,
            original: { state: "unresolved", reason: "historical_unresolved" },
            correction: { state: "original" }
          },
          repository_assignment_revision_id: null,
          repository_assignment_state: "historical_unresolved",
          repository_automatic_identity: null,
          repository_override_identity: null,
          repository_assignment_version: 2
        });
      }
      expect(
        (
          await pool.query<{ row: unknown }>(
            "select to_jsonb(e) as row from memory_events e order by id"
          )
        ).rows
      ).toEqual(eventsBefore);
      expect(
        (
          await pool.query<{ row: unknown }>(
            "select to_jsonb(o) as row from session_repository_observations o order by id"
          )
        ).rows
      ).toEqual([]);
      const resetSession = sessions[3]!;
      const continued = await repo.createCapturedSession(actor, {
        sourceRuntime: "pi",
        externalSessionId: resetSession.externalSessionId!,
        repositoryIdentity: identity
      });
      expect(continued.repositoryAssignment).toMatchObject({
        state: "historical_unresolved",
        version: 2,
        automatic: null,
        effective: null
      });
      const duplicate = await repo.createCapturedSession(actor, {
        sourceRuntime: "pi",
        idempotencyKey: resetSession.externalSessionId!,
        repositoryIdentity: identity
      });
      expect(duplicate.id).toBe(resetSession.id);
      expect(duplicate.repositoryAssignment).toEqual(
        continued.repositoryAssignment
      );
      const assigned = await updateSessionRepositoryOverride(pool, {
        ownerUserId: owner.id,
        sessionId: resetSession.id,
        expectedVersion: 2,
        identity
      });
      expect(assigned?.effective).toEqual(identity);
      // Migration replay must preserve a post-cutover explicit assignment.
      await runDbMigrations(pool);
      expect(
        (await repo.getCapturedSession(actor, resetSession.id))
          ?.repositoryAssignment
      ).toEqual(assigned);
      const reset = await updateSessionRepositoryOverride(pool, {
        ownerUserId: owner.id,
        sessionId: resetSession.id,
        expectedVersion: 3,
        identity: null
      });
      expect(reset).toMatchObject({
        state: "historical_unresolved",
        version: 4,
        effective: null
      });
      expect(
        await updateSessionRepositoryOverride(pool, {
          ownerUserId: owner.id,
          sessionId: resetSession.id,
          expectedVersion: 1,
          identity
        })
      ).toBeNull();
      await pool.query("update sessions set invalidated_at=now() where id=$1", [
        resetSession.id
      ]);
      const reimport = await repo.createCapturedSession(actor, {
        sourceRuntime: "pi",
        externalSessionId: resetSession.externalSessionId!,
        logicalSessionId: randomUUID(),
        idempotencyKey: randomUUID(),
        repositoryIdentity: identity
      });
      expect(reimport.repositoryAssignment).toMatchObject({
        state: "historical_unresolved",
        effective: null
      });
      const fresh = await repo.createCapturedSession(actor, {
        sourceRuntime: "codex",
        externalSessionId: randomUUID(),
        repositoryIdentity: identity
      });
      expect(fresh.repositoryAssignment).toMatchObject({
        state: "recorded",
        version: 1,
        effective: identity
      });
      await runDbMigrations(pool);
      expect(
        (await repo.getCapturedSession(actor, fresh.id))?.repositoryAssignment
      ).toEqual(fresh.repositoryAssignment);
    } finally {
      await pool.end();
      await rm(folder, { recursive: true, force: true });
    }
  }, 120_000);
});
