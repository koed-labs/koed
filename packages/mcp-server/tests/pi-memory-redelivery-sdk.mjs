/* global setTimeout, Response */
// Validates recall completion delivery against the actual Pi SDK and the
// production Koed extension. A fake model streams through Pi's agent loop, and
// a fixture task runtime replaces the Local AI Runtime. No real model or memory
// service is contacted.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import process from "node:process";
import {
  COMPLETION,
  DISPOSITION
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
  throw new Error("Actual Pi SDK required; set KOED_TEST_PI_SDK_MODULE");
const piRoot = resolve(dirname(modulePath), "..");
const aiPath = [
  join(piRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
  join(piRoot, "../pi-ai/dist/compat.js")
].find(existsSync);
if (!aiPath) throw new Error("Pi AI package with the faux provider required");
const {
  SessionManager,
  SettingsManager,
  ModelRuntime,
  DefaultResourceLoader,
  createAgentSession
} = await import(pathToFileURL(modulePath).href);
const ai = await import(pathToFileURL(aiPath).href);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const extensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../integrations/pi/extensions/koed.mjs"
);
const root = mkdtempSync(join(tmpdir(), "koed-pi-redelivery-sdk-"));
const previousHome = process.env.KOED_HOME,
  previousFetch = globalThis.fetch;
const tasks = new Map();
let reads = 0;
process.env.KOED_HOME = join(root, "koed");
mkdirSync(join(process.env.KOED_HOME, "run"), { recursive: true });
writeFileSync(
  join(process.env.KOED_HOME, "run/local-ai-runtime.json"),
  JSON.stringify({
    protocolVersion: 1,
    url: "http://127.0.0.1:54321",
    authorization: `Bearer ${"a".repeat(32)}`,
    pid: 123,
    startedAt: new Date().toISOString()
  }),
  { mode: 0o600 }
);
globalThis.fetch = async (url, options) => {
  const route = new URL(url).pathname;
  let task;
  if (route === "/v1/tasks/memory-answer") {
    const request = JSON.parse(options.body);
    task = {
      id: `task-${tasks.size}`,
      invocationKey: request.invocationKey,
      status: "running",
      version: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString()
    };
    tasks.set(task.id, task);
  } else {
    task = tasks.get(route.split("/").at(-1));
    reads++;
  }
  assert.ok(task, "only fixture task routes are permitted");
  return new Response(JSON.stringify({ task }), { status: 200 });
};

const scenario = async (name, run) => {
  const dir = join(root, name);
  const faux = ai.createFauxCore({
    tokensPerSecond: 40,
    tokenSize: { min: 1, max: 1 }
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false }
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "agent/auth.json"),
    modelsPath: join(dir, "agent/models.json")
  });
  // The fake model needs no credentials; only this runtime instance is stubbed.
  modelRuntime.hasConfiguredAuth = () => true;
  modelRuntime.getAuth = async () => ({ auth: { apiKey: "fixture" } });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: join(dir, "agent"),
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    sessionManager: manager,
    model: faux.getModel(),
    tools: ["memory_answer"]
  });
  session.agent.streamFunction = faux.streamSimple;
  await session.bindExtensions({ mode: "rpc" });
  const entries = (type, customType) =>
    manager
      .getEntries()
      .filter((e) => e.type === type && e.customType === customType);
  const until = async (condition, label) => {
    for (let i = 0; i < 400 && !condition(); i++) await sleep(25);
    assert.ok(condition(), label);
  };
  try {
    await run({ session, faux, entries, until });
  } finally {
    session.dispose();
  }
};

// The model calls memory_answer, then keeps streaming independent work while
// recall runs. The task completes during that work, so the completion queues.
const busyRecall = (faux, followUps) =>
  faux.setResponses([
    ai.fauxAssistantMessage(
      ai.fauxToolCall("memory_answer", { query: "generated question" })
    ),
    ai.fauxAssistantMessage("independent work ".repeat(120)),
    ...followUps
  ]);
const completeTask = (id) => {
  const task = tasks.get(id);
  task.status = "completed";
  task.version = 2;
  task.result = { answer: `generated answer for ${id}` };
};

try {
  await scenario("normal", async ({ session, faux, entries, until }) => {
    busyRecall(faux, [ai.fauxAssistantMessage("used the answer")]);
    const run = session.prompt("start");
    await until(() => tasks.has("task-0"), "recall accepted");
    await until(() => session.isStreaming, "agent busy");
    completeTask("task-0");
    await run;
    await session.waitForIdle();
    await sleep(100);
    assert.equal(entries("custom_message", COMPLETION).length, 1);
    assert.equal(faux.getPendingResponseCount(), 0, "follow-up turn ran");
    assert.equal(
      entries("custom", DISPOSITION).filter(
        (e) => e.data.disposition === "enqueued"
      ).length,
      1
    );
  });

  await scenario("esc", async ({ session, faux, entries, until }) => {
    busyRecall(faux, [ai.fauxAssistantMessage("must not run")]);
    const run = session.prompt("start");
    await until(() => tasks.has("task-1"), "recall accepted");
    await until(() => session.isStreaming, "agent busy");
    completeTask("task-1");
    // Wait until the extension has queued the completion behind the busy run.
    await until(
      () =>
        entries("custom", DISPOSITION).some(
          (e) => e.data.taskId === "task-1" && e.data.disposition === "enqueued"
        ),
      "completion queued"
    );
    assert.ok(session.isStreaming, "completion queued while busy");
    assert.equal(entries("custom_message", COMPLETION).length, 0);
    const readsBeforeEsc = reads;
    // Esc in interactive Pi: clear every queue, then abort the run.
    session.clearQueue();
    await session.abort();
    await run.catch(() => undefined);
    await until(
      () => entries("custom_message", COMPLETION).length === 1,
      "completion redelivered after Esc"
    );
    await sleep(300);
    assert.equal(entries("custom_message", COMPLETION).length, 1);
    assert.ok(reads > readsBeforeEsc, "redelivery used a fresh task read");
    assert.equal(faux.getPendingResponseCount(), 1, "no turn after Esc");
    assert.equal(session.isStreaming, false);
    const [saved] = entries("custom_message", COMPLETION);
    assert.match(String(saved.content), /not instructions/);
    assert.equal(saved.details.taskId, "task-1");
  });

  process.stdout.write(
    JSON.stringify({
      sdk: modulePath,
      productionExtensionLoader: true,
      normalFollowUpDelivered: true,
      escRedeliveredOnceWithoutTurn: true
    }) + "\n"
  );
} finally {
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.KOED_HOME;
  else process.env.KOED_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}
