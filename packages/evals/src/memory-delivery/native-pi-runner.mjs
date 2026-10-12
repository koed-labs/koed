/* global Response, Headers, setTimeout */
import console from "node:console";
import { createRequire } from "node:module";
import { randomInt, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL, URL } from "node:url";
import process from "node:process";
import {
  scoreDeliveryRun,
  scoreAttributedDeliveryRun,
  deliveryScenarios
} from "./benchmark.mjs";
import { recordEvent } from "./fixture-data.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const selected = option("--case")?.split(",") ?? ["delayed"];
if (
  selected.some(
    (s) => ![...deliveryScenarios, "mixed", "concurrent"].includes(s)
  )
)
  throw new Error("Unknown Pi delivery scenario");
const modulePath =
  option("--sdk") ??
  process.env.KOED_TEST_PI_SDK_MODULE ??
  "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
if (!existsSync(modulePath)) throw new Error("Installed Pi SDK is required");
const sdk = await import(pathToFileURL(modulePath).href);
const sdkRequire = createRequire(modulePath);
const { Type } = await import(
  pathToFileURL(sdkRequire.resolve("typebox")).href
);
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(modulePath), "../package.json"), "utf8")
).version;
const root = mkdtempSync(join(tmpdir(), "koed-native-pi-"));
const koedHome = join(root, "koed");
const installed = join(koedHome, "integrations", "pi");
cpSync(
  new URL("../../../mcp-server/integrations/pi", import.meta.url),
  installed,
  { recursive: true }
);
mkdirSync(join(installed, "node_modules"), { recursive: true });
let peer = dirname(sdkRequire.resolve("typebox"));
while (
  !existsSync(join(peer, "package.json")) ||
  JSON.parse(readFileSync(join(peer, "package.json"), "utf8")).name !==
    "typebox"
) {
  const parent = dirname(peer);
  if (parent === peer)
    throw new Error("Installed typebox peer root is unavailable");
  peer = parent;
}
symlinkSync(peer, join(installed, "node_modules", "typebox"), "dir");
mkdirSync(join(koedHome, "run"), { recursive: true, mode: 0o700 });
writeFileSync(
  join(koedHome, "run", "local-ai-runtime.json"),
  JSON.stringify({
    protocolVersion: 1,
    url: "http://127.0.0.1:1",
    authorization: `Bearer ${"f".repeat(48)}`,
    pid: process.pid,
    startedAt: new Date().toISOString()
  }),
  { mode: 0o600 }
);
const originalFetch = globalThis.fetch;
const originalHome = process.env.KOED_HOME,
  originalMode = process.env.KOED_PI_MEMORY_ANSWER_MODE;
process.env.KOED_HOME = koedHome;
process.env.KOED_PI_MEMORY_ANSWER_MODE = "auto";
const sourceAgentDir =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const defaultsPath = join(sourceAgentDir, "settings.json");
const defaults = existsSync(defaultsPath)
  ? JSON.parse(readFileSync(defaultsPath, "utf8"))
  : {};
