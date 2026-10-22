import process from "node:process";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ901_CITATION_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated citation lifecycle profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);
const projectId = "00000000-0000-4000-8000-000000002032";

async function run() {
  let window;
  try {
    await app.whenReady();
    const output = resolve(scratch, "hq-901-citation-lifecycle");
    await mkdir(output, { recursive: true });
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      useContentSize: true,
      webPreferences: { backgroundThrottling: false }
    });
    const errors = [];
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") errors.push(details.message);
    });
    const js = async (source) => {
      try {
        return await window.webContents.executeJavaScript(source);
      } catch (error) {
        throw new Error(
          `Citation script failed: ${source}: ${String(error)}; ${await window.webContents.executeJavaScript("document.body.innerText.slice(0,4000)")}`,
          { cause: error }
        );
      }
    };
    const wait = async (source) => {
      for (let attempt = 0; attempt < 180; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `Citation lifecycle did not reach ${source}: ${await js("document.body.innerText")}`
      );
    };
    const capture = async (name) => {
      await delay(100);
      await writeFile(
        resolve(output, name),
        (await window.webContents.capturePage()).toPNG()
      );
    };
    for (const dark of [false, true]) {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        {
          query: {
            view: "hq",
            hq306Capture: "yes",
            hq901CitationLifecycle: "yes"
          }
        }
      );
      await wait("document.documentElement.dataset.hqFixtureReady === 'true'");
      await wait(
        "[...document.querySelectorAll('[data-hq-chat-row]')].some(row=>row.textContent.includes('Plan next week')) || [...document.querySelectorAll('.hq-sidebar button')].some(button=>button.textContent.trim()==='Show 2 more')"
      );
      await js(
        "if (![...document.querySelectorAll('[data-hq-chat-row]')].some(row=>row.textContent.includes('Plan next week'))) [...document.querySelectorAll('.hq-sidebar button')].find(button=>button.textContent.trim()==='Show 2 more').click()"
      );
      await wait(
        "[...document.querySelectorAll('[data-hq-chat-row]')].some(row=>row.textContent.includes('Plan next week'))"
      );
      await js(
        `document.documentElement.classList.toggle('dark',${dark});document.documentElement.classList.toggle('light',${!dark})`
      );
      await js(`(() => {
        const row = [...document.querySelectorAll('[data-hq-chat-row]')].find(row => row.textContent.includes('Plan next week'));
        if (!row) throw new Error('Missing loose citation Conversation');
        row.click();
      })()`);
      await wait(
        "Boolean(document.querySelector('[data-hq-route=\"conversation\"] .hq-citation-chip'))"
      );
      assert.ok(
        await js(
          "document.querySelector('[aria-label=\"Conversation visibility\"]')?.textContent.includes('Just me')"
        )
      );
      assert.equal(
        await js(`(() => {
        const row=[...document.querySelectorAll('[data-hq-chat-row]')].find(row=>row.textContent.includes('Plan next week'));
        return row?.getAttribute('data-hq-chat-project');
      })()`),
        "hq103-loose"
      );
      const before = await js(`(() => {
        const scroll=document.querySelector('[data-hq-sidebar-scroll]');
        scroll.scrollTop=Math.min(100,scroll.scrollHeight-scroll.clientHeight);
        scroll.dispatchEvent(new Event('scroll'));
        return scroll.scrollTop;
      })()`);
      assert.ok(
        before > 0,
        "The sidebar must actually be scrolled for this proof"
      );
      await js("document.querySelector('.hq-citation-chip').click()");
      await wait(
        "document.querySelector('.hq-citation-detail h2')?.textContent==='Never book meetings before 9am.'"
      );
      assert.equal(
        await js(
          "document.querySelector('[data-hq-sidebar-scroll]').scrollTop"
        ),
        before
      );
      await capture(`loose-citation-${dark ? "dark" : "light"}.png`);
      await js(
        "document.querySelector('[aria-label=\"Close memory source\"]').click()"
      );

      await js(
        `document.querySelector('[data-hq-project-menu-trigger="${projectId}"]').click()`
      );
      await wait("Boolean(document.querySelector('[data-hq-project-menu]'))");
      await js(
        "[...document.querySelectorAll('[data-hq-project-menu] [role=menuitem]')].find(item=>item.textContent.trim()==='Delete project').click()"
      );
      await wait(
        "document.querySelector('.hq-project-modal')?.textContent.includes('Delete koed-mobile?')"
      );
      assert.ok(
        await js(
          `Boolean(document.querySelector('[data-hq-project-link="${projectId}"]'))`
        ),
        "Project remains before confirmation"
      );
      assert.ok(
        await js(
          "document.querySelector('.hq-project-modal').textContent.includes('Koed keeps what it learned.')"
        )
      );
      await js("document.querySelector('.hq-project-modal__danger').click()");
      await wait(
        `!document.querySelector('[data-hq-project-link="${projectId}"]') && Boolean(document.querySelector('.hq-project-toast button'))`
      );
      await js("document.querySelector('.hq-citation-chip').click()");
      await wait(
        "document.querySelector('.hq-citation-detail h2')?.textContent==='Never book meetings before 9am.'"
      );
      await capture(`deleted-project-citation-${dark ? "dark" : "light"}.png`);
      await js(
        "document.querySelector('[aria-label=\"Close memory source\"]').click()"
      );
      await js(
        "document.querySelector('.hq-project-toast button:first-of-type').click()"
      );
      await wait(
        `Boolean(document.querySelector('[data-hq-project-link="${projectId}"]')) && !document.querySelector('.hq-project-toast')`
      );
      await js("document.querySelector('.hq-citation-chip').click()");
      await wait(
        "document.querySelector('.hq-citation-detail h2')?.textContent==='Never book meetings before 9am.'"
      );
      await capture(`restored-project-citation-${dark ? "dark" : "light"}.png`);
    }
    assert.deepEqual(errors, []);
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          status: "pass",
          scope: "simulated-ipc",
          proofIds: [
            "S19.2.loose-private-citation-scroll",
            "S19.3.project-delete-undo-citation"
          ],
          consoleErrors: errors
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    window?.destroy();
  }
}
void run().then(
  () => app.quit(),
  (error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
    app.exit(1);
  }
);
