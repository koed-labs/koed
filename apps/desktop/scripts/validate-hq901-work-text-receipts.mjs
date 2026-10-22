import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { storeDesktopLocalCredential } from "@koed/shared";
import { createKoedTextActionObserver } from "../../../apps/worker/dist/koed-text-action-observer.js";
import { createWorkItemCompletionObserver } from "../../../apps/worker/dist/work-item-completion.js";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(root, "scratch/hq-901-work-text-receipts");
await mkdir(output, { recursive: true });
const koedHome = await mkdtemp(resolve(root, "scratch/hq901-text-home-"));
try {
  const ownerUserId = randomUUID();
  const executionId = randomUUID();
  const commandId = randomUUID();
  const leaseToken = randomUUID();
  const projectId = randomUUID();
  storeDesktopLocalCredential(koedHome, {
    ownerUserId,
    operationFamilies: ["personal_collaboration_write", "managed_execution"]
  });
  let currentPrompt = "";
  const deliveries = [];
  const observer = createKoedTextActionObserver({
    repository: {
      getManagedConversationCommand: async () => ({
        ownerUserId,
        executionId,
        commandKind: "prompt",
        executionGeneration: 2,
        state: "dispatching",
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        payload: { prompt: currentPrompt }
      })
    },
    apiUrl: "http://127.0.0.1:32123",
    koedHome,
    fetch: async (_url, init) => {
      deliveries.push(JSON.parse(String(init.body)));
      return new globalThis.Response('{"status":"recorded"}', { status: 202 });
    }
  });
  const scenarios = [
    {
      prompt: "Add a reminder to check mobile spacing",
      title: "Check mobile spacing",
      toolCallId: "offered-accepted"
    },
    {
      prompt: "Add problem set 4 by Friday",
      title: "Problem set 4",
      toolCallId: "typed-add"
    },
    {
      prompt: "Turn Plan.md into to-dos",
      title: "Draft release notes",
      toolCallId: "document-1"
    },
    {
      prompt: "Turn Plan.md into to-dos",
      title: "Review mobile spacing",
      toolCallId: "document-2"
    },
    {
      prompt: "Turn Plan.md into to-dos",
      title: "Prepare launch checklist",
      toolCallId: "document-3"
    }
  ];
  for (const scenario of scenarios) {
    currentPrompt = scenario.prompt;
    assert.equal(
      await observer({
        execution: { id: executionId, ownerUserId, executionGeneration: 2 },
        command: { id: commandId, leaseToken },
        providerTurnId: `turn-${scenario.toolCallId}`,
        toolCallId: scenario.toolCallId,
        toolName: "koed_todo_add",
        arguments: { projectId, title: scenario.title },
        result: { structuredContent: { status: "requested" } }
      }),
      true
    );
  }
  assert.deepEqual(
    deliveries.map((row) => row.toolCallId),
    scenarios.map((row) => row.toolCallId)
  );
  assert.ok(
    deliveries.every(
      (row) =>
        row.commandId === commandId &&
        row.leaseToken === leaseToken &&
        row.name === "koed_todo_add"
    )
  );
  assert.deepEqual(
    deliveries.slice(2).map((row) => row.arguments.title),
    scenarios.slice(2).map((row) => row.title)
  );

  let completed = 0;
  const runtime = [];
  const complete = createWorkItemCompletionObserver({
    completeForManagedExecutionLease: async (selector) => {
      assert.deepEqual(selector, {
        ownerUserId,
        executionId,
        commandId,
        leaseToken
      });
      completed++;
      return {};
    },
    putManagedConversationRuntimeItem: async (_actor, item) => {
      runtime.push(item);
      return {};
    }
  });
  assert.equal(
    await complete({
      execution: { id: executionId, ownerUserId, executionGeneration: 2 },
      command: { id: commandId, leaseToken },
      providerTurnId: "no-pr-turn",
      toolCallId: "no-pr-complete",
      toolName: "work_item_complete",
      arguments: {},
      result: { structuredContent: { status: "requested" } }
    }),
    true
  );
  assert.equal(completed, 1);
  assert.equal(runtime[0].payload.text, "Work Item completion accepted.");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        id: "HQ901.work-text-receipts",
        status: "pass",
        proofIds: [
          "S06.1.offered-typed-document-tool-receipts",
          "S10.1.typed-todo-and-no-pr-complete-receipts"
        ],
        scope:
          "production leased worker observers with simulated loopback API receipt; persistence/rendering covered separately"
      },
      null,
      2
    ) + "\n"
  );
} finally {
  await rm(koedHome, { recursive: true, force: true });
}
