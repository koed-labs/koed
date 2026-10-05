import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  decryptEnvelopeToUtf8,
  type EncryptedPayloadEnvelope
} from "@koed/shared";

import { createManagedConversationRepository } from "./managed-conversation-repository.js";

describe("managed Conversation recovery lookup", () => {
  it("returns absent from an owner, kind, and prompt identity scoped query", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = createManagedConversationRepository(
      { query } as unknown as pg.Pool,
      {}
    );
    const identity = {
      commandKind: "prompt" as const,
      idempotencyKey: "prompt:stable-key",
      clientUserMessageId: "0ebcc84e-1028-493b-8c54-e41f61f76818",
      executionId: "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa",
      executionGeneration: 4
    };

    await expect(
      repository.getManagedConversationCommandByRecoveryIdentity(
        { userId: "owner-user-id" },
        identity
      )
    ).resolves.toBeNull();

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("command.owner_user_id = $1"),
      [
        "owner-user-id",
        identity.idempotencyKey,
        "prompt",
        identity.clientUserMessageId,
        identity.executionId,
        identity.executionGeneration
      ]
    );
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("command.idempotency_key = $2");
    expect(sql).toContain("command.command_kind = $3");
    expect(sql).toContain("command.client_user_message_id = $4");
    expect(sql).toContain("command.execution_id = $5");
    expect(sql).toContain("command.execution_generation = $6");
  });

  it("checks indeterminate prompts by owner, execution, and generation only", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] });
    const repository = createManagedConversationRepository(
      { query } as unknown as pg.Pool,
      {}
    );

    await expect(
      repository.hasIndeterminateManagedConversationPrompt(
        { userId: "owner-user-id" },
        {
          executionId: "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa",
          executionGeneration: 4
        }
      )
    ).resolves.toBe(true);
    await expect(
      repository.hasIndeterminateManagedConversationPrompt(
        { userId: "other-user-id" },
        {
          executionId: "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa",
          executionGeneration: 3
        }
      )
    ).resolves.toBe(false);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("owner_user_id = $1"),
      ["owner-user-id", "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa", 4]
    );
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("execution_id = $2");
    expect(sql).toContain("execution_generation = $3");
    expect(sql).toContain("command_kind = 'prompt'");
    expect(sql).toContain("state = 'indeterminate'");
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("owner_user_id = $1"),
      ["other-user-id", "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa", 3]
    );
  });
});

