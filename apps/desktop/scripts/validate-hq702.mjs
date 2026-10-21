import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { app, BrowserWindow, nativeTheme } from "electron";
import { showProjectSharePolicyNativeReview } from "../dist-electron/koed-server/project-share-policy-native-review.js";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-702", "screenshots");
const profile = process.env.KOED_HQ702_USER_DATA_DIR;
assert.ok(profile, "Set an isolated HQ-702 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

async function run() {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      useContentSize: true
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source, label) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      const detail = await js(`JSON.stringify({
        trace: window.__koedHq702Trace,
        menu: document.querySelector('[aria-label="Chat summary sharing"]')?.textContent,
        looseRows: Array.from(document.querySelectorAll('.hq-sidebar__loose-group [data-hq-chat-row]')).map(row => row.textContent),
        looseDrag: Array.from(document.querySelectorAll('.hq-sidebar__loose-group [data-hq-chat-row]')).map(row => ({title:row.textContent,draggable:row.draggable,active:row.getAttribute('data-hq-drag-source')})),
        dragData: window.__hq702Drag?.getData('application/x-koed-conversation'),
        looseMore: document.querySelector('.hq-sidebar__loose-group .hq-sidebar__more')?.textContent,
        project: document.querySelector('[data-hq-route="project"]')?.getAttribute('data-hq-project-id')
      })`).catch(() => "fixture unavailable");
      assert.fail(`Timed out waiting for ${label}: ${detail}`);
    };
    const debuggerClient = window.webContents.debugger;
    await mkdir(output, { recursive: true });
    const capture = async (name) => {
      if (name.startsWith("chat-")) {
        const chatName = name.startsWith("chat-moved-in-")
          ? "Conversation 91"
          : name.startsWith("chat-private-other-menu-")
            ? "Other project chat"
            : "Plan next week";
        const visible = await js(`(() => {
          const row = Array.from(document.querySelectorAll('[data-hq-chat-project="00000000-0000-4000-8000-000000002038"][data-hq-chat-row]')).find(row => row.textContent.includes(${JSON.stringify(chatName)}));
          row?.scrollIntoView({block:'center'});
          const menu = document.querySelector('[aria-label="Chat summary sharing"]');
          menu?.scrollIntoView({block:'nearest'});
          const rect = row?.getBoundingClientRect();
          const menuRect = menu?.getBoundingClientRect();
          return !!rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && (!menuRect || (menuRect.top >= 0 && menuRect.bottom <= innerHeight));
        })()`);
        assert.equal(
          visible,
          true,
          `${name} must show its exact chat and menu`
        );
      }
      await js(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
      );
      await delay(100);
      const image = await window.webContents.capturePage();
      await writeFile(resolve(output, name), image.toPNG());
    };
    for (const theme of ["light", "dark"]) {
      await window.loadFile(
        resolve(root, "apps/desktop/dist/browser-validation.html"),
        {
          query: {
            view: "hq",
            hq701Capture: "yes",
            hq701Linked: "yes",
            hq306Capture: "yes",
            hq702Capture: "yes"
          }
        }
      );
      await waitFor(
        "document.documentElement.dataset.hqFixtureReady === 'true'",
        "HQ fixture"
      );
      window.show();
      await js(
        `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
      );
      await js(
        "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')?.click()"
      );
      await waitFor(
        "document.querySelector('[aria-label=\"View who is in this shared Project\"]') !== null",
        "shared Project chip"
      );
      await js(
        "document.querySelector('[aria-label=\"View who is in this shared Project\"]')?.click()"
      );
      await waitFor(
        "document.querySelector('.hq-share-policy [role=\"status\"]')?.textContent.includes('Summary sharing is off')",
        "policy status"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-share-policy')?.textContent.includes('Curated Memory requires a separate review')"
        ),
        true
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-share-policy')?.textContent.includes('Launch plan chat · 20 Oct')"
        ),
        true
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-share-policy')?.textContent.includes('00000000-0000-4000-8000-000000007021')"
        ),
        false
      );
      if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
      await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false
      });
      await capture(`summary-off-${theme}.png`);
      await js(
        "Array.from(document.querySelectorAll('.hq-share-policy button')).find(b => b.textContent === 'Review summary sharing')?.click()"
      );
      await waitFor(
        "window.__koedHq702Trace?.enableReviews === 1 && document.querySelector('.hq-share-policy')?.textContent.includes('Summary sharing policy is on')",
        "fixture enable"
      );
      assert.equal(
        await js(
          "document.querySelector('.hq-share-policy')?.textContent.includes('1 pending or unconfirmed')"
        ),
        true
      );
      await capture(`summary-on-${theme}.png`);
      await js(
        "Array.from(document.querySelectorAll('.hq-share-policy button')).find(b => b.textContent === 'Retry pending summaries')?.click()"
      );
      await waitFor(
        "window.__koedHq702Trace?.stageRetries === 1",
        "explicit approved-manifest retry"
      );
      await js(
        "Array.from(document.querySelectorAll('.hq-share-policy button')).find(b => b.textContent === 'Stop future summary sharing')?.click()"
      );
      await waitFor(
        "window.__koedHq702Trace?.revokeReviews === 1 && document.querySelector('.hq-share-policy')?.textContent.includes('Existing grants keep their own consent')",
        "fixture revoke"
      );
      await capture(`summary-revoked-${theme}.png`);
      await js(
        "document.querySelector('[aria-label=\"Close Share Project\"]')?.click()"
      );
      await waitFor(
        "document.querySelector('.hq-share-policy') === null",
        "closed share sheet"
      );
      await waitFor(
        "Array.from(document.querySelectorAll('[data-hq-chat-project=\"00000000-0000-4000-8000-000000002038\"][data-hq-chat-row]')).some(row => row.textContent.includes('Plan next week'))",
        "exact linked captured chat"
      );
      const chatRow =
        "Array.from(document.querySelectorAll('[data-hq-chat-project=\"00000000-0000-4000-8000-000000002038\"][data-hq-chat-row]')).find(row => row.textContent.includes('Plan next week'))";
      await js(
        "document.querySelector('[data-hq-project-link=\"00000000-0000-4000-8000-000000002038\"]')?.scrollIntoView({block:'center'})"
      );
      await js(`${chatRow}?.scrollIntoView({block:'center'})`);
      assert.equal(
        await js(
          `(() => { const row = ${chatRow}; const rect = row?.getBoundingClientRect(); return !!rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight; })()`
        ),
        true,
        "exact chat row must be visible in the Native capture"
      );
      const openChatMenu = `${chatRow}?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`;
      await js(openChatMenu);
      await waitFor(
        "window.__koedHq702Trace?.chatStatusReads === 1 && document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('Make private')",
        "exact chat sharing status"
      );
      assert.equal(
        await js(
          "document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('Share again')"
        ),
        false
      );
      await capture(`chat-summary-shared-${theme}.png`);
      await js(
        "Array.from(document.querySelectorAll('[aria-label=\"Chat summary sharing\"] button')).find(b => b.textContent === 'Make private')?.click()"
      );
      await waitFor(
        "window.__koedHq702Trace?.makePrivateReviews === 1 && document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('Project summary sharing was canceled.')",
        "canceled exact Make private"
      );
      assert.equal(
        await js(
          "document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('This chat is private.')"
        ),
        false
      );
      assert.equal(
        await js(
          "document.querySelector('[aria-label=\"Chat summary private\"]') !== null"
        ),
        false
      );
      await capture(`chat-summary-canceled-${theme}.png`);
      await js(
        "Array.from(document.querySelectorAll('[aria-label=\"Chat summary sharing\"] button')).find(b => b.textContent === 'Check summary status again')?.click()"
      );
      await waitFor(
        "window.__koedHq702Trace?.chatStatusReads === 2 && document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('Make private')",
        "retried exact chat status"
      );
      await js(
        "Array.from(document.querySelectorAll('[aria-label=\"Chat summary sharing\"] button')).find(b => b.textContent === 'Make private')?.click()"
      );
      await waitFor(
        "window.__koedHq702Trace?.makePrivateReviews === 2 && document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('This chat is private.')",
        "confirmed exact Make private"
      );
      assert.equal(
        await js(
          "document.querySelector('[aria-label=\"Chat summary private\"]') !== null"
        ),
        true
      );
      await capture(`chat-summary-private-${theme}.png`);
      await js(`
        {
          const row = Array.from(document.querySelectorAll('[data-hq-chat-project="00000000-0000-4000-8000-000000002038"][data-hq-chat-row]')).find(row => row.textContent.includes('Other project chat'));
          row?.scrollIntoView({block:'center'});
          row?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
        }
      `);
      await waitFor(
        "window.__koedHq702Trace?.chatStatusReads === 3 && document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('Make private')",
        "second chat exact status"
      );
      assert.equal(
        await js(
          "document.querySelectorAll('[aria-label=\"Chat summary private\"]').length"
        ),
        1
      );
      await capture(`chat-private-other-menu-${theme}.png`);
      await js(`${chatRow}?.scrollIntoView({block:'center'})`);
      await js(openChatMenu);
      await waitFor(
        "document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('Share again')",
        "private-only Share again control"
      );
      await js(
        "Array.from(document.querySelectorAll('[aria-label=\"Chat summary sharing\"] button')).find(b => b.textContent === 'Share again')?.click()"
      );
      await waitFor(
        "window.__koedHq702Trace?.chatStatusReads === 5 && window.__koedHq702Trace?.chatOffers.length === 1 && document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('This chat remains private')",
        "declined Share again"
      );
      assert.deepEqual(await js("window.__koedHq702Trace.chatOffers[0]"), {
        sessionId: "00000000-0000-4000-8000-000000002045",
        reason: "share_again"
      });
      await capture(`chat-share-again-declined-${theme}.png`);
      await js(
        "Array.from(document.querySelectorAll('[aria-label=\"Chat summary sharing\"] button')).find(b => b.textContent === 'Share again')?.click()"
      );
      await waitFor(
        "window.__koedHq702Trace?.chatStatusReads === 6 && window.__koedHq702Trace?.chatOffers.length === 2 && document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('Make private')",
        "confirmed Share again"
      );
      assert.equal(
        await js(
          "document.querySelector('[aria-label=\"Chat summary private\"]') !== null"
        ),
        false
      );
      await capture(`chat-share-again-confirmed-${theme}.png`);
      const dragLooseIntoProject = async () => {
        await js(`
          window.__hq702Drag = new DataTransfer();
          const source = Array.from(document.querySelectorAll('.hq-sidebar__loose-group [data-hq-chat-row]')).find(row => row.textContent.includes('Conversation 91'));
          source?.dispatchEvent(new DragEvent('dragstart', {bubbles:true,dataTransfer:window.__hq702Drag}));
        `);
        await waitFor(
          "document.querySelector('.hq-sidebar__loose-group')?.dataset.hqDragging === 'true'",
          "captured chat drag"
        );
        await js(`
          document.querySelector('[data-hq-project-link="00000000-0000-4000-8000-000000002038"]')?.closest('.hq-sidebar__project')?.dispatchEvent(new DragEvent('drop', {bubbles:true,dataTransfer:window.__hq702Drag}));
        `);
      };
      await dragLooseIntoProject();
      await waitFor(
        "window.__koedHq702Trace?.moves === 1 && window.__koedHq702Trace?.chatStatusReads === 7 && window.__koedHq702Trace?.chatOffers.length === 3 && document.querySelector('.hq-chat-move__notice')?.textContent.includes('Summary sharing was canceled')",
        "declined moved-in summary offer"
      );
      assert.deepEqual(await js("window.__koedHq702Trace.chatOffers[2]"), {
        sessionId: "00000000-0000-4000-8000-000000000091",
        reason: "moved_in"
      });
      await capture(`chat-moved-in-declined-${theme}.png`);
      await js(`
        {
          const row = Array.from(document.querySelectorAll('[data-hq-chat-project="00000000-0000-4000-8000-000000002038"][data-hq-chat-row]')).find(row => row.textContent.includes('Conversation 91'));
          row?.scrollIntoView({block:'center'});
          row?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
        }
      `);
      await waitFor(
        "document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('Share a summary')",
        "manual summary retry for moved-in chat"
      );
      await js(
        "Array.from(document.querySelectorAll('[aria-label=\"Chat summary sharing\"] button')).find(b => b.textContent === 'Share a summary')?.click()"
      );
      await waitFor(
        "window.__koedHq702Trace?.moves === 1 && window.__koedHq702Trace?.chatStatusReads === 9 && window.__koedHq702Trace?.chatOffers.length === 4 && document.querySelector('[aria-label=\"Chat summary sharing\"]')?.textContent.includes('Summary sharing is pending')",
        "explicit moved-in summary retry remains pending"
      );
      assert.deepEqual(await js("window.__koedHq702Trace.chatOffers[3]"), {
        sessionId: "00000000-0000-4000-8000-000000000091",
        reason: "moved_in"
      });
      await capture(`chat-moved-in-pending-${theme}.png`);
    }
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      window.show();
      let modal;
      const review = {
        version: 1,
        title: "Share Project summaries?",
        description:
          "Your eligible captured chats in this Project can share summaries with the Team.",
        consequence:
          "Summary updates can continue under each grant. Full transcripts and Curated Memory need separate approval.",
        confirmLabel: "Share eligible summaries",
        details: [{ label: "Project", value: "Launch plan" }],
        reviewSources: Array.from({ length: 100 }, (_, index) => ({
          sessionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          reviewLabel: `Captured chat ${index + 1} · redacted title`,
          eligible: index % 2 === 0
        }))
      };
      const chatReview = {
        version: 1,
        title: "Share a summary of this chat with Koed team?",
        description:
          "This exact Captured Session will have its own Project-bound Pending Share and consent.",
        consequence:
          "Project members can recall the approved summary. Future updates to this chat continue under this grant until it is withdrawn or frozen.",
        confirmLabel: "Share Memory",
        details: [{ label: "Project", value: "Launch plan" }],
        reviewSources: []
      };
      const openReview = (reviewToShow = review) => {
        const controller = new globalThis.AbortController();
        const decision = showProjectSharePolicyNativeReview({
          review: reviewToShow,
          parent: window,
          ownerId: String(window.webContents.id),
          signal: controller.signal,
          currentParent: () => window,
          createWindow: (options) => {
            modal = new BrowserWindow(options);
            return modal;
          }
        });
        return { decision, controller };
      };
      const readyModal = async (sourceCount = 100) => {
        for (let attempt = 0; attempt < 150; attempt++) {
          if (
            modal &&
            !modal.isDestroyed() &&
            (await modal.webContents
              .executeJavaScript(
                `Boolean(document.querySelector('h1')) && document.querySelectorAll('ol li').length === ${sourceCount}`
              )
              .catch(() => false))
          )
            return;
          await delay(50);
        }
        assert.fail("Timed out waiting for exact Native review");
      };
      const captureModal = async (name) => {
        const debuggerClient = modal.webContents.debugger;
        if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
        const { data } = await debuggerClient.sendCommand(
          "Page.captureScreenshot",
          {
            format: "png",
            captureBeyondViewport: false
          }
        );
        await writeFile(resolve(output, name), Buffer.from(data, "base64"));
      };
      const cancelled = openReview();
      await readyModal();
      assert.equal(
        await modal.webContents.executeJavaScript(
          "document.body.textContent.includes('Captured Sessions (100)')"
        ),
        true
      );
      assert.equal(
        await modal.webContents.executeJavaScript(
          "document.body.textContent.includes('Full transcripts and Curated Memory need separate approval.')"
        ),
        true
      );
      await captureModal(`native-review-${theme}.png`);
      await modal.webContents
        .executeJavaScript("document.querySelector('button.cancel').click()")
        .catch(() => undefined);
      assert.equal(await cancelled.decision, false);
      const approved = openReview();
      await readyModal();
      await modal.webContents
        .executeJavaScript(
          "document.querySelector('button[type=submit]:not(.cancel)').click()"
        )
        .catch(() => undefined);
      assert.equal(await approved.decision, true);
      const escaped = openReview();
      await readyModal();
      modal.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      assert.equal(await escaped.decision, false);
      const chatCanceled = openReview(chatReview);
      await readyModal(0);
      assert.equal(
        await modal.webContents.executeJavaScript(
          "document.querySelector('h1')?.textContent === 'Share a summary of this chat with Koed team?' && document.body.textContent.includes('approved summary') && !document.body.textContent.includes('full transcript')"
        ),
        true
      );
      await captureModal(`native-chat-summary-${theme}.png`);
      await modal.webContents
        .executeJavaScript("document.querySelector('button.cancel').click()")
        .catch(() => undefined);
      assert.equal(await chatCanceled.decision, false);
      const chatApproved = openReview(chatReview);
      await readyModal(0);
      await modal.webContents
        .executeJavaScript(
          "document.querySelector('button[type=submit]:not(.cancel)').click()"
        )
        .catch(() => undefined);
      assert.equal(await chatApproved.decision, true);
      window.hide();
    }
    await writeFile(
      resolve(scratch, "hq-702", "HQ702.native.json"),
      JSON.stringify(
        {
          id: "HQ702.ui.native",
          owner: "HQ-702",
          status: "pass",
          scope: "renderer-fixture",
          assertions: [
            "summary-only disclosure",
            "exact chat-summary question in isolated Native review, approve and cancel",
            "full transcripts and Curated Memory require separate approval",
            "bounded trusted labels without Session IDs",
            "enable, explicit pending retry, and revoke controls",
            "exact linked-chat Make private, cancellation, and confirmed private status",
            "private badge remains scoped to its chat while another chat menu opens",
            "private-only Share again declined and confirmed through exact Project and chat selectors",
            "completed moved-in chat offer declined, then manually retried from unshared and left pending",
            "real Electron Native review intercepted approve, cancel, and Escape",
            "light and dark"
          ],
          nativeGrantAuthorityProved: false,
          nativeReviewInterceptionProved: true,
          scenarioAssertions: [
            {
              id: "S15.2",
              owner: "HQ-702",
              status: "pass",
              scope: "renderer-and-native-ui",
              exactSummaryQuestion: true,
              nativeApproveAndCancel: true,
              separateTranscriptAndCuratedDisclosure: true,
              conversationSourceAccessPublicationProved: false
            }
          ],
          screenshots: [
            "summary-off-light.png",
            "summary-on-light.png",
            "summary-revoked-light.png",
            "chat-summary-shared-light.png",
            "chat-summary-canceled-light.png",
            "chat-summary-private-light.png",
            "chat-private-other-menu-light.png",
            "chat-share-again-declined-light.png",
            "chat-share-again-confirmed-light.png",
            "chat-moved-in-declined-light.png",
            "chat-moved-in-pending-light.png",
            "summary-off-dark.png",
            "summary-on-dark.png",
            "summary-revoked-dark.png",
            "chat-summary-shared-dark.png",
            "chat-summary-canceled-dark.png",
            "chat-summary-private-dark.png",
            "chat-private-other-menu-dark.png",
            "chat-share-again-declined-dark.png",
            "chat-share-again-confirmed-dark.png",
            "chat-moved-in-declined-dark.png",
            "chat-moved-in-pending-dark.png",
            "native-review-light.png",
            "native-review-dark.png",
            "native-chat-summary-light.png",
            "native-chat-summary-dark.png"
          ]
        },
        null,
        2
      )
    );
    process.stdout.write(
      `HQ-702 renderer fixture proof passed; screenshots: ${output}\n`
    );
  } finally {
    window?.destroy();
    app.quit();
  }
}

void run().catch((error) => {
  process.stderr.write(`${error.stack ?? String(error)}\n`);
  app.exit(1);
});
