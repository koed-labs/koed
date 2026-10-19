import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";

/** Additive HQ109 proof. Call after existing HQ103 subchecks; preserve approved SKIPs. */
export async function validateHqSettings({
  window,
  debuggerClient,
  repoRoot,
  delay
}) {
  const js = (source) => window.webContents.executeJavaScript(source);
  const settle = () =>
    js(
      "Promise.all([...document.querySelectorAll('.hq-settings,.hq-settings-dialog')].flatMap(node=>node.getAnimations({subtree:true})).map(animation=>animation.finished.catch(()=>undefined)))"
    );
  const waitFor = async (source, expected = true) => {
    let actual;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      actual = await js(source);
      if (actual === expected) return actual;
      await delay(25);
    }
    assert.equal(actual, expected, source);
  };
  const click = async (selector) => {
    assert.equal(
      await js(
        `(() => { const button=document.querySelector(${JSON.stringify(selector)}); if(!button) return false; button.focus(); button.click(); return true; })()`
      ),
      true,
      selector
    );
    await delay(30);
    await settle();
  };
  const clickText = async (scope, text) => {
    assert.equal(
      await js(
        `(() => { const button=[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((node)=>node.textContent?.trim()===${JSON.stringify(text)}); if(!button) return false; button.focus(); button.click(); return true; })()`
      ),
      true,
      text
    );
    await delay(30);
    await settle();
  };
  const screenshot = async (name) => {
    const { data } = await debuggerClient.sendCommand(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false }
    );
    const directory = resolve(repoRoot, "scratch/hq-109/screenshots");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, name), Buffer.from(data, "base64"));
  };
  const viewport = async (width, height) => {
    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await delay(60);
  };
  const close = async () => {
    await click('.hq-settings [aria-label="Close Settings"]');
    await waitFor("Boolean(document.querySelector('.hq-settings'))", false);
  };
  const open = async () => {
    await click("button.hq-account");
    await waitFor("Boolean(document.querySelector('.hq-settings'))");
  };
  const assertSearchStaysOutsideSettings = async (
    expectedDialogs,
    selector
  ) => {
    for (const modifier of ["metaKey", "ctrlKey"]) {
      await js(
        `(() => {const modal=document.querySelector(${JSON.stringify(selector)});(modal.querySelector('button')??modal).focus();})()`
      );
      await js(
        `window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',${modifier}:true,bubbles:true,cancelable:true}))`
      );
      await settle();
      const state = await js(
        `(() => ({dialogs:document.querySelectorAll('[role=dialog]').length,search:Boolean(document.querySelector('.hq-search')),focusInside:Boolean(document.activeElement?.closest(${JSON.stringify(selector)}))}))()`
      );
      if (state.search)
        await screenshot(
          `hq109-cmdk-${expectedDialogs === 1 ? "outer" : "nested"}-boundary-failure.png`
        );
      assert.deepEqual(
        state,
        { dialogs: expectedDialogs, search: false, focusInside: true },
        `${modifier}+K must stay outside the active Settings modal`
      );
    }
  };
  const underlying = () =>
    js(
      `(() => {const node=document.querySelector('[data-hq-route]'); return {route:node?.getAttribute('data-hq-route'),project:node?.getAttribute('data-hq-project-id'),session:node?.getAttribute('data-hq-session-id'),scroll:document.querySelector('[data-hq-sidebar-scroll]')?.scrollTop};})()`
    );

  await viewport(1280, 800);
  await click('[data-hq-project-link="hq103-koed"]');
  await waitFor(
    "document.querySelector('[data-hq-route]')?.getAttribute('data-hq-route')",
    "project"
  );
  await js(
    `(() => {const scroll=document.querySelector('[data-hq-sidebar-scroll]');scroll.scrollTop=50;scroll.dispatchEvent(new Event('scroll'));})()`
  );
  const project = await underlying();
  await open();
  assert.deepEqual(await underlying(), project);
  await assertSearchStaysOutsideSettings(1, ".hq-settings");
  assert.equal(
    await js(
      "Boolean(document.querySelector('.hq-shell')?.closest('[aria-hidden=true], [inert]'))"
    ),
    true
  );
  await close();
  assert.deepEqual(await underlying(), project);
  assert.equal(
    await js(
      "document.activeElement===document.querySelector('button.hq-account')"
    ),
    true
  );

  // Navigating between modal uses must retain the new Conversation selection.
  await click('[data-hq-chat-row][data-hq-chat-project="hq103-koed"]');
  await waitFor(
    "document.querySelector('[data-hq-route]')?.getAttribute('data-hq-route')",
    "conversation"
  );
  const conversation = await underlying();
  await open();
  await js(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
  );
  await waitFor("Boolean(document.querySelector('.hq-settings'))", false);
  assert.deepEqual(await underlying(), conversation);
  for (const modifier of ["metaKey", "ctrlKey"]) {
    await js(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:',',${modifier}:true,bubbles:true,cancelable:true}))`
    );
    await waitFor("Boolean(document.querySelector('.hq-settings'))");
    await close();
    assert.deepEqual(await underlying(), conversation);
  }
  // Once Settings closes, both platform shortcuts must open the ordinary HQ search.
  for (const modifier of ["metaKey", "ctrlKey"]) {
    await js(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',${modifier}:true,bubbles:true,cancelable:true}))`
    );
    await waitFor("Boolean(document.querySelector('.hq-search'))");
    await js(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await waitFor("Boolean(document.querySelector('.hq-search'))", false);
  }
  await click('button[aria-label="Search and commands"]');
  await click('[id="hq-search-route:preferences"]');
  await waitFor("Boolean(document.querySelector('.hq-settings'))");
  await waitFor("Boolean(document.querySelector('.hq-search'))", false);
  await close();
  assert.equal(
    await js(
      "document.activeElement===document.querySelector('button.hq-account')"
    ),
    true
  );

  await open();
  await screenshot("hq109-first-integrated-open.png");
  for (const theme of ["Light", "Dark"]) {
    await clickText(".hq-settings__themes", theme);
    const geometry = await js(
      `(() => {const p=document.querySelector('.hq-settings'),s=getComputedStyle(p),nav=p.querySelector('aside'),button=p.querySelector('nav button');return {x:p.getBoundingClientRect().x,y:p.getBoundingClientRect().y,width:p.offsetWidth,height:p.offsetHeight,rail:nav.offsetWidth,radius:s.borderRadius,background:s.backgroundColor,nav:getComputedStyle(nav).backgroundColor,heading:getComputedStyle(p.querySelector('h2')).fontSize,navFont:getComputedStyle(button).fontSize,backdrop:getComputedStyle(p.parentElement.previousElementSibling).backgroundColor,overflow:p.scrollWidth>p.clientWidth,legacy:Boolean(document.querySelector('.koed-preferences,.desktop-preferences,[data-personal-route-focus]'))};})()`
    );
    assert.deepEqual(
      {
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        rail: geometry.rail,
        radius: geometry.radius,
        heading: geometry.heading,
        navFont: geometry.navFont,
        backdrop: geometry.backdrop,
        overflow: geometry.overflow,
        legacy: geometry.legacy
      },
      {
        x: 230,
        y: 90,
        width: 820,
        height: 620,
        rail: 210,
        radius: "22px",
        heading: "18px",
        navFont: "14.5px",
        backdrop: "rgba(0, 0, 0, 0.55)",
        overflow: false,
        legacy: false
      }
    );
    assert.equal(
      geometry.background,
      theme === "Light" ? "rgb(241, 241, 244)" : "rgb(19, 19, 23)"
    );
    await screenshot(`hq109-settings-${theme.toLowerCase()}.png`);
    await clickText(".hq-settings nav", "Agents");
    await clickText(".hq-settings", "Set up Codex");
    await waitFor("document.querySelectorAll('[role=dialog]').length", 2);
    await assertSearchStaysOutsideSettings(2, ".hq-settings-dialog");
    const portal = await js(
      `(() => {const p=document.querySelector('.hq-settings-dialog'),s=getComputedStyle(p);return {scoped:p.hasAttribute('data-hq-shell'),background:s.backgroundColor,font:s.fontSize,primary:s.getPropertyValue('--primary').trim(),button:s.getPropertyValue('--hq-btn').trim(),focused:Boolean(document.activeElement?.closest('.hq-settings-dialog')),above:Number(getComputedStyle(p.parentElement).zIndex)>Number(getComputedStyle(document.querySelector('.hq-settings').parentElement).zIndex)};})()`
    );
    assert.equal(portal.scoped, true);
    assert.equal(portal.background, geometry.background);
    assert.equal(portal.font, "14px");
    assert.equal(portal.primary, portal.button);
    assert.equal(portal.focused, true);
    assert.equal(portal.above, true);
    await screenshot(`hq109-settings-${theme.toLowerCase()}-portal.png`);
    await js(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await waitFor("document.querySelectorAll('[role=dialog]').length", 1);
    assert.equal(
      await js("document.activeElement?.textContent?.trim()"),
      "Set up Codex"
    );
    await clickText(".hq-settings nav", "General");
  }
  // These are fixture APIs, proving actual control callbacks without native effects.
  await click('.hq-settings [aria-label="Launch Koed at startup"]');
  await click('.hq-settings [aria-label="Hardware acceleration"]');
  assert.deepEqual(await js("window.__koedHqSettingsOperations"), [
    "startup:true",
    "acceleration:false"
  ]);
  await close();

  await click('button[aria-label="Collapse sidebar"]');
  await waitFor(
    "document.querySelector('.hq-shell')?.hasAttribute('data-hq-compact')"
  );
  await open();
  await close();
  assert.equal(
    await js(
      "document.activeElement===document.querySelector('button.hq-account')"
    ),
    true
  );
  await click('button[aria-label="Expand sidebar"]');

  for (const width of [390, 320]) {
    await viewport(width, 844);
    await click('button[aria-label="Show project navigation"]');
    await open();
    await waitFor(
      "Boolean(document.querySelector('[data-hq-sidebar-dialog][role=dialog]'))",
      false
    );
    const phone = await js(
      `(() => {const p=document.querySelector('.hq-settings'),r=p.getBoundingClientRect(),body=p.querySelector('.hq-settings__content');return {left:r.left,right:innerWidth-r.right,width:r.width,overflow:p.scrollWidth>p.clientWidth,body:getComputedStyle(body).overflowY,nav:p.querySelector('nav').scrollWidth>p.querySelector('nav').clientWidth};})()`
    );
    assert.deepEqual(phone, {
      left: 16,
      right: 16,
      width: width - 32,
      overflow: false,
      body: "auto",
      nav: true
    });
    await screenshot(`hq109-settings-phone-${width}.png`);
    await clickText(".hq-settings nav", "Agents");
    await clickText(".hq-settings", "Set up Codex");
    assert.equal(
      await js(
        "document.querySelector('.hq-settings-dialog').scrollWidth>document.querySelector('.hq-settings-dialog').clientWidth"
      ),
      false
    );
    await screenshot(`hq109-settings-phone-${width}-portal.png`);
    await js(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await waitFor("document.querySelectorAll('[role=dialog]').length", 1);
    await close();
    assert.equal(
      await js(
        "document.activeElement===document.querySelector('button[aria-label=\"Show project navigation\"]')"
      ),
      true
    );
    assert.deepEqual(await underlying(), conversation);
  }
}