describe("managed Conversation clean stopped continuation", () => {
  const ownerUserId = "11111111-1111-4111-8111-111111111111";
  const executionId = "66666666-6666-4666-8666-666666666666";
  const executionGeneration = 2;
  const clientUserMessageId = "44444444-4444-4444-8444-444444444444";
  const now = new Date("2026-10-01T00:00:00.000Z");

  const repositoryFor = (
    options: {
      state?: string;
      projectId?: string | null;
      binding?: Record<string, unknown> | null;
      unsettled?: boolean;
    } = {}
  ) => {
    const execution = {
      id: executionId,
      owner_user_id: ownerUserId,
      project_id: Object.hasOwn(options, "projectId")
        ? options.projectId
        : "lp_0123456789abcdef0123456789abcdef",
      provider: "codex",
      ai_client_instance_id: "codex.default",
      model: "gpt-test",
      reasoning_effort: "low",
      permission_mode: "supervised",
      runner_kind: "local_device",
      state: options.state ?? "stopped",
      state_version: 5,
      execution_generation: executionGeneration,
      runner_deployment_id: "77777777-7777-4777-8777-777777777777",
      runner_device_id: "88888888-8888-4888-8888-888888888888",
      runner_id: null,
      runner_lease_expires_at: null,
      logical_session_id: "logical-session-id",
      provider_thread_id: "provider-thread-id",
      provider_cli_version: "codex-test",
      source_generation_id: null,
      last_error_code: null,
      created_at: now,
      updated_at: now,
      started_at: now,
      quiesced_at: null,
      stopped_at: now
    };
    const binding = Object.hasOwn(options, "binding")
      ? options.binding
      : {
          execution_id: executionId,
          owner_user_id: ownerUserId,
          deployment_id: execution.runner_deployment_id,
          device_id: execution.runner_device_id,
          execution_generation: executionGeneration,
          checkout_id: "99999999-9999-4999-8999-999999999999",
          local_session_id: "local-session-id",
          provider_thread_id: "provider-thread-id",
          transcript_path: "/managed/transcript.jsonl",
          managed_home: "/managed/home",
          checkout_lifecycle: "ready",
          cleanup_state: "not_requested"
        };
    const commands: Array<Record<string, unknown>> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("update managed_conversation_executions")) {
        execution.state = "running";
        execution.state_version += 1;
        execution.stopped_at = null;
        return { rows: [{ ...execution }] };
      }
      if (sql.includes("from managed_conversation_executions")) {
        return { rows: [{ ...execution }] };
      }
      if (sql.includes("managed_conversation_project_moves")) {
        return { rows: [] };
      }
      if (sql.includes("from managed_conversation_runtime_bindings")) {
        return { rows: binding ? [binding] : [] };
      }
      if (
        sql.includes("select id") &&
        sql.includes("state not in ('completed', 'failed', 'canceled')")
      ) {
        return { rows: options.unsettled ? [{ id: "unsettled-command" }] : [] };
      }
      if (
        sql.includes("update managed_conversation_commands") &&
        sql.includes("set allow_archived_resume = true")
      ) {
        const command = commands.find((item) => item.id === params[1]);
        if (!command) return { rows: [] };
        command.allow_archived_resume = true;
        return { rows: [command] };
      }
      if (
        sql.includes("from managed_conversation_commands") &&
        sql.includes("idempotency_key = $2")
      ) {
        return {
          rows: commands.filter(
            (command) => command.idempotency_key === params[1]
          )
        };
      }
      if (sql.includes("select coalesce(max(sequence)")) {
        return { rows: [{ sequence: commands.length }] };
      }
      if (sql.includes("insert into managed_conversation_commands")) {
        const command = {
          id: params[0],
          owner_user_id: params[1],
          execution_id: params[2],
          idempotency_key: params[3],
          sequence: params[4],
          command_kind: "prompt",
          target_deployment_id: null,
          target_device_id: null,
          request_digest: params[5],
          client_user_message_id: params[6],
          execution_generation: params[7],
          allow_archived_resume: params[8],
          encrypted_payload: params[9],
          state: "queued",
          attempts: 0,
          lease_token: null,
          lease_expires_at: null,
          result: null,
          blocked_on_kind: null,
          blocked_on_id: null,
          last_error_code: null,
          created_at: now,
          updated_at: now,
          dispatching_at: null,
          completed_at: null
        };
        commands.push(command);
        return { rows: [command] };
      }
      if (sql.includes("insert into collaboration_outbox")) {
        return {
          rows: [
            {
              id: "99999999-9999-4999-8999-999999999999",
              cursor: "1",
              protocol_version: 1,
              family: "managed_conversation_changed",
              scope: "personal",
              personal_owner_user_id: ownerUserId,
              team_id: null,
              team_workspace_id: null,
              thread_id: null,
              message_id: null,
              share_grant_id: null,
              logical_memory_id: null,
              resource_type: "managed_conversation_execution",
              resource_id: executionId,
              actor_principal_id: ownerUserId,
              mutation_id: params[13],
              occurred_at: now
            }
          ]
        };
      }
      return { rows: [] };
    });
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 9).toString("base64")
    );
    const repository = createManagedConversationRepository(
      {
        connect: vi.fn(async () => ({ query, release: vi.fn() }))
      } as unknown as pg.Pool,
      { envelopeEncryptionProvider: provider }
    );
    return { repository, query, execution, commands };
  };

  const promptInput = {
    executionId,
    executionGeneration,
    resumeFromStopped: true as const,
    idempotencyKey: "stopped-prompt-request",
    clientUserMessageId,
    prompt: "Continue this managed Conversation",
    personalMemoryContext: {
      schemaVersion: 1 as const,
      status: "skipped" as const,
      attributionNonce: "55555555-5555-4555-8555-555555555555",
      searchDomain: "global" as const,
      projectId: "lp_0123456789abcdef0123456789abcdef",
      evidence: []
    }
  };

  it("resumes the bound provider thread atomically and replays the same prompt idempotently", async () => {
    const { repository, query, execution, commands } = repositoryFor();
    const first = await repository.enqueueManagedConversationPrompt(
      { userId: ownerUserId },
      promptInput
    );
    expect(execution.state).toBe("running");
    execution.state = "stopped";
    execution.state_version += 1;
    commands[0]!.allow_archived_resume = false;
    const replay = await repository.enqueueManagedConversationPrompt(
      { userId: ownerUserId },
      promptInput
    );

    expect(execution.state).toBe("stopped");
    expect(first.id).toBe(replay.id);
    expect(first.allowArchivedResume).toBe(true);
    expect(replay.allowArchivedResume).toBe(true);
    expect(commands).toHaveLength(1);
    expect(first.payload).toMatchObject({ prompt: promptInput.prompt });
    expect(replay.payload).toMatchObject({ prompt: promptInput.prompt });
    expect(first.payload).not.toHaveProperty("resumeFromStopped");
    expect(
      query.mock.calls.filter(([sql]) =>
        (sql as string).includes("set state = 'running'")
      )
    ).toHaveLength(1);
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes("execution_generation = $3")
      )
    ).toBe(true);
  });

  it("fails closed when the existing provider history is absent", async () => {
    const { repository, query } = repositoryFor({ binding: null });

    await expect(
      repository.enqueueManagedConversationPrompt(
        { userId: ownerUserId },
        promptInput
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes("set state = 'running'")
      )
    ).toBe(false);
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it("does not resume while an operation has an unresolved outcome", async () => {
    const { repository, query } = repositoryFor({ unsettled: true });

    await expect(
      repository.enqueueManagedConversationPrompt(
        { userId: ownerUserId },
        promptInput
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes("set state = 'running'")
      )
    ).toBe(false);
  });

  it("allows a pending checkout lifecycle for an independent conversation", async () => {
    const { repository, execution } = repositoryFor({
      projectId: null,
      binding: {
        execution_id: executionId,
        owner_user_id: ownerUserId,
        deployment_id: "77777777-7777-4777-8777-777777777777",
        device_id: "88888888-8888-4888-8888-888888888888",
        execution_generation: executionGeneration,
        checkout_id: null,
        local_session_id: "local-session-id",
        provider_thread_id: "provider-thread-id",
        transcript_path: "/managed/transcript.jsonl",
        managed_home: "/managed/home",
        checkout_lifecycle: "pending",
        cleanup_state: "not_requested"
      }
    });

    await repository.enqueueManagedConversationPrompt(
      { userId: ownerUserId },
      {
        ...promptInput,
        personalMemoryContext: {
          ...promptInput.personalMemoryContext,
          projectId: null
        }
      }
    );
    expect(execution.state).toBe("running");
  });

  it("does not resume a Project execution with a pending checkout", async () => {
    const { repository, query } = repositoryFor({
      binding: {
        execution_id: executionId,
        owner_user_id: ownerUserId,
        deployment_id: "77777777-7777-4777-8777-777777777777",
        device_id: "88888888-8888-4888-8888-888888888888",
        execution_generation: executionGeneration,
        checkout_id: null,
        local_session_id: "local-session-id",
        provider_thread_id: "provider-thread-id",
        transcript_path: "/managed/transcript.jsonl",
        managed_home: "/managed/home",
        checkout_lifecycle: "pending",
        cleanup_state: "not_requested"
      }
    });

    await expect(
      repository.enqueueManagedConversationPrompt(
        { userId: ownerUserId },
        promptInput
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes("set state = 'running'")
      )
    ).toBe(false);
  });

  it("does not resume a binding whose checkout cleanup has started", async () => {
    const { repository, query } = repositoryFor({
      binding: {
        execution_id: executionId,
        owner_user_id: ownerUserId,
        deployment_id: "77777777-7777-4777-8777-777777777777",
        device_id: "88888888-8888-4888-8888-888888888888",
        execution_generation: executionGeneration,
        local_session_id: "local-session-id",
        provider_thread_id: "provider-thread-id",
        transcript_path: "/managed/transcript.jsonl",
        managed_home: "/managed/home",
        checkout_lifecycle: "cleanup_requested",
        cleanup_state: "requested"
      }
    });

    await expect(
      repository.enqueueManagedConversationPrompt(
        { userId: ownerUserId },
        promptInput
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes("set state = 'running'")
      )
    ).toBe(false);
  });

  it.each(["failed", "fenced"])(
    "does not resume a %s execution",
    async (state) => {
      const { repository, query } = repositoryFor({ state });

      await expect(
        repository.enqueueManagedConversationPrompt(
          { userId: ownerUserId },
          promptInput
        )
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(query).toHaveBeenCalledWith("rollback");
      expect(
        query.mock.calls.some(([sql]) =>
          (sql as string).includes("set state = 'running'")
        )
      ).toBe(false);
    }
  );
});

describe("managed Conversation prompt cancellation", () => {
  const ownerUserId = "owner-user-id";
  const executionId = "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa";
  const commandId = "5224b37d-08b3-48f4-84d7-c4ba29ff63f7";
  const executionGeneration = 4;

  const repositoryFor = (initial: {
    state: string;
    attempts: number;
    result?: Record<string, unknown>;
    claimWinsDuringCancel?: boolean;
  }) => {
    const command = {
      id: commandId,
      state: initial.state,
      attempts: initial.attempts,
      result: initial.result
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("update managed_conversation_commands")) {
        if (initial.claimWinsDuringCancel) {
          command.state = "dispatching";
          command.attempts += 1;
        }
        if (command.state === "queued" && command.attempts === 0) {
          command.state = "canceled";
          return { rows: [{ id: commandId, state: "canceled" }] };
        }
        return { rows: [] };
      }
      if (
        sql.includes("select id, state") &&
        sql.includes("managed_conversation_commands")
      ) {
        return { rows: [{ id: command.id, state: command.state }] };
      }
      return { rows: [] };
    });
    const repository = createManagedConversationRepository(
      {
        connect: vi.fn(async () => ({ query, release: vi.fn() }))
      } as unknown as pg.Pool,
      {}
    );
    return { repository, query, command };
  };

  it("does not cancel a queued prompt already claimed for checkpoint recovery", async () => {
    const checkpoint = {
      phase: "checkpoint_pending",
      providerTurnId: "provider-turn-id",
      sourceGenerationId: "source-generation-id"
    };
    const { repository, query, command } = repositoryFor({
      state: "queued",
      attempts: 1,
      result: checkpoint
    });

    await expect(
      repository.cancelManagedConversationPrompt(
        { userId: ownerUserId },
        { executionId, commandId, executionGeneration }
      )
    ).resolves.toEqual({ id: commandId, state: "queued" });

    const cancelSql = query.mock.calls.find(([sql]) =>
      sql.includes("update managed_conversation_commands")
    )?.[0];
    expect(cancelSql).toContain("and attempts = 0");
    expect(command).toMatchObject({
      state: "queued",
      attempts: 1,
      result: checkpoint
    });
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes("update personal_agent_execution_jobs")
      )
    ).toBe(false);
  });

  it("cancels a queued prompt that has never been claimed", async () => {
    const { repository, query, command } = repositoryFor({
      state: "queued",
      attempts: 0
    });

    await expect(
      repository.cancelManagedConversationPrompt(
        { userId: ownerUserId },
        { executionId, commandId, executionGeneration }
      )
    ).resolves.toEqual({ id: commandId, state: "canceled" });

    expect(command).toMatchObject({ state: "canceled", attempts: 0 });
    expect(query.mock.calls.some(([sql]) => sql.includes("pg_notify"))).toBe(
      true
    );
  });

  it("returns the persisted dispatching state when a runner claim wins the race", async () => {
    const { repository, query, command } = repositoryFor({
      state: "queued",
      attempts: 0,
      claimWinsDuringCancel: true
    });

    await expect(
      repository.cancelManagedConversationPrompt(
        { userId: ownerUserId },
        { executionId, commandId, executionGeneration }
      )
    ).resolves.toEqual({ id: commandId, state: "dispatching" });

    expect(command).toMatchObject({ state: "dispatching", attempts: 1 });
    expect(query.mock.calls.some(([sql]) => sql.includes("pg_notify"))).toBe(
      false
    );
  });
});

