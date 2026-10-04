import assert from "node:assert/strict";
import test from "node:test";
// Node 24's native TypeScript runner requires the source extension here.
import {
  indexShareableConversationRows,
  indexShareablePersonalConversations,
  isSyntheticIndependentProject,
  managedConversationActivityLabel,
  managedConversationSourceIds,
  managedProviderSourceIdsByExecution,
  matchLocalConversationToHome,
  matchManagedExecutionForCapturedSession,
  ownedMemoryForCapturedSession,
  ownerMemoryLoadMayApply,
  ownerSnapshotMaySurviveRefresh,
  shareDialogSourceMayRemainOpen
  // @ts-expect-error -- Next's app compiler does not enable TS extension imports.
} from "./LocalConversationBrowser.match.ts";
import type { HomeExecution, HomeRecent } from "@/lib/studio-contract";
import type { PersonalMemoryEntry } from "@koed/shared/collaboration";

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

test("indexes only owner memory entries with a logical memory identity", () => {
  const entry = (value: Partial<PersonalMemoryEntry>): PersonalMemoryEntry => ({
    id: "koed-session-1",
    logicalMemoryId: "logical-memory-1",
    title: "Owner title",
    projectName: null,
    updatedAt: recent.updatedAt,
    preview: "",
    eventCount: 1,
    hasSynchronizedRevision: false,
    syncState: "not_started",
    ...value
  });
  const index = indexShareablePersonalConversations([
    entry({}),
    entry({ id: "not-ready", logicalMemoryId: null })
  ]);

  assert.equal(
    ownedMemoryForCapturedSession({
      sessionId: recent.sessionId,
      entriesBySessionId: index
    })?.logicalMemoryId,
    "logical-memory-1"
  );
  assert.equal(
    ownedMemoryForCapturedSession({
      sessionId: "codex:native%2Fthread-1",
      entriesBySessionId: index
    }),
    null
  );
  assert.equal(
    ownedMemoryForCapturedSession({
      sessionId: "not-ready",
      entriesBySessionId: index
    }),
    null
  );
  const rows = indexShareableConversationRows({
    entriesBySessionId: index,
    recents: [recent],
    executions: [execution]
  });
  assert.equal(
    rows.byLocalSourceId.get("codex:native%2Fthread-1")?.id,
    "koed-session-1"
  );
  assert.equal(rows.byExecutionId.get(execution.id)?.id, "koed-session-1");
  assert.equal(rows.byExecutionId.has("koed-session-1"), false);
});

test("rejects owner memory loads after a scope or request generation changes", () => {
  const current = {
    active: true,
    sequence: 3,
    currentSequence: 3,
    homeScopeKey: "account-a",
    currentHomeScopeKey: "account-a"
  };
  assert.equal(ownerMemoryLoadMayApply(current), true);
  assert.equal(
    ownerMemoryLoadMayApply({ ...current, currentSequence: 4 }),
    false
  );
  assert.equal(
    ownerMemoryLoadMayApply({ ...current, currentHomeScopeKey: "account-b" }),
    false
  );
  assert.equal(ownerMemoryLoadMayApply({ ...current, active: false }), false);
});

test("keeps an open share dialog through same-authority refresh but closes on scope, authority, or source change", () => {
  const current = {
    sourceHomeScopeKey: "home-a",
    currentHomeScopeKey: "home-a",
    sourceAuthorityKey: "backend-a:user-a",
    currentAuthorityKey: "backend-a:user-a",
    sourceLogicalMemoryId: "memory-a",
    currentLogicalMemoryId: "memory-a"
  };
  assert.equal(shareDialogSourceMayRemainOpen(current), true);
  assert.equal(
    shareDialogSourceMayRemainOpen({
      ...current,
      currentHomeScopeKey: "home-b"
    }),
    false
  );
  assert.equal(
    shareDialogSourceMayRemainOpen({
      ...current,
      currentAuthorityKey: "backend-a:user-b"
    }),
    false
  );
  assert.equal(
    shareDialogSourceMayRemainOpen({
      ...current,
      currentLogicalMemoryId: "memory-b"
    }),
    false
  );
});

