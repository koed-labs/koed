import assert from "node:assert/strict";
import test from "node:test";
// prettier-ignore
// @ts-expect-error -- Node's native test runner needs the source extension.
import { cancelHostedProjectMove, cancelLocalProjectMove, cancelHostedQueuedPrompt, cancelHostedConversationStart, deleteLocalRetainedManagedWorktree, HostedManagedChatError, hasMeaningfulHostedApprovalDetails, hostedActiveAgentAttribution, hostedLaunchInstancesForDevice, hostedLaunchSelectionForOptions, hostedMessagesForSelection, hostedMessagesWithTransientOutput, hostedPromptOutcomeIsUncertain, hostedRecoveryBackendId, hostedRecoveryDisposition, hostedRecoveryGuardForSelection, hostedRecoverySelectionIsCurrent, hostedNewStartPromptForVerifiedScope, listHostedManagedConversations, loadHostedLaunchOptions, loadHostedManagedConversation, loadHostedManagedConversationAccess, loadHostedRecallFeedback, updateHostedRecallFeedback, loadLatestHostedProjectMove, loadLatestLocalProjectMove, loadLocalRetainedWorkspaces, lookupHostedConversationRecovery, openLocalRetainedWorkspace, parseHostedConversationState, queueHostedConversationPrompt, requestHostedConversationControl, requestHostedProjectMove, requestLocalProjectMove, respondToHostedRuntimeItem, startHostedManagedConversation } from "./hosted-managed-chats.ts";

const id = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const execution = {
  id,
  provider: "codex",
  aiClientInstanceId: "codex.default",
  model: "gpt-6-sol",
  reasoningEffort: "high",
  permissionMode: "supervised",
  executionGeneration: 3,
  stateVersion: 8,
  state: "running",
  lastErrorCode: null,
  projectId: null,
  runnerKind: "local_device",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:01:00.000Z",
  startedAt: "2026-09-01T10:00:01.000Z",
  stoppedAt: null
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });

test("hosted recall feedback uses the exact answer route and desired-state PUT", async () => {
  const requests: Array<{ path: string; method: string; body?: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({
      path: String(input),
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {})
    });
    return json({
      feedback: {
        rating: "up",
        comment: null,
        updatedAt: "2026-10-01T10:00:00.000Z"
      }
    });
  };
  await loadHostedRecallFeedback(id, `agent:${commandId}`, undefined, fetcher);
  await updateHostedRecallFeedback(
    id,
    `agent:${commandId}`,
    { comment: null },
    undefined,
    fetcher
  );
  assert.deepEqual(requests, [
    {
      path: `/v1/managed-conversations/${id}/recall-feedback/agent%3A${commandId}`,
      method: "GET"
    },
    {
      path: `/v1/managed-conversations/${id}/recall-feedback/agent%3A${commandId}`,
      method: "PUT",
      body: '{"comment":null}'
    }
  ]);
});

test("does not render a pending message from another selected Conversation", () => {
  const oldMessage = {
    id: "old-client-message",
    executionId: "old-execution",
    role: "user" as const,
    content: "T05-CLAIM-RACE",
    createdAt: execution.createdAt,
    author: null,
    commandId,
    commandState: "indeterminate"
  };
  const currentMessage = {
    id: "new-client-message",
    role: "user" as const,
    content: "FINAL-START",
    createdAt: execution.createdAt,
    author: null
  };

  assert.deepEqual(
    hostedMessagesForSelection(
      "new-execution",
      "new-execution",
      [] as Array<{ id: string }>,
      oldMessage
    ),
    []
  );
  assert.deepEqual(
    hostedMessagesForSelection(
      "new-execution",
      "old-execution",
      [currentMessage],
      {
        ...currentMessage,
        executionId: "old-execution",
        commandId,
        commandState: "queued"
      }
    ),
    []
  );
  assert.deepEqual(
    hostedMessagesForSelection(
      "new-execution",
      "new-execution",
      [] as Array<{ id: string }>,
      {
        ...currentMessage,
        executionId: "new-execution",
        commandId,
        commandState: "queued"
      }
    ),
    [
      {
        ...currentMessage,
        executionId: "new-execution",
        commandId,
        commandState: "queued"
      }
    ]
  );
});

test("scopes recovery blocking to the selected Conversation", () => {
  const unresolvedExecutionId = "older-indeterminate-execution";
  const healthyExecutionId = "healthy-execution";
  const checkingExecutionIds = [unresolvedExecutionId];

  assert.deepEqual(
    hostedRecoveryGuardForSelection({
      selectedExecutionId: healthyExecutionId,
      pendingOperationExecutionId: unresolvedExecutionId,
      checkingExecutionIds
    }),
    { hasPendingOperation: false, isChecking: false }
  );
  assert.deepEqual(
    hostedRecoveryGuardForSelection({
      selectedExecutionId: unresolvedExecutionId,
      pendingOperationExecutionId: unresolvedExecutionId,
      checkingExecutionIds
    }),
    { hasPendingOperation: true, isChecking: true }
  );
  assert.deepEqual(
    hostedRecoveryGuardForSelection({
      selectedExecutionId: healthyExecutionId,
      pendingOperationExecutionId: null,
      checkingExecutionIds: []
    }),
    { hasPendingOperation: false, isChecking: false }
  );
});

test("keeps a delayed new-start recovery result from replacing a newly selected Conversation", async () => {
  let selectedExecutionId: string | null = "older-execution";
  let persistedNewStartIdentity: string | null = "accepted-new-start";
  const selectedExecutionAtStart = selectedExecutionId;
  let resolveLookup!: (executionId: string) => void;
  const lookup = new Promise<string>((resolve) => {
    resolveLookup = resolve;
  });

  const reconcile = async () => {
    const recoveredExecutionId = await lookup;
    if (
      !hostedRecoverySelectionIsCurrent(
        selectedExecutionAtStart,
        selectedExecutionId
      )
    )
      return;
    persistedNewStartIdentity = null;
    selectedExecutionId = recoveredExecutionId;
  };
  const pendingReconciliation = reconcile();
  selectedExecutionId = "healthy-execution";
  resolveLookup("recovered-new-start-execution");
  await pendingReconciliation;

  assert.equal(selectedExecutionId, "healthy-execution");
  assert.equal(persistedNewStartIdentity, "accepted-new-start");
});

