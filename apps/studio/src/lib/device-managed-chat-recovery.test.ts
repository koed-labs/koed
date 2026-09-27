import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error -- Node's native test runner imports TypeScript sources directly.
import { createDeviceManagedChatRecoveryStore } from "./device-managed-chat-recovery.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test("restores an unsent draft on this device and isolates its owner, backend, and conversation", () => {
  const storage = new MemoryStorage();
  const first = createDeviceManagedChatRecoveryStore({ ownerId: "owner-a", backendId: "backend-a", executionId: "execution-a", storage });
  const sameScope = createDeviceManagedChatRecoveryStore({ ownerId: "owner-a", backendId: "backend-a", executionId: "execution-a", storage });
  assert.ok(first && sameScope);
  first.write({ schemaVersion: 1, draft: "keep this unsent" });
  assert.deepEqual(sameScope.read(), { schemaVersion: 1, draft: "keep this unsent" });
  for (const scope of [
    { ownerId: "owner-b", backendId: "backend-a", executionId: "execution-a" },
    { ownerId: "owner-a", backendId: "backend-b", executionId: "execution-a" },
    { ownerId: "owner-a", backendId: "backend-a", executionId: "execution-b" }
  ]) {
    const isolated = createDeviceManagedChatRecoveryStore({ ...scope, storage });
    assert.equal(isolated?.read(), null);
  }
});

test("persists launch and prompt identity without marking it resubmittable", () => {
  const storage = new MemoryStorage();
  const store = createDeviceManagedChatRecoveryStore({ ownerId: "owner", backendId: "backend", executionId: null, storage });
  assert.ok(store);
  const operation = {
    kind: "prompt" as const,
    startIdempotencyKey: "stable-start-key",
    promptIdempotencyKey: "stable-command-key",
    clientUserMessageId: "stable-client-message-id",
    executionGeneration: 3,
    prompt: "Make a change",
    state: "reconciling" as const
  };
  store.write({ schemaVersion: 1, draft: "Make a change", pendingOperation: operation });
  const recovered = createDeviceManagedChatRecoveryStore({ ownerId: "owner", backendId: "backend", executionId: null, storage })?.read();
  assert.deepEqual(recovered?.pendingOperation, operation);
  assert.equal(recovered?.draft, "Make a change");
});

test("rejects malformed recovery data and clears only the selected scope", () => {
  const storage = new MemoryStorage();
  const one = createDeviceManagedChatRecoveryStore({ ownerId: "owner", backendId: "backend", executionId: "one", storage });
  const two = createDeviceManagedChatRecoveryStore({ ownerId: "owner", backendId: "backend", executionId: "two", storage });
  assert.ok(one && two);
  one.write({ schemaVersion: 1, draft: "a" });
  two.write({ schemaVersion: 1, draft: "b" });
  const firstKey = [...storage.values.keys()].find((key) => key.endsWith(":one"));
  assert.ok(firstKey);
  storage.values.set(firstKey, JSON.stringify({ schemaVersion: 1, draft: 3 }));
  assert.equal(one.read(), null);
  one.clear();
  assert.equal(two.read()?.draft, "b");
});
