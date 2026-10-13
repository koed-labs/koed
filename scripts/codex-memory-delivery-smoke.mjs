import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Native protocol test only: synthetic Responses server, isolated profile, no model credentials.
const binary = process.env.CODEX_TEST_BINARY ?? "codex";
const root = await mkdtemp(path.join(os.tmpdir(), "koed-codex-delivery-"));
const home = path.join(root, "profile");
const children = [];
const connections = [];
const requests = [];
const results = [];
let heldResponse;
let holdNext = false;
let toolCallNext = false;
let modelItem;
let pendingMcp;
let responseNumber = 0;
const event = (response, value) =>
  response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
const finishResponse = (response, id) => {
  event(response, {
    type: "response.output_item.done",
    item: {
      type: "message",
      id: `message-${id}`,
      role: "assistant",
      content: [{ type: "output_text", text: "Synthetic completion." }]
    }
  });
  event(response, {
    type: "response.completed",
    response: {
      id,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    }
  });
  response.end();
};
const server = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/mcp") {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const reply = (result) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result })
        );
      };
      if (message.id === undefined) response.writeHead(202).end();
      else if (message.method === "initialize") {
        reply({
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic-koed", version: "0.0.0" }
        });
      } else if (message.method === "tools/list") {
        reply({
          tools: [
            {
              name: "memory_answer",
              description: "Synthetic delayed compact recall answer.",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true, openWorldHint: false }
            },
            {
              name: "independent_check",
              description: "Synthetic independent read-only work.",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true }
            }
          ]
        });
      } else if (message.method === "tools/call") {
        if (message.params.name === "memory_answer") pendingMcp = { reply };
        else
          reply({
            content: [
              {
                type: "text",
                text: "Independent work completed before recall."
              }
            ]
          });
      } else reply({});
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const id = `response-${++responseNumber}`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    event(response, { type: "response.created", response: { id } });
    if (modelItem) {
      const item = modelItem;
      modelItem = undefined;
      event(response, { type: "response.output_item.done", item });
      event(response, { type: "response.completed", response: { id } });
      response.end();
    } else if (toolCallNext) {
      toolCallNext = false;
      event(response, {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: `tool-${id}`,
          call_id: `call-${id}`,
          name: "synthetic_foreground_tool",
          arguments: "{}"
        }
      });
      event(response, { type: "response.completed", response: { id } });
      response.end();
    } else if (holdNext) {
      holdNext = false;
      heldResponse = { response, id };
    } else finishResponse(response, id);
  } catch {
    response.writeHead(500).end();
  }
});

const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/^(OPENAI|CHATGPT|CODEX|AZURE_OPENAI|ANTHROPIC|CLAUDE|KOED|MEMORY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i.test(
        name
      )
  )
);
Object.assign(environment, {
  CODEX_HOME: home,
  HOME: root,
  XDG_CONFIG_HOME: path.join(root, "xdg"),
  NO_PROXY: "127.0.0.1,localhost",
  RUST_LOG: "error"
});

const start = (args) => {
  const child = spawn(binary, args, {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.push(child);
  child.stderr.on("data", () => {});
  return child;
};
const deadline = async (predicate, label) => {
  const end = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await sleep(20);
  }
};
const rpc = (socket) => {
  let id = 0;
  const pending = new Map();
  const events = [];
  const serverRequests = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id !== undefined && message.method) {
      serverRequests.push(message);
    } else if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
    } else events.push(message);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Native connection closed"));
    }
    pending.clear();
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`RPC timeout: ${method}`));
      }, 15_000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  return {
    events,
    serverRequests,
    call,
    respond: (id, result) => socket.send(JSON.stringify({ id, result })),
    async initialize(name) {
      const result = await call("initialize", {
        clientInfo: { name, version: "0.0.0" },
        capabilities: { experimentalApi: true }
      });
      socket.send(JSON.stringify({ method: "initialized" }));
      return result;
    }
  };
};

