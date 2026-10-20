import assert from "node:assert/strict";

const inspect = (window, expression) =>
  window.webContents.executeJavaScript(expression);

async function waitFor(window, delay, condition, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await inspect(window, condition)) return;
    await delay(25);
  }
  throw new Error(`HQ108 timed out waiting for ${label}.`);
}

export async function validateHqNow(
  window,
  pagePath,
  captureScreenshot,
  delay
) {
  const needs = '.hq-now__section[aria-label="Needs you"]';
  const projects = '.hq-now__section[aria-label="Projects"]';
  await waitFor(
    window,
    delay,
    `document.querySelectorAll('${needs} .hq-now__row').length === 2 && document.querySelectorAll('${projects} .hq-now__row').length === 4`,
    "initial Now data"
  );
  const home = await inspect(
    window,
    `(() => ({
    route: document.querySelector('[data-hq-route]')?.getAttribute('data-hq-route'),
    header: document.querySelector('.hq-main__heading h1')?.textContent,
    composer: document.querySelector('[data-hq-route="home"] textarea[aria-label="Message your AI Client"]') !== null,
    needs: [...document.querySelectorAll('${needs} .hq-now__row strong')].map((node) => node.textContent),
    projects: document.querySelectorAll('${projects} .hq-now__row').length,
    nowEnabled: document.querySelector('button[aria-label="Now"]')?.disabled === false,
    nowCurrent: document.querySelector('button[aria-label="Now"]')?.getAttribute('aria-current'),
    nowSelectedBackground: getComputedStyle(document.querySelector('button[aria-label="Now"]')).backgroundColor !== 'rgba(0, 0, 0, 0)',
    pendingCount: document.querySelectorAll('${projects} .hq-now__pending-count').length,
    pendingColor: getComputedStyle(document.querySelector('${projects} .hq-now__pending-count')).color,
    composerWidth: Math.round(document.querySelector('.hq-conversation--now .hq-composer')?.getBoundingClientRect().width ?? 0),
    bodyWidth: Math.round(document.querySelector('.hq-now__content')?.getBoundingClientRect().width ?? 0)
  }))()`
  );
  assert.deepEqual(home, {
    route: "home",
    header: "Now",
    composer: true,
    needs: ["review release", "Choose the review date"],
    projects: 4,
    nowEnabled: true,
    nowCurrent: "page",
    nowSelectedBackground: true,
    pendingCount: 2,
    pendingColor: "rgb(220, 86, 58)",
    composerWidth: 848,
    bodyWidth: 880
  });
  await inspect(
    window,
    `(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    document.documentElement.dataset.theme = 'light';
  })()`
  );
  await delay(30);
  await captureScreenshot("hq108-now-light-1280x800.png");
  await inspect(
    window,
    `(() => {
    document.documentElement.classList.replace('light', 'dark');
    document.documentElement.dataset.theme = 'dark';
  })()`
  );
  await delay(30);
  await captureScreenshot("hq108-now-dark-1280x800.png");
  await inspect(
    window,
    `(() => {
    document.documentElement.classList.replace('dark', 'light');
    document.documentElement.dataset.theme = 'light';
    document.querySelector('${needs} .hq-now__row')?.click();
  })()`
  );
  await waitFor(
    window,
    delay,
    `document.querySelector('[data-hq-route="conversation"][data-hq-session-id="00000000-0000-4000-8000-000000000021"]') !== null`,
    "inventory Conversation route"
  );
  assert.equal(
    await inspect(
      window,
      `document.querySelector('button[aria-label="Now"]')?.hasAttribute('aria-current')`
    ),
    false
  );
  await waitFor(
    window,
    delay,
    `document.querySelector('.hq-runtime-item[aria-label="AI Client approval"]') !== null`,
    "inventory runtime approval"
  );
  await inspect(
    window,
    `document.querySelector('button[aria-label="Now"]')?.click()`
  );
  await waitFor(
    window,
    delay,
    `document.querySelector('[data-hq-route="home"]') !== null && document.querySelector('button[aria-label="Now"]')?.getAttribute('aria-current') === 'page'`,
    "Now navigation"
  );
  await inspect(
    window,
    `(() => {
    const input = document.querySelector('.hq-conversation--now textarea[aria-label="Message your AI Client"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, 'Plan my next week');
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  })()`
  );
  await inspect(
    window,
    `document.querySelector('.hq-conversation--now button[aria-label="Send message"]')?.click()`
  );
  await waitFor(
    window,
    delay,
    `document.querySelector('[data-hq-route="conversation"]')?.getAttribute('data-hq-project-id') === 'hq103-loose'`,
    "new Conversation from Now"
  );
  assert.equal(
    await inspect(
      window,
      `document.body.textContent.includes('Plan my next week')`
    ),
    true
  );
  await inspect(
    window,
    `document.querySelector('button[aria-label="Now"]')?.click()`
  );
  await waitFor(
    window,
    delay,
    `document.querySelector('[data-hq-route="home"] ${needs} header button') !== null && document.querySelector('[data-hq-route="home"] ${projects} header button') !== null`,
    "Now sections after Conversation"
  );
  await inspect(
    window,
    `document.querySelector('${needs} header button')?.click()`
  );
  await inspect(
    window,
    `document.querySelector('${projects} header button')?.click()`
  );
  await waitFor(
    window,
    delay,
    `document.querySelector('${needs} header button')?.getAttribute('aria-expanded') === 'false' && document.querySelector('${projects} header button')?.getAttribute('aria-expanded') === 'false'`,
    "folded Now sections"
  );
  await captureScreenshot("hq108-now-folded-light-1280x800.png");
  await window.loadFile(pagePath, {
    query: { projectsFailure: "none", view: "hq" }
  });
  await waitFor(
    window,
    delay,
    `document.querySelector('[data-hq-route="home"]') !== null && document.querySelector('${projects} header button') !== null`,
    "reloaded Now"
  );
  const folded = await inspect(
    window,
    `(() => ({
    needs: document.querySelector('${needs} header button')?.getAttribute('aria-expanded'),
    projects: document.querySelector('${projects} header button')?.getAttribute('aria-expanded')
  }))()`
  );
  assert.deepEqual(folded, { needs: "false", projects: "false" });
  await window.loadFile(pagePath, {
    query: { projectsFailure: "none", view: "hq", nowOverflow: "yes" }
  });
  await waitFor(
    window,
    delay,
    `document.querySelector('${needs} header button') !== null`,
    "overflow Now fixture"
  );
  await inspect(
    window,
    `document.querySelector('${needs} header button[aria-expanded="false"]')?.click()`
  );
  await inspect(
    window,
    `document.querySelector('${projects} header button[aria-expanded="false"]')?.click()`
  );
  await waitFor(
    window,
    delay,
    `document.querySelector('${needs} .hq-now__more') !== null && document.querySelector('${projects} .hq-now__more') !== null`,
    "both overflow controls"
  );
  const capped = await inspect(
    window,
    `(() => ({
    needs: document.querySelectorAll('${needs} .hq-now__row').length,
    projects: document.querySelectorAll('${projects} .hq-now__row').length,
    needsMore: document.querySelector('${needs} .hq-now__more')?.textContent,
    projectsMore: document.querySelector('${projects} .hq-now__more')?.textContent
  }))()`
  );
  assert.deepEqual(capped, {
    needs: 5,
    projects: 5,
    needsMore: "Show 2 more",
    projectsMore: "Show 2 more"
  });
  await inspect(
    window,
    `(() => {
    document.querySelector('${needs} .hq-now__more')?.click();
    document.querySelector('${projects} .hq-now__more')?.click();
  })()`
  );
  assert.deepEqual(
    await inspect(
      window,
      `(() => ({
    needs: document.querySelectorAll('${needs} .hq-now__row').length,
    projects: document.querySelectorAll('${projects} .hq-now__row').length
  }))()`
    ),
    { needs: 7, projects: 7 }
  );
  await window.loadFile(pagePath, {
    query: { projectsFailure: "none", view: "hq" }
  });
  await waitFor(
    window,
    delay,
    `document.querySelectorAll('[data-hq-project-link]').length === 4`,
    "baseline HQ fixture restoration"
  );
}