test("seeds a verified fresh hosted start from handoff draft without replacing recovery or edits", () => {
  const base = {
    handoffDraft: "Discuss the request before starting work.",
    promptWasEdited: false,
    selectedExecutionAtStart: null,
    selectedExecutionNow: null
  };
  assert.equal(
    hostedNewStartPromptForVerifiedScope({ ...base, recoveryRecord: null }),
    base.handoffDraft
  );
  assert.equal(
    hostedNewStartPromptForVerifiedScope({
      ...base,
      recoveryRecord: { draft: "Recovered local draft" }
    }),
    "Recovered local draft"
  );
  assert.equal(
    hostedNewStartPromptForVerifiedScope({
      ...base,
      recoveryRecord: { draft: "" }
    }),
    ""
  );
  assert.equal(
    hostedNewStartPromptForVerifiedScope({
      ...base,
      recoveryRecord: null,
      promptWasEdited: true
    }),
    null
  );
  assert.equal(
    hostedNewStartPromptForVerifiedScope({
      ...base,
      recoveryRecord: null,
      selectedExecutionNow: "another-chat"
    }),
    null
  );
  assert.equal(
    hostedNewStartPromptForVerifiedScope({
      ...base,
      recoveryRecord: null,
      handoffDraft: "x".repeat(9_000)
    })?.length,
    8_000
  );
});

test("shows only the active execution generation's approved transient output and reconciles canonical IDs", () => {
  const history = [
    {
      id: "provider:canonical",
      role: "assistant" as const,
      content: "Canonical answer",
      createdAt: "2026-09-01T10:00:02.000Z",
      author: null,
      providerTurnId: "turn-1",
      providerItemId: "item-1"
    }
  ];
  const runtime: NonNullable<
    Parameters<typeof hostedMessagesWithTransientOutput>[1]
  > = {
    execution: {
      ...execution,
      id,
      executionGeneration: 3,
      permissionMode: "supervised"
    },
    latestCommand: {
      id: commandId,
      commandKind: "prompt",
      state: "running",
      lastErrorCode: null
    },
    items: [
      {
        id: "runtime-1",
        executionGeneration: 3,
        itemKind: "transient_output",
        state: "pending",
        providerTurnId: "turn-1",
        providerItemId: "item-1",
        createdAt: "2026-09-01T10:00:01.000Z",
        updatedAt: "2026-09-01T10:00:03.000Z",
        presentation: {
          mode: "expanded",
          renderer: "message",
          policyKey: "transient_output"
        },
        payload: { text: "Partial answer" }
      }
    ]
  };
  assert.deepEqual(
    hostedMessagesWithTransientOutput(id, runtime, history),
    history
  );
  assert.deepEqual(
    hostedMessagesWithTransientOutput("other-execution", runtime, []),
    []
  );
  const uncertainRuntime = {
    ...runtime,
    latestCommand: {
      id: commandId,
      commandKind: "prompt",
      state: "indeterminate",
      lastErrorCode: null
    }
  };
  const uncertain = hostedMessagesWithTransientOutput(id, uncertainRuntime, []);
  assert.equal(uncertain.length, 1);
  assert.equal(uncertain[0].content, "Partial answer");
  assert.deepEqual(
    hostedMessagesWithTransientOutput(id, uncertainRuntime, history),
    history
  );
  const withheldFooter = hostedMessagesWithTransientOutput(
    id,
    {
      ...uncertainRuntime,
      items: [
        {
          ...uncertainRuntime.items[0]!,
          payload: {
            text: "Visible answer\n<!-- koed-memory-attribution:v1:partial"
          }
        }
      ]
    },
    []
  );
  assert.equal(withheldFooter[0]?.content, "Visible answer");
  const maskedUncertainRuntime = {
    ...runtime,
    hasIndeterminatePrompt: true,
    latestCommand: {
      id: commandId,
      commandKind: "interrupt",
      state: "completed",
      lastErrorCode: null
    }
  };
  const retainedPartial = hostedMessagesWithTransientOutput(
    id,
    maskedUncertainRuntime,
    []
  );
  assert.equal(retainedPartial.length, 1);
  assert.equal(retainedPartial[0].content, "Partial answer");
  assert.deepEqual(
    hostedMessagesWithTransientOutput(
      id,
      {
        ...runtime,
        latestCommand: {
          id: commandId,
          commandKind: "prompt",
          state: "completed",
          lastErrorCode: null
        }
      },
      []
    ),
    []
  );

  const visible = hostedMessagesWithTransientOutput(
    id,
    {
      ...runtime,
      items: [
        {
          ...runtime.items[0],
          providerTurnId: "turn-2",
          providerItemId: "item-2",
          payload: {
            text: "Partial /Users/jacobo/private.txt token=privatevalue"
          }
        }
      ]
    },
    []
  );
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, "transient:runtime-1");
  assert.equal(
    visible[0].content,
    "Partial [local path hidden] token=[redacted]"
  );
  assert.equal(visible[0].providerTurnId, "turn-2");
  assert.equal(visible[0].providerItemId, "item-2");

  assert.deepEqual(
    hostedMessagesWithTransientOutput(
      id,
      {
        ...runtime,
        items: [
          {
            ...runtime.items[0],
            executionGeneration: 2,
            providerTurnId: "old-turn"
          }
        ]
      },
      []
    ),
    []
  );
  assert.deepEqual(
    hostedMessagesWithTransientOutput(
      id,
      {
        ...runtime,
        items: [
          {
            ...runtime.items[0],
            presentation: {
              mode: "hidden",
              renderer: "message",
              policyKey: "transient_output"
            }
          }
        ]
      },
      []
    ),
    []
  );
  assert.deepEqual(
    hostedMessagesWithTransientOutput(
      id,
      {
        ...runtime,
        items: [
          {
            ...runtime.items[0],
            presentation: {
              mode: "expanded",
              renderer: "tool",
              policyKey: "transient_output"
            }
          }
        ]
      },
      []
    ),
    []
  );
});

test("lists only safe execution data using the signed-in same-origin session", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return json({
      executions: [
        { ...execution, path: "/private/device/path", credential: "secret" }
      ]
    });
  };
  const values = await listHostedManagedConversations(undefined, fetcher);
  assert.equal(values.length, 1);
  assert.equal(values[0].id, id);
  assert.equal(values[0].projectId, null);
  assert.equal("path" in values[0], false);
  assert.equal("credential" in values[0], false);
  assert.deepEqual(
    calls.map((call) => call.url),
    ["/v1/managed-conversations?limit=100"]
  );
  assert.equal(calls[0].init?.credentials, "include");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).authorization,
    undefined
  );
});

