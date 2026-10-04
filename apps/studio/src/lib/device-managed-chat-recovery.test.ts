import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDeviceManagedChatRecoveryStore,
  createLocalManagedChatRecoveryStore,
  managedChatCommandMatchesPendingPrompt,
  managedChatRecoveryCommandDisposition,
  managedChatSendRequestFingerprint,
  reusableManagedChatSendIdentity,
  settleManagedChatStartRecovery
  // @ts-expect-error -- Node's native TypeScript test runner requires the .ts extension.
} from "./device-managed-chat-recovery.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("restores an unsent draft on this device and isolates its owner, backend, and conversation", () => {
  const storage = new MemoryStorage();
  const first = createDeviceManagedChatRecoveryStore({
    ownerId: "owner-a",
    backendId: "backend-a",
    executionId: "execution-a",
    storage
  });
  const sameScope = createDeviceManagedChatRecoveryStore({
    ownerId: "owner-a",
    backendId: "backend-a",
    executionId: "execution-a",
    storage
  });
  assert.ok(first && sameScope);
  first.write({ schemaVersion: 1, draft: "keep this unsent" });
  assert.deepEqual(sameScope.read(), {
    schemaVersion: 1,
    draft: "keep this unsent"
  });
  for (const scope of [
    { ownerId: "owner-b", backendId: "backend-a", executionId: "execution-a" },
    { ownerId: "owner-a", backendId: "backend-b", executionId: "execution-a" },
    { ownerId: "owner-a", backendId: "backend-a", executionId: "execution-b" }
  ]) {
    const isolated = createDeviceManagedChatRecoveryStore({
      ...scope,
      storage
    });
    assert.equal(isolated?.read(), null);
  }
});

test("persists launch and prompt identity without marking it resubmittable", () => {
  const storage = new MemoryStorage();
  const store = createDeviceManagedChatRecoveryStore({
    ownerId: "owner",
    backendId: "backend",
    executionId: null,
    storage
  });
  assert.ok(store);
  const operation = {
    kind: "prompt" as const,
    startIdempotencyKey: "stable-start-key",
    promptIdempotencyKey: "stable-command-key",
    clientUserMessageId: "stable-client-message-id",
    executionGeneration: 3,
    prompt: "Make a change",
    requestFingerprint: "same-request",
    state: "reconciling" as const
  };
  store.write({
    schemaVersion: 1,
    draft: "Make a change",
    pendingOperation: operation
  });
  const recovered = createDeviceManagedChatRecoveryStore({
    ownerId: "owner",
    backendId: "backend",
    executionId: null,
    storage
  })?.read();
  assert.deepEqual(recovered?.pendingOperation, operation);
  assert.equal(recovered?.draft, "Make a change");
});

test("migrates a recall-paused first Job draft into the execution scope for reload and retry", () => {
  const storage = new MemoryStorage();
  const newChatScope = createDeviceManagedChatRecoveryStore({
    ownerId: "owner",
    backendId: "backend",
    executionId: null,
    storage
  });
  const executionScope = createDeviceManagedChatRecoveryStore({
    ownerId: "owner",
    backendId: "backend",
    executionId: "execution-1",
    storage
  });
  assert.ok(newChatScope && executionScope);
  newChatScope.write({ schemaVersion: 1, draft: "Prepare the release notes" });

  // The first send already created an empty execution. Move its retained draft
  // before clearing the new-chat key, as LiveAgentChat does before the 503.
  const firstAttempt = newChatScope.read();
  assert.ok(firstAttempt);
  executionScope.write(firstAttempt);
  newChatScope.clear();

  const reloadedExecutionScope = createDeviceManagedChatRecoveryStore({
    ownerId: "owner",
    backendId: "backend",
    executionId: "execution-1",
    storage
  });
  assert.equal(
    reloadedExecutionScope?.read()?.draft,
    "Prepare the release notes"
  );
  assert.equal(reloadedExecutionScope?.read()?.pendingOperation, undefined);
});

