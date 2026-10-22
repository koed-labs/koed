import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";
import {
  createManagedMemoryActionObserver,
  createManagedMemoryActionProcessor
} from "../../worker/dist/memory-action-observer.js";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-901-forget", "screenshots");
const profile = process.env.KOED_HQ901_FORGET_USER_DATA_DIR;
assert.ok(
  profile && dirname(resolve(profile)) === scratch,
  "Use an isolated HQ-901 forget profile"
);
app.setPath("userData", profile);

const owner = "00000000-0000-4000-8000-000000000109";
const executionId = "00000000-0000-4000-8000-000000002044";
const commandId = "00000000-0000-4000-8000-000000009183";
const actionId = "00000000-0000-4000-8000-000000009184";
const assertionId = "00000000-0000-4000-8000-000000009185";
const alias = `r${"a".repeat(32)}c1`;
const oldTeamAlias = `r${"b".repeat(32)}c1`;
const leaseToken = "00000000-0000-4000-8000-000000009186";

async function run() {
  let window;
  try {
    await app.whenReady();
    await mkdir(output, { recursive: true });
    window = new BrowserWindow({
      show: true,
      width: 1280,
      height: 800,
      webPreferences: { backgroundThrottling: false }
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, label = source, limit = 120) => {
      for (let i = 0; i < limit; i++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ-901 forget timed out: ${label}; ${await js(`JSON.stringify((() => {
          const composer = document.querySelector('.hq-conversation--active .hq-conversation__dock');
          const input = composer?.querySelector('textarea');
          const send = composer?.querySelector('button[type="submit"]');
          return {
            trace: window.__koedHq204Trace,
            activeConversation: Boolean(document.querySelector('.hq-conversation--active')),
            stopConversation: Boolean(document.querySelector('.hq-conversation__stop')),
            composer: Boolean(composer),
            value: input?.value ?? null,
            sendDisabled: send?.disabled ?? null,
            sendLabel: send?.getAttribute('aria-label') ?? null,
            alerts: [...document.querySelectorAll('[role="alert"]')].map((row) => row.textContent),
            body: document.body.innerText.slice(-700)
          };
        })())`).catch(() => "unavailable")}`
      );
    };
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      {
        query: { view: "hq", hq718Capture: "yes", hq306Capture: "yes" }
      }
    );
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')?.click()"
    );
    await waitFor(
      "!!document.querySelector('.hq-conversation--active .hq-conversation__dock') && !!document.querySelector('.hq-conversation__stop')",
      "resumed HQ Conversation ready"
    );
    await waitFor(
      "!!document.querySelector('.hq-conversation--active .hq-conversation__dock textarea') && !!document.querySelector('.hq-conversation--active .hq-conversation__dock form button[type=\"submit\"]')",
      "ready HQ composer"
    );
    await js(`(() => {
      const input = document.querySelector('.hq-conversation--active .hq-conversation__dock textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Forget that');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(
      "document.querySelector('.hq-conversation--active .hq-conversation__dock form button[type=\"submit\"]')?.disabled === false && document.querySelector('.hq-conversation--active .hq-conversation__dock textarea')?.value === 'Forget that'",
      "enabled typed composer"
    );
    await js(
      "document.querySelector('.hq-conversation--active .hq-conversation__dock form').requestSubmit()"
    );
    await waitFor(
      "window.__koedHq204Trace.nextPrompt === 'Forget that'",
      "typed composer dispatch"
    );
    const typedPrompt = await js("window.__koedHq204Trace.nextPrompt");
    let queued;
    let finished;
    let runtimeOutput;
    let suppressionCalls = 0;
    const command = {
      id: commandId,
      executionId,
      commandKind: "prompt",
      leaseToken,
      state: "dispatching",
      executionGeneration: 1,
      clientUserMessageId: "00000000-0000-4000-8000-000000009187",
      payload: { prompt: typedPrompt },
      createdAt: "2026-10-20T10:02:00Z"
    };
    const repository = {
      getManagedConversationCommand: async () => command,
      getManagedConversationExecution: async () => ({
        id: executionId,
        executionGeneration: 1,
        providerThreadId: "hq-fixture-thread"
      }),
      getManagedConversationRuntimeBinding: async () => ({
        localSessionId: "hq-local-session",
        executionGeneration: 1
      }),
      enqueueManagedMemoryAction: async (_actor, input) => {
        queued = {
          id: actionId,
          state: "pending",
          providerTurnId: input.providerTurnId,
          toolCallId: input.toolCallId,
          actionKind: input.actionKind,
          request: input.request
        };
        return queued;
      },
      listManagedMemoryActionsForCommand: async () => (queued ? [queued] : []),
      withManagedMemoryActionLease: async (_actor, _input, processAction) => {
        const result = await processAction(queued, {
          localSessionId: "hq-local-session",
          clientUserMessageId: command.clientUserMessageId
        });
        finished = { ...queued, result };
        return finished;
      },
      listLcmGraphEvents: async () => [
        {
          actor: "assistant",
          content: `Teammate context [m:${oldTeamAlias}]`,
          timestamp: "2026-10-20T10:00:00Z",
          sourceSequence: 1,
          sessionId: "hq-local-session"
        },
        {
          actor: "assistant",
          content: `Your preference [m:${alias}]`,
          timestamp: "2026-10-20T10:01:00Z",
          sourceSequence: 2,
          sessionId: "hq-local-session"
        }
      ],
      listManagedConversationCitationsByAliases: async () => [
        {
          alias: oldTeamAlias,
          visibility: "team",
          sourceType: "curated_memory",
          sourceId: "team-source",
          providerTurnId: "older-turn"
        },
        {
          alias,
          visibility: "personal",
          sourceType: "curated_memory",
          sourceId: assertionId,
          providerTurnId: "latest-turn"
        }
      ],
      getManagedConversationCitationLocator: async () => ({
        backendId: "fixture-deployment",
        sourceNamespace: "fixture-deployment",
        sourceOwnerPrincipalId: owner,
        visibility: "personal",
        sourceType: "curated_memory",
        sourceId: assertionId,
        questionId: "00000000-0000-4000-8000-000000009188",
        ordinal: 0
      }),
      getManagedPersonalQuestionCitation: async () => ({
        sourceType: "curated_memory",
        sourceId: assertionId,
        sourceOwnerPrincipalId: owner
      }),
      getCuratedMemoryAssertion: async () => ({
        id: assertionId,
        ownerUserId: owner,
        visibility: "personal",
        status: "current",
        suppressedAt: null
      }),
      suppressCuratedMemoryAssertion: async (_actor, id, input) => {
        assert.equal(id, assertionId);
        assert.equal(input.reason, `managed-memory-action:${actionId}`);
        suppressionCalls++;
        return { suppressionToken: "fixture-token" };
      },
      putManagedConversationRuntimeItem: async (_actor, input) => {
        runtimeOutput = input;
        return input;
      }
    };
    const event = {
      execution: {
        id: executionId,
        ownerUserId: owner,
        executionGeneration: 1
      },
      command: { id: commandId, leaseToken },
      providerTurnId: "current-turn",
      toolCallId: "memory-forget-1",
      toolName: "memory_forget",
      arguments: {},
      result: { structuredContent: { status: "requested" } }
    };
    assert.equal(
      await createManagedMemoryActionObserver(repository)(event),
      true,
      "trusted LocalRuntime tool receipt queued action"
    );
    await createManagedMemoryActionProcessor(
      repository,
      "fixture-deployment"
    )({
      ownerUserId: owner,
      executionId,
      commandId,
      leaseToken,
      executionGeneration: 1
    });
    assert.equal(
      suppressionCalls,
      1,
      "latest owned citation suppressed exactly once"
    );
    assert.equal(finished.result.outcome, "forgotten");
    assert.equal(finished.result.citationAlias, alias);
    assert.equal(runtimeOutput.payload.outcome, "forgotten");
    assert.equal(
      JSON.stringify(runtimeOutput).includes("fixture-token"),
      false,
      "suppression token stays private"
    );
    const action = {
      id: actionId,
      executionId,
      actionKind: "forget",
      state: "completed",
      outcome: finished.result.outcome,
      message: finished.result.message,
      assertionId,
      citationAlias: alias,
      createdAt: "2026-10-20T10:02:00Z",
      completedAt: "2026-10-20T10:02:01Z"
    };
    await js(`window.__koedHq718Trace.apply(${JSON.stringify(action)})`);
    await waitFor(
      "document.querySelector('.hq-managed-memory-action')?.textContent.includes('Forgot this memory')",
      "worker receipt projected in HQ",
      140
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-managed-memory-action button')?.textContent.trim()"
      ),
      "Undo"
    );
    await writeFile(
      resolve(output, "forget-that-receipt.png"),
      (await window.webContents.capturePage()).toPNG()
    );
    await js("document.querySelector('button[aria-label=\"Now\"]')?.click()");
    await waitFor(
      "!!document.querySelector('.hq-now') && document.querySelector('button[aria-label=\"Now\"]')?.getAttribute('aria-current') === 'page'",
      "return to Now after memory action"
    );
    const report = {
      id: "HQ901.forget.native",
      owner: "HQ-901",
      status: "pass",
      scope: "renderer-fixture+LocalRuntime-action-observer",
      scenarioAssertions: [
        {
          id: "S18.3.forget-that",
          detail:
            "typed HQ request, trusted memory_forget receipt, latest owned citation selection, exact suppression, projected Undo feedback, and return to Now"
        }
      ],
      screenshots: ["forget-that-receipt.png"]
    };
    await writeFile(
      resolve(scratch, "hq-901-forget", "report.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report));
  } finally {
    window?.destroy();
    app.quit();
  }
}

void run().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
