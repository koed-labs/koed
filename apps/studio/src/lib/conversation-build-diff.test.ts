import { expect, it, vi } from "vitest";
import {
  conversationDiffEvent,
  createConversationBuildDiffLoader
} from "./conversation-build-diff";
import type { RuntimeSnapshot } from "./managed-agent-chat";
const executionId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const checkpoint = "33333333-3333-4333-8333-333333333333";
const runtime: RuntimeSnapshot = {
  execution: {
    id: executionId,
    executionGeneration: 1,
    projectId: "project",
    state: "running",
    stateVersion: 1,
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "model",
    reasoningEffort: "medium",
    permissionMode: "full_access",
    lastErrorCode: null
  },
  items: [],
  latestCommand: {
    id: commandId,
    commandKind: "prompt",
    state: "completed",
    lastErrorCode: null
  }
};
const digest = "a".repeat(64);
const saved = {
  executionId,
  executionGeneration: 1,
  scope: "turn",
  scopeKey: `turn:${commandId}`,
  fromCheckpointId: checkpoint,
  toCheckpointId: checkpoint,
  revisionDigest: digest,
  complete: true,
  truncated: false,
  fileCount: 1,
  byteCount: 100,
  diff: {
    fromCommitObjectId: "a".repeat(40),
    toCommitObjectId: "b".repeat(40),
    complete: true,
    files: [
      {
        path: "index.html",
        status: "added",
        binary: false,
        patch:
          "diff --git a/index.html b/index.html\n--- /dev/null\n+++ b/index.html\n@@ -0,0 +1,3 @@\n+<html>\n+++source line\n+</html>\n",
        patchTruncated: false
      }
    ],
    fileCount: 1,
    returnedFileCount: 1,
    byteCount: 100,
    truncated: false,
    continuation: null,
    revisionDigest: digest
  }
};
const activity = {
  source: "live" as const,
  state: "completed" as const,
  events: []
};
it("maps the saved turn diff to the existing file and line-count presentation", () => {
  const event = conversationDiffEvent(saved, runtime)!;
  expect(event.technical?.files).toEqual([
    {
      path: "index.html",
      change: "added",
      additions: 3,
      deletions: 0,
      patch: saved.diff.files[0].patch,
      patchTruncated: false
    }
  ]);
  expect(event.technical?.diff).toEqual({
    filesChanged: 1,
    additions: 3,
    deletions: 0
  });
  expect(event.technical?.files?.[0].patch).toContain("+<html>");
});
it("rejects a diff for another conversation, generation or prompt", () => {
  for (const change of [
    { executionId: checkpoint },
    { executionGeneration: 2 },
    { scopeKey: "turn:old" },
    { scope: "full", scopeKey: "full" }
  ])
    expect(conversationDiffEvent({ ...saved, ...change }, runtime)).toBeNull();
});
it("leaves line totals unknown when a patch is binary, excluded or incomplete", () => {
  for (const change of [
    { binary: true, patch: null },
    { patchTruncated: true },
    { contentExcluded: true, patch: null }
  ]) {
    const event = conversationDiffEvent(
      {
        ...saved,
        diff: { ...saved.diff, files: [{ ...saved.diff.files[0], ...change }] }
      },
      runtime
    )!;
    expect(event.technical?.diff).toEqual({ filesChanged: 1 });
    expect(event.technical?.files?.[0].additions).toBeUndefined();
  }
  expect(
    conversationDiffEvent({ ...saved, truncated: true }, runtime)?.technical
      ?.diff
  ).toEqual({ filesChanged: 1 });
});
it("fetches a completed turn once per owner scope and caches bounded patches", async () => {
  const load = createConversationBuildDiffLoader();
  const request = vi.fn().mockResolvedValue(saved);
  const first = await load(activity, runtime, "backend:owner", request);
  expect(first.events[0].technical?.files?.[0].path).toBe("index.html");
  await load(activity, runtime, "backend:owner", request);
  expect(request).toHaveBeenCalledTimes(1);
  await load(activity, runtime, "backend:other-owner", request);
  expect(request).toHaveBeenCalledTimes(2);
  await load(
    activity,
    {
      ...runtime,
      latestCommand: { ...runtime.latestCommand!, state: "running" }
    },
    "backend:owner",
    request
  );
  await load(
    { ...activity, jobs: [{ id: "job", title: "job", state: "completed" }] },
    runtime,
    "backend:owner",
    request
  );
  expect(request).toHaveBeenCalledTimes(2);
});
it("does not repeatedly fetch unavailable diffs or cache aborted reads", async () => {
  const load = createConversationBuildDiffLoader();
  const request = vi.fn().mockRejectedValue(new Error("Unavailable"));
  expect(
    (await load(activity, runtime, "scope", request)).events[0].technical
      ?.status
  ).toContain("unknown");
  await load(activity, runtime, "scope", request);
  expect(request).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  controller.abort();
  await load(activity, runtime, "other", request, controller.signal);
  await load(activity, runtime, "other", request);
  expect(request).toHaveBeenCalledTimes(3);
});

it("renders recorded edits for a folder without Git and verifies the turn identity", () => {
  const evidence = {
    executionId,
    executionGeneration: 1,
    scope: "turn",
    scopeKey: `turn:${commandId}`,
    source: "ai_client",
    files: [
      {
        path: "index.html",
        change: "added",
        patch: "+Hello world",
        patchTruncated: false,
        additions: 1,
        deletions: 0
      }
    ]
  };
  expect(
    conversationDiffEvent(evidence, runtime)?.technical?.files?.[0].patch
  ).toBe("+Hello world");
  expect(conversationDiffEvent(evidence, runtime)?.technical?.status).toContain(
    "AI Client"
  );
  expect(
    conversationDiffEvent({ ...evidence, executionGeneration: 2 }, runtime)
  ).toBeNull();
});
it("bounds retained patch text and indicates truncation", () => {
  const event = conversationDiffEvent(
    {
      ...saved,
      diff: {
        ...saved.diff,
        files: [{ ...saved.diff.files[0], patch: "x".repeat(40000) }]
      }
    },
    runtime
  )!;
  expect(event.technical?.files?.[0].patch?.length).toBe(32768);
  expect(event.technical?.files?.[0].patchTruncated).toBe(true);
});

it("labels exec-recorded patches as unverified and retains them alongside named Job activity", async () => {
  const evidence = {
    executionId,
    executionGeneration: 1,
    scope: "turn",
    scopeKey: `turn:${commandId}`,
    source: "ai_client",
    files: [
      {
        path: "index.html",
        change: "modified",
        confirmation: "recorded",
        patch: "@@\n+Say Aloha",
        patchTruncated: false,
        additions: 1,
        deletions: 0
      }
    ]
  };
  const load = createConversationBuildDiffLoader();
  const result = await load(
    { ...activity, jobs: [{ id: "job", title: "Job", state: "completed" }] },
    runtime,
    "owner",
    async () => evidence
  );
  expect(result.recentTurnChanges?.technical?.files?.[0].patch).toContain(
    "+Say Aloha"
  );
  expect(result.recentTurnChanges?.technical?.status).toContain(
    "not independently verified"
  );
});