const runtime = await sdk.ModelRuntime.create({
  authPath: join(sourceAgentDir, "auth.json"),
  modelsPath: join(sourceAgentDir, "models.json"),
  modelsStorePath: join(root, "model-store.json"),
  allowModelNetwork: true
});
const provider = option("--provider") ?? defaults.defaultProvider;
const modelId = option("--model") ?? defaults.defaultModel;
const available = await runtime.getAvailable(provider);
const model = modelId ? available.find((m) => m.id === modelId) : available[0];
if (!model) {
  console.error(
    JSON.stringify({
      configuredProvider: provider,
      configuredModel: modelId,
      configuredAuth: runtime.hasConfiguredAuth(provider),
      availableModelIds: available.map((m) => m.id)
    })
  );
  throw new Error("The configured Pi model is not available or authenticated");
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function runScenario(scenario) {
  const workspace = join(root, scenario);
  mkdirSync(workspace);
  const expectedSettings = {
    retryDelayMs: randomInt(1200, 9000),
    cacheAuthorization: false
  };
  const attributed = ["mixed", "concurrent"].includes(scenario);
  const settingsByTarget = {
    alpha: expectedSettings,
    beta: {
      retryDelayMs: expectedSettings.retryDelayMs + 10000,
      cacheAuthorization: false
    }
  };
  const targetFromQuery = (query) =>
    /\bbeta\b/i.test(query ?? "") ? "beta" : "alpha";
  const settingsPath = (target) =>
    join(workspace, attributed ? `${target}.json` : "import-settings.json");
  const fixture = { eventsPath: join(workspace, "events.jsonl") };
  const memoryMarkdown =
    scenario === "not_found"
      ? "No prior implementation decision was found."
      : `Retained decision: set retryDelayMs to ${expectedSettings.retryDelayMs} and cacheAuthorization to false. Preserve authentication checks.`;
  const answerFor = (target) =>
    attributed
      ? `Retained decision for ${target}: set retryDelayMs to ${settingsByTarget[target].retryDelayMs} and cacheAuthorization to false. Preserve authentication checks.`
      : memoryMarkdown;
  writeFileSync(
    join(workspace, "import-settings.json"),
    JSON.stringify({ retryDelayMs: 300, cacheAuthorization: true })
  );
  if (attributed)
    for (const target of ["alpha", "beta"])
      writeFileSync(
        settingsPath(target),
        JSON.stringify({ retryDelayMs: 300, cacheAuthorization: true })
      );
  writeFileSync(
    join(workspace, "failure.txt"),
    "The import timed out after a temporary connection failure. Current retryDelayMs=300 and cacheAuthorization=true.\n"
  );
  const tasks = new Map();
  let session,
    releaseDiagnostic,
    stopped = false,
    agentStartsAtStop;
  const complete = () => {
    for (const task of tasks.values()) {
      if (task.status !== "running") continue;
      task.status = scenario === "failed" ? "failed" : "completed";
      task.version++;
      task.result =
        task.status === "failed" ? null : { markdown: answerFor(task.target) };
      recordEvent(fixture, "task_terminal", { target: task.target });
    }
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    if (url.origin !== "http://127.0.0.1:1") return originalFetch(input, init);
    if (
      new Headers(init?.headers).get("authorization") !==
      `Bearer ${"f".repeat(48)}`
    )
      throw new Error("Fixture authorization mismatch");
    let task;
    if (url.pathname === "/v1/tasks/memory-answer") {
      const request = JSON.parse(init.body);
      if (Object.hasOwn(request.input, "delivery_mode"))
        throw new Error("Presentation input reached execution");
      task = {
        id: randomUUID(),
        invocationKey: request.invocationKey,
        status: "running",
        version: 1,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        target: targetFromQuery(request.input.query)
      };
      tasks.set(task.id, task);
      if (scenario === "fast") complete();
    } else if (url.pathname === "/v1/tools/memory_answer") {
      const request = JSON.parse(init.body);
      if (Object.hasOwn(request.input, "delivery_mode"))
        throw new Error("Presentation input reached execution");
      recordEvent(fixture, "completion", {
        outcome: "found",
        route: "pi_blocking",
        target: targetFromQuery(request.input.query)
      });
      return new Response(
        JSON.stringify({
          markdown: answerFor(targetFromQuery(request.input.query))
        }),
        {
          status: 200
        }
      );
    } else {
      task = tasks.get(url.pathname.split("/").at(-1));
    }
    if (!task) throw new Error("Unexpected fixture task request");
    return new Response(JSON.stringify({ task }), { status: 200 });
  };
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false }
  });
  const manager = sdk.SessionManager.create(
    workspace,
    join(workspace, "sessions")
  );
  const loader = new sdk.DefaultResourceLoader({
    cwd: workspace,
    agentDir: join(workspace, "agent"),
    settingsManager,
    additionalExtensionPaths: [join(installed, "extensions", "koed.mjs")],
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await loader.reload();
  if (loader.getExtensions().errors.length)
    throw new Error("The installed Koed extension could not load");
  const tools = [
    {
      name: "inspect_failure",
      label: "Inspect failure",
      description:
        "Read the current import failure. This useful diagnostic is independent of the previous implementation decision.",
      parameters: Type.Object({}),
      execute: async () => {
        recordEvent(fixture, "diagnostic_read");
        if (scenario === "interrupted") {
          complete();
          await new Promise((done) => {
            releaseDiagnostic = done;
          });
        }
        return {
          content: [
            {
              type: "text",
              text: readFileSync(join(workspace, "failure.txt"), "utf8")
            }
          ],
          details: {}
        };
      }
    },
    {
      name: "apply_fix",
      label: "Apply fix",
      description:
        "Save the import settings chosen from the previous implementation decision.",
      parameters: Type.Object({
        retryDelayMs: Type.Number(),
        cacheAuthorization: Type.Boolean(),
        ...(attributed
          ? {
              target: Type.Union([Type.Literal("alpha"), Type.Literal("beta")])
            }
          : {})
      }),
      execute: async (_id, params) => {
        recordEvent(fixture, "dependent_action", {
          target: params.target ?? "alpha"
        });
        writeFileSync(
          settingsPath(params.target ?? "alpha"),
          JSON.stringify(params)
        );
        return {
          content: [{ type: "text", text: "Fixture settings saved." }],
          details: {}
        };
      }
    }
  ];
  const created = await sdk.createAgentSession({
    cwd: workspace,
    agentDir: join(workspace, "agent"),
    resourceLoader: loader,
    modelRuntime: runtime,
    settingsManager,
    sessionManager: manager,
    model,
    customTools: tools,
    tools: ["memory_answer", "inspect_failure", "apply_fix"]
  });
  session = created.session;
  await session.bindExtensions({
    mode: scenario === "fallback" ? "print" : "interactive"
  });
  let agentStarts = 0,
    modelError = false;
  session.subscribe((event) => {
    if (event.type === "agent_start") agentStarts++;
    if (event.type === "agent_settled")
      recordEvent(fixture, "agent_settled", {
        aborted: Boolean(event.aborted)
      });
    if (
      event.type === "tool_execution_start" &&
      event.toolName === "memory_answer"
    )
      recordEvent(fixture, "recall_requested", {
        mode: event.args?.delivery_mode ?? "auto",
        target: targetFromQuery(event.args?.query)
      });
    if (
      event.type === "tool_execution_end" &&
      event.toolName === "memory_answer" &&
      event.result?.details?.accepted
    )
      recordEvent(fixture, "receipt");
    if (event.type !== "message_end") return;
    const message = event.message;
    if (
      message.role === "custom" &&
      message.customType === "koed-memory-answer-completion"
    ) {
      const content =
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      const target = tasks.get(message.details?.taskId)?.target ?? "alpha";
      recordEvent(fixture, "completion", {
        outcome: content.includes(answerFor(target))
          ? scenario === "not_found"
            ? "not_found"
            : "found"
          : "failed",
        route: "pi_follow_up",
        target
      });
    }
    if (message.role === "assistant") {
      if (message.stopReason === "error" && !stopped) modelError = true;
      const content = (message.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      try {
        const result = JSON.parse(content);
        if (
          ["waiting_for_memory", "fixed", "blocked"].includes(result.status)
        ) {
          recordEvent(fixture, "final_response", { status: result.status });
          if (result.status === "waiting_for_memory") {
            recordEvent(fixture, "yield");
            if (scenario !== "interrupted") complete();
          }
        }
      } catch {
        /* Only structured final statuses are completion-claim evidence. */
      }
    }
  });
  const events = () =>
    existsSync(fixture.eventsPath)
      ? readFileSync(fixture.eventsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((s) => JSON.parse(s))
      : [];
  const until = async (condition, timeoutMs = 120000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (modelError || Date.now() > deadline)
        throw new Error("Native Pi scenario did not complete");
      await delay(25);
    }
  };
  try {
    const prompt = attributed
      ? [
          "Configure the alpha and beta import settings from their respective previous decisions. Query memory once per target and name alpha or beta explicitly in each query. Use apply_fix with its target parameter; the recalled values differ, so associate each answer with its own target.",
          scenario === "mixed"
            ? "Alpha diagnostics are already collected; the next action is its memory-dependent decision, so finish alpha first. Then check beta's memory while collecting independent diagnostics with inspect_failure."
            : "Start both recalls before choosing either fix. The next planned action is independent diagnostics with inspect_failure; both prior decisions can arrive later.",
          "Choose delivery from each next action. Do not guess settings or repeat recall. Return a JSON status waiting_for_memory when necessary, and fixed only after both targets have their correct saved settings."
        ].join("\n")
      : [
          "Fix the import settings according to our previous implementation decision. Start by checking prior memory once with memory_answer and choose delivery from the next planned action.",
          scenario === "blocking"
            ? "Diagnostics are already collected: the import timed out after a temporary connection failure. The next action is to choose the settings from the previous decision; no diagnostic read is needed."
            : "The next planned action is the useful independent read through inspect_failure. Perform it while waiting if delivery permits, then use the retained decision before choosing the fix.",
          "Use apply_fix to save retryDelayMs and cacheAuthorization. If the prior decision is unavailable, report the blocker rather than guessing. Return a single JSON object with status waiting_for_memory while yielding, fixed only after applying the correct settings, or blocked when the prerequisite is unavailable."
        ].join("\n");
    const initial = session.prompt(prompt).catch(() => {
      if (!stopped) modelError = true;
    });
    if (scenario === "interrupted") {
      await until(
        () =>
          releaseDiagnostic &&
          manager
            .getEntries()
            .some(
              (e) =>
                e.type === "custom" &&
                e.customType === "koed-memory-answer-disposition-v1" &&
                e.data?.disposition === "enqueued"
            )
      );
      stopped = true;
      recordEvent(fixture, "interruption");
      agentStartsAtStop = agentStarts;
      session.clearQueue();
      const abort = session.abort();
      releaseDiagnostic();
      await abort;
      await initial;
      await until(
        () =>
          manager
            .getEntries()
            .some(
              (e) =>
                e.type === "custom_message" &&
                e.customType === "koed-memory-answer-completion"
            ),
        10000
      );
    } else {
      await until(() =>
        events().some(
          (e) =>
            e.kind === "final_response" &&
            ["fixed", "blocked"].includes(e.status)
        )
      );
      await initial;
      await session.waitForIdle();
    }
    const actualSettings = JSON.parse(
      readFileSync(join(workspace, "import-settings.json"), "utf8")
    );
    const actualByTarget = attributed
      ? Object.fromEntries(
          ["alpha", "beta"].map((target) => [
            target,
            JSON.parse(readFileSync(settingsPath(target), "utf8"))
          ])
        )
      : null;
    const score = attributed
      ? scoreAttributedDeliveryRun({
          scenario,
          events: events(),
          expectedSettings: settingsByTarget,
          actualSettings: actualByTarget
        })
      : scoreDeliveryRun({
          scenario,
          host: "pi",
          events: events(),
          expectedSettings,
          actualSettings,
          exitCode: 0
        });
    const savedCompletions = manager
      .getEntries()
      .filter(
        (e) =>
          e.type === "custom_message" &&
          e.customType === "koed-memory-answer-completion"
      ).length;
    if (scenario === "interrupted") {
      score.checks.noRevivalAfterStop = agentStarts === agentStartsAtStop;
      score.checks.quietSavedRecovery = savedCompletions === 1;
      score.passed = Object.values(score.checks).every(Boolean);
    }
    return {
      scenario,
      sdkVersion,
      model: { provider: model.provider, id: model.id },
      setup: {
        installedStandalonePackage: true,
        persistentConversation: true,
        mode: scenario === "fallback" ? "print" : "interactive",
        syntheticTaskRuntime: true,
        normalCredentialCustody: true
      },
      events: events(),
      expectedSettings: attributed ? settingsByTarget : expectedSettings,
      actualSettings: attributed ? actualByTarget : actualSettings,
      savedCompletions,
      ...score
    };
  } catch (error) {
    return {
      scenario,
      sdkVersion,
      model: { provider: model.provider, id: model.id },
      events: events(),
      passed: false,
      checks: { nativeScenarioCompleted: false },
      failureStage: stopped ? "quiet_recovery" : "agent_run",
      failureClass: error instanceof Error ? error.name : "unknown",
      agentStarts,
      pendingMessages: session.pendingMessageCount,
      savedCompletions: manager
        .getEntries()
        .filter(
          (e) =>
            e.type === "custom_message" &&
            e.customType === "koed-memory-answer-completion"
        ).length,
      dispositions: manager
        .getEntries()
        .filter((e) => e.customType === "koed-memory-answer-disposition-v1")
        .map((e) => e.data?.disposition)
    };
  } finally {
    releaseDiagnostic?.();
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "exit"
    });
    await session.abort();
    session.dispose();
  }
}

try {
  const runs = [];
  for (const scenario of selected) {
    console.error(`Running native Pi delivery: ${scenario}`);
    runs.push(await runScenario(scenario));
    if (option("--out"))
      writeFileSync(
        resolve(option("--out")),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            runs,
            passed: runs.every((r) => r.passed)
          },
          null,
          2
        ) + "\n"
      );
  }
  const report = {
    generatedAt: new Date().toISOString(),
    runs,
    passed: runs.every((r) => r.passed)
  };
  if (option("--out"))
    writeFileSync(
      resolve(option("--out")),
      JSON.stringify(report, null, 2) + "\n"
    );
  else process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (!report.passed) process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.KOED_HOME;
  else process.env.KOED_HOME = originalHome;
  if (originalMode === undefined) delete process.env.KOED_PI_MEMORY_ANSWER_MODE;
  else process.env.KOED_PI_MEMORY_ANSWER_MODE = originalMode;
  rmSync(root, { recursive: true, force: true });
}
