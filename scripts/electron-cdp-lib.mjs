/* global document, HTMLElement, HTMLInputElement, HTMLTextAreaElement, MutationObserver, window */

import { writeFile } from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 30_000;

const withTimeout = (promise, timeoutMs, message) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

export const selectElectronPageTarget = (targets) => {
  const pages = targets.filter((target) => target?.type === "page");
  return (
    pages.find((target) => target.url === "koed://app/") ??
    pages.find((target) => target.title === "Koed") ??
    pages[0] ??
    null
  );
};

export const functionExpression = (fn, args = []) =>
  `(${fn.toString()})(...${JSON.stringify(args)})`;

export const connectElectronCdp = async ({
  port,
  host = "127.0.0.1",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket
}) => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Electron CDP port must be a valid TCP port.");
  }
  if (typeof fetchImpl !== "function" || typeof WebSocketImpl !== "function") {
    throw new Error("Electron CDP requires fetch and WebSocket support.");
  }

  const targetResponse = await withTimeout(
    fetchImpl(`http://${host}:${port}/json/list`),
    timeoutMs,
    `Electron CDP target discovery timed out on ${host}:${port}.`
  );
  if (!targetResponse.ok) {
    throw new Error(
      `Electron CDP target discovery failed with HTTP ${targetResponse.status}.`
    );
  }
  const target = selectElectronPageTarget(await targetResponse.json());
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No Koed Electron page target found on ${host}:${port}.`);
  }

  const socket = new WebSocketImpl(target.webSocketDebuggerUrl);
  await withTimeout(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    timeoutMs,
    `Electron CDP websocket timed out on ${host}:${port}.`
  );

  let requestId = 0;
  const pending = new Map();
  const consoleEvents = [];
  const runtimeExceptions = [];
  const networkFailures = [];
  const protocolEventWaiters = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        request.reject(
          new Error(
            `Electron CDP ${request.method} failed: ${message.error.message}`
          )
        );
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      consoleEvents.push(message.params);
    } else if (message.method === "Runtime.exceptionThrown") {
      runtimeExceptions.push(message.params);
    } else if (message.method === "Network.loadingFailed") {
      networkFailures.push(message.params);
    }
    const waiters = protocolEventWaiters.get(message.method);
    if (waiters) {
      protocolEventWaiters.delete(message.method);
      for (const waiter of waiters) waiter(message.params);
    }
  });

  const send = (method, params = {}, requestTimeoutMs = timeoutMs) =>
    withTimeout(
      new Promise((resolve, reject) => {
        const id = ++requestId;
        pending.set(id, { resolve, reject, method });
        socket.send(JSON.stringify({ id, method, params }));
      }),
      requestTimeoutMs,
      `Electron CDP ${method} timed out on ${host}:${port}.`
    );

  await Promise.all([
    send("Runtime.enable"),
    send("Network.enable"),
    send("Page.enable")
  ]);

  const waitForProtocolEvent = (method, eventTimeoutMs = timeoutMs) =>
    withTimeout(
      new Promise((resolve) => {
        const waiters = protocolEventWaiters.get(method) ?? [];
        waiters.push(resolve);
        protocolEventWaiters.set(method, waiters);
      }),
      eventTimeoutMs,
      `Electron CDP ${method} event timed out on ${host}:${port}.`
    );

  const evaluate = async (
    fn,
    args = [],
    { awaitPromise = true, evaluationTimeoutMs = timeoutMs } = {}
  ) => {
    const result = await send(
      "Runtime.evaluate",
      {
        expression: functionExpression(fn, args),
        awaitPromise,
        returnByValue: true
      },
      evaluationTimeoutMs
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "Electron renderer evaluation failed."
      );
    }
    return result.result?.value;
  };

  return {
    target,
    evaluate,
    cookies: async (urls) =>
      (await send("Network.getCookies", { urls })).cookies ?? [],
    reload: async (reloadTimeoutMs = timeoutMs) => {
      await send("Page.enable");
      const loaded = waitForProtocolEvent(
        "Page.loadEventFired",
        reloadTimeoutMs
      );
      await send("Page.reload", { ignoreCache: true });
      await loaded;
    },
    bodyText: () => evaluate(() => document.body.innerText),
    clickButton: (label, occurrence = "first") =>
      evaluate(
        (expectedLabel, expectedOccurrence) => {
          const buttons = [...document.querySelectorAll("button")].filter(
            (button) => button.textContent?.trim() === expectedLabel
          );
          const button =
            expectedOccurrence === "last"
              ? buttons.at(-1)
              : buttons.at(Number(expectedOccurrence) || 0);
          if (!button || button.disabled) {
            return {
              clicked: false,
              matchingButtons: buttons.length,
              disabled: button?.disabled ?? null
            };
          }
          button.click();
          return { clicked: true, matchingButtons: buttons.length };
        },
        [label, occurrence]
      ),
    clickAriaLabel: (label) =>
      evaluate(
        (expectedLabel) => {
          const element = [...document.querySelectorAll("[aria-label]")].find(
            (candidate) =>
              candidate.getAttribute("aria-label") === expectedLabel
          );
          if (
            !(element instanceof HTMLElement) ||
            element.ariaDisabled === "true"
          ) {
            return false;
          }
          element.click();
          return true;
        },
        [label]
      ),
    fillAriaLabel: (label, value) =>
      evaluate(
        (expectedLabel, nextValue) => {
          const element = [...document.querySelectorAll("[aria-label]")].find(
            (candidate) =>
              candidate.getAttribute("aria-label") === expectedLabel
          );
          if (
            !(element instanceof HTMLInputElement) &&
            !(element instanceof HTMLTextAreaElement)
          ) {
            return false;
          }
          const prototype =
            element instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(
            element,
            nextValue
          );
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        },
        [label, value]
      ),
    waitForCollaborationEvent: (
      predicate,
      args = [],
      waitTimeoutMs = timeoutMs
    ) =>
      evaluate(
        (predicateSource, predicateArgs, rendererTimeoutMs) =>
          new Promise((resolve, reject) => {
            const matches = new Function("return (" + predicateSource + ")")();
            const unsubscribe = window.koedDesktop?.collaboration?.subscribe(
              (event) => {
                if (!matches(event, ...predicateArgs)) return;
                clearTimeout(timer);
                unsubscribe();
                resolve(event);
              }
            );
            if (!unsubscribe) {
              reject(
                new Error("Koed collaboration renderer bridge is unavailable.")
              );
              return;
            }
            const timer = setTimeout(() => {
              unsubscribe();
              reject(
                new Error("Electron collaboration event condition timed out.")
              );
            }, rendererTimeoutMs);
          }),
        [predicate.toString(), args, waitTimeoutMs],
        {
          awaitPromise: true,
          evaluationTimeoutMs: waitTimeoutMs + 2_000
        }
      ),
    waitForBody: (predicate, args = [], waitTimeoutMs = timeoutMs) =>
      evaluate(
        (predicateSource, predicateArgs, rendererTimeoutMs) =>
          new Promise((resolve, reject) => {
            const matches = new Function("return (" + predicateSource + ")")();
            const inspect = () =>
              matches(document.body.innerText, ...predicateArgs);
            if (inspect()) {
              resolve(document.body.innerText);
              return;
            }
            const observer = new MutationObserver(() => {
              if (!inspect()) return;
              observer.disconnect();
              clearTimeout(timer);
              resolve(document.body.innerText);
            });
            const timer = setTimeout(() => {
              observer.disconnect();
              reject(new Error("Electron renderer condition timed out."));
            }, rendererTimeoutMs);
            observer.observe(document.body, {
              subtree: true,
              childList: true,
              characterData: true,
              attributes: true
            });
          }),
        [predicate.toString(), args, waitTimeoutMs],
        {
          awaitPromise: true,
          evaluationTimeoutMs: waitTimeoutMs + 2_000
        }
      ),
    waitForJavaScriptDialog: (waitTimeoutMs = timeoutMs) =>
      waitForProtocolEvent("Page.javascriptDialogOpening", waitTimeoutMs),
    handleJavaScriptDialog: (accept) =>
      send("Page.handleJavaScriptDialog", { accept }),
    screenshot: async (path) => {
      const result = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true
      });
      await writeFile(path, Buffer.from(result.data, "base64"));
      return path;
    },
    diagnostics: () => ({
      consoleEvents: [...consoleEvents],
      runtimeExceptions: [...runtimeExceptions],
      networkFailures: [...networkFailures]
    }),
    close: () => {
      for (const request of pending.values()) {
        request.reject(new Error("Electron CDP connection closed."));
      }
      pending.clear();
      protocolEventWaiters.clear();
      socket.close();
    }
  };
};

export const ensureKoedElectronSetup = async (
  client,
  { timeoutMs = 180_000 } = {}
) => {
  let changed = false;
  const hasApplicationShell = () =>
    client.evaluate(
      () => document.querySelector('[aria-label="Koed scopes"]') !== null
    );
  const continueFromReady = async () => {
    const result = await client.clickButton("Continue");
    if (!result.clicked) {
      throw new Error("Could not continue from completed Koed setup.");
    }
    changed = true;
  };

  if (await hasApplicationShell()) {
    return { changed, state: "ready" };
  }

  await client.waitForBody(
    (text) =>
      document.querySelector('[aria-label="Koed scopes"]') !== null ||
      text.includes("Set up Koed") ||
      text.includes("Koed is ready") ||
      text.includes("How Koed handles your Memory"),
    [],
    10_000
  );
  if (await hasApplicationShell()) {
    return { changed, state: "ready" };
  }

  let currentText = await client.bodyText();
  if (currentText.includes("Koed is ready")) {
    await continueFromReady();
  } else if (!currentText.includes("How Koed handles your Memory")) {
    const opened = await client.clickButton("Set up Koed", "first");
    if (!opened.clicked) {
      throw new Error("Could not open the Koed setup confirmation.");
    }
    await client.waitForBody(
      (text) => text.includes("Set up Koed on this computer?"),
      [],
      10_000
    );
    const confirmed = await client.clickButton("Set up Koed", "last");
    if (!confirmed.clicked) {
      throw new Error("Could not confirm Koed setup.");
    }
    const setupResult = await client.waitForBody(
      (text) =>
        text.includes("How Koed handles your Memory") ||
        text.includes("Setup failed") ||
        text.includes("Koed is ready"),
      [],
      timeoutMs
    );
    if (setupResult.includes("Setup failed")) {
      throw new Error("Koed Electron setup reported failure.");
    }
    if (setupResult.includes("Koed is ready")) {
      await continueFromReady();
    }
    changed = true;
  }

  await client.waitForBody(
    (text) =>
      text.includes("How Koed handles your Memory") ||
      document.querySelector('[aria-label="Koed scopes"]') !== null,
    [],
    10_000
  );
  currentText = await client.bodyText();
  if (currentText.includes("How Koed handles your Memory")) {
    const currentStep = Number(currentText.match(/(\d+) of 5/)?.[1] ?? "1");
    for (let lesson = currentStep + 1; lesson <= 5; lesson += 1) {
      const next = await client.clickButton("Next");
      if (!next.clicked) {
        throw new Error(
          `Could not advance Koed trust guidance to step ${lesson}.`
        );
      }
      await client.waitForBody(
        (text, step) => text.includes(`${step} of 5`),
        [lesson],
        10_000
      );
    }
    const finish = await client.clickButton("Finish");
    if (!finish.clicked) {
      throw new Error("Could not complete Koed trust guidance.");
    }
    changed = true;
  }

  await client.waitForBody(
    () => document.querySelector('[aria-label="Koed scopes"]') !== null,
    [],
    timeoutMs
  );
  return { changed, state: "ready" };
};