describe("managed Agent signal command fencing", () => {
  it("rejects a stale callback after the same runner reclaimed the command", async () => {
    const ownerUserId = "4fe5d99e-f13d-4269-b66d-80e7f99bcaf0";
    const executionId = "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa";
    const commandId = "5224b37d-08b3-48f4-84d7-c4ba29ff63f7";
    const deviceId = "b118b2ac-652e-4084-bf0c-d8d6f63fafb2";
    const deploymentId = "7c25f5d9-bdef-4bc7-a05d-d88d2eac027a";
    const currentLeaseToken = "a9678f28-e7b8-459f-9ea1-a93045e384e3";
    const staleLeaseToken = "e3717fb4-7bb3-4793-a449-43f1ab7a2cb5";
    const runnerId = "runner-one";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from managed_conversation_commands")) {
        return {
          rows: [
            {
              id: commandId,
              execution_id: executionId,
              command_kind: "prompt",
              state: "dispatching",
              execution_generation: 3,
              lease_token: currentLeaseToken,
              lease_expires_at: new Date(Date.now() + 60_000)
            }
          ]
        };
      }
      if (sql.includes("from managed_conversation_executions")) {
        return {
          rows: [
            {
              id: executionId,
              owner_user_id: ownerUserId,
              execution_generation: 3,
              state: "running",
              runner_id: runnerId,
              runner_device_id: deviceId,
              runner_deployment_id: deploymentId
            }
          ]
        };
      }
      return { rows: [] };
    });
    const repository = createManagedConversationRepository(
      {
        connect: vi.fn(async () => ({ query, release: vi.fn() }))
      } as unknown as pg.Pool,
      {}
    );

    await expect(
      repository.recordPersonalAgentIntentForManagedCommand(
        { userId: ownerUserId },
        {
          commandId,
          executionId,
          executionGeneration: 3,
          leaseToken: staleLeaseToken,
          runnerId,
          deviceId,
          deploymentId,
          providerTurnId: "codex-turn-from-old-claim",
          intent: { kind: "assign", goal: "Modify a file" }
        }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it("rejects a phase signal when its unchanged command token has expired", async () => {
    const ownerUserId = "4fe5d99e-f13d-4269-b66d-80e7f99bcaf0";
    const executionId = "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa";
    const commandId = "5224b37d-08b3-48f4-84d7-c4ba29ff63f7";
    const deviceId = "b118b2ac-652e-4084-bf0c-d8d6f63fafb2";
    const deploymentId = "7c25f5d9-bdef-4bc7-a05d-d88d2eac027a";
    const leaseToken = "a9678f28-e7b8-459f-9ea1-a93045e384e3";
    const runnerId = "runner-one";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from managed_conversation_commands")) {
        return {
          rows: [
            {
              id: commandId,
              execution_id: executionId,
              command_kind: "prompt",
              state: "dispatching",
              execution_generation: 3,
              lease_token: leaseToken,
              lease_expires_at: new Date(Date.now() - 1)
            }
          ]
        };
      }
      if (sql.includes("from managed_conversation_executions")) {
        return {
          rows: [
            {
              id: executionId,
              owner_user_id: ownerUserId,
              execution_generation: 3,
              state: "running",
              runner_id: runnerId,
              runner_device_id: deviceId,
              runner_deployment_id: deploymentId,
              runner_lease_expires_at: new Date(Date.now() + 60_000)
            }
          ]
        };
      }
      return { rows: [] };
    });
    const repository = createManagedConversationRepository(
      {
        connect: vi.fn(async () => ({ query, release: vi.fn() }))
      } as unknown as pg.Pool,
      {}
    );

    await expect(
      repository.recordPersonalAgentPhaseForManagedCommand(
        { userId: ownerUserId },
        {
          commandId,
          executionId,
          executionGeneration: 3,
          leaseToken,
          runnerId,
          deviceId,
          deploymentId,
          providerTurnId: "codex-current-provider-turn",
          attemptId: "67479cab-82d3-42ed-b026-2f0364874dc1",
          phase: "checking"
        }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(query).toHaveBeenCalledWith("rollback");
    expect(
      query.mock.calls.some(([sql]) =>
        (sql as string).includes("personal_agent_execution_attempts")
      )
    ).toBe(false);
  });
});

