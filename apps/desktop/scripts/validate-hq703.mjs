import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-703", "screenshots");
const profile = process.env.KOED_HQ703_USER_DATA_DIR;
assert.ok(
  profile && dirname(resolve(profile)) === scratch,
  "Use an isolated HQ-703 profile in scratch"
);
app.setPath("userData", profile);

const run = async () => {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: true,
      width: 1280,
      height: 800,
      webPreferences: { backgroundThrottling: false }
    });
    const js = async (source) => {
      try {
        return await window.webContents.executeJavaScript(source);
      } catch (error) {
        throw new Error(`HQ703 JS ${source.slice(0, 260)}: ${error}`, {
          cause: error
        });
      }
    };
    const waitFor = async (source) => {
      for (let i = 0; i < 120; i++) {
        if (await js(source)) return;
        await delay(50);
      }
      const detail = await js(
        "JSON.stringify({ready:document.documentElement.dataset.hqFixtureReady,trace:window.__koedHq703Trace,body:document.body?.innerText?.slice(0,1800)})"
      ).catch(() => "page unavailable");
      throw new Error(`HQ-703 fixture did not reach ${source}: ${detail}`);
    };
    await mkdir(output, { recursive: true });
    const capture = async (name, theme) => {
      const visible = await js(`(() => {
        const row = document.querySelector('.hq-now__invitation');
        row?.scrollIntoView({block:'center'});
        const rect = row?.getBoundingClientRect();
        return !!rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight &&
          document.documentElement.classList.contains(${JSON.stringify(theme)}) &&
          row.textContent.includes('landing-site') && row.textContent.includes('Launch Team') &&
          row.textContent.includes('Maya Chen') && row.textContent.includes('Maya’s Design Agent') &&
          row.textContent.includes('member') && row.textContent.includes('write access') &&
          row.textContent.includes('shared as summaries') && row.textContent.includes('Expires') &&
          row.querySelectorAll('button').length === 2;
      })()`);
      assert.equal(
        visible,
        true,
        `${name} must show the full invitation scope and theme`
      );
      await js(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
      );
      await delay(200);
      await window.webContents.capturePage();
      await writeFile(
        resolve(output, name),
        (await window.webContents.capturePage()).toPNG()
      );
    };
    for (const theme of ["light", "dark"]) {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        {
          query: {
            view: "hq",
            hq703Capture: "yes",
            hq701Linked: "yes",
            hq705Capture: "yes"
          }
        }
      );
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true' && !!document.querySelector('.hq-now__invitation')"
      );
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add(${JSON.stringify(theme)})`
      );
      await capture(`invitation-${theme}.png`, theme);
      await js(
        "window.__koedHq703Trace.failNext = true; document.querySelector('.hq-now__invitation-actions button:last-child').click()"
      );
      await waitFor(
        "!!document.querySelector('.hq-now__invitation') && window.__koedHq703Trace.decisions.length === 1"
      );
      await js(
        "document.querySelector('.hq-now__invitation-actions button:last-child').click()"
      );
      await waitFor("!document.querySelector('.hq-now__invitation')");
      await waitFor(
        "window.__koedHq703Trace.joins === 1 && document.querySelector('[data-hq-route=project][data-hq-project-id=\"00000000-0000-4000-8000-000000002038\"]') !== null"
      );
      const joined = await js(`(() => ({
        groups: [...document.querySelectorAll('[data-hq-sidebar-group]')].map((item) => item.textContent.trim()),
        projectInTeam: document.querySelector('[id="hq-group-team-00000000-0000-4000-8000-000000007120"] [data-hq-project-link="00000000-0000-4000-8000-000000002038"]')?.textContent.includes('landing-site'),
        privateTab: document.querySelector('.hq-project-context-tabs [role="tab"][aria-selected="true"]')?.textContent.includes('Just me')
      }))()`);
      assert.deepEqual(joined, {
        groups: ["Just me", "Shared", "Koed team"],
        projectInTeam: true,
        privateTab: true
      });
      await waitFor(
        "window.__koedHq703Trace.catchUpStatuses.includes('recovered') && document.querySelector('.hq-project-context-tabs__content:not([hidden])')?.textContent.includes('Welcome to landing-site.')"
      );
      assert.deepEqual(
        await js(`(() => ({
          commandId: window.__koedHq703Trace.catchUpCommandId,
          statuses: [...new Set(window.__koedHq703Trace.catchUpStatuses)],
          welcome: document.querySelector('.hq-project-context-tabs__content:not([hidden])')?.textContent.includes('Welcome to landing-site.'),
          teamText: document.querySelector('.hq-project-context-tabs__content:not([hidden])')?.textContent.includes('team-message-human-sentinel')
        }))()`),
        {
          commandId: "00000000-0000-4000-8000-000000007033",
          statuses: ["queued", "recovered"],
          welcome: true,
          teamText: false
        },
        "joined private HQ must render a captured welcome from its trusted catch-up receipt"
      );
      assert.equal(
        await js(`(() => {
        const heading = document.querySelector('[data-hq-sidebar-group="team:00000000-0000-4000-8000-000000007120"]');
        heading?.scrollIntoView({block:'center'});
        const rect = heading?.getBoundingClientRect();
        return !!rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight &&
          document.querySelector('#hq-group-team-00000000-0000-4000-8000-000000007120 [data-hq-project-link="00000000-0000-4000-8000-000000002038"]')?.textContent.includes('landing-site') &&
          document.querySelector('.hq-project-context-tabs [role="tab"][aria-selected="true"]')?.textContent.includes('Just me');
      })()`),
        true,
        "joined HQ capture must show named Team, Project link, and private conversation"
      );
      await js(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
      );
      await delay(200);
      await writeFile(
        resolve(output, `joined-hq-${theme}.png`),
        (await window.webContents.capturePage()).toPNG()
      );
      assert.deepEqual(
        await js(`(() => ({
          groups: ['Needs you', 'Working now', 'To do', 'In review'].map(label => Boolean(document.querySelector('.hq-project-view__section[aria-label="' + label + '"]'))),
          projectChatRight: Boolean(document.querySelector('.hq-project-context-tabs[role=tablist], .hq-project-context-tabs [role=tablist][aria-label="Project conversation"]')),
          teamTab: Boolean([...document.querySelectorAll('.hq-project-context-tabs [role=tab]')].find(tab => tab.textContent.includes('Team'))),
          colleagueReview: document.body.textContent.includes('Ana’s review'),
          teamTextInPrivateHq: document.querySelector('.hq-project-context-tabs__content:not([hidden])')?.textContent.includes('team-message-human-sentinel')
        }))()`),
        {
          groups: [true, true, true, true],
          projectChatRight: true,
          teamTab: true,
          colleagueReview: true,
          teamTextInPrivateHq: false
        }
      );
      assert.deepEqual(
        await js(`(() => ({
        visible: document.querySelectorAll('#hq-group-just-me .hq-sidebar__loose-group [data-hq-chat-row]').length,
        more: document.querySelector('#hq-group-just-me .hq-sidebar__loose-group .hq-sidebar__more')?.textContent
      }))()`),
        { visible: 5, more: "Show 2 more" }
      );
      await js(
        "document.querySelector('#hq-group-just-me .hq-sidebar__loose-group .hq-sidebar__more')?.click()"
      );
      assert.equal(
        await js(
          "document.querySelectorAll('#hq-group-just-me .hq-sidebar__loose-group [data-hq-chat-row]').length"
        ),
        7
      );
      await js(
        "document.querySelector('[data-hq-sidebar-group=\"team:00000000-0000-4000-8000-000000007120\"]')?.click()"
      );
      assert.equal(
        await js(
          "document.querySelector('[data-hq-sidebar-group=\"team:00000000-0000-4000-8000-000000007120\"]')?.getAttribute('aria-expanded')"
        ),
        "false"
      );
      await js(
        "document.querySelector('[data-hq-sidebar-group=\"team:00000000-0000-4000-8000-000000007120\"]')?.click()"
      );
      assert.equal(
        await js(
          "document.querySelector('[data-hq-sidebar-group=\"team:00000000-0000-4000-8000-000000007120\"]')?.getAttribute('aria-expanded')"
        ),
        "true"
      );
      await js(
        "document.querySelector('.hq-project-context-tabs [role=tab]:last-child')?.click()"
      );
      await waitFor(
        "document.querySelector('.hq-project-context-tabs__content:not([hidden])')?.textContent.includes('team-message-human-sentinel')"
      );
      await js(
        "document.querySelector('.hq-project-context-tabs [role=tab]:first-child')?.click()"
      );
      await waitFor(
        "document.querySelector('.hq-project-context-tabs [role=tab]:first-child')?.getAttribute('aria-selected') === 'true'"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-context-tabs__content:not([hidden])')?.textContent.includes('team-message-human-sentinel')"
        ),
        false
      );
      await js(`(() => {
        const input = document.querySelector('.hq-project-conversation textarea');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, "Who's in Koed team?");
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      })()`);
      await delay(40);
      await js(
        "document.querySelector('.hq-project-conversation form')?.requestSubmit()"
      );
      await waitFor(
        "window.__koedHq204Trace.nextPrompt === \"Who's in Koed team?\" && document.querySelector('.hq-project-context-tabs__content:not([hidden])')?.textContent.includes('Koed team includes you and Maya Chen.')"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-project-context-tabs__content:not([hidden])')?.textContent.includes('team-message-human-sentinel')"
        ),
        false
      );
      assert.deepEqual(await js("window.__koedHq703Trace.decisions"), [
        "accept",
        "accept"
      ]);
    }
    const report = {
      id: "HQ703.ui.native",
      owner: "HQ-703",
      status: "pass",
      scope: "renderer-fixture",
      scenarioAssertions: [
        { id: "S13.1", detail: "pre-join summary-sharing disclosure" },
        {
          id: "S01.3.four-groups-project-chat",
          detail:
            "joined Shared Project shows all four Work Item groups and Project conversation tabs on the right"
        },
        {
          id: "S13.1.accepted-join",
          detail:
            "accepted invitation joins its Personal Project, opens HQ with private chat, and groups Project under named Team"
        },
        {
          id: "S13.1.private-welcome",
          detail:
            "accepted join issues trusted catch-up command and captured assistant welcome appears in private HQ without Team message text"
        },
        {
          id: "S15.1.named-team-order",
          detail: "Just me, Shared, named Koed team order with linked Project"
        },
        {
          id: "S15.3.named-team-fold",
          detail: "named Team group folds and opens through sidebar controls"
        },
        {
          id: "S16.1.loose-chat-cap",
          detail: "five loose Chats under Just me, Show 2 more reveals seven"
        },
        {
          id: "S16.1.typed-roster-question",
          detail:
            "typed private HQ question receives the Shared Project roster without Team message text"
        },
        {
          id: "S14.1",
          detail: "addressed invite scope and Native decision controls"
        }
      ],
      nativeGrantAuthorityProved: false,
      screenshots: [
        "invitation-light.png",
        "invitation-dark.png",
        "joined-hq-light.png",
        "joined-hq-dark.png"
      ]
    };
    await writeFile(
      resolve(scratch, "hq-703", "HQ703.native.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report));
  } finally {
    window?.destroy();
    app.quit();
  }
};

void run().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