test("retries only the exact retained request with its original idempotency identity", () => {
  const request = {
    kind: "prompt" as const,
    projectId: "project-a",
    executionId: "execution-a",
    executionGeneration: 3,
    agentId: "agent-a",
    agentVersion: 4,
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "gpt-test",
    reasoningEffort: "high",
    permissionMode: "supervised",
    expectedSettings: {
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "supervised"
    }
  };
  const requestFingerprint = managedChatSendRequestFingerprint(request);
  const operation = {
    kind: "prompt" as const,
    startIdempotencyKey: "stable-start-key",
    promptIdempotencyKey: "stable-command-key",
    clientUserMessageId: "stable-client-message-id",
    executionGeneration: 3,
    prompt: "Make a change",
    requestFingerprint,
    state: "reconciling" as const
  };
  const record = {
    schemaVersion: 1 as const,
    draft: operation.prompt,
    pendingOperation: operation
  };
  assert.deepEqual(
    reusableManagedChatSendIdentity(
      record,
      operation.prompt,
      requestFingerprint
    ),
    {
      promptIdempotencyKey: operation.promptIdempotencyKey,
      clientUserMessageId: operation.clientUserMessageId,
      startIdempotencyKey: operation.startIdempotencyKey
    }
  );
  assert.equal(
    reusableManagedChatSendIdentity(
      record,
      "A different prompt",
      requestFingerprint
    ),
    null
  );
  assert.equal(
    reusableManagedChatSendIdentity(
      record,
      operation.prompt,
      managedChatSendRequestFingerprint({ ...request, model: "gpt-other" })
    ),
    null
  );
  assert.equal(
    reusableManagedChatSendIdentity(
      record,
      operation.prompt,
      managedChatSendRequestFingerprint({
        ...request,
        permissionMode: "full_access"
      })
    ),
    null
  );
  assert.equal(
    reusableManagedChatSendIdentity(
      record,
      operation.prompt,
      managedChatSendRequestFingerprint({ ...request, projectId: "project-b" })
    ),
    null
  );
  assert.equal(
    reusableManagedChatSendIdentity(
      {
        ...record,
        pendingOperation: { ...operation, state: "accepted" }
      },
      operation.prompt,
      requestFingerprint
    ),
    null
  );
});

test("binds a fresh Team request start fingerprint to both server versions", () => {
  const start = {
    kind: "start" as const,
    projectId: "project-a",
    executionId: null,
    executionGeneration: null,
    agentId: "agent-a",
    agentVersion: 4,
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "gpt-test",
    reasoningEffort: "high",
    permissionMode: "supervised",
    expectedSettings: null,
    teamAgentRequestBinding: ["request-a", 2, 5] as const
  };
  const fingerprint = managedChatSendRequestFingerprint(start);
  assert.notEqual(
    managedChatSendRequestFingerprint({
      ...start,
      teamAgentRequestBinding: ["request-b", 2, 5]
    }),
    fingerprint
  );
  assert.notEqual(
    managedChatSendRequestFingerprint({
      ...start,
      teamAgentRequestBinding: ["request-a", 3, 5]
    }),
    fingerprint
  );
  assert.notEqual(
    managedChatSendRequestFingerprint({
      ...start,
      teamAgentRequestBinding: ["request-a", 2, 6]
    }),
    fingerprint
  );
});

