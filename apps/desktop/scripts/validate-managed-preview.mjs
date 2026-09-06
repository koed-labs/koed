import assert from "node:assert/strict";
import { createServer } from "node:http";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { app, BrowserWindow, session } from "electron";

import { createManagedPreviewController } from "../dist-electron/window/managed-preview-controller.js";

const listen = async (handler) => {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, port: address.port };
};

const closeServer = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

const waitFor = async (read, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const run = async () => {
  await app.whenReady();
  let forbiddenRequests = 0;
  let targetRequests = 0;
  const forbidden = await listen((_request, response) => {
    forbiddenRequests += 1;
    response.end("forbidden");
  });
  const target = await listen((_request, response) => {
    targetRequests += 1;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("set-cookie", "preview-test=must-clear; SameSite=Lax");
    response.end(`<!doctype html><script>
      localStorage.setItem("preview-test", "must-clear");
      fetch("http://127.0.0.1:${forbidden.port}/must-not-run").catch(() => {});
    </script><p>Managed preview ready</p>`);
  });
  const parent = new BrowserWindow({
    show: true,
    opacity: 0,
    skipTaskbar: true,
    width: 800,
    height: 600,
    webPreferences: { sandbox: true }
  });
  const controller = createManagedPreviewController();
  const surfaceId = "11111111-1111-4111-8111-111111111111";
  const events = [];
  try {
    await parent.loadURL("data:text/html,<main>Koed preview host</main>");
    await controller.attach(
      parent.webContents,
      {
        surfaceId,
        access: {
          preview: {
            id: "22222222-2222-4222-8222-222222222222",
            executionId: "33333333-3333-4333-8333-333333333333",
            executionGeneration: 1,
            lifecycleGeneration: 1,
            terminalId: "44444444-4444-4444-8444-444444444444",
            state: "available",
            source: "terminal_output",
            policyVersion: 1,
            discoveredAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          navigationUrl: `http://127.0.0.1:${target.port}/`
        },
        bounds: { x: 0, y: 0, width: 640, height: 480 }
      },
      (event) => events.push(event)
    );
    await waitFor(
      () => events.some((event) => event.state === "ready"),
      "preview ready event"
    );
    await delay(250);
    assert.ok(targetRequests >= 1, "Expected the verified target to load");
    assert.equal(
      forbiddenRequests,
      0,
      "Cross-origin preview request escaped its isolated origin"
    );

    await controller.detach(parent.webContents, surfaceId);
    const previewSession = session.fromPartition(`koed-preview-${surfaceId}`);
    assert.deepEqual(await previewSession.cookies.get({}), []);
    assert.ok(events.some((event) => event.state === "closed"));
  } finally {
    await controller.close();
    if (!parent.isDestroyed()) parent.destroy();
    await Promise.all([
      closeServer(target.server),
      closeServer(forbidden.server)
    ]);
    app.quit();
  }
};

void run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  app.exit(1);
});
