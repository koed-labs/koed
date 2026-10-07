/* global setImmediate */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { connectPackagedDesktop } from "./packaged-desktop-lifecycle.mjs";

const fixture = (timeoutMs = 1000) => {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    sent: [],
    killed: false,
    kill() {
      this.killed = true;
    },
    send(message, callback) {
      this.sent.push(message);
      callback(null);
    }
  });
  const desktop = connectPackagedDesktop(child, timeoutMs);
  const ready = () =>
    child.emit("message", { type: "koed.desktop.smoke.ready", version: 1 });
  return { child, desktop, ready };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("waits for manager ready then sends only correlated lifecycle requests", async () => {
  const { child, desktop, ready } = fixture();
  const result = desktop.invoke("start_daemon");
  assert.deepEqual(child.sent, []);
  ready();
  await tick();
  const request = child.sent[0];
  assert.equal(request.command, "start_daemon");
  assert.equal(request.version, 1);
  assert.deepEqual(Object.keys(request).sort(), [
    "command",
    "id",
    "type",
    "version"
  ]);
  child.emit("message", {
    type: "koed.desktop.smoke.response",
    version: 1,
    id: request.id,
    result: { ok: true, startedPid: 123 }
  });
  assert.deepEqual(await result, { ok: true, startedPid: 123 });
});

test("invalid correlation fails pending requests", async () => {
  const { child, desktop, ready } = fixture();
  ready();
  const result = desktop.invoke("status");
  const rejected = assert.rejects(result, /Uncorrelated/);
  await tick();
  child.emit("message", {
    type: "koed.desktop.smoke.response",
    version: 1,
    id: "other",
    result: {}
  });
  await rejected;
  await assert.rejects(desktop.invoke("stop"), /not connected/);
});

test("reports manager errors without interpreting them as success", async () => {
  const { child, desktop, ready } = fixture();
  ready();
  const result = desktop.invoke("start_daemon");
  const rejected = assert.rejects(result, /privacy gate/);
  await tick();
  child.emit("message", {
    type: "koed.desktop.smoke.response",
    version: 1,
    id: child.sent[0].id,
    error: "privacy gate"
  });
  await rejected;
});

test("bootstrap timeout terminates manager with diagnostics", async () => {
  const { child, desktop } = fixture(20);
  child.stderr.emit("data", "bootstrap failed");
  await assert.rejects(desktop.ready, /bootstrap timed out.*bootstrap failed/s);
  assert.equal(child.killed, true);
});

test("disconnect rejects in-flight lifecycle operation", async () => {
  const { child, desktop, ready } = fixture();
  ready();
  const result = desktop.invoke("stop");
  const rejected = assert.rejects(result, /IPC disconnected/);
  await tick();
  child.emit("disconnect");
  await rejected;
});