test("reuses a retained first prompt identity after its bare start completed", () => {
  const prompt = "Reply exactly: local recovery verified.";
  const startFingerprint = managedChatSendRequestFingerprint({
    kind: "start",
    projectId: null,
    executionId: null,
    executionGeneration: null,
    agentId: "agent-a",
    agentVersion: 1,
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    permissionMode: "full_access",
    expectedSettings: null
  });
  const pendingOperation = {
    kind: "start" as const,
    startIdempotencyKey: "stable-start-key",
    promptIdempotencyKey: "stable-prompt-key",
    clientUserMessageId: "stable-message-id",
    prompt,
    requestFingerprint: startFingerprint,
    state: "reconciling" as const
  };
  const record = {
    schemaVersion: 1 as const,
    draft: prompt,
    pendingOperation
  };
  const firstPromptFingerprint = managedChatSendRequestFingerprint({
    kind: "prompt",
    projectId: null,
    executionId: "execution-a",
    executionGeneration: 1,
    agentId: "agent-a",
    agentVersion: 1,
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    permissionMode: "full_access",
    expectedSettings: {
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      permissionMode: "full_access"
    }
  });
  const earlyRecoveryFingerprint = managedChatSendRequestFingerprint({
    kind: "prompt",
    projectId: null,
    executionId: "execution-a",
    executionGeneration: null,
    agentId: "agent-a",
    agentVersion: 1,
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    permissionMode: "full_access",
    expectedSettings: null
  });

  assert.deepEqual(
    reusableManagedChatSendIdentity(record, prompt, firstPromptFingerprint),
    {
      promptIdempotencyKey: pendingOperation.promptIdempotencyKey,
      clientUserMessageId: pendingOperation.clientUserMessageId,
      startIdempotencyKey: pendingOperation.startIdempotencyKey
    }
  );
  assert.deepEqual(
    reusableManagedChatSendIdentity(record, prompt, earlyRecoveryFingerprint),
    {
      promptIdempotencyKey: pendingOperation.promptIdempotencyKey,
      clientUserMessageId: pendingOperation.clientUserMessageId,
      startIdempotencyKey: pendingOperation.startIdempotencyKey
    }
  );
  assert.equal(
    reusableManagedChatSendIdentity(
      record,
      prompt,
      managedChatSendRequestFingerprint({
        kind: "prompt",
        projectId: null,
        executionId: "execution-a",
        executionGeneration: 1,
        agentId: "agent-a",
        agentVersion: 2,
        provider: "codex",
        aiClientInstanceId: "codex.default",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        permissionMode: "full_access",
        expectedSettings: {
          model: "gpt-5.6-luna",
          reasoningEffort: "low",
          permissionMode: "full_access"
        }
      })
    ),
    null
  );
  assert.equal(
    reusableManagedChatSendIdentity(
      record,
      prompt,
      managedChatSendRequestFingerprint({
        kind: "prompt",
        projectId: null,
        executionId: "execution-a",
        executionGeneration: 1,
        agentId: "agent-a",
        agentVersion: 1,
        provider: "codex",
        aiClientInstanceId: "codex.default",
        model: "gpt-other",
        reasoningEffort: "low",
        permissionMode: "full_access",
        expectedSettings: {
          model: "gpt-5.6-luna",
          reasoningEffort: "low",
          permissionMode: "full_access"
        }
      })
    ),
    null
  );
  assert.equal(
    reusableManagedChatSendIdentity(
      record,
      "Changed goal",
      firstPromptFingerprint
    ),
    null
  );
});

test("settles a confirmed start before sending its retained prompt", () => {
  const record = {
    schemaVersion: 1 as const,
    draft: "Continue after launch",
    pendingOperation: {
      kind: "start" as const,
      startIdempotencyKey: "stable-start-key",
      promptIdempotencyKey: "unused-prompt-key",
      clientUserMessageId: "unused-message-id",
      prompt: "Continue after launch",
      requestFingerprint: "start-request",
      state: "reconciling" as const
    }
  };
  assert.deepEqual(settleManagedChatStartRecovery(record, "dispatching"), {
    schemaVersion: 1,
    draft: record.draft
  });
  assert.deepEqual(
    settleManagedChatStartRecovery(record, "indeterminate"),
    record
  );
});