test("requests and reloads a Project Move without retaining runner-local fields", async () => {
  const moveId = "33333333-3333-4333-8333-333333333333";
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return json({
      move: {
        id: moveId,
        executionId: id,
        executionGeneration: 3,
        sourceProjectId: null,
        destinationProjectId: "target-project",
        state: String(input).endsWith("/cancel") ? "claimed" : "pending",
        createdAt: execution.createdAt,
        updatedAt: execution.updatedAt,
        claimToken: "private-token",
        destinationLocalPath: "/private/path"
      }
    });
  };
  const requested = await requestHostedProjectMove(
    execution,
    "target-project",
    "move-request-key-01",
    undefined,
    fetcher
  );
  assert.equal(requested.state, "pending");
  assert.equal("claimToken" in requested, false);
  assert.equal("destinationLocalPath" in requested, false);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    executionGeneration: 3,
    expectedStateVersion: 8,
    destinationProjectId: "target-project",
    idempotencyKey: "move-request-key-01"
  });
  assert.equal(calls[0].init?.credentials, "include");
  const reloaded = await loadLatestHostedProjectMove(id, undefined, fetcher);
  assert.equal(reloaded?.id, moveId);
  assert.equal(reloaded?.state, "pending");
  const cancelResult = await cancelHostedProjectMove(
    execution,
    moveId,
    undefined,
    fetcher
  );
  assert.equal(cancelResult.state, "claimed");
  assert.equal("claimToken" in cancelResult, false);
});

test("routes Desktop Project Move through the local Studio gateway", async () => {
  const moveId = "33333333-3333-4333-8333-333333333333";
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    paths.push(String(input));
    if (String(input) === "/studio-api/github/session")
      return json({ csrfToken: "review-csrf" });
    if (init?.method === "POST")
      assert.equal(
        new Headers(init.headers).get("x-studio-csrf"),
        "review-csrf"
      );
    return json({
      move: {
        id: moveId,
        executionId: id,
        executionGeneration: 3,
        sourceProjectId: null,
        destinationProjectId: "lp_0123456789abcdef0123456789abcdef",
        state: "pending",
        createdAt: execution.createdAt,
        updatedAt: execution.updatedAt
      }
    });
  };
  await requestLocalProjectMove(
    execution,
    "lp_0123456789abcdef0123456789abcdef",
    "move-request-key-02",
    undefined,
    fetcher
  );
  await loadLatestLocalProjectMove(id, undefined, fetcher);
  await cancelLocalProjectMove(execution, moveId, undefined, fetcher);
  assert.deepEqual(paths, [
    "/studio-api/github/session",
    `/studio-api/managed-conversations/${id}/project-moves`,
    `/studio-api/managed-conversations/${id}/project-moves/latest`,
    "/studio-api/github/session",
    `/studio-api/managed-conversations/${id}/project-moves/${moveId}/cancel`
  ]);
});

test("loads and opens retained workspaces through the local CSRF-protected gateway", async () => {
  const moveId = "33333333-3333-4333-8333-333333333333";
  const unavailableMoveId = "44444444-4444-4444-8444-444444444444";
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "/studio-api/github/session")
      return json({ csrfToken: "retained-workspace-csrf" });
    if (url.endsWith("/open")) return json({ opened: true });
    if (url.endsWith("/delete")) return json({ deleted: true });
    return json({
      workspaces: [
        {
          moveId,
          sourcePath: "/Users/example/Projects/source",
          reason: "source_workspace_edits",
          retainedAt: execution.updatedAt,
          sourceProjectId: null,
          available: true,
          checkoutKind: "koed_managed_worktree",
          deletable: true,
          privateField: "must not be retained"
        },
        {
          moveId: unavailableMoveId,
          sourcePath: "/Users/example/Projects/removed-source",
          reason: "source_workspace_edits",
          retainedAt: execution.updatedAt,
          sourceProjectId: "lp_0123456789abcdef0123456789abcdef",
          available: false,
          checkoutKind: "user_managed_checkout",
          deletable: false
        }
      ]
    });
  };

  const workspaces = await loadLocalRetainedWorkspaces(id, undefined, fetcher);
  assert.deepEqual(workspaces, [
    {
      moveId,
      sourcePath: "/Users/example/Projects/source",
      reason: "source_workspace_edits",
      retainedAt: execution.updatedAt,
      sourceProjectId: null,
      available: true,
      checkoutKind: "koed_managed_worktree",
      deletable: true
    },
    {
      moveId: unavailableMoveId,
      sourcePath: "/Users/example/Projects/removed-source",
      reason: "source_workspace_edits",
      retainedAt: execution.updatedAt,
      sourceProjectId: "lp_0123456789abcdef0123456789abcdef",
      available: false,
      checkoutKind: "user_managed_checkout",
      deletable: false
    }
  ]);
  await openLocalRetainedWorkspace(id, moveId, undefined, fetcher);
  await deleteLocalRetainedManagedWorktree(id, moveId, undefined, fetcher);

  const reads = calls.filter((call) =>
    call.url.includes("/retained-workspaces")
  );
  assert.equal(reads[0].init?.method, "GET");
  assert.equal(
    new Headers(reads[0].init?.headers).get("x-studio-csrf"),
    "retained-workspace-csrf"
  );
  assert.equal(reads[1].init?.method, "POST");
  assert.equal(
    new Headers(reads[1].init?.headers).get("x-studio-csrf"),
    "retained-workspace-csrf"
  );
  assert.deepEqual(JSON.parse(String(reads[1].init?.body)), {});
  assert.equal(reads[2].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(reads[2].init?.body)), {
    confirmation: "delete_managed_worktree"
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "/studio-api/github/session",
      `/studio-api/managed-conversations/${id}/retained-workspaces`,
      "/studio-api/github/session",
      `/studio-api/managed-conversations/${id}/retained-workspaces/${moveId}/open`,
      "/studio-api/github/session",
      `/studio-api/managed-conversations/${id}/retained-workspaces/${moveId}/delete`
    ]
  );
});

test("maps an unavailable retained workspace error to readable local copy", async () => {
  const fetcher: typeof fetch = async (input) =>
    String(input) === "/studio-api/github/session"
      ? json({ csrfToken: "retained-workspace-csrf" })
      : json({ error: "retained_workspace_unavailable" }, 404);
  await assert.rejects(
    openLocalRetainedWorkspace(
      id,
      "33333333-3333-4333-8333-333333333333",
      undefined,
      fetcher
    ),
    /no longer available on this computer/
  );
});

