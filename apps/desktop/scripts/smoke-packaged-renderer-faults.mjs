/* global AbortSignal, clearTimeout, console, fetch, setTimeout, WebSocket */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const delay = (ms) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const childExited = (child) =>
  child.exitCode !== null || child.signalCode !== null;

const waitForChildExit = (child, timeoutMs) => {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    function finish(exited) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    }
    function onExit() {
      finish(true);
    }
    const timer = setTimeout(
      () => finish(childExited(child)),
      Math.max(1, timeoutMs)
    );
    child.once("exit", onExit);
    if (childExited(child)) finish(true);
  });
};

export const terminateChild = async (child, graceMs = 2_000) => {
  if (childExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, graceMs)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, graceMs))) {
    throw new Error("Packaged Electron did not exit after SIGKILL.");
  }
};

export const waitForRendererTarget = async ({
  debuggingPort,
  readChildExit,
  startupTimeoutMs = 30_000,
  requestTimeoutMs = 1_000,
  fetchImpl = fetch,
  now = Date.now,
  delayImpl = delay
}) => {
  const startupDeadline = now() + startupTimeoutMs;
  while (now() < startupDeadline && !readChildExit()) {
    const remainingMs = startupDeadline - now();
    try {
      const targets = await fetchImpl(
        `http://127.0.0.1:${debuggingPort}/json/list`,
        {
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(requestTimeoutMs, remainingMs))
          )
        }
      ).then((response) => response.json());
      const target = targets.find(
        (item) => item.type === "page" && item.webSocketDebuggerUrl
      );
      if (target) return target;
    } catch {
      // Chromium may not be listening yet, or a request may reach its bounded
      // timeout while the renderer starts.
    }
    const delayMs = Math.min(50, startupDeadline - now());
    if (delayMs > 0) await delayImpl(delayMs);
  }
  return undefined;
};

const appendOutputTail = (current, chunk) =>
  `${current}${String(chunk)}`.slice(-32_768);

export const redactLaunchOutput = (value) =>
  value
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:cmt|cms)_[A-Za-z0-9_-]+/gu, "[REDACTED_CREDENTIAL]")
    .replace(/\b(KOED_[A-Z0-9_]*(?:KEY|SECRET|TOKEN))=\S+/gu, "$1=[REDACTED]");

export const connect = (url) =>
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
            const callTimer = setTimeout(() => {
              pending.delete(id);
              rejectCall(
                new Error(`Packaged renderer CDP ${method} call timed out.`)
              );
            }, 15_000);
            pending.set(id, {
              resolve: resolveCall,
              reject: rejectCall,
              timer: callTimer
            });
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
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });
  });

