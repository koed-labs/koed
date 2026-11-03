import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import {
  generateKeyPair,
  exportPublicKey,
  openClientSecureChannel
} from "@getpaseo/relay/e2ee";
import * as prototype from "./prototype.mjs";
import { runScenario, corruptFrame, connect, transport } from "./prototype.mjs";

test(
  "first malformed hello arriving with open is rejected and closed",
  { timeout: 5000 },
  async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    const sockets = new Set();
    const emit = WebSocket.prototype.emit;
    WebSocket.prototype.emit = function (event, ...args) {
      const result = emit.call(this, event, ...args);
      if (event === "open" && sockets.has(this)) {
        emit.call(
          this,
          "message",
          Buffer.from('{"type":"e2ee_hello","protected":null}'),
          false
        );
      }
      return result;
    };
    try {
      const ws = await connect(
        server.address().port,
        "race",
        "server",
        "id",
        sockets
      );
      const handshake = prototype.acceptDaemonEndpoint(ws, generateKeyPair());
      await assert.rejects(
        Promise.race([
          handshake,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("hello lost")), 100)
          )
        ]),
        (error) => {
          assert.notEqual(error.message, "hello lost");
          return true;
        }
      );
      if (ws.readyState !== WebSocket.CLOSED)
        await new Promise((resolve) => ws.once("close", resolve));
    } finally {
      WebSocket.prototype.emit = emit;
      for (const ws of sockets) ws.terminate();
      for (const ws of server.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  }
);

test("transport flushes early control messages, errors and close in order", () => {
  const ws = new EventEmitter();
  const t = transport(ws);
  const error = new Error("socket failure");
  ws.emit("message", Buffer.from('{"type":"connected"}'), false);
  ws.emit("error", error);
  ws.emit("close", 1006, Buffer.from("closed"));
  const events = [];
  t.onmessage = (message) => events.push(["message", message.data]);
  t.onerror = (value) => events.push(["error", value]);
  t.onclose = (code, reason) => events.push(["close", code, reason]);
  t.flush();
  assert.deepEqual(events, [
    ["message", '{"type":"connected"}'],
    ["error", error],
    ["close", 1006, "closed"]
  ]);
});

test("terminal close bypasses unhandled message and permits late close handler", () => {
  const ws = new EventEmitter();
  const t = transport(ws);
  const events = [];
  ws.emit("message", Buffer.from("orphan"), false);
  ws.emit("close", 1006, Buffer.from("gone"));
  t.onclose = (code, reason) => events.push([code, reason]);
  t.flush();
  t.onmessage = (message) => events.push(message.data);
  t.flush();
  assert.deepEqual(events, [[1006, "gone"]]);
});

test("unhandled messages are bounded and overflow closes transport", () => {
  const ws = new EventEmitter();
  const closes = [];
  ws.close = (...args) => closes.push(args);
  const t = transport(ws);
  for (let i = 0; i < 300; i++) ws.emit("message", Buffer.from("x"), false);
  assert.deepEqual(closes, [[1009, "buffer limit exceeded"]]);
  const received = [];
  t.onmessage = (message) => received.push(message.data);
  t.flush();
  assert.equal(received.length, 0);
});

test("unhandled error bypasses an earlier message when error handler exists", () => {
  const ws = new EventEmitter();
  const t = transport(ws);
  const events = [];
  t.onerror = (error) => events.push(error.message);
  ws.emit("message", Buffer.from("orphan"), false);
  ws.emit("error", new Error("failure"));
  t.onmessage = (message) => events.push(message.data);
  t.flush();
  assert.deepEqual(events, ["failure"]);
});

test("unhandled message byte limit closes transport", () => {
  const ws = new EventEmitter();
  const closes = [];
  ws.close = (...args) => closes.push(args);
  transport(ws);
  ws.emit("message", Buffer.alloc(1048577), false);
  assert.deepEqual(closes, [[1009, "buffer limit exceeded"]]);
});

test("closed handshake cannot publish or leave an open channel", async () => {
  const key = generateKeyPair();
  let hello;
  const client = await openClientSecureChannel(
    {
      send: (data) => {
        hello = data;
      },
      close() {}
    },
    {
      daemonPublicKeyB64: exportPublicKey(key.publicKey),
      minimumMode: "protected"
    }
  );
  client.close();
  const ws = new EventEmitter();
  ws.send = () => {};
  ws.close = () => {};
  const t = transport(ws);
  ws.emit("message", Buffer.from(hello), false);
  ws.emit("close", 1006, Buffer.from("gone"));
  let opens = 0,
    closes = 0;
  assert.equal(typeof prototype.openDaemonEndpoint, "function");
  const handshake = prototype.openDaemonEndpoint(t, key, {
    onopen: () => opens++,
    onclose: () => closes++
  });
  await assert.rejects(handshake, /closed/i);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opens, 0);
  assert.equal(closes, 1);
});