test("keeps unrecognized command states uncertain and permits legacy retries only with the saved prompt", () => {
  assert.equal(managedChatRecoveryCommandDisposition("queued"), "pending");
  assert.equal(managedChatRecoveryCommandDisposition("completed"), "completed");
  assert.equal(
    managedChatRecoveryCommandDisposition("future_state"),
    "uncertain"
  );
  assert.equal(
    managedChatRecoveryCommandDisposition("indeterminate"),
    "uncertain"
  );

  const operation = {
    kind: "prompt" as const,
    startIdempotencyKey: "legacy-start-key",
    promptIdempotencyKey: "legacy-prompt-key",
    clientUserMessageId: "legacy-message-id",
    executionGeneration: 3,
    prompt: "Keep this exact prompt",
    state: "reconciling" as const
  };
  const record = {
    schemaVersion: 1 as const,
    draft: operation.prompt,
    pendingOperation: operation
  };
  assert.deepEqual(
    reusableManagedChatSendIdentity(
      record,
      operation.prompt,
      "current-settings-fingerprint"
    ),
    {
      promptIdempotencyKey: operation.promptIdempotencyKey,
      clientUserMessageId: operation.clientUserMessageId,
      startIdempotencyKey: operation.startIdempotencyKey
    }
  );
  assert.equal(
    reusableManagedChatSendIdentity(
      record,
      "Changed prompt",
      "current-settings-fingerprint"
    ),
    null
  );
});

test("reconciles a late runtime command only for the retained prompt identity", () => {
  const operation = {
    kind: "prompt" as const,
    startIdempotencyKey: "start-key",
    promptIdempotencyKey: "prompt-key",
    clientUserMessageId: "message-id",
    executionGeneration: 4,
    prompt: "Retained prompt",
    state: "reconciling" as const
  };
  assert.equal(
    managedChatCommandMatchesPendingPrompt(
      operation,
      { commandKind: "prompt", clientUserMessageId: "message-id" },
      4
    ),
    true
  );
  assert.equal(
    managedChatCommandMatchesPendingPrompt(
      operation,
      { commandKind: "prompt", clientUserMessageId: "another-message" },
      4
    ),
    false
  );
  assert.equal(
    managedChatCommandMatchesPendingPrompt(
      operation,
      { commandKind: "prompt", clientUserMessageId: "message-id" },
      5
    ),
    false
  );
});

test("rejects malformed recovery data and clears only the selected scope", () => {
  const storage = new MemoryStorage();
  const one = createDeviceManagedChatRecoveryStore({
    ownerId: "owner",
    backendId: "backend",
    executionId: "one",
    storage
  });
  const two = createDeviceManagedChatRecoveryStore({
    ownerId: "owner",
    backendId: "backend",
    executionId: "two",
    storage
  });
  assert.ok(one && two);
  one.write({ schemaVersion: 1, draft: "a" });
  two.write({ schemaVersion: 1, draft: "b" });
  const firstKey = [...storage.values.keys()].find((key) =>
    key.endsWith(":one")
  );
  assert.ok(firstKey);
  storage.values.set(firstKey, JSON.stringify({ schemaVersion: 1, draft: 3 }));
  assert.equal(one.read(), null);
  one.clear();
  assert.equal(two.read()?.draft, "b");
});