test("loads runtime and generation-matched live user and agent messages", async () => {
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith("/runtime"))
      return json({
        execution: { ...execution, path: "/private/device/path" },
        hasIndeterminatePrompt: true,
        latestCommand: {
          id: "55555555-5555-4555-8555-555555555555",
          commandKind: "prompt",
          state: "running"
        },
        items: [
          {
            id: commandId,
            executionGeneration: 3,
            itemKind: "command_approval",
            state: "pending",
            payload: {
              command:
                "tool --token=abc123 --file /Users/runner/private/secret.txt",
              credential: "secret",
              cwd: "/Users/runner/private",
              reason: "Need approval for /Users/runner/private; token=abc123",
              input: {
                file_path: "/Users/runner/private/secret.txt",
                patch:
                  "--- /Users/runner/private/secret.txt\n+++ /Users/runner/private/secret.txt\n+safe change"
              },
              diff: [
                {
                  one: {
                    two: {
                      three: {
                        four: {
                          hiddenPath: "/Users/runner/private/deep-secret.txt"
                        }
                      }
                    }
                  }
                }
              ],
              permissions: {
                filesystem: { read: ["/Users/runner/private"] },
                network: false
              }
            },
            presentation: { mode: "expanded", renderer: "approval" },
            answered: false
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            executionGeneration: 3,
            itemKind: "user_input",
            state: "pending",
            payload: {
              questions: [
                {
                  id: "target-branch",
                  header: "Target branch",
                  question: "Which branch should use /Users/runner/project?",
                  required: false,
                  options: [{ label: "main" }, { label: "release" }]
                }
              ]
            },
            presentation: { mode: "expanded", renderer: "user_input" },
            answered: false
          },
          {
            id: "stream-item",
            executionGeneration: 3,
            providerTurnId: "provider-turn",
            providerItemId: "provider-item",
            itemKind: "transient_output",
            state: "pending",
            createdAt: execution.updatedAt,
            updatedAt: execution.updatedAt,
            payload: {
              text: "Streaming /Users/runner/private/file.txt token=private"
            },
            presentation: {
              mode: "expanded",
              renderer: "message",
              policyKey: "transient_output"
            }
          },
          {
            id: "unsafe-stream-item",
            executionGeneration: 3,
            itemKind: "transient_output",
            state: "pending",
            payload: { text: "Should not be exposed" },
            presentation: {
              mode: "expanded",
              renderer: "tool",
              policyKey: "transient_output"
            }
          },
          {
            id: "33333333-3333-4333-8333-333333333333",
            executionGeneration: 2,
            itemKind: "command_approval",
            state: "pending",
            payload: { command: "stale" }
          }
        ]
      });
    return json({
      executionId: id,
      executionGeneration: 3,
      executionState: "running",
      messages: [
        {
          id: "user-message",
          role: "user",
          content: "Continue",
          createdAt: execution.createdAt
        },
        {
          id: "agent-message",
          role: "assistant",
          content: "Working",
          createdAt: execution.updatedAt,
          author: { agentId: "agent-1", name: "Agent" }
        },
        {
          id: "other-role",
          role: "system",
          content: "private",
          createdAt: execution.updatedAt
        }
      ]
    });
  };
  const loaded = await loadHostedManagedConversation(id, undefined, fetcher);
  assert.equal(loaded.runtime.execution.id, id);
  assert.equal("path" in loaded.runtime.execution, false);
  assert.equal(loaded.runtime.hasIndeterminatePrompt, true);
  assert.deepEqual(
    loaded.runtime.items.map((item) => item.id),
    [
      commandId,
      "44444444-4444-4444-8444-444444444444",
      "stream-item",
      "unsafe-stream-item"
    ]
  );
  assert.equal("credential" in loaded.runtime.items[0].payload, false);
  assert.equal(
    loaded.runtime.items.find((item) => item.id === "stream-item")?.payload
      .text,
    "Streaming [local path hidden] token=[redacted]"
  );
  assert.equal(
    "text" in
      (loaded.runtime.items.find((item) => item.id === "unsafe-stream-item")
        ?.payload ?? {}),
    false
  );
  assert.equal("cwd" in loaded.runtime.items[0].payload, false);
  assert.doesNotMatch(
    JSON.stringify(loaded.runtime.items[0].payload.diff),
    /deep-secret\.txt/u
  );
  assert.match(
    JSON.stringify(loaded.runtime.items[0].payload.diff),
    /details omitted/u
  );
  assert.match(
    String(loaded.runtime.items[0].payload.command),
    /\[redacted\]/u
  );
  assert.doesNotMatch(
    String(loaded.runtime.items[0].payload.command),
    /\/Users\//u
  );
  assert.equal("credential" in loaded.runtime.items[0].payload, false);
  assert.equal(
    loaded.runtime.items[0].payload.reason,
    "Need approval for [local path hidden] token=[redacted]"
  );
  const approval = {
    id: commandId,
    kind: "command_approval" as const,
    description: "Need approval",
    details: [
      {
        label: "Command",
        text: String(loaded.runtime.items[0].payload.command)
      },
      {
        label: "patch",
        text: String(
          (loaded.runtime.items[0].payload.input as Record<string, unknown>)
            .patch
        )
      },
      {
        label: "Permissions",
        text: JSON.stringify(loaded.runtime.items[0].payload.permissions)
      }
    ]
  };
  assert.equal(hasMeaningfulHostedApprovalDetails(approval), true);
  assert.ok(approval.details.some((detail) => detail.label === "Command"));
  assert.ok(approval.details.some((detail) => detail.label === "patch"));
  assert.ok(approval.details.some((detail) => detail.label === "Permissions"));
  assert.ok(
    approval.details.every(
      (detail) => !detail.text.includes("/Users/runner/private")
    )
  );
  const questionItem = loaded.runtime.items[1];
  const questions = questionItem.payload.questions as Array<{
    id: string;
    question: string;
    required: boolean;
    options: Array<{ label: string }>;
  }>;
  assert.equal(questions[0].id, "target-branch");
  assert.equal(questions[0].required, false);
  assert.equal(
    questions[0].question,
    "Which branch should use [local path hidden]"
  );
  assert.deepEqual(
    questions[0].options.map((option) => option.label),
    ["main", "release"]
  );
  const questionRequest = {
    id: questionItem.id,
    kind: "user_input" as const,
    description: "The agent needs your input",
    details: [],
    questions: questions.map((question) => ({
      ...question,
      header: "Target branch"
    }))
  };
  assert.equal(hasMeaningfulHostedApprovalDetails(questionRequest), true);
  const detailFreeRequest = {
    id: commandId,
    kind: "command_approval" as const,
    description: "The agent needs your approval",
    details: []
  };
  assert.equal(hasMeaningfulHostedApprovalDetails(detailFreeRequest), false);
  assert.deepEqual(
    loaded.state.messages.map((message) => message.role),
    ["user", "assistant"]
  );
  assert.throws(
    () =>
      parseHostedConversationState(
        {
          executionId: id,
          executionGeneration: 2,
          executionState: "running",
          messages: []
        },
        id,
        3
      ),
    /outdated/
  );
});