test("handshake flood is bounded while ready send is in flight", async () => {
  const key = generateKeyPair();
  let hello;
  const client = await openClientSecureChannel(
    {
      send: (data) => {
        hello = data;
      },
      close() {}
    },
    {
      daemonPublicKeyB64: exportPublicKey(key.publicKey),
      minimumMode: "protected"
    }
  );
  client.close();
  const ws = new EventEmitter();
  const closes = [];
  ws.close = (...args) => closes.push(args);
  ws.send = () => {
    for (let i = 0; i < 300; i++) ws.emit("message", Buffer.from("x"), false);
  };
  const handshake = prototype.openDaemonEndpoint(transport(ws), key);
  ws.emit("message", Buffer.from(hello), false);
  await assert.rejects(handshake, /closed/i);
  assert.deepEqual(closes[0], [1009, "buffer limit exceeded"]);
});

test("valid hello retry during ready send survives handshake gate", async () => {
  const key = generateKeyPair();
  let hello;
  const client = await openClientSecureChannel(
    {
      send: (data) => {
        hello = data;
      },
      close() {}
    },
    {
      daemonPublicKeyB64: exportPublicKey(key.publicKey),
      minimumMode: "protected"
    }
  );
  client.close();
  const ws = new EventEmitter();
  let sends = 0;
  ws.close = () => {};
  ws.send = () => {
    if (++sends === 1) ws.emit("message", Buffer.from(hello), false);
  };
  const handshake = prototype.openDaemonEndpoint(transport(ws), key);
  ws.emit("message", Buffer.from(hello), false);
  const channel = await handshake;
  assert.equal(channel.isOpen(), true);
  assert.equal(sends, 2);
  channel.close();
});

test("live close during ready send cannot publish an open channel", async () => {
  const key = generateKeyPair();
  let hello;
  const client = await openClientSecureChannel(
    {
      send: (data) => {
        hello = data;
      },
      close() {}
    },
    {
      daemonPublicKeyB64: exportPublicKey(key.publicKey),
      minimumMode: "protected"
    }
  );
  client.close();
  const ws = new EventEmitter();
  ws.send = () => ws.emit("close", 1006, Buffer.from("gone"));
  ws.close = () => {};
  const t = transport(ws);
  let opens = 0,
    closes = 0;
  const handshake = prototype.openDaemonEndpoint(t, key, {
    onopen: () => opens++,
    onclose: () => closes++
  });
  ws.emit("message", Buffer.from(hello), false);
  await assert.rejects(handshake, /closed/i);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opens, 0);
  assert.equal(closes, 1);
});

