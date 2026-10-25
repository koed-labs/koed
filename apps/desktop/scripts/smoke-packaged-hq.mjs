/* global Buffer, console, setTimeout */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  connect,
  redactLaunchOutput,
  terminateChild,
  trustedClick,
  waitForRendererTarget
} from "./smoke-packaged-renderer-faults.mjs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const HQ_SURFACE_PHASE_TIMEOUT_MS = 180_000;

export const waitForPackagedHqSurface = async ({
  readState,
  continueSetup,
  expectedSurface = "hq",
  delayImpl = delay,
  nowImpl = () => performance.now()
}) => {
  let state;
  let continuedSetup = false;
  let phaseStartedAt = nowImpl();
  while (true) {
    const candidate = await readState();
    // A slow CDP read can finish after this phase's deadline. Keep the last
    // in-budget state so a late shell or Continue button cannot pass the smoke.
    if (nowImpl() - phaseStartedAt > HQ_SURFACE_PHASE_TIMEOUT_MS) break;
    state = candidate;
    if (
      state?.hqEnabled === true &&
      (expectedSurface === "setup"
        ? ((state.onboarding && state.shell && !state.hqSetup) ||
            state.hqSetup) &&
          !state.setup
        : state.shell && !state.hqSetup)
    )
      break;
    if (
      expectedSurface === "hq" &&
      state?.hqEnabled === true &&
      state.hqSetup &&
      state.setupState === "complete" &&
      !continuedSetup
    ) {
      await continueSetup();
      continuedSetup = true;
      // Continue performs a fresh Native inspection and status refresh. Its
      // phase gets the same 60s runtime + 120s check budget as initial setup.
      phaseStartedAt = nowImpl();
      continue;
    }
    const remaining =
      HQ_SURFACE_PHASE_TIMEOUT_MS - (nowImpl() - phaseStartedAt);
    if (remaining <= 0) break;
    await delayImpl(Math.min(100, remaining));
  }
  return state;
};

export const smokePackagedHqDefault = async ({
  executable,
  env,
  koedHome,
  screenshotDir,
  expectedSurface = "hq"
}) => {
  const userDataDir = mkdtempSync(resolve(tmpdir(), "koed-hq-default-"));
  const debuggingPort =
    45_000 +
    [...userDataDir].reduce(
      (hash, character) => (hash * 33 + character.codePointAt(0)) % 10_000,
      0
    );
  const launchEnvironment = { ...env, KOED_HOME: koedHome };
  // The assertion below must exercise the package default, independent of the
  // shell that invoked this smoke.
  delete launchEnvironment.KOED_DESKTOP_HQ_ENABLED;
  delete launchEnvironment.ELECTRON_RUN_AS_NODE;
  let childExit;
  let outputTail = "";
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run"
    ],
    { env: launchEnvironment, stdio: ["ignore", "pipe", "pipe"] }
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      outputTail = `${outputTail}${String(chunk)}`.slice(-32_768);
    });
  child.on("exit", (code, signal) => {
    childExit = { code, signal };
  });
  let cdp;
  try {
    const target = await waitForRendererTarget({
      debuggingPort,
      readChildExit: () => childExit
    });
    if (!target)
      throw new Error(
        `Packaged HQ renderer target unavailable. Exit: ${JSON.stringify(childExit)}. Output: ${redactLaunchOutput(outputTail)}`
      );
    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.call("Runtime.enable");
    await cdp.call("Page.enable");
    const evaluate = async (expression) => {
      const result = await cdp.call("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text
        );
      return result.result.value;
    };
    const captureScreenshot = async (surface) => {
      mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
      const screenshotPath = resolve(
        screenshotDir,
        `packaged-hq-${surface}-${randomUUID()}.png`
      );
      const image = await cdp.call("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false
      });
      writeFileSync(screenshotPath, Buffer.from(image.data, "base64"), {
        mode: 0o600
      });
      console.error(`[packaged-hq] ${surface} screenshot: ${screenshotPath}`);
      return screenshotPath;
    };
    const state = await waitForPackagedHqSurface({
      expectedSurface,
      readState: () =>
        evaluate(`(() => ({
        url: location.href,
        hqEnabled: window.koedDesktop?.featureFlags?.hqEnabled,
        shell: Boolean(document.querySelector('[data-hq-shell]')),
        hqSetup: Boolean(document.querySelector('[data-hq-setup]')),
        setupState: document.querySelector('[data-hq-setup]')?.getAttribute('data-state') ?? null,
        onboarding: Boolean(document.querySelector('.hq-onboarding')),
        route: document.querySelector('[data-hq-route]')?.getAttribute('data-hq-route') ?? null,
        setup: Boolean(document.querySelector('.koed-setup-card')),
        body: document.body?.innerText?.slice(0, 500) ?? ''
      }))()`),
      continueSetup: () =>
        trustedClick({
          cdp,
          evaluate,
          locator:
            "[...document.querySelectorAll('[data-hq-setup] button')].find((candidate) => candidate.textContent?.trim() === 'Continue to Koed' && !candidate.disabled)"
        })
    });
    if (
      !state?.url?.startsWith("koed://app/") ||
      state.url.includes("browser-validation") ||
      state.hqEnabled !== true ||
      !(expectedSurface === "setup"
        ? state.onboarding && state.shell && !state.hqSetup && !state.setup
        : state.shell && !state.hqSetup)
    ) {
      const setupInspection = await evaluate(`Promise.race([
        Promise.resolve(window.koedDesktop?.setup?.inspect?.())
          .then((snapshot) => ({
            state: snapshot?.state ?? null,
            stages: (snapshot?.stages ?? []).map((stage) => ({
              id: stage.id,
              state: stage.state,
              message: String(stage.message ?? '').slice(0, 240)
            }))
          }))
          .catch((error) => ({ error: String(error).slice(0, 240) })),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 8000))
      ])`);
      throw new Error(
        `Packaged default ${expectedSurface} did not render: ${JSON.stringify(state)}. Setup inspection: ${JSON.stringify(setupInspection)}`
      );
    }
    if (expectedSurface === "setup")
      return {
        packageDefaultEnabled: true,
        productionEntry: state.url,
        hqOnboardingSurface: true,
        screenshotPath: await captureScreenshot("first-run-onboarding")
      };
    const screenshotPath = await captureScreenshot("default");
    return {
      packageDefaultEnabled: true,
      productionEntry: state.url,
      hqShell: true,
      onboarding: state.onboarding,
      route: state.route,
      screenshotPath
    };
  } finally {
    cdp?.close();
    await terminateChild(child);
    rmSync(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200
    });
  }
};