test("requires a verified collaboration backend ID for device recovery scope", () => {
  assert.equal(
    hostedRecoveryBackendId({ connection: { backendId: "up_team_abc" } }),
    "up_team_abc"
  );
  assert.equal(
    hostedRecoveryBackendId({ connection: { backendId: null } }),
    null
  );
  assert.equal(
    hostedRecoveryBackendId({ connection: { backendId: "  " } }),
    null
  );
  assert.equal(hostedRecoveryBackendId({ connection: {} }), null);
  assert.equal(hostedRecoveryBackendId(null), null);
});

test("keeps hosted messages readable when optional memory attribution is malformed", () => {
  const state = parseHostedConversationState(
    {
      executionId: id,
      executionGeneration: 3,
      executionState: "running",
      messages: [
        {
          id: "assistant-with-citation",
          role: "assistant",
          content: "Answer\n<!-- koed-memory-attribution:v1:malformed -->",
          createdAt: execution.createdAt,
          memory: {
            used: true,
            status: "available",
            citations: [{ label: "A source label" }]
          }
        },
        {
          id: "assistant-with-invalid-citation",
          role: "assistant",
          content: "Must remain readable",
          createdAt: execution.createdAt,
          memory: {
            used: true,
            status: "available",
            citations: [{ label: 12 }]
          }
        },
        {
          id: "user-with-memory",
          role: "user",
          content: "Must remain readable",
          createdAt: execution.createdAt,
          memory: { used: true, status: "available", citations: [] }
        },
        {
          id: "legacy-assistant",
          role: "assistant",
          content: "No attribution metadata",
          createdAt: execution.createdAt
        }
      ]
    },
    id,
    3
  );

  assert.deepEqual(
    state.messages.map((message) => message.id),
    [
      "assistant-with-citation",
      "assistant-with-invalid-citation",
      "user-with-memory",
      "legacy-assistant"
    ]
  );
  assert.deepEqual(state.messages[0].memory, {
    used: true,
    status: "available",
    citations: [{ label: "A source label" }]
  });
  assert.equal(state.messages[0].content, "Answer");
  assert.equal("memory" in state.messages[1], false);
  assert.equal("memory" in state.messages[2], false);
  assert.equal("memory" in state.messages[3], false);
});

test("responds to a hosted runtime request with its exact kind and generation", async () => {
  let call: { url: string; init?: RequestInit } | undefined;
  await respondToHostedRuntimeItem(
    execution,
    {
      id: commandId,
      itemKind: "user_input",
      executionGeneration: 3
    },
    { answers: { "question-1": ["yes"] } },
    undefined,
    async (input, init) => {
      call = { url: String(input), init };
      return json({ accepted: true });
    }
  );
  assert.equal(
    call?.url,
    `/v1/managed-conversations/${id}/runtime-items/${commandId}/respond`
  );
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    kind: "user_input",
    executionGeneration: 3,
    answers: { "question-1": ["yes"] }
  });
  await assert.rejects(
    respondToHostedRuntimeItem(
      execution,
      { id: commandId, itemKind: "command_approval", executionGeneration: 2 },
      { decision: "accept" },
      undefined,
      async () => {
        throw new Error("stale requests must not be sent");
      }
    ),
    /outdated/
  );
});

test("loads the authenticated recovery scope and looks up stable send identities", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "/v1/managed-conversations/access")
      return json({ user: { id: "owner-id" }, backendId: "hosted-deployment" });
    if (url.includes("kind=start")) return json({ found: false });
    return json({
      found: true,
      execution: { id, executionGeneration: 3, path: "/private/runner/path" },
      command: {
        id: commandId,
        state: "queued",
        executionId: id,
        executionGeneration: 3,
        commandKind: "prompt",
        clientUserMessageId: "33333333-3333-4333-8333-333333333333",
        createdAt: execution.createdAt,
        credential: "secret"
      }
    });
  };
  assert.deepEqual(
    await loadHostedManagedConversationAccess(undefined, fetcher),
    {
      ownerId: "owner-id",
      backendId: "hosted-deployment"
    }
  );
  assert.deepEqual(
    await lookupHostedConversationRecovery(
      { kind: "start", idempotencyKey: "stable-start-key" },
      undefined,
      fetcher
    ),
    { found: false }
  );
  const found = await lookupHostedConversationRecovery(
    {
      kind: "prompt",
      idempotencyKey: "stable-prompt-key",
      clientUserMessageId: "33333333-3333-4333-8333-333333333333",
      executionId: id,
      executionGeneration: 3
    },
    undefined,
    fetcher
  );
  assert.deepEqual(found, {
    found: true,
    executionId: id,
    executionGeneration: 3,
    commandId,
    commandState: "queued",
    commandKind: "prompt",
    clientUserMessageId: "33333333-3333-4333-8333-333333333333"
  });
  assert.ok(calls[1].includes("kind=start"));
  assert.ok(calls[1].includes("idempotencyKey=stable-start-key"));
  assert.ok(calls[2].includes("executionGeneration=3"));
  assert.ok(
    calls[2].includes(
      "clientUserMessageId=33333333-3333-4333-8333-333333333333"
    )
  );
  assert.equal(calls[2].includes("/private/runner/path"), false);
});

test("retains hosted send identity until terminal state and hides failed or canceled pending messages", () => {
  assert.deepEqual(hostedRecoveryDisposition("failed"), {
    kind: "failed",
    clearIdentity: false,
    restorePrompt: true,
    showPendingMessage: false
  });
  assert.deepEqual(hostedRecoveryDisposition("indeterminate"), {
    kind: "uncertain",
    clearIdentity: false,
    restorePrompt: true,
    showPendingMessage: true
  });
  assert.deepEqual(hostedRecoveryDisposition("future-state"), {
    kind: "uncertain",
    clearIdentity: false,
    restorePrompt: true,
    showPendingMessage: true
  });
  assert.deepEqual(hostedRecoveryDisposition("canceled"), {
    kind: "canceled",
    clearIdentity: true,
    restorePrompt: true,
    showPendingMessage: false
  });
  for (const state of ["queued", "blocked", "dispatching"]) {
    assert.deepEqual(hostedRecoveryDisposition(state), {
      kind: "accepted",
      clearIdentity: false,
      restorePrompt: false,
      showPendingMessage: true
    });
  }
  assert.deepEqual(hostedRecoveryDisposition("completed"), {
    kind: "accepted",
    clearIdentity: true,
    restorePrompt: false,
    showPendingMessage: true
  });
});