const waitFor = async (
  evaluate,
  expression,
  label,
  diagnosticExpression = undefined
) => {
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
  let diagnostic = "";
  if (diagnosticExpression) {
    try {
      diagnostic = ` Diagnostic: ${JSON.stringify(
        await evaluate(diagnosticExpression)
      )}`;
    } catch (error) {
      diagnostic = ` Diagnostic collection failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  throw new Error(
    `Timed out waiting for packaged renderer ${label}.${
      lastError instanceof Error ? ` Last error: ${lastError.message}` : ""
    }${diagnostic}`
  );
};

export const trustedClick = async ({ cdp, evaluate, locator }) => {
  await cdp.call("Page.bringToFront");
  const center = await evaluate(`(() => {
    const element = (${locator});
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0
      ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
      : null;
  })()`);
  if (!center) {
    throw new Error(
      `Packaged renderer element was not interactable: ${locator}`
    );
  }
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: center.x,
    y: center.y
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: center.x,
    y: center.y,
    button: "left",
    clickCount: 1
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: center.x,
    y: center.y,
    button: "left",
    clickCount: 1
  });
};

const smokeHqFixture = async ({ cdp, evaluate }) => {
  const ready = `document.documentElement.dataset.browserValidationReady === "true" && Boolean(window.__koedCollaborationInteractions) && Boolean(window.__koedPackagedHqClient?.current()?.navigation?.teams?.length) && Boolean(document.querySelector('[data-hq-shell]'))`;
  await waitFor(evaluate, ready, "HQ fault fixture");
  await waitFor(
    evaluate,
    `Boolean(document.querySelector('.hq-sidebar')) && Boolean(document.querySelector('button.hq-account'))`,
    "HQ sidebar and account navigation",
    `(() => ({
      shell: Boolean(document.querySelector('[data-hq-shell]')),
      onboarding: Boolean(document.querySelector('.hq-onboarding')),
      sidebar: Boolean(document.querySelector('.hq-sidebar')),
      account: Boolean(document.querySelector('button.hq-account')),
      body: document.body.innerText.slice(0, 1000)
    }))()`
  );
  await evaluate(`document.querySelector('button.hq-account').click()`);
  await waitFor(
    evaluate,
    `Boolean(document.querySelector('.hq-settings'))`,
    "HQ Settings navigation"
  );
  await evaluate(
    `document.querySelector('.hq-settings [aria-label="Close Settings"]').click()`
  );
  await waitFor(
    evaluate,
    `!document.querySelector('.hq-settings')`,
    "HQ Settings return"
  );
  const shares = await evaluate(
    `window.__koedPackagedHqClient.listOwnedShares({cursor:null})`
  );
  if (!Array.isArray(shares?.shares) || shares.shares.length < 2)
    throw new Error(
      `HQ packaged owner-wide share read failed: ${JSON.stringify(shares)}`
    );
  const ownerShareControls = await evaluate(`(async () => {
    const client = window.__koedPackagedHqClient;
    const initial = await client.listOwnedShares({cursor:null});
    const pending = initial.shares.find((item)=>item.kind==='pending' && item.pendingShare.mode==='continuous');
    const active = initial.shares.find((item)=>item.kind==='grant' && item.grant.lifecycle==='active');
    if (!pending || !active) throw new Error('Owner-wide pending and active Shares are required');
    const paused = await client.controlPendingShare({pendingShareId:pending.pendingShare.id,expectedOperationVersion:pending.pendingShare.operationVersion,action:'pause'});
    const pausedRead = await client.listOwnedShares({cursor:null});
    const resume = await client.controlPendingShare({pendingShareId:pending.pendingShare.id,expectedOperationVersion:paused.operationVersion,action:'resume'});
    const resumedRead = await client.listOwnedShares({cursor:null});
    const grant = active.grant;
    const revoke = () => client.revokeSharedMemory({mutationId:crypto.randomUUID(),teamId:grant.teamId,workspaceId:grant.workspaceId,shareGrantId:grant.id,expectedGrantVersion:grant.grantVersion,reasonCode:'owner_revoked'});
    window.__koedPackagedHqNativeReview.approved = false;
    const commandsBeforeCancel = window.__koedCollaborationInteractions.commands().filter((item)=>item.command==='collaboration.revoke_shared_memory').length;
    const canceled = await revoke().then(()=>false,()=>true);
    const commandsAfterCancel = window.__koedCollaborationInteractions.commands().filter((item)=>item.command==='collaboration.revoke_shared_memory').length;
    const afterCancel = await client.listOwnedShares({cursor:null});
    window.__koedPackagedHqNativeReview.approved = true;
    const revoked = await revoke();
    const afterRevoke = await client.listOwnedShares({cursor:null});
    return {
      paused:paused.sourceUpdateState,
      pausedRead:pausedRead.shares.find((item)=>item.kind==='pending' && item.pendingShare.id===pending.pendingShare.id)?.pendingShare.sourceUpdateState,
      resumed:resume.sourceUpdateState,
      resumedRead:resumedRead.shares.find((item)=>item.kind==='pending' && item.pendingShare.id===pending.pendingShare.id)?.pendingShare.sourceUpdateState,
      canceled,commandsBeforeCancel,commandsAfterCancel,
      activeAfterCancel:afterCancel.shares.some((item)=>item.kind==='grant' && item.grant.id===grant.id && item.grant.lifecycle==='active'),
      revoked:revoked.lifecycle,
      revokedInOwnerRead:!afterRevoke.shares.some((item)=>item.kind==='grant' && item.grant.id===grant.id && item.grant.lifecycle==='active'),
      revokeCommands:window.__koedCollaborationInteractions.commands().filter((item)=>item.command==='collaboration.revoke_shared_memory').length
    };
  })()`);
  if (
    ownerShareControls.paused !== "paused" ||
    ownerShareControls.pausedRead !== "paused" ||
    ownerShareControls.resumed !== "active" ||
    ownerShareControls.resumedRead !== "active" ||
    !ownerShareControls.canceled ||
    ownerShareControls.commandsBeforeCancel !==
      ownerShareControls.commandsAfterCancel ||
    !ownerShareControls.activeAfterCancel ||
    ownerShareControls.revoked !== "revoked" ||
    !ownerShareControls.revokedInOwnerRead ||
    ownerShareControls.revokeCommands !==
      ownerShareControls.commandsAfterCancel + 1
  )
    throw new Error(
      `HQ owner Share controls failed: ${JSON.stringify(ownerShareControls)}`
    );

  const selectChannel = `(() => {
    const team = window.__koedPackagedHqClient.current().navigation.teams[0];
    const workspace = team.workspaces[0];
    const channel = workspace.channels[0];
    if (!channel) throw new Error('HQ packaged channel fixture missing');
    return window.__koedPackagedHqClient.select({kind:'workspace_channel',teamId:team.id,workspaceId:workspace.id,threadId:channel.id});
  })()`;
  await evaluate(selectChannel);
  const replayBody = "Packaged HQ renderer replay sentinel";
  await evaluate(
    `window.__koedCollaborationInteractions.suspendAcknowledgements()`
  );
  await evaluate(
    `window.__koedCollaborationInteractions.emitMessage('channel', ${JSON.stringify(replayBody)}, 'bob')`
  );
  await waitFor(
    evaluate,
    `window.__koedCollaborationInteractions.commands().some((item) => item.command === 'collaboration.acknowledge_delivery')`,
    "HQ acknowledgement before renderer restart"
  );
  await cdp.call("Page.reload", { ignoreCache: true });
  await waitFor(evaluate, ready, "HQ fixture after renderer restart");
  await evaluate(selectChannel);
  await evaluate(
    `window.__koedCollaborationInteractions.emitMessage('channel', ${JSON.stringify(replayBody)}, 'bob')`
  );
  await waitFor(
    evaluate,
    `window.__koedCollaborationInteractions.commands().some((item) => item.command === 'collaboration.acknowledge_delivery')`,
    "HQ acknowledgement after renderer restart"
  );
  const replay = await evaluate(`(() => ({
    matches: window.__koedPackagedHqClient.current().view?.messages?.items?.filter((item) => item.body === ${JSON.stringify(replayBody)}).length ?? 0,
    acknowledgements: window.__koedCollaborationInteractions.commands().filter((item) => item.command === 'collaboration.acknowledge_delivery').length
  }))()`);
  if (replay.matches !== 1 || replay.acknowledgements < 1)
    throw new Error(
      `HQ replay was not applied exactly once: ${JSON.stringify(replay)}`
    );

  const accessibleText = `(() => {
    const attributes = ['aria-label','aria-description','title','alt','placeholder'];
    return [document.body.innerText,...[...document.querySelectorAll('body *')].flatMap((node)=>attributes.map((name)=>node.getAttribute(name)??''))].join('\\n');
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
  const failAndAssertRedacted = async ({ family, sentinels, expression }) => {
    const outcome = await evaluate(expression);
    if (
      outcome?.name !== "CollaborationClientError" ||
      outcome?.message !== "Collaboration is temporarily unavailable."
    )
      throw new Error(
        `${family} did not return the production safe failure: ${JSON.stringify(outcome)}`
      );
    const exposed = `${await evaluate(accessibleText)}\n${consoleText()}\n${JSON.stringify(outcome)}`;
    for (const sentinel of sentinels)
      if (exposed.includes(sentinel))
        throw new Error(
          `HQ packaged ${family} leaked private failure sentinel: ${sentinel}`
        );
  };
  cdp.notifications.length = 0;
  const apiSentinels = [
    "api-secret-7H2K",
    "API_STACK_FRAME_X91",
    "api_internal_01842",
    "https://api.private.invalid/v1/team",
    "set KOED_API_TOKEN=do-not-render"
  ];
  await failAndAssertRedacted({
    family: "API",
    sentinels: apiSentinels,
    expression: `(() => {
      window.__koedCollaborationInteractions.failNextApiRequest(${JSON.stringify(apiSentinels.join(" | "))});
      const team = window.__koedPackagedHqClient.current().navigation.teams[0];
      const thread = team.workspaces[0].channels[0];
      return window.__koedPackagedHqClient.sendMessage({thread:{scope:'team',teamId:team.id,threadId:thread.id},clientMessageId:crypto.randomUUID(),body:'Packaged HQ failure probe'}).then(()=>({name:'success'})).catch((error)=>({name:error.name,message:error.message}));
    })()`
  });
  const brokerSentinels = [
    "broker-secret-4P8M",
    "BROKER_STACK_FRAME_B72",
    "broker_internal_77291",
    "wss://broker.private.invalid/socket",
    "run koed broker --unsafe-debug"
  ];
  await failAndAssertRedacted({
    family: "broker",
    sentinels: brokerSentinels,
    expression: `(() => {
      window.__koedCollaborationInteractions.failNextBrokerRequest(${JSON.stringify(brokerSentinels.join(" | "))});
      const team = window.__koedPackagedHqClient.current().navigation.teams[0];
      return window.__koedPackagedHqClient.select({kind:'team_people',teamId:team.id}).then(()=>({name:'success'})).catch((error)=>({name:error.name,message:error.message}));
    })()`
  });
  const enrollmentSentinels = [
    "enrollment-secret-2Q6V",
    "ENROLL_STACK_FRAME_E33",
    "device_internal_99012",
    "https://enroll.private.invalid/device",
    "set KOED_ENROLLMENT_KEY=do-not-render"
  ];
  await failAndAssertRedacted({
    family: "enrollment",
    sentinels: enrollmentSentinels,
    expression: `(() => {
      window.__koedCollaborationInteractions.failNextEnrollment(${JSON.stringify(enrollmentSentinels.join(" | "))});
      return window.__koedPackagedHqClient.connectRemote({remoteUrl:'https://team.example.test'}).then(()=>({name:'success'})).catch((error)=>({name:error.name,message:error.message}));
    })()`
  });
  await evaluate(`document.querySelector('button.hq-account').click()`);
  await waitFor(
    evaluate,
    `Boolean(document.querySelector('.hq-settings'))`,
    "HQ Settings before Team enrollment"
  );
  await evaluate(`(() => {
    const teams = [...document.querySelectorAll('.hq-settings nav button')].find((item)=>item.textContent?.trim()==='Teams');
    if (!teams) throw new Error('HQ Teams settings navigation unavailable');
    teams.click();
  })()`);
  await waitFor(
    evaluate,
    `Boolean(document.querySelector('.hq-settings #hq-team-url'))`,
    "HQ Team Connection form"
  );
  await evaluate(`(() => {
    window.__koedCollaborationInteractions.failNextEnrollment(${JSON.stringify(enrollmentSentinels.join(" | "))});
    const input = document.querySelector('.hq-settings #hq-team-url');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(input,'https://team.example.test');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await waitFor(
    evaluate,
    `document.querySelector('.hq-settings #hq-team-url')?.value === 'https://team.example.test'`,
    "HQ Team Connection input"
  );
  await evaluate(
    `document.querySelector('.hq-settings #hq-team-url').form.requestSubmit()`
  );
  await waitFor(
    evaluate,
    `[...document.querySelectorAll('.hq-settings [role="alert"]')].some((node)=>node.textContent?.includes('Collaboration is temporarily unavailable.'))`,
    "HQ Team Connection safe error"
  );
  const enrollmentExposed = `${await evaluate(accessibleText)}\n${consoleText()}`;
  for (const sentinel of enrollmentSentinels)
    if (enrollmentExposed.includes(sentinel))
      throw new Error(
        `HQ Team Connection leaked private failure sentinel: ${sentinel}`
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
  await waitFor(
    evaluate,
    `window.__koedPackagedHqClient.current()?.connection?.state === 'unavailable'`,
    "HQ production client realtime unavailable state"
  );
  await waitFor(
    evaluate,
    `[...document.querySelectorAll('.hq-settings [role="status"]')].some((node)=>node.textContent?.trim()==='unavailable')`,
    "HQ Team Connection unavailable state"
  );
  await cdp.call("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  await waitFor(
    evaluate,
    `matchMedia('(prefers-reduced-motion: reduce)').matches && Number.parseFloat(getComputedStyle(document.querySelector('.hq-settings__rail nav button')).transitionDuration) <= 0.001`,
    "HQ Settings reduced motion"
  );
  const exposed = `${await evaluate(accessibleText)}\n${consoleText()}`;
  for (const sentinel of realtimeSentinels)
    if (exposed.includes(sentinel))
      throw new Error(
        `HQ packaged realtime leaked private failure sentinel: ${sentinel}`
      );
  return {
    hqNavigation: true,
    preferencesNavigation: true,
    teamEnrollmentSafeUi: true,
    realtimeUnavailableSafeUi: true,
    hqSettingsReducedMotion: true,
    ownerWideSharesRead: shares.shares.length,
    ownerShareAuthorityControls: true,
    ownerSharePresentation:
      "HQ fixture validates client authority; HQ sharing UI is covered by the separate HQ validators",
    crashAfterApplyBeforeAcknowledgement: true,
    redeliveryAppliedOnceAfterRestart: true,
    representativeFailuresRedacted: ["api", "broker", "enrollment", "realtime"]
  };
};

export const smokePackagedRendererFaults = async ({
  executable,
  env,
  koedHome,
  hqMode = false
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
    const target = await waitForRendererTarget({
      debuggingPort,
      readChildExit: () => childExit
    });
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
    await cdp.call("Page.enable");
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
    if (hqMode) {
      await cdp.call("Page.navigate", {
        url: "koed://app/browser-validation.html?view=collaboration-interactions&actor=alice&packagedHqFaults=yes"
      });
      return await smokeHqFixture({ cdp, evaluate });
    }
    console.error("[packaged-renderer] setup surface started");
    await waitFor(
      evaluate,
      `document.querySelector('.koed-setup-card h1')?.textContent?.trim() === 'Set up Koed'`,
      "setup surface",
      `(() => ({
        title: document.querySelector('h1')?.textContent ?? null,
        body: document.body.innerText.slice(0, 1000)
      }))()`
    );
    console.error("[packaged-renderer] setup surface finished");
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
    console.error("[packaged-renderer] collaboration fixture started");
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
    console.error("[packaged-renderer] collaboration fixture finished");

    console.error("[packaged-renderer] Personal Memory navigation started");
    await evaluate(
      `document.querySelector('[aria-label="Personal"]')?.click()`
    );
    await waitFor(
      evaluate,
      `[...document.querySelectorAll('.desktop-sidebar-nav-item')].some((item) => item.textContent?.trim() === 'Projects')`,
      "Personal Projects navigation"
    );
    await evaluate(
      `[...document.querySelectorAll('.desktop-sidebar-nav-item')].find((item) => item.textContent?.trim() === 'Projects')?.click()`
    );
    await waitFor(
      evaluate,
      `Boolean(document.querySelector('.personal-memory-workspace [data-project-id="browser-project"]'))`,
      "Personal Memory Projects surface"
    );
    await evaluate(
      `document.querySelector('[data-project-id="browser-project"]')?.click()`
    );
    await waitFor(
      evaluate,
      `Boolean(document.querySelector('[data-session-id] .personal-session-row-select'))`,
      "Personal Memory Captured Session list"
    );
    await evaluate(
      `document.querySelector('[data-session-id] .personal-session-row-select')?.click()`
    );
    await waitFor(
      evaluate,
      `document.querySelectorAll('.native-event-wrap').length > 0 && document.body.innerText.includes('Browser validation Memory Event')`,
      "Personal Memory Captured Session timeline"
    );
    console.error("[packaged-renderer] Personal Memory navigation finished");
    await evaluate(
      `document.querySelector('[aria-label="Personal"]')?.click()`
    );
    await waitFor(
      evaluate,
      `[...document.querySelectorAll('.desktop-sidebar-nav-item')].some((item) => item.textContent?.trim() === 'Shares')`,
      "Personal Shares navigation"
    );
    await evaluate(
      `[...document.querySelectorAll('.desktop-sidebar-nav-item')].find((item) => item.textContent?.trim() === 'Shares')?.click()`
    );
    await waitFor(
      evaluate,
      `document.body.innerText.includes('Packaged asynchronous sharing') && document.body.innerText.includes('Packaged revocation fixture')`,
      "owner-wide Shares surface"
    );
    await evaluate(
      `(() => { const card = [...document.querySelectorAll('.collab-share-row')].find((item) => item.textContent?.includes('Packaged asynchronous sharing')); card?.focus(); card?.click(); })()`
    );
    await waitFor(
      evaluate,
      `document.querySelector('.collab-share-detail-workspace')?.textContent?.includes('Packaged asynchronous sharing')`,
      "continuous Share selection"
    );
    await evaluate(
      `(() => { const button = document.querySelector('.collab-share-detail-workspace .collab-share-modify-button'); button?.focus(); button?.click(); })()`
    );
    await waitFor(
      evaluate,
      `[...document.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Pause updates')`,
      "Shares Modify controls"
    );
    await trustedClick({
      cdp,
      evaluate,
      locator: `[...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Pause updates')`
    });
    await waitFor(
      evaluate,
      `[...document.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Resume updates') && document.querySelector('.collab-share-detail-workspace')?.textContent?.includes('Packaged asynchronous sharing')`,
      "Shares pause state",
      `(() => ({
        activeElement: document.activeElement?.outerHTML ?? null,
        pauseButton: [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Pause updates')?.outerHTML ?? null,
        resumeButton: [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Resume updates')?.outerHTML ?? null,
        detailText: document.querySelector('.collab-share-detail-workspace')?.textContent ?? null
      }))()`
    );
    await waitFor(
      evaluate,
      `document.activeElement?.textContent?.trim() === 'Resume updates'`,
      "stable Shares focus",
      `(() => ({
        hasFocus: document.hasFocus(),
        visibilityState: document.visibilityState,
        activeElement: document.activeElement?.outerHTML ?? null,
        resumeButton: [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Resume updates')?.outerHTML ?? null
      }))()`
    );
    await evaluate(
      `[...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Done')?.click()`
    );
    await evaluate(
      `(() => { const card = [...document.querySelectorAll('.collab-share-row')].find((item) => item.textContent?.includes('Packaged revocation fixture')); card?.focus(); card?.click(); window.__koedCollaborationInteractions.emitPendingShareNeedsAttention(); })()`
    );
    await waitFor(
      evaluate,
      `document.activeElement?.textContent?.includes('Packaged revocation fixture') && document.querySelector('.collab-share-detail-workspace')?.textContent?.includes('Packaged revocation fixture') && [...document.querySelectorAll('[role="status"][aria-live="polite"]')].some((item) => item.textContent?.includes('Packaged asynchronous sharing: Update needs attention'))`,
      "packaged Shares live announcement"
    );
    await cdp.call("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-reduced-motion", value: "reduce" }]
    });
    await waitFor(
      evaluate,
      `matchMedia('(prefers-reduced-motion: reduce)').matches && Number.parseFloat(getComputedStyle(document.querySelector('.collab-share-row')).transitionDuration) <= 0.001`,
      "packaged Shares reduced motion"
    );
    await evaluate(
      `[...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Revoke')?.click()`
    );
    await waitFor(
      evaluate,
      `document.body.innerText.includes('Your Personal Memory will not be deleted.')`,
      "packaged Shares destructive confirmation"
    );
    await evaluate(
      `[...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Cancel')?.click()`
    );
    await waitFor(
      evaluate,
      `!document.body.innerText.includes('Your Personal Memory will not be deleted.') && !window.__koedCollaborationInteractions.commands().some((item) => item.command === 'collaboration.revoke_shared_memory')`,
      "packaged Shares canceled destructive confirmation"
    );
    await evaluate(
      `[...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Revoke')?.click()`
    );
    await evaluate(
      `[...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Revoke Share')?.click()`
    );
    await waitFor(
      evaluate,
      `[...document.querySelectorAll('.collab-share-section')].some((item) => item.querySelector('h2')?.textContent?.trim() === 'Revoked' && item.textContent?.includes('Packaged revocation fixture')) && window.__koedCollaborationInteractions.commands().some((item) => item.command === 'collaboration.revoke_shared_memory')`,
      "packaged Shares confirmed revocation"
    );
    console.error("[packaged-renderer] Personal Shares finished");
    await openProductChannel(" after Shares validation");

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
    console.error("[packaged-renderer] redacted failure checks started");

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
      `[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Teams")`,
      "Teams preference"
    );
    await evaluate(
      `[...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Teams")?.click()`
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
    console.error("[packaged-renderer] redacted failure checks finished");
    return {
      setupSurface: true,
      personalMemoryNavigation: true,
      preferencesNavigation: true,
      crashAfterApplyBeforeAcknowledgement: true,
      redeliveryAppliedOnceAfterRestart: true,
      ownerWideSharesAccessibility: true,
      representativeUiFailuresRedacted: [
        "api",
        "broker",
        "enrollment",
        "realtime"
      ]
    };
  } finally {
    cdp?.close();
    await terminateChild(child);
    // Electron's own helper/GPU processes can briefly outlive the main
    // process and still hold file handles in userDataDir, racing this
    // recursive delete with ENOTEMPTY; retry to absorb that.
    rmSync(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200
    });
  }
};
