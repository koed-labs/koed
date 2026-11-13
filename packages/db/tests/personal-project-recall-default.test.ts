import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import { createPersonalProjectDefaultService } from "../../../apps/worker/src/personal-project-default-service.js";
import { personalProjectDefaultIdentity } from "@koed-labs/shared/personal-project-default";
import type { PersonalGitContext } from "@koed-labs/shared";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "headless canonical default Project recall",
  () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });
    it("uses background default organization and the same durable rule for future native Conversations without UI calls", async () => {
      const repository = createMemorySourceRepository(pool);
      const actor = {
        userId: (
          await repository.createUser({
            email: `headless-${randomUUID()}@example.test`
          })
        ).id
      };
      const git: PersonalGitContext = {
        kind: "portable_repository",
        key: `gr_${randomUUID()}`,
        root: "/recorded/headless",
        branch: "main",
        checkoutId: "initial_checkout",
        originatingDeviceId: "capture_device",
        selectedRemote: "origin",
        anchorDisplay: "example.test/headless",
        reason: "origin"
      };
      const initial = await repository.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex-cli",
        repositoryIdentity: git
      });
      expect(await repository.personalProjectDefaultStatus(actor)).toEqual({
        reconciliationPending: true
      });
      await expect(
        repository.resolvePersonalProjectRecall(actor, {
          sessionId: initial.id
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "personal_project_membership_pending",
        retryable: true
      });
      const service = createPersonalProjectDefaultService({
        repository: {
          ...repository,
          nextPersonalProjectDefaultOwner: async () =>
            (await repository.personalProjectDefaultStatus(actor))
              .reconciliationPending
              ? actor.userId
              : null
        },
        wakePool: pool,
        logger: { error: () => undefined }
      });
      expect(await service.processOnce()).toEqual({ processed: true });
      expect(await repository.personalProjectDefaultStatus(actor)).toEqual({
        reconciliationPending: false
      });
      const resolved = await repository.resolvePersonalProjectRecall(actor, {
        externalSessionId: initial.externalSessionId!,
        sourceRuntime: "codex-cli"
      });
      const expectedProjectId = personalProjectDefaultIdentity({
        kind: "repository",
        repository: git
      }).projectIdentity;
      expect(resolved.target.projects).toEqual([
        { ownerUserId: actor.userId, projectId: expectedProjectId }
      ]);
      const future = await repository.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex-cli",
        repositoryIdentity: {
          ...git,
          root: "/recorded/second-checkout",
          checkoutId: "future_checkout"
        }
      });
      expect(await repository.personalProjectDefaultStatus(actor)).toEqual({
        reconciliationPending: true
      });
      expect(
        (
          await repository.resolvePersonalProjectRecall(actor, {
            externalSessionId: future.externalSessionId!,
            sourceRuntime: "codex-cli"
          })
        ).target.projects
      ).toEqual(resolved.target.projects);
      expect(await service.processOnce()).toEqual({ processed: true });
      expect(
        (
          await repository.resolvePersonalProjectRecall(actor, {
            sessionId: future.id
          })
        ).target.projects
      ).toEqual(resolved.target.projects);
      expect(
        await pool.query(
          "select 1 from personal_project_inclusions where owner_user_id=$1 and project_id=$2",
          [actor.userId, expectedProjectId]
        )
      ).toMatchObject({ rows: [] });
    });
    it("distinguishes explicit pending source verification from absent, foreign, deleted and settled zero-membership Conversations", async () => {
      const repository = createMemorySourceRepository(pool);
      const actor = {
        userId: (
          await repository.createUser({
            email: `pending-${randomUUID()}@example.test`
          })
        ).id
      };
      const other = {
        userId: (
          await repository.createUser({
            email: `pending-${randomUUID()}@example.test`
          })
        ).id
      };
      const source = await repository.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex-cli"
      });
      await repository.reconcilePersonalProjectDefaults(actor);
      await expect(
        repository.resolvePersonalProjectRecall(actor, { sessionId: source.id })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "personal_project_membership_missing",
        retryable: false
      });
      await pool.query(
        `insert into personal_source_bindings(owner_user_id,originating_deployment_id,originating_device_id,source_logical_session_id,local_session_id,local_logical_session_id,availability)
      select $1,'pending_deployment','pending_device','pending_logical',id,logical_session_id,'pending' from sessions where id=$2`,
        [actor.userId, source.id]
      );
      for (const input of [
        { sessionId: source.id },
        {
          externalSessionId: source.externalSessionId!,
          sourceRuntime: "codex-cli"
        },
        {
          source: {
            ownerUserId: actor.userId,
            originatingDeploymentId: "pending_deployment",
            originatingDeviceId: "pending_device",
            logicalSessionId: "pending_logical"
          }
        }
      ])
        await expect(
          repository.resolvePersonalProjectRecall(actor, input)
        ).rejects.toMatchObject({
          statusCode: 409,
          code: "personal_conversation_pending",
          retryable: true
        });
      await expect(
        repository.resolvePersonalProjectRecall(other, { sessionId: source.id })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "personal_conversation_unavailable",
        retryable: false
      });
      await expect(
        repository.resolvePersonalProjectRecall(actor, {
          sessionId: randomUUID()
        })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "personal_conversation_unavailable",
        retryable: false
      });
      await pool.query(
        "update sessions set personal_deleted_at=now() where id=$1",
        [source.id]
      );
      await expect(
        repository.resolvePersonalProjectRecall(actor, { sessionId: source.id })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "personal_conversation_unavailable",
        retryable: false
      });
    });
  }
);
