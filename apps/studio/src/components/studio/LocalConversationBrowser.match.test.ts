import assert from "node:assert/strict";
import test from "node:test";
// Node 24's native TypeScript runner requires the source extension here.
// @ts-expect-error -- Next's app compiler does not enable TS extension imports.
import { isSyntheticIndependentProject, managedConversationSourceIds, matchLocalConversationToHome, matchManagedExecutionForCapturedSession } from "./LocalConversationBrowser.match.ts";
import type { HomeExecution, HomeRecent } from "@/lib/studio-contract";

const recent: HomeRecent = {
  id: "native/thread-1",
  sessionId: "koed-session-1",
  projectId: "project-1",
  projectName: "Project",
  title: "Captured conversation",
  provider: "codex-cli",
  updatedAt: "2026-09-25T10:00:00.000Z"
};

const execution: HomeExecution = {
  id: "managed-execution-1",
  sessionId: recent.sessionId,
  projectId: recent.projectId,
  title: recent.title,
  provider: "codex",
  state: "running",
  updatedAt: recent.updatedAt,
  error: null
};

test("matches the exact native thread ID and normalized provider to a managed execution", () => {
  assert.deepEqual(
    matchLocalConversationToHome({
      sourceId: "codex:native%2Fthread-1",
      provider: "codex",
      recents: [recent],
      executions: [execution]
    }),
    { type: "managed", executionId: execution.id }
  );
});

test("identifies an exact captured source without implying a managed execution", () => {
  assert.deepEqual(
    matchLocalConversationToHome({
      sourceId: "codex:native%2Fthread-1",
      provider: "codex",
      recents: [recent],
      executions: []
    }),
    { type: "captured", recent }
  );
});

test("rejects provider, native ID, malformed ID, and inactive execution mismatches", () => {
  const base = {
    sourceId: "codex:native%2Fthread-1",
    provider: "codex" as const,
    recents: [recent],
    executions: [execution]
  };
  assert.equal(
    matchLocalConversationToHome({ ...base, sourceId: "codex:other-thread" }),
    null
  );
  assert.equal(
    matchLocalConversationToHome({ ...base, provider: "pi" }),
    null
  );
  assert.equal(
    matchLocalConversationToHome({ ...base, sourceId: "codex:%E0%A4%A" }),
    null
  );
  assert.deepEqual(
    matchLocalConversationToHome({
      ...base,
      executions: [{ ...execution, state: "complete" }]
    }),
    { type: "captured", recent }
  );
});

test("does not call a source uncaptured solely because it is outside Home recents", () => {
  assert.equal(
    matchLocalConversationToHome({
      sourceId: "codex:native%2Fthread-1",
      provider: "codex",
      recents: [],
      executions: []
    }),
    null
  );
});

test("resumes a resolved session only for one same-provider running or ready execution", () => {
  assert.equal(
    matchManagedExecutionForCapturedSession({
      sessionId: recent.sessionId,
      provider: "codex",
      executions: [execution]
    }),
    execution.id
  );
  assert.equal(
    matchManagedExecutionForCapturedSession({
      sessionId: recent.sessionId,
      provider: "claude-code",
      executions: [execution]
    }),
    null
  );
  assert.equal(
    matchManagedExecutionForCapturedSession({
      sessionId: recent.sessionId,
      provider: "codex",
      executions: [{ ...execution, state: "complete" }]
    }),
    null
  );
});

test("deduplicates captured catalog rows only when their session resolves to one active managed execution", () => {
  assert.deepEqual(
    managedConversationSourceIds({ recents: [recent], executions: [execution] }),
    new Set(["codex:native%2Fthread-1"])
  );
  assert.deepEqual(
    managedConversationSourceIds({ recents: [recent], executions: [] }),
    new Set()
  );
  assert.deepEqual(
    managedConversationSourceIds({
      recents: [recent],
      executions: [execution, { ...execution, id: "another-execution" }]
    }),
    new Set()
  );
});

test("recognizes synthetic runtime UUID project groups but preserves opaque registered IDs", () => {
  assert.equal(
    isSyntheticIndependentProject("77b28db5-addf-49b5-b20f-402c676238ad"),
    true
  );
  assert.equal(
    isSyntheticIndependentProject(
      "local-project:hash",
      "77b28db5-addf-49b5-b20f-402c676238ad"
    ),
    true
  );
  assert.equal(
    isSyntheticIndependentProject("lp_0123456789abcdef0123456789abcdef"),
    false
  );
});
