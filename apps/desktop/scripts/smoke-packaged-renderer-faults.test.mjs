/* global process */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  terminateChild,
  trustedClick,
  waitForRendererTarget
} from "./smoke-packaged-renderer-faults.mjs";

test("trusted renderer clicks foreground the page and dispatch real mouse input", async () => {
  const calls = [];
  const cdp = {
    call: async (method, params) => calls.push({ method, params })
  };
  const expressions = [];
  await trustedClick({
    cdp,
    evaluate: async (expression) => {
      expressions.push(expression);
      return { x: 120, y: 80 };
    },
    locator: "document.querySelector('button')"
  });

  assert.match(expressions[0], /document\.querySelector\('button'\)/u);
  assert.deepEqual(calls, [
    { method: "Page.bringToFront", params: undefined },
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 120, y: 80 }
    },
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mousePressed",
        x: 120,
        y: 80,
        button: "left",
        clickCount: 1
      }
    },
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseReleased",
        x: 120,
        y: 80,
        button: "left",
        clickCount: 1
      }
    }
  ]);
});

test("renderer target discovery bounds a stalled CDP request", async () => {
  const startedAt = performance.now();
  const target = await waitForRendererTarget({
    debuggingPort: 45_001,
    readChildExit: () => undefined,
    startupTimeoutMs: 40,
    requestTimeoutMs: 10,
    delayImpl: async () => {},
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true
        });
      })
  });

  assert.equal(target, undefined);
  assert.ok(
    performance.now() - startedAt < 500,
    "stalled discovery should honor the configured deadline"
  );
});

test("renderer target discovery returns the first page target", async () => {
  const expected = {
    type: "page",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1"
  };
  const target = await waitForRendererTarget({
    debuggingPort: 45_002,
    readChildExit: () => undefined,
    fetchImpl: async () => ({
      json: async () => [{ type: "browser" }, expected]
    })
  });
  assert.deepEqual(target, expected);
});

test("renderer child termination escalates and waits for exit", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  try {
    await once(child.stdout, "data");
    await terminateChild(child, 50);
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});
