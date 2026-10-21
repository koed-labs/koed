import assert from "node:assert/strict";
import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scratch = resolve(repoRoot, "scratch");
const images = resolve(scratch, "hq-803", "screenshots");
const profile = process.env.KOED_HQ803_USER_DATA_DIR;
assert.ok(profile, "Supply an isolated HQ-803 Electron profile.");
assert.equal(dirname(resolve(profile)), scratch);
app.setPath("userData", profile);

const run = async () => {
  let window;
  let failed = false;
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: true, width: 1280, height: 800 });
    const errors = [];
    window.webContents.on("console-message", (_event, details) => {
      if (details.level === "error") errors.push(details.message);
    });
    await window.loadFile(
      resolve(repoRoot, "apps/desktop/dist/browser-validation.html"),
      {
        query: {
          view: "hq",
          hq803Capture: "yes",
          hq802DeckCapture: "yes"
        }
      }
    );
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = async (source) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await js(source)) return;
        await delay(50);
      }
      throw new Error(
        `HQ-803 fixture did not reach ${source}; errors: ${errors.join(" | ")}`
      );
    };
    const projectId = "00000000-0000-4000-8000-000000002038";
    await waitFor(
      `document.documentElement.dataset.hqFixtureReady === 'true' && Boolean(document.querySelector('[data-hq-project-link="${projectId}"]'))`
    );
    await js(
      `document.querySelector('[data-hq-project-link="${projectId}"]').click()`
    );
    await waitFor("Boolean(document.querySelector('.hq-decks__chip'))");
    await delay(750);
    assert.match(
      await js("document.querySelector('.hq-decks__chip').textContent"),
      /Midterm flashcards/
    );
    await js("document.querySelector('.hq-decks__chip').click()");
    await waitFor(
      "Boolean(document.querySelector('.hq-decks__panel .hq-decks__card')) && Boolean(document.querySelector('.hq-project-conversation__inspector:not([hidden])'))"
    );
    assert.match(
      await js("document.querySelector('.hq-decks__panel').textContent"),
      /5 to review today/
    );
    await mkdir(images, { recursive: true });
    const capture = async (name) => {
      const theme = name.endsWith("-dark.png") ? "dark" : "light";
      const generatedDeck = name.startsWith("deck-generated-open-");
      const deckExpected =
        name !== "deck-generated-action-light.png" &&
        name !== "deck-to-sources-dark.png";
      const visible = await js(`(() => {
        const panel = document.querySelector(${JSON.stringify(deckExpected ? ".hq-decks__panel" : name === "deck-to-sources-dark.png" ? ".hq-project-sources__panel" : ".hq-text-action")});
        const rect = panel?.getBoundingClientRect();
        return !!rect && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth && rect.top < innerHeight &&
          document.documentElement.classList.contains('dark') === ${theme === "dark"} &&
          ${generatedDeck ? "panel.textContent.includes('Chapter 7 flashcards') && panel.textContent.includes('What shifts supply?')" : "true"};
      })()`);
      assert.equal(visible, true, `${name} must show its panel and theme`);
      await js(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
      );
      await delay(250);
      await window.webContents.capturePage();
      await writeFile(
        resolve(images, name),
        (await window.webContents.capturePage()).toPNG()
      );
    };
    await capture("deck-study-light.png");
    await js("document.querySelector('.hq-decks__card').click()");
    await waitFor(
      "document.querySelector('.hq-decks__card')?.textContent?.includes('next best alternative')"
    );
    assert.equal(
      await js("document.querySelectorAll('.hq-decks__ratings button').length"),
      3
    );
    await capture("deck-answer-light.png");
    await js(
      "document.querySelector('.hq-decks__ratings button:first-child').click()"
    );
    await waitFor("window.__koedHq803Trace?.grades?.[0] === 'again'");
    await waitFor(
      "!document.querySelector('.hq-decks__card')?.textContent?.includes('What is opportunity cost?')"
    );
    assert.match(
      await js("document.querySelector('.hq-decks__panel').textContent"),
      /5 to review today/
    );
    await js("document.querySelector('.hq-decks__card').click()");
    await waitFor(
      "document.querySelector('.hq-decks__ratings button:nth-child(2)')?.textContent?.includes('tomorrow')"
    );
    await js(
      "document.querySelector('.hq-decks__ratings button:nth-child(2)').click()"
    );
    await waitFor("window.__koedHq803Trace?.grades?.[1] === 'good'");
    assert.match(
      await js("document.querySelector('.hq-decks__panel').textContent"),
      /4 to review today/
    );
    await js(
      "document.querySelector('.hq-decks__tabs button:last-child').click()"
    );
    assert.equal(
      await js("document.querySelectorAll('.hq-decks__all article').length"),
      5
    );
    await capture("deck-all-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark'); document.documentElement.dataset.theme='dark'"
    );
    await capture("deck-all-dark.png");
    await js(
      "document.querySelector('.hq-decks__tabs button:first-child').click()"
    );
    await capture("deck-study-dark.png");
    await js(
      "document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light'); document.documentElement.dataset.theme='light'"
    );
    await js(
      "document.querySelector('.hq-decks__panel button[aria-label=\"Close Deck\"]').click()"
    );
    await waitFor(
      "Array.from(document.querySelectorAll('.hq-text-action')).some((card) => card.textContent.includes('Chapter 7 flashcards'))"
    );
    await capture("deck-generated-action-light.png");
    await js(
      "Array.from(document.querySelectorAll('.hq-text-action')).find((card) => card.textContent.includes('Chapter 7 flashcards')).querySelector('button')?.click()"
    );
    await waitFor(
      "window.__koedHq802DeckTrace?.receiptCalls === 1 && window.__koedHq802DeckTrace?.generatedOpens === 1 && document.querySelector('.hq-decks__panel')?.textContent?.includes('What shifts supply?')"
    );
    assert.match(
      await js("document.querySelector('.hq-decks__panel').textContent"),
      /Chapter 7 flashcards/
    );
    assert.doesNotMatch(
      await js("document.querySelector('.hq-decks__panel').textContent"),
      /What is opportunity cost\?/
    );
    await capture("deck-generated-open-light.png");
    await js(
      "document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark'); document.documentElement.dataset.theme='dark'"
    );
    await capture("deck-generated-open-dark.png");
    await js("document.querySelector('.hq-project-sources__count').click()");
    await waitFor(
      "Boolean(document.querySelector('.hq-project-sources__panel')) && !document.querySelector('.hq-decks__panel')"
    );
    assert.equal(
      await js(
        "document.querySelectorAll('.hq-project-conversation__inspector .hq-project-sources__panel').length"
      ),
      1
    );
    await capture("deck-to-sources-dark.png");
    assert.equal(errors.length, 0, errors.join(" | "));
    await writeFile(
      resolve(scratch, "hq-803", "browser-report.json"),
      JSON.stringify(
        {
          id: "HQ803.native",
          owner: "HQ-803",
          status: "pass",
          assertions: [
            { id: "S22.1.study", owner: "HQ-803", status: "pass" },
            { id: "S22.1.text", owner: "HQ-802/HQ-803", status: "pass" }
          ],
          coverage: {
            chipOpensDeck: true,
            studyAndAllCards: true,
            flip: true,
            againStaysDue: true,
            goodAdvances: true,
            lightAndDark: true,
            generatedActionReceiptOpensExactDeck: true,
            deckYieldsPanelToSources: true
          },
          screenshots: [
            "deck-study-light.png",
            "deck-answer-light.png",
            "deck-all-light.png",
            "deck-all-dark.png",
            "deck-study-dark.png",
            "deck-generated-action-light.png",
            "deck-generated-open-light.png",
            "deck-generated-open-dark.png",
            "deck-to-sources-dark.png"
          ]
        },
        null,
        2
      )
    );
    process.stdout.write(`HQ-803 Electron captures: ${images}\n`);
  } catch (cause) {
    failed = true;
    process.stderr.write(
      `${cause instanceof Error ? cause.stack : String(cause)}\n`
    );
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(failed ? 1 : 0);
  }
};
void run();
