import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureKoedElectronSetup,
  functionExpression,
  selectElectronPageTarget
} from "./electron-cdp-lib.mjs";

test("selectElectronPageTarget prefers the Koed application page", () => {
  assert.deepEqual(
    selectElectronPageTarget([
      { type: "page", title: "Other", url: "https://example.test" },
      {
        type: "page",
        title: "Koed",
        url: "koed://app/",
        webSocketDebuggerUrl: "ws://koed"
      }
    ]),
    {
      type: "page",
      title: "Koed",
      url: "koed://app/",
      webSocketDebuggerUrl: "ws://koed"
    }
  );
});

test("functionExpression serializes arguments without interpolating source", () => {
  const expression = functionExpression(
    (value) => ({ value }),
    ['quote" and newline\n']
  );
  assert.equal(
    expression,
    '((value) => ({ value }))(...["quote\\" and newline\\n"])'
  );
});

const setupClient = (initialState) => {
  let state = initialState;
  const clicks = [];
  const text = () => {
    if (state === "ready") return "Set up Koed\nKoed is ready\nContinue";
    if (state === "confirm") {
      return "Set up Koed on this computer?\nSet up Koed";
    }
    if (state.startsWith("guidance-")) {
      return `How Koed handles your Memory\n${state.slice(-1)} of 5`;
    }
    if (state === "shell") return "Personal Memory";
    return "Set up Koed";
  };
  return {
    clicks,
    bodyText: async () => text(),
    evaluate: async () => state === "shell",
    waitForBody: async () => text(),
    clickButton: async (label, occurrence = "first") => {
      clicks.push([label, occurrence]);
      if (label === "Set up Koed" && state === "setup") {
        state = "confirm";
        return { clicked: true };
      }
      if (
        label === "Set up Koed" &&
        occurrence === "last" &&
        state === "confirm"
      ) {
        state = "ready";
        return { clicked: true };
      }
      if (label === "Continue" && state === "ready") {
        state = "guidance-1";
        return { clicked: true };
      }
      if (label === "Next" && state.startsWith("guidance-")) {
        state = `guidance-${Number(state.slice(-1)) + 1}`;
        return { clicked: true };
      }
      if (label === "Finish" && state === "guidance-5") {
        state = "shell";
        return { clicked: true };
      }
      return { clicked: false };
    }
  };
};

test("ensureKoedElectronSetup continues an already completed setup", async () => {
  const client = setupClient("ready");
  assert.deepEqual(await ensureKoedElectronSetup(client), {
    changed: true,
    state: "ready"
  });
  assert.deepEqual(client.clicks[0], ["Continue", "first"]);
  assert.equal(
    client.clicks.some(([label]) => label === "Set up Koed"),
    false
  );
});

test("ensureKoedElectronSetup completes setup and trust guidance", async () => {
  const client = setupClient("setup");
  assert.deepEqual(await ensureKoedElectronSetup(client), {
    changed: true,
    state: "ready"
  });
  assert.deepEqual(client.clicks.slice(0, 3), [
    ["Set up Koed", "first"],
    ["Set up Koed", "last"],
    ["Continue", "first"]
  ]);
});

test("ensureKoedElectronSetup resumes interrupted trust guidance", async () => {
  const client = setupClient("guidance-3");
  assert.deepEqual(await ensureKoedElectronSetup(client), {
    changed: true,
    state: "ready"
  });
  assert.deepEqual(client.clicks, [
    ["Next", "first"],
    ["Next", "first"],
    ["Finish", "first"]
  ]);
  assert.equal(
    client.clicks.some(([label]) => label === "Set up Koed"),
    false
  );
});

test("ensureKoedElectronSetup waits for the application shell after reload", async () => {
  let shellReady = false;
  const client = {
    bodyText: async () => "",
    evaluate: async () => shellReady,
    waitForBody: async () => {
      shellReady = true;
      return "Personal Memory";
    },
    clickButton: async () => {
      throw new Error("setup controls must not be used after reload");
    }
  };

  assert.deepEqual(await ensureKoedElectronSetup(client), {
    changed: false,
    state: "ready"
  });
});
