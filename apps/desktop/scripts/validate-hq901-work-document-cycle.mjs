import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow, ipcMain } from "electron";
import { storeDesktopLocalCredential } from "@koed/shared";
import { createWorkItemsFromDocObserver } from "../../../apps/worker/dist/work-items-from-doc-observer.js";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_WORK_DOCUMENT_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ901 document profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  await app.whenReady();
  const credentialHome = await mkdtemp(resolve(scratch, "hq901-doc-home-"));
  const ownerUserId = randomUUID();
  const executionId = "00000000-0000-4000-8000-000000002044";
  const commandId = randomUUID();
  const leaseToken = randomUUID();
  const sourceId = "00000000-0000-4000-8000-000000002053";
  const sourceRevisionId = "00000000-0000-4000-8000-000000002054";
  const noteRevisionId = randomUUID();
  const projectId = "00000000-0000-4000-8000-000000002038";
  const items = new Map();
  const applyResults = [];
  const runtime = [];
  storeDesktopLocalCredential(credentialHome, {
    ownerUserId,
    operationFamilies: ["personal_collaboration_write", "managed_execution"]
  });
  ipcMain.handle("hq901:doc-items", () => [...items.values()]);
  const observer = createWorkItemsFromDocObserver({
    repository: {
      getManagedConversationCommand: async () => ({
        ownerUserId,
        executionId,
        executionGeneration: 1,
        state: "dispatching",
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      }),
      putManagedConversationRuntimeItem: async (_actor, item) => {
        runtime.push(item);
      }
    },
    apiUrl: "http://127.0.0.1:32123",
    koedHome: credentialHome,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.commandId, commandId);
      assert.equal(body.leaseToken, leaseToken);
      assert.equal(body.sourceId, sourceId);
      assert.equal(body.sourceRevisionId, sourceRevisionId);
      assert.equal(body.proposals.length, 3);
      let created = 0;
      for (const proposal of body.proposals) {
        const key = `${body.sourceRevisionId}:${proposal.lineNumber}:${proposal.sourceLine}`;
        if (items.has(key)) continue;
        created++;
        items.set(key, {
          id: randomUUID(),
          projectId,
          kind: "todo",
          key: null,
          title: proposal.title,
          goal: proposal.goal,
          origin: "plan",
          originRef: sourceId,
          idempotencyKey: null,
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
        });
      }
      applyResults.push({
        created,
        alreadyExisting: body.proposals.length - created
      });
      return new globalThis.Response(JSON.stringify(applyResults.at(-1)), {
        status: 200
      });
    }
  });
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      backgroundThrottling: false,
      preload: resolve(import.meta.dirname, "hq901-doc-cycle-preload.cjs")
    }
  });
  try {
    const load = () =>
      window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        {
          query: { view: "hq", hq901DocCycle: "yes" }
        }
      );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(`HQ901 document cycle did not reach ${source}`);
    };
    await load();
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
    );
    await waitFor(
      "document.querySelector('[aria-label$=\"Project sources\"]') !== null"
    );
    await js(
      "document.querySelector('[aria-label$=\"Project sources\"]').click()"
    );
    await waitFor(
      'Array.from(document.querySelectorAll(".hq-project-sources__row")).some(x=>x.textContent.includes("Plan.md"))'
    );
    await js(
      'Array.from(document.querySelectorAll(".hq-project-sources__row")).find(x=>x.textContent.includes("Plan.md")).click()'
    );
    await waitFor(
      'document.querySelector(".hq-project-sources__ask") !== null'
    );
    await js('document.querySelector(".hq-project-sources__ask").click()');
    await waitFor(
      'window.__koedHq204Trace?.firstPrompt === "Turn Plan.md into tickets"'
    );
    assert.equal(
      await js("window.__koedHq204Trace.firstSelectedDocumentSourceId"),
      sourceId
    );
    const event = {
      execution: { id: executionId, ownerUserId, executionGeneration: 1 },
      command: { id: commandId, leaseToken },
      providerTurnId: "document-turn",
      toolCallId: "document-tool",
      toolName: "work_items_from_doc",
      arguments: {
        mode: "apply",
        source_id: sourceId,
        source_revision_id: sourceRevisionId,
        note_revision_id: noteRevisionId,
        proposals: [
          {
            line_number: 2,
            source_line: "Draft release notes",
            title: "Draft release notes",
            goal: "Draft release notes",
            due_text: null
          },
          {
            line_number: 3,
            source_line: "Review mobile spacing",
            title: "Review mobile spacing",
            goal: "Review mobile spacing",
            due_text: null
          },
          {
            line_number: 4,
            source_line: "Prepare launch checklist",
            title: "Prepare launch checklist",
            goal: "Prepare launch checklist",
            due_text: null
          }
        ]
      },
      result: { structuredContent: { status: "requested" } }
    };
    assert.equal(await observer(event), true);
    assert.deepEqual(applyResults[0], { created: 3, alreadyExisting: 0 });
    assert.equal(
      runtime.at(-1).payload.text,
      "Koed created 3 Work Items; 0 already had a Work Item for this document revision."
    );
    assert.equal(
      await observer({ ...event, toolCallId: "document-tool-repeat" }),
      true
    );
    assert.deepEqual(applyResults[1], { created: 0, alreadyExisting: 3 });
    assert.equal(items.size, 3);
    await load();
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
    );
    await waitFor(
      'document.querySelector(\'[aria-label="To do"]\')?.textContent.includes("Draft release notes")'
    );
    const rendered = await js(
      "document.querySelector('[aria-label=\"To do\"]')?.textContent"
    );
    for (const title of [
      "Draft release notes",
      "Review mobile spacing",
      "Prepare launch checklist"
    ])
      assert.ok(rendered.includes(title), title);
    const entries = ["offered", "typed"];
    for (const entry of entries) {
      items.clear();
      applyResults.length = 0;
      runtime.length = 0;
      const entryLoad = () =>
        window.loadFile(
          resolve(root, "apps/desktop/dist/browser-validation.html"),
          { query: { view: "hq", hq901DocEntry: entry } }
        );
      await entryLoad();
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'"
      );
      await js(
        `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
      );
      if (entry === "offered")
        await waitFor(
          'document.body.textContent.includes("I can make 3 Work Items")'
        );
      await waitFor(
        'document.querySelector(".hq-project-conversation textarea") !== null'
      );
      const prompt =
        entry === "offered" ? "Make 3" : "Turn Plan.md into to-dos";
      await js(`(() => {
        const textarea = document.querySelector(".hq-project-conversation textarea");
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setValue.call(textarea, ${JSON.stringify(prompt)});
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await waitFor(
        'document.querySelector(".hq-project-conversation form button[type=submit]")?.disabled === false'
      );
      await js(
        'document.querySelector(".hq-project-conversation form").requestSubmit()'
      );
      await waitFor(
        `window.__koedHq204Trace.${entry === "offered" ? "nextPrompt" : "firstPrompt"} === ${JSON.stringify(prompt)}`
      );
      assert.equal(
        await js(
          `window.__koedHq204Trace.${entry === "offered" ? "nextSelectedDocumentSourceId" : "firstSelectedDocumentSourceId"}`
        ),
        ""
      );
      assert.equal(
        await observer({ ...event, toolCallId: `document-tool-${entry}` }),
        true
      );
      assert.deepEqual(applyResults[0], { created: 3, alreadyExisting: 0 });
      assert.equal(
        await observer({
          ...event,
          toolCallId: `document-tool-${entry}-repeat`
        }),
        true
      );
      assert.deepEqual(applyResults[1], { created: 0, alreadyExisting: 3 });
      assert.equal(items.size, 3);
      await entryLoad();
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'"
      );
      await js(
        `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
      );
      await waitFor(
        'document.querySelector(\'[aria-label="To do"]\')?.textContent.includes("Draft release notes")'
      );
      const three = await js(
        "document.querySelector('[aria-label=\"To do\"]')?.textContent"
      );
      for (const title of [
        "Draft release notes",
        "Review mobile spacing",
        "Prepare launch checklist"
      ])
        assert.ok(three.includes(title), `${entry}: ${title}`);
    }
    const output = resolve(scratch, "hq-901-work-document-cycle");
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          id: "HQ901.work-document-cycle",
          status: "pass",
          proofIds: [
            "S06.1.document-ui-tool-three-repeat-zero",
            "S06.1.offered-ui-tool-three-repeat-zero",
            "S06.1.typed-ui-tool-three-repeat-zero"
          ],
          scope:
            "three rendered entry paths to production leased document observer, simulated API inventory and three rendered Work Items per path with repeat-zero"
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    window.destroy();
    ipcMain.removeHandler("hq901:doc-items");
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
