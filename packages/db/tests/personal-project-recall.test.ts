import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  type PersonalGitContext,
  type PersonalSelectionSnapshot
} from "@koed-labs/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import {
  personalSourceSelectionSql,
  resolvePersonalSourceSelection,
  projectPersonalSelectionQuery
} from "../src/personal-selection-sql.js";
import { personalMemoryNodeSelectionSql } from "../src/personal-derived-selection-sql.js";
import { pinMemoryAnswerTaskSelection } from "../src/memory-answer-task-request.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("canonical Project recall union", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  it("unions direct and rule membership once, applies independent exclusions, pins and rechecks the caller, and keeps unrelated owners/Projects out", async () => {
    const repo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 29).toString("base64")
      )
    });
    const actor = {
      userId: (
        await repo.createUser({ email: `union-${randomUUID()}@example.test` })
      ).id
    };
    const other = {
      userId: (
        await repo.createUser({ email: `union-${randomUUID()}@example.test` })
      ).id
    };
    const git: PersonalGitContext = {
      kind: "portable_repository",
      key: `gr_${randomUUID()}`,
      root: "/recorded/checkout",
      branch: "main",
      checkoutId: "checkout",
      originatingDeviceId: "device",
      selectedRemote: "origin",
      anchorDisplay: "example.test/union",
      reason: "origin"
    };
    const capture = (repositoryIdentity?: PersonalGitContext) =>
      repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        sourceRuntime: "codex-cli",
        ...(repositoryIdentity ? { repositoryIdentity } : {})
      });
    const caller = await capture(git),
      aOnly = await capture(),
      bOnly = await capture(git),
      overlap = await capture(git),
      cOnly = await capture(),
      empty = await capture();
    let a = await repo.createNamedPersonalProject(actor, { name: "A" }),
      b = await repo.createNamedPersonalProject(actor, { name: "B" }),
      c = await repo.createNamedPersonalProject(actor, { name: "C" });
    for (const source of [caller, aOnly, overlap])
      a = (
        await repo.addPersonalProjectSession(actor, a.projectId, {
          expectedVersion: a.version,
          sessionId: source.id
        })
      ).project;
    b = (
      await repo.addPersonalProjectRepositoryRule(actor, b.projectId, {
        expectedVersion: b.version,
        repository: git
      })
    ).project;
    for (const source of [overlap, cOnly])
      c = (
        await repo.addPersonalProjectSession(actor, c.projectId, {
          expectedVersion: c.version,
          sessionId: source.id
        })
      ).project;
    const resolved = await repo.resolvePersonalProjectRecall(actor, {
      sessionId: caller.id
    });
    expect(resolved.target.projects.map((ref) => ref.projectId).sort()).toEqual(
      [a.projectId, b.projectId].sort()
    );
    expect(
      await repo.resolvePersonalProjectRecall(actor, {
        externalSessionId: caller.externalSessionId!,
        sourceRuntime: "codex-cli"
      })
    ).toEqual(resolved);
    const source = {
      ownerUserId: actor.userId,
      originatingDeploymentId: "union_deployment",
      originatingDeviceId: "union_device",
      logicalSessionId: `opaque_${randomUUID()}`
    };
    await pool.query(
      `insert into personal_source_bindings(owner_user_id,originating_deployment_id,originating_device_id,source_logical_session_id,local_session_id,local_logical_session_id,availability,git_state,folder_state)
      select $1,$2,$3,$4,id,logical_session_id,'available','available','available' from sessions where id=$5`,
      [
        actor.userId,
        source.originatingDeploymentId,
        source.originatingDeviceId,
        source.logicalSessionId,
        caller.id
      ]
    );
    expect(await repo.resolvePersonalProjectRecall(actor, { source })).toEqual(
      resolved
    );
    await expect(
      repo.resolvePersonalProjectRecall(other, { source })
    ).rejects.toMatchObject({ statusCode: 404 });
    const ambiguous = await capture();
    await pool.query("update sessions set external_session_id=$2 where id=$1", [
      ambiguous.id,
      caller.externalSessionId
    ]);
    await expect(
      repo.resolvePersonalProjectRecall(actor, {
        externalSessionId: caller.externalSessionId!,
        sourceRuntime: "codex-cli"
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    const selection: PersonalSelectionSnapshot = {
      version: 1,
      ownerUserId: actor.userId,
      target: resolved.target,
      callerRepositoryContext: null
    };
    expect(
      projectPersonalSelectionQuery(actor.userId, {
        personalSelection: selection
      }).selection.namedProjectIds
    ).toHaveLength(2);
    const selected = async () =>
      (
        await pool.query<{ id: string }>(
          `select s.id from sessions s where ${personalSourceSelectionSql("s", "$1")} order by s.id`,
          [
            JSON.stringify(
              resolvePersonalSourceSelection(actor.userId, {
                personalSelection: selection
              })
            )
          ]
        )
      ).rows.map((row) => row.id);
    expect(await selected()).toEqual(
      [caller.id, aOnly.id, bOnly.id, overlap.id].sort()
    );
    a = (
      await repo.excludePersonalProjectSession(actor, a.projectId, {
        expectedVersion: a.version,
        sessionId: overlap.id
      })
    ).project;
    expect(await selected()).toContain(overlap.id);
    b = (
      await repo.excludePersonalProjectSession(actor, b.projectId, {
        expectedVersion: b.version,
        sessionId: overlap.id
      })
    ).project;
    expect(await selected()).not.toContain(overlap.id);
    const event = async (sessionId: string) =>
      repo.createMemoryEvent(actor, {
        sessionId,
        projectId: "recorded",
        visibility: "personal",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_message",
        content: "UNION_FACT",
        idempotencyKey: randomUUID()
      });
    const inEvent = await event(aOnly.id),
      outEvent = await event(cOnly.id);
    const node = await repo.createMemoryNode(actor, {
      visibility: "personal",
      summaryText: "MIXED_UNION",
      sourceHash: randomUUID()
    });
    await pool.query(
      "update memory_nodes set source_event_count=2,lcm_algorithm_version='fixture' where id=$1",
      [node.id]
    );
    await pool.query(
      "insert into memory_node_sources(memory_node_id,memory_event_id,source_order) values($1,$2,0),($1,$3,1)",
      [node.id, inEvent.id, outEvent.id]
    );
    const checkSummary = await pool.query<{ allowed: boolean }>(
      `select ${personalMemoryNodeSelectionSql("$1::uuid", "$2", "$3", "$4")} allowed`,
      [
        node.id,
        JSON.stringify(
          resolvePersonalSourceSelection(actor.userId, {
            personalSelection: selection
          })
        ),
        null,
        null
      ]
    );
    expect(checkSummary.rows[0]!.allowed).toBe(false);
    expect(() =>
      pinMemoryAnswerTaskSelection(
        {
          requestVersion: 1,
          selection,
          input: { search_domain: "project", query: "fact" }
        },
        actor.userId
      )
    ).not.toThrow();
    const finalInput = {
      idempotencyKey: randomUUID(),
      query: "Union answer",
      status: "answered" as const,
      answerMarkdown: "Retained owner answer",
      searchDomain: "project" as const,
      personalSelection: selection
    };
    const finalQuestion = await repo.createFinalMemoryQuestion(
      actor,
      finalInput
    );
    expect(finalQuestion.projectId).toBeNull();
    expect(finalQuestion.retrieval?.personal_selection).toEqual(selection);
    const stored = await pool.query<{ retrieval: unknown }>(
      "select retrieval from memory_questions where id=$1",
      [finalQuestion.id]
    );
    expect(stored.rows[0]!.retrieval).toMatchObject({ contentEncrypted: true });
    expect((await repo.createFinalMemoryQuestion(actor, finalInput)).id).toBe(
      finalQuestion.id
    );
    await expect(
      repo.createFinalMemoryQuestion(actor, {
        ...finalInput,
        personalSelection: {
          ...selection,
          target: {
            ...resolved.target,
            projects: resolved.target.projects.slice(0, 1)
          }
        }
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      repo.createFinalMemoryQuestion(actor, {
        ...finalInput,
        personalSelection: undefined
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      repo.createFinalMemoryQuestion(actor, {
        ...finalInput,
        searchDomain: "global",
        personalSelection: undefined
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      repo.createFinalMemoryQuestion(other, {
        ...finalInput,
        idempotencyKey: randomUUID()
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      repo.createFinalMemoryQuestion(actor, {
        ...finalInput,
        teamWorkspaceId: randomUUID(),
        idempotencyKey: randomUUID()
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    await repo.reconcilePersonalProjectDefaults(actor);
    await expect(
      repo.resolvePersonalProjectRecall(actor, { sessionId: empty.id })
    ).rejects.toMatchObject({
      code: "personal_project_membership_missing",
      statusCode: 409
    });
    await expect(
      repo.resolvePersonalProjectRecall(other, { sessionId: caller.id })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      repo.resolvePersonalProjectRecall(actor, { sessionId: randomUUID() })
    ).rejects.toMatchObject({ statusCode: 404 });
    a = (
      await repo.excludePersonalProjectSession(actor, a.projectId, {
        expectedVersion: a.version,
        sessionId: caller.id
      })
    ).project;
    expect(await selected()).toEqual([caller.id, bOnly.id].sort());
    b = (
      await repo.excludePersonalProjectSession(actor, b.projectId, {
        expectedVersion: b.version,
        sessionId: caller.id
      })
    ).project;
    expect(await selected()).toEqual([]);
    expect(
      (await repo.getMemoryQuestion(actor, finalQuestion.id))?.retrieval
        ?.personal_selection
    ).toEqual(selection);
  });
});
