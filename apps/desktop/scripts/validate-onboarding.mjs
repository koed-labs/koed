import assert from "node:assert/strict";
import { app, BrowserWindow, nativeTheme } from "electron";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import console from "node:console";

const run = async () => {
  const scratch = fileURLToPath(
    new URL("../../../scratch/onboarding/electron/", import.meta.url)
  );
  await mkdir(scratch, { recursive: true });
  app.setPath("userData", await mkdtemp(join(scratch, "profile-")));
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  const errors = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const page = fileURLToPath(
    new URL("../dist-validation/v1-validation.html", import.meta.url)
  );
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const waitFor = async (expression) => {
    const limit = Date.now() + 10000;
    while (!(await evaluate(expression))) {
      assert.ok(Date.now() < limit, `Timed out: ${expression}`);
      await delay(40);
    }
  };
  const click = async (name) => {
    assert.equal(
      await evaluate(
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(name)});if(!b||b.disabled)return false;b.click();return true;})()`
      ),
      true,
      `Enabled button: ${name}`
    );
  };
  const key = (keyCode) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    if (keyCode === "Return" || keyCode === "Space")
      window.webContents.sendInputEvent({
        type: "char",
        keyCode: keyCode === "Return" ? "\r" : " "
      });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  };
  const capture = async (name) => {
    await waitFor(
      "document.querySelector('.lp-kin-scene')?.dataset.kinState === 'fallback' || document.querySelector('.lp-kin-scene')?.dataset.kinAnimating === 'false'"
    );
    await evaluate("document.fonts.ready");
    await evaluate(
      "Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(()=>{})))"
    );
    await evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
    );
    await waitFor(
      "document.querySelector('.lp-kin-scene')?.dataset.kinState === 'fallback' || document.querySelector('.lp-kin-scene')?.dataset.kinAnimating === 'false'"
    );
    await writeFile(
      join(scratch, name + ".png"),
      (await window.webContents.capturePage()).toPNG()
    );
    assert.equal(
      await evaluate("document.documentElement.scrollWidth>innerWidth"),
      false,
      `${name}: horizontal overflow`
    );
  };
  const load = async (scene, theme = "light", outcome = "partial") => {
    nativeTheme.themeSource = theme;
    await window.loadFile(page, {
      query: { onboarding: "1", scene, theme, outcome }
    });
    await waitFor(
      "!!document.querySelector('.lp-workspace') && document.querySelector('.lp-kin-scene')?.dataset.kinState !== 'loading'"
    );
    await waitFor("!document.body.innerText.includes('Checking local setup')");
  };
  try {
    for (const [size, width, height] of [
      ["desktop", 1280, 720],
      ["compact", 960, 640]
    ]) {
      window.setContentSize(width, height);
      for (const theme of ["light", "dark"]) {
        await load("ready", theme);
        await waitFor(
          "document.body.innerText.includes('Your Koed is ready.')"
        );
        await capture(`${size}-${theme}-ready`);
        await click("Next");
        await waitFor(
          "!!document.querySelector('input[aria-label=\"Enable Pi\"]:checked')"
        );
        await capture(`${size}-${theme}-clients`);
        await click("Connect");
        await waitFor("document.body.innerText.includes('Retry failed')");
        await capture(`${size}-${theme}-partial`);
        await click("Retry failed");
        await waitFor(
          "document.body.innerText.includes('Everyone’s connected.')"
        );
        await click("Continue");
        await waitFor("document.body.innerText.includes('You’re all set.')");
        await capture(`${size}-${theme}-complete`);
        await click("Let’s go");
        await waitFor(
          "window.onboardingValidation.complete && !!document.querySelector('.v1-app')"
        );
        assert.equal(
          await evaluate("window.onboardingValidation.savedAgent.name"),
          "Koed"
        );
        assert.equal(
          await evaluate(
            "document.querySelectorAll('.lp-kin-scene canvas').length"
          ),
          0
        );
        await load("setup-error", theme);
        await waitFor("document.body.innerText.includes('Retry step')");
        await capture(`${size}-${theme}-setup-error`);
        await click("Retry step");
        await waitFor(
          "window.onboardingValidation.calls().some(c=>c.command==='setup_run')"
        );
        await evaluate("window.onboardingValidation.stage('model',.5)");
        await capture(`${size}-${theme}-running`);
        await evaluate("window.onboardingValidation.completeSetup()");
        await waitFor(
          "document.body.innerText.includes('Your Koed is ready.')"
        );
      }
    }
    window.setContentSize(960, 640);
    await load("clients", "dark", "details");
    await click("Connect");
    await waitFor("!!document.querySelector('.lp-client-details')");
    assert.equal(
      await evaluate("document.querySelector('.lp-client-details').open"),
      false
    );
    await capture("compact-dark-error-details-closed");
    await evaluate(
      "document.querySelector('.lp-client-details summary').focus()"
    );
    key("Return");
    await waitFor("document.querySelector('.lp-client-details').open");
    await capture("compact-dark-error-details-open");
    nativeTheme.themeSource = "light";
    await waitFor(
      "getComputedStyle(document.querySelector('.lp-workspace')).colorScheme==='light'"
    );
    await capture("compact-light-error-details-open");
    await click("Retry failed");
    await waitFor("document.body.innerText.includes('Everyone’s connected.')");
    assert.equal(
      await evaluate("document.querySelectorAll('.lp-client-details').length"),
      0
    );
    const verifyScrollableRecovery = async (label) => {
      assert.equal(
        await evaluate(`(() => {
        const workspace = document.querySelector('.lp-workspace');
        workspace.scrollTop = 0;
        return workspace.clientHeight <= innerHeight &&
          workspace.scrollHeight > workspace.clientHeight &&
          document.querySelector('.lp-loader').getBoundingClientRect().top >= 0;
      })()`),
        true,
        `${label}: bounded scrolling with reachable top`
      );
      assert.equal(
        await evaluate(`(() => {
        const workspace = document.querySelector('.lp-workspace');
        const button = [...workspace.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Retry'));
        button.scrollIntoView({ block: 'end' });
        const bounds = button.getBoundingClientRect();
        return workspace.scrollTop > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight;
      })()`),
        true,
        `${label}: recovery button reachable by scrolling`
      );
      await capture(label);
    };
    await load("clients", "dark", "long-details");
    await click("Connect");
    await waitFor("!!document.querySelector('.lp-client-details')");
    await evaluate("document.querySelector('.lp-client-details').open = true");
    await verifyScrollableRecovery("compact-dark-long-client-details");
    await click("Retry failed");
    await waitFor("document.body.innerText.includes('Everyone’s connected.')");
    await load("setup-error");
    await evaluate(
      `window.onboardingValidation.fail('Download failed. Check the connection and retry. '.repeat(60))`
    );
    await verifyScrollableRecovery("compact-light-long-setup-error");
    await click("Retry step");
    await waitFor(
      "window.onboardingValidation.calls().some(c=>c.command==='setup_run')"
    );
    window.setContentSize(1280, 720);
    await load("clients", "dark", "failure");
    await waitFor(
      "!!document.querySelector('input[aria-label=\"Enable Pi\"]:checked')"
    );
    await click("Connect");
    await waitFor("document.body.innerText.includes('Retry connections')");
    assert.equal(
      await evaluate(
        "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Continue')"
      ),
      false
    );
    await capture("desktop-dark-full-failure");
    await load("pending");
    await waitFor(
      "!!document.querySelector('.lp-primary-button:not(:disabled)')"
    );
    assert.equal(
      await evaluate(
        "window.onboardingValidation.calls().some(c=>c.command==='setup_run')"
      ),
      false
    );
    assert.equal(
      await evaluate(
        "document.querySelector('h1, [role=progressbar], .lp-theme-toggle')"
      ),
      null
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.lp-workspace').innerText.trim()"
      ),
      "Get Started"
    );
    await capture("desktop-light-consent");
    nativeTheme.themeSource = "dark";
    await waitFor(
      "getComputedStyle(document.querySelector('.lp-workspace')).colorScheme==='dark'"
    );
    await capture("desktop-dark-consent");
    await click("Get Started");
    await evaluate("window.onboardingValidation.stage('model',.5)");
    await waitFor(
      "document.querySelector('[role=progressbar]').getAttribute('aria-valuenow')==='41'"
    );
    await waitFor("document.body.innerText.includes('256 MB of 512 MB')");
    await capture("desktop-dark-download-progress");
    await evaluate("window.onboardingValidation.stage('model',.505)");
    await waitFor(
      "Number(document.querySelector('[role=progressbar] i').style.transform.slice(7,-1)) > 2.5 / 6"
    );
    await evaluate("window.onboardingValidation.fail()");
    await waitFor("document.body.innerText.includes('Retry step')");
    await click("Retry step");
    await evaluate("window.onboardingValidation.completeSetup()");
    await waitFor("document.body.innerText.includes('Your Koed is ready.')");
    nativeTheme.themeSource = "dark";
    await waitFor(
      "getComputedStyle(document.querySelector('.lp-workspace')).colorScheme==='dark'"
    );
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('.lp-workspace')).colorScheme"
      ),
      "dark"
    );
    // Use real Electron pointer input: direct tracking, flick reaction and click suppression.
    await load("pending", "dark");
    const bounds = await evaluate(`(() => {
      const r = document.querySelector('.lp-kin-button').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    const originalSkin = await evaluate(
      "document.querySelector('.lp-kin-scene').dataset.kinSkin"
    );
    window.webContents.sendInputEvent({
      type: "mouseDown",
      ...bounds,
      button: "left",
      clickCount: 1
    });
    for (let i = 1; i <= 6; i++) {
      window.webContents.sendInputEvent({
        type: "mouseMove",
        x: bounds.x + i * 28,
        y: bounds.y,
        button: "left"
      });
      await delay(12);
    }
    await waitFor(
      "document.querySelector('.lp-kin-scene').dataset.kinMood==='startled'"
    );
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: bounds.x + 168,
      y: bounds.y,
      button: "left",
      clickCount: 1
    });
    await waitFor(
      "document.querySelector('.lp-kin-button').dataset.dragging==='false'"
    );
    // Capture the reaction as Kin turns back toward the user.
    await waitFor(`(() => {
      const e = document.querySelector('.lp-kin-scene');
      const yaw = Number(e.dataset.kinYaw);
      return e.dataset.kinMood === 'startled' && Math.abs(Math.atan2(Math.sin(yaw), Math.cos(yaw))) < 0.3;
    })()`);
    await writeFile(
      join(scratch, "desktop-dark-kin-fast-spin.png"),
      (await window.webContents.capturePage()).toPNG()
    );
    await waitFor(
      "document.querySelector('.lp-kin-scene').dataset.kinAnimating==='false'"
    );
    assert.equal(
      await evaluate("document.querySelector('.lp-kin-scene').dataset.kinSkin"),
      originalSkin,
      "Dragging must not trigger the click trick"
    );
    await load("ready", "dark");
    // Exercise the real engine in Electron, including loss of its context.
    const kinState = await evaluate(
      "document.querySelector('.lp-kin-scene').dataset.kinState"
    );
    assert.equal(
      kinState,
      "ready",
      "Branch Pixelkin engine renders in Electron"
    );
    await evaluate(
      "document.querySelector('.lp-kin-scene canvas').dispatchEvent(new Event('webglcontextlost'))"
    );
    await waitFor(
      "document.querySelector('.lp-kin-scene').dataset.kinState==='fallback'"
    );
    await capture("desktop-dark-webgl-fallback");

    // Full application: durable completion, relaunch, and Settings restart.
    await window.loadFile(page, {
      query: { onboarding: "1", full: "1", scene: "ready", outcome: "success" }
    });
    await waitFor("document.body.innerText.includes('Your Koed is ready.')");
    await click("Next");
    await waitFor(
      "!!document.querySelector('input[aria-label=\"Enable Pi\"]:checked')"
    );
    await click("Connect");
    await waitFor("document.body.innerText.includes('Everyone’s connected.')");
    await click("Continue");
    await evaluate("window.onboardingValidation.failCompletionWrites=1");
    await click("Let’s go");
    await waitFor("document.body.innerText.includes('Profile save failed')");
    assert.equal(
      await evaluate(
        "window.onboardingValidation.profile().onboarding.completed"
      ),
      false
    );
    assert.equal(
      await evaluate("localStorage.getItem('onboarding-backend-complete')"),
      "true"
    );
    await click("Let’s go");
    await waitFor(
      "!!document.querySelector('.v1-app') && !document.querySelector('.lp-workspace')"
    );
    assert.equal(
      await evaluate(
        "window.onboardingValidation.profile().onboarding.completed"
      ),
      true
    );
    assert.equal(
      await evaluate("window.onboardingValidation.profile().onboarding.draft"),
      undefined
    );
    const savedLook = await evaluate(
      "window.onboardingValidation.profile().agentLook"
    );
    await window.reload();
    await waitFor(
      "!!document.querySelector('.v1-app') && !document.querySelector('.lp-workspace')"
    );
    // The account menu is the normal Settings entry.
    await evaluate("document.querySelector('.v1-account').click()");
    await waitFor("document.body.innerText.includes('Settings')");
    await waitFor("document.body.innerText.includes('Run setup again')");
    await click("Run setup again");
    await waitFor("document.body.innerText.includes('Your Koed is ready.')");
    assert.equal(
      await evaluate("window.onboardingValidation.profile().agentLook"),
      savedLook
    );
    await capture("full-app-restarted-setup");
    // Emulate the accessibility preference through Chromium's supported protocol.
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }
    );
    await load("running", "dark", "success");
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('.lp-progress-track'),'::after').animationName"
      ),
      "none"
    );
    await load("ready", "dark", "success");
    await capture("desktop-dark-reduced-motion");
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('.lp-scrolling-message')).animationName"
      ),
      "none"
    );
    // Keyboard activation follows the visible tab order from the first control.
    await evaluate("document.querySelector('.lp-kin-button').focus()");
    for (let i = 0; i < 1; i++) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    }
    await waitFor("document.activeElement?.textContent.trim()==='Next'");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await waitFor(
      "document.activeElement?.textContent.trim()==='Connect your AI Clients.'"
    );
    await waitFor(
      "!!document.querySelector('input[aria-label=\"Enable Pi\"]:checked')"
    );
    key("Tab");
    await waitFor(
      "document.activeElement?.getAttribute('aria-label')==='Enable Codex'"
    );
    key("Space");
    await waitFor(
      "!document.querySelector('input[aria-label=\"Enable Codex\"]').checked"
    );
    key("Space");
    await waitFor(
      "document.querySelector('input[aria-label=\"Enable Codex\"]').checked"
    );
    for (let i = 0; i < 4; i++) key("Tab");
    await waitFor("document.activeElement?.textContent.trim()==='Connect'");
    key("Return");
    await waitFor("document.body.innerText.includes('Everyone’s connected.')");
    await waitFor("document.activeElement?.tagName==='H1'");
    key("Tab");
    key("Tab");
    await waitFor("document.activeElement?.textContent.trim()==='Continue'");
    key("Return");
    await waitFor(
      "document.activeElement?.textContent.trim()==='You’re all set.'"
    );
    await capture("desktop-dark-reduced-motion-complete");
    assert.equal(
      await evaluate(
        "document.querySelector('.lp-celebration canvas').getContext('2d').getImageData(0,0,1,1).data[3]"
      ),
      0
    );
    key("Tab");
    await waitFor("document.activeElement?.textContent.trim()==='Let’s go'");
    key("Return");
    await waitFor(
      "window.onboardingValidation.complete && !!document.querySelector('.v1-app')"
    );
    await window.webContents.debugger.sendCommand(
      "Emulation.setEmulatedMedia",
      { features: [] }
    );
    window.webContents.debugger.detach();
    assert.deepEqual(errors, []);
    await writeFile(
      join(scratch, "report.json"),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          engine: kinState,
          sizes: [
            [1280, 720],
            [960, 640]
          ],
          themes: ["light", "dark"],
          scenarios: [
            "ready",
            "clients",
            "partial",
            "retry",
            "complete",
            "finish",
            "setup-error",
            "long-client-details-scroll",
            "long-setup-error-scroll",
            "running",
            "full-failure",
            "consent",
            "theme",
            "webgl-fallback",
            "full-app-profile-save-retry",
            "relaunch",
            "settings-restart",
            "keyboard",
            "drag-spin",
            "reduced-motion"
          ],
          rendererErrors: errors
        },
        null,
        2
      ) + "\n"
    );
    console.log("Onboarding Electron checks passed. Evidence:", scratch);
  } finally {
    window.destroy();
    app.quit();
  }
};
void run().catch((error) => {
  console.error(error);
  app.exit(1);
});