test(
  "real peer closes after valid hello before endpoint publication",
  { timeout: 5000 },
  async () => {
    const key = generateKeyPair();
    let hello;
    const client = await openClientSecureChannel(
      {
        send: (data) => {
          hello = data;
        },
        close() {}
      },
      {
        daemonPublicKeyB64: exportPublicKey(key.publicKey),
        minimumMode: "protected"
      }
    );
    client.close();
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    const peerClose = new Promise((resolve) =>
      server.once("connection", (peer) => {
        peer.once("close", resolve);
        peer.send(hello);
        peer.close();
      })
    );
    const sockets = new Set();
    try {
      const ws = await connect(
        server.address().port,
        "race",
        "server",
        "id",
        sockets
      );
      if (ws.readyState !== WebSocket.CLOSED)
        await new Promise((resolve) => ws.once("close", resolve));
      let opens = 0;
      await assert.rejects(
        prototype.acceptDaemonEndpoint(ws, key, { onopen: () => opens++ }),
        /closed/i
      );
      await peerClose;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(opens, 0);
    } finally {
      for (const ws of sockets) ws.terminate();
      for (const ws of server.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  }
);

test(
  "real peer oversized message is rejected at websocket boundary",
  { timeout: 5000 },
  async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    const peerClose = new Promise((resolve) =>
      server.once("connection", (peer) => {
        peer.once("close", (code) => resolve(code));
        peer.send(Buffer.alloc(1048577));
      })
    );
    const sockets = new Set();
    try {
      const ws = await connect(
        server.address().port,
        "race",
        "server",
        "id",
        sockets
      );
      const error = new Promise((resolve) => {
        transport(ws).onerror = resolve;
      });
      transport(ws).flush();
      assert.equal(await peerClose, 1009);
      assert.equal(
        (
          await Promise.race([
            error,
            new Promise((resolve) => setTimeout(() => resolve({}), 200))
          ])
        ).code,
        "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
      );
    } finally {
      for (const ws of sockets) ws.terminate();
      for (const ws of server.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  }
);

test(
  "real peer observes malformed hello rejection close",
  { timeout: 5000 },
  async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    const peerClose = new Promise((resolve) =>
      server.once("connection", (peer) => {
        peer.once("close", (code, reason) =>
          resolve([code, reason.toString()])
        );
        peer.send('{"type":"e2ee_hello","protected":null}');
      })
    );
    const sockets = new Set();
    try {
      const ws = await connect(
        server.address().port,
        "race",
        "server",
        "id",
        sockets
      );
      await assert.rejects(
        prototype.acceptDaemonEndpoint(ws, generateKeyPair())
      );
      assert.deepEqual(await peerClose, [1008, "handshake rejected"]);
    } finally {
      for (const ws of sockets) ws.terminate();
      for (const ws of server.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  }
);

test("tamper preserves frame type and changes ciphertext, not base64 padding", () => {
  const bytes = Buffer.from([0, 3, 7, 8, 9]);
  const text = bytes.toString("base64");
  const changed = corruptFrame(text);
  assert.equal(typeof changed, "string");
  const decoded = Buffer.from(changed, "base64");
  assert.deepEqual(decoded.subarray(0, 2), bytes.subarray(0, 2));
  assert.notDeepEqual(decoded.subarray(2), bytes.subarray(2));
  assert.ok(
    corruptFrame(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    ) instanceof ArrayBuffer
  );
});

test(
  "process group cleanup kills descendants after leader exits",
  { timeout: 10000 },
  async () => {
    const { stopChild } = await import("./prototype.mjs");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }); console.log(c.pid); setTimeout(() => process.exit(0), 200);`
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    const pid = Number(
      await new Promise((resolve) =>
        child.stdout.once("data", (data) => resolve(data.toString().trim()))
      )
    );
    await new Promise((resolve) => child.once("exit", resolve));
    try {
      await stopChild(child, true);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
);

test(
  "Wrangler startup failure cleans up surviving process group",
  { timeout: 12000 },
  () => {
    const dir = mkdtempSync(resolve("../../scratch/paseo-cleanup-"));
    const script = resolve(dir, "node_modules/wrangler/bin/wrangler.js");
    const pidFile = resolve(dir, "pid");
    mkdirSync(resolve(dir, "node_modules/wrangler/bin"), { recursive: true });
    writeFileSync(resolve(dir, "empty.env"), "");
    writeFileSync(
      script,
      `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => process.exit(1), 300);`
    );
    let pid;
    try {
      const module = new URL("./prototype.mjs", import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { launch } from '${module}'; await launch(12345);`
        ],
        { cwd: dir, encoding: "utf8", timeout: 10000 }
      );
      assert.match(result.stderr, /Wrangler startup failed/);
      pid = Number(readFileSync(pidFile, "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      if (pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("Docker rejects remote endpoint before starting relay", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { runScenario } from './prototype.mjs'; await runScenario();"
    ],
    {
      env: {
        ...process.env,
        DOCKER_HOST: "tcp://example.com:2375",
        PASEO_RELAY_RUNTIME: "docker"
      },
      encoding: "utf8",
      timeout: 10000
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local Unix socket/);
});

test("missing Docker executable reports startup failure without an unhandled spawn error", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { runScenario } from './prototype.mjs'; await runScenario();"
    ],
    {
      env: { ...process.env, PATH: "", PASEO_RELAY_RUNTIME: "docker" },
      encoding: "utf8",
      timeout: 10000
    }
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
});

test(
  "real v2 relay protects independent bidirectional traffic and rejects attacks",
  { timeout: 90000 },
  async () => {
    const result = await runScenario();
    assert.deepEqual(result.messages, [
      "alpha request",
      "alpha response",
      "beta request",
      "beta response"
    ]);
    assert.equal(result.mode, "protected");
    assert.equal(result.wrongKeyRejected, true);
    assert.equal(result.tamperRejected, true);
    assert.equal(result.replayRejected, true);
    assert.equal(result.legacyClientRejected, true);
    assert.equal(result.legacyDaemonRejected, true);
  }
);
