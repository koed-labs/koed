import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "../packages/db/node_modules/pg/lib/index.js";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "../packages/shared/dist/index.js";
import { runDbMigrations } from "../packages/db/dist/migrate.js";
import { createPersonalAgentRepository } from "../packages/db/dist/personal-agent-repository.js";
import { createManagedConversationRepository } from "../packages/db/dist/managed-conversation-repository.js";
import { createPersonalAgentChatRepository } from "../packages/db/dist/personal-agent-chat-repository.js";

const databaseUrl = process.env.KOED_MULTI_AGENT_SMOKE_DATABASE_URL;
if (!databaseUrl)
  throw new Error("KOED_MULTI_AGENT_SMOKE_DATABASE_URL is required");
const database = `koed_multi_agent_test_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const testUrl = new URL(databaseUrl);
testUrl.pathname = `/${database}`;
let pool;
let databaseCreated = false;
const results = [];

try {
  await admin.query(`create database "${database}"`);
  databaseCreated = true;
  pool = new pg.Pool({ connectionString: testUrl.toString(), max: 8 });
  await runDbMigrations(pool);
  const encryption = {
    envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64url")
    )
  };
  const agents = createPersonalAgentRepository(pool, encryption);
  const managed = createManagedConversationRepository(pool, encryption);
  const chats = createPersonalAgentChatRepository(pool, encryption);
  const actor = { userId: randomUUID() };
  const otherActor = { userId: randomUUID() };
  const device = randomUUID();
  const deployment = randomUUID();
  await pool.query(
    "insert into users (id,email,display_name) values ($1,$2,$3),($4,$5,$6)",
    [
      actor.userId,
      `${actor.userId}@test.invalid`,
      "Test owner",
      otherActor.userId,
      `${otherActor.userId}@test.invalid`,
      "Other owner"
    ]
  );
  const profiles = [];
  const preparedAgentContexts = {};
  for (const [name, provider] of [
    ["Builder", "codex"],
    ["Reviewer", "codex"],
    ["Critic", "claude"]
  ]) {
    const detail = await agents.createPersonalAgent(actor, {
      requestId: randomUUID(),
      name,
      role: "Disposable acceptance Agent",
      avatarReference: "pixelkin:smoke",
      soulInstructions: "",
      instructionSource: "custom",
      defaultProvider: null,
      defaultModel: null,
      defaultReasoningEffort: null
    });
    profiles.push({
      kind: "agent",
      agentId: detail.agent.id,
      agentVersion: detail.agent.currentVersion,
      provider,
      aiClientInstanceId: `${provider}.default`,
      targetDeviceId: device,
      model: "test-model",
      reasoningEffort: "high",
      permissionMode: "supervised",
      selectedResourceIds: []
    });
    const version = await agents.getPersonalAgentVersion(actor, {
      agentId: detail.agent.id,
      version: detail.agent.currentVersion
    });
    preparedAgentContexts[detail.agent.id] = {
      context: {
        schemaVersion: 1,
        identity: {
          agentId: detail.agent.id,
          version: version.version,
          identityVersionId: version.id,
          name: version.name,
          role: version.role,
          avatarReference: version.avatarReference
        },
        project: { projectId: null, name: null }
      }
    };
  }
  const context = {
    projectId: null,
    contextKind: "independent",
    targetDeviceId: device
  };
  const input = (conversationId, recipients, text = "Build, then review.") => ({
    conversationId,
    requestId: randomUUID(),
    text,
    context,
    recipients,
    targetDeploymentId: deployment,
    preparedAgentContexts
  });
  const claim = () =>
    chats.claimNextPersonalAgentChatDelivery({
      ownerUserId: actor.userId,
      targetDeviceId: device,
      deploymentId: deployment,
      runnerId: "disposable-worker",
      leaseMs: 60_000
    });
  const finish = async (delivery, text, truncated = false, settle = true) => {
    const created = await managed.createManagedConversation(actor, {
      projectId: null,
      contextKind: "independent",
      provider: delivery.launch.provider,
      aiClientInstanceId: delivery.launch.aiClientInstanceId,
      model: delivery.launch.model,
      reasoningEffort: delivery.launch.reasoningEffort,
      permissionMode: "supervised",
      runnerKind: "local_device",
      runnerDeploymentId: deployment,
      runnerDeviceId: device,
      idempotencyKey: randomUUID()
    });
    const enqueued = await managed.enqueueManagedConversationPrompt(actor, {
      executionId: created.execution.id,
      executionGeneration: created.execution.executionGeneration,
      idempotencyKey: randomUUID(),
      clientUserMessageId: randomUUID(),
      prompt: delivery.prompt
    });
    const commandId = enqueued.id;
    await pool.query(
      "update managed_conversation_commands set personal_agent_chat_delivery_id=$2 where id=$1",
      [commandId, delivery.deliveryId]
    );
    const settlement = {
      ownerUserId: actor.userId,
      deliveryId: delivery.deliveryId,
      claimToken: delivery.claimToken,
      executionId: created.execution.id,
      commandId,
      jobId: null,
      reply: text,
      truncated,
      contextTransfer: delivery.contextTransfer
    };
    assert.equal(
      await chats.attachManagedConversationToPersonalAgentChatDelivery(
        settlement
      ),
      true
    );
    const commandLease = randomUUID();
    await pool.query(
      "update managed_conversation_commands set state='dispatching',lease_token=$2,lease_expires_at=now()+interval '1 minute' where id=$1",
      [commandId, commandLease]
    );
    assert.equal(
      await managed.completeManagedConversationCommand({
        commandId,
        leaseToken: commandLease,
        assistantOutput: { text, truncated }
      }),
      true
    );
    if (!settle) return settlement;
    assert.equal(
      await chats.completePersonalAgentChatDelivery({
        ...settlement,
        claimToken: randomUUID()
      }),
      false
    );
    assert.equal(
      await chats.completePersonalAgentChatDelivery(settlement),
      true
    );
    assert.equal(
      await chats.completePersonalAgentChatDelivery(settlement),
      false
    );
    return settlement;
  };
  const retainNativeSession = async (native, profile, rootId) => {
    await pool.query(
      "update managed_conversation_executions set state='running',personal_agent_chat_workspace_id=$2,logical_session_id=$1,provider_thread_id=$1::text where id=$1",
      [native.executionId, rootId]
    );
    await pool.query(
      "insert into personal_agent_execution_jobs (owner_user_id,conversation_id,agent_id,agent_version,command_id,state) values ($1,$2,$3,$4,$5,'succeeded')",
      [
        actor.userId,
        native.executionId,
        profile.agentId,
        profile.agentVersion,
        native.commandId
      ]
    );
  };
  const scenario = async (name, run) => {
    try {
      await run();
      results.push({ name, status: "passed" });
    } catch (error) {
      results.push({
        name,
        status: "failed",
        error: error.message,
        stack: error.stack
      });
    }
    // Other scenarios use a fresh root and must not inherit this scenario's queue.
    await pool.query(
      "update personal_agent_chat_roots set status='blocked' where owner_user_id=$1",
      [actor.userId]
    );
  };

  await scenario(
    "concurrent initial retries converge to one human message",
    async () => {
      const request = input(randomUUID(), profiles.slice(0, 2));
      const [left, right] = await Promise.all([
        chats.submitPersonalAgentChatMessage(actor, request),
        chats.submitPersonalAgentChatMessage(actor, request)
      ]);
      assert.equal(left.message.id, right.message.id);
      assert.equal(left.deliveries.length, 2);
      assert.deepEqual(
        left.deliveries.map((delivery) => delivery.agentId),
        profiles.slice(0, 2).map((profile) => profile.agentId)
      );
      await assert.rejects(
        chats.submitPersonalAgentChatMessage(actor, {
          ...request,
          text: "Changed retry"
        }),
        { code: "IDEMPOTENCY_CONFLICT" }
      );
    }
  );

  for (const [name, recipients] of [
    ["same provider", profiles.slice(0, 2)],
    ["different providers", [profiles[0], profiles[2]]]
  ]) {
    await scenario(
      `${name}: one root, sequential claims, separate sessions and retained replies`,
      async () => {
        const rootId = randomUUID();
        await chats.submitPersonalAgentChatMessage(
          actor,
          input(rootId, recipients)
        );
        assert.equal(
          await chats.getPersonalAgentChat(otherActor, rootId),
          null
        );
        assert.equal(
          await chats.claimNextPersonalAgentChatDelivery({
            ownerUserId: actor.userId,
            targetDeviceId: randomUUID(),
            deploymentId: deployment,
            runnerId: "wrong-device",
            leaseMs: 60_000
          }),
          null
        );
        const claims = await Promise.all([claim(), claim()]);
        assert.equal(claims.filter(Boolean).length, 1);
        const first = claims.find(Boolean);
        assert.equal(first.launch.agentId, recipients[0].agentId);
        assert.equal(await claim(), null);
        const firstRun = await finish(first, "The page is ready.");
        const second = await claim();
        assert.equal(second.launch.agentId, recipients[1].agentId);
        assert.match(second.conversationContextText, /The page is ready\./);
        assert.ok(second.contextTransfer.transferredMessages > 0);
        const secondRun = await finish(second, "Review completed.", true);
        assert.notEqual(firstRun.executionId, secondRun.executionId);
        const reopened = await createPersonalAgentChatRepository(
          pool,
          encryption
        ).getPersonalAgentChat(actor, rootId);
        assert.equal(
          reopened.conversation.messages.filter(
            (message) => message.kind === "user"
          ).length,
          1
        );
        assert.deepEqual(
          reopened.conversation.messages
            .filter((message) => message.kind === "agent_reply")
            .map((message) => message.authorAgentId),
          recipients.map((recipient) => recipient.agentId)
        );
        assert.equal(reopened.conversation.messages.at(-1).truncated, true);
        assert.equal(reopened.conversation.status, "idle");
      }
    );
  }

  await scenario("a new Agent can join on a later message", async () => {
    const rootId = randomUUID();
    await chats.submitPersonalAgentChatMessage(
      actor,
      input(rootId, [profiles[0]])
    );
    await finish(await claim(), "First reply.");
    await chats.submitPersonalAgentChatMessage(
      actor,
      input(rootId, [profiles[2]], "Now review it.")
    );
    const state = await chats.getPersonalAgentChat(actor, rootId);
    assert.deepEqual(
      state.conversation.participants.map((participant) => participant.agentId),
      [profiles[0].agentId, profiles[2].agentId]
    );
  });

  await scenario(
    "confirmed failure waits for explicit continuation",
    async () => {
      const rootId = randomUUID();
      await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, profiles.slice(0, 2))
      );
      const first = await claim();
      assert.equal(
        await chats.failPersonalAgentChatDelivery({
          ownerUserId: actor.userId,
          deliveryId: first.deliveryId,
          claimToken: first.claimToken,
          certainty: "confirmed_failure",
          errorCode: "ProviderUnavailable"
        }),
        true
      );
      assert.equal(await claim(), null);
      const continueRequest = {
        conversationId: rootId,
        requestId: randomUUID(),
        skipFailedDeliveryId: first.deliveryId
      };
      const resumed = await chats.continuePersonalAgentChatBatch(
        actor,
        continueRequest
      );
      assert.ok(resumed);
      const retried = await chats.continuePersonalAgentChatBatch(
        actor,
        continueRequest
      );
      assert.equal(retried?.skippedDeliveryId, resumed.skippedDeliveryId);
      assert.equal(retried?.resumedDeliveryId, resumed.resumedDeliveryId);
      assert.equal((await claim()).launch.agentId, profiles[1].agentId);
    }
  );

  await scenario(
    "a restarted worker reclaims an expired pre-dispatch delivery with a new fence",
    async () => {
      const rootId = randomUUID();
      await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, [profiles[0]])
      );
      const first = await claim();
      await pool.query(
        "update personal_agent_chat_deliveries set claim_until=now()-interval '1 second' where id=$1",
        [first.deliveryId]
      );
      const resumed = await createPersonalAgentChatRepository(
        pool,
        encryption
      ).claimNextPersonalAgentChatDelivery({
        ownerUserId: actor.userId,
        targetDeviceId: device,
        deploymentId: deployment,
        runnerId: "restarted-worker",
        leaseMs: 60_000
      });
      assert.ok(resumed);
      assert.equal(resumed.deliveryId, first.deliveryId);
      assert.notEqual(resumed.claimToken, first.claimToken);
      assert.equal(
        await chats.failPersonalAgentChatDelivery({
          ownerUserId: actor.userId,
          deliveryId: first.deliveryId,
          claimToken: first.claimToken,
          certainty: "confirmed_failure",
          errorCode: "StaleWorker"
        }),
        false
      );
    }
  );

  await scenario(
    "uncertain outcome cannot be skipped or hidden by cancel",
    async () => {
      const rootId = randomUUID();
      const admitted = await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, profiles.slice(0, 2))
      );
      const first = await claim();
      await chats.failPersonalAgentChatDelivery({
        ownerUserId: actor.userId,
        deliveryId: first.deliveryId,
        claimToken: first.claimToken,
        certainty: "indeterminate",
        errorCode: "LostAcknowledgement"
      });
      const reconciliation = await claim();
      assert.equal(reconciliation.deliveryId, first.deliveryId);
      assert.equal(reconciliation.reconciliationOnly, true);
      assert.equal(
        await chats.continuePersonalAgentChatBatch(actor, {
          conversationId: rootId,
          requestId: randomUUID(),
          skipFailedDeliveryId: first.deliveryId
        }),
        null
      );
      const cancelRequest = {
        conversationId: rootId,
        messageId: admitted.message.id,
        requestId: randomUUID()
      };
      const canceled = await chats.cancelPersonalAgentChatBatch(
        actor,
        cancelRequest
      );
      const retried = await chats.cancelPersonalAgentChatBatch(
        actor,
        cancelRequest
      );
      assert.deepEqual(
        retried?.canceledDeliveryIds,
        canceled?.canceledDeliveryIds
      );
      assert.equal(
        (await chats.getPersonalAgentChat(actor, rootId)).conversation.status,
        "uncertain"
      );
    }
  );

  await scenario(
    "canceling a queued batch permits a later explicit message",
    async () => {
      const rootId = randomUUID();
      const admitted = await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, profiles.slice(0, 2))
      );
      await chats.cancelPersonalAgentChatBatch(actor, {
        conversationId: rootId,
        messageId: admitted.message.id,
        requestId: randomUUID()
      });
      assert.equal(await claim(), null);
      const next = await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, [profiles[2]], "A new request after stopping.")
      );
      assert.equal(next.deliveries.length, 1);
    }
  );

  await scenario(
    "old request replay survives bounded timeline pagination",
    async () => {
      const rootId = randomUUID();
      const firstRequest = input(rootId, [profiles[0]], "Original request.");
      const original = await chats.submitPersonalAgentChatMessage(
        actor,
        firstRequest
      );
      for (let index = 0; index < 105; index += 1) {
        await chats.submitPersonalAgentChatMessage(
          actor,
          input(rootId, [profiles[0]], `Later request ${index}.`)
        );
      }
      const newest = await chats.getPersonalAgentChat(actor, rootId, {
        limit: 10
      });
      assert.equal(newest.conversation.messages.length, 10);
      assert.equal(newest.timelinePage.hasMore, true);
      const older = await chats.getPersonalAgentChat(actor, rootId, {
        limit: 10,
        beforeSequence: Number(newest.timelinePage.nextCursor)
      });
      assert.ok(
        older.conversation.messages.at(-1).sequence <
          newest.conversation.messages[0].sequence
      );
      assert.equal(
        (await chats.submitPersonalAgentChatMessage(actor, firstRequest))
          .message.id,
        original.message.id
      );
    }
  );

  await scenario(
    "adopting a generic chat preserves public history and has one root",
    async () => {
      const source = await managed.createManagedConversation(actor, {
        projectId: null,
        contextKind: "independent",
        provider: "codex",
        aiClientInstanceId: "codex.default",
        model: "test-model",
        reasoningEffort: "high",
        permissionMode: "supervised",
        runnerKind: "local_device",
        runnerDeploymentId: deployment,
        runnerDeviceId: device,
        idempotencyKey: randomUUID()
      });
      await pool.query(
        "update managed_conversation_commands set state='completed' where execution_id=$1 and command_kind='start'",
        [source.execution.id]
      );
      const command = await managed.enqueueManagedConversationPrompt(actor, {
        executionId: source.execution.id,
        executionGeneration: source.execution.executionGeneration,
        idempotencyKey: randomUUID(),
        clientUserMessageId: randomUUID(),
        prompt: "Earlier public question."
      });
      const leaseToken = randomUUID();
      await pool.query(
        "update managed_conversation_commands set state='dispatching',lease_token=$2,lease_expires_at=now()+interval '1 minute' where id=$1",
        [command.id, leaseToken]
      );
      assert.equal(
        await managed.completeManagedConversationCommand({
          commandId: command.id,
          leaseToken,
          assistantOutput: { text: "Earlier public answer.", truncated: false }
        }),
        true
      );
      const rootId = randomUUID();
      await chats.submitPersonalAgentChatMessage(actor, {
        ...input(rootId, profiles.slice(0, 2), "Please collaborate on this."),
        sourceExecutionId: source.execution.id
      });
      const state = await chats.getPersonalAgentChat(actor, rootId);
      assert.deepEqual(
        state.conversation.messages.map((message) => message.text),
        [
          "Earlier public question.",
          "Earlier public answer.",
          "Please collaborate on this."
        ]
      );
      assert.ok(
        (await claim()).conversationContextText.includes(
          "Earlier public answer."
        )
      );
      await assert.rejects(
        chats.submitPersonalAgentChatMessage(actor, {
          ...input(randomUUID(), [profiles[0]]),
          sourceExecutionId: source.execution.id
        }),
        (error) => error.statusCode === 409
      );
      assert.equal(await chats.getPersonalAgentChat(otherActor, rootId), null);
    }
  );

  await scenario(
    "an Agent joining a long chat receives recent bounded context",
    async () => {
      const rootId = randomUUID();
      for (let index = 0; index < 520; index += 1) {
        await chats.submitPersonalAgentChatMessage(
          actor,
          input(rootId, [profiles[0]], `Earlier public request ${index}.`)
        );
      }
      // Simulate explicitly canceled earlier batches without launching native providers.
      await pool.query(
        "update personal_agent_chat_deliveries set status='canceled' where conversation_id=$1",
        [rootId]
      );
      await pool.query(
        "update personal_agent_chat_turns set status='canceled' where conversation_id=$1",
        [rootId]
      );
      await pool.query(
        "update personal_agent_chat_roots set status='idle' where conversation_id=$1",
        [rootId]
      );
      await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, [profiles[2]], "Review the latest context.")
      );
      const delivery = await claim();
      assert.equal(delivery.launch.agentId, profiles[2].agentId);
      assert.ok(
        delivery.conversationContextText.includes("Earlier public request 519.")
      );
      assert.ok(
        Buffer.byteLength(delivery.conversationContextText, "utf8") <= 24 * 1024
      );
      assert.ok(delivery.contextTransfer.omittedMessages > 0);
    }
  );

  await scenario(
    "an unchanged Agent session keeps its incremental cursor and excludes its own native replies",
    async () => {
      const rootId = randomUUID();
      await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, [profiles[0]])
      );
      const native = await finish(
        await claim(),
        "Own native history is retained."
      );
      await retainNativeSession(native, profiles[0], rootId);
      await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, [profiles[0]], "Continue in the same session.")
      );
      const retained = await claim();
      assert.ok(retained.contextTransfer.cursorBeforeSequence > 0);
      assert.doesNotMatch(
        retained.conversationContextText ?? "",
        /Own native history is retained/
      );
    }
  );

  await scenario(
    "changing an Agent model bootstraps its prior public replies into the new session",
    async () => {
      const rootId = randomUUID();
      await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, [profiles[0]])
      );
      const native = await finish(await claim(), "Earlier work by this Agent.");
      await retainNativeSession(native, profiles[0], rootId);
      await chats.submitPersonalAgentChatMessage(
        actor,
        input(
          rootId,
          [{ ...profiles[0], model: "different-test-model" }],
          "Continue with another model."
        )
      );
      const fresh = await claim();
      assert.equal(fresh.contextTransfer.cursorBeforeSequence, 0);
      assert.match(fresh.conversationContextText, /Earlier work by this Agent/);
    }
  );

  await scenario(
    "a lost settlement resumes by reconciliation without another native prompt",
    async () => {
      const rootId = randomUUID();
      await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, profiles.slice(0, 2))
      );
      const first = await claim();
      const native = await finish(
        first,
        "Recovered public reply.",
        false,
        false
      );
      await pool.query(
        "update personal_agent_chat_deliveries set claim_until=now()-interval '1 second' where id=$1",
        [first.deliveryId]
      );
      const recovered = await claim();
      assert.equal(recovered.deliveryId, first.deliveryId);
      assert.equal(recovered.reconciliationOnly, true);
      assert.notEqual(recovered.claimToken, first.claimToken);
      assert.equal(
        await chats.completePersonalAgentChatDelivery({
          ...native,
          claimToken: recovered.claimToken
        }),
        true
      );
      const next = await claim();
      assert.equal(next.launch.agentId, profiles[1].agentId);
      assert.match(next.conversationContextText, /Recovered public reply/);
    }
  );

  await scenario(
    "native child preparation commits parent linkage and reuses its identity",
    async () => {
      const rootId = randomUUID();
      await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, [profiles[0]])
      );
      const delivery = await claim();
      const contexts =
        typeof delivery.personalAgentContext === "string"
          ? JSON.parse(delivery.personalAgentContext)
          : delivery.personalAgentContext;
      const prepare = {
        actor,
        conversationId: rootId,
        deliveryId: delivery.deliveryId,
        claimToken: delivery.claimToken,
        targetDeviceId: device,
        targetDeploymentId: deployment,
        provider: delivery.launch.provider,
        aiClientInstanceId: delivery.launch.aiClientInstanceId,
        model: delivery.launch.model,
        reasoningEffort: delivery.launch.reasoningEffort,
        permissionMode: delivery.launch.permissionMode,
        prompt: delivery.prompt,
        contextText: delivery.conversationContextText,
        contextTransfer: delivery.contextTransfer,
        clientUserMessageId: delivery.messageId,
        selectedResourceIds: [],
        agentId: delivery.launch.agentId,
        agentVersion: delivery.launch.agentVersion,
        personalAgentContext: contexts.context,
        idempotencyKey: `personal-agent-chat-delivery:${delivery.deliveryId}`
      };
      const created = await managed.preparePersonalAgentChatChild(prepare);
      const retried = await managed.preparePersonalAgentChatChild(prepare);
      assert.equal(retried.execution.id, created.execution.id);
      assert.equal(retried.command.id, created.command.id);
      const linkage = await pool.query(
        "select execution_id,command_id from personal_agent_chat_deliveries where id=$1",
        [delivery.deliveryId]
      );
      assert.equal(linkage.rows[0].execution_id, created.execution.id);
      assert.equal(linkage.rows[0].command_id, created.command.id);
      const native = await pool.query(
        "select personal_agent_chat_delivery_id from managed_conversation_commands where id=$1",
        [created.command.id]
      );
      assert.equal(
        native.rows[0].personal_agent_chat_delivery_id,
        delivery.deliveryId
      );
      assert.equal(created.execution.personalAgentChatWorkspaceId, rootId);
      await pool.query(
        "update managed_conversation_commands set state='completed' where id=$1",
        [created.command.id]
      );
      await assert.rejects(
        chats.submitPersonalAgentChatMessage(actor, {
          ...input(randomUUID(), [profiles[1]]),
          sourceExecutionId: created.execution.id
        })
      );
      await assert.rejects(
        managed.preparePersonalAgentChatChild({
          ...prepare,
          targetDeviceId: randomUUID()
        })
      );
      await assert.rejects(
        managed.preparePersonalAgentChatChild({
          ...prepare,
          claimToken: randomUUID()
        })
      );
    }
  );

  await scenario(
    "renaming an Agent preserves its native session and incremental public context",
    async () => {
      const rootId = randomUUID();
      await chats.submitPersonalAgentChatMessage(
        actor,
        input(rootId, [profiles[0]])
      );
      const native = await finish(
        await claim(),
        "Public reply before identity revision."
      );
      await retainNativeSession(native, profiles[0], rootId);
      const updated = await agents.updatePersonalAgent(actor, {
        agentId: profiles[0].agentId,
        requestId: randomUUID(),
        expectedVersion: 1,
        name: "Builder renamed"
      });
      const version = await agents.getPersonalAgentVersion(actor, {
        agentId: updated.agent.id,
        version: updated.agent.currentVersion
      });
      preparedAgentContexts[updated.agent.id] = {
        ...preparedAgentContexts[updated.agent.id],
        context: {
          ...preparedAgentContexts[updated.agent.id].context,
          identity: {
            ...preparedAgentContexts[updated.agent.id].context.identity,
            version: version.version,
            identityVersionId: version.id,
            name: version.name,
            avatarReference: version.avatarReference
          }
        }
      };
      await chats.submitPersonalAgentChatMessage(
        actor,
        input(
          rootId,
          [{ ...profiles[0], agentVersion: version.version }],
          "Continue after identity revision."
        )
      );
      const fresh = await claim();
      assert.ok(fresh.contextTransfer.cursorBeforeSequence > 0);
      assert.doesNotMatch(
        fresh.conversationContextText ?? "",
        /Public reply before identity revision/
      );
    }
  );

  console.log(
    JSON.stringify(
      {
        status: results.every((result) => result.status === "passed")
          ? "passed"
          : "failed",
        scenarios: results
      },
      null,
      2
    )
  );
  if (results.some((result) => result.status === "failed"))
    process.exitCode = 1;
} finally {
  await pool?.end();
  if (databaseCreated)
    await admin.query(`drop database if exists "${database}" with (force)`);
  await admin.end();
}
