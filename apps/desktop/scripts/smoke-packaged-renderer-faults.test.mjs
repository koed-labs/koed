/* global process, fetch */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadRendererValidation } from "./renderer-validation-assets.mjs";
import {
  terminateChild,
  trustedClick,
  waitForRendererTarget
} from "./smoke-packaged-renderer-faults.mjs";

test("packaged fault fixtures preserve the trusted renderer origin and serve only their separate assets", async (t) => {
  const scratch = resolve(import.meta.dirname, "../../../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "renderer-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "assets"));
  writeFileSync(
    resolve(root, "browser-validation.html"),
    '<head><script type="module" src="./assets/fixture.js"></script></head><main id="root"></main>'
  );
  writeFileSync(
    resolve(root, "assets/fixture.js"),
    "globalThis.fixture = true;"
  );
  const calls = [];
  let reloading = false;
  let reloadFrameReads = 0;
  const cdp = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "Page.reload") reloading = true;
      return method === "Page.getFrameTree"
        ? {
            frameTree: {
              frame: {
                id: "package-frame",
                loaderId:
                  reloading && reloadFrameReads++ > 0
                    ? "reloaded-document"
                    : "original-document"
              }
            }
          }
        : { result: { value: true } };
    }
  };
  const fixture = await loadRendererValidation(
    cdp,
    { view: "chat", actor: "alice" },
    root
  );
  try {
    assert.match(
      calls.find(({ method }) => method === "Page.navigate").params.url,
      /koed:\/\/app\/\?view=chat&actor=alice/
    );
    const document = calls.find(
      ({ method }) => method === "Page.setDocumentContent"
    ).params;
    assert.equal(document.frameId, "package-frame");
    const base = document.html.match(
      /src="(http:[^"]+\/)assets\/fixture.js"/
    )[1];
    const script = await fetch(`${base}assets/fixture.js`);
    assert.equal(await script.text(), "globalThis.fixture = true;");
    assert.equal(script.headers.get("content-type"), "text/javascript");
    assert.equal(
      script.headers.get("access-control-allow-origin"),
      "koed://app"
    );
    assert.equal((await fetch(`${base}assets/missing.js`)).status, 404);
    assert.equal(
      (await fetch(`${base}assets/%2F..%2F..%2Foutside.js`)).status,
      403
    );
    await fixture.reload();
    const afterReload = calls.slice(
      calls.findIndex(({ method }) => method === "Page.reload") + 1
    );
    assert.deepEqual(
      afterReload.slice(0, 3).map(({ method }) => method),
      ["Page.getFrameTree", "Page.getFrameTree", "Runtime.evaluate"]
    );
    const documents = calls.filter(
      ({ method }) => method === "Page.setDocumentContent"
    );
    assert.equal(documents.length, 2);
    assert.deepEqual(documents[1].params, document);
    assert.equal(
      calls.filter(({ method }) => method === "Page.navigate").length,
      1
    );
  } finally {
    await fixture.dispose();
  }
});

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