test("sends prompt and control mutations with generation and idempotency data", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/prompts"))
      return json({ command: { id: commandId, state: "queued" } }, 202);
    return json({ command: { id: commandId, state: "dispatching" } }, 202);
  };
  assert.deepEqual(
    await queueHostedConversationPrompt(
      execution,
      "hello",
      { idempotencyKey: "send-key", clientUserMessageId: "client-id" },
      undefined,
      fetcher,
      {
        selectedResourceIds: [`res_${"a".repeat(64)}`],
        selectedResourceHostedInstanceId: "hosted-codex-one"
      }
    ),
    { commandId, state: "queued" }
  );
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    executionGeneration: execution.executionGeneration,
    idempotencyKey: "send-key",
    clientUserMessageId: "client-id",
    prompt: "hello",
    selectedResourceIds: [`res_${"a".repeat(64)}`],
    selectedResourceHostedInstanceId: "hosted-codex-one"
  });
  assert.deepEqual(
    await requestHostedConversationControl(
      execution,
      "interrupt",
      "interrupt-key",
      undefined,
      fetcher
    ),
    { commandId, state: "dispatching" }
  );
  assert.deepEqual(
    await requestHostedConversationControl(
      execution,
      "stop",
      "stop-key",
      undefined,
      fetcher
    ),
    { commandId, state: "dispatching" }
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      `/v1/managed-conversations/${id}/prompts`,
      `/v1/managed-conversations/${id}/interrupt`,
      `/v1/managed-conversations/${id}/stop`
    ]
  );
  const promptBody = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(promptBody, {
    executionGeneration: 3,
    idempotencyKey: "send-key",
    clientUserMessageId: "client-id",
    prompt: "hello",
    selectedResourceIds: [
      "res_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ],
    selectedResourceHostedInstanceId: "hosted-codex-one"
  });
  assert.equal(calls[0].init?.credentials, "include");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    executionGeneration: 3,
    idempotencyKey: "interrupt-key"
  });
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), {
    executionGeneration: 3,
    idempotencyKey: "stop-key"
  });
  assert.equal(
    "authorization" in (calls[0].init?.headers as Record<string, string>),
    false
  );
});

test("attributes hosted follow-up prompts to the verified active Agent version", async () => {
  const state = parseHostedConversationState(
    {
      executionId: id,
      executionGeneration: 3,
      executionState: "running",
      activeAgentId: "agent-1",
      participants: [
        {
          agentId: "agent-1",
          name: "Researcher",
          lifecycle: "active",
          currentVersion: 7
        }
      ],
      messages: []
    },
    id,
    3
  );
  const attribution = hostedActiveAgentAttribution(state);
  assert.deepEqual(attribution, {
    agentId: "agent-1",
    expectedAgentVersion: 7
  });
  let sent: Record<string, unknown> | null = null;
  await queueHostedConversationPrompt(
    execution,
    "Continue the research",
    {
      idempotencyKey: "follow-up-key",
      clientUserMessageId: "follow-up-message",
      ...attribution
    },
    undefined,
    async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ command: { id: commandId, state: "queued" } }, 202);
    }
  );
  assert.deepEqual(sent, {
    executionGeneration: 3,
    idempotencyKey: "follow-up-key",
    clientUserMessageId: "follow-up-message",
    prompt: "Continue the research",
    agentId: "agent-1",
    expectedAgentVersion: 7
  });
  assert.throws(
    () =>
      hostedActiveAgentAttribution({
        ...state,
        participants: state.participants?.map((participant) => ({
          ...participant,
          lifecycle: "retired"
        }))
      }),
    /no longer active/
  );
});

test("sends the one-shot Continue without Memory flag only with the accepted prompt", async () => {
  const sent: Record<string, unknown>[] = [];
  await queueHostedConversationPrompt(
    execution,
    "Continue this goal",
    { idempotencyKey: "continue-key", clientUserMessageId: "continue-message" },
    undefined,
    async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ command: { id: commandId, state: "queued" } }, 202);
    },
    { continueWithoutMemory: true }
  );
  assert.equal(sent[0]?.continueWithoutMemory, true);
});

test("surfaces the bounded hosted recall pause code for Studio recovery actions", async () => {
  await assert.rejects(
    queueHostedConversationPrompt(
      execution,
      "Continue this goal",
      {
        idempotencyKey: "recall-pause-key",
        clientUserMessageId: "recall-pause-message"
      },
      undefined,
      async () =>
        json(
          {
            error: {
              code: "MEMORY_RECALL_UNAVAILABLE",
              message:
                "Memory could not be checked. Retry or continue without Memory."
            }
          },
          503
        )
    ),
    (error: unknown) =>
      error instanceof HostedManagedChatError &&
      error.status === 503 &&
      error.code === "MEMORY_RECALL_UNAVAILABLE"
  );
});

test("cancels only through the queued command endpoint and preserves a race result", async () => {
  let call: { url: string; init?: RequestInit } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    call = { url: String(input), init };
    return json(
      { command: { id: commandId, state: "dispatching", canceled: false } },
      409
    );
  };
  await assert.rejects(
    cancelHostedQueuedPrompt(execution, commandId, undefined, fetcher),
    (error: unknown) =>
      error instanceof HostedManagedChatError && error.status === 409
  );
  assert.equal(
    call?.url,
    `/v1/managed-conversations/${id}/prompts/${commandId}/cancel`
  );
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    executionGeneration: 3
  });
});

test("rejects unauthorized session and never exposes error response details", async () => {
  await assert.rejects(
    listHostedManagedConversations(undefined, async () =>
      json({ error: "Unauthorized", path: "/private/device/path" }, 401)
    ),
    (error: unknown) =>
      error instanceof HostedManagedChatError &&
      error.status === 401 &&
      !error.message.includes("/private")
  );
});

test("keeps stale launch choices but hides models for other not-ready states", async () => {
  const options = await loadHostedLaunchOptions(undefined, async () =>
    json({
      runners: [
        {
          kind: "local_device",
          deviceId: "device-a",
          deploymentId: "deployment-a",
          displayName: "Computer A"
        }
      ],
      instances: [
        {
          instanceId: "runner.opaque-a",
          runnerDeviceId: "device-a",
          driverId: "codex",
          displayName: "Codex",
          ready: false,
          readiness: "stale",
          models: [
            {
              id: "gpt-6-sol",
              displayName: "gpt-6-sol",
              supportedReasoningEfforts: ["high"]
            }
          ],
          capabilities: {
            permissionModes: [{ mode: "supervised", support: "supported" }]
          }
        }
      ],
      projects: [{ id: "project-a", name: "Real Project" }]
    })
  );
  assert.deepEqual(options.runners, [
    { deviceId: "device-a", displayName: "Computer A" }
  ]);
  assert.equal(options.instances[0].ready, false);
  assert.equal(options.instances[0].readiness, "stale");
  assert.equal(options.instances[0].models[0].id, "gpt-6-sol");
  assert.deepEqual(options.projects, [
    { id: "project-a", name: "Real Project" }
  ]);

  const authenticationRequired = await loadHostedLaunchOptions(
    undefined,
    async () =>
      json({
        runners: [
          {
            kind: "local_device",
            deviceId: "device-a",
            displayName: "Computer A"
          }
        ],
        instances: [
          {
            instanceId: "runner.opaque-a",
            runnerDeviceId: "device-a",
            driverId: "codex",
            ready: false,
            readiness: "authentication_required",
            models: [{ id: "old-model", supportedReasoningEfforts: ["high"] }],
            capabilities: {
              permissionModes: [{ mode: "supervised", support: "supported" }]
            }
          }
        ]
      })
  );
  assert.equal(
    authenticationRequired.instances[0]?.readiness,
    "authentication_required"
  );
  assert.deepEqual(authenticationRequired.instances[0]?.models, []);
});

