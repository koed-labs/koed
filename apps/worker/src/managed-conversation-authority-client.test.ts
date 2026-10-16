import { describe, expect, it, vi } from "vitest";

import {
  combineManagedConversationRepositories,
  createManagedConversationAuthorityClient
} from "./managed-conversation-authority-client.js";

describe("Managed Conversation authority client", () => {
  const ids = {
    handoff: "00000000-0000-4000-8000-000000000010",
    fork: "00000000-0000-4000-8000-000000000011",
    source: "00000000-0000-4000-8000-000000000012",
    generation: "00000000-0000-4000-8000-000000000013",
    snapshot: "00000000-0000-4000-8000-000000000014",
    session: "00000000-0000-4000-8000-000000000015"
  };

  it("uses the runner authority routes for durable Personal Agent chat delivery", async () => {
    const deliveryId = "00000000-0000-4000-8000-000000000071";
    const conversationId = "00000000-0000-4000-8000-000000000072";
    const claimToken = "00000000-0000-4000-8000-000000000073";
    const executionId = "00000000-0000-4000-8000-000000000074";
    const commandId = "00000000-0000-4000-8000-000000000075";
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      const payload = path.endsWith("/claim")
        ? { delivery: null }
        : path.endsWith("/prepare")
          ? { execution: { id: executionId }, command: { id: commandId } }
          : path.endsWith("/complete")
            ? { completed: true }
            : { result: null };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });
    const runner = client.personalAgentChatRunner;

    await runner.claimDelivery({
      ownerUserId: ids.session,
      targetDeviceId: ids.source,
      targetDeploymentId: ids.generation,
      runnerId: "personal-chat:test",
      leaseMs: 30_000
    });
    await runner.prepareChild({
      actor: { userId: ids.session },
      conversationId,
      deliveryId,
      claimToken,
      targetDeviceId: ids.source,
      targetDeploymentId: ids.generation,
      provider: "codex",
      aiClientInstanceId: "codex.default",
      model: "gpt-test",
      reasoningEffort: null,
      permissionMode: "supervised",
      prompt: "A direct user prompt",
      contextText: null,
      contextTransfer: null,
      clientUserMessageId: ids.session,
      selectedResourceIds: [],
      idempotencyKey: `personal-agent-chat-delivery:${deliveryId}`
    });
    await runner.getChildResult({
      actor: { userId: ids.session },
      conversationId,
      deliveryId,
      claimToken,
      targetDeviceId: ids.source,
      targetDeploymentId: ids.generation
    });
    await runner.completeDelivery({
      ownerUserId: ids.session,
      deliveryId,
      claimToken,
      executionId,
      commandId,
      jobId: null,
      reply: "captured answer",
      truncated: true,
      contextTransfer: null
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(
      fetch.mock.calls.map(([request]) => new URL(String(request)).pathname)
    ).toEqual([
      "/v1/managed-conversation-runner/personal-agent-chats/claim",
      `/v1/managed-conversation-runner/personal-agent-chats/deliveries/${deliveryId}/prepare`,
      `/v1/managed-conversation-runner/personal-agent-chats/deliveries/${deliveryId}/result`,
      `/v1/managed-conversation-runner/personal-agent-chats/deliveries/${deliveryId}/complete`
    ]);
    const claimBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    const prepareBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    const resultBody = JSON.parse(String(fetch.mock.calls[2]?.[1]?.body));
    const completeBody = JSON.parse(String(fetch.mock.calls[3]?.[1]?.body));
    expect(claimBody).toEqual({
      runnerId: "personal-chat:test",
      leaseMs: 30_000
    });
    expect(prepareBody).toMatchObject({
      conversationId,
      claimToken,
      prompt: "A direct user prompt",
      idempotencyKey: `personal-agent-chat-delivery:${deliveryId}`
    });
    expect(prepareBody).not.toHaveProperty("actor");
    expect(prepareBody).not.toHaveProperty("targetDeviceId");
    expect(prepareBody).not.toHaveProperty("targetDeploymentId");
    expect(resultBody).toEqual({ claimToken, conversationId });
    expect(completeBody).toMatchObject({
      reply: "captured answer",
      truncated: true
    });
  });

  it("reads runner-scoped owner review state without sending caller-selected identity or private goal", async () => {
    const executionId = "00000000-0000-4000-8000-000000000088";
    const binding = {
      requestId: "00000000-0000-4000-8000-000000000089",
      teamId: "00000000-0000-4000-8000-000000000090",
      teamProjectId: "00000000-0000-4000-8000-000000000091",
      channelId: "00000000-0000-4000-8000-000000000092",
      ownerUserId: ids.session,
      agentId: "00000000-0000-4000-8000-000000000093",
      status: "awaiting_owner"
    };
    const pending = {
      ownerUserId: ids.session,
      agentId: binding.agentId,
      agentVersion: 3,
      localProjectId: "00000000-0000-4000-8000-000000000094"
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("/owner-review-binding") ? { binding } : { pending }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device bound-instance",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });
    const untrustedActor = { userId: "caller-selected-owner" };

    await expect(
      client.getOwnerReviewBindingForExecution(untrustedActor, { executionId })
    ).resolves.toEqual(binding);
    await expect(
      client.getAwaitingOwnerRequestForExecution(untrustedActor, {
        executionId
      })
    ).resolves.toEqual(pending);

    expect(
      fetch.mock.calls.map(([request]) => new URL(String(request)).pathname)
    ).toEqual([
      `/v1/managed-conversation-runner/executions/${executionId}/owner-review-binding`,
      `/v1/managed-conversation-runner/executions/${executionId}/awaiting-owner-request`
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        authorization: "Koed-Device bound-instance"
      });
      expect(init?.body).toBeUndefined();
    }
  });

  it("reads only bounded runtime output through the assigned generation and turn route", async () => {
    const executionId = "00000000-0000-4000-8000-000000000095";
    const providerTurnId = "claude-turn:current";
    const item = {
      id: "00000000-0000-4000-8000-000000000096",
      ownerUserId: ids.session,
      executionId,
      executionGeneration: 4,
      providerRequestId: "transient:claude-turn:current:assistant",
      providerTurnId,
      providerItemId: "assistant-final",
      itemKind: "transient_output",
      presentation: {},
      state: "pending",
      requestDigest: "a".repeat(64),
      payload: { text: "Final response", managedOutputTruncated: true },
      response: null,
      responseDigest: null,
      revision: 1,
      createdAt: "2026-10-01T00:00:01.000Z",
      updatedAt: "2026-10-01T00:00:01.000Z",
      respondedAt: null,
      resolvedAt: null
    };
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ items: [item] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device bound-instance",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.listManagedConversationRuntimeItems(
        { userId: ids.session },
        {
          executionId,
          executionGeneration: 4,
          providerTurnId,
          itemKind: "transient_output",
          limit: 33
        }
      )
    ).resolves.toEqual([item]);

    const [request, init] = fetch.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.pathname).toBe(
      `/v1/managed-conversation-runner/executions/${executionId}/runtime-items`
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      executionGeneration: "4",
      providerTurnId,
      limit: "32"
    });
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({
      authorization: "Koed-Device bound-instance"
    });
    expect(init?.body).toBeUndefined();
    expect(url.searchParams.has("ownerUserId")).toBe(false);
    expect(url.searchParams.has("deviceId")).toBe(false);
  });

  it("rejects oversized and out-of-scope runtime output responses", async () => {
    const executionId = "00000000-0000-4000-8000-000000000097";
    const baseItem = {
      id: "00000000-0000-4000-8000-000000000098",
      ownerUserId: ids.session,
      executionId,
      executionGeneration: 2,
      providerRequestId: "transient:turn",
      providerTurnId: "turn",
      itemKind: "transient_output",
      payload: { text: "reply" }
    };
    const responses: unknown[] = [
      { items: [{ ...baseItem, ownerUserId: ids.generation }] },
      { items: Array.from({ length: 33 }, () => baseItem) },
      { items: [{ ...baseItem, payload: { text: "x".repeat(65_537) } }] }
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device bound-instance",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });
    const request = {
      executionId,
      executionGeneration: 2,
      providerTurnId: "turn",
      itemKind: "transient_output" as const,
      limit: 33
    };

    await expect(
      client.listManagedConversationRuntimeItems(
        { userId: ids.session },
        request
      )
    ).rejects.toMatchObject({ statusCode: 502 });
    await expect(
      client.listManagedConversationRuntimeItems(
        { userId: ids.session },
        request
      )
    ).rejects.toMatchObject({ statusCode: 502 });
    await expect(
      client.listManagedConversationRuntimeItems(
        { userId: ids.session },
        request
      )
    ).rejects.toMatchObject({ statusCode: 502 });
    await expect(
      client.listManagedConversationRuntimeItems(
        { userId: ids.session },
        { ...request, limit: 34 }
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("restores only the known owner-review backfill retry code", async () => {
    const responses = [
      {
        error:
          "Owner review binding lookup is incomplete; retry before dispatch",
        code: "team_agent_review_binding_backfill_pending"
      },
      { error: "Other retryable failure", code: "other_retryable_failure" }
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const payload = responses.shift();
      return new Response(JSON.stringify(payload), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device bound-instance",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.getOwnerReviewBindingForExecution(
        { userId: ids.session },
        { executionId: ids.session }
      )
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "TEAM_AGENT_REVIEW_BINDING_BACKFILL_PENDING"
    });
    await expect(
      client.getOwnerReviewBindingForExecution(
        { userId: ids.session },
        { executionId: ids.session }
      )
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "other_retryable_failure"
    });
  });

  it("keeps provider usage on the execution device while authority stays remote", async () => {
    const localOwnerUserId = ids.session;
    const recordWorkflowTokenUsage = vi.fn(async () => ({ id: "usage-1" }));
    const remoteClaim = vi.fn(async () => []);
    const repository = combineManagedConversationRepositories(
      { recordWorkflowTokenUsage } as never,
      { claimManagedConversationCommands: remoteClaim } as never,
      localOwnerUserId
    );

    await repository.recordWorkflowTokenUsage(
      { userId: "remote-owner-is-not-local" },
      {
        workflowType: "managed_conversation",
        workflowId: "execution-1",
        totalTokens: 42
      }
    );
    await repository.claimManagedConversationCommands({
      runnerId: "runner-1",
      deviceId: "00000000-0000-4000-8000-000000000020",
      deploymentId: "00000000-0000-4000-8000-000000000021",
      limit: 1,
      leaseMs: 30_000
    });

    expect(recordWorkflowTokenUsage).toHaveBeenCalledWith(
      { userId: localOwnerUserId },
      expect.objectContaining({ workflowId: "execution-1" })
    );
    expect(remoteClaim).toHaveBeenCalledOnce();
  });

  it("claims recurring occurrences from the selected authority with only runner scope", async () => {
    const occurrence = {
      id: "00000000-0000-4000-8000-000000000081",
      taskId: "00000000-0000-4000-8000-000000000082",
      taskRevision: 3,
      trigger: "scheduled",
      scheduledAt: "2026-10-15T10:00:00.000Z",
      status: "dispatched",
      conversationId: "00000000-0000-4000-8000-000000000081",
      messageId: "00000000-0000-4000-8000-000000000083",
      deliveryId: "00000000-0000-4000-8000-000000000084",
      executionId: "00000000-0000-4000-8000-000000000085",
      errorCode: null,
      createdAt: "2026-10-15T10:00:00.000Z",
      updatedAt: "2026-10-15T10:00:01.000Z",
      completedAt: null
    };
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ occurrence }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device bound-instance",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.recurringAgentTaskRunner.claimNext({
        runnerId: "recurring-agent-task:test",
        leaseMs: 120_000
      })
    ).resolves.toEqual(occurrence);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://team.example.test/v1/managed-conversation-runner/recurring-agent-tasks/claim"
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      runnerId: "recurring-agent-task:test",
      leaseMs: 120_000
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Koed-Device bound-instance"
    });
  });

  it("routes every hosted Personal Agent job and attempt operation to authority with no local fallback", async () => {
    const localMethods = Object.fromEntries(
      [
        "getPersonalAgentExecutionJob",
        "listPersonalAgentExecutionJobs",
        "listPersonalAgentExecutionAttempts",
        "createPersonalAgentExecutionAttempt",
        "recordPersonalAgentTurnOutput",
        "completePersonalAgentExecutionAttempt"
      ].map((name) => [
        name,
        vi.fn(async () => {
          throw new Error(`local ${name} called`);
        })
      ])
    );
    const remoteMethods = {
      getPersonalAgentExecutionJob: vi.fn(async () => null),
      listPersonalAgentExecutionJobs: vi.fn(async () => ({
        jobs: [],
        hasMore: false,
        nextCursor: null
      })),
      listPersonalAgentExecutionAttempts: vi.fn(async () => ({
        attempts: [],
        hasMore: false,
        nextCursor: null
      })),
      createPersonalAgentExecutionAttempt: vi.fn(async () => ({
        id: "attempt"
      })),
      recordPersonalAgentTurnOutput: vi.fn(async () => ({ id: "job" })),
      completePersonalAgentExecutionAttempt: vi.fn(async () => ({
        replayed: false
      }))
    };
    const repository = combineManagedConversationRepositories(
      localMethods as never,
      remoteMethods as never,
      ids.session
    );
    const actor = { userId: "hosted-owner" };

    await repository.getPersonalAgentExecutionJob(actor, "job");
    await repository.listPersonalAgentExecutionJobs(actor, {
      conversationId: "conversation"
    });
    await repository.listPersonalAgentExecutionAttempts(actor, {
      jobId: "job"
    });
    await repository.createPersonalAgentExecutionAttempt(actor, {
      jobId: "job",
      attemptNumber: 1,
      attribution: { kind: "agent", agentId: "agent", agentVersion: 1 },
      provider: "codex",
      model: "model",
      aiClientInstanceId: "codex.default",
      reasoningEffort: null,
      permissionMode: "supervised",
      managedExecutionId: "conversation",
      managedExecutionGeneration: 1,
      status: "running",
      outcome: null,
      startedAt: new Date().toISOString(),
      completedAt: null
    });
    await repository.recordPersonalAgentTurnOutput({
      actor,
      jobId: "job",
      attemptId: "attempt",
      outputText: "done",
      outputReference: { runtimeItemIds: ["runtime-item"] }
    });
    await repository.completePersonalAgentExecutionAttempt({
      actor,
      jobId: "job",
      attemptId: "attempt",
      outcome: "succeeded"
    });

    for (const method of Object.values(localMethods)) {
      expect(method).not.toHaveBeenCalled();
    }
    for (const method of Object.values(remoteMethods)) {
      expect(method).toHaveBeenCalledOnce();
    }
  });

  it("delegates owner-review authority to the paired Team authority without local fallback", async () => {
    const getOwnerReviewBindingForExecution = vi.fn(async () => null);
    const getAwaitingOwnerRequestForExecution = vi.fn(async () => null);
    const localBinding = vi.fn(async () => {
      throw new Error("local owner-review lookup must not be used");
    });
    const localPending = vi.fn(async () => {
      throw new Error("local pending-request lookup must not be used");
    });
    const repository = combineManagedConversationRepositories(
      {
        getOwnerReviewBindingForExecution: localBinding,
        getAwaitingOwnerRequestForExecution: localPending
      } as never,
      {
        getOwnerReviewBindingForExecution,
        getAwaitingOwnerRequestForExecution
      } as never,
      ids.session
    );

    await expect(
      repository.getOwnerReviewBindingForExecution(
        { userId: "native-owner" },
        { executionId: ids.session }
      )
    ).resolves.toBeNull();
    await expect(
      repository.getAwaitingOwnerRequestForExecution(
        { userId: "native-owner" },
        { executionId: ids.session }
      )
    ).resolves.toBeNull();

    expect(getOwnerReviewBindingForExecution).toHaveBeenCalledOnce();
    expect(getAwaitingOwnerRequestForExecution).toHaveBeenCalledOnce();
    expect(localBinding).not.toHaveBeenCalled();
    expect(localPending).not.toHaveBeenCalled();
  });

  it("revalidates hosted turns against the execution device's native AI Client catalog", async () => {
    const instance = {
      instanceId: "codex.default",
      configIdentityHash: "native"
    };
    const snapshot = {
      instanceId: "codex.default",
      installationIdentityHash: "native"
    };
    const listAiClientInstances = vi.fn(async () => [instance]);
    const listCurrentAiClientCapabilitySnapshots = vi.fn(async () => [
      snapshot
    ]);
    const sourceCredential = {
      id: "native-source-credential",
      deviceInstanceId: "native-device",
      operationFamilies: ["managed_execution"],
      metadata: { protocolDeploymentId: "native-deployment" },
      revokedAt: null,
      expiresAt: null
    };
    const listDeviceCredentials = vi.fn(async () => [sourceCredential]);
    const remoteInstances = vi.fn(async () => []);
    const remoteSnapshots = vi.fn(async () => []);
    const remoteCredentials = vi.fn(async () => []);
    const repository = combineManagedConversationRepositories(
      {
        listAiClientInstances,
        listCurrentAiClientCapabilitySnapshots,
        listDeviceCredentials
      } as never,
      {
        listAiClientInstances: remoteInstances,
        listCurrentAiClientCapabilitySnapshots: remoteSnapshots,
        listDeviceCredentials: remoteCredentials
      } as never,
      "native-owner"
    );

    await expect(
      repository.listAiClientInstances({ userId: "hosted-owner" })
    ).resolves.toEqual([instance]);
    await expect(
      repository.listCurrentAiClientCapabilitySnapshots({
        userId: "hosted-owner"
      })
    ).resolves.toEqual([snapshot]);
    await expect(
      repository.listDeviceCredentials({ userId: "hosted-owner" })
    ).resolves.toEqual([sourceCredential]);
    expect(listAiClientInstances).toHaveBeenCalledWith({
      userId: "native-owner"
    });
    expect(listCurrentAiClientCapabilitySnapshots).toHaveBeenCalledWith({
      userId: "native-owner"
    });
    expect(listDeviceCredentials).toHaveBeenCalledWith({
      userId: "native-owner"
    });
    expect(remoteInstances).not.toHaveBeenCalled();
    expect(remoteSnapshots).not.toHaveBeenCalled();
    expect(remoteCredentials).not.toHaveBeenCalled();
  });

  it("forwards the explicit transient-output retention flag to runtime cleanup", async () => {
    const executionId = "00000000-0000-4000-8000-000000000099";
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ canceled: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.cancelManagedConversationRuntimeItems(
        { userId: ids.session },
        {
          executionId,
          executionGeneration: 3,
          preserveTransientOutput: true
        }
      )
    ).resolves.toBe(2);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      executionGeneration: 3,
      preserveTransientOutput: true
    });
  });

  it("sends only strict runner fields for Personal Agent intent and turn status", async () => {
    const commandId = "00000000-0000-4000-8000-000000000061";
    const executionId = "00000000-0000-4000-8000-000000000062";
    const leaseToken = "00000000-0000-4000-8000-000000000063";
    const deviceId = "00000000-0000-4000-8000-000000000064";
    const deploymentId = "00000000-0000-4000-8000-000000000065";
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("/personal-agent-intent")
            ? {
                assignment: {
                  jobId: "job-1",
                  agentId: "agent-1",
                  agentVersion: 1,
                  title: "Implement feature",
                  continuation: false
                }
              }
            : {}
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await client.recordPersonalAgentIntentForManagedCommand(
      { userId: ids.session },
      {
        commandId,
        executionId,
        executionGeneration: 4,
        leaseToken,
        runnerId: "runner-1",
        deviceId,
        deploymentId,
        providerTurnId: "turn-1",
        intent: { kind: "assign", goal: "Implement feature" }
      } as never
    );
    await client.recordPersonalAgentTurnStatusForManagedCommand(
      { userId: ids.session },
      {
        commandId,
        executionId,
        executionGeneration: 4,
        leaseToken,
        runnerId: "runner-1",
        deviceId,
        deploymentId,
        providerTurnId: "turn-1",
        status: "complete"
      } as never
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    const intentBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    const statusBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(Object.keys(intentBody).sort()).toEqual(
      [
        "executionGeneration",
        "executionId",
        "intent",
        "leaseToken",
        "providerTurnId",
        "runnerId"
      ].sort()
    );
    expect(Object.keys(statusBody).sort()).toEqual(
      [
        "executionGeneration",
        "executionId",
        "leaseToken",
        "providerTurnId",
        "runnerId",
        "status"
      ].sort()
    );
    expect(intentBody.deviceId).toBeUndefined();
    expect(intentBody.deploymentId).toBeUndefined();
    expect(statusBody.deviceId).toBeUndefined();
    expect(statusBody.deploymentId).toBeUndefined();
  });

  it("sends Project Move claims and completion to authority without local paths", async () => {
    const moveId = "00000000-0000-4000-8000-000000000040";
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      const payload = path.endsWith("/claim")
        ? { moves: [{ id: moveId, state: "claimed", claimToken: ids.handoff }] }
        : { move: { id: moveId, state: "completed" } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });
    await client.claimManagedConversationProjectMoves({
      ownerUserId: ids.session,
      deploymentId: ids.generation,
      deviceId: ids.source,
      runnerId: "runner-1",
      leaseMs: 30_000,
      limit: 1
    });
    await client.completeManagedConversationProjectMove({
      ownerUserId: ids.session,
      moveId,
      executionGeneration: 1,
      claimToken: ids.handoff,
      runnerId: "runner-1",
      deploymentId: ids.generation,
      deviceId: ids.source,
      destinationProjectName: "Target Project"
    });
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe(
      "/v1/managed-conversation-runner/project-moves/claim"
    );
    expect(new URL(String(fetch.mock.calls[1]![0])).pathname).toBe(
      `/v1/managed-conversation-runner/project-moves/${moveId}/complete`
    );
    const serialized = fetch.mock.calls
      .map((call) => String(call[1]?.body))
      .join("\n");
    expect(serialized).not.toContain("sourceProjectPath");
    expect(serialized).not.toContain("destinationLocalPath");
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({
      executionGeneration: 1,
      claimToken: ids.handoff,
      runnerId: "runner-1",
      destinationProjectName: "Target Project"
    });
  });

  it("binds the first durable source generation through runner authority", async () => {
    const execution = {
      id: "00000000-0000-4000-8000-000000000001",
      state: "running",
      sourceGenerationId: "00000000-0000-4000-8000-000000000002"
    };
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ execution }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.bindManagedConversationSourceGeneration(
        { userId: "local-owner-is-not-forwarded" },
        {
          executionId: execution.id,
          executionGeneration: 1,
          runnerId: "runner-1",
          expectedSourceGenerationId: "source-generation-before",
          sourceGenerationId: execution.sourceGenerationId
        }
      )
    ).resolves.toEqual(execution);
    const request = fetch.mock.calls[0]!;
    expect(new URL(String(request[0])).pathname).toBe(
      `/v1/managed-conversation-runner/executions/${execution.id}/source-generation`
    );
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      executionGeneration: 1,
      runnerId: "runner-1",
      expectedSourceGenerationId: "source-generation-before",
      sourceGenerationId: execution.sourceGenerationId
    });
  });

  it("persists checkpoint-only recovery through runner authority", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("checkpoint-pending")
            ? { marked: true }
            : { updated: true, reconciled: false, requeued: true }
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });
    const commandId = "00000000-0000-4000-8000-000000000030";
    const leaseToken = "00000000-0000-4000-8000-000000000031";

    await expect(
      client.markManagedConversationCheckpointPending({
        commandId,
        leaseToken,
        sourceGenerationId: ids.generation,
        providerTurnId: "provider-turn-1"
      })
    ).resolves.toBe(true);
    await expect(
      client.failManagedConversationCommand({
        commandId,
        leaseToken,
        state: "indeterminate",
        errorCode: "ExecutionCheckpointConcurrentMutationError"
      })
    ).resolves.toEqual({
      updated: true,
      reconciled: false,
      requeued: true
    });
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(
      `/v1/managed-conversation-runner/commands/${commandId}/checkpoint-pending`
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      leaseToken,
      sourceGenerationId: ids.generation,
      providerTurnId: "provider-turn-1"
    });
  });

  it("lists and records checkpoints through runner authority", async () => {
    const executionId = "00000000-0000-4000-8000-000000000040";
    const checkpoint = {
      id: "00000000-0000-4000-8000-000000000041",
      executionId,
      executionGeneration: 3,
      commandId: "00000000-0000-4000-8000-000000000042",
      providerTurnId: null,
      sourceGenerationId: null,
      sequence: 0,
      checkpointKind: "baseline" as const,
      checkpointStatus: "unsupported" as const,
      failureCode: null,
      repositoryIdentityHash: null,
      worktreeIdentityHash: null,
      vcsDriver: null,
      checkpointRef: null,
      commitObjectId: null,
      capturedAt: "2026-08-18T00:00:00.000Z"
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      const method = init?.method ?? "GET";
      return new Response(
        JSON.stringify(
          method === "GET"
            ? { checkpoints: [{ ...checkpoint, ownerUserId: ids.session }] }
            : {
                checkpoint: {
                  ...checkpoint,
                  ownerUserId: ids.session,
                  createdAt: checkpoint.capturedAt
                }
              }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.listManagedConversationExecutionCheckpoints(
        { userId: "local-owner-is-not-forwarded" },
        { executionId, executionGeneration: 3 }
      )
    ).resolves.toEqual([{ ...checkpoint, ownerUserId: ids.session }]);
    await expect(
      client.recordManagedConversationExecutionCheckpoint(
        { userId: "local-owner-is-not-forwarded" },
        { checkpoint, diffs: [] }
      )
    ).resolves.toEqual({
      ...checkpoint,
      ownerUserId: ids.session,
      createdAt: checkpoint.capturedAt
    });

    const listUrl = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(listUrl.pathname).toBe(
      `/v1/managed-conversation-runner/executions/${executionId}/checkpoints`
    );
    expect(listUrl.searchParams.get("executionGeneration")).toBe("3");
    expect(new URL(String(fetch.mock.calls[1]?.[0])).pathname).toBe(
      `/v1/managed-conversation-runner/executions/${executionId}/checkpoints`
    );
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      checkpoint,
      diffs: []
    });
  });

  it("claims and settles file operations through runner authority", async () => {
    const commandId = "00000000-0000-4000-8000-000000000050";
    const leaseToken = "00000000-0000-4000-8000-000000000051";
    const checkpointId = "00000000-0000-4000-8000-000000000052";
    const command = {
      id: commandId,
      commandKind: "file_read",
      executionId: "00000000-0000-4000-8000-000000000053"
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("claim-files")
            ? { commands: [command] }
            : path.endsWith("file-complete")
              ? { completed: true }
              : { updated: true }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });
    const result = {
      protocolVersion: 1 as const,
      checkpointId,
      checkpointSequence: 1,
      revision: { checkpointId, revisionDigest: "a".repeat(64) },
      kind: "read" as const,
      path: "src/example.ts",
      content: "export {};\n",
      contentDigest: "b".repeat(64),
      totalBytes: 11,
      offset: 0,
      nextOffset: null,
      lineCount: 2
    };

    await expect(
      client.claimManagedConversationFileOperations({
        runnerId: "runner",
        deploymentId: ids.generation,
        deviceId: ids.session,
        limit: 2,
        leaseMs: 30_000
      })
    ).resolves.toEqual([command]);
    await expect(
      client.completeManagedConversationFileOperation({
        commandId,
        leaseToken,
        result
      })
    ).resolves.toBe(true);
    await expect(
      client.failManagedConversationFileOperation({
        commandId,
        leaseToken,
        state: "queued",
        errorCode: "ManagedConversationAuthorityUnavailableError"
      })
    ).resolves.toBe(true);
    expect(
      fetch.mock.calls.map((call) => new URL(String(call[0])).pathname)
    ).toEqual([
      "/v1/managed-conversation-runner/commands/claim-files",
      `/v1/managed-conversation-runner/commands/${commandId}/file-complete`,
      `/v1/managed-conversation-runner/commands/${commandId}/file-fail`
    ]);
  });

  it("publishes verified workspace readiness and bounded rejection through runner authority", async () => {
    const executionId = "00000000-0000-4000-8000-000000000001";
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("runtime-binding-ready")
            ? { ready: true }
            : { failed: true }
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });
    const binding = {
      ownerUserId: ids.session,
      executionId,
      executionGeneration: 2,
      deploymentId: "00000000-0000-4000-8000-000000000020",
      deviceId: "00000000-0000-4000-8000-000000000021"
    };

    await expect(
      client.releaseManagedConversationStartForRuntimeBinding(binding)
    ).resolves.toBe(true);
    await expect(
      client.failManagedConversationStartForRuntimeBinding({
        ...binding,
        errorCode: "ExecutionCheckoutSourceDirtyError"
      })
    ).resolves.toBe(true);

    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(
      `/v1/managed-conversation-runner/executions/${executionId}/runtime-binding-ready`
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      executionGeneration: 2
    });
    expect(new URL(String(fetch.mock.calls[1]?.[0])).pathname).toBe(
      `/v1/managed-conversation-runner/executions/${executionId}/runtime-binding-failed`
    );
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      executionGeneration: 2,
      errorCode: "ExecutionCheckoutSourceDirtyError"
    });
  });

  it("loads only executions assigned by the remote runner authority", async () => {
    const execution = { id: "execution-1", state: "running" };
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ executions: [execution] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.listManagedConversationExecutionsForRunner({
        ownerUserId: "00000000-0000-4000-8000-000000000001",
        deviceId: "00000000-0000-4000-8000-000000000002",
        deploymentId: "00000000-0000-4000-8000-000000000003"
      })
    ).resolves.toEqual([execution]);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(
      "/v1/managed-conversation-runner/executions"
    );
  });

  it("acquires a recovered execution lease without forwarding local identity", async () => {
    const executionId = "00000000-0000-4000-8000-000000000001";
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ acquired: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.acquireManagedConversationExecutionLease({
        executionId,
        executionGeneration: 2,
        deploymentId: "local-deployment-is-not-forwarded",
        deviceId: "local-device-is-not-forwarded",
        runnerId: "recovered-runner",
        leaseMs: 30_000
      })
    ).resolves.toBe(true);
    const request = fetch.mock.calls[0]!;
    expect(new URL(String(request[0])).pathname).toBe(
      `/v1/managed-conversation-runner/executions/${executionId}/acquire`
    );
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      executionGeneration: 2,
      runnerId: "recovered-runner",
      leaseMs: 30_000
    });
  });

  it("checks exact source readiness at the execution authority", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ ready: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.isManagedConversationSourceGenerationReady({
        ownerUserId: "local-owner-is-not-forwarded",
        sourceGenerationId: ids.generation
      })
    ).resolves.toBe(true);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(
      `/v1/managed-conversation-runner/source-replicas/${ids.generation}/status`
    );
    expect(
      new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get("readiness")
    ).toBe("finalized");
  });

  it("derives claim authority from the credential instead of sending local identity fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ commands: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.claimManagedConversationCommands({
        runnerId: "runner-1",
        deviceId: "00000000-0000-4000-8000-000000000001",
        deploymentId: "00000000-0000-4000-8000-000000000002",
        limit: 8,
        leaseMs: 30_000
      })
    ).resolves.toEqual([]);

    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0]!;
    expect(new URL(String(request[0])).pathname).toBe(
      "/v1/managed-conversation-runner/commands/claim"
    );
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      runnerId: "runner-1",
      limit: 8,
      leaseMs: 30_000
    });
  });

  it("keeps handoff path identity out of strict request bodies", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("/prepare")
            ? {
                handoff: { id: ids.handoff },
                manifest: { protocol: "test" },
                sourceOriginKeyId: "source-key"
              }
            : { handoff: { id: ids.handoff } }
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await client.prepareManagedConversationHandoff(
      { userId: "local-owner-is-not-forwarded" },
      {
        handoffId: ids.handoff,
        expectedStateVersion: 1,
        runnerId: "runner-1",
        providerArtifactRelativePath: "sessions/source.jsonl",
        logicalSourceId: ids.source,
        sourceGenerationId: ids.generation,
        sourceClosureHash: "a".repeat(64),
        sourceEndByteCursor: 123,
        sourceEndItemCursor: 4,
        workspaceSnapshotId: ids.snapshot
      }
    );
    await client.attestManagedConversationHandoffSource(
      { userId: "local-owner-is-not-forwarded" },
      {
        handoffId: ids.handoff,
        expectedStateVersion: 3,
        sourceKeyId: "source-key",
        sourceSignature: "signature"
      }
    );

    expect(
      JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    ).not.toHaveProperty("handoffId");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      expectedStateVersion: 1,
      runnerId: "runner-1",
      providerArtifactRelativePath: "sessions/source.jsonl",
      logicalSourceId: ids.source,
      sourceGenerationId: ids.generation,
      sourceClosureHash: "a".repeat(64),
      sourceEndByteCursor: 123,
      sourceEndItemCursor: 4,
      workspaceSnapshotId: ids.snapshot
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      expectedStateVersion: 3,
      sourceKeyId: "source-key",
      sourceSignature: "signature"
    });
  });

  it("preserves bounded authority conflict codes for deterministic recovery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: "Managed Conversation source closure is not exact",
            code: "managed_conversation_handoff_source_closure_conflict"
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" }
          }
        )
    );
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await expect(
      client.prepareManagedConversationHandoff(
        { userId: "local-owner-is-not-forwarded" },
        {
          handoffId: ids.handoff,
          expectedStateVersion: 1,
          runnerId: "runner-1",
          providerArtifactRelativePath: "sessions/source.jsonl",
          logicalSourceId: ids.source,
          sourceGenerationId: ids.generation,
          sourceClosureHash: "a".repeat(64),
          sourceEndByteCursor: 123,
          sourceEndItemCursor: 4,
          workspaceSnapshotId: ids.snapshot
        }
      )
    ).rejects.toMatchObject({
      name: "ManagedConversationAuthorityConflictError",
      code: "managed_conversation_handoff_source_closure_conflict"
    });
  });

  it("keeps fork path identity out of strict request bodies", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const path = new URL(String(request)).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("/prepare-source")
            ? {
                fork: { id: ids.fork },
                manifest: { protocol: "test" },
                sourceOriginKeyId: "source-key"
              }
            : { fork: { id: ids.fork } }
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    const client = createManagedConversationAuthorityClient({
      baseUrl: "https://team.example.test",
      authorization: "Koed-Device test",
      envelopeEncryptionProvider: {} as never,
      fetch: fetch as typeof globalThis.fetch
    });

    await client.prepareManagedConversationForkSource(
      { userId: "local-owner-is-not-forwarded" },
      {
        forkId: ids.fork,
        expectedStateVersion: 1,
        runnerId: "runner-1",
        providerArtifactRelativePath: "sessions/source.jsonl",
        logicalSourceId: ids.source,
        sourceGenerationId: ids.generation,
        sourceClosureHash: "b".repeat(64),
        sourceEndByteCursor: 456,
        sourceEndItemCursor: 7,
        workspaceSnapshotId: ids.snapshot,
        parentLogicalSessionId: ids.session
      }
    );
    await client.attestManagedConversationForkSource(
      { userId: "local-owner-is-not-forwarded" },
      {
        forkId: ids.fork,
        expectedStateVersion: 2,
        sourceKeyId: "source-key",
        sourceSignature: "signature"
      }
    );

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      expectedStateVersion: 1,
      runnerId: "runner-1",
      providerArtifactRelativePath: "sessions/source.jsonl",
      logicalSourceId: ids.source,
      sourceGenerationId: ids.generation,
      sourceClosureHash: "b".repeat(64),
      sourceEndByteCursor: 456,
      sourceEndItemCursor: 7,
      workspaceSnapshotId: ids.snapshot,
      parentLogicalSessionId: ids.session
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      expectedStateVersion: 2,
      sourceKeyId: "source-key",
      sourceSignature: "signature"
    });
  });
});
