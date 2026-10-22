import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";
import { showProjectSharePolicyNativeReview } from "../dist-electron/koed-server/project-share-policy-native-review.js";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-901-invites", "screenshots");
const profile = process.env.KOED_HQ901_INVITES_USER_DATA_DIR;
assert.ok(
  profile && dirname(resolve(profile)) === scratch,
  "Use an isolated HQ-901 invitations profile"
);
app.setPath("userData", profile);

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
    const waitFor = async (source, label = source) => {
      for (let i = 0; i < 150; i++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ-901 invitations timed out: ${label}; ${await js("document.body.innerText.slice(0,1000)").catch(() => "page unavailable")}`
      );
    };
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      {
        query: {
          view: "hq",
          hq714Capture: "yes",
          hq711Capture: "yes",
          hq701Linked: "yes"
        }
      }
    );
    await waitFor("document.documentElement.dataset.hqFixtureReady === 'true'");
    await js(
      "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')?.click()"
    );
    await waitFor(
      "!!document.querySelector('.hq-project-conversation textarea')"
    );
    await js(`(() => {
      const input = document.querySelector('.hq-project-conversation textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Invite ana@example.test to landing-site');
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    })()`);
    await waitFor(
      'document.querySelector(".hq-project-conversation form button[type=submit]")?.disabled === false'
    );
    await js(
      "document.querySelector('.hq-project-conversation form')?.requestSubmit()"
    );
    await waitFor(
      "window.__koedHq204Trace.nextPrompt === 'Invite ana@example.test to landing-site'",
      "typed composer dispatch"
    );
    await waitFor(
      "!!document.querySelector('.hq-text-action')",
      "managed invite action projection"
    );
    assert.match(
      await js("document.querySelector('.hq-text-action').textContent"),
      /Invite to Project.*ana@example.test.*landing-site/
    );
    await js(
      "document.querySelector('.hq-text-action__button--primary')?.click()"
    );
    await waitFor(
      "window.__koedHq714Trace.requests.length === 1 && !!window.__koedHq714Trace.resolve",
      "approved action claimed and bound createInvitation request"
    );
    const request = await js("window.__koedHq714Trace.requests[0]");
    assert.deepEqual(
      {
        email: request.email,
        role: request.role,
        access: request.defaultWorkspaceAccess,
        projectId: request.workspaceProjectId,
        actionId: request.managedTextAction.actionId
      },
      {
        email: "ana@example.test",
        role: "member",
        access: "write",
        projectId: "00000000-0000-4000-8000-000000007122",
        actionId: "00000000-0000-4000-8000-000000007141"
      }
    );
    assert.equal(
      await js("window.__koedHq504Trace.applications"),
      0,
      "no receipt before Native confirmation"
    );
    let modal;
    const decision = showProjectSharePolicyNativeReview({
      review: {
        version: 1,
        title: "Invite ana@example.test to landing-site?",
        description:
          "Confirm this person and the exact shared Project before sending an invitation.",
        consequence:
          "Ana receives one member access level: write access to landing-site.",
        confirmLabel: "Create invitation",
        details: [
          { label: "Team", value: "Koed team" },
          { label: "Project", value: "landing-site" },
          { label: "Email", value: request.email },
          { label: "Access", value: "member · write" }
        ],
        reviewSources: []
      },
      parent: window,
      ownerId: String(window.webContents.id),
      signal: new globalThis.AbortController().signal,
      currentParent: () => window,
      createWindow: (options) => {
        modal = new BrowserWindow(options);
        return modal;
      }
    });
    for (
      let i = 0;
      i < 150 &&
      (!modal ||
        modal.isDestroyed() ||
        !(await modal.webContents
          .executeJavaScript("!!document.querySelector('h1')")
          .catch(() => false)));
      i++
    )
      await delay(50);
    assert.ok(modal && !modal.isDestroyed(), "Native invitation review opened");
    assert.deepEqual(
      await modal.webContents.executeJavaScript(`(() => ({
      title: document.querySelector('h1').textContent,
      details: [...document.querySelectorAll('dl dt')].map((label) => [label.textContent, label.nextElementSibling.textContent]),
      accessMentions: [...document.querySelectorAll('dl dt')].filter((label) => label.textContent === 'Access').length
    }))()`),
      {
        title: "Invite ana@example.test to landing-site?",
        details: [
          ["Team", "Koed team"],
          ["Project", "landing-site"],
          ["Email", "ana@example.test"],
          ["Access", "member · write"]
        ],
        accessMentions: 1
      }
    );
    await writeFile(
      resolve(output, "typed-invite-native-review.png"),
      (await modal.webContents.capturePage()).toPNG()
    );
    await modal.webContents.executeJavaScript(
      "document.querySelector('button:not(.cancel)').click()"
    );
    assert.equal(await decision, true, "Native review confirmed");
    await js("window.__koedHq714Trace.approve()");
    await waitFor(
      "window.__koedHq504Trace.applications === 1 && sessionStorage.getItem('hq714-invitation-issued') === 'ana@example.test'",
      "Native action receipt"
    );
    assert.equal(await js("window.__koedHq504Trace.claims"), 1);
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
      "document.documentElement.dataset.hqFixtureReady === 'true' && !!document.querySelector('.hq-now__invitation')",
      "recipient invitation"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-now__invitation').textContent.includes('Koed team')"
      ),
      true
    );
    await js(
      "document.querySelector('.hq-now__invitation-actions button:last-child').click()"
    );
    await waitFor(
      "window.__koedHq703Trace.joins === 1 && !!document.querySelector('[data-hq-route=project][data-hq-project-id=\"00000000-0000-4000-8000-000000002038\"]')",
      "accepted invitation join"
    );
    assert.equal(
      await js(
        "document.querySelector('.hq-project-context-tabs [role=tab][aria-selected=true]')?.textContent.includes('Just me')"
      ),
      true
    );
    const report = {
      id: "HQ901.invites.native",
      owner: "HQ-901",
      status: "pass",
      scope: "renderer-fixture+Native-review",
      scenarioAssertions: [
        {
          id: "S14.1.email-invite-join",
          detail:
            "typed invitation action produces exact scoped request, Native confirmation, receipt, recipient accept and shared join"
        },
        {
          id: "S14.1.single-access",
          detail: "one effective member · write access level in Native review"
        }
      ],
      screenshots: ["typed-invite-native-review.png"]
    };
    await writeFile(
      resolve(scratch, "hq-901-invites", "report.json"),
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
