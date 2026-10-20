import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import { preparePersonalSourceContextSnapshot } from "../src/personal-source-context-export.js";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  type PersonalGitContext
} from "@koed/shared";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "verified source context binding in PostgreSQL",
  () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });
    it("records reviewed corrections and resets against a stable causal head while rejecting an unreviewed rewrite", async () => {
      const repo = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            Buffer.alloc(32, 112).toString("base64")
          )
      });
      const actor = {
        userId: (
          await repo.createUser({
            email: `source-binding-${randomUUID()}@example.test`
          })
        ).id
      };
      const git: PersonalGitContext = {
        kind: "portable_repository",
        key: "gr_binding_a",
        root: "/origin/repo",
        branch: "main",
        reason: "origin",
        checkoutId: "checkout_binding",
        originatingDeviceId: "source_device",
        selectedRemote: "origin",
        anchorDisplay: "example.test/binding-a"
      };
      const target: PersonalGitContext = {
        ...git,
        key: "gr_binding_b",
        anchorDisplay: "example.test/binding-b"
      };
      const source = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: git
      });
      await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: target
      });
      const snapshot = async () => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          const result = await preparePersonalSourceContextSnapshot(client, {
            ownerUserId: actor.userId,
            localSessionId: source.id,
            originatingDeploymentId: "source_deployment",
            originatingDeviceId: "source_device"
          });
          await client.query("commit");
          return result;
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      };
      const original = await snapshot();
      expect(original.git.revisions).toHaveLength(1);
      const initial = (await repo.getPersonalSourceContext(actor, source.id))
        .context;
      expect(initial.sync?.git.frontier).toEqual([original.git.head]);
      const preview = await repo.previewPersonalSourceCorrection(
        actor,
        source.id,
        {
          axis: "git",
          action: "set",
          repository: target,
          expectedVersion: initial.git.revision
        }
      );
      const applied = await repo.applyPersonalSourceCorrection(
        actor,
        source.id,
        preview.preview.reviewId,
        { expectedVersion: initial.git.revision }
      );
      const corrected = await snapshot();
      expect(corrected.git.revisions).toHaveLength(2);
      expect(
        corrected.git.revisions.find(
          (row) => row.revisionId === corrected.git.head
        )?.replaces
      ).toEqual([original.git.head]);
      expect(corrected.context.git.correction).toEqual(
        applied.context.git.correction
      );
      expect(corrected.folder).toEqual(original.folder);
      await expect(
        pool.query(
          "update sessions set repository_override_identity=null,repository_assignment_version=repository_assignment_version+1 where id=$1",
          [source.id]
        )
      ).rejects.toThrow(
        "Source context requires a verified projection or reviewed correction"
      );
      const reset = await repo.previewPersonalSourceCorrection(
        actor,
        source.id,
        {
          axis: "git",
          action: "reset",
          expectedVersion: applied.context.git.revision
        }
      );
      await repo.applyPersonalSourceCorrection(
        actor,
        source.id,
        reset.preview.reviewId,
        { expectedVersion: applied.context.git.revision }
      );
      const restored = await snapshot();
      expect(restored.git.revisions).toHaveLength(3);
      expect(restored.context.git.original).toEqual(
        original.context.git.original
      );
      expect(restored.context.git.correction).toEqual({ state: "original" });
      expect(restored.git.head).not.toBe(original.git.head);
      expect(
        restored.git.revisions.find(
          (row) => row.revisionId === restored.git.head
        )?.replaces
      ).toEqual([corrected.git.head]);
      expect(await snapshot()).toEqual(restored);
    });
  }
);
