/* global setTimeout, Response */
// Actual Pi0.85.1 loader, extension runner and cancelled lifecycle operations.
// Completion uses the real sendCustomMessage append path with model triggering
// disabled by the fixture. No model request or normal configuration is read.
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, URL } from "node:url";
import process from "node:process";
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
const {
  SessionManager,
  SettingsManager,
  ModelRuntime,
  DefaultResourceLoader,
  createAgentSession,
  AgentSessionRuntime
} = await import(pathToFileURL(modulePath).href);
const root = mkdtempSync(join(tmpdir(), "koed-pi-cancel-sdk-"));
const previousHome = process.env.KOED_HOME,
  previousFetch = globalThis.fetch;
let session;
try {
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
  const tasks = new Map();
  let releaseThirdRead,
    earlyTreeRaceObserved = false;
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
    } else task = tasks.get(route.split("/").at(-1));
    assert.ok(task, "only fixture task routes are permitted");
    if (route === "/v1/tasks/task-2" && !earlyTreeRaceObserved)
      await new Promise((done) => {
        releaseThirdRead = done;
      });
    return new Response(JSON.stringify({ task }), { status: 200 });
  };
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false }
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "agent/auth.json"),
    modelsPath: join(root, "agent/models.json")
  });
  let cancelTransitions = true;
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager,
    additionalExtensionPaths: [
      resolve(
        dirname(new URL(import.meta.url).pathname),
        "../integrations/pi/extensions/koed.mjs"
      )
    ],
    extensionFactories: [
      (pi) => {
        for (const event of [
          "session_before_switch",
          "session_before_fork",
          "session_before_tree"
        ])
          pi.on(event, () => ({ cancel: cancelTransitions }));
        pi.on("session_tree", async (_event, ctx) => {
          if (!releaseThirdRead) return;
          tasks.get("task-2").status = "completed";
          tasks.get("task-2").version = 2;
          tasks.get("task-2").result = {
            answer: "must not enter the new branch"
          };
          releaseThirdRead();
          releaseThirdRead = undefined;
          // Allow the stale observer to settle before Koed's tree handler.
          await new Promise((done) => setTimeout(done, 400));
          assert.equal(
            ctx.sessionManager
              .getBranch()
              .some(
                (e) =>
                  e.type === "custom" &&
                  e.customType === "koed-memory-answer-receipt-v1" &&
                  e.data.taskId === "task-2"
              ),
            false
          );
          assert.equal(
            ctx.sessionManager
              .getEntries()
              .some(
                (e) =>
                  e.type === "custom" &&
                  e.customType === "koed-memory-answer-disposition-v1" &&
                  e.data.taskId === "task-2"
              ),
            false
          );
          earlyTreeRaceObserved = true;
        });
      }
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await loader.reload();
  assert.equal(
    loader.getExtensions().errors.length,
    0,
    JSON.stringify(loader.getExtensions().errors)
  );
  const extensions = loader.getExtensions().extensions;
  const earlyIndex = extensions.findIndex((extension) =>
    extension.handlers.has("session_before_switch")
  );
  assert.ok(earlyIndex >= 0);
  const [earlyExtension] = extensions.splice(earlyIndex, 1);
  extensions.unshift(earlyExtension);
  const manager = SessionManager.create(root, join(root, "sessions"));
  const userId = manager.appendMessage({
    role: "user",
    content: "generated lifecycle fixture",
    timestamp: Date.now()
  });
  const created = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    sessionManager: manager,
    tools: ["memory_answer"]
  });
  session = created.session;
  const sendCustomMessage = session.sendCustomMessage.bind(session);
  const enqueueOptions = [];
  session.sendCustomMessage = (message, options) => {
    enqueueOptions.push(options);
    return sendCustomMessage(message, { ...options, triggerTurn: false });
  };
  await session.bindExtensions({});
  const runtime = new AgentSessionRuntime(
    session,
    { cwd: root, agentDir: join(root, "agent") },
    () => {
      throw new Error("cancelled transition must not replace runtime");
    }
  );
  const tool = session.extensionRunner
    .getAllRegisteredTools()
    .find((t) => t.definition.name === "memory_answer").definition;
  const first = await tool.execute(
    "before-cancel",
    { query: "generated pending question" },
    undefined,
    undefined,
    session.extensionRunner.createContext()
  );
  assert.equal(first.details.accepted, true);
  assert.deepEqual(
    await runtime.switchSession(join(root, "never-opened.jsonl")),
    { cancelled: true }
  );
  assert.equal((await runtime.fork(userId)).cancelled, true);
  // Navigate to an actual historical entry so the SDK reaches before_tree.
  manager.appendMessage({
    role: "user",
    content: "generated second leaf",
    timestamp: Date.now()
  });
  assert.equal((await session.navigateTree(userId)).cancelled, true);
  assert.equal(manager.getSessionId(), first.details.conversation);
  tasks.get("task-0").status = "completed";
  tasks.get("task-0").version = 2;
  tasks.get("task-0").result = {
    answer: "generated completion after cancellations"
  };
  const waitCompletion = async (count) => {
    for (let i = 0; i < 40 && enqueueOptions.length < count; i++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(enqueueOptions.length, count);
  };
  await waitCompletion(1);
  assert.deepEqual(enqueueOptions[0], {
    deliverAs: "followUp",
    triggerTurn: true
  });
  const second = await tool.execute(
    "after-cancel",
    { query: "generated new question" },
    undefined,
    undefined,
    session.extensionRunner.createContext()
  );
  assert.equal(second.details.accepted, true);
  tasks.get("task-1").status = "completed";
  tasks.get("task-1").version = 2;
  tasks.get("task-1").result = { answer: "new callback remains active" };
  await waitCompletion(2);
  assert.equal(
    manager
      .getBranch()
      .filter(
        (e) =>
          e.type === "custom_message" &&
          e.customType === "koed-memory-answer-completion"
      ).length,
    2
  );
  const third = await tool.execute(
    "before-tree-commit",
    { query: "generated abandoned branch question" },
    undefined,
    undefined,
    session.extensionRunner.createContext()
  );
  assert.equal(
    typeof releaseThirdRead,
    "function",
    "fixture must hold the in-flight third task read"
  );
  const outgoingLeaf = manager.getLeafId();
  cancelTransitions = false;
  assert.equal((await session.navigateTree(userId)).cancelled, false);
  assert.equal(earlyTreeRaceObserved, true);
  tasks.get("task-2").status = "completed";
  tasks.get("task-2").version = 2;
  tasks.get("task-2").result = { answer: "must not enter the new branch" };
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(enqueueOptions.length, 2);
  assert.ok(
    manager
      .getEntries()
      .some(
        (e) =>
          e.type === "custom" &&
          e.customType === "koed-memory-answer-disposition-v1" &&
          e.data.taskId === third.details.taskId
      )
  );
  assert.equal((await session.navigateTree(outgoingLeaf)).cancelled, false);
  await session.extensionRunner.emit({
    type: "session_start",
    reason: "reload"
  });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(
    enqueueOptions.length,
    2,
    "abandoned pending receipt must not recover on its old branch"
  );
  await runtime.dispose();
  session = undefined;
  process.stdout.write(
    JSON.stringify({
      sdk: modulePath,
      sdkVersion: JSON.parse(
        readFileSync(join(dirname(modulePath), "../package.json"), "utf8")
      ).version,
      productionExtensionLoader: true,
      cancelledSwitch: true,
      cancelledFork: true,
      cancelledTree: true,
      pendingCompletion: true,
      newInvocationAfterCancel: true,
      committedTreeSuppressesOutgoingBranch: true,
      earlierAsyncTreeHandlerRace: true,
      realCustomMessageAppend: true,
      modelTriggerFixtureDisabled: true
    }) + "\n"
  );
} finally {
  session?.dispose();
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.KOED_HOME;
  else process.env.KOED_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}