try {
  await mkdir(home);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await writeFile(
    path.join(home, "config.toml"),
    `model = "koed-test-model"
model_provider = "koed_test"
approval_policy = "never"
sandbox_mode = "read-only"
[analytics]
enabled = false
[model_providers.koed_test]
name = "Synthetic protocol fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[mcp_servers.synthetic]
url = "http://127.0.0.1:${port}/mcp"
tool_timeout_sec = 30
`
  );
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const hostPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const hostUrl = `ws://127.0.0.1:${hostPort}`;
  const host = start(["app-server", "--listen", hostUrl]);
  let socketReady = false;
  await deadline(() => {
    void fetch(`http://127.0.0.1:${hostPort}`, {
      signal: AbortSignal.timeout(200)
    })
      .then(() => (socketReady = true))
      .catch(() => {});
    return socketReady || host.exitCode !== null;
  }, "isolated host socket");
  assert.equal(host.exitCode, null, "Native host must remain running");
  const connect = async () => {
    const socket = new WebSocket(hostUrl);
    connections.push(socket);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Native connection failed")),
        { once: true }
      );
    });
    return rpc(socket);
  };
  const owner = await connect();
  const peer = await connect();
  const info = await owner.initialize("koed_delivery_owner_test");
  await peer.initialize("koed_delivery_peer_test");
  const { thread } = await owner.call("thread/start", {
    cwd: root,
    model: "koed-test-model",
    modelProvider: "koed_test",
    approvalPolicy: "never",
    sandbox: "read-only",
    dynamicTools: [
      {
        type: "function",
        name: "synthetic_foreground_tool",
        description:
          "A synthetic host tool with a deliberately delayed response.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    ]
  });
  const loaded = await peer.call("thread/loaded/list", {});
  assert.ok(loaded.data.includes(thread.id));
  results.push({
    check: "separate client addresses the original loaded host thread",
    passed: true
  });

  const output = "Synthetic compact Koed answer: cobalt.";
  const toolOutput = { name: "memory_answer", namespace: "koed", output };
  holdNext = true;
  const original = await owner.call("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "Synthetic independent work." }]
  });
  await deadline(() => Boolean(heldResponse), "active model request");
  const pushed = await peer.call("turn/start", {
    threadId: thread.id,
    input: [],
    toolOutput
  });
  assert.equal(pushed.turn.id, original.turn.id);
  finishResponse(heldResponse.response, heldResponse.id);
  heldResponse = undefined;
  await deadline(
    () =>
      requests.some((request) =>
        request.input.some(
          (item) =>
            item.type === "function_call_output" && item.output === output
        )
      ),
    "model-visible standalone output"
  );
  await deadline(
    () =>
      owner.events.some(
        (message) =>
          message.method === "item/completed" &&
          message.params.item.type === "functionCallOutput"
      ),
    "owner receives native output item"
  );
  assert.equal(
    requests.some((request) =>
      request.input.some(
        (item) =>
          item.type === "message" &&
          item.role === "user" &&
          JSON.stringify(item.content).includes(output)
      )
    ),
    false
  );
  results.push({
    check: "active delivery uses tool output, not user-role feedback",
    passed: true
  });
  await deadline(
    () =>
      owner.events.some(
        (message) =>
          message.method === "turn/completed" &&
          message.params.turn.id === original.turn.id
      ),
    "original turn completes"
  );
  const idle = await peer.call("turn/start", {
    threadId: thread.id,
    input: [],
    toolOutput
  });
  assert.notEqual(idle.turn.id, original.turn.id);
  await deadline(
    () =>
      owner.events.some(
        (message) =>
          message.method === "turn/completed" &&
          message.params.turn.id === idle.turn.id
      ),
    "idle wake completes"
  );
  results.push({
    check:
      "late standalone output starts a new turn; lifecycle policy required",
    passed: true
  });
  const before = requests.length;
  await peer.call("thread/inject_items", {
    threadId: thread.id,
    items: [
      {
        type: "function_call_output",
        name: "memory_answer",
        namespace: "koed",
        output: "Passive synthetic answer."
      }
    ]
  });
  await sleep(300);
  assert.equal(requests.length, before);
  results.push({
    check: "idle history injection does not wake the model",
    passed: true
  });

  holdNext = true;
  const cancelled = await owner.call("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "Synthetic work that will be interrupted." }]
  });
  await deadline(() => Boolean(heldResponse), "interruptible model request");
  await owner.call("turn/interrupt", {
    threadId: thread.id,
    turnId: cancelled.turn.id
  });
  await deadline(
    () =>
      owner.events.some(
        (message) =>
          message.method === "turn/completed" &&
          message.params.turn.id === cancelled.turn.id &&
          message.params.turn.status === "interrupted"
      ),
    "interruption acknowledgment"
  );
  heldResponse.response.destroy();
  heldResponse = undefined;
  const afterInterrupt = await peer.call("turn/start", {
    threadId: thread.id,
    input: [],
    toolOutput: {
      ...toolOutput,
      output: "Synthetic late answer after interruption."
    }
  });
  assert.notEqual(afterInterrupt.turn.id, cancelled.turn.id);
  await deadline(
    () =>
      owner.events.some(
        (message) =>
          message.method === "turn/completed" &&
          message.params.turn.id === afterInterrupt.turn.id
      ),
    "unfenced post-interruption result completes"
  );
  results.push({
    check:
      "unfenced tool output restarts interrupted work; not safe as a default",
    passed: true
  });

  holdNext = true;
  const newer = await owner.call("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "A newer synthetic user request." }]
  });
  await deadline(() => Boolean(heldResponse), "newer active turn");
  const late = await peer.call("turn/start", {
    threadId: thread.id,
    input: [],
    toolOutput: {
      ...toolOutput,
      output: "Synthetic answer from an older request."
    }
  });
  assert.equal(late.turn.id, newer.turn.id);
  finishResponse(heldResponse.response, heldResponse.id);
  heldResponse = undefined;
  await deadline(
    () =>
      owner.events.some(
        (message) =>
          message.method === "turn/completed" &&
          message.params.turn.id === newer.turn.id
      ),
    "newer turn completes"
  );
  results.push({
    check: "tool output has no original-turn fence and can enter a newer turn",
    passed: true
  });

  const duplicateText = "Synthetic duplicate delivery.";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pushedDuplicate = await peer.call("turn/start", {
      threadId: thread.id,
      input: [],
      toolOutput: { ...toolOutput, output: duplicateText }
    });
    await deadline(
      () =>
        owner.events.some(
          (message) =>
            message.method === "turn/completed" &&
            message.params.turn.id === pushedDuplicate.turn.id
        ),
      "duplicate delivery completes"
    );
  }
  assert.equal(
    requests
      .at(-1)
      .input.filter(
        (item) =>
          item.type === "function_call_output" && item.output === duplicateText
      ).length,
    2
  );
  results.push({
    check: "native tool output does not deduplicate submissions",
    passed: true
  });
  await assert.rejects(
    peer.call("turn/start", {
      threadId: "00000000-0000-4000-8000-000000000000",
      input: [],
      toolOutput
    }),
    /not found|not loaded|unknown|no thread/i
  );
  results.push({
    check: "an unloaded thread ID cannot receive a pushed output",
    passed: true
  });
  toolCallNext = true;
  const foreground = await owner.call("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "Synthetic foreground tool request." }]
  });
  await deadline(
    () =>
      owner.serverRequests.some(
        (request) =>
          request.method === "item/tool/call" &&
          request.params.turnId === foreground.turn.id
      ),
    "native foreground tool call"
  );
  const toolRequest = owner.serverRequests.find(
    (request) =>
      request.method === "item/tool/call" &&
      request.params.turnId === foreground.turn.id
  );
  const beforeToolDelivery = requests.length;
  const foregroundOutput = "Synthetic compact answer during foreground tool.";
  const duringTool = await peer.call("turn/start", {
    threadId: thread.id,
    input: [],
    toolOutput: { ...toolOutput, output: foregroundOutput }
  });
  assert.equal(duringTool.turn.id, foreground.turn.id);
  await sleep(300);
  assert.equal(requests.length, beforeToolDelivery);
  owner.respond(toolRequest.id, {
    contentItems: [
      { type: "inputText", text: "Synthetic foreground tool finished." }
    ],
    success: true
  });
  await deadline(
    () =>
      requests.some((request) =>
        request.input.some(
          (item) =>
            item.type === "function_call_output" &&
            item.output === foregroundOutput
        )
      ),
    "model reads pushed output after foreground tool returns"
  );
  await deadline(
    () =>
      owner.events.some(
        (message) =>
          message.method === "turn/completed" &&
          message.params.turn.id === foreground.turn.id
      ),
    "foreground tool turn completes"
  );
  results.push({
    check:
      "native answer queues during a foreground tool and reaches the next model request",
    passed: true
  });
  const background = await owner.call("thread/start", {
    cwd: root,
    model: "koed-test-model",
    modelProvider: "koed_test",
    approvalPolicy: "never",
    sandbox: "read-only",
    config: { "features.code_mode": true, "features.code_mode_interrupt": true }
  });
  const emitExec = (callId, input) => {
    modelItem = {
      type: "custom_tool_call",
      call_id: callId,
      name: "exec",
      input
    };
  };
  const awaitTurn = async (turnId) =>
    deadline(
      () =>
        owner.events.some(
          (message) =>
            message.method === "turn/completed" &&
            message.params.turn.id === turnId
        ),
      "background tool turn completion"
    );
  const firstBackgroundRequest = requests.length;
  emitExec(
    "native-memory-start",
    '// @exec: {"yield_time_ms": 10}\nconst answer = await tools.mcp__synthetic__memory_answer({delivery_mode: "blocking"}); for (const item of answer.content) { if (item.type === "text") text(item.text); }'
  );
  const startedBackground = await owner.call("turn/start", {
    threadId: background.thread.id,
    input: [{ type: "text", text: "Start synthetic recall and yield." }]
  });
  await deadline(
    () => Boolean(pendingMcp),
    "ordinary MCP call starts inside native cell"
  );
  await awaitTurn(startedBackground.turn.id);
  const yielded = requests
    .slice(firstBackgroundRequest)
    .flatMap((request) => request.input)
    .find(
      (item) =>
        item.type === "custom_tool_call_output" &&
        item.call_id === "native-memory-start"
    );
  const cellId = JSON.stringify(yielded?.output).match(
    /Script running with cell ID ([A-Za-z0-9_-]+)/
  )?.[1];
  assert.ok(cellId, "Native exec must yield a live cell ID");
  results.push({
    check:
      "ordinary MCP call remains pending after native exec yields and original turn ends",
    passed: true
  });
  emitExec(
    "independent-work",
    "text(await tools.mcp__synthetic__independent_check({}));"
  );
  const independent = await owner.call("turn/start", {
    threadId: background.thread.id,
    input: [{ type: "text", text: "Do independent synthetic work." }]
  });
  await awaitTurn(independent.turn.id);
  assert.ok(
    requests
      .at(-1)
      .input.some(
        (item) =>
          item.type === "custom_tool_call_output" &&
          item.call_id === "independent-work" &&
          JSON.stringify(item.output).includes("Independent work completed")
      )
  );
  results.push({
    check:
      "main agent can execute independent native work while ordinary MCP remains pending",
    passed: true
  });
  const beforeMcpCompletion = requests.length;
  const compactAnswer =
    "Synthetic memory answer returned by the original MCP call.";
  pendingMcp.reply({
    content: [{ type: "text", text: compactAnswer }],
    _meta: { privateObserverValue: "synthetic-private-observer-metadata" }
  });
  pendingMcp = undefined;
  await sleep(500);
  assert.equal(requests.length, beforeMcpCompletion);
  results.push({
    check:
      "background MCP completion does not automatically wake an idle model",
    passed: true
  });
  modelItem = {
    type: "function_call",
    call_id: "native-memory-wait",
    name: "wait",
    arguments: JSON.stringify({ cell_id: cellId, yield_time_ms: 1000 })
  };
  const collected = await owner.call("turn/start", {
    threadId: background.thread.id,
    input: [
      { type: "text", text: "Collect the original synthetic recall result." }
    ]
  });
  await awaitTurn(collected.turn.id);
  assert.ok(
    requests
      .at(-1)
      .input.some(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === "native-memory-wait" &&
          JSON.stringify(item.output).includes(compactAnswer)
      )
  );
  assert.equal(
    requests
      .at(-1)
      .input.some(
        (item) =>
          item.role === "user" &&
          JSON.stringify(item.content).includes(compactAnswer)
      ),
    false
  );
  results.push({
    check:
      "native wait collects original compact MCP result as tool output, not user feedback",
    passed: true
  });
  assert.equal(
    JSON.stringify(requests.at(-1).input).includes(
      "synthetic-private-observer-metadata"
    ),
    false
  );
  results.push({
    check: "text-only collection excludes private MCP observer metadata",
    passed: true
  });
  emitExec(
    "cancelled-memory-start",
    '// @exec: {"yield_time_ms": 10}\nconst answer = await tools.mcp__synthetic__memory_answer({delivery_mode: "blocking"}); for (const item of answer.content) { if (item.type === "text") text(item.text); }'
  );
  holdNext = true;
  const interruptible = await owner.call("turn/start", {
    threadId: background.thread.id,
    input: [
      { type: "text", text: "Start recall then interrupt its active turn." }
    ]
  });
  await deadline(
    () => Boolean(pendingMcp) && Boolean(heldResponse),
    "pending recall and interruptible active sample"
  );
  await owner.call("turn/interrupt", {
    threadId: background.thread.id,
    turnId: interruptible.turn.id
  });
  await awaitTurn(interruptible.turn.id);
  heldResponse.response.destroy();
  heldResponse = undefined;
  const afterNativeInterrupt = requests.length;
  const interruptedAnswer =
    "Synthetic answer that must not be presented after interruption.";
  pendingMcp.reply({ content: [{ type: "text", text: interruptedAnswer }] });
  pendingMcp = undefined;
  await sleep(500);
  assert.equal(requests.length, afterNativeInterrupt);
  results.push({
    check:
      "interrupted native background recall does not restart the idle model",
    passed: true
  });
  console.log(
    JSON.stringify(
      {
        nativeServer: info.userAgent,
        inference: "synthetic localhost only",
        results
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(JSON.stringify({ completed: results, error: error.message }));
  throw error;
} finally {
  heldResponse?.response.destroy();
  for (const connection of connections) connection.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
