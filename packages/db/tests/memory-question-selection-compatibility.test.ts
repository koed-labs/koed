import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  type PersonalSelectionSnapshot
} from "@koed-labs/shared";
import {
  createDbPool,
  createMemoryAnswerTaskRepository,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "legacy v1 Personal task completion compatibility",
  () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });
    it("binds an omitted legacy completion selection from the accepted task and rejects supplied changes or history replay", async () => {
      const options = {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            Buffer.alloc(32, 71).toString("base64")
          )
      };
      const repository = createMemorySourceRepository(pool, options);
      const tasks = createMemoryAnswerTaskRepository(pool, options);
      const actor = {
        userId: (
          await repository.createUser({
            email: `compat-${randomUUID()}@example.test`
          })
        ).id
      };
      const other = {
        userId: (
          await repository.createUser({
            email: `compat-${randomUUID()}@example.test`
          })
        ).id
      };
      const a = await repository.createNamedPersonalProject(actor, {
        name: "Accepted"
      });
      const b = await repository.createNamedPersonalProject(actor, {
        name: "Changed"
      });
      const selection: PersonalSelectionSnapshot = {
        version: 1,
        ownerUserId: actor.userId,
        target: {
          kind: "project",
          project: { ownerUserId: actor.userId, projectId: a.projectId }
        },
        callerRepositoryContext: null
      };
      const accepted = await tasks.acceptMemoryAnswerTask(actor, {
        origin: "mcp",
        maxQueued: 10,
        request: {
          requestVersion: 1,
          selection,
          input: {
            query: "Legacy explicit Project question",
            search_domain: "project",
            project_id: a.projectId,
            repository_context: null
          }
        }
      });
      const claimed = (
        await tasks.claimMemoryAnswerTask(actor, {
          leaseOwner: "legacy-client",
          leaseMs: 60_000
        })
      ).task!;
      expect(claimed.id).toBe(accepted.id);
      const finalQuestion = {
        idempotencyKey: randomUUID(),
        query: "Legacy explicit Project question",
        searchDomain: "project" as const,
        projectId: a.projectId,
        status: "answered" as const,
        answerMarkdown: "Accepted Project answer"
      };
      const completion = {
        taskId: claimed.id,
        leaseOwner: claimed.leaseOwner,
        fenceGeneration: claimed.fenceGeneration,
        finalQuestion,
        result: { answer_markdown: finalQuestion.answerMarkdown }
      };
      for (const supplied of [
        {
          ...selection,
          ownerUserId: other.userId,
          target: {
            kind: "project" as const,
            project: { ownerUserId: other.userId, projectId: a.projectId }
          }
        },
        {
          ...selection,
          target: {
            kind: "project" as const,
            project: { ownerUserId: actor.userId, projectId: b.projectId }
          }
        },
        { ...selection, target: { kind: "global" as const } }
      ])
        await expect(
          tasks.completeMemoryAnswerTask(actor, {
            ...completion,
            finalQuestion: { ...finalQuestion, personalSelection: supplied }
          })
        ).rejects.toThrow("Personal selection does not match task");
      const completed = await tasks.completeMemoryAnswerTask(actor, completion);
      expect(completed?.status).toBe("completed");
      const history = await repository.getMemoryQuestion(
        actor,
        completed!.questionId!
      );
      expect(history?.retrieval?.personal_selection).toEqual(selection);
      expect(history?.projectId).toBe(a.projectId);
      expect(await repository.getMemoryQuestion(other, history!.id)).toBeNull();
      await expect(
        repository.createFinalMemoryQuestion(actor, {
          ...finalQuestion,
          idempotencyKey: `memory-answer-task:${claimed.id}`,
          personalSelection: {
            ...selection,
            target: {
              kind: "project",
              project: { ownerUserId: actor.userId, projectId: b.projectId }
            }
          },
          projectId: b.projectId
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (await repository.getMemoryQuestion(actor, history!.id))?.retrieval
          ?.personal_selection
      ).toEqual(selection);
    });
  }
);