test("keeps a same-scope owner snapshot after transient failure but clears it on explicit authorization denial", () => {
  assert.equal(
    ownerSnapshotMaySurviveRefresh({
      sameHomeScope: true,
      authorizationDenied: false
    }),
    true
  );
  assert.equal(
    ownerSnapshotMaySurviveRefresh({
      sameHomeScope: true,
      authorizationDenied: true
    }),
    false
  );
  assert.equal(
    ownerSnapshotMaySurviveRefresh({
      sameHomeScope: false,
      authorizationDenied: false
    }),
    false
  );
});

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
  assert.equal(matchLocalConversationToHome({ ...base, provider: "pi" }), null);
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

test("resolves terminal managed history when there is no active execution", () => {
  for (const state of ["stopped", "failed", "fenced"] as const) {
    const history = { ...execution, id: `history-${state}`, state };
    assert.equal(
      matchManagedExecutionForCapturedSession({
        sessionId: recent.sessionId,
        provider: "codex",
        executions: [history]
      }),
      history.id
    );
    assert.deepEqual(
      matchLocalConversationToHome({
        sourceId: "codex:native%2Fthread-1",
        provider: "codex",
        recents: [recent],
        executions: [history]
      }),
      { type: "managed", executionId: history.id }
    );
  }
});

test("prefers one active execution over terminal history and refuses ambiguous matches", () => {
  const stopped = { ...execution, id: "stopped", state: "stopped" };
  assert.equal(
    matchManagedExecutionForCapturedSession({
      sessionId: recent.sessionId,
      provider: "codex",
      executions: [stopped, execution]
    }),
    execution.id
  );
  assert.equal(
    matchManagedExecutionForCapturedSession({
      sessionId: recent.sessionId,
      provider: "codex",
      executions: [stopped, execution, { ...execution, id: "another-active" }]
    }),
    null
  );
  assert.equal(
    matchManagedExecutionForCapturedSession({
      sessionId: recent.sessionId,
      provider: "codex",
      executions: [stopped, { ...stopped, id: "another-stopped" }]
    }),
    null
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

test("deduplicates captured catalog rows when their session resolves to one managed row", () => {
  assert.deepEqual(
    managedConversationSourceIds({
      recents: [recent],
      executions: [execution]
    }),
    new Set(["codex:native%2Fthread-1"])
  );
  assert.deepEqual(
    managedConversationSourceIds({ recents: [recent], executions: [] }),
    new Set()
  );
  assert.deepEqual(
    managedConversationSourceIds({
      recents: [recent],
      executions: [{ ...execution, state: "stopped" }]
    }),
    new Set(["codex:native%2Fthread-1"])
  );
  assert.deepEqual(
    managedConversationSourceIds({
      recents: [recent],
      executions: [execution, { ...execution, id: "another-execution" }]
    }),
    new Set()
  );
});

test("maps known provider source IDs to the unique matching managed execution", () => {
  assert.deepEqual(
    managedProviderSourceIdsByExecution({
      recents: [recent],
      executions: [execution]
    }),
    { [execution.id]: ["codex:native%2Fthread-1"] }
  );
  assert.deepEqual(
    managedProviderSourceIdsByExecution({
      recents: [recent],
      executions: [execution, { ...execution, id: "another-execution" }]
    }),
    {}
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

test("labels managed rows by observed activity rather than execution lifecycle", () => {
  assert.equal(managedConversationActivityLabel("running"), "Working");
  assert.equal(managedConversationActivityLabel("pending"), "Queued");
  assert.equal(
    managedConversationActivityLabel("uncertain"),
    "Status uncertain"
  );
  assert.equal(managedConversationActivityLabel("idle"), "Idle");
  assert.equal(
    managedConversationActivityLabel("running", "running"),
    "Working"
  );
  assert.equal(managedConversationActivityLabel("idle", "stopped"), "Stopped");
  assert.equal(managedConversationActivityLabel("idle", "failed"), "Failed");
  assert.equal(
    managedConversationActivityLabel("idle", "fenced"),
    "Disconnected"
  );
  assert.equal(
    managedConversationActivityLabel(undefined),
    "Activity unverified"
  );
});