describe("managed Conversation initial Agent start", () => {
  it("keeps private planning unassigned in the encrypted start command and replay", async () => {
    const ownerUserId = "11111111-1111-4111-8111-111111111111";
    const agentId = "22222222-2222-4222-8222-222222222222";
    const identityVersionId = "33333333-3333-4333-8333-333333333333";
    const clientMessageId = "44444444-4444-4444-8444-444444444444";
    const projectId = "lp_0123456789abcdef0123456789abcdef";
    const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const now = new Date("2026-09-30T00:00:00.000Z");
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 9).toString("base64")
    );
    const memoryContext = {
      schemaVersion: 1,
      status: "skipped",
      attributionNonce: "55555555-5555-4555-8555-555555555555",
      searchDomain: "global",
      projectId,
      evidence: []
    };
    const agentContext = {
      schemaVersion: 1,
      identity: {
        agentId,
        version: 4,
        identityVersionId,
        name: "Mira",
        role: "Reviewer",
        soulInstructions: "Be precise."
      },
      project: { projectId, name: "Shared project" },
      memory: { searchDomain: "global", evidence: [] }
    };
    const executionRow = {
      id: "66666666-6666-4666-8666-666666666666",
      owner_user_id: ownerUserId,
      project_id: projectId,
      provider: "codex",
      ai_client_instance_id: "codex.default",
      model: "gpt-test",
      reasoning_effort: "low",
      permission_mode: "supervised",
      runner_kind: "local_device",
      state: "starting",
      state_version: 1,
      execution_generation: 1,
      runner_deployment_id: "77777777-7777-4777-8777-777777777777",
      runner_device_id: "88888888-8888-4888-8888-888888888888",
      runner_id: null,
      runner_lease_expires_at: null,
      logical_session_id: null,
      provider_thread_id: null,
      provider_cli_version: null,
      source_generation_id: null,
      last_error_code: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      quiesced_at: null,
      stopped_at: null
    };
    let startCommandRow: Record<string, unknown> | null = null;
    const jobInsertCalls: Array<unknown[]> = [];
    const outboxRow = {
      id: "99999999-9999-4999-8999-999999999999",
      cursor: "1",
      protocol_version: 1,
      family: "managed_conversation_changed",
      scope: "personal",
      personal_owner_user_id: ownerUserId,
      team_id: null,
      team_workspace_id: null,
      thread_id: null,
      message_id: null,
      share_grant_id: null,
      logical_memory_id: null,
      resource_type: "managed_conversation_execution",
      resource_id: executionRow.id,
      actor_principal_id: ownerUserId,
      mutation_id: "managed-conversation-created",
      occurred_at: now
    };
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (
        sql.includes("from managed_conversation_commands") &&
        sql.includes("idempotency_key = $2")
      ) {
        return { rows: startCommandRow ? [startCommandRow] : [] };
      }
      if (
        sql.includes("from managed_conversation_executions") &&
        sql.includes("where owner_user_id = $1 and id = $2")
      ) {
        return { rows: [executionRow] };
      }
      if (sql.includes("insert into managed_conversation_executions")) {
        executionRow.id = params[0] as string;
        executionRow.project_id = params[2] as string | null;
        return { rows: [executionRow] };
      }
      if (sql.includes("from personal_agent_identities")) {
        return { rows: [{ current_version: 4, lifecycle: "active" }] };
      }
      if (sql.includes("from personal_agent_identity_versions")) {
        return { rows: [{ id: identityVersionId }] };
      }
      if (sql.includes("from personal_agent_conversations")) {
        return { rows: [{ owner_user_id: ownerUserId }] };
      }
      if (sql.includes("insert into managed_conversation_commands")) {
        const encryptedPayload = params[5] as EncryptedPayloadEnvelope;
        startCommandRow = {
          id: params[0],
          owner_user_id: params[1],
          execution_id: params[2],
          idempotency_key: params[3],
          sequence: 0,
          command_kind: "start",
          target_deployment_id: null,
          target_device_id: null,
          request_digest: params[4],
          client_user_message_id: null,
          execution_generation: 1,
          encrypted_payload: encryptedPayload,
          state: params[6],
          attempts: 0,
          lease_token: null,
          lease_expires_at: null,
          result: null,
          blocked_on_kind: "runtime_binding",
          blocked_on_id: executionRow.id,
          last_error_code: null,
          created_at: now,
          updated_at: now,
          dispatching_at: null,
          completed_at: null
        };
        return { rows: [startCommandRow] };
      }
      if (sql.includes("insert into personal_agent_execution_jobs")) {
        jobInsertCalls.push(params);
      }
      if (sql.includes("insert into collaboration_outbox")) {
        return { rows: [outboxRow] };
      }
      return { rows: [] };
    });
    const poolClient = { query, release: vi.fn() };
    const bindReview = vi.fn(
      async (client: pg.PoolClient, boundExecutionId: string) => {
        expect(client).toBe(poolClient);
        expect(boundExecutionId).toBe(executionRow.id);
        expect(startCommandRow).toBeNull();
        return {
          requestId,
          teamId,
          teamProjectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          ownerUserId,
          agentId,
          agentVersion: 4,
          localProjectId: projectId,
          privateGoal: "Ship the small fix."
        };
      }
    );
    const repository = createManagedConversationRepository(
      {
        connect: vi.fn(async () => poolClient)
      } as unknown as pg.Pool,
      { envelopeEncryptionProvider: provider }
    );
    const input = {
      projectId,
      contextKind: "project" as const,
      provider: "codex",
      aiClientInstanceId: "codex.default",
      model: "gpt-test",
      reasoningEffort: "low",
      permissionMode: "supervised" as const,
      runnerKind: "local_device" as const,
      runnerDeploymentId: executionRow.runner_deployment_id,
      runnerDeviceId: executionRow.runner_device_id,
      idempotencyKey: "agent-start-replay-key",
      initialPrompt: "Ship the small fix.",
      initialPromptClientUserMessageId: clientMessageId,
      initialPersonalMemoryContext: memoryContext,
      initialAgentId: agentId,
      initialExpectedAgentVersion: 4,
      initialPersonalAgentContext: agentContext,
      initialTeamAgentRequest: {
        teamId,
        requestId,
        expectedRequestVersion: 2,
        expectedReviewVersion: 3
      },
      bindInitialTeamAgentRequestWithClient: bindReview,
      deferUntilRuntimeBinding: true
    };

    const first = await repository.createManagedConversation(
      { userId: ownerUserId },
      input
    );
    const replay = await repository.createManagedConversation(
      { userId: ownerUserId },
      input
    );

    expect(first.execution.id).toBe(executionRow.id);
    expect(replay.command.id).toBe(first.command.id);
    expect(first.command.commandKind).toBe("start");
    const encryptedStartPayload =
      startCommandRow?.encrypted_payload as EncryptedPayloadEnvelope;
    const decodedStartPayload = JSON.parse(
      await decryptEnvelopeToUtf8(provider, encryptedStartPayload)
    ) as Record<string, unknown>;
    expect(decodedStartPayload).toMatchObject({
      prompt: "Ship the small fix.",
      continueWithoutMemory: true,
      personalAgent: {
        jobId: null,
        agentId,
        agentVersion: 4,
        identityVersionId
      },
      personalAgentContext: { ...agentContext, pendingTeamRequestId: requestId }
    });
    expect(jobInsertCalls).toHaveLength(0);
    expect(bindReview).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.filter(([sql]) =>
        sql.includes("insert into managed_conversation_commands")
      )
    ).toHaveLength(1);

    // Native Studio starts a private Team review without a prompt; the
    // transaction still binds the reviewed Agent before returning the
    // execution so the next ordinary prompt cannot escape as an unassigned
    // conversation.
    startCommandRow = null;
    const nativeStart = await repository.createManagedConversation(
      { userId: ownerUserId },
      {
        ...input,
        idempotencyKey: "native-team-review-start",
        initialPrompt: undefined,
        initialPromptClientUserMessageId: undefined,
        initialPersonalMemoryContext: undefined,
        initialAgentId: undefined,
        initialExpectedAgentVersion: undefined,
        initialPersonalAgentContext: undefined
      }
    );
    expect(nativeStart.execution.id).toBe(executionRow.id);
    expect(nativeStart.command.payload).toBeNull();
    expect(bindReview).toHaveBeenCalledTimes(2);
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          sql.includes("insert into personal_agent_conversations") &&
          params[0] === nativeStart.execution.id &&
          params[2] === agentId
      )
    ).toBe(true);
    expect(jobInsertCalls).toHaveLength(0);
  });
});

