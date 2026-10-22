import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_WORK_ORIGIN_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ-901 origin profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { backgroundThrottling: false }
  });
  try {
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq901Origin: "yes" } }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 180; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ901 origin did not reach: ${source}; state=${JSON.stringify(await js('({rows: Array.from(document.querySelectorAll("[data-hq-chat-row]")).map((x) => ({text:x.textContent, current:x.getAttribute("aria-current"), project:x.dataset.hqChatProject})), active: Boolean(document.querySelector(".hq-conversation--active")), brief: Boolean(document.querySelector("[aria-label=\\"Work brief\\"]"))})'))}`
      );
    };
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]').click()"
    );
    await waitFor(
      'document.querySelector(".hq-project-view__origin-summary") !== null'
    );
    const summary = await js(
      'document.querySelector(".hq-project-view__origin-summary")?.textContent'
    );
    assert.ok(summary.includes("From Plan next week"), summary);
    assert.ok(summary.includes("Polish the narrow layout requested in chat"));
    const output = resolve(scratch, "hq-901-work-origin");
    await mkdir(output, { recursive: true });
    const capture = async (name, theme) => {
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      await delay(80);
      await writeFile(
        resolve(output, name),
        await window.capturePage().then((image) => image.toPNG())
      );
    };
    for (const theme of ["light", "dark"])
      await capture(`origin-row-${theme}.png`, theme);
    await js(
      'document.querySelector(".hq-project-view__section--doing .hq-project-view__brief-trigger").click()'
    );
    await waitFor(
      "document.querySelector('[aria-label=\"Work brief\"]') !== null"
    );
    const brief = await js(
      "document.querySelector('[aria-label=\"Work brief\"]')?.textContent"
    );
    assert.ok(brief.includes("Check mobile spacing"));
    assert.ok(brief.includes("Live"));
    assert.ok(brief.includes("Polish the narrow layout requested in chat"));
    for (const theme of ["light", "dark"])
      await capture(`origin-brief-${theme}.png`, theme);
    await js(
      "document.querySelector('[aria-label=\"Close work brief\"]').click()"
    );
    await waitFor(
      "document.querySelector('[aria-label=\"Work brief\"]') === null"
    );
    assert.equal(
      await js(
        'document.querySelector("[data-hq-project-link=\\"00000000-0000-4000-8000-000000002038\\"]")?.getAttribute("aria-current")'
      ),
      "page"
    );
    await js(
      'document.querySelector(".hq-project-view__section--doing .hq-project-view__brief-trigger").click()'
    );
    await waitFor(
      'document.querySelector(".hq-project-view__origin-link") !== null'
    );
    const linkText = await js(
      'document.querySelector(".hq-project-view__origin-link")?.textContent'
    );
    assert.ok(linkText.includes("Open the chat it came from"));
    await js('document.querySelector(".hq-project-view__origin-link").click()');
    await waitFor(
      'Array.from(document.querySelectorAll("[data-hq-chat-row][aria-current=\\"page\\"]")).some((row) => row.textContent.includes("Plan next week") && row.dataset.hqChatProject === "00000000-0000-4000-8000-000000002038")'
    );
    await waitFor(
      'document.querySelector(".hq-conversation--active") !== null'
    );
    await waitFor(
      "document.querySelector('[aria-label=\"Work brief\"]') === null"
    );
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          id: "HQ901.work-origin",
          status: "pass",
          proofIds: ["S02.1.origin-row-brief-link-close"],
          scope: "new HQ Electron renderer with simulated IPC"
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    window.destroy();
    app.quit();
  }
};

void run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  app.exit(1);
});
