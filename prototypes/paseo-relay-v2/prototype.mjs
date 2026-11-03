import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  generateKeyPair,
  exportPublicKey,
  openClientSecureChannel,
  openDaemonSecureChannel,
  createClientChannel
} from "@getpaseo/relay/e2ee";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function corruptFrame(data) {
  const text = typeof data === "string";
  const bytes = Buffer.from(data, text ? "base64" : undefined);
  if (bytes.length <= 2) throw new Error("Record has no ciphertext");
  bytes[2] ^= 1;
  return text
    ? bytes.toString("base64")
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function monitor(child) {
  let error;
  child.on("error", (value) => {
    error = value;
  });
  return () => {
    if (error) throw error;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Process exited (${child.exitCode ?? child.signalCode})`);
  };
}
export async function stopChild(child, group = false) {
  if (!child.pid) return;
  const alive = () => {
    if (!group) return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      if (error.code !== "EPERM") throw error;
      const ps = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
      if (ps.error || ps.status !== 0)
        throw new Error(
          `Cannot inspect process group: ${ps.error ?? ps.stderr}`
        );
      return ps.stdout.split("\n").some((line) => {
        const [pgid, state] = line.trim().split(/\s+/);
        return Number(pgid) === child.pid && !state?.startsWith("Z");
      });
    }
  };
  const signal = (name) => {
    try {
      if (group) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  if (!alive()) return;
  signal("SIGTERM");
  const deadline = Date.now() + 2000;
  while (alive() && Date.now() < deadline) await delay(20);
  if (alive()) {
    signal("SIGKILL");
    await until(() => !alive(), "process termination", 3000);
  }
}
async function until(predicate, description, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve)
  );
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const transports = new WeakMap();
export function transport(ws) {
  if (transports.has(ws)) return transports.get(ws);
  const t = {
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) =>
      ws.send(data instanceof ArrayBuffer ? Buffer.from(data) : data),
    close: (code, reason) => ws.close(code, reason)
  };
  const pending = [];
  let bytes = 0,
    closed = false,
    deliveredClose,
    overflow = false,
    handshake = false,
    gateMessages = false;
  let onclose = null;
  Object.defineProperty(t, "onclose", {
    get: () => onclose,
    set: (handler) => {
      onclose = handler;
      if (handler && deliveredClose) handler(...deliveredClose);
    }
  });
  t.isClosed = () => closed || overflow;
  t.beginHandshake = () => {
    handshake = true;
  };
  t.endHandshake = () => {
    handshake = false;
    gateMessages = false;
    t.flush();
  };
  t.flush = () => {
    while (pending.length) {
      let index = pending.findIndex(
        ([handler]) => t[handler] && !(gateMessages && handler === "onmessage")
      );
      if (index < 0) break;
      if (index && pending[index][0] === "onmessage") break;
      const removed = pending.splice(0, index + 1);
      for (const event of removed) bytes -= event[2];
      const [handler, args] = removed.at(-1);
      if (handler === "onclose") deliveredClose = args;
      if (handler === "onmessage" && handshake) gateMessages = true;
      t[handler](...args);
    }
  };
  const queue = (handler, args, size = 0) => {
    if (overflow && handler !== "onclose") return;
    if (
      handler !== "onclose" &&
      (pending.length >= 256 || bytes + size > 1048576)
    ) {
      overflow = true;
      pending.length = 0;
      bytes = 0;
      ws.close(1009, "buffer limit exceeded");
      return;
    }
    pending.push([handler, args, size]);
    bytes += size;
    t.flush();
  };
  ws.on("message", (data, binary) => {
    if (overflow) return;
    if (pending.length >= 256 || bytes + data.length > 1048576) {
      overflow = true;
      pending.length = 0;
      bytes = 0;
      ws.close(1009, "buffer limit exceeded");
      return;
    }
    queue(
      "onmessage",
      [
        {
          data: binary ? Uint8Array.from(data).buffer : data.toString(),
          isBinary: binary
        }
      ],
      data.length
    );
  });
  ws.on("close", (code, reason) => {
    closed = true;
    queue("onclose", [code, reason.toString()]);
  });
  ws.on("error", (error) => queue("onerror", [error]));
  transports.set(ws, t);
  return t;
}
export async function connect(port, session, role, id, sockets) {
  const query = new URLSearchParams({ v: "2", serverId: session, role });
  if (id) query.set("connectionId", id);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`, {
    maxPayload: 1048576
  });
  sockets.add(ws);
  transport(ws);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}
export async function launch(port) {
  const env = {
    ...process.env,
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost"
  };
  delete env.PASEO_RELAY_UPSTREAM;
  const child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--local",
      "--env-file",
      "empty.env",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--show-interactive-dev-session=false"
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"], env }
  );
  const check = monitor(child);
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  try {
    await until(
      () => {
        check();
        return output.includes("Ready on");
      },
      "local Wrangler",
      15000
    );
  } catch (error) {
    await stopChild(child, true);
    throw new Error(`Wrangler startup failed: ${output}`, { cause: error });
  }
  return child;
}
async function launchDocker(port) {
  const name = `paseo-prototype-${randomUUID()}`;
  const image =
    "ghcr.io/getpaseo/paseo-relay@sha256:9d5c65d4bd2c42a85a5c8ab329f801a7db41dc4c153ca7bfba6c0857b3cdad0d";
  let host = process.env.DOCKER_HOST;
  if (!host) {
    const context = spawnSync(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { encoding: "utf8", timeout: 5000 }
    );
    if (context.error) throw context.error;
    if (context.status !== 0)
      throw new Error(`Docker context inspection failed: ${context.stderr}`);
    host = context.stdout.trim();
  }
  if (!/^unix:\/\/\//.test(host))
    throw new Error("Docker requires a local Unix socket endpoint");
  const docker = (args) => ["--host", host, ...args];
  const env = { ...process.env };
  delete env.DOCKER_CONTEXT;
  const child = spawn(
    "docker",
    docker([
      "run",
      "--rm",
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:4000`,
      image
    ]),
    { stdio: ["ignore", "pipe", "pipe"], env }
  );
  const check = monitor(child);
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const stop = async () => {
    try {
      const inspect = spawnSync("docker", docker(["inspect", name]), {
        timeout: 5000,
        encoding: "utf8",
        env
      });
      if (inspect.error) throw inspect.error;
      if (inspect.status === 0) {
        const removal = spawnSync("docker", docker(["rm", "-f", name]), {
          timeout: 5000,
          encoding: "utf8",
          env
        });
        if (removal.error || removal.status !== 0)
          throw new Error(
            `Docker removal failed: ${removal.error ?? removal.stderr}`
          );
      } else if (!inspect.stderr.includes("No such"))
        throw new Error(`Docker inspect failed: ${inspect.stderr}`);
    } finally {
      await stopChild(child);
    }
  };
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      check();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ready`, {
          signal: AbortSignal.timeout(500)
        });
        if (response.ok) return { child, stop };
      } catch {
        /* Relay may still be starting. */
      }
      await delay(100);
    }
    throw new Error(`Timed out waiting for Docker relay readiness: ${output}`);
  } catch (error) {
    await stop().catch((cleanup) => {
      throw new AggregateError(
        [error, cleanup],
        "Docker startup and cleanup failed"
      );
    });
    throw error;
  }
}
export async function openDaemonEndpoint(t, key, events = {}) {
  t.beginHandshake();
  const handshake = openDaemonSecureChannel(t, {
    daemonKeyPair: key,
    minimumMode: "protected",
    events: {
      ...events,
      onopen: () => {
        if (!t.isClosed()) events.onopen?.();
      }
    }
  });
  t.flush();
  const channel = await handshake;
  if (t.isClosed()) {
    channel.close();
    throw new Error("Connection closed during handshake");
  }
  t.endHandshake();
  return channel;
}
export async function acceptDaemonEndpoint(ws, key, events = {}) {
  try {
    return await openDaemonEndpoint(transport(ws), key, events);
  } catch (error) {
    if (ws.readyState === WebSocket.OPEN)
      ws.close(
        error.closeCode ?? 1008,
        error.closeReason ?? "handshake rejected"
      );
    throw error;
  }
}
async function setup(port, sockets, key = generateKeyPair()) {
  const session = randomUUID();
  const endpoints = new Map();
  const control = await connect(port, session, "server", null, sockets);
  const controlTransport = transport(control);
  controlTransport.onmessage = async ({ data }) => {
    const message = JSON.parse(data.toString());
    if (message.type !== "connected") return;
    const id = message.connectionId;
    let ws;
    try {
      ws = await connect(port, session, "server", id, sockets);
      const messages = [];
      const channel = await acceptDaemonEndpoint(ws, key, {
        onmessage: (data) => messages.push(data),
        onerror: () => {}
      });
      if (transport(ws).isClosed()) {
        channel.close();
        throw new Error("Connection closed during handshake");
      }
      endpoints.set(id, { channel, messages, ws });
    } catch (error) {
      endpoints.set(id, { error });
    }
  };
  controlTransport.onerror = (error) =>
    console.error("Control socket error:", error);
  controlTransport.onclose = () => {};
  controlTransport.flush();
  return { session, key, endpoints };
}
async function client(port, setup, sockets, key = setup.key, legacy = false) {
  const id = randomUUID();
  const ws = await connect(port, setup.session, "client", id, sockets);
  const t = transport(ws);
  const messages = [],
    errors = [],
    opens = [];
  const options = {
    daemonPublicKeyB64: exportPublicKey(key.publicKey),
    minimumMode: "protected",
    events: {
      onmessage: (data) => messages.push(data),
      onerror: (error) => errors.push(error),
      onopen: () => opens.push(true)
    }
  };
  const handshake = legacy
    ? createClientChannel(t, options.daemonPublicKeyB64, options.events)
    : openClientSecureChannel(t, options);
  t.flush();
  const channel = await handshake;
  return { id, ws, t, channel, messages, errors, opens };
}
export async function runScenario() {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Node 24 required");
  const port = await freePort(),
    sockets = new Set();
  const runtime = process.env.PASEO_RELAY_RUNTIME ?? "worker";
  if (!["worker", "docker"].includes(runtime))
    throw new Error(`Unknown relay runtime: ${runtime}`);
  const instance =
    runtime === "docker"
      ? await launchDocker(port)
      : { child: await launch(port), stop: null };
  const { child } = instance;
  try {
    const s = await setup(port, sockets);
    const a = await client(port, s, sockets),
      b = await client(port, s, sockets);
    await until(
      () =>
        a.channel.isOpen() &&
        b.channel.isOpen() &&
        s.endpoints.has(a.id) &&
        s.endpoints.has(b.id),
      "protected channels"
    );
    const da = s.endpoints.get(a.id),
      db = s.endpoints.get(b.id);
    if (
      [a.channel, b.channel, da.channel, db.channel].some(
        (c) => c.securityMode() !== "protected"
      )
    )
      throw new Error("Security downgrade");
    await a.channel.send("alpha request");
    await b.channel.send("beta request");
    await da.channel.send("alpha response");
    await db.channel.send("beta response");
    await until(
      () =>
        da.messages.length &&
        db.messages.length &&
        a.messages.length &&
        b.messages.length,
      "bidirectional messages"
    );
    const messages = [
      da.messages[0],
      a.messages[0],
      db.messages[0],
      b.messages[0]
    ];
    if (
      da.messages.length !== 1 ||
      db.messages.length !== 1 ||
      a.messages.length !== 1 ||
      b.messages.length !== 1
    )
      throw new Error("Unexpected cross-client traffic");
    // Noise IK binds the first message to the pinned static key; an unpinned responder cannot read it.
    const attacker = await setup(port, sockets);
    const control = await client(port, attacker, sockets);
    await until(
      () =>
        control.channel.isOpen() && attacker.endpoints.get(control.id)?.channel,
      "matching key control"
    );
    await control.channel.send("matching key");
    await until(
      () =>
        attacker.endpoints.get(control.id).messages.includes("matching key"),
      "matching key message"
    );
    const wrong = await client(port, attacker, sockets, s.key);
    const wrongFailure = await until(
      () => attacker.endpoints.get(wrong.id)?.error,
      "wrong key responder failure"
    );
    await until(
      () => wrong.ws.readyState === WebSocket.CLOSED,
      "wrong key client close"
    );
    const wrongKeyRejected =
      !!wrongFailure &&
      !wrong.channel.isOpen() &&
      wrong.opens.length === 0 &&
      wrong.messages.length === 0;
    let hello;
    const probe = await openClientSecureChannel(
      {
        send: (data) => {
          hello = data;
        },
        close: () => {}
      },
      {
        daemonPublicKeyB64: exportPublicKey(s.key.publicKey),
        minimumMode: "protected"
      }
    );
    probe.close();
    const legacy = await client(port, s, sockets, s.key, true);
    const rejected = await until(
      () => s.endpoints.get(legacy.id)?.error,
      "legacy client rejection"
    );
    await until(() => legacy.ws.readyState >= 2, "legacy client close");
    const legacyClientRejected =
      rejected.closeCode === 1008 && !legacy.channel.isOpen();
    // Simulate an old responder on a real v2 data socket to exercise client policy.
    const oldSession = randomUUID();
    const oldControl = await connect(port, oldSession, "server", null, sockets);
    const oldControlTransport = transport(oldControl);
    oldControlTransport.onmessage = async ({ data }) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== "connected") return;
      const old = await connect(
        port,
        oldSession,
        "server",
        msg.connectionId,
        sockets
      );
      const t = transport(old);
      t.onmessage = () => old.send(JSON.stringify({ type: "e2ee_ready" }));
      t.onerror = (error) =>
        console.error("Old responder socket error:", error);
      t.onclose = () => {};
      t.flush();
    };
    oldControlTransport.onerror = (error) =>
      console.error("Old control socket error:", error);
    oldControlTransport.onclose = () => {};
    oldControlTransport.flush();
    const old = await client(
      port,
      { session: oldSession, key: s.key },
      sockets
    );
    await until(
      () =>
        old.errors.some(
          (error) =>
            error.message === "daemon offered only legacy endpoint security"
        ) && old.ws.readyState === WebSocket.CLOSED,
      "legacy daemon rejection",
      40000
    );
    const legacyDaemonRejected =
      !old.channel.isOpen() &&
      old.opens.length === 0 &&
      old.messages.length === 0;
    // Exercise malformed and unsupported envelopes on each endpoint.
    for (const protectedValue of [null, { v: 999, message: "AA==" }]) {
      const rawId = randomUUID();
      const raw = await connect(port, s.session, "client", rawId, sockets);
      const parsed = JSON.parse(hello);
      parsed.protected = protectedValue;
      raw.send(JSON.stringify(parsed));
      await until(
        () =>
          s.endpoints.get(rawId)?.error && raw.readyState >= WebSocket.CLOSING,
        "malformed hello rejection"
      );
      if (s.endpoints.get(rawId).channel)
        throw new Error("Malformed hello opened channel");
      const session = randomUUID();
      const control = await connect(port, session, "server", null, sockets);
      const controlTransport = transport(control);
      controlTransport.onmessage = async ({ data }) => {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "connected") return;
        const ws = await connect(
          port,
          session,
          "server",
          msg.connectionId,
          sockets
        );
        ws.send(
          JSON.stringify({ type: "e2ee_ready", protected: protectedValue })
        );
      };
      controlTransport.onerror = (error) =>
        console.error("Control socket error:", error);
      controlTransport.onclose = () => {};
      controlTransport.flush();
      const bad = await client(port, { session, key: s.key }, sockets);
      await until(
        () => bad.errors.length && bad.ws.readyState >= WebSocket.CLOSING,
        "malformed ready rejection"
      );
      if (bad.opens.length || bad.messages.length || bad.channel.isOpen())
        throw new Error("Malformed ready opened channel");
    }
    // Inject modified and replayed actual ciphertext over the same upstream data path.
    const c = await client(port, s, sockets);
    await until(
      () => c.channel.isOpen() && s.endpoints.has(c.id),
      "tamper channel"
    );
    const dc = s.endpoints.get(c.id);
    const send = c.t.send;
    c.t.send = (data) => send(corruptFrame(data));
    await c.channel.send("tamper");
    await until(
      () => dc.ws.readyState >= 2 || c.ws.readyState >= 2,
      "tamper close"
    );
    const tamperRejected = dc.messages.length === 0;
    const d = await client(port, s, sockets);
    await until(
      () => d.channel.isOpen() && s.endpoints.has(d.id),
      "replay channel"
    );
    const dd = s.endpoints.get(d.id);
    const originalSend = d.t.send;
    let frame;
    d.t.send = (data) => {
      frame = typeof data === "string" ? data : data.slice(0);
      return originalSend(data);
    };
    await d.channel.send("once");
    await until(() => dd.messages.length === 1, "first record");
    d.ws.send(frame);
    await until(
      () => dd.ws.readyState >= 2 || d.ws.readyState >= 2,
      "replay close"
    );
    const replayRejected = dd.messages.length === 1;
    a.ws.close();
    await until(
      () => da.ws.readyState >= WebSocket.CLOSING,
      "client disconnect propagation"
    );
    db.ws.close();
    await until(
      () => b.ws.readyState >= WebSocket.CLOSING,
      "daemon disconnect propagation"
    );
    return {
      messages,
      mode: "protected",
      wrongKeyRejected,
      tamperRejected,
      replayRejected,
      legacyClientRejected,
      legacyDaemonRejected
    };
  } finally {
    for (const ws of sockets) ws.terminate();
    try {
      await until(
        () => [...sockets].every((ws) => ws.readyState === WebSocket.CLOSED),
        "socket termination",
        3000
      );
    } finally {
      if (instance.stop) await instance.stop();
      else await stopChild(child, true);
    }
  }
}
