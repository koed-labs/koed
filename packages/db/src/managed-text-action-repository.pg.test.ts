import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCapturedSessionRepository } from "./captured-session-repository.js";
import { createChatForgetRepository } from "./chat-forget-repository.js";
import {
  createChatMoveRepository,
  ChatMoveConflictError
} from "./chat-move-repository.js";
import { createManagedConversationRepository } from "./managed-conversation-repository.js";
import { createManagedTextActionRepository } from "./managed-text-action-repository.js";
import { runDbMigrations } from "./migrate.js";
import { createProjectApiRepository } from "./project-api-repository.js";
import { createWorkItemRepository } from "./work-item-repository.js";
import { createAgentsRepository } from "./agents-repository.js";
import {
  createFlashcardDeckRepository,
  DeckConflictError
} from "./flashcard-deck-repository.js";
import { deckCreateFromTextAction } from "./managed-deck-action.js";
import {
  createScheduledJobRepository,
  ScheduledJobConflict
} from "./scheduled-job-repository.js";

// Requires the canonical HQ-504 migration (0073). This file is prepared before
// that schema slot opens; it must be run against a fresh child database then.
const testUrl = process.env.KOED_HQ504_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)("HQ-504 exact managed text-action authority", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64url")
  );
  const deploymentId = randomUUID();
  const deviceId = randomUUID();

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq504_actions_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(
        `drop database if exists ${quote(database)} with (force)`
      );
    await admin?.end();
  });

  const fixture = async (
    permissionMode: "supervised" | "full_access" = "supervised",
    ordinaryConversation = false
  ) => {
    const owner = randomUUID();
    const actor = { userId: owner };
    await pool.query("insert into users(id,email) values($1,$2)", [
      owner,
      `${owner}@example.test`
    ]);
    const projects = createProjectApiRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const project = await projects.create(owner, {
      name: "Origin Project",
      folderPath: null,
      idempotencyKey: randomUUID()
    });
    if (!ordinaryConversation)
      await projects.reserveHqConversation(owner, project.id);
    const managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const actions = createManagedTextActionRepository(pool, provider);
    const launched = await managed.createManagedConversation(actor, {
      projectId: project.id,
      ...(ordinaryConversation
        ? {}
        : {
            hqProjectId: project.id,
            hqPrivatePath: `/private/project-hq/${owner}/${project.id}`
          }),
      contextKind: "independent",
      provider: "codex",
      aiClientInstanceId: "codex.default",
      model: "test",
      permissionMode,
      runnerKind: "local_device",
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      idempotencyKey: randomUUID(),
      ...(ordinaryConversation
        ? {}
        : {
            initialPrompt: "Create a Project from my request",
            textActionHumanOrigin: "hq_first_message" as const
          })
    });
    const executionId = launched.execution.id;
    let commandId = launched.command.id;
    const logicalSessionId = randomUUID();
    const sessionId = randomUUID();
    await managed.upsertManagedConversationRuntimeBinding(actor, {
      executionId,
      deploymentId,
      deviceId,
      executionGeneration: 1,
      projectPath: `/private/project-hq/${owner}/${project.id}`
    });
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,
         external_session_id,visibility,capture_method,source_kind,
         source_runtime,source_adapter_version,cwd)
       values($1,$2,$3,$4,'personal','transcript','codex',
         'codex','codex-transcript-v1',$5)`,
      [
        sessionId,
        owner,
        logicalSessionId,
        `hq504-${sessionId}`,
        `/private/project-hq/${owner}/${project.id}`
      ]
    );
    await pool.query(
      `update managed_conversation_executions
          set logical_session_id=$2,provider_thread_id=$3,state='running'
        where id=$1`,
      [executionId, logicalSessionId, `provider-${sessionId}`]
    );
    await pool.query(
      `update managed_conversation_runtime_bindings
          set local_session_id=$2,provider_thread_id=$3 where execution_id=$1`,
      [executionId, sessionId, `provider-${sessionId}`]
    );
    const runnerId = randomUUID();
    let claimed = await managed.claimManagedConversationCommands({
      ownerUserId: owner,
      runnerId,
      deploymentId,
      deviceId,
      leaseMs: 60_000
    });
    if (ordinaryConversation) {
      const start = claimed.find((entry) => entry.id === commandId);
      expect(start?.leaseToken).toBeTruthy();
      expect(
        await managed.completeManagedConversationCommand({
          commandId,
          leaseToken: start!.leaseToken!
        })
      ).toBe(true);
      const prompt = await managed.enqueueManagedConversationPrompt(actor, {
        executionId,
        executionGeneration: 1,
        idempotencyKey: randomUUID(),
        clientUserMessageId: randomUUID(),
        prompt: "Please create the requested Project",
        textActionHumanOrigin: "human_prompt"
      });
      commandId = prompt.id;
      claimed = await managed.claimManagedConversationCommands({
        ownerUserId: owner,
        runnerId,
        deploymentId,
        deviceId,
        leaseMs: 60_000
      });
    }
    const command = claimed.find((entry) => entry.id === commandId);
    expect(command?.leaseToken).toBeTruthy();
    return {
      owner,
      actor,
      project,
      projects,
      managed,
      actions,
      executionId,
      commandId,
      sessionId,
      leaseToken: command!.leaseToken!
    };
  };

  it("creates a reviewed Personal Deck with an exact journal effect and rejects same-key adoption", async () => {
    const f = await fixture("supervised");
    await pool.query(
      `insert into ai_client_instances(owner_user_id,instance_id,driver_id,display_name,enabled)
       values($1,'codex.default','codex','Codex',true) on conflict do nothing`,
      [f.owner]
    );
    const agent = await createAgentsRepository(pool).create(f.owner, {
      name: "Flashcard Agent",
      role: "Assistant",
      look: {},
      aiClientInstanceId: "codex.default",
      defaultPermissionMode: "supervised",
      defaultModel: null
    });
    const decks = createFlashcardDeckRepository(pool);
    const make = async (toolCallId: string) => {
      const args = {
        projectId: f.project.id,
        title: "Chapter 7",
        scope: "Chapter 7 only; exclude later chapters",
        madeFrom: "Course notes",
        cards: [
          { question: "What is X?", answer: "X is Y.", sourceRef: "Notes p. 7" }
        ]
      };
      const action = await f.actions.enqueueManagedTextAction(f.actor, {
        executionId: f.executionId,
        commandId: f.commandId,
        leaseToken: f.leaseToken,
        executionGeneration: 1,
        providerTurnId: `turn-${toolCallId}`,
        toolCallId,
        name: "koed_deck_make",
        arguments: args
      });
      expect(action?.state).toBe("awaiting_review");
      expect(action?.snapshot.agentId).toBe(agent.id);
      const approved = await f.actions.decideManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id,
        expectedRevision: action!.revision,
        decision: "approve"
      });
      const claimed = await f.actions.claimManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id,
        expectedRevision: approved!.revision
      });
      expect(claimed?.state).toBe("claimed");
      return { action: action!, claimed: claimed!, args };
    };
    const good = await make("flashcards-good");
    const prepared = await f.actions.prepareManagedTextDeckMake(f.actor, {
      executionId: f.executionId,
      actionId: good.action.id,
      expectedRevision: good.claimed.revision
    });
    expect(prepared?.id).toBe(good.action.id);
    const payload = deckCreateFromTextAction(
      good.action.id,
      good.args,
      agent.id
    );
    const created = await decks.createPersonal(f.owner, f.project.id, payload, {
      actionId: good.action.id,
      encryptionProvider: provider
    });
    expect(created.createdByAgentId).toBe(agent.id);
    expect(
      (
        await pool.query(
          "select 1 from managed_conversation_text_action_create_effects where owner_user_id=$1 and action_id=$2 and project_id=$3",
          [f.owner, good.action.id, f.project.id]
        )
      ).rowCount
    ).toBe(1);
    expect(
      (
        await f.actions.completeManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: good.action.id,
          expectedRevision: good.claimed.revision
        })
      )?.state
    ).toBe("applied");

    const collision = await make("flashcards-collision");
    const collisionPayload = deckCreateFromTextAction(
      collision.action.id,
      collision.args,
      agent.id
    );
    await decks.createPersonal(f.owner, f.project.id, collisionPayload);
    await expect(
      decks.createPersonal(f.owner, f.project.id, collisionPayload, {
        actionId: collision.action.id,
        encryptionProvider: provider
      })
    ).rejects.toBeInstanceOf(DeckConflictError);
    expect(
      await f.actions.completeManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: collision.action.id,
        expectedRevision: collision.claimed.revision
      })
    ).toBeNull();
    const moved = await make("flashcards-assignment-changed");
    expect(
      await f.actions.prepareManagedTextDeckMake(f.actor, {
        executionId: f.executionId,
        actionId: moved.action.id,
        expectedRevision: moved.claimed.revision
      })
    ).not.toBeNull();
    // An assignment round trip can keep the same Project ID. Its version
    // still invalidates the earlier approval before the actual Deck effect.
    await pool.query(
      "update sessions set project_assignment_version=project_assignment_version+2 where id=$1",
      [f.sessionId]
    );
    await expect(
      decks.createPersonal(
        f.owner,
        f.project.id,
        deckCreateFromTextAction(moved.action.id, moved.args, agent.id),
        { actionId: moved.action.id, encryptionProvider: provider }
      )
    ).rejects.toThrow("Reviewed Deck action changed");
    expect(
      await decks.getPersonalByCreationKey(
        f.owner,
        f.project.id,
        moved.action.id
      )
    ).toBeNull();
  });

  it("binds a human-origin unscoped Scheduled Job and rejects a moved Conversation after claim", async () => {
    const setup = async (projectScoped = false) => {
      const f = await fixture("supervised", true);
      if (projectScoped)
        await pool.query(
          "update sessions set automatic_personal_project_id=$2,project_assignment_version=project_assignment_version+1 where id=$1",
          [f.sessionId, f.project.id]
        );
      await pool.query(
        `insert into ai_client_instances(owner_user_id,instance_id,driver_id,display_name,enabled)
         values($1,'codex.default','codex','Codex',true) on conflict do nothing`,
        [f.owner]
      );
      const agent = await createAgentsRepository(pool).create(f.owner, {
        name: "Scheduler",
        role: "Assistant",
        look: {},
        aiClientInstanceId: "codex.default",
        defaultPermissionMode: "supervised",
        defaultModel: null
      });
      await pool.query(
        `insert into device_credentials(owner_user_id,credential_key_id,upstream_backend_id,
           device_instance_id,verifier_kind,verifier_hash,operation_families)
         values($1,$2,'personal',$3,'secret_hash',$4,array['managed_execution'])`,
        [f.owner, `hq603-${randomUUID()}`, deviceId, "a".repeat(64)]
      );
      const args = {
        title: "Morning brief",
        instruction: "Check the plan",
        schedule: { kind: "daily" as const, at: "09:00", tz: "Europe/Oslo" }
      };
      const action = await f.actions.enqueueManagedTextAction(f.actor, {
        executionId: f.executionId,
        commandId: f.commandId,
        leaseToken: f.leaseToken,
        executionGeneration: 1,
        providerTurnId: "turn-job",
        toolCallId: "tool-job",
        name: "koed_job_create",
        arguments: args
      });
      expect(action?.state).toBe("awaiting_review");
      expect(action?.snapshot.projectId).toBe(
        projectScoped ? f.project.id : undefined
      );
      const approved = await f.actions.decideManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id,
        expectedRevision: action!.revision,
        decision: "approve"
      });
      const claimed = await f.actions.claimManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id,
        expectedRevision: approved!.revision
      });
      expect(claimed?.state).toBe("claimed");
      return { f, agent, action: action!, claimed: claimed!, args };
    };
    const first = await setup();
    const jobs = createScheduledJobRepository(pool, {
      encryptionProvider: provider
    });
    const created = await jobs.create(first.f.owner, deviceId, {
      ...first.args,
      requestId: first.action.id,
      textActionId: first.action.id,
      projectId: null,
      agentId: first.agent.id,
      conversationSessionId: first.f.sessionId
    });
    expect(created.projectId).toBeNull();
    expect(
      (
        await first.f.actions.completeManagedTextAction(first.f.actor, {
          executionId: first.f.executionId,
          actionId: first.action.id,
          expectedRevision: first.claimed.revision
        })
      )?.state
    ).toBe("applied");
    expect(
      (
        await jobs.create(first.f.owner, deviceId, {
          ...first.args,
          requestId: first.action.id,
          textActionId: first.action.id,
          projectId: null,
          agentId: first.agent.id,
          conversationSessionId: first.f.sessionId
        })
      ).id
    ).toBe(created.id);
    const pauseAction = await first.f.actions.enqueueManagedTextAction(
      first.f.actor,
      {
        executionId: first.f.executionId,
        commandId: first.f.commandId,
        leaseToken: first.f.leaseToken,
        executionGeneration: 1,
        providerTurnId: "turn-job",
        toolCallId: "tool-job-pause",
        name: "koed_job_pause",
        arguments: { title: created.title, paused: true }
      }
    );
    expect(pauseAction?.state).toBe("awaiting_review");
    const pauseApproved = await first.f.actions.decideManagedTextAction(
      first.f.actor,
      {
        executionId: first.f.executionId,
        actionId: pauseAction!.id,
        expectedRevision: pauseAction!.revision,
        decision: "approve"
      }
    );
    const pauseClaimed = await first.f.actions.claimManagedTextAction(
      first.f.actor,
      {
        executionId: first.f.executionId,
        actionId: pauseAction!.id,
        expectedRevision: pauseApproved!.revision
      }
    );
    expect(pauseClaimed?.state).toBe("claimed");
    expect(
      (
        await jobs.setPaused(
          first.f.owner,
          created.id,
          created.version,
          true,
          pauseAction!.id
        )
      ).paused
    ).toBe(true);
    expect(
      (
        await first.f.actions.completeManagedTextAction(first.f.actor, {
          executionId: first.f.executionId,
          actionId: pauseAction!.id,
          expectedRevision: pauseClaimed!.revision
        })
      )?.state
    ).toBe("applied");
    const resumed = await jobs.setPaused(
      first.f.owner,
      created.id,
      created.version + 1,
      false
    );
    const syntheticRun = await jobs.runNow(
      first.f.owner,
      created.id,
      resumed.version,
      randomUUID()
    );
    const syntheticAttempt = await jobs.startAttempt(
      first.f.owner,
      created.id,
      syntheticRun.id,
      {
        expectedJobVersion: resumed.version,
        runnerDeviceId: deviceId,
        fenceToken: "synthetic-boundary"
      }
    );
    if (!syntheticAttempt.started)
      throw new Error("Expected a Scheduled Job attempt");
    await pool.query(
      `insert into scheduled_job_attempt_dispatch_bindings
       (attempt_id,owner_user_id,managed_execution_id,managed_execution_generation,managed_command_id)
       values($1,$2,$3,1,$4)`,
      [
        syntheticAttempt.attemptId,
        first.f.owner,
        first.f.executionId,
        first.f.commandId
      ]
    );
    for (const name of ["koed_chat_create", "koed_job_create"] as const) {
      expect(
        await first.f.actions.enqueueManagedTextAction(first.f.actor, {
          executionId: first.f.executionId,
          commandId: first.f.commandId,
          leaseToken: first.f.leaseToken,
          executionGeneration: 1,
          providerTurnId: "synthetic-turn",
          toolCallId: `synthetic-${name}`,
          name,
          arguments: name === "koed_chat_create" ? {} : first.args
        })
      ).toBeNull();
    }
    const second = await setup();
    await pool.query(
      `update sessions set automatic_personal_project_id=$2,
       project_assignment_version=project_assignment_version+1 where id=$1`,
      [second.f.sessionId, second.f.project.id]
    );
    await expect(
      jobs.create(second.f.owner, deviceId, {
        ...second.args,
        requestId: second.action.id,
        textActionId: second.action.id,
        projectId: null,
        agentId: second.agent.id,
        conversationSessionId: second.f.sessionId
      })
    ).rejects.toBeInstanceOf(ScheduledJobConflict);
    const third = await setup(true);
    await pool.query("update projects set version=version+1 where id=$1", [
      third.f.project.id
    ]);
    await expect(
      jobs.create(third.f.owner, deviceId, {
        ...third.args,
        requestId: third.action.id,
        textActionId: third.action.id,
        projectId: third.f.project.id,
        agentId: third.agent.id,
        conversationSessionId: third.f.sessionId
      })
    ).rejects.toBeInstanceOf(ScheduledJobConflict);
  }, 120_000);

  it("uses the exact human command, generation and lease for a single proposal", async () => {
    const f = await fixture();
    const request = {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-1",
      toolCallId: "tool-1",
      name: "koed_project_create" as const,
      arguments: { name: "Exact new Project" }
    };
    expect(
      await f.actions.enqueueManagedTextAction(f.actor, {
        ...request,
        leaseToken: randomUUID()
      })
    ).toBeNull();
    expect(
      await f.actions.enqueueManagedTextAction(f.actor, {
        ...request,
        executionGeneration: 2
      })
    ).toBeNull();
    const proposed = await f.actions.enqueueManagedTextAction(f.actor, request);
    expect(proposed?.state).toBe("awaiting_review");
    expect(proposed?.commandId).toBe(f.commandId);
    expect(
      (await f.actions.enqueueManagedTextAction(f.actor, request))?.id
    ).toBe(proposed?.id);
    expect(
      await f.actions.enqueueManagedTextAction(f.actor, {
        ...request,
        arguments: { name: "Changed request" }
      })
    ).toBeNull();
    expect(
      await f.actions.enqueueManagedTextAction(
        { userId: randomUUID() },
        request
      )
    ).toBeNull();
  }, 120_000);

  it("allows a reviewed exact create after the human turn completes, and does not adopt a generic key collision", async () => {
    const f = await fixture();
    const action = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-create",
      toolCallId: "tool-create",
      name: "koed_project_create",
      arguments: { name: "Reviewed Project" }
    });
    expect(action?.state).toBe("awaiting_review");
    expect(
      await f.managed.completeManagedConversationCommand({
        commandId: f.commandId,
        leaseToken: f.leaseToken
      })
    ).toBe(true);
    const approved = await f.actions.decideManagedTextAction(f.actor, {
      executionId: f.executionId,
      actionId: action!.id,
      expectedRevision: action!.revision,
      decision: "approve"
    });
    expect(approved?.state).toBe("ready");
    const [first, second] = await Promise.all([
      f.actions.claimManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id,
        expectedRevision: approved!.revision
      }),
      f.actions.claimManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id,
        expectedRevision: approved!.revision
      })
    ]);
    const claimed = first ?? second;
    expect(claimed?.state).toBe("claimed");
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(
      await f.actions.completeManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id,
        expectedRevision: claimed!.revision
      })
    ).toBeNull();
    // An ordinary button-style create with the same idempotency key has no
    // action receipt and must never satisfy the claimed text action.
    await f.projects.create(f.owner, {
      name: "Reviewed Project",
      folderPath: null,
      idempotencyKey: action!.id
    });
    await expect(
      f.projects.create(f.owner, {
        name: "Reviewed Project",
        folderPath: null,
        idempotencyKey: action!.id,
        textActionId: action!.id
      })
    ).rejects.toThrow("receipt");
    expect(
      await f.actions.completeManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id,
        expectedRevision: claimed!.revision
      })
    ).toBeNull();
    expect(
      (
        await f.actions.reconcileManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: action!.id
        })
      )?.state
    ).toBe("claimed");
  }, 120_000);

  it("denies a stale or synthetic command and a restrictive permission change", async () => {
    const stale = await fixture("full_access");
    const action = await stale.actions.enqueueManagedTextAction(stale.actor, {
      executionId: stale.executionId,
      commandId: stale.commandId,
      leaseToken: stale.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-full",
      toolCallId: "tool-full",
      name: "koed_project_create",
      arguments: { name: "No silent downgrade" }
    });
    expect(action?.state).toBe("ready");
    await pool.query(
      "update managed_conversation_executions set permission_mode='supervised' where id=$1",
      [stale.executionId]
    );
    expect(
      await stale.actions.claimManagedTextAction(stale.actor, {
        executionId: stale.executionId,
        actionId: action!.id,
        expectedRevision: action!.revision
      })
    ).toBeNull();
    await pool.query(
      "update managed_conversation_commands set lease_expires_at=now()-interval '1 second' where id=$1",
      [stale.commandId]
    );
    expect(
      await stale.actions.enqueueManagedTextAction(stale.actor, {
        executionId: stale.executionId,
        commandId: stale.commandId,
        leaseToken: stale.leaseToken,
        executionGeneration: 1,
        providerTurnId: "turn-expired",
        toolCallId: "tool-expired",
        name: "koed_chat_create",
        arguments: {}
      })
    ).toBeNull();
    await expect(
      pool.query(
        "update managed_conversation_commands set command_kind='hq_catch_up' where id=$1",
        [stale.commandId]
      )
    ).rejects.toThrow();
    expect(
      await stale.actions.enqueueManagedTextAction(stale.actor, {
        executionId: stale.executionId,
        commandId: stale.commandId,
        leaseToken: stale.leaseToken,
        executionGeneration: 1,
        providerTurnId: "turn-synthetic",
        toolCallId: "tool-synthetic",
        name: "koed_chat_create",
        arguments: {}
      })
    ).toBeNull();
    expect(
      await stale.actions.enqueueManagedTextAction(stale.actor, {
        executionId: stale.executionId,
        commandId: stale.commandId,
        leaseToken: stale.leaseToken,
        executionGeneration: 1,
        providerTurnId: "turn-synthetic-job",
        toolCallId: "tool-synthetic-job",
        name: "koed_job_create",
        arguments: {
          title: "No synthetic Job",
          instruction: "Denied",
          schedule: { kind: "daily", at: "09:00", tz: "Europe/Oslo" }
        }
      })
    ).toBeNull();
  }, 120_000);

  it("records exact Project and private to-do creates before reporting success", async () => {
    const f = await fixture("full_access");
    const projectAction = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-effects",
      toolCallId: "project-create",
      name: "koed_project_create",
      arguments: { name: "Effect Project" }
    });
    expect(projectAction?.state).toBe("ready");
    const claimedProject = await f.actions.claimManagedTextAction(f.actor, {
      executionId: f.executionId,
      actionId: projectAction!.id,
      expectedRevision: projectAction!.revision
    });
    expect(claimedProject?.state).toBe("claimed");
    const created = await f.projects.create(f.owner, {
      name: "Effect Project",
      folderPath: null,
      idempotencyKey: projectAction!.id,
      textActionId: projectAction!.id
    });
    const replay = await f.projects.create(f.owner, {
      name: "Effect Project",
      folderPath: null,
      idempotencyKey: projectAction!.id,
      textActionId: projectAction!.id
    });
    expect(replay.id).toBe(created.id);
    expect(
      (
        await f.actions.completeManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: projectAction!.id,
          expectedRevision: claimedProject!.revision
        })
      )?.state
    ).toBe("applied");

    const todoAction = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-effects",
      toolCallId: "todo-create",
      name: "koed_todo_add",
      arguments: { projectId: f.project.id, title: "Exact to-do" }
    });
    expect(todoAction?.state).toBe("ready");
    const claimedTodo = await f.actions.claimManagedTextAction(f.actor, {
      executionId: f.executionId,
      actionId: todoAction!.id,
      expectedRevision: todoAction!.revision
    });
    expect(claimedTodo?.state).toBe("claimed");
    const workItems = createWorkItemRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const item = await workItems.create(f.owner, f.project.id, {
      kind: "todo",
      title: "Exact to-do",
      goal: "Exact to-do",
      origin: "koed_text_action",
      idempotencyKey: todoAction!.id,
      textActionId: todoAction!.id
    });
    expect(item.title).toBe("Exact to-do");
    expect(
      (
        await f.actions.completeManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: todoAction!.id,
          expectedRevision: claimedTodo!.revision
        })
      )?.state
    ).toBe("applied");
    const receipts = await pool.query<{ action_id: string }>(
      `select action_id from managed_conversation_text_action_create_effects
        where owner_user_id=$1 order by action_id`,
      [f.owner]
    );
    expect(receipts.rows.map((row) => row.action_id).sort()).toEqual(
      [projectAction!.id, todoAction!.id].sort()
    );
  }, 120_000);

  it("dispatches a private to-do through the exact claimed text action, never a matching generic key", async () => {
    const f = await fixture("full_access");
    const agentId = randomUUID();
    await pool.query(
      `insert into ai_client_instances
       (owner_user_id,instance_id,driver_id,display_name,enabled)
       values($1,'codex.default','codex','Codex',true)`,
      [f.owner]
    );
    await pool.query(
      `insert into agents(id,owner_user_id,name,ai_client_instance_id,default_permission_mode)
       values($1,$2,'Quinn','codex.default','supervised')`,
      [agentId, f.owner]
    );
    const workItems = createWorkItemRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const createItem = (title: string) =>
      workItems.create(f.owner, f.project.id, {
        kind: "todo",
        title,
        goal: title,
        origin: "manual",
        idempotencyKey: randomUUID()
      });
    const launch = (
      item: { id: string; version: number },
      textActionId?: string
    ) =>
      f.managed.createManagedConversation(f.actor, {
        projectId: f.project.id,
        contextKind: "project",
        provider: "codex",
        aiClientInstanceId: "codex.default",
        model: "test",
        permissionMode: "supervised",
        runnerKind: "local_device",
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        idempotencyKey: randomUUID(),
        initialPrompt: item.id,
        deferUntilRuntimeBinding: true,
        workItemDispatch: {
          itemId: item.id,
          agentId,
          version: item.version,
          ...(textActionId ? { textActionId } : {})
        }
      });
    const propose = async (
      item: { id: string; version: number },
      call: string
    ) => {
      const proposed = await f.actions.enqueueManagedTextAction(f.actor, {
        executionId: f.executionId,
        commandId: f.commandId,
        leaseToken: f.leaseToken,
        executionGeneration: 1,
        providerTurnId: "turn-send",
        toolCallId: call,
        name: "koed_todo_send",
        arguments: {
          projectId: f.project.id,
          workItemId: item.id,
          agentId
        }
      });
      expect(proposed?.state).toBe("ready");
      const claimed = await f.actions.claimManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: proposed!.id,
        expectedRevision: proposed!.revision
      });
      expect(claimed?.state).toBe("claimed");
      return { proposed: proposed!, claimed: claimed! };
    };

    // A normal button dispatch has the same public dispatch key, but no text-action effect.
    const genericItem = await createItem("Generic collision");
    const genericAction = await propose(genericItem, "generic-collision");
    const generic = await launch(genericItem);
    expect(
      (await workItems.getForRealtime(f.owner, genericItem.id))?.dispatchKey
    ).toBe(`${genericItem.id}:${genericItem.version}`);
    expect(
      await f.actions.completeManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: genericAction.proposed.id,
        expectedRevision: genericAction.claimed.revision
      })
    ).toBeNull();
    await expect(
      launch(genericItem, genericAction.proposed.id)
    ).rejects.toMatchObject({
      statusCode: 409
    });
    const noAdopt = await pool.query(
      `select 1 from managed_conversation_text_action_dispatch_effects
        where action_id=$1`,
      [genericAction.proposed.id]
    );
    expect(noAdopt.rowCount).toBe(0);

    // The actual text-action path commits execution, Work Item CAS and exact effect together.
    const item = await createItem("Exact private dispatch");
    const action = await propose(item, "exact-dispatch");
    await expect(launch(item, genericAction.proposed.id)).rejects.toMatchObject(
      {
        statusCode: 409
      }
    );
    const dispatched = await launch(item, action.proposed.id);
    const current = await workItems.getForRealtime(f.owner, item.id);
    expect(current).toMatchObject({
      status: "doing",
      executionId: dispatched.execution.id,
      assigneeAgentId: agentId,
      dispatchKey: `${item.id}:${item.version}`
    });
    const effect = await pool.query<{
      execution_id: string;
      command_id: string;
      work_item_version: number;
    }>(
      `select execution_id,command_id,work_item_version
         from managed_conversation_text_action_dispatch_effects
        where action_id=$1 and owner_user_id=$2`,
      [action.proposed.id, f.owner]
    );
    expect(effect.rows).toEqual([
      {
        execution_id: dispatched.execution.id,
        command_id: dispatched.command.id,
        work_item_version: item.version
      }
    ]);
    const replay = await launch(item, action.proposed.id);
    expect(replay.execution.id).toBe(dispatched.execution.id);
    expect(
      (
        await pool.query<{ count: number }>(
          `select count(*)::int as count from managed_conversation_text_action_dispatch_effects
            where action_id=$1`,
          [action.proposed.id]
        )
      ).rows[0]?.count
    ).toBe(1);
    expect(
      (
        await f.actions.completeManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: action.proposed.id,
          expectedRevision: action.claimed.revision
        })
      )?.state
    ).toBe("applied");
    expect(generic.execution.id).not.toBe(dispatched.execution.id);
  }, 120_000);

  it("keeps a claimed Team nonce private and applies only its exact receipt hash", async () => {
    const f = await fixture();
    const teamBackendId = randomUUID();
    const workspaceProjectId = randomUUID();
    await pool.query(
      `update projects set team_backend_id=$2,workspace_project_id=$3
        where id=$1`,
      [f.project.id, teamBackendId, workspaceProjectId]
    );
    let receivedHash: string | null = null;
    const actions = createManagedTextActionRepository(pool, provider, {
      teamAuthority: async () => ({
        teamProjectVersion: 1,
        teamMemberVersion: 1
      }),
      teamReceipt: async () => ({
        confirmed: true,
        effectNonceHash: receivedHash
      })
    });
    const proposed = await actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-team",
      toolCallId: "team-todo",
      name: "koed_todo_add",
      arguments: { projectId: f.project.id, title: "Team exact" }
    });
    expect(proposed?.state).toBe("ready");
    const claimed = await actions.claimManagedTextAction(f.actor, {
      executionId: f.executionId,
      actionId: proposed!.id,
      expectedRevision: proposed!.revision
    });
    expect(claimed?.state).toBe("claimed");
    expect(JSON.stringify(claimed)).not.toContain("effectNonce");
    await expect(
      pool.query(
        `update managed_conversation_text_action_team_nonces
          set encrypted_nonce=jsonb_set(encrypted_nonce,'{aad,teamProjectVersion}','[]'::jsonb)
        where action_id=$1`,
        [proposed!.id]
      )
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(
        "delete from managed_conversation_text_action_team_nonces where action_id=$1",
        [proposed!.id]
      )
    ).rejects.toThrow(/directly/);
    const prepared = await actions.prepareManagedTextTeamTodoAdd(f.actor, {
      executionId: f.executionId,
      actionId: proposed!.id,
      expectedRevision: claimed!.revision
    });
    expect(prepared?.action.id).toBe(proposed!.id);
    expect(prepared?.effectNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const exactHash = createHash("sha256")
      .update(Buffer.from(prepared!.effectNonce, "base64url"))
      .digest("hex");
    receivedHash = createHash("sha256").update("attacker-guess").digest("hex");
    expect(
      await actions.completeManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: proposed!.id,
        expectedRevision: claimed!.revision
      })
    ).toBeNull();
    receivedHash = exactHash;
    expect(
      (
        await actions.completeManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: proposed!.id,
          expectedRevision: claimed!.revision
        })
      )?.state
    ).toBe("applied");
  }, 120_000);

  it("opens a linked Project HQ without granting linked delete or move authority", async () => {
    const f = await fixture("full_access");
    const teamBackendId = randomUUID();
    const teamWorkspaceId = randomUUID();
    const workspaceProjectId = randomUUID();
    await pool.query(
      `update projects set team_backend_id=$2,team_workspace_id=$3,
         workspace_project_id=$4 where id=$1`,
      [f.project.id, teamBackendId, teamWorkspaceId, workspaceProjectId]
    );
    const open = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-linked-navigation",
      toolCallId: "open-hq",
      name: "koed_hq_open",
      arguments: { projectId: f.project.id }
    });
    expect(open?.state).toBe("ready");
    expect(open?.snapshot).toMatchObject({
      projectId: f.project.id,
      projectName: f.project.name,
      projectVersion: f.project.version
    });
    expect(open?.snapshot).not.toHaveProperty("teamProjectVersion");
    expect(open?.snapshot).not.toHaveProperty("teamMemberVersion");

    const deletion = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-linked-navigation",
      toolCallId: "delete-linked",
      name: "koed_project_delete",
      arguments: { projectId: f.project.id }
    });
    expect(deletion?.state).toBe("unavailable");
    expect(deletion?.snapshot).toEqual({});

    const movableSession = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,
        external_session_id,source_runtime,capture_method,visibility)
       values($1,$2,$3,$4,'codex','api','personal')`,
      [movableSession, f.owner, randomUUID(), `linked-target-${movableSession}`]
    );
    const move = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-linked-navigation",
      toolCallId: "move-to-linked",
      name: "koed_chat_move",
      arguments: { sessionId: movableSession, projectId: f.project.id }
    });
    expect(move?.state).toBe("unavailable");
    expect(move?.snapshot).toEqual({});
  }, 120_000);

  it("requires an exact placement receipt; a matching final destination is insufficient", async () => {
    const f = await fixture("full_access");
    const target = await f.projects.create(f.owner, {
      name: "Destination",
      folderPath: null,
      idempotencyKey: randomUUID()
    });
    const movableSession = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,
        external_session_id,source_runtime,capture_method,visibility)
       values($1,$2,$3,$4,'codex','api','personal')`,
      [movableSession, f.owner, randomUUID(), `movable-${movableSession}`]
    );
    const action = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-move",
      toolCallId: "move-chat",
      name: "koed_chat_move",
      arguments: { sessionId: movableSession, projectId: target.id }
    });
    expect(action?.state).toBe("ready");
    const claimed = await f.actions.claimManagedTextAction(f.actor, {
      executionId: f.executionId,
      actionId: action!.id,
      expectedRevision: action!.revision
    });
    expect(claimed?.state).toBe("claimed");
    const captured = createCapturedSessionRepository(pool);
    const destination = { id: target.id, name: target.name, path: null };
    // The ordinary button reaches exactly the target, but does not mint the
    // text action's immutable per-session receipt.
    expect(
      await captured.moveCapturedSessionToProject(
        f.actor,
        movableSession,
        destination,
        null
      )
    ).not.toBeNull();
    expect(
      await f.actions.completeManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id,
        expectedRevision: claimed!.revision
      })
    ).toBeNull();
    const effects = await pool.query(
      `select 1 from managed_conversation_text_action_move_effects
        where owner_user_id=$1 and action_id=$2`,
      [f.owner, action!.id]
    );
    expect(effects.rowCount).toBe(0);
  }, 120_000);

  it("binds a reviewed move to the exact Session placement transaction", async () => {
    const f = await fixture("full_access");
    const destination = await f.projects.create(f.owner, {
      name: "Exact destination",
      folderPath: null,
      idempotencyKey: randomUUID()
    });
    const sessionId = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,
        external_session_id,source_runtime,capture_method,visibility)
       values($1,$2,$3,$4,'codex','api','personal')`,
      [sessionId, f.owner, randomUUID(), `exact-move-${sessionId}`]
    );
    const proposed = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-exact-move",
      toolCallId: "move",
      name: "koed_chat_move",
      arguments: { sessionId, projectId: destination.id }
    });
    expect(proposed?.state).toBe("ready");
    const claimed = await f.actions.claimManagedTextAction(f.actor, {
      executionId: f.executionId,
      actionId: proposed!.id,
      expectedRevision: proposed!.revision
    });
    expect(claimed?.state).toBe("claimed");
    const captured = createCapturedSessionRepository(pool);
    expect(
      await captured.moveCapturedSessionToProject(
        f.actor,
        sessionId,
        { id: destination.id, name: destination.name, path: null },
        null,
        proposed!.id
      )
    ).not.toBeNull();
    expect(
      (
        await f.actions.completeManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: proposed!.id,
          expectedRevision: claimed!.revision
        })
      )?.state
    ).toBe("applied");
    const effect = await pool.query<{ session_id: string }>(
      `select session_id from managed_conversation_text_action_move_effects
        where owner_user_id=$1 and action_id=$2`,
      [f.owner, proposed!.id]
    );
    expect(effect.rows).toEqual([{ session_id: sessionId }]);
  }, 120_000);

  it("cannot propose or claim from a deleting or invalidated origin Session", async () => {
    const f = await fixture();
    await pool.query("update sessions set delete_batch_id=$2 where id=$1", [
      f.sessionId,
      randomUUID()
    ]);
    expect(
      await f.actions.enqueueManagedTextAction(f.actor, {
        executionId: f.executionId,
        commandId: f.commandId,
        leaseToken: f.leaseToken,
        executionGeneration: 1,
        providerTurnId: "turn-deleting",
        toolCallId: "tool-deleting",
        name: "koed_project_create",
        arguments: { name: "Forbidden" }
      })
    ).toBeNull();
    await pool.query("update sessions set delete_batch_id=null where id=$1", [
      f.sessionId
    ]);
    const action = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-invalidated",
      toolCallId: "tool-invalidated",
      name: "koed_project_create",
      arguments: { name: "Before invalidation" }
    });
    expect(action?.state).toBe("awaiting_review");
    await pool.query("update sessions set invalidated_at=now() where id=$1", [
      f.sessionId
    ]);
    expect(
      await f.actions.decideManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id,
        expectedRevision: action!.revision,
        decision: "approve"
      })
    ).toBeNull();
    expect(
      await f.actions.reconcileManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id
      })
    ).toBeNull();
  }, 120_000);

  it("keeps exact Native cancellation terminal without adopting another batch", async () => {
    const f = await fixture();
    const targetSession = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,
        external_session_id,source_runtime,capture_method,visibility)
       values($1,$2,$3,$4,'codex','api','personal')`,
      [targetSession, f.owner, randomUUID(), `native-${targetSession}`]
    );
    const action = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-native",
      toolCallId: "delete-chat",
      name: "koed_chat_delete",
      arguments: { sessionId: targetSession }
    });
    expect(action?.reviewKind).toBe("native");
    expect(action?.state).toBe("awaiting_review");
    const wrongBatch = randomUUID();
    const manifestHash = "0".repeat(64);
    await pool.query(
      `insert into chat_delete_operations(batch_id,session_id,owner_user_id,
        source_manifest,source_manifest_hash,execution_manifest,execution_set_hash)
       values($1,$2,$3,'[]'::jsonb,$4,'[]'::jsonb,$4)`,
      [wrongBatch, targetSession, f.owner, manifestHash]
    );
    await pool.query(
      "update chat_delete_operations set state='cancelled' where batch_id=$1",
      [wrongBatch]
    );
    expect(
      (
        await f.actions.reconcileManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: action!.id
        })
      )?.state
    ).toBe("awaiting_review");
    await expect(
      pool.query(
        "update managed_conversation_text_actions set state='declined',revision=revision+1 where id=$1",
        [action!.id]
      )
    ).rejects.toThrow(/exact terminal batch/);
    await pool.query(
      `insert into chat_delete_operations(batch_id,session_id,owner_user_id,
        source_manifest,source_manifest_hash,execution_manifest,execution_set_hash)
       values($1,$2,$3,'[]'::jsonb,$4,'[]'::jsonb,$4)`,
      [action!.id, targetSession, f.owner, manifestHash]
    );
    await pool.query(
      "update chat_delete_operations set state='cancelled' where batch_id=$1",
      [action!.id]
    );
    expect(
      (
        await f.actions.reconcileManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: action!.id
        })
      )?.state
    ).toBe("declined");
    const durable = await pool.query<{ state: string }>(
      "select state from managed_conversation_text_actions where id=$1",
      [action!.id]
    );
    expect(durable.rows[0]?.state).toBe("declined");
  }, 120_000);

  it("keeps a completed exact Native deletion applied after Undo", async () => {
    const f = await fixture();
    const targetSession = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,
        external_session_id,source_runtime,capture_method,visibility)
       values($1,$2,$3,$4,'codex','api','personal')`,
      [targetSession, f.owner, randomUUID(), `undo-${targetSession}`]
    );
    const action = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-undo",
      toolCallId: "delete-then-undo",
      name: "koed_chat_delete",
      arguments: { sessionId: targetSession }
    });
    expect(action?.reviewKind).toBe("native");
    const manifestHash = "0".repeat(64);
    await pool.query(
      `insert into chat_delete_operations(batch_id,session_id,owner_user_id,
        source_manifest,source_manifest_hash,execution_manifest,execution_set_hash)
       values($1,$2,$3,'[]'::jsonb,$4,'[]'::jsonb,$4)`,
      [action!.id, targetSession, f.owner, manifestHash]
    );
    await pool.query(
      "update sessions set trashed_at=now(),delete_batch_id=$2 where id=$1",
      [targetSession, action!.id]
    );
    await pool.query(
      "update chat_delete_operations set state='complete' where batch_id=$1",
      [action!.id]
    );
    expect(
      (
        await f.actions.reconcileManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: action!.id
        })
      )?.state
    ).toBe("applied");
    await pool.query(
      "update chat_delete_operations set state='restored' where batch_id=$1",
      [action!.id]
    );
    await pool.query(
      "update sessions set trashed_at=null,delete_batch_id=null where id=$1",
      [targetSession]
    );
    expect(
      (
        await f.actions.reconcileManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: action!.id
        })
      )?.state
    ).toBe("applied");
    const durable = await pool.query<{ state: string }>(
      "select state from managed_conversation_text_actions where id=$1",
      [action!.id]
    );
    expect(durable.rows[0]?.state).toBe("applied");
  }, 120_000);

  it("keeps owner Forget authoritative and lets physical execution cleanup cascade action records", async () => {
    const f = await fixture("full_access", true);
    const created = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-forget",
      toolCallId: "create-project",
      name: "koed_project_create",
      arguments: { name: "Independent created Project" }
    });
    const createdClaim = await f.actions.claimManagedTextAction(f.actor, {
      executionId: f.executionId,
      actionId: created!.id,
      expectedRevision: created!.revision
    });
    await f.projects.create(f.owner, {
      name: "Independent created Project",
      folderPath: null,
      idempotencyKey: created!.id,
      textActionId: created!.id
    });
    expect(
      (
        await f.actions.completeManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: created!.id,
          expectedRevision: createdClaim!.revision
        })
      )?.state
    ).toBe("applied");

    const targetSession = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,
        external_session_id,source_runtime,capture_method,visibility)
       values($1,$2,$3,$4,'codex','api','personal')`,
      [targetSession, f.owner, randomUUID(), `forget-native-${targetSession}`]
    );
    const native = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-forget",
      toolCallId: "native-delete",
      name: "koed_chat_delete",
      arguments: { sessionId: targetSession }
    });
    const manifestHash = "0".repeat(64);
    await pool.query(
      `insert into chat_delete_operations(batch_id,session_id,owner_user_id,
        source_manifest,source_manifest_hash,execution_manifest,execution_set_hash)
       values($1,$2,$3,'[]'::jsonb,$4,'[]'::jsonb,$4)`,
      [native!.id, targetSession, f.owner, manifestHash]
    );
    await pool.query(
      "update chat_delete_operations set state='cancelled' where batch_id=$1",
      [native!.id]
    );
    expect(
      (
        await f.actions.reconcileManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: native!.id
        })
      )?.state
    ).toBe("declined");

    const teamBackendId = randomUUID();
    const workspaceProjectId = randomUUID();
    await pool.query(
      `update projects set team_backend_id=$2,workspace_project_id=$3
        where id=$1`,
      [f.project.id, teamBackendId, workspaceProjectId]
    );
    const teamActions = createManagedTextActionRepository(pool, provider, {
      teamAuthority: async () => ({
        teamProjectVersion: 1,
        teamMemberVersion: 1
      })
    });
    const team = await teamActions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-forget",
      toolCallId: "team-todo",
      name: "koed_todo_add",
      arguments: { projectId: f.project.id, title: "Pending Team effect" }
    });
    const teamClaim = await teamActions.claimManagedTextAction(f.actor, {
      executionId: f.executionId,
      actionId: team!.id,
      expectedRevision: team!.revision
    });
    expect(teamClaim?.state).toBe("claimed");
    expect(
      (
        await teamActions.prepareManagedTextTeamTodoAdd(f.actor, {
          executionId: f.executionId,
          actionId: team!.id,
          expectedRevision: teamClaim!.revision
        })
      )?.effectNonce
    ).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const forget = createChatForgetRepository(pool);
    const operation = await forget.beginForgetChat(f.owner, f.sessionId);
    expect(
      await f.actions.listManagedTextActions(f.actor, f.executionId)
    ).toEqual([]);
    expect(
      await f.actions.reconcileManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: native!.id
      })
    ).toBeNull();
    await pool.query(
      `update managed_conversation_executions
         set state='stopped',state_version=state_version+1,stopped_at=now()
       where owner_user_id=$1 and id=$2`,
      [f.owner, f.executionId]
    );
    const stopped = await pool.query<{ state_version: number }>(
      `select state_version from managed_conversation_executions
        where owner_user_id=$1 and id=$2`,
      [f.owner, f.executionId]
    );
    await forget.recordForgetRuntimeAck(
      f.owner,
      f.sessionId,
      operation.batch_id,
      {
        executionId: f.executionId,
        executionGeneration: 1,
        state: "stopped",
        stateVersion: stopped.rows[0]!.state_version
      }
    );
    await forget.completeForgetChat(f.owner, f.sessionId, operation.batch_id);
    expect(
      await f.actions.listManagedTextActions(f.actor, f.executionId)
    ).toEqual([]);

    // Forget is reversible for seven days; physical retention cleanup is a
    // later parent removal. Verify that immutable child rows cannot veto its
    // FK cascade and cannot recreate an action after the parent is gone.
    const removed = await pool.query(
      `delete from managed_conversation_executions
        where owner_user_id=$1 and id=$2 returning id`,
      [f.owner, f.executionId]
    );
    expect(removed.rowCount).toBe(1);
    for (const table of [
      "managed_conversation_text_actions",
      "managed_conversation_text_action_team_nonces",
      "managed_conversation_text_action_create_effects"
    ]) {
      const remaining = await pool.query(
        `select 1 from ${table} where owner_user_id=$1 limit 1`,
        [f.owner]
      );
      expect(remaining.rowCount).toBe(0);
    }
    expect(
      await f.actions.listManagedTextActions(f.actor, f.executionId)
    ).toEqual([]);
  }, 120_000);

  it("permits only an actual origin Session FK cascade while its command remains", async () => {
    const f = await fixture("full_access", true);
    const action = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "origin-cascade",
      toolCallId: "open-chat",
      name: "koed_chat_create",
      arguments: { projectId: f.project.id }
    });
    expect(action?.state).toBe("ready");
    await expect(
      pool.query("delete from managed_conversation_text_actions where id=$1", [
        action!.id
      ])
    ).rejects.toThrow(/directly/);
    // Real lifecycle unbinds the runner before physically removing a Session.
    // Leave the origin command present to exercise the Session FK cascade.
    await pool.query(
      "delete from managed_conversation_runtime_bindings where execution_id=$1",
      [f.executionId]
    );
    await pool.query("delete from sessions where id=$1 and owner_user_id=$2", [
      f.sessionId,
      f.owner
    ]);
    const retainedCommand = await pool.query(
      "select 1 from managed_conversation_commands where id=$1",
      [f.commandId]
    );
    const removedAction = await pool.query(
      "select 1 from managed_conversation_text_actions where id=$1",
      [action!.id]
    );
    expect(retainedCommand.rowCount).toBe(1);
    expect(removedAction.rowCount).toBe(0);
  }, 120_000);

  it("permits exact move-Session and dispatch-command FK cascades but rejects direct receipt deletion", async () => {
    const f = await fixture("full_access");
    const targetSession = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,external_session_id,
        source_runtime,capture_method,visibility)
       values($1,$2,$3,$4,'codex','api','personal')`,
      [targetSession, f.owner, randomUUID(), `cascade-${targetSession}`]
    );
    const move = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "child-cascade",
      toolCallId: "move-child",
      name: "koed_chat_move",
      arguments: { sessionId: targetSession, projectId: f.project.id }
    });
    expect(move?.state).toBe("ready");
    await pool.query(
      `insert into managed_conversation_text_action_move_effects
         (action_id,owner_user_id,session_id,target_project_id,assignment_version)
       values($1,$2,$3,$4,2)`,
      [move!.id, f.owner, targetSession, f.project.id]
    );
    await expect(
      pool.query(
        "delete from managed_conversation_text_action_move_authorities where action_id=$1",
        [move!.id]
      )
    ).rejects.toThrow(/directly/);
    await expect(
      pool.query(
        "delete from managed_conversation_text_action_move_effects where action_id=$1",
        [move!.id]
      )
    ).rejects.toThrow(/directly/);
    await pool.query("delete from sessions where id=$1 and owner_user_id=$2", [
      targetSession,
      f.owner
    ]);
    expect(
      (
        await pool.query(
          "select 1 from managed_conversation_text_action_move_authorities where action_id=$1",
          [move!.id]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (
        await pool.query(
          "select 1 from managed_conversation_text_action_move_effects where action_id=$1",
          [move!.id]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (
        await pool.query(
          "select 1 from managed_conversation_text_actions where id=$1",
          [move!.id]
        )
      ).rowCount
    ).toBe(1);

    const targetCommand = randomUUID();
    await pool.query(
      `insert into managed_conversation_commands
        (id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,
         request_digest,client_user_message_id,execution_generation,state,encrypted_payload)
       values($1,$2,$3,$4,99,'prompt',$5,$6,1,'completed','{}'::jsonb)`,
      [
        targetCommand,
        f.owner,
        f.executionId,
        randomUUID(),
        "0".repeat(64),
        randomUUID()
      ]
    );
    await pool.query(
      `insert into managed_conversation_text_action_dispatch_effects
         (action_id,owner_user_id,project_id,work_item_id,agent_id,
          work_item_version,execution_id,command_id)
       values($1,$2,$3,$4,$5,1,$6,$7)`,
      [
        move!.id,
        f.owner,
        f.project.id,
        randomUUID(),
        randomUUID(),
        f.executionId,
        targetCommand
      ]
    );
    await expect(
      pool.query(
        "delete from managed_conversation_text_action_dispatch_effects where action_id=$1",
        [move!.id]
      )
    ).rejects.toThrow(/directly/);
    await pool.query("delete from managed_conversation_commands where id=$1", [
      targetCommand
    ]);
    expect(
      (
        await pool.query(
          "select 1 from managed_conversation_text_action_dispatch_effects where action_id=$1",
          [move!.id]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (
        await pool.query(
          "select 1 from managed_conversation_text_actions where id=$1",
          [move!.id]
        )
      ).rowCount
    ).toBe(1);
  }, 120_000);

  it("binds a shared-source move to its exact reviewed journal batch", async () => {
    const f = await fixture("full_access");
    const source = await f.projects.create(f.owner, {
      name: "Shared source",
      folderPath: null,
      idempotencyKey: randomUUID()
    });
    const target = await f.projects.create(f.owner, {
      name: "Private target",
      folderPath: null,
      idempotencyKey: randomUUID()
    });
    const teamBackendId = randomUUID(),
      teamWorkspaceId = randomUUID();
    const workspaceProjectId = randomUUID(),
      movedSession = randomUUID();
    await pool.query(
      `update projects set team_backend_id=$2,team_workspace_id=$3,
         workspace_project_id=$4 where id=$1`,
      [source.id, teamBackendId, teamWorkspaceId, workspaceProjectId]
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,
         external_session_id,source_runtime,capture_method,visibility,
         automatic_personal_project_id,metadata)
       values($1,$2,$3,$4,'codex','api','personal',$5,$6::jsonb)`,
      [
        movedSession,
        f.owner,
        randomUUID(),
        `shared-${movedSession}`,
        source.id,
        JSON.stringify({ threadName: "Shared design chat" })
      ]
    );
    await pool.query(
      `insert into project_policy_session_grants(owner_user_id,session_id,
         project_id,backend_id,logical_memory_id,team_id,team_workspace_id,
         share_grant_id,policy_generation,mapping_version,grant_version)
       values($1,$2,$3,$4,$5,$6,$7,$8,1,1,1)`,
      [
        f.owner,
        movedSession,
        source.id,
        teamBackendId,
        randomUUID(),
        randomUUID(),
        teamWorkspaceId,
        randomUUID()
      ]
    );
    const action = await f.actions.enqueueManagedTextAction(f.actor, {
      executionId: f.executionId,
      commandId: f.commandId,
      leaseToken: f.leaseToken,
      executionGeneration: 1,
      providerTurnId: "turn-shared-move",
      toolCallId: "shared-move",
      name: "koed_chat_move",
      arguments: { sessionId: movedSession, projectId: target.id }
    });
    expect(action?.snapshot).toMatchObject({
      chatTitle: "Shared design chat",
      sourceProjectName: "Shared source",
      projectName: "Private target",
      sourceWorkspaceProjectId: workspaceProjectId
    });
    const claimed = await f.actions.claimManagedTextAction(f.actor, {
      executionId: f.executionId,
      actionId: action!.id,
      expectedRevision: action!.revision
    });
    expect(claimed?.state).toBe("claimed");
    const journal = createChatMoveRepository(pool, {
      textActionEncryptionProvider: provider
    });
    const pending = await journal.prepare(
      f.owner,
      movedSession,
      source.id,
      target.id,
      action!.id
    );
    expect(pending?.textActionId).toBe(action!.id);
    expect(
      (await journal.getByTextAction(f.owner, movedSession, action!.id))
        ?.batchId
    ).toBe(pending?.batchId);
    expect(
      await journal.getByTextAction(randomUUID(), movedSession, action!.id)
    ).toBeNull();
    expect(
      await journal.getByTextAction(f.owner, movedSession, randomUUID())
    ).toBeNull();
    await expect(
      journal.prepare(f.owner, movedSession, source.id, target.id, randomUUID())
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
    await expect(
      journal.complete(f.owner, movedSession, pending!.batchId)
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
    expect(
      (
        await pool.query(
          `select 1 from managed_conversation_text_action_move_effects
          where owner_user_id=$1 and action_id=$2`,
          [f.owner, action!.id]
        )
      ).rowCount
    ).toBe(0);
    expect(
      await f.actions.completeManagedTextAction(f.actor, {
        executionId: f.executionId,
        actionId: action!.id,
        expectedRevision: claimed!.revision
      })
    ).toBeNull();
    const ack = await journal.reserve(
      f.owner,
      movedSession,
      pending!.batchId,
      pending!.bindings[0]!.id,
      1
    );
    await journal.ack(f.owner, movedSession, pending!.batchId, {
      ...ack,
      state: "resolved"
    });
    expect(
      await journal.complete(f.owner, movedSession, pending!.batchId)
    ).toBe(target.id);
    const effect = await pool.query<{ move_batch_id: string }>(
      `select move_batch_id from managed_conversation_text_action_move_effects
        where owner_user_id=$1 and action_id=$2 and session_id=$3`,
      [f.owner, action!.id, movedSession]
    );
    expect(effect.rows[0]?.move_batch_id).toBe(pending!.batchId);
    expect(
      (
        await f.actions.completeManagedTextAction(f.actor, {
          executionId: f.executionId,
          actionId: action!.id,
          expectedRevision: claimed!.revision
        })
      )?.state
    ).toBe("applied");
  }, 120_000);
});