describe("managed Agent Job Public Square publication", () => {
  it("publishes a new Job in the same transaction through current authorized project links", async () => {
    const ownerUserId = "4fe5d99e-f13d-4269-b66d-80e7f99bcaf0";
    const executionId = "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa";
    const commandId = "5224b37d-08b3-48f4-84d7-c4ba29ff63f7";
    const agentId = "44444444-4444-4444-8444-444444444444";
    const identityVersionId = "55555555-5555-4555-8555-555555555555";
    const deviceId = "b118b2ac-652e-4084-bf0c-d8d6f63fafb2";
    const deploymentId = "7c25f5d9-bdef-4bc7-a05d-d88d2eac027a";
    const leaseToken = "a9678f28-e7b8-459f-9ea1-a93045e384e3";
    const runnerId = "runner-one";
    const projectId = "project:registered-here";
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 37).toString("base64")
    );
    const payload = {
      prompt: "Review this pull request.",
      personalAgent: {
        jobId: null,
        agentId,
        agentVersion: 1,
        identityVersionId
      },
      personalAgentContext: {
        schemaVersion: 1,
        identity: {
          agentId,
          version: 1,
          identityVersionId,
          name: "Reviewer",
          role: "Review pull requests",
          soulInstructions: "Find concrete risks."
        },
        project: { projectId, name: "Project" },
        activeJob: null,
        pendingTeamRequestId: null,
        memory: { searchDomain: "project", evidence: [] }
      }
    };
    const encryptedPayload = await provider.encrypt({
      plaintext: JSON.stringify(payload),
      scope: {
        tenantId: ownerUserId,
        objectClass: "managed_conversation_prompt"
      },
      provenance: {
        rowFamily: "managed_conversation_commands",
        sourceId: commandId
      },
      ciphertextLocation: "managed_conversation_commands.encrypted_payload",
      aad: { ownerUserId, executionId, commandId }
    });
    const now = new Date();
    const commandRow = {
      id: commandId,
      owner_user_id: ownerUserId,
      execution_id: executionId,
      command_kind: "prompt",
      state: "dispatching",
      execution_generation: 3,
      lease_token: leaseToken,
      lease_expires_at: new Date(Date.now() + 60_000),
      encrypted_payload: encryptedPayload
    };
    const executionRow = {
      id: executionId,
      owner_user_id: ownerUserId,
      project_id: projectId,
      execution_generation: 3,
      state: "running",
      runner_id: runnerId,
      runner_device_id: deviceId,
      runner_deployment_id: deploymentId
    };
    const outboxRow = {
      id: "99999999-9999-4999-8999-999999999999",
      cursor: "1",
      protocol_version: 1,
      family: "managed_conversation_changed",
      scope: "personal",
      personal_owner_user_id: ownerUserId,
      team_id: null,
      team_workspace_id: null,
      thread_id: null,
      message_id: null,
      share_grant_id: null,
      logical_memory_id: null,
      resource_type: "managed_conversation_execution",
      resource_id: executionId,
      actor_principal_id: ownerUserId,
      mutation_id: "managed-agent-intent-test",
      occurred_at: now
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from managed_conversation_commands")) {
        return { rows: [commandRow] };
      }
      if (sql.includes("from managed_conversation_executions")) {
        return { rows: [executionRow] };
      }
      if (sql.includes("insert into collaboration_outbox")) {
        return { rows: [outboxRow] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const repository = createManagedConversationRepository(
      { connect: vi.fn(async () => client) } as unknown as pg.Pool,
      { envelopeEncryptionProvider: provider }
    );

    await repository.recordPersonalAgentIntentForManagedCommand(
      { userId: ownerUserId },
      {
        commandId,
        executionId,
        executionGeneration: 3,
        leaseToken,
        runnerId,
        deviceId,
        deploymentId,
        providerTurnId: "codex-current-provider-turn",
        intent: { kind: "assign", goal: "Review the pull request" }
      }
    );

    const jobInsertIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes("insert into personal_agent_execution_jobs")
    );
    const publicationIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes("insert into personal_agent_team_job_publications")
    );
    const eventIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes("insert into personal_agent_execution_job_events")
    );
    expect(jobInsertIndex).toBeGreaterThan(-1);
    expect(publicationIndex).toBeGreaterThan(jobInsertIndex);
    expect(eventIndex).toBeGreaterThan(publicationIndex);
    const publicationSql = query.mock.calls[publicationIndex]?.[0] as string;
    expect(publicationSql).toContain("c.actor_user_id = j.owner_user_id");
    expect(publicationSql).toContain("c.local_project_id = j.project_id");
    expect(publicationSql).toContain("sp.unshared_at is null");
    expect(publicationSql).toContain("t.lifecycle = 'active'");
    expect(publicationSql).toContain("tm.status = 'enabled'");
    expect(publicationSql).toContain(
      "on conflict (connection_id, job_id) do nothing"
    );
    expect(publicationSql).not.toMatch(/encrypted_payload|command_id|prompt/i);
    const insertedJobId = query.mock.calls[jobInsertIndex]?.[1]?.[0];
    expect(query.mock.calls[publicationIndex]?.[1]).toEqual([
      insertedJobId,
      ownerUserId
    ]);
    expect(query.mock.calls.some(([sql]) => sql === "commit")).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === "rollback")).toBe(false);
  });
});

