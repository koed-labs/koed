import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow, ipcMain } from "electron";
import { storeDesktopLocalCredential } from "@koed/shared";
import { createKoedTextActionObserver } from "../../../apps/worker/dist/koed-text-action-observer.js";
import { createWorkItemCompletionObserver } from "../../../apps/worker/dist/work-item-completion.js";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_WORK_TODO_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ901 to-do profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  await app.whenReady();
  const credentialHome = await mkdtemp(resolve(scratch, "hq901-todo-home-"));
  const ownerUserId = randomUUID();
  const projectId = "00000000-0000-4000-8000-000000002038";
  const chatExecutionId = "00000000-0000-4000-8000-000000002044";
  const workExecutionId = "00000000-0000-4000-8000-000000004404";
  const chatCommandId = randomUUID();
  const workCommandId = randomUUID();
  const chatLease = randomUUID();
  const workLease = randomUUID();
  const itemId = randomUUID();
  let item = null;
  let dispatches = 0;
  let completionCalls = 0;
  const runtime = [];
  storeDesktopLocalCredential(credentialHome, {
    ownerUserId,
    operationFamilies: ["personal_collaboration_write", "managed_execution"]
  });
  ipcMain.handle("hq901:todo-items", () => (item ? [item] : []));
  ipcMain.handle("hq901:todo-dispatch", (_event, input) => {
    assert.equal(input.projectId, projectId);
    assert.equal(input.itemId, itemId);
    assert.equal(input.version, item?.version);
    assert.equal(item?.status, "todo");
    assert.equal(item?.prNumber, null);
    dispatches++;
    item = {
      ...item,
      status: "doing",
      assigneeAgentId: input.agentId,
      executionId: workExecutionId,
      dispatchKey: `${item.id}:${item.version}`,
      version: item.version + 1,
      updatedAt: new Date().toISOString()
    };
    return { item, executionId: workExecutionId, reused: false };
  });
  const add = createKoedTextActionObserver({
    repository: {
      getManagedConversationCommand: async () => ({
        ownerUserId,
        executionId: chatExecutionId,
        commandKind: "prompt",
        executionGeneration: 1,
        state: "dispatching",
        leaseToken: chatLease,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        payload: { prompt: "Add a to-do to check mobile spacing" }
      })
    },
    apiUrl: "http://127.0.0.1:32123",
    koedHome: credentialHome,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.name, "koed_todo_add");
      assert.equal(body.commandId, chatCommandId);
      assert.equal(body.leaseToken, chatLease);
      assert.deepEqual(body.arguments, {
        projectId,
        title: "Check mobile spacing"
      });
      assert.equal(item, null);
      item = {
        id: itemId,
        projectId,
        kind: "todo",
        key: null,
        title: "Check mobile spacing",
        goal: "Check mobile spacing",
        origin: "koed_text_action",
        originRef: "00000000-0000-4000-8000-000000002045",
        idempotencyKey: body.toolCallId,
        status: "todo",
        blockedReason: null,
        assigneeAgentId: null,
        executionId: null,
        dispatchKey: null,
        prProvider: null,
        prNumber: null,
        prUrl: null,
        prState: null,
        dueOn: null,
        doneAt: null,
        doneBy: null,
        createdBy: ownerUserId,
        createdAt: "2026-10-20T09:00:00.000Z",
        updatedAt: "2026-10-20T09:00:00.000Z",
        version: 1
      };
      return new globalThis.Response('{"status":"recorded"}', { status: 202 });
    }
  });
  const complete = createWorkItemCompletionObserver({
    completeForManagedExecutionLease: async (selector) => {
      assert.deepEqual(selector, {
        ownerUserId,
        executionId: workExecutionId,
        commandId: workCommandId,
        leaseToken: workLease
      });
      assert.equal(item?.status, "doing");
      assert.equal(item?.prNumber, null);
      completionCalls++;
      item = {
        ...item,
        status: "done",
        version: item.version + 1,
        doneAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      return item;
    },
    putManagedConversationRuntimeItem: async (_actor, value) => {
      runtime.push(value);
    }
  });
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      backgroundThrottling: false,
      preload: resolve(import.meta.dirname, "hq901-todo-cycle-preload.cjs")
    }
  });
  try {
    const load = () =>
      window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        {
          query: { view: "hq", hq901TodoCycle: "yes" }
        }
      );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(`HQ901 typed to-do did not reach ${source}`);
    };
    const openProject = async () => {
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'"
      );
      await js(
        `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
      );
    };
    await load();
    await openProject();
    await waitFor(
      'document.querySelector(".hq-project-conversation textarea") !== null'
    );
    await js(`(() => {
      const textarea = document.querySelector(".hq-project-conversation textarea");
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setValue.call(textarea, "Add a to-do to check mobile spacing");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitFor(
      'document.querySelector(".hq-project-conversation form button[type=submit]")?.disabled === false'
    );
    await js(
      'document.querySelector(".hq-project-conversation form").requestSubmit()'
    );
    await waitFor(
      'window.__koedHq204Trace.firstPrompt === "Add a to-do to check mobile spacing"'
    );
    assert.equal(
      await add({
        execution: { id: chatExecutionId, ownerUserId, executionGeneration: 1 },
        command: { id: chatCommandId, leaseToken: chatLease },
        providerTurnId: "typed-todo-turn",
        toolCallId: "typed-todo-tool",
        toolName: "koed_todo_add",
        arguments: { projectId, title: "Check mobile spacing" },
        result: { structuredContent: { status: "requested" } }
      }),
      true
    );
    await load();
    await openProject();
    await waitFor(
      'document.querySelector(\'[aria-label="To do"]\')?.textContent.includes("Check mobile spacing")'
    );
    assert.equal(
      await js(
        'document.querySelector(\'[aria-label="Needs you"]\')?.textContent.includes("Check mobile spacing") ?? false'
      ),
      false
    );
    await js(
      "document.querySelector('[aria-label=\"To do\"] .hq-project-view__send').click()"
    );
    await waitFor(
      'document.querySelector(".hq-project-view__send-menu") !== null'
    );
    assert.ok(
      await js(
        'document.querySelector(".hq-project-view__send-menu")?.textContent.includes("Quinn")'
      )
    );
    await js(
      'Array.from(document.querySelectorAll(".hq-project-view__send-menu [role=menuitem]")).find(x => x.textContent.includes("Quinn")).click()'
    );
    await waitFor(
      'document.querySelector(\'[aria-label="Working now"]\')?.textContent.includes("Check mobile spacing")'
    );
    assert.equal(dispatches, 1);
    assert.equal(
      await complete({
        execution: { id: workExecutionId, ownerUserId, executionGeneration: 1 },
        command: { id: workCommandId, leaseToken: workLease },
        providerTurnId: "no-pr-turn",
        toolCallId: "no-pr-complete",
        toolName: "work_item_complete",
        arguments: {},
        result: { structuredContent: { status: "requested" } }
      }),
      true
    );
    assert.equal(completionCalls, 1);
    assert.equal(runtime.at(-1).payload.text, "Work Item completion accepted.");
    await load();
    await openProject();
    await waitFor(
      'document.querySelector(\'[aria-label="Done today"]\')?.textContent.includes("Check mobile spacing")'
    );
    assert.equal(item.prNumber, null);
    const output = resolve(scratch, "hq-901-work-todo-cycle");
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          id: "HQ901.work-todo-cycle",
          status: "pass",
          proofIds: ["S10.1.typed-add-handoff-no-pr-completion"],
          scope:
            "rendered typed prompt and handoff through production leased observers with simulated API inventory"
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    window.destroy();
    ipcMain.removeHandler("hq901:todo-items");
    ipcMain.removeHandler("hq901:todo-dispatch");
    await rm(credentialHome, { recursive: true, force: true });
    app.quit();
  }
};

void run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  app.exit(1);
});