test("Desktop recovery survives a changed loopback origin and preserves scoped send identity", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const values = new Map<string, string>();
  const reference = ({
    ownerId,
    executionId
  }: {
    ownerId: string;
    executionId: string;
  }) => `${ownerId}:${executionId}`;
  (globalThis as { window?: unknown }).window = {
    koedStudioChatRecovery: {
      read: async (scope: { ownerId: string; executionId: string }) =>
        values.get(reference(scope)) ?? null,
      write: async (scope: {
        ownerId: string;
        executionId: string;
        value: string;
      }) => {
        values.set(reference(scope), scope.value);
      },
      delete: async (scope: { ownerId: string; executionId: string }) => {
        values.delete(reference(scope));
      }
    }
  };
  try {
    const first = createLocalManagedChatRecoveryStore({
      ownerId: "owner-a",
      backendId: "http://127.0.0.1:58523",
      executionId: null
    });
    const operation = {
      kind: "start" as const,
      startIdempotencyKey: "start-key",
      promptIdempotencyKey: "prompt-key",
      clientUserMessageId: "message-key",
      prompt: "Work on this",
      state: "pending" as const
    };
    first.write({
      schemaVersion: 1,
      draft: operation.prompt,
      pendingOperation: operation
    });
    const afterRestart = createLocalManagedChatRecoveryStore({
      ownerId: "owner-a",
      backendId: "http://127.0.0.1:59852",
      executionId: null
    });
    await afterRestart.hydrate?.();
    assert.deepEqual(afterRestart.read()?.pendingOperation, operation);
    assert.equal(afterRestart.read()?.draft, operation.prompt);
    const otherOwner = createLocalManagedChatRecoveryStore({
      ownerId: "owner-b",
      backendId: "http://127.0.0.1:59852",
      executionId: null
    });
    await otherOwner.hydrate?.();
    assert.equal(otherOwner.read(), null);
    afterRestart.clear();
    const cleared = createLocalManagedChatRecoveryStore({
      ownerId: "owner-a",
      backendId: "http://127.0.0.1:59852",
      executionId: null
    });
    await cleared.hydrate?.();
    assert.equal(cleared.read(), null);
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test("Desktop send identity flush waits for the encrypted bridge write", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  let releaseWrite: (() => void) | undefined;
  let completed = false;
  (globalThis as { window?: unknown }).window = {
    koedStudioChatRecovery: {
      read: async () => null,
      write: async () => {
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        completed = true;
      },
      delete: async () => undefined
    }
  };
  try {
    const store = createLocalManagedChatRecoveryStore({
      ownerId: "owner",
      backendId: "temporary-origin",
      executionId: null
    });
    store.write({
      schemaVersion: 1,
      draft: "Send",
      pendingOperation: {
        kind: "start",
        startIdempotencyKey: "start",
        promptIdempotencyKey: "prompt",
        clientUserMessageId: "message",
        prompt: "Send",
        state: "pending"
      }
    });
    const flushed = store.flush?.();
    assert.ok(flushed);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(completed, false);
    assert.ok(releaseWrite);
    releaseWrite();
    await flushed;
    assert.equal(completed, true);
  } finally {
    releaseWrite?.();
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test("browser send identity persistence reports storage failure before submit", () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota unavailable");
    },
    removeItem: () => undefined
  };
  const store = createDeviceManagedChatRecoveryStore({
    ownerId: "owner",
    backendId: "backend",
    executionId: null,
    storage
  });
  assert.ok(store);
  const record = { schemaVersion: 1 as const, draft: "Send" };
  assert.doesNotThrow(() => store.write(record));
  assert.throws(() => store.writeDurably?.(record), /quota unavailable/);
});

test("keeps stopped-session resume intent and the original prompt identity across restart", () => {
  const storage = new MemoryStorage();
  const scope = {
    ownerId: "owner",
    backendId: "backend",
    executionId: "stopped-chat",
    storage
  };
  const store = createDeviceManagedChatRecoveryStore(scope);
  assert.ok(store);
  const operation = {
    kind: "prompt" as const,
    startIdempotencyKey: "unused-start",
    promptIdempotencyKey: "same-prompt",
    clientUserMessageId: "same-message",
    executionGeneration: 4,
    prompt: "Continue our discussion",
    resumeFromStopped: true as const,
    requestFingerprint: "unchanged-settings",
    state: "pending" as const
  };
  store.write({
    schemaVersion: 1,
    draft: operation.prompt,
    pendingOperation: operation
  });
  const restored = createDeviceManagedChatRecoveryStore(scope)?.read();
  assert.deepEqual(restored?.pendingOperation, operation);
  assert.deepEqual(
    reusableManagedChatSendIdentity(
      restored ?? null,
      operation.prompt,
      operation.requestFingerprint
    ),
    {
      startIdempotencyKey: operation.startIdempotencyKey,
      promptIdempotencyKey: operation.promptIdempotencyKey,
      clientUserMessageId: operation.clientUserMessageId
    }
  );
  const [key] = storage.values.keys();
  storage.values.set(
    key!,
    JSON.stringify({
      schemaVersion: 1,
      draft: "unsent",
      pendingOperation: { ...operation, resumeFromStopped: "yes" }
    })
  );
  assert.equal(createDeviceManagedChatRecoveryStore(scope)?.read(), null);
});
