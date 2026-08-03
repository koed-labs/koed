/* global clearTimeout, fetch, setTimeout, WebSocket */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const delay = (ms) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const appendOutputTail = (current, chunk) =>
  `${current}${String(chunk)}`.slice(-32_768);

const redactLaunchOutput = (value) =>
  value
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:cmt|cms)_[A-Za-z0-9_-]+/gu, "[REDACTED_CREDENTIAL]")
    .replace(/\b(KOED_[A-Z0-9_]*(?:KEY|SECRET|TOKEN))=\S+/gu, "$1=[REDACTED]");

const connect = (url) =>
  new Promise((resolveConnect, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let sequence = 0;
    const notifications = [];
    const timer = setTimeout(
      () => reject(new Error("Packaged renderer CDP connection timed out.")),
      10_000
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolveConnect({
        call(method, params = {}) {
          sequence += 1;
          const id = sequence;
          return new Promise((resolveCall, rejectCall) => {
            pending.set(id, { resolve: resolveCall, reject: rejectCall });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        notifications,
        close: () => socket.close()
      });
    });
    socket.addEventListener("error", () =>
      reject(new Error("Packaged renderer CDP connection failed."))
    );
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      if (!message.id) {
        notifications.push(message);
        return;
      }
      if (!pending.has(message.id)) return;
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });
  });

const waitFor = async (evaluate, expression, label) => {
  let last;
  let lastError;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      last = await evaluate(expression);
      if (last) return last;
      lastError = undefined;
    } catch (error) {
      // Navigation briefly replaces the renderer execution context. Retry until
      // the destination document is ready, but retain the last failure for a
      // useful timeout diagnostic.
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(
    `Timed out waiting for packaged renderer ${label}.${
      lastError instanceof Error ? ` Last error: ${lastError.message}` : ""
    }`
  );
};