test("keeps model choices on their enrolled runner and rejects unbound instances", async () => {
  const instance = {
    driverId: "codex",
    ready: true,
    models: [{ id: "model" }],
    capabilities: {
      permissionModes: [{ mode: "supervised", support: "supported" }]
    }
  };
  const options = await loadHostedLaunchOptions(undefined, async () =>
    json({
      runners: ["a", "b"].map((deviceId) => ({
        kind: "local_device",
        deviceId,
        displayName: deviceId
      })),
      instances: [
        { ...instance, instanceId: "runner.a", runnerDeviceId: "a" },
        { ...instance, instanceId: "runner.b", runnerDeviceId: "b" },
        { ...instance, instanceId: "codex.default" },
        { ...instance, instanceId: "runner.other", runnerDeviceId: "other" }
      ]
    })
  );
  assert.equal(options.instances.length, 2);
  assert.deepEqual(
    hostedLaunchInstancesForDevice(options, "a").map(
      (value) => value.instanceId
    ),
    ["runner.a"]
  );
  assert.deepEqual(
    hostedLaunchInstancesForDevice(options, "b").map(
      (value) => value.instanceId
    ),
    ["runner.b"]
  );
  assert.deepEqual(hostedLaunchInstancesForDevice(options, "other"), []);
});

test("refreshes launch choices without replacing still-valid selections", () => {
  const options = {
    runners: [
      { deviceId: "device-a", displayName: "Computer A" },
      { deviceId: "device-b", displayName: "Computer B" }
    ],
    instances: [
      {
        instanceId: "codex.a",
        runnerDeviceId: "device-a",
        driverId: "codex",
        ready: true,
        readiness: "ready",
        models: [
          {
            id: "model-a",
            provider: "codex",
            supportedReasoningEfforts: ["low", "high"]
          },
          {
            id: "model-b",
            provider: "codex",
            supportedReasoningEfforts: ["medium"]
          }
        ],
        permissionModes: ["supervised", "full"]
      },
      {
        instanceId: "claude.b",
        runnerDeviceId: "device-b",
        driverId: "claude",
        ready: true,
        readiness: "ready",
        models: [
          {
            id: "model-c",
            provider: "claude",
            supportedReasoningEfforts: []
          }
        ],
        permissionModes: ["read"]
      }
    ],
    projects: [
      { id: "project-a", name: "Project A" },
      { id: "project-b", name: "Project B" }
    ]
  };

  assert.deepEqual(
    hostedLaunchSelectionForOptions(options, {
      projectId: "project-b",
      deviceId: "device-a",
      instanceId: "codex.a",
      modelId: "model-b",
      effort: "medium",
      permission: "full"
    }),
    {
      projectId: "project-b",
      deviceId: "device-a",
      instanceId: "codex.a",
      modelId: "model-b",
      effort: "medium",
      permission: "full"
    }
  );
  assert.deepEqual(
    hostedLaunchSelectionForOptions(options, {
      projectId: "removed-project",
      deviceId: "removed-device",
      instanceId: "removed-instance",
      modelId: "removed-model",
      effort: "unsupported",
      permission: "unsupported"
    }),
    {
      projectId: "project-a",
      deviceId: "device-a",
      instanceId: "codex.a",
      modelId: "model-a",
      effort: "low",
      permission: "supervised"
    }
  );
  assert.deepEqual(
    hostedLaunchSelectionForOptions(options, {
      projectId: "",
      deviceId: "device-b",
      instanceId: "claude.b",
      modelId: "model-c",
      effort: "",
      permission: "read"
    }),
    {
      projectId: "",
      deviceId: "device-b",
      instanceId: "claude.b",
      modelId: "model-c",
      effort: "",
      permission: "read"
    }
  );
});

test("starts a selected-device Conversation and cancels only by execution generation", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return String(input) === "/v1/managed-conversations"
      ? json({ execution, command: { id: commandId, state: "queued" } }, 202)
      : json({ command: { id: commandId, state: "canceled", canceled: true } });
  };
  const started = await startHostedManagedConversation(
    {
      projectId: "project-a",
      contextKind: "project",
      provider: "codex",
      aiClientInstanceId: "hosted-codex-one",
      model: "gpt-6-sol",
      reasoningEffort: "high",
      permissionMode: "supervised",
      targetDeviceId: "device-a",
      idempotencyKey: "start-key",
      initialPrompt: "Begin",
      selectedResourceIds: [`res_${"b".repeat(64)}`],
      selectedResourceHostedInstanceId: "hosted-codex-one"
    },
    undefined,
    fetcher
  );
  assert.equal(started.commandState, "queued");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    projectId: "project-a",
    contextKind: "project",
    provider: "codex",
    aiClientInstanceId: "hosted-codex-one",
    model: "gpt-6-sol",
    reasoningEffort: "high",
    permissionMode: "supervised",
    targetDeviceId: "device-a",
    idempotencyKey: "start-key",
    initialPrompt: "Begin",
    selectedResourceIds: [`res_${"b".repeat(64)}`],
    selectedResourceHostedInstanceId: "hosted-codex-one",
    runnerKind: "local_device"
  });
  assert.deepEqual(
    await cancelHostedConversationStart(started.execution, undefined, fetcher),
    {
      commandId,
      state: "canceled",
      canceled: true
    }
  );
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "/v1/managed-conversations",
      `/v1/managed-conversations/${id}/start/cancel`
    ]
  );
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    projectId: "project-a",
    contextKind: "project",
    provider: "codex",
    aiClientInstanceId: "hosted-codex-one",
    model: "gpt-6-sol",
    reasoningEffort: "high",
    permissionMode: "supervised",
    targetDeviceId: "device-a",
    idempotencyKey: "start-key",
    initialPrompt: "Begin",
    selectedResourceIds: [
      "res_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    ],
    selectedResourceHostedInstanceId: "hosted-codex-one",
    runnerKind: "local_device"
  });
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    executionGeneration: 3
  });
});

