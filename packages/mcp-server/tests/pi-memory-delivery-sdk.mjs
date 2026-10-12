// Executable actual SDK lifecycle check. No model or normal Memory access.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  createPiMemoryDelivery,
  RECEIPT,
  DISPOSITION,
  COMPLETION
} from "../integrations/pi/pi-memory-delivery.mjs";
const require = createRequire(import.meta.url);
let modulePath = process.env.KOED_TEST_PI_SDK_MODULE;
if (!modulePath) {
  try {
    modulePath = require.resolve("@earendil-works/pi-coding-agent");
  } catch {
    modulePath =
      "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
  }
}
if (!existsSync(modulePath))
  throw new Error(
    "Actual Pi SDK unavailable; set KOED_TEST_PI_SDK_MODULE to its dist/index.js"
  );
const { SessionManager } = await import(pathToFileURL(modulePath).href);
const root = mkdtempSync(join(tmpdir(), "koed-pi-delivery-sdk-"));
const expiresAt = new Date(Date.now() + 60000).toISOString();
const tasks = new Map();
const port = {
  scope: join(root, "koed"),
  async start(_input, _caller, invocationKey) {
    const task = {
      id: `task-${tasks.size}`,
      invocationKey,
      status: "running",
      version: 1,
      expiresAt
    };
    tasks.set(task.id, task);
    return task;
  },
  async get(id) {
    return tasks.get(id);
  },
  async cancel() {
    throw new Error("detach must never cancel");
  }
};
const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "generated assistant" }],
  api: "openai-responses",
  provider: "openai",
  model: "generated",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: "stop",
  timestamp: Date.now()
};
let manager;
let sent = 0;
const ctx = () => ({ cwd: root, sessionManager: manager });
const pi = {
  appendEntry(type, data) {
    manager.appendCustomEntry(type, data);
  },
  sendMessage(message, options) {
    assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
    sent++;
    manager.appendCustomMessageEntry(
      message.customType,
      message.content,
      message.display,
      message.details
    );
  }
};
const create = () =>
  createPiMemoryDelivery(pi, {
    port,
    blocking: async () => ({ markdown: "blocking" }),
    pollMs: 25
  });
try {
  manager = SessionManager.create(root, join(root, "sessions"));
  // Pi buffers brand-new histories until first assistant: explicitly reproduce
  // this limit rather than claiming custom entries are immediately durable.
  const first = create();
  first.start({ reason: "startup" }, ctx());
  await first.execute(
    "buffered",
    { query: "generated first question" },
    undefined,
    ctx()
  );
  assert.equal(existsSync(manager.getSessionFile()), false);
  manager.appendMessage(assistant);
  const originalFile = manager.getSessionFile(),
    originalId = manager.getSessionId();
  assert.ok(readFileSync(originalFile, "utf8").includes(RECEIPT));
  first.detach();
  // Fresh adapter and actual file reopen prove recovery after process loss.
  manager = SessionManager.open(originalFile);
  assert.equal(manager.getSessionId(), originalId);
  tasks.get("task-0").status = "completed";
  tasks.get("task-0").version = 2;
  tasks.get("task-0").result = { markdown: "generated result" };
  const resumed = create();
  resumed.start({ reason: "resume" }, ctx());
  await resumed.settle();
  assert.equal(sent, 1);
  assert.ok(
    manager
      .getBranch()
      .some((e) => e.type === "custom_message" && e.customType === COMPLETION)
  );
  assert.ok(
    manager
      .getBranch()
      .some((e) => e.type === "custom" && e.customType === DISPOSITION)
  );
  resumed.detach();
  manager = SessionManager.open(originalFile);
  const repeated = create();
  repeated.start({ reason: "reload" }, ctx());
  await repeated.settle();
  assert.equal(sent, 1);
  // ForkFrom copies receipts but assigns a new Conversation. Even startup on
  // that copied history must not observe or deliver the parent's pending task.
  await repeated.execute(
    "pending-fork",
    { query: "generated fork question" },
    undefined,
    ctx()
  );
  repeated.detach();
  manager = SessionManager.forkFrom(
    originalFile,
    root,
    join(root, "fork-sessions")
  );
  assert.notEqual(manager.getSessionId(), originalId);
  assert.ok(
    manager
      .getEntries()
      .some((e) => e.type === "custom" && e.customType === RECEIPT)
  );
  tasks.get("task-1").status = "completed";
  tasks.get("task-1").version = 2;
  tasks.get("task-1").result = { markdown: "parent result" };
  const forked = create();
  forked.start({ reason: "startup" }, ctx());
  await forked.settle();
  assert.equal(sent, 1);
  // Current-branch receipt exclusion is confirmed with actual branch movement.
  manager = SessionManager.open(originalFile);
  const before = manager.getBranch().find((e) => e.type === "message").id;
  manager.branch(before);
  const branched = create();
  branched.start({ reason: "resume" }, ctx());
  await branched.settle();
  assert.equal(sent, 1);
  process.stdout.write(
    JSON.stringify({
      sdk: modulePath,
      sdkVersion: JSON.parse(
        readFileSync(join(dirname(modulePath), "../package.json"), "utf8")
      ).version,
      persistentResume: true,
      duplicateSuppression: true,
      forkSuppression: true,
      branchSuppression: true,
      initialBufferLimitObserved: true
    }) + "\n"
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