describe("managed Conversation start prompt dispatch", () => {
  const ownerUserId = "owner-user-id";
  const executionId = "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa";
  const startCommandId = "5224b37d-08b3-48f4-84d7-c4ba29ff63f7";
  const leaseToken = "lease-token";
  const clientUserMessageId = "0ebcc84e-1028-493b-8c54-e41f61f76818";
  const personalMemoryContext = {
    schemaVersion: 1,
    status: "available",
    attributionNonce: "99999999-9999-4999-8999-999999999999",
    searchDomain: "global",
    projectId: null,
    evidence: [
      {
        nodeId: "private-node-id",
        sourceType: "memory_event",
        sourceId: "private-source-id",
        summaryText: "Private remembered detail",
        citation: { nodeId: "private-node-id", visibility: "personal" }
      }
    ]
  };
  const personalAgent = {
    jobId: "33333333-3333-4333-8333-333333333333",
    agentId: "44444444-4444-4444-8444-444444444444",
    agentVersion: 2,
    identityVersionId: "55555555-5555-4555-8555-555555555555",
    replayed: false
  };
  const personalAgentContext = {
    schemaVersion: 1,
    identity: {
      agentId: personalAgent.agentId,
      version: personalAgent.agentVersion,
      identityVersionId: personalAgent.identityVersionId,
      name: "Mira",
      role: "Reviewer",
      soulInstructions: "Be precise."
    },
    project: { projectId: null, name: null },
    memory: { searchDomain: "global", evidence: personalMemoryContext.evidence }
  };
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 7).toString("base64")
  );

  it("queues one encrypted child prompt and binds the existing Job to it", async () => {
    const encryptedPayload = await provider.encrypt({
      plaintext: JSON.stringify({
        prompt: "  Say hello  ",
        clientUserMessageId,
        settings: {
          model: "claude-test",
          reasoningEffort: null,
          permissionMode: "supervised"
        },
        personalMemoryContext,
        personalAgent,
        personalAgentContext
      }),
      scope: {
        tenantId: ownerUserId,
        objectClass: "managed_conversation_prompt"
      },
      provenance: {
        rowFamily: "managed_conversation_commands",
        sourceId: startCommandId
      },
      ciphertextLocation: "managed_conversation_commands.encrypted_payload",
      aad: { ownerUserId, executionId, commandId: startCommandId }
    });
    let completed = false;
    let childInsertParams: unknown[] | undefined;
    let personalAgentJobBindingParams: unknown[] | undefined;
    const outboxRow = {
      id: "outbox-id",
      cursor: "1",
      protocol_version: 1,
      family: "managed_conversation_changed",
      scope: "personal",
      personal_owner_user_id: ownerUserId,
      team_id: null,
      team_workspace_id: null,
      thread_id: null,
      message_id: null,
      share_grant_id: null,
      logical_memory_id: null,
      resource_type: "managed_conversation_execution",
      resource_id: executionId,
      actor_principal_id: ownerUserId,
      mutation_id: "mutation-id",
      occurred_at: new Date()
    };
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("update managed_conversation_commands")) {
        if (completed) return { rows: [] };
        completed = true;
        return {
          rows: [
            {
              id: startCommandId,
              owner_user_id: ownerUserId,
              execution_id: executionId,
              execution_generation: 2,
              command_kind: "start",
              encrypted_payload: encryptedPayload
            }
          ]
        };
      }
      if (
        sql.includes("from managed_conversation_executions") &&
        sql.includes("for update")
      ) {
        return {
          rows: [
            {
              execution_generation: 2,
              state: "running",
              model: "claude-current",
              reasoning_effort: "high",
              permission_mode: "auto_edit"
            }
          ]
        };
      }
      if (sql.includes("coalesce(max(sequence)"))
        return { rows: [{ sequence: 4 }] };
      if (sql.includes("insert into managed_conversation_commands")) {
        childInsertParams = params;
        return { rows: [{ id: "child-command-id" }] };
      }
      if (sql.includes("update personal_agent_execution_jobs")) {
        personalAgentJobBindingParams = params;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("insert into collaboration_outbox")) {
        return { rows: [outboxRow] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) };
    const repository = createManagedConversationRepository(
      pool as unknown as pg.Pool,
      { envelopeEncryptionProvider: provider }
    );

    await expect(
      repository.completeManagedConversationCommand({
        commandId: startCommandId,
        leaseToken
      })
    ).resolves.toBe(true);
    await expect(
      repository.completeManagedConversationCommand({
        commandId: startCommandId,
        leaseToken
      })
    ).resolves.toBe(false);

    expect(
      query.mock.calls.filter(([sql]) =>
        sql.includes("insert into managed_conversation_commands")
      )
    ).toHaveLength(1);
    expect(childInsertParams?.[3]).toBe(
      `managed-conversation-start-prompt:${startCommandId}`
    );
    expect(childInsertParams?.[4]).toBe(4);
    expect(childInsertParams?.[6]).toBe(clientUserMessageId);
    expect(childInsertParams?.[7]).toBe(2);
    expect(personalAgentJobBindingParams).toEqual([
      ownerUserId,
      personalAgent.jobId,
      "child-command-id",
      startCommandId,
      executionId,
      personalAgent.agentId,
      personalAgent.agentVersion
    ]);
    const childPayload = JSON.parse(
      await decryptEnvelopeToUtf8(
        provider,
        childInsertParams?.[8] as EncryptedPayloadEnvelope
      )
    ) as Record<string, unknown>;
    expect(childPayload).toMatchObject({
      prompt: "Say hello",
      clientUserMessageId,
      settings: {
        model: "claude-current",
        reasoningEffort: "high",
        permissionMode: "auto_edit"
      },
      personalMemoryContext,
      personalAgent: { ...personalAgent, replayed: false },
      personalAgentContext
    });
    expect(JSON.stringify(childPayload)).toContain("private-node-id");
    expect(
      query.mock.calls.filter(([sql]) =>
        sql.includes("insert into personal_agent_execution_jobs")
      )
    ).toHaveLength(0);
  });

  it("does not dispatch the prompt when a pending start was canceled", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const client = { query, release: vi.fn() };
    const repository = createManagedConversationRepository(
      { connect: vi.fn(async () => client) } as unknown as pg.Pool,
      { envelopeEncryptionProvider: provider }
    );

    await expect(
      repository.completeManagedConversationCommand({
        commandId: startCommandId,
        leaseToken
      })
    ).resolves.toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes("insert into managed_conversation_commands")
      )
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes("from managed_conversation_executions")
      )
    ).toBe(false);
  });
});