test("starts an independent hosted Conversation with no Project", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const started = await startHostedManagedConversation(
    {
      projectId: null,
      contextKind: "independent",
      provider: "codex",
      aiClientInstanceId: "codex.default",
      model: "gpt-6-sol",
      reasoningEffort: null,
      permissionMode: "supervised",
      targetDeviceId: "device-a",
      idempotencyKey: "standalone-start-key"
    },
    undefined,
    async (input, init) => {
      request = { url: String(input), init };
      return json(
        {
          execution: { ...execution, projectId: null },
          command: { id: commandId, state: "queued" }
        },
        202
      );
    }
  );

  assert.equal(started.commandState, "queued");
  assert.equal(request?.url, "/v1/managed-conversations");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    projectId: null,
    contextKind: "independent",
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "gpt-6-sol",
    reasoningEffort: null,
    permissionMode: "supervised",
    targetDeviceId: "device-a",
    idempotencyKey: "standalone-start-key",
    runnerKind: "local_device"
  });
});

test("starts a hosted Agent Job with its owner version and clear goal", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  await startHostedManagedConversation(
    {
      projectId: null,
      contextKind: "independent",
      provider: "codex",
      aiClientInstanceId: "codex.default",
      model: "gpt-6-sol",
      reasoningEffort: "high",
      permissionMode: "supervised",
      targetDeviceId: "device-a",
      idempotencyKey: "agent-job-start-key",
      initialPrompt: "Review the billing implementation and report risks.",
      initialPromptClientUserMessageId: "33333333-3333-4333-8333-333333333333",
      agentId: "11111111-1111-4111-8111-111111111111",
      expectedAgentVersion: 7,
      continueWithoutMemory: true
    },
    undefined,
    async (input, init) => {
      request = { url: String(input), init };
      return json(
        {
          execution: { ...execution, projectId: null },
          command: { id: commandId, state: "queued" }
        },
        202
      );
    }
  );

  assert.equal(request?.url, "/v1/managed-conversations");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    projectId: null,
    contextKind: "independent",
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "gpt-6-sol",
    reasoningEffort: "high",
    permissionMode: "supervised",
    targetDeviceId: "device-a",
    idempotencyKey: "agent-job-start-key",
    initialPrompt: "Review the billing implementation and report risks.",
    initialPromptClientUserMessageId: "33333333-3333-4333-8333-333333333333",
    agentId: "11111111-1111-4111-8111-111111111111",
    expectedAgentVersion: 7,
    continueWithoutMemory: true,
    runnerKind: "local_device"
  });
});

test("rejects a mismatched Project and hosted context before sending", async () => {
  let requestCount = 0;
  await assert.rejects(
    startHostedManagedConversation(
      {
        projectId: null,
        contextKind: "project",
        provider: "codex",
        aiClientInstanceId: "codex.default",
        model: "gpt-6-sol",
        reasoningEffort: null,
        permissionMode: "supervised",
        targetDeviceId: "device-a",
        idempotencyKey: "mismatched-start-key"
      },
      undefined,
      async () => {
        requestCount += 1;
        return json({});
      }
    ),
    /Choose either a Project or a standalone Conversation/
  );
  assert.equal(requestCount, 0);
});

test("rejects hosted recovery scopes without an authenticated backend identity", async () => {
  for (const backendId of [undefined, null, "", "   "]) {
    await assert.rejects(
      loadHostedManagedConversationAccess(undefined, async () =>
        json({ user: { id: "owner-id" }, backendId })
      ),
      /backend identity is unavailable/
    );
  }
});

test("blocks unresolved prompts even when a later control command masks them or local recovery is absent", () => {
  const localRecovery = hostedRecoveryGuardForSelection({
    selectedExecutionId: id,
    pendingOperationExecutionId: null,
    checkingExecutionIds: []
  });
  assert.deepEqual(localRecovery, {
    hasPendingOperation: false,
    isChecking: false
  });

  const runtimeWithMaskedPrompt = {
    execution: { ...execution, state: "running" },
    items: [],
    latestCommand: {
      id: commandId,
      commandKind: "interrupt",
      state: "completed",
      lastErrorCode: null
    },
    hasIndeterminatePrompt: true
  };
  assert.equal(hostedPromptOutcomeIsUncertain(runtimeWithMaskedPrompt), true);
  assert.equal(
    hostedPromptOutcomeIsUncertain({
      ...runtimeWithMaskedPrompt,
      hasIndeterminatePrompt: false,
      latestCommand: {
        ...runtimeWithMaskedPrompt.latestCommand,
        commandKind: "prompt",
        state: "completed"
      }
    }),
    false
  );
  assert.equal(
    hostedPromptOutcomeIsUncertain({
      ...runtimeWithMaskedPrompt,
      hasIndeterminatePrompt: false,
      latestCommand: {
        ...runtimeWithMaskedPrompt.latestCommand,
        commandKind: "prompt",
        state: "indeterminate"
      }
    }),
    true
  );
  assert.equal(
    hostedPromptOutcomeIsUncertain({
      ...runtimeWithMaskedPrompt,
      hasIndeterminatePrompt: false,
      latestCommand: {
        ...runtimeWithMaskedPrompt.latestCommand,
        commandKind: "stop",
        state: "indeterminate"
      }
    }),
    false
  );
});

test("shared managed chat uses native proxy and CSRF on Desktop, hosted authority on web", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ path: String(input), init });
    return String(input).endsWith("/session")
      ? json({ csrfToken: "native-fixture-csrf" })
      : json({ command: { id: commandId, state: "queued" } }, 202);
  };
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { pathname: "/pull-requests" } }
    });
    await queueHostedConversationPrompt(
      execution,
      "Continue",
      { idempotencyKey: "native-send", clientUserMessageId: "native-message" },
      undefined,
      fetcher
    );
    assert.deepEqual(
      calls.map((call) => call.path),
      [
        "/studio-api/github/session",
        `/studio-api/managed-conversations/${id}/prompts`
      ]
    );
    assert.equal(
      new Headers(calls[1].init?.headers).get("x-studio-csrf"),
      "native-fixture-csrf"
    );
    calls.length = 0;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { pathname: "/studio/pull-requests" } }
    });
    await queueHostedConversationPrompt(
      execution,
      "Continue",
      { idempotencyKey: "web-send", clientUserMessageId: "web-message" },
      undefined,
      fetcher
    );
    assert.deepEqual(
      calls.map((call) => call.path),
      [`/v1/managed-conversations/${id}/prompts`]
    );
    assert.equal(
      new Headers(calls[0].init?.headers).get("x-studio-csrf"),
      null
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
