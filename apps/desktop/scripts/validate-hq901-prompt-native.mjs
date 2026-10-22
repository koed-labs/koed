import process from "node:process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { app } from "electron";
import { personalCatchUpInput } from "../../api/dist/projects/project-catch-up.js";
import {
  resolveCuratedMemoryReviewConfig,
  reviewCuratedMemoryProposal
} from "../../../packages/mcp-server/dist/curated-memory-review-worker.js";
import { probeManagedConversationProviderPrompt } from "../../worker/dist/managed-conversation-prompt-probe.js";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_PROMPT_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated prompt-proof Native profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

async function run() {
  await app.whenReady();
  const home = await mkdtemp(resolve(scratch, "hq901-prompt-runtime-"));
  try {
    // Simulated Team IPC store: the positive read establishes that this is a
    // populated human-only channel, separate from every Personal prompt source.
    const teamMessages = [
      { id: randomUUID(), text: "HQ901_PRIVATE_TEAM_SENTINEL" }
    ];
    const teamIpc = { listMessages: async () => teamMessages };
    const present = await teamIpc.listMessages();
    assert.equal(present.length, 1);
    const sentinel = present[0].text;
    const ownerUserId = randomUUID();
    const projectId = randomUUID();
    const now = new Date().toISOString();
    const captured = {};
    const catchUp = personalCatchUpInput({
      ownerUserId,
      projectId,
      seenCursor: "before",
      highWater: "after",
      events: [
        {
          cursor: "after",
          kind: "source_ready",
          attemptId: randomUUID(),
          sourceId: randomUUID(),
          name: "Personal Plan.md",
          at: now
        }
      ],
      teamWindow: {
        teamBackendId: "fixture-team",
        workspaceProjectId: randomUUID(),
        teamPrincipalUserId: ownerUserId,
        memberId: randomUUID(),
        projectVersion: 1,
        memberVersion: 1,
        seenCursor: "1",
        highCursor: "2",
        welcomeDue: false,
        events: [{ kind: "source_added", ref: randomUUID(), at: now }],
        messages: present
      }
    });
    captured.catchUp = catchUp.instruction;
    assert.ok(captured.catchUp.includes("Personal Plan.md"));
    assert.ok(!captured.catchUp.includes(sentinel));

    const evidenceId = randomUUID();
    await reviewCuratedMemoryProposal(
      {
        proposal: {
          id: randomUUID(),
          proposedClaim: "Prefers window seats",
          proposedTopic: "Travel",
          rationale: "Personal preference",
          tags: [],
          sensitivityHint: "normal",
          expiresAt: null,
          operation: "store",
          targetAssertionId: null,
          attemptCount: 1
        },
        evidence: [
          {
            sourceType: "conversation_item",
            sourceId: evidenceId,
            sourceHash: "fixture-personal-hash",
            text: "I prefer window seats.",
            occurredAt: now,
            sessionId: randomUUID(),
            metadata: { sourceEventType: "user_message" }
          }
        ],
        rejectedSourceCount: 0,
        currentAssertions: [],
        teamMessages: present
      },
      resolveCuratedMemoryReviewConfig(
        {},
        {
          model: "gpt-test",
          timeoutMs: 1000,
          maxAttempts: 1,
          maxPromptTokens: 24000
        }
      ),
      async (prompt) => {
        captured.proposal = prompt;
        return {
          text: JSON.stringify({
            outcome: "rejected",
            reason_category: "not_user_authored",
            decision_reason: "Fixture decision; input was inspected."
          }),
          model: "gpt-test"
        };
      }
    );
    assert.ok(captured.proposal.includes("I prefer window seats."));
    assert.ok(!captured.proposal.includes(sentinel));

    const executionId = randomUUID();
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const providerThreadId = randomUUID();
    const commandId = randomUUID();
    const execution = {
      id: executionId,
      ownerUserId,
      projectId,
      provider: "codex",
      aiClientInstanceId: "codex.default",
      model: "gpt-test",
      reasoningEffort: "low",
      permissionMode: "supervised",
      runnerKind: "local_device",
      state: "running",
      stateVersion: 2,
      executionGeneration: 1,
      runnerDeploymentId: deploymentId,
      runnerDeviceId: deviceId,
      runnerId: null,
      runnerLeaseExpiresAt: null,
      logicalSessionId: randomUUID(),
      providerThreadId,
      providerCliVersion: null,
      sourceGenerationId: null,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      quiescedAt: null,
      stoppedAt: null
    };
    const command = {
      id: commandId,
      ownerUserId,
      executionId,
      executionGeneration: 1,
      commandKind: "prompt",
      sequence: 1,
      attempts: 1,
      leaseToken: randomUUID(),
      clientUserMessageId: randomUUID(),
      payload: {
        prompt: "Summarize my Personal Project work",
        teamMessages: present
      },
      execution
    };
    const probeInput = {
      command,
      binding: {
        executionId,
        ownerUserId,
        deploymentId,
        deviceId,
        executionGeneration: 1,
        sourceProjectPath: home,
        projectPath: home,
        checkoutId: randomUUID(),
        checkoutKind: "user_managed_checkout",
        checkoutLifecycle: "ready",
        cleanupState: "not_requested",
        vcsDriver: null,
        localRepositoryCommonDirectory: null,
        localGitDirectory: null,
        repositoryIdentityHash: null,
        worktreeIdentityHash: null,
        baseRef: null,
        baseObjectId: null,
        branchRef: null,
        headObjectId: null,
        creationOperationId: randomUUID(),
        localSessionId: randomUUID(),
        providerThreadId,
        transcriptPath: resolve(home, "transcript.jsonl"),
        managedHome: home,
        providerCliVersion: null,
        sourceGenerationId: null,
        createdAt: now,
        updatedAt: now
      },
      baseline: {
        commandId,
        checkpointKind: "baseline",
        checkpointStatus: "ready"
      },
      teamMessageTexts: [sentinel],
      koedHome: home
    };
    const observed = await probeManagedConversationProviderPrompt(probeInput);
    captured.agentTurn = observed.prompt;
    assert.ok(captured.agentTurn.includes(command.payload.prompt));
    assert.ok(!captured.agentTurn.includes(sentinel));
    const catchUpCommandId = randomUUID();
    const catchUpObserved = await probeManagedConversationProviderPrompt({
      ...probeInput,
      command: {
        ...command,
        id: catchUpCommandId,
        payload: { prompt: catchUp.instruction, teamMessages: present }
      },
      baseline: { ...probeInput.baseline, commandId: catchUpCommandId }
    });
    captured.catchUp = catchUpObserved.prompt;
    assert.ok(captured.catchUp.includes("Personal Plan.md"));
    assert.ok(!captured.catchUp.includes(sentinel));
    const output = resolve(scratch, "hq-901-prompts");
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          status: "pass",
          scope: "simulated-ipc",
          proofIds: [
            "N1.S.catch-up-input",
            "N1.S.proposal-input",
            "N1.S.agent-turn-input"
          ],
          teamMessagePositiveControl: present.length,
          capturedInputs: captured
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

void run().then(
  () => app.quit(),
  (error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
    app.exit(1);
  }
);
