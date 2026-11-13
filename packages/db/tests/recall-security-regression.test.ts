import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed-labs/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import { resolvePersonalSourceSelection } from "../src/personal-selection-sql.js";
import { authorizedPersonalDerivedEvidence } from "../src/personal-derived-selection-sql.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "recall authorization adversarial regressions",
  () => {
    let pool: pg.Pool;
    const fixtureOwners: string[] = [];
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    });
    afterAll(async () => {
      if (fixtureOwners.length) {
        await pool.query(
          "update memory_nodes set invalidated_at=now() where owner_user_id=any($1::uuid[])",
          [fixtureOwners]
        );
        await pool.query(
          "update memory_events set include_in_embedding=false where owner_user_id=any($1::uuid[])",
          [fixtureOwners]
        );
      }
      await pool?.end();
    });

    it("keeps pinned unions owner-bound and revokes summary bodies without upgrading filtered sources", async () => {
      const repo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            Buffer.alloc(32, 87).toString("base64")
          )
      });
      const actor = {
        userId: (
          await repo.createUser({ email: `${randomUUID()}@security.test` })
        ).id
      };
      const attacker = {
        userId: (
          await repo.createUser({ email: `${randomUUID()}@security.test` })
        ).id
      };
      fixtureOwners.push(actor.userId, attacker.userId);
      const session = () =>
        repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          sourceRuntime: "codex-cli"
        });
      const caller = await session(),
        selected = await session(),
        unrelated = await session();
      let project = await repo.createNamedPersonalProject(actor, {
        name: "Pinned security Project"
      });
      for (const source of [caller, selected])
        project = (
          await repo.addPersonalProjectSession(actor, project.projectId, {
            expectedVersion: project.version,
            sessionId: source.id
          })
        ).project;
      const resolution = await repo.resolvePersonalProjectRecall(actor, {
        sessionId: caller.id
      });
      const snapshot = {
        version: 1 as const,
        ownerUserId: actor.userId,
        target: resolution.target,
        callerRepositoryContext: null
      };
      const selection = resolvePersonalSourceSelection(actor.userId, {
        personalSelection: snapshot
      });
      await expect(
        repo.resolvePersonalProjectRecall(attacker, {
          externalSessionId: caller.externalSessionId!,
          sourceRuntime: "codex-cli"
        })
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(() =>
        resolvePersonalSourceSelection(attacker.userId, {
          personalSelection: snapshot
        })
      ).toThrow();
      expect(() =>
        resolvePersonalSourceSelection(attacker.userId, {
          personalSelection: { ...snapshot, ownerUserId: attacker.userId }
        })
      ).toThrow();

      const event = (sessionId: string) =>
        repo.createMemoryEvent(actor, {
          sessionId,
          projectId: "fixture",
          visibility: "personal",
          actor: "user",
          eventType: "captured",
          rawEventType: "user_message",
          content: "Retained private source",
          idempotencyKey: randomUUID()
        });
      const selectedEvent = await event(selected.id),
        unrelatedEvent = await event(unrelated.id);
      const node = async (events: string[], completed = false) => {
        const created = await repo.createMemoryNode(actor, {
          visibility: "personal",
          summaryText: "Retained summary body",
          sourceHash: randomUUID()
        });
        await pool.query(
          "update memory_nodes set source_event_count=$2,lcm_algorithm_version='security-fixture' where id=$1",
          [created.id, events.length]
        );
        for (const [order, id] of events.entries())
          await pool.query(
            "insert into memory_node_sources(memory_node_id,memory_event_id,source_order) values($1,$2,$3)",
            [created.id, id, order]
          );
        if (completed)
          await pool.query(
            "update memory_nodes set summary_model='fixture-client' where id=$1",
            [created.id]
          );
        return created;
      };
      const complete = await node([selectedEvent.id], true);
      const pendingMixed = await node([selectedEvent.id, unrelatedEvent.id]);
      const completedMixed = await node(
        [selectedEvent.id, unrelatedEvent.id],
        true
      );
      const rows = [complete, pendingMixed, completedMixed].map(({ id }) => ({
        source_type: "memory_node",
        source_id: id
      }));
      const allowed = () =>
        authorizedPersonalDerivedEvidence(
          pool,
          selection,
          rows,
          null,
          null,
          false,
          true
        );
      expect(await allowed()).toEqual(
        new Map([
          [`memory_node:${complete.id}`, true],
          [`memory_node:${pendingMixed.id}`, false]
        ])
      );
      const attackerGlobal = resolvePersonalSourceSelection(attacker.userId, {
        searchDomain: "global"
      });
      expect(
        await authorizedPersonalDerivedEvidence(
          pool,
          attackerGlobal,
          rows,
          null,
          null,
          false,
          true
        )
      ).toEqual(new Map());

      await pool.query(
        "update memory_events set personal_deleted_at=now() where id=$1",
        [selectedEvent.id]
      );
      expect(await allowed()).toEqual(new Map());
      await pool.query(
        "update memory_events set personal_deleted_at=null where id=$1",
        [selectedEvent.id]
      );
      const excluded = await repo.excludePersonalProjectSession(
        actor,
        project.projectId,
        { expectedVersion: project.version, sessionId: selected.id }
      );
      project = excluded.project;
      expect(await allowed()).toEqual(new Map());
      const exclusion = excluded.explanation.exclusion!;
      project = (
        await repo.restorePersonalProjectSession(actor, project.projectId, {
          expectedVersion: project.version,
          sessionId: selected.id,
          exclusionId: exclusion.exclusionId,
          expectedExclusionRevisionId: exclusion.headRevisionId
        })
      ).project;
      expect((await allowed()).get(`memory_node:${complete.id}`)).toBe(true);
      await repo.excludePersonalProjectSession(actor, project.projectId, {
        expectedVersion: project.version,
        sessionId: caller.id
      });
      expect(await allowed()).toEqual(new Map());
    });
  }
);