export const smokePackagedRendererFaults = async ({
  executable,
  env,
  koedHome
}) => {
  const userDataDir = mkdtempSync(resolve(tmpdir(), "koed-renderer-faults-"));
  const debuggingPort =
    45_000 +
    [...userDataDir].reduce(
      (hash, character) => (hash * 33 + character.codePointAt(0)) % 10_000,
      0
    );
  const launchEnvironment = { ...env, KOED_HOME: koedHome };
  delete launchEnvironment.ELECTRON_RUN_AS_NODE;
  let stdoutTail = "";
  let stderrTail = "";
  let childExit;
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run"
    ],
    {
      env: launchEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout.on("data", (chunk) => {
    stdoutTail = appendOutputTail(stdoutTail, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrTail = appendOutputTail(stderrTail, chunk);
  });
  child.on("exit", (code, signal) => {
    childExit = { code, signal };
  });
  let cdp;
  try {
    let target;
    const startupDeadline = Date.now() + 30_000;
    while (Date.now() < startupDeadline && !childExit) {
      try {
        const targets = await fetch(
          `http://127.0.0.1:${debuggingPort}/json/list`
        ).then((response) => response.json());
        target = targets.find(
          (item) => item.type === "page" && item.webSocketDebuggerUrl
        );
        if (target) break;
      } catch {
        // The packaged Chromium endpoint is not listening yet.
      }
      await delay(50);
    }
    if (!target) {
      const exitDetail = childExit
        ? ` Electron exited with code ${String(childExit.code)} and signal ${String(childExit.signal)}.`
        : " Electron remained running.";
      const output = redactLaunchOutput(
        [stdoutTail, stderrTail].filter(Boolean).join("\n")
      );
      throw new Error(
        `Packaged renderer CDP target was unavailable after 30 seconds.${exitDetail}${
          output ? `\nPackaged Electron output:\n${output}` : ""
        }`
      );
    }
    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.call("Runtime.enable");
    const evaluate = async (expression) => {
      const response = await cdp.call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.exception?.description ??
            response.exceptionDetails.text
        );
      }
      return response.result.value;
    };
    const openProductChannel = async (suffix = "") => {
      const productControl = `[...document.querySelectorAll('.desktop-sidebar-nav-item')].find((item) => item.textContent?.trim() === 'product')`;
      await waitFor(
        evaluate,
        `Boolean(document.querySelector('[title="Electron Team App"]'))`,
        `Team control${suffix}`
      );
      await evaluate(
        `document.querySelector('[title="Electron Team App"]')?.click()`
      );
      await waitFor(
        evaluate,
        `Boolean(document.querySelector('.desktop-workspace-heading')) || Boolean(${productControl})`,
        `Workspace navigation${suffix}`
      );
      await evaluate(
        `if (!${productControl}) document.querySelector('.desktop-workspace-heading')?.click()`
      );
      await waitFor(
        evaluate,
        `Boolean(${productControl})`,
        `message channel control${suffix}`
      );
      await evaluate(`${productControl}?.click()`);
      await waitFor(
        evaluate,
        `Boolean(document.querySelector('textarea[aria-label="Message product"]'))`,
        `message channel${suffix}`
      );
    };
    const validationUrl =
      "koed://app/browser-validation.html?view=collaboration-interactions&actor=alice";
    await cdp.call("Page.navigate", { url: validationUrl });
    await waitFor(
      evaluate,
      `document.documentElement.dataset.browserValidationReady === "true" && Boolean(window.__koedCollaborationInteractions)`,
      "fault fixture"
    );
    await openProductChannel();

    const replayBody = "Packaged renderer replay sentinel";
    await evaluate(
      `window.__koedCollaborationInteractions.suspendAcknowledgements()`
    );
    await evaluate(
      `window.__koedCollaborationInteractions.emitMessage("channel", ${JSON.stringify(replayBody)}, "bob")`
    );
    await waitFor(
      evaluate,
      `document.body.innerText.includes(${JSON.stringify(replayBody)}) && window.__koedCollaborationInteractions.commands().some((item) => item.command === "collaboration.acknowledge_delivery")`,
      "application before suspended acknowledgement"
    );
    await cdp.call("Page.reload", { ignoreCache: true });
    await waitFor(
      evaluate,
      `document.documentElement.dataset.browserValidationReady === "true" && Boolean(window.__koedCollaborationInteractions)`,
      "renderer restart"
    );
    await openProductChannel(" after restart");
    await evaluate(
      `window.__koedCollaborationInteractions.emitMessage("channel", ${JSON.stringify(replayBody)}, "bob")`
    );
    await waitFor(
      evaluate,
      `[...document.querySelectorAll(".collab-message")].filter((item) => item.textContent?.includes(${JSON.stringify(replayBody)})).length === 1 && window.__koedCollaborationInteractions.commands().some((item) => item.command === "collaboration.acknowledge_delivery")`,
      "redelivery after renderer restart"
    );

    const accessibleText = `(() => {
      const attributes = ["aria-label", "aria-description", "title", "alt", "placeholder"];
      return [document.body.innerText, ...[...document.querySelectorAll("body *")].flatMap((node) =>
        attributes.map((name) => node.getAttribute(name) ?? "")
      )].join("\\n");
    })()`;
    const consoleText = () =>
      cdp.notifications
        .filter(
          (item) =>
            item.method === "Runtime.consoleAPICalled" ||
            item.method === "Runtime.exceptionThrown"
        )
        .map((item) => JSON.stringify(item.params))
        .join("\n");
    const assertRedacted = async (family, sentinels, expectedMessage) => {
      await waitFor(
        evaluate,
        `${accessibleText}.includes(${JSON.stringify(expectedMessage)})`,
        `${family} safe UI failure`
      );
      const exposed = `${await evaluate(accessibleText)}\n${consoleText()}`;
      for (const sentinel of sentinels) {
        if (exposed.includes(sentinel)) {
          throw new Error(
            `Packaged renderer exposed ${family} failure sentinel: ${sentinel}`
          );
        }
      }
    };
    cdp.notifications.length = 0;

    const apiSentinels = [
      "api-secret-7H2K",
      "API_STACK_FRAME_X91",
      "api_internal_01842",
      "https://api.private.invalid/v1/team",
      "set KOED_API_TOKEN=do-not-render"
    ];
    const privateDetail = apiSentinels.join(" | ");
    await evaluate(
      `window.__koedCollaborationInteractions.failNextApiRequest(${JSON.stringify(privateDetail)}); (() => { const input = document.querySelector('textarea[aria-label="Message product"]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; setter.call(input, "Packaged failure probe"); input.dispatchEvent(new Event("input", { bubbles: true })); })()`
    );
    await waitFor(
      evaluate,
      `document.querySelector('button[aria-label="Send message"]')?.disabled === false`,
      "enabled failure probe"
    );
    await evaluate(
      `document.querySelector('button[aria-label="Send message"]')?.click()`
    );
    await assertRedacted(
      "API",
      apiSentinels,
      "Collaboration is temporarily unavailable."
    );

    const brokerSentinels = [
      "broker-secret-4P8M",
      "BROKER_STACK_FRAME_B72",
      "broker_internal_77291",
      "wss://broker.private.invalid/socket",
      "run koed broker --unsafe-debug"
    ];
    await evaluate(
      `window.__koedCollaborationInteractions.failNextBrokerRequest(${JSON.stringify(brokerSentinels.join(" | "))}); document.querySelector('button[title="Cloud Memory Platform"]')?.click()`
    );
    await assertRedacted(
      "broker",
      brokerSentinels,
      "Collaboration is temporarily unavailable."
    );

    const enrollmentSentinels = [
      "enrollment-secret-2Q6V",
      "ENROLL_STACK_FRAME_E33",
      "device_internal_99012",
      "https://enroll.private.invalid/device",
      "set KOED_ENROLLMENT_KEY=do-not-render"
    ];
    await evaluate(
      `window.__koedCollaborationInteractions.failNextEnrollment(${JSON.stringify(enrollmentSentinels.join(" | "))}); document.querySelector('[aria-label="Preferences"]')?.click()`
    );
    await waitFor(
      evaluate,
      `[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Team Connection")`,
      "Team Connection preference"
    );
    await evaluate(
      `[...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Team Connection")?.click()`
    );
    await waitFor(
      evaluate,
      `Boolean(document.querySelector('.koed-connection-form input[type="url"]'))`,
      "Team Backend URL field"
    );
    await evaluate(
      `(() => { const input = document.querySelector('.koed-connection-form input[type="url"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; setter.call(input, "https://team.example.test"); input.dispatchEvent(new Event("input", { bubbles: true })); input.form.requestSubmit(); })()`
    );
    await assertRedacted(
      "enrollment",
      enrollmentSentinels,
      "Collaboration is temporarily unavailable."
    );

    const realtimeSentinels = [
      "realtime-secret-5N1R",
      "REALTIME_STACK_FRAME_R44",
      "delivery_internal_66103",
      "wss://realtime.private.invalid/events",
      "enable REALTIME_TRACE=private"
    ];
    await evaluate(
      `window.__koedCollaborationInteractions.emitRealtimeFailure(${JSON.stringify(realtimeSentinels.join(" | "))})`
    );
    await assertRedacted("realtime", realtimeSentinels, "Unavailable");
    return {
      crashAfterApplyBeforeAcknowledgement: true,
      redeliveryAppliedOnceAfterRestart: true,
      representativeUiFailuresRedacted: [
        "api",
        "broker",
        "enrollment",
        "realtime"
      ]
    };
  } finally {
    cdp?.close();
    if (!child.killed) child.kill("SIGTERM");
    rmSync(userDataDir, { recursive: true, force: true });
  }
};
