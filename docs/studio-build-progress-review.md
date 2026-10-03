# Studio Build progress review

Build progress is an owner-only view of events recorded by a managed runtime for a selected Personal Agent Job. The story uses runtime lifecycle events and explicit Agent phase/status signals. It does not summarize transcripts or infer progress from generated text.

Codex app-server item callbacks and Claude SDK tool-use/result messages supply actual shell command starts and results while a Job runs. Build progress records those provider events directly, without reading a conversation transcript. Command text and results are bounded and common credentials are redacted. Pi's managed RPC stream does not currently expose normalized shell-command start and result events, so Pi Jobs report that command history is unavailable while retaining lifecycle and workspace observations.

The runtime records a starting Git observation and later read-only Git observations from the server-validated Project folder. Changes already present at Job start are marked as baseline. Later observations state that timing does not establish authorship. A finished Job uses its recorded events and final observation; opening an older Job does not inspect the current folder. Files outside Git, missing folders, and Jobs without a Project report unavailable workspace details.

History is encrypted in the owner's Personal Agent Job record. The API checks the owner, Job, execution, generation, runner, and active attempt before accepting an event. Needs-your-input links use the existing runtime question or approval item; resolved items no longer carry an actionable attention link in Build progress.

## Focused verification

Run the source checks from the integration repository with Node 24 on `PATH`:

```sh
pnpm --filter @koed/shared build
pnpm --filter @koed/db build
pnpm --filter @koed/mcp-server build
pnpm --filter @koed/db exec vitest run src/personal-agent-repository.test.ts
pnpm --filter @koed/worker exec vitest run src/build-progress-capture.test.ts
pnpm --filter @koed/mcp-server exec vitest run tests/codex-app-server-runner.test.ts tests/claude-managed-conversation.test.ts
pnpm --filter @koed/api exec vitest run --config ../../vitest.config.ts src/managed-conversations/routes.test.ts src/managed-conversations/runner-routes.test.ts
pnpm --filter @koed/api typecheck
pnpm --filter @koed/worker typecheck
pnpm --filter @koed/studio typecheck
node --test apps/studio/src/lib/studio-build-activity.test.ts apps/studio/src/lib/hosted-managed-chats.test.ts apps/studio/src/lib/device-managed-chat-recovery.test.ts
```

Focused results on Node 24: API route tests 100/100, repository tests 18/18, provider event tests 65/65, capture tests 3/3, and Studio activity/hosted/recovery tests 49/49. API, worker, and Studio typechecks pass. The capture tests cover missing and non-Git folders, a clean Project, and baseline versus later file changes. The repository test checks encrypted-at-rest payloads and rejects a different owner. The route tests cover owner/generation/current-attempt fences and hosted resource-scope forwarding.

## Manual review with the existing Studio session

1. Open a managed Personal Agent Conversation with a Project and start a Job.
2. Check that Build progress selects the running Job and displays the runtime's start/phase events.
3. Make a change through the Agent and check that the workspace view labels changes as observed, not authored. Check that a pre-existing changed file is marked baseline.
4. If the runtime asks a question or requests approval, use the Build attention link and verify it opens the existing control. Resolve the request and check that the Build link is no longer actionable.
5. Select a completed older Job. Confirm its recorded progress remains stable while the current workspace changes.
6. Check the Advanced view for only runner-reported commands/results and captured Git metadata. A no-Project Job should show that workspace details are unavailable.

Migrations 0069 and 0070 were applied to the isolated Mac staging database. A real PostgreSQL acceptance probe passed owner separation, stale-generation and settled-attempt rejection, duplicate-event idempotency and encrypted-at-rest storage. The interactive live-Job flow above remains a separate review check; database fixtures do not establish live provider execution.

## Bounded hosted execution checkpoint

An isolated owner-authenticated Codex managed Conversation started through the hosted authority and was stopped through its supported Stop command; the final execution state was `stopped`. This was a standalone managed Conversation, not a Personal Agent Job. It therefore does not establish saved Job Build events, observed changes or completed Job history. Those live acceptance items remain open. The disposable runtime/profile was stopped and removed; staging accounts and original User provider data/settings were not modified by cleanup.
