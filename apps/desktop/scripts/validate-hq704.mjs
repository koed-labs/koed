import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import console from "node:console";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-704", "screenshots");
const profile = process.env.KOED_HQ704_USER_DATA_DIR;
assert.ok(
  profile && dirname(resolve(profile)) === scratch,
  "Use an isolated HQ-704 profile"
);
app.setPath("userData", profile);
const projectId = "00000000-0000-4000-8000-000000002038";
let window;
async function run() {
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      useContentSize: true
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let i = 0; i < 150; i++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(`HQ-704 did not reach ${source}`);
    };
    await mkdir(output, { recursive: true });
    const shots = [];
    const capture = async (name) => {
      await js(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
      );
      await delay(150);
      await writeFile(
        resolve(output, name),
        (await window.webContents.capturePage()).toPNG()
      );
      shots.push(name);
    };
    const click = async (selector, label) => {
      const found = await js(
        `(()=>{const button=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)return false;button.click();return true;})()`
      );
      assert.equal(found, true, `Enabled ${label}`);
    };
    const load = async (theme, owner) => {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        {
          query: {
            view: "hq",
            hq704Capture: "yes",
            hq704Owner: owner ? "yes" : "no",
            hq701Capture: "yes",
            hq701Linked: "yes",
            hq711Capture: "yes",
            hq306Capture: "yes"
          }
        }
      );
      await waitFor("document.documentElement.dataset.hqFixtureReady==='true'");
      await js(
        `document.documentElement.classList.remove('light','dark');document.documentElement.classList.add('${theme}')`
      );
    };
    const menu = async () => {
      await js(
        `document.querySelector('[data-hq-project-menu-trigger="${projectId}"]').click()`
      );
      await waitFor(
        "Array.from(document.querySelectorAll('[data-hq-project-menu] button')).some(x=>!x.disabled&&/^(Delete|Leave) project$/.test(x.textContent.trim()))"
      );
    };
    for (const theme of ["light", "dark"]) {
      await load(theme, false);
      await menu();
      assert.equal(
        await js(
          "Array.from(document.querySelectorAll('[data-hq-project-menu] button')).some(x=>x.textContent.trim()==='Delete project')"
        ),
        false
      );
      await capture(`member-menu-${theme}.png`);
      await click("[data-hq-project-menu] button", "Leave project");
      await waitFor(
        "!!document.querySelector('.hq-project-lifecycle h2')&&document.querySelector('.hq-project-lifecycle h2').textContent.startsWith('Leave')"
      );
      assert.match(
        await js("document.querySelector('.hq-project-lifecycle').textContent"),
        /new invitation/
      );
      await capture(`project-leave-${theme}.png`);
      await click(".hq-project-lifecycle button", "Cancel");
      assert.deepEqual(await js("window.__koedHq704Trace.actions"), []);

      await load(theme, true);
      await js(
        `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
      );
      await waitFor("!!document.querySelector('.hq-text-action')");
      assert.match(
        await js("document.querySelector('.hq-text-action').textContent"),
        /Leave shared Project/
      );
      await click(".hq-text-action button", "Review exact effect");
      await waitFor(
        "document.querySelector('.hq-project-lifecycle h2')?.textContent.startsWith('Delete')===true"
      );
      assert.match(
        await js("document.querySelector('.hq-project-lifecycle').textContent"),
        /You own this Project/
      );
      assert.deepEqual(await js("window.__koedHq704Trace.actions"), []);
      await capture(`owner-text-delete-review-${theme}.png`);
      await click(".hq-project-lifecycle button", "Delete project");
      await waitFor("window.__koedHq704Trace.actions.length===2");
      assert.deepEqual(await js("window.__koedHq704Trace.actions"), [
        "text_decline",
        "delete_shared_project"
      ]);
      await js(
        "document.querySelector('[aria-label=\"Manage shared groups\"]').click()"
      );
      await waitFor(
        "document.querySelector('.hq-team-groups')?.textContent.includes('Recently deleted Projects')===true"
      );
      await capture(`deleted-owner-restore-${theme}.png`);
      await click(".hq-team-groups button", "Restore");
      await waitFor(
        "document.querySelector('.hq-team-groups [role=status]')?.textContent.includes('Members need new access')===true"
      );
      assert.equal(
        await js(
          "Array.from(document.querySelectorAll('.hq-team-groups button')).some(x=>x.textContent==='Undo')"
        ),
        false
      );
      await capture(`metadata-restored-${theme}.png`);
      await click(".hq-team-groups button", "Done");

      await load(theme, true);
      await js(
        "document.querySelector('[aria-label=\"Manage shared groups\"]').click()"
      );
      await waitFor("!!document.querySelector('.hq-team-groups__list button')");
      await js(
        "document.querySelector('.hq-team-groups__list button').click()"
      );
      await click(".hq-team-groups button", "Review leave");
      await waitFor(
        "document.querySelector('.hq-team-groups h2')?.textContent.startsWith('Leave')===true"
      );
      const text = await js(
        "document.querySelector('.hq-team-groups').textContent"
      );
      assert.match(text, /new invitation/);
      assert.match(text, /no Undo/);
      assert.match(text, /Just me/);
      assert.match(text, /frozen record/);
      await capture(`group-leave-review-${theme}.png`);
      await click(".hq-team-groups button", "Leave group");
      await waitFor(
        "document.querySelector('.hq-team-groups [role=status]')?.textContent.includes('new invitation')===true"
      );
      assert.deepEqual(await js("window.__koedHq704Trace.actions"), [
        "leave_team"
      ]);
      assert.equal(
        await js(
          `!!document.querySelector('[data-hq-project-link="${projectId}"]')`
        ),
        true
      );
      assert.equal(
        await js(
          "Array.from(document.querySelectorAll('.hq-team-groups button')).some(x=>x.textContent==='Undo')"
        ),
        false
      );
      await capture(`group-left-${theme}.png`);
    }
    const report = {
      id: "HQ704.ui.native",
      owner: "HQ-704",
      status: "pass",
      scope: "renderer-fixture",
      scenarioAssertions: ["S19.4.ui", "S20.2", "S20.3.ui", "S20.4", "N6.S.ui"],
      nativeGrantAuthorityProved: false,
      realCopyBackProved: false,
      coverage: {
        ownerTextLeaveDeclinedBeforeSeparateDelete: true,
        nonownerLeaveMenu: true,
        returnRequiresNewInvitation: true,
        noLeaveUndo: true,
        metadataOnlyRestoreDisclosure: true,
        personalProjectRetainedInRenderer: true,
        desktopLightAndDark: true
      },
      screenshots: shots,
      deferredIntegration: ["I20.3", "N6.I", "I25"]
    };
    await writeFile(
      resolve(scratch, "hq-704", "HQ704.native.json"),
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