describe("managed provider encrypted history", () => {
  const owner = "owner";
  const executionId = "d5fe6081-1d6c-4b5a-93c3-5f41d39a25fa";
  const commandId = "5224b37d-08b3-48f4-84d7-c4ba29ff63f7";
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 8).toString("base64")
  );
  const envelope = (value: Record<string, unknown>) =>
    provider.encrypt({
      plaintext: JSON.stringify(value),
      scope: { tenantId: owner, objectClass: "managed_conversation_prompt" },
      provenance: {
        rowFamily: "managed_conversation_commands",
        sourceId: commandId
      },
      ciphertextLocation: "managed_conversation_commands.encrypted_payload",
      aad: { ownerUserId: owner, executionId, commandId }
    });

  it("encrypts final output in the same completion transaction and never plaintext result", async () => {
    const encrypted = await envelope({
      prompt: "Private prompt",
      settings: {}
    });
    let saved: unknown;
    const outboxRow = {
      id: "outbox-id",
      cursor: "1",
      protocol_version: 1,
      family: "managed_conversation_changed",
      scope: "personal",
      personal_owner_user_id: owner,
      team_id: null,
      team_workspace_id: null,
      thread_id: null,
      message_id: null,
      share_grant_id: null,
      logical_memory_id: null,
      resource_type: "managed_conversation_execution",
      resource_id: executionId,
      actor_principal_id: owner,
      mutation_id: "mutation-id",
      occurred_at: new Date()
    };

    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("returning id, owner_user_id"))
        return {
          rows: [
            {
              id: commandId,
              owner_user_id: owner,
              execution_id: executionId,
              execution_generation: 1,
              command_kind: "prompt",
              encrypted_payload: encrypted
            }
          ]
        };
      if (sql.includes("set encrypted_payload")) saved = params[1];
      if (sql.includes("insert into collaboration_outbox"))
        return { rows: [outboxRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const repository = createManagedConversationRepository(
      { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool,
      { envelopeEncryptionProvider: provider }
    );
    await expect(
      repository.completeManagedConversationCommand({
        commandId,
        leaseToken: "lease",
        result: { turnId: "turn" },
        assistantOutput: { text: "Private final reply", truncated: false }
      })
    ).resolves.toBe(true);
    expect(JSON.stringify(saved)).not.toContain("Private final reply");
    expect(
      JSON.parse(
        await decryptEnvelopeToUtf8(provider, saved as EncryptedPayloadEnvelope)
      )
    ).toMatchObject({
      prompt: "Private prompt",
      assistantOutput: { text: "Private final reply", truncated: false }
    });
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes("returning id, owner_user_id")
      )?.[1]?.[2]
    ).toEqual({ turnId: "turn" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("returns bounded decrypted turns scoped to owner and execution, and rejects invalid cursors", async () => {
    const encrypted = await envelope({
      prompt: "Prompt",
      assistantOutput: { text: "Final", truncated: false }
    });
    const now = new Date();
    const row = {
      id: commandId,
      state: "completed",
      client_user_message_id: commandId,
      result: { turnId: "provider-turn", providerItemId: "provider-item" },
      sequence: 4,
      created_at: now,
      completed_at: now,
      updated_at: now,
      encrypted_payload: encrypted
    };
    const query = vi.fn(async () => ({
      rows: [row, { ...row, sequence: 3 }]
    }));
    const repository = createManagedConversationRepository(
      { query } as unknown as pg.Pool,
      { envelopeEncryptionProvider: provider }
    );
    const history = await repository.listManagedConversationPromptHistory(
      { userId: owner },
      { executionId, limit: 1, before: "prompt:5" }
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("owner_user_id = $1 and execution_id = $2"),
      [owner, executionId, 5, 2]
    );
    expect(query.mock.calls[0]?.[0]).not.toContain("state = 'completed'");
    expect(query.mock.calls[0]?.[0]).toContain("not exists");
    expect(history).toMatchObject({
      turns: [
        {
          commandId,
          prompt: "Prompt",
          providerTurnId: "provider-turn",
          providerItemId: "provider-item",
          assistantOutput: { text: "Final", truncated: false }
        }
      ],
      hasMore: true,
      nextCursor: "prompt:4"
    });
    await expect(
      repository.listManagedConversationPromptHistory(
        { userId: owner },
        { executionId, before: "foreign-cursor" }
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    const assignedHistory =
      await repository.listManagedConversationPromptHistory(
        { userId: owner },
        { executionId, includeAssigned: true }
      );
    expect(assignedHistory.turns).toHaveLength(2);
    expect(query.mock.calls[1]?.[0]).not.toContain("not exists");
    expect(query.mock.calls[1]?.[1]).toEqual([owner, executionId, null, 21]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(["queued", "running", "failed", "canceled", "indeterminate"])(
    "retains the submitted question for a %s task without presenting a completed answer",
    async (state) => {
      const encrypted = await envelope({
        prompt: "Hello world!",
        assistantOutput: { text: "Unconfirmed reply", truncated: false }
      });
      const now = new Date();
      const query = vi.fn(async () => ({
        rows: [
          {
            id: commandId,
            state,
            client_user_message_id: commandId,
            sequence: 4,
            created_at: now,
            completed_at: null,
            updated_at: now,
            encrypted_payload: encrypted
          }
        ]
      }));
      const repository = createManagedConversationRepository(
        { query } as unknown as pg.Pool,
        { envelopeEncryptionProvider: provider }
      );
      const history = await repository.listManagedConversationPromptHistory(
        { userId: owner },
        { executionId }
      );
      expect(query.mock.calls[0]?.[0]).not.toContain("state = 'completed'");
      expect(history.turns).toEqual([
        expect.objectContaining({
          prompt: "Hello world!",
          assistantOutput: null
        })
      ]);
    }
  );

  it("directly loads one saved provider answer by owner, execution, and command id", async () => {
    const context = {
      schemaVersion: 1,
      status: "available",
      attributionNonce: "nonce",
      searchDomain: "global",
      projectId: null,
      evidence: [{ nodeId: "node-1" }]
    };
    const encrypted = await envelope({
      prompt: "Original prompt",
      assistantOutput: { text: "Saved answer", truncated: false },
      personalMemoryContext: context
    });
    const row = {
      id: commandId,
      encrypted_payload: encrypted
    };
    const query = vi.fn(async () => ({ rows: [row] }));
    const repository = createManagedConversationRepository(
      { query } as unknown as pg.Pool,
      { envelopeEncryptionProvider: provider }
    );

    await expect(
      repository.getManagedConversationPromptHistoryAnswer(
        { userId: owner },
        { executionId, commandId }
      )
    ).resolves.toEqual({
      commandId,
      assistantOutput: { text: "Saved answer", truncated: false },
      personalMemoryContext: context
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "where owner_user_id = $1 and execution_id = $2 and id = $3"
      ),
      [owner, executionId, commandId]
    );
    expect(query.mock.calls[0]?.[0]).toContain("command_kind = 'prompt'");
    expect(query.mock.calls[0]?.[0]).toContain("state = 'completed'");
    expect(query.mock.calls[0]?.[0]).not.toContain("sequence <");
  });
});
