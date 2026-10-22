import assert from "node:assert/strict";
import console from "node:console";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const output = resolve(scratch, "hq-711", "screenshots");

/** HQ-711 owned visibility and colleague privacy subset; the full S03/S20 compound flows remain separate. */
export const validateHq711 = async (window) => {
  const errors = [];
  window.webContents.on("console-message", (...args) => {
    errors.push(
      args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ")
    );
  });
  await mkdir(output, { recursive: true });
  const js = (source) => window.webContents.executeJavaScript(source);
  const waitFor = async (source, label) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await js(source)) return;
      await delay(50);
    }
    const detail = await js(
      "JSON.stringify({body: document.body?.innerText?.slice(0,1300), ready:document.documentElement.dataset.hqFixtureReady, reads:window.__koedHqVisibilityReads, lines:Array.from(document.querySelectorAll('.hq-composer__visibility')).map(el=>({text:el.textContent,parent:el.parentElement?.parentElement?.className})), html:document.body?.innerHTML?.slice(0,300)})"
    ).catch(() => "script unavailable");
    throw new Error(`${label}: ${errors.join(" | ")} ${detail}`);
  };
  const capture = async (name, expected) => {
    const visible = await js(`(() => {
        const line = document.querySelector('.hq-composer__visibility');
        const rect = line?.getBoundingClientRect();
        return !!line && !!rect && rect.width > 0 && rect.height > 0 &&
          rect.top >= 0 && rect.bottom <= innerHeight &&
          line.textContent.includes(${JSON.stringify(expected)}) &&
          document.documentElement.classList.contains(${JSON.stringify(name.endsWith("dark.png") ? "dark" : "light")});
      })()`);
    assert.equal(
      visible,
      true,
      `${name} must show its visibility line and theme`
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
  const projectId = "00000000-0000-4000-8000-000000002038";
  for (const theme of ["light", "dark"]) {
    await window.loadFile(
      resolve(root, "apps/desktop/dist/browser-validation.html"),
      {
        query: {
          view: "hq",
          hq701Linked: "yes",
          hq306Capture: "yes",
          hq702Capture: "yes",
          hq711Capture: "yes"
        }
      }
    );
    await waitFor(
      "document.documentElement.dataset.hqFixtureReady === 'true'",
      "HQ fixture"
    );
    await js(
      `document.documentElement.classList.remove('light','dark'); document.documentElement.classList.add('${theme}')`
    );
    await js(
      `document.querySelector('[data-hq-project-link="${projectId}"]')?.click()`
    );
    await waitFor(
      "document.querySelector('.hq-composer__visibility')?.textContent.includes('Just me · not shared with Koed team')",
      "private HQ"
    );
    await capture(
      `private-hq-${theme}.png`,
      "Just me · not shared with Koed team"
    );
    await waitFor(
      "document.querySelector('.hq-shared-project__privacy')?.textContent.includes('private to its owner')",
      "colleague Agent privacy note"
    );
    await js(
      "document.querySelector('.hq-shared-project__privacy')?.scrollIntoView({block:'center'})"
    );
    const colleagueVisible = await js(`(() => {
        const note = document.querySelector('.hq-shared-project__privacy');
        const rect = note?.getBoundingClientRect();
        return !!rect && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight &&
          !note.closest('.hq-shared-project__row')?.querySelector('a[href*="/chat/"]');
      })()`);
    assert.equal(
      colleagueVisible,
      true,
      "colleague note visible without chat link"
    );
    const colleagueProgress = await js(`(() => {
      const note = document.querySelector('.hq-shared-project__privacy');
      const row = note?.closest('.hq-shared-project__row');
      const link = row?.querySelector('.hq-shared-project__pr-link');
      return {
        status: row?.closest('[aria-label]')?.getAttribute('aria-label'),
        step: row?.querySelector('.hq-project-view__work-item-meta')?.textContent.trim(),
        prText: link?.textContent.trim(),
        prHref: link?.getAttribute('href'),
        chatLink: Boolean(row?.querySelector('a[href*="/chat/"], [data-hq-conversation]')),
        privateExecution: row?.textContent.includes('colleague-private-execution')
      };
    })()`);
    assert.equal(colleagueProgress.status, "Needs you");
    assert.match(colleagueProgress.step, /Pull request open/);
    assert.equal(colleagueProgress.prText, "Open PR");
    assert.equal(
      colleagueProgress.prHref,
      "https://github.com/acme/repo/pull/213"
    );
    assert.equal(colleagueProgress.chatLink, false);
    assert.equal(colleagueProgress.privateExecution, false);
    await js(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    );
    await delay(200);
    await writeFile(
      resolve(output, `colleague-private-${theme}.png`),
      (await window.webContents.capturePage()).toPNG()
    );
    await js(
      `Array.from(document.querySelectorAll('[data-hq-chat-project="${projectId}"][data-hq-chat-row]')).find(row => row.textContent.includes('Plan next week'))?.click()`
    );
    await waitFor(
      "document.querySelector('.hq-composer__visibility')?.textContent.includes('Visible to Koed team (summaries)')",
      "shared exact Conversation summary"
    );
    assert.match(
      await js("document.querySelector('.hq-composer__visibility')?.title"),
      /Maya/
    );
    await capture(
      `shared-summary-${theme}.png`,
      "Visible to Koed team (summaries)"
    );
    await js("window.__koedHq711VisibilityFixture.setMode('pending')");
    await waitFor(
      "!document.querySelector('.hq-composer__visibility')",
      "pending share has no publication label"
    );
    await js("window.__koedHq711VisibilityFixture.setMode('private')");
    await waitFor(
      "document.querySelector('.hq-composer__visibility')?.textContent.includes('Just me · not shared with Koed team')",
      "private exact Conversation"
    );
    await capture(
      `private-chat-${theme}.png`,
      "Just me · not shared with Koed team"
    );
    await js("window.__koedHq711VisibilityFixture.setMode('unknown')");
    await waitFor(
      "!document.querySelector('.hq-composer__visibility')",
      "unknown owner read has no claim"
    );
    await js("window.__koedHq711VisibilityFixture.setMode('direct')");
    await waitFor(
      "document.querySelector('.hq-composer__visibility')?.textContent.includes('Visible to Maya (summaries)')",
      "named limited audience"
    );
    await capture(
      `limited-audience-${theme}.png`,
      "Visible to Maya (summaries)"
    );
    await js(
      "document.querySelector('button[aria-label=\"New chat\"]')?.click()"
    );
    await waitFor(
      "document.querySelector('.hq-conversation--blank .hq-composer__visibility')?.textContent.trim() === 'Just me'",
      "visibility before first message"
    );
    await capture(`empty-initial-${theme}.png`, "Just me");
  }
  await writeFile(
    resolve(scratch, "hq-711", "HQ711.native.json"),
    JSON.stringify(
      {
        id: "HQ711.native",
        status: "pass",
        proofIds: [
          "S03.1.privacy-note",
          "S03.1.no-colleague-chat-link",
          "S03.1.safe-status-step-pr"
        ],
        scope: "simulated IPC renderer fixture"
      },
      null,
      2
    ) + "\n"
  );
  console.log(`HQ-711 Native fixture proof passed: ${output}`);
};
