import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createMemorySourceRepository } from "./repository.js";

const baseUrl = process.env.PULL_REQUEST_AUTHORITY_TEST_DATABASE_URL;
const databaseName = `koed_pr_authority_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!baseUrl)("Pull request authority (PostgreSQL)", () => {
  const configured = baseUrl ? new URL(baseUrl) : null;
  const adminUrl = configured ? new URL(configured) : null;
  if (adminUrl) adminUrl.pathname = "/postgres";
  const testUrl = configured ? new URL(configured) : null;
  if (testUrl) testUrl.pathname = `/${databaseName}`;
  const admin = adminUrl
    ? new pg.Client({ connectionString: adminUrl.toString() })
    : null;
  const pool = testUrl
    ? new pg.Pool({ connectionString: testUrl.toString() })
    : null;
  let connected = false;
  afterAll(async () => {
    await pool?.end();
    if (!admin || !connected) return;
    try {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",
        [databaseName]
      );
      await admin.query(`drop database if exists "${databaseName}"`);
    } finally {
      await admin.end();
    }
  });

  it("stores encrypted task results, fences runner claims, and preserves one Agent chat per PR", async () => {
    if (!admin || !pool) throw new Error("Test database URL unavailable");
    await admin.connect();
    connected = true;
    await admin.query(`create database "${databaseName}"`);
    await runDbMigrations(pool);
    const ownerId = randomUUID(),
      otherOwnerId = randomUUID();
    await pool.query(
      "insert into users(id,email,display_name) values($1,$2,$3),($4,$5,$6)",
      [
        ownerId,
        `${ownerId}@pull-request.invalid`,
        "PR owner",
        otherOwnerId,
        `${otherOwnerId}@pull-request.invalid`,
        "Other owner"
      ]
    );
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64url")
    );
    const repository = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const actor = { userId: ownerId },
      agentRepo = repository;
    const agent = await agentRepo.createPersonalAgent(actor, {
      requestId: randomUUID(),
      name: "PR review agent",
      role: "Review pull requests",
      soulInstructions: "Review only the selected changes.",
      instructionSource: "custom",
      defaultProvider: "codex",
      defaultModel: "test-model"
    });
    const deviceId = randomUUID(),
      deploymentId = randomUUID();
    const detailsOperation = await repository.enqueuePullRequestOperation(
      actor,
      {
        requestId: randomUUID(),
        targetDeviceId: deviceId,
        targetDeploymentId: deploymentId,
        payload: {
          kind: "pull_request_details",
          account: { id: "42", login: "reviewer" },
          connectionGeneration: 3,
          repository: {
            id: "repo-7",
            owner: "acme",
            name: "widget",
            fullName: "acme/widget"
          },
          pullRequestNumber: 11
        }
      }
    );
    const claims = await repository.claimPullRequestOperations({
      ownerUserId: ownerId,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      runnerId: "integration-runner",
      limit: 1,
      leaseMs: 60_000
    });
    expect(claims).toHaveLength(1);
    expect(
      await repository.claimPullRequestOperations({
        ownerUserId: otherOwnerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId: "wrong-owner",
        limit: 1,
        leaseMs: 60_000
      })
    ).toHaveLength(0);
    const claim = claims[0]!;
    expect(claim.operation.id).toBe(detailsOperation.id);
    expect(
      await repository.completePullRequestOperation({
        operationId: detailsOperation.id,
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId: "wrong-runner",
        leaseToken: claim.leaseToken,
        result: {
          account: { id: "42", login: "reviewer" },
          connectionGeneration: 3,
          repository: {
            id: "repo-7",
            owner: "acme",
            name: "widget",
            fullName: "acme/widget"
          },
          pullRequestNumber: 11,
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          title: "Private result body"
        }
      })
    ).toBeNull();
    expect(
      await repository.completePullRequestOperation({
        operationId: detailsOperation.id,
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId: "integration-runner",
        leaseToken: claim.leaseToken,
        result: {
          account: { id: "42", login: "reviewer" },
          connectionGeneration: 3,
          repository: {
            id: "repo-7",
            owner: "acme",
            name: "widget",
            fullName: "acme/widget"
          },
          pullRequestNumber: 11,
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          title: "Private result body"
        }
      })
    ).not.toBeNull();
    const plaintext = await pool.query<{
      encrypted_payload: object;
      encrypted_result: object;
    }>(
      "select encrypted_payload,encrypted_result from pull_request_operations where id=$1",
      [detailsOperation.id]
    );
    expect(JSON.stringify(plaintext.rows[0])).not.toContain(
      "Private result body"
    );
    await expect(
      repository.createPullRequestReview(actor, {
        requestId: randomUUID(),
        detailsOperationId: detailsOperation.id,
        agentId: agent.agent.id,
        projectId: `lp_${"c".repeat(32)}`
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    const created = await repository.createPullRequestReview(actor, {
      requestId: randomUUID(),
      detailsOperationId: detailsOperation.id,
      agentId: agent.agent.id
    });
    const reload = await repository.createPullRequestReview(actor, {
      requestId: randomUUID(),
      detailsOperationId: detailsOperation.id,
      agentId: agent.agent.id
    });
    expect(reload.id).toBe(created.id);
    expect(
      await repository.getPullRequestReview(
        { userId: otherOwnerId },
        { reviewId: created.id }
      )
    ).toBeNull();
    await expect(
      repository.freezePullRequestReviewDraft(actor, {
        reviewId: created.id,
        expectedReviewRevision: created.revision,
        expectedDraftRevision: 0,
        accountId: created.account.id,
        connectionGeneration: created.connectionGeneration,
        baseSha: created.expectedBaseSha,
        headSha: created.expectedHeadSha
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    const runnerId = "pr-authority-integration-runner";
    const alternateAgent = await repository.createPersonalAgent(actor, {
      requestId: randomUUID(),
      name: "Alternate PR agent",
      role: "Test review binding",
      soulInstructions: "Do not review this request.",
      instructionSource: "custom",
      defaultProvider: "codex",
      defaultModel: "test-model"
    });
    const alternateReview = await repository.createPullRequestReview(actor, {
      requestId: randomUUID(),
      detailsOperationId: detailsOperation.id,
      agentId: alternateAgent.agent.id
    });
    const foreignActor = { userId: otherOwnerId };
    const foreignAgent = await repository.createPersonalAgent(foreignActor, {
      requestId: randomUUID(),
      name: "Foreign PR agent",
      role: "Test owner fencing",
      soulInstructions: "Do not review this request.",
      instructionSource: "custom",
      defaultProvider: "codex",
      defaultModel: "test-model"
    });
    const foreignDetails = await repository.enqueuePullRequestOperation(
      foreignActor,
      {
        requestId: randomUUID(),
        targetDeviceId: deviceId,
        targetDeploymentId: deploymentId,
        payload: {
          kind: "pull_request_details",
          account: { id: "42", login: "reviewer" },
          connectionGeneration: 3,
          repository: {
            id: "repo-7",
            owner: "acme",
            name: "widget",
            fullName: "acme/widget"
          },
          pullRequestNumber: 11
        }
      }
    );
    const foreignDetailsClaim = (
      await repository.claimPullRequestOperations({
        ownerUserId: otherOwnerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId: "foreign-owner-runner",
        limit: 1,
        leaseMs: 60_000
      })
    )[0]!;
    await repository.completePullRequestOperation({
      operationId: foreignDetails.id,
      ownerUserId: otherOwnerId,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      runnerId: "foreign-owner-runner",
      leaseToken: foreignDetailsClaim.leaseToken,
      result: {
        account: { id: "42", login: "reviewer" },
        connectionGeneration: 3,
        repository: {
          id: "repo-7",
          owner: "acme",
          name: "widget",
          fullName: "acme/widget"
        },
        pullRequestNumber: 11,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        title: "Foreign private pull request"
      }
    });
    const foreignReview = await repository.createPullRequestReview(
      foreignActor,
      {
        requestId: randomUUID(),
        detailsOperationId: foreignDetails.id,
        agentId: foreignAgent.agent.id
      }
    );
    const executionCount = async () =>
      (
        await pool.query<{ count: string }>(
          "select count(*)::text as count from managed_conversation_executions where owner_user_id=$1",
          [ownerId]
        )
      ).rows[0]!.count;
    const expectRejectedAtomicBinding = async (input: {
      reviewId: string;
      agentId: string;
      deviceId?: string;
      projectId?: string | null;
    }) => {
      const before = await executionCount();
      const targetDeviceId = input.deviceId ?? deviceId;
      const projectId = input.projectId ?? null;
      const contextKind = projectId ? "project" : "independent";
      await expect(
        repository.createManagedConversation(actor, {
          projectId,
          contextKind,
          provider: "codex",
          aiClientInstanceId: "codex.default",
          model: "test-model",
          permissionMode: "supervised",
          runnerKind: "local_device",
          runnerDeploymentId: deploymentId,
          runnerDeviceId: targetDeviceId,
          idempotencyKey: randomUUID(),
          initialPullRequestReviewId: input.reviewId,
          bindInitialPullRequestReviewWithClient: async (
            client,
            executionId
          ) => {
            const bound =
              await repository.bindPullRequestReviewExecutionWithClient(
                client,
                actor,
                {
                  reviewId: input.reviewId,
                  executionId,
                  agentId: input.agentId,
                  runnerDeploymentId: deploymentId,
                  runnerDeviceId: targetDeviceId,
                  projectId
                }
              );
            if (!bound) throw new Error("Pull Request binding rejected");
          }
        })
      ).rejects.toThrow("Pull Request binding rejected");
      expect(await executionCount()).toBe(before);
    };
    await expectRejectedAtomicBinding({
      reviewId: foreignReview.id,
      agentId: agent.agent.id
    });
    await expectRejectedAtomicBinding({
      reviewId: created.id,
      agentId: alternateAgent.agent.id
    });
    await expectRejectedAtomicBinding({
      reviewId: created.id,
      agentId: agent.agent.id,
      deviceId: randomUUID()
    });
    await expectRejectedAtomicBinding({
      reviewId: created.id,
      agentId: agent.agent.id,
      projectId: `lp_${randomUUID().replaceAll("-", "")}`
    });
    const managedStart = await repository.createManagedConversation(actor, {
      projectId: null,
      contextKind: "independent",
      provider: "codex",
      aiClientInstanceId: "codex.default",
      model: "test-model",
      permissionMode: "supervised",
      runnerKind: "local_device",
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      idempotencyKey: randomUUID(),
      initialPullRequestReviewId: created.id,
      bindInitialPullRequestReviewWithClient: async (client, executionId) => {
        const bound = await repository.bindPullRequestReviewExecutionWithClient(
          client,
          actor,
          {
            reviewId: created.id,
            executionId,
            agentId: agent.agent.id,
            runnerDeploymentId: deploymentId,
            runnerDeviceId: deviceId,
            projectId: null
          }
        );
        if (!bound) throw new Error("PR execution binding failed");
      }
    });
    await repository.addPersonalAgentParticipant(actor, {
      conversationId: managedStart.execution.id,
      agentId: agent.agent.id,
      makeActive: true
    });
    const job = await repository.createPersonalAgentExecutionJob(actor, {
      conversationId: managedStart.execution.id,
      commandId: managedStart.command.id,
      attribution: {
        kind: "agent",
        agentId: agent.agent.id,
        agentVersion: agent.agent.currentVersion
      },
      projectId: null
    });
    const leaseToken = randomUUID();
    await pool.query(
      "update managed_conversation_executions set state='running',runner_id=$2,runner_lease_expires_at=now()+interval '5 minutes',logical_session_id=$3,provider_thread_id=$4,started_at=now() where id=$1 and owner_user_id=$5",
      [
        managedStart.execution.id,
        runnerId,
        randomUUID(),
        `itest-${randomUUID()}`,
        ownerId
      ]
    );
    await pool.query(
      "update managed_conversation_commands set state='dispatching',lease_token=$2,lease_expires_at=now()+interval '5 minutes',dispatching_at=now() where id=$1 and owner_user_id=$3",
      [managedStart.command.id, leaseToken, ownerId]
    );
    const attempt = await repository.createPersonalAgentExecutionAttempt(
      actor,
      {
        jobId: job.id,
        commandId: managedStart.command.id,
        attemptNumber: 1,
        attribution: {
          kind: "agent",
          agentId: agent.agent.id,
          agentVersion: agent.agent.currentVersion
        },
        provider: "codex",
        model: "test-model",
        aiClientInstanceId: "codex.default",
        reasoningEffort: null,
        permissionMode: "supervised",
        managedExecutionId: managedStart.execution.id,
        managedExecutionGeneration: managedStart.execution.executionGeneration,
        status: "running",
        outcome: null,
        startedAt: new Date().toISOString(),
        completedAt: null
      }
    );
    await repository.completePersonalAgentExecutionAttempt({
      actor,
      jobId: job.id,
      attemptId: attempt.id,
      outcome: "succeeded",
      eventId: randomUUID()
    });

    const findings = [
      {
        path: "src/widget.ts",
        line: 17,
        side: "RIGHT" as const,
        body: "Agent inline finding"
      }
    ];
    const proofInput = {
      ownerUserId: ownerId,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      reviewId: created.id,
      executionId: managedStart.execution.id,
      executionGeneration: managedStart.execution.executionGeneration,
      commandId: managedStart.command.id,
      leaseToken,
      agentJobId: job.id,
      baseSha: created.expectedBaseSha,
      headSha: created.expectedHeadSha,
      result: {
        event: "COMMENT" as const,
        body: "Agent review draft",
        findings
      }
    };
    await pool.query(
      "update managed_conversation_commands set lease_expires_at=now()-interval '1 second' where id=$1 and owner_user_id=$2",
      [managedStart.command.id, ownerId]
    );
    expect(
      await repository.markPullRequestReviewCompleted(proofInput)
    ).toBeNull();
    await pool.query(
      "update managed_conversation_commands set lease_expires_at=now()+interval '5 minutes' where id=$1 and owner_user_id=$2",
      [managedStart.command.id, ownerId]
    );
    expect(
      await repository.markPullRequestReviewCompleted({
        ...proofInput,
        agentJobId: randomUUID()
      })
    ).toBeNull();
    expect(
      await repository.markPullRequestReviewCompleted({
        ...proofInput,
        executionGeneration: managedStart.execution.executionGeneration + 1
      })
    ).toBeNull();
    expect(
      await repository.markPullRequestReviewCompleted({
        ...proofInput,
        runnerDeviceId: randomUUID()
      })
    ).toBeNull();
    const prematureProof = await pool.query<{
      reviewed_base_sha: string | null;
      reviewed_head_sha: string | null;
      draft_revision: number;
    }>(
      "select reviewed_base_sha,reviewed_head_sha,draft_revision from pull_request_reviews where id=$1 and owner_user_id=$2",
      [created.id, ownerId]
    );
    expect(prematureProof.rows[0]).toEqual({
      reviewed_base_sha: null,
      reviewed_head_sha: null,
      draft_revision: 0
    });
    const agentDraft =
      await repository.markPullRequestReviewCompleted(proofInput);
    expect(agentDraft).toMatchObject({
      origin: "agent",
      body: "Agent review draft",
      findings
    });
    const storedDraft = await pool.query<{ encrypted_payload: object }>(
      "select encrypted_payload from pull_request_review_drafts where review_id=$1 and owner_user_id=$2 and revision=1",
      [created.id, ownerId]
    );
    expect(JSON.stringify(storedDraft.rows[0])).not.toContain(
      "Agent review draft"
    );
    expect(JSON.stringify(storedDraft.rows[0])).not.toContain(
      "Agent inline finding"
    );

    const provenReview = (await repository.getPullRequestReview(actor, {
      reviewId: created.id
    }))!;
    const ownerFindings = [
      { ...findings[0]!, body: "Owner confirmed exact finding" }
    ];
    const editedDraft = await repository.savePullRequestReviewDraft(actor, {
      reviewId: created.id,
      expectedReviewRevision: provenReview.revision,
      expectedDraftRevision: agentDraft!.revision,
      executionGeneration: managedStart.execution.executionGeneration,
      accountId: provenReview.account.id,
      connectionGeneration: provenReview.connectionGeneration,
      baseSha: provenReview.expectedBaseSha,
      headSha: provenReview.expectedHeadSha,
      event: "REQUEST_CHANGES",
      body: "Owner confirmed review text",
      findings: ownerFindings
    });
    const beforeFreeze = (await repository.getPullRequestReview(actor, {
      reviewId: created.id
    }))!;
    const initialFrozenReview = await repository.freezePullRequestReviewDraft(
      actor,
      {
        reviewId: created.id,
        expectedReviewRevision: beforeFreeze.revision,
        expectedDraftRevision: editedDraft.revision,
        accountId: beforeFreeze.account.id,
        connectionGeneration: beforeFreeze.connectionGeneration,
        baseSha: beforeFreeze.expectedBaseSha,
        headSha: beforeFreeze.expectedHeadSha
      }
    );
    expect(initialFrozenReview.body).toBe(
      `Owner confirmed review text\n\n<!-- koed-review:${initialFrozenReview.id} -->`
    );
    expect(initialFrozenReview.findings).toEqual(ownerFindings);
    const frozenContent = {
      id: initialFrozenReview.id,
      reviewId: initialFrozenReview.reviewId,
      draftRevision: initialFrozenReview.draftRevision,
      accountId: initialFrozenReview.accountId,
      connectionGeneration: initialFrozenReview.connectionGeneration,
      baseSha: initialFrozenReview.baseSha,
      headSha: initialFrozenReview.headSha,
      event: initialFrozenReview.event,
      body: initialFrozenReview.body,
      findings: initialFrozenReview.findings
    };
    expect(initialFrozenReview.digest).toBe(
      createHash("sha256").update(JSON.stringify(frozenContent)).digest("hex")
    );
    expect(
      await repository.getLatestFrozenPullRequestReview(actor, {
        reviewId: created.id
      })
    ).toEqual(initialFrozenReview);
    expect(
      await repository.getLatestFrozenPullRequestReview(
        { userId: otherOwnerId },
        { reviewId: created.id }
      )
    ).toBeNull();
    const beforePostFreezeEdit = (await repository.getPullRequestReview(actor, {
      reviewId: created.id
    }))!;
    const stalePublish = await repository.enqueuePullRequestOperation(actor, {
      requestId: randomUUID(),
      targetDeviceId: deviceId,
      targetDeploymentId: deploymentId,
      payload: {
        kind: "publish_review",
        reviewId: created.id,
        frozenReviewId: initialFrozenReview.id,
        confirmationDigest: initialFrozenReview.digest,
        expectedReviewRevision: beforePostFreezeEdit.revision
      }
    });
    const postFreezeEdit = await repository.savePullRequestReviewDraft(actor, {
      reviewId: created.id,
      expectedReviewRevision: beforePostFreezeEdit.revision,
      expectedDraftRevision: editedDraft.revision,
      executionGeneration: managedStart.execution.executionGeneration,
      accountId: beforePostFreezeEdit.account.id,
      connectionGeneration: beforePostFreezeEdit.connectionGeneration,
      baseSha: beforePostFreezeEdit.expectedBaseSha,
      headSha: beforePostFreezeEdit.expectedHeadSha,
      event: "REQUEST_CHANGES",
      body: "Owner revised after preview",
      findings: ownerFindings
    });
    const afterPostFreezeEdit = (await repository.getPullRequestReview(actor, {
      reviewId: created.id
    }))!;
    const frozenReview = await repository.freezePullRequestReviewDraft(actor, {
      reviewId: created.id,
      expectedReviewRevision: afterPostFreezeEdit.revision,
      expectedDraftRevision: postFreezeEdit.revision,
      accountId: afterPostFreezeEdit.account.id,
      connectionGeneration: afterPostFreezeEdit.connectionGeneration,
      baseSha: afterPostFreezeEdit.expectedBaseSha,
      headSha: afterPostFreezeEdit.expectedHeadSha
    });
    expect(frozenReview.body).toContain("Owner revised after preview");
    expect(
      await repository.getLatestFrozenPullRequestReview(actor, {
        reviewId: created.id
      })
    ).toEqual(frozenReview);
    const afterFreeze = (await repository.getPullRequestReview(actor, {
      reviewId: created.id
    }))!;
    expect(
      await repository.claimPullRequestOperations({
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId,
        limit: 1,
        leaseMs: 60_000
      })
    ).toHaveLength(0);
    expect(
      (
        await repository.getPullRequestOperation(actor, {
          operationId: stalePublish.id
        })
      )?.state
    ).toBe("failed");
    const staleFreezeState = await pool.query<{ state: string }>(
      "select state from pull_request_review_freezes where id=$1 and owner_user_id=$2",
      [initialFrozenReview.id, ownerId]
    );
    expect(staleFreezeState.rows[0]?.state).toBe("frozen");
    const publish = await repository.enqueuePullRequestOperation(actor, {
      requestId: randomUUID(),
      targetDeviceId: deviceId,
      targetDeploymentId: deploymentId,
      payload: {
        kind: "publish_review",
        reviewId: created.id,
        frozenReviewId: frozenReview.id,
        confirmationDigest: frozenReview.digest,
        expectedReviewRevision: afterFreeze.revision
      }
    });
    const writeClaims = await repository.claimPullRequestOperations({
      ownerUserId: ownerId,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      runnerId,
      limit: 1,
      leaseMs: 60_000
    });
    expect(writeClaims).toHaveLength(1);
    expect(writeClaims[0]!.operation.id).toBe(publish.id);
    expect(
      await repository.claimPullRequestOperations({
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId,
        limit: 1,
        leaseMs: 60_000
      })
    ).toHaveLength(0);
    await repository.failPullRequestOperation({
      operationId: publish.id,
      ownerUserId: ownerId,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      runnerId,
      leaseToken: writeClaims[0]!.leaseToken,
      state: "uncertain",
      errorCode: "transport_timeout"
    });
    expect(
      await repository.claimPullRequestOperations({
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId,
        limit: 1,
        leaseMs: 60_000
      })
    ).toHaveLength(0);
    const reconcile = await repository.enqueuePullRequestOperation(actor, {
      requestId: randomUUID(),
      targetDeviceId: deviceId,
      targetDeploymentId: deploymentId,
      payload: {
        kind: "reconcile_review",
        reviewId: created.id,
        frozenReviewId: frozenReview.id,
        uncertainOperationId: publish.id
      }
    });
    const reconcileClaim = (
      await repository.claimPullRequestOperations({
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId,
        limit: 1,
        leaseMs: 60_000
      })
    )[0]!;
    const commentsDigest = createHash("sha256")
      .update(JSON.stringify(frozenReview.findings))
      .digest("hex");
    await repository.completePullRequestOperation({
      operationId: reconcile.id,
      ownerUserId: ownerId,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      runnerId,
      leaseToken: reconcileClaim.leaseToken,
      result: {
        confirmed: true,
        uncertainOperationId: publish.id,
        frozenReviewId: frozenReview.id,
        reviewId: created.id,
        frozenDigest: frozenReview.digest,
        body: frozenReview.body,
        headSha: frozenReview.headSha,
        event: frozenReview.event,
        commentsDigest,
        githubReviewId: "gh-review-101"
      }
    });
    expect(
      (
        await repository.getPullRequestOperation(actor, {
          operationId: publish.id
        })
      )?.state
    ).toBe("completed");
    expect(
      (await repository.getPullRequestReview(actor, { reviewId: created.id }))
        ?.status
    ).toBe("published");

    const readyReview = (await repository.getPullRequestReview(actor, {
      reviewId: created.id
    }))!;
    const preparePush = await repository.enqueuePullRequestOperation(actor, {
      requestId: randomUUID(),
      targetDeviceId: deviceId,
      targetDeploymentId: deploymentId,
      payload: {
        kind: "prepare_push",
        reviewId: created.id,
        expectedRevision: readyReview.revision
      }
    });
    const prepareClaim = (
      await repository.claimPullRequestOperations({
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId,
        limit: 1,
        leaseMs: 60_000
      })
    )[0]!;
    const commitSha = "c".repeat(40),
      diffDigest = "e".repeat(64);
    await repository.completePullRequestOperation({
      operationId: preparePush.id,
      ownerUserId: ownerId,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      runnerId,
      leaseToken: prepareClaim.leaseToken,
      result: {
        proposalVersion: 1,
        reviewId: created.id,
        executionId: managedStart.execution.id,
        executionGeneration: managedStart.execution.executionGeneration,
        account: readyReview.account,
        connectionGeneration: readyReview.connectionGeneration,
        repository: readyReview.repository,
        headRepository: { id: "repo-7", fullName: "acme/widget" },
        headBranch: "feature/pr-authority",
        remoteSha: readyReview.expectedHeadSha,
        checkoutHead: readyReview.expectedHeadSha,
        treeSha: "f".repeat(40),
        diff: "private confirmed patch",
        diffDigest,
        commitSha
      }
    });
    const afterPrepare = (await repository.getPullRequestReview(actor, {
      reviewId: created.id
    }))!;
    const staleGenerationPush = await repository.enqueuePullRequestOperation(
      actor,
      {
        requestId: randomUUID(),
        targetDeviceId: deviceId,
        targetDeploymentId: deploymentId,
        payload: {
          kind: "push",
          reviewId: created.id,
          pushProposalId: preparePush.id,
          confirmationDigest: diffDigest,
          expectedReviewRevision: afterPrepare.revision
        }
      }
    );
    await pool.query(
      "update managed_conversation_executions set execution_generation=execution_generation+1 where id=$1 and owner_user_id=$2",
      [managedStart.execution.id, ownerId]
    );
    expect(
      await repository.claimPullRequestOperations({
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId,
        limit: 1,
        leaseMs: 60_000
      })
    ).toHaveLength(0);
    expect(
      (
        await repository.getPullRequestOperation(actor, {
          operationId: staleGenerationPush.id
        })
      )?.state
    ).toBe("failed");
    const proposalDispatchState = await pool.query<{
      write_dispatched: boolean;
    }>("select write_dispatched from pull_request_operations where id=$1", [
      preparePush.id
    ]);
    expect(proposalDispatchState.rows[0]?.write_dispatched).toBe(false);
    await pool.query(
      "update managed_conversation_executions set execution_generation=$3 where id=$1 and owner_user_id=$2",
      [
        managedStart.execution.id,
        ownerId,
        managedStart.execution.executionGeneration
      ]
    );
    const push = await repository.enqueuePullRequestOperation(actor, {
      requestId: randomUUID(),
      targetDeviceId: deviceId,
      targetDeploymentId: deploymentId,
      payload: {
        kind: "push",
        reviewId: created.id,
        pushProposalId: preparePush.id,
        confirmationDigest: diffDigest,
        expectedReviewRevision: afterPrepare.revision
      }
    });
    const pushClaim = (
      await repository.claimPullRequestOperations({
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId,
        limit: 1,
        leaseMs: 60_000
      })
    )[0]!;
    expect(pushClaim.operation.id).toBe(push.id);
    await repository.failPullRequestOperation({
      operationId: push.id,
      ownerUserId: ownerId,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      runnerId,
      leaseToken: pushClaim.leaseToken,
      state: "uncertain",
      errorCode: "push_response_lost"
    });
    expect(
      await repository.claimPullRequestOperations({
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId,
        limit: 1,
        leaseMs: 60_000
      })
    ).toHaveLength(0);
    const badReconcile = await repository.enqueuePullRequestOperation(actor, {
      requestId: randomUUID(),
      targetDeviceId: deviceId,
      targetDeploymentId: deploymentId,
      payload: {
        kind: "reconcile_push",
        reviewId: created.id,
        pushProposalId: preparePush.id,
        uncertainOperationId: push.id
      }
    });
    const badClaim = (
      await repository.claimPullRequestOperations({
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId,
        limit: 1,
        leaseMs: 60_000
      })
    )[0]!;
    await repository.completePullRequestOperation({
      operationId: badReconcile.id,
      ownerUserId: ownerId,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      runnerId,
      leaseToken: badClaim.leaseToken,
      result: {
        confirmed: true,
        uncertainOperationId: push.id,
        pushProposalId: preparePush.id,
        reviewId: created.id,
        proposedCommitSha: "d".repeat(40),
        remoteHeadSha: "d".repeat(40),
        diffDigest
      }
    });
    expect(
      (
        await repository.getPullRequestOperation(actor, {
          operationId: push.id
        })
      )?.state
    ).toBe("uncertain");
    const goodReconcile = await repository.enqueuePullRequestOperation(actor, {
      requestId: randomUUID(),
      targetDeviceId: deviceId,
      targetDeploymentId: deploymentId,
      payload: {
        kind: "reconcile_push",
        reviewId: created.id,
        pushProposalId: preparePush.id,
        uncertainOperationId: push.id
      }
    });
    const goodClaim = (
      await repository.claimPullRequestOperations({
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId,
        limit: 1,
        leaseMs: 60_000
      })
    )[0]!;
    await repository.completePullRequestOperation({
      operationId: goodReconcile.id,
      ownerUserId: ownerId,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      runnerId,
      leaseToken: goodClaim.leaseToken,
      result: {
        confirmed: true,
        uncertainOperationId: push.id,
        pushProposalId: preparePush.id,
        reviewId: created.id,
        proposedCommitSha: commitSha,
        remoteHeadSha: commitSha,
        diffDigest
      }
    });
    expect(
      (
        await repository.getPullRequestOperation(actor, {
          operationId: push.id
        })
      )?.state
    ).toBe("completed");
    const encryptedProposal = await pool.query<{ encrypted_result: object }>(
      "select encrypted_result from pull_request_operations where id=$1",
      [preparePush.id]
    );
    expect(JSON.stringify(encryptedProposal.rows[0])).not.toContain(
      "private confirmed patch"
    );

    await pool.query(
      "update pull_request_operations set updated_at='2025-01-01T00:00:00.000000Z' where owner_user_id=$1",
      [ownerId]
    );
    await pool.query(
      "update pull_request_operations set updated_at='2026-10-02T08:00:00.123456Z' where id=$1",
      [detailsOperation.id]
    );
    await pool.query(
      "update pull_request_operations set updated_at='2026-10-02T08:00:00.123987Z' where id=$1",
      [stalePublish.id]
    );
    const operationPage1 = await repository.listPullRequestOperations(actor, {
      limit: 1
    });
    expect(operationPage1.operations[0]?.id).toBe(stalePublish.id);
    expect(operationPage1.nextCursor).toMatch(
      /2026-10-02T08:00:00\.123987Z\.[0-9a-f-]{36}/u
    );
    const operationPage2 = await repository.listPullRequestOperations(actor, {
      limit: 1,
      before: operationPage1.nextCursor
    });
    expect(operationPage2.operations[0]?.id).toBe(detailsOperation.id);
    const foreignOperationCursorTime = await pool.query<{ cursor: string }>(
      `select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '.' || id as cursor from pull_request_operations where id=$1 and owner_user_id=$2`,
      [foreignDetails.id, otherOwnerId]
    );
    await expect(
      repository.listPullRequestOperations(actor, {
        before: foreignOperationCursorTime.rows[0]!.cursor
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    const decoyDetailsOperations: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const number = 100 + index;
      const operation = await repository.enqueuePullRequestOperation(actor, {
        requestId: randomUUID(),
        targetDeviceId: deviceId,
        targetDeploymentId: deploymentId,
        payload: {
          kind: "pull_request_details",
          account: { id: "42", login: "reviewer" },
          connectionGeneration: 3,
          repository: {
            id: "repo-7",
            owner: "acme",
            name: "widget",
            fullName: "acme/widget"
          },
          pullRequestNumber: number
        }
      });
      decoyDetailsOperations.push(operation.id);
    }
    let completedDecoyDetails = 0;
    while (completedDecoyDetails < decoyDetailsOperations.length) {
      const batch = await repository.claimPullRequestOperations({
        ownerUserId: ownerId,
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        runnerId,
        limit: 32,
        leaseMs: 60_000
      });
      expect(batch.length).toBeGreaterThan(0);
      for (const item of batch) {
        const number = 100 + decoyDetailsOperations.indexOf(item.operation.id);
        await repository.completePullRequestOperation({
          operationId: item.operation.id,
          ownerUserId: ownerId,
          runnerDeploymentId: deploymentId,
          runnerDeviceId: deviceId,
          runnerId,
          leaseToken: item.leaseToken,
          result: {
            account: { id: "42", login: "reviewer" },
            connectionGeneration: 3,
            repository: {
              id: "repo-7",
              owner: "acme",
              name: "widget",
              fullName: "acme/widget"
            },
            pullRequestNumber: number,
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            title: `Decoy pull request ${number}`
          }
        });
        completedDecoyDetails += 1;
      }
    }
    for (const operationId of decoyDetailsOperations) {
      const operation = await repository.getPullRequestOperation(actor, {
        operationId
      });
      expect(operation?.payload.kind).toBe("pull_request_details");
      if (operation?.payload.kind !== "pull_request_details") continue;
      await repository.createPullRequestReview(actor, {
        requestId: randomUUID(),
        detailsOperationId: operation.id,
        agentId: agent.agent.id
      });
    }
    await pool.query(
      "update pull_request_reviews set updated_at='2026-10-01T00:00:00.000000Z' where owner_user_id=$1 and id=$2",
      [ownerId, created.id]
    );
    const olderScoped = await repository.listPullRequestReviews(actor, {
      limit: 1,
      repositoryId: "repo-7",
      pullRequestNumber: 11,
      agentId: agent.agent.id
    });
    expect(olderScoped.reviews.map((item) => item.id)).toEqual([created.id]);
    const foreignReviewCursorTime = await pool.query<{ cursor: string }>(
      `select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '.' || id as cursor from pull_request_reviews where id=$1 and owner_user_id=$2`,
      [foreignReview.id, otherOwnerId]
    );
    await expect(
      repository.listPullRequestReviews(actor, {
        before: foreignReviewCursorTime.rows[0]!.cursor
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    await pool.query(
      "update pull_request_reviews set updated_at=case when id=$2 then '2026-10-02T08:00:00.123987Z'::timestamptz else '2026-10-02T08:00:00.123456Z'::timestamptz end where owner_user_id=$1 and id in ($2,$3)",
      [ownerId, alternateReview.id, created.id]
    );
    const reviewPage1 = await repository.listPullRequestReviews(actor, {
      limit: 1,
      repositoryId: "repo-7",
      pullRequestNumber: 11
    });
    expect(reviewPage1.reviews[0]?.id).toBe(alternateReview.id);
    expect(reviewPage1.nextCursor).toMatch(
      /2026-10-02T08:00:00\.123987Z\.[0-9a-f-]{36}/u
    );
    const reviewPage2 = await repository.listPullRequestReviews(actor, {
      limit: 1,
      before: reviewPage1.nextCursor,
      repositoryId: "repo-7",
      pullRequestNumber: 11
    });
    expect(reviewPage2.reviews[0]?.id).toBe(created.id);
  });
});
