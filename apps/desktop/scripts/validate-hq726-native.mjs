import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const profile = process.env.KOED_HQ726_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-726 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);
const output = resolve(scratch, "hq-726", "screenshots");
const projectId = "00000000-0000-4000-8000-000000002038";

async function run() {
  let window;
  try {
    await app.whenReady();
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
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, label) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      assert.fail(
        `HQ-726 timed out waiting for ${label}: ${await js("document.body.textContent.slice(0,900)")}; ${errors.join(" | ")}`
      );
    };
    const click = async (source, label) => {
      assert.equal(await js(source), true, label);
    };
    const capture = async (name, theme) => {
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      await js(
        `Promise.all(document.getAnimations({subtree:true})
          .filter(animation => animation.playState !== 'paused' && Number.isFinite(animation.effect?.getComputedTiming().iterations ?? Infinity))
          .map(animation => animation.finished.catch(() => undefined)))
          .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`
      );
      const center = await js(`(() => {
        const panel=document.querySelector('[aria-label="Shared Project state"]');
        return {present:!!panel, text:panel?.textContent ?? '', error:panel?.querySelector('[role="alert"]')?.textContent ?? ''};
      })()`);
      assert.equal(
        center.present,
        true,
        "linked Shared Project view is present"
      );
      assert.equal(
        center.error,
        "",
        "linked Shared Project has no refresh error"
      );
      assert.doesNotMatch(
        center.text,
        /Shared Project state is unavailable|Shared Project could not be refreshed|Loading shared work/
      );
      const image = await window.webContents.capturePage();
      await writeFile(resolve(output, name), image.toPNG());
    };
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      { query: { view: "hq", hq726Capture: "yes" } }
    );
    await waitFor(
      "document.documentElement.dataset.hqFixtureReady === 'true' && !!window.__koedHq726Contributions",
      "separate HQ-726 fixture"
    );
    window.show();
    await click(
      `(() => {const link=document.querySelector('[data-hq-project-link="${projectId}"]');link?.click();return !!link;})()`,
      "linked Project"
    );
    await waitFor(
      `!!document.querySelector('button[aria-label="What Koed knows"]')`,
      "What Koed knows control"
    );
    await click(
      `(() => {const button=document.querySelector('button[aria-label="What Koed knows"]');button?.click();return !!button;})()`,
      "open Project memory"
    );
    await waitFor(
      `document.querySelector('[aria-label="Team contributions"]')?.textContent.includes('Shared by Bob')`,
      "retained contribution"
    );
    await waitFor(
      `(() => {const panel=document.querySelector('[aria-label="Shared Project state"]');return !!panel && !panel.textContent.includes('Shared Project state is unavailable.') && !panel.textContent.includes('Loading shared work') && !panel.querySelector('[role="alert"]');})()`,
      "linked Shared Project state"
    );
    const project = await js(`(() => {
      const section=document.querySelector('[aria-label="Team contributions"]');
      return {text:section?.textContent, buttons:section?.querySelectorAll('button').length, selected:document.querySelector('.hq-knows__tabs [aria-selected="true"]')?.textContent, reads:window.__koedHq726Contributions.trace.projectReads.slice()};
    })()`);
    assert.match(project.text, /Shared with this Project/);
    assert.match(project.text, /Keep the Atlas launch decision/);
    assert.match(project.text, /Shared by Bob/);
    assert.doesNotMatch(project.text, /no longer in Design Team/);
    assert.equal(project.buttons, 0, "Team summary is read-only");
    assert.equal(project.selected, "Project1");
    assert.ok(project.reads.length >= 1);
    assert.ok(project.reads.every((id) => id === projectId));
    await capture("project-contribution-light.png", "light");
    await capture("project-contribution-dark.png", "dark");

    const scopeTab = async (index, expected) => {
      await click(
        `(() => {const button=document.querySelectorAll('.hq-knows__tabs button')[${index}];button?.click();return !!button;})()`,
        `${expected} scope`
      );
      await waitFor(
        `document.querySelector('.hq-knows__tabs [aria-selected="true"]')?.textContent.startsWith('${expected}')`,
        `${expected} selected`
      );
      assert.equal(
        await js(
          "!!document.querySelector('[aria-label=\"Team contributions\"]')"
        ),
        false,
        `${expected} must not display Team contributions`
      );
    };
    await scopeTab(1, "Me");
    await scopeTab(2, "Other");
    assert.deepEqual(
      await js("window.__koedHq726Contributions.trace.projectReads"),
      project.reads,
      "Me and unscoped never fetch Team contributions"
    );

    await click(
      `(() => {const button=document.querySelector('[aria-label="Close memory panel"]');button?.click();return !!button;})()`,
      "close memory"
    );
    await js("window.__koedHq726Contributions.setNoLongerInGroup(true)");
    await click(
      `(() => {const button=document.querySelector('button[aria-label="What Koed knows"]');button?.click();return !!button;})()`,
      "reopen Project memory"
    );
    await click(
      `(() => {const button=document.querySelectorAll('.hq-knows__tabs button')[0];button?.click();return !!button;})()`,
      "select Project scope again"
    );
    await waitFor(
      "document.querySelector('[aria-label=\"Team contributions\"]')?.textContent.includes('Shared by Bob (no longer in Design Team)')",
      "disabled Team membership byline"
    );
    assert.equal(
      await js(
        "document.querySelector('[aria-label=\"Team contributions\"]')?.textContent.includes('Keep the Atlas launch decision')"
      ),
      true,
      "contribution remains visible after Team membership ends"
    );
    await capture("former-group-contribution-light.png", "light");
    await capture("former-group-contribution-dark.png", "dark");

    await click(
      `(() => {const button=document.querySelector('[aria-label="Close memory panel"]');button?.click();return !!button;})()`,
      "close before delayed read"
    );
    await js("window.__koedHq726Contributions.holdNextRead()");
    await click(
      `(() => {const button=document.querySelector('button[aria-label="What Koed knows"]');button?.click();return !!button;})()`,
      "open with delayed contribution read"
    );
    await waitFor(
      "window.__koedHq726Contributions.hasPendingRead()",
      "pending Project contribution read"
    );
    await scopeTab(1, "Me");
    const readsBeforeRelease = await js(
      "window.__koedHq726Contributions.trace.projectReads.length"
    );
    await js("window.__koedHq726Contributions.releasePendingRead()");
    await delay(50);
    assert.equal(
      await js(
        "!!document.querySelector('[aria-label=\"Team contributions\"]')"
      ),
      false,
      "late Project response cannot leak into Me"
    );
    assert.equal(
      await js("window.__koedHq726Contributions.trace.projectReads.length"),
      readsBeforeRelease,
      "Me scope does not request Team data"
    );
    assert.deepEqual(errors, []);
    const report = {
      id: "HQ726.native",
      owner: "HQ-726",
      status: "pass",
      assertions: [
        "I720.1.presentation",
        "I720.6.presentation",
        "R16",
        "Me.unscoped.isolation",
        "late.scope.response"
      ],
      screenshots: [
        "project-contribution-light.png",
        "project-contribution-dark.png",
        "former-group-contribution-light.png",
        "former-group-contribution-dark.png"
      ],
      trace: {
        projectReads: await js(
          "window.__koedHq726Contributions.trace.projectReads"
        )
      }
    };
    await writeFile(
      resolve(scratch, "hq-726", "HQ726.native.json"),
      JSON.stringify(report, null, 2) + "\n"
    );
    process.stdout.write(
      "PASS HQ-726 native retained contribution presentation and scope isolation.\n"
    );
  } finally {
    window?.close();
    app.quit();
  }
}
run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
