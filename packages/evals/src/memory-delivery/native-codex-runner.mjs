/* global setTimeout, clearTimeout */
import console from "node:console";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { deliveryScenarios, scoreDeliveryRun } from "./benchmark.mjs";
import { recordEvent } from "./fixture-data.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const selected = option("--case")?.split(",") ?? ["delayed"];
if (selected.some((s) => !deliveryScenarios.includes(s)))
  throw new Error("Unknown delivery scenario");
const binary = option("--codex") ?? "codex";
const model = option("--model") ?? "gpt-6.1-sol";
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const hostVersion = spawnSync(binary, ["--version"], { encoding: "utf8" });
if (hostVersion.status !== 0) throw new Error("Codex CLI version check failed");
const toml = (value) => {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([k, v]) => `${k}=${toml(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const readEvents = (fixture) =>
  existsSync(fixture.eventsPath)
    ? readFileSync(fixture.eventsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s))
    : [];

async function runScenario(scenario) {
  const root = mkdtempSync(join(tmpdir(), "koed-delivery-native-"));
  const workspace = join(root, "workspace"),
    koedHome = join(root, "koed");
  mkdirSync(workspace);
  mkdirSync(join(koedHome, "run"), { recursive: true, mode: 0o700 });
  const expectedSettings = {
    retryDelayMs: randomInt(1200, 9000),
    cacheAuthorization: false
  };
  const memoryMarkdown =
    scenario === "not_found"
      ? "No prior implementation decision was found."
      : `Retained decision: set retryDelayMs to ${expectedSettings.retryDelayMs} and cacheAuthorization to false. Preserve authentication checks.`;
  const fixture = {
    root,
    workspace,
    koedHome,
    scenario,
    expectedSettings,
    memoryMarkdown,
    eventsPath: join(root, "events.jsonl"),
    authorization: `Bearer ${randomBytes(32).toString("base64url")}`
  };
  writeFileSync(
    join(workspace, "failure.txt"),
    "The import timed out after a temporary connection failure. Current settings: retryDelayMs=300, cacheAuthorization=true.\n"
  );
  writeFileSync(
    join(workspace, "import-settings.json"),
    JSON.stringify({ retryDelayMs: 300, cacheAuthorization: true })
  );
  const tasks = new Map();
  const terminal = (task) => {
    if (task.status !== "running") return;
    const failed = scenario === "failed";
    task.status = failed ? "failed" : "completed";
    task.version++;
    task.updatedAt = new Date().toISOString();
    task.completedAt = failed ? null : task.updatedAt;
    task.failedAt = failed ? task.updatedAt : null;
    task.lastErrorCode = failed ? "fixture_failure" : null;
    task.result = failed
      ? null
      : {
          markdown: memoryMarkdown,
          localMemoryWorker: {
            status: "completed",
            memoryStatus: scenario === "not_found" ? "not_found" : "found"
          }
        };
    recordEvent(fixture, "task_terminal");
  };
  const accept = (invocationKey) => {
    for (const task of tasks.values())
      if (task.invocationKey === invocationKey) return task;
    const at = new Date().toISOString();
    const task = {
      id: randomUUID(),
      origin: "mcp",
      invocationKey,
      questionId: null,
      status: "running",
      statusMessage: null,
      attemptCount: 1,
      maxAttempts: 1,
      fenceGeneration: 1,
      cancelRequestedAt: null,
      startedAt: at,
      lastProgressAt: at,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      result: null,
      version: 1,
      createdAt: at,
      updatedAt: at,
      expiresAt: new Date(Date.now() + 120000).toISOString()
    };
    tasks.set(task.id, task);
    if (scenario === "fast") terminal(task);
    return task;
  };
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== fixture.authorization) {
        response.writeHead(401);
        response.end("{}");
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      const send = (status, value) => {
        response.writeHead(status);
        response.end(JSON.stringify(value));
      };
      if (request.url === "/v1/capabilities") {
        send(200, {
          protocolVersion: 1,
          supportedTools: ["memory_answer"],
          curatedMemoryIntakeAvailable: false
        });
      } else if (request.url === "/v1/tasks/memory-answer") {
        if (Object.hasOwn(parsed.input, "delivery_mode"))
          throw new Error("Presentation input reached execution");
        // The request itself is synthetic; the transport, authorization fence,
        // schema parsing and Codex delivery are the actual maintained adapters.
        send(202, { task: accept(parsed.invocationKey) });
      } else if (request.url === "/fixture/yield") {
        if (scenario !== "interrupted")
          for (const task of tasks.values()) terminal(task);
        send(200, {});
      } else if (request.url?.startsWith("/v1/tasks/")) {
        const task = tasks.get(request.url.split("/").at(-1));
        send(task ? 200 : 404, task ? { task } : {});
      } else if (request.url === "/v1/tools/memory_answer") {
        if (Object.hasOwn(parsed.input, "delivery_mode"))
          throw new Error("Presentation input reached execution");
        const task = accept(parsed.invocationKey);
        terminal(task);
        recordEvent(fixture, "completion", {
          outcome: "found",
          route: "mcp_result"
        });
        send(200, task.result);
      } else send(404, {});
    })().catch(() => {
      response.writeHead(500);
      response.end('{"error":"Fixture runtime failed"}');
    });
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  fixture.runtimeUrl = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(koedHome, "run", "local-ai-runtime.json"),
    JSON.stringify({
      protocolVersion: 1,
      url: fixture.runtimeUrl,
      authorization: fixture.authorization,
      pid: process.pid,
      startedAt: new Date().toISOString()
    }),
    { mode: 0o600 }
  );
  const fixturePath = join(root, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
  const schemaPath = join(root, "final-schema.json");
  writeFileSync(
    schemaPath,
    JSON.stringify({
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["waiting_for_memory", "fixed", "blocked"]
        },
        message: { type: "string" }
      },
      required: ["status", "message"],
      additionalProperties: false
    })
  );
  const hooks = {};
  {
    // These automation hooks execute the vetted local fixture wrapper around
    // runCodexMemoryHook, not user-configured or third-party hook sources.
    const command = [
      process.execPath,
      join(currentDirectory, "fixture-hook.mjs")
    ]
      .map(quote)
      .join(" ");
    for (const event of scenario === "fallback"
      ? ["PreToolUse"]
      : ["PreToolUse", "PostToolUse", "Stop", "Interrupt", "SessionEnd"])
      hooks[event] = [
        {
          ...(event === "PreToolUse"
            ? { matcher: ".*" }
            : event === "PostToolUse"
              ? { matcher: "^mcp__koed_delivery_eval__memory_answer$" }
              : {}),
          hooks: [{ type: "command", command, timeout: 10 }]
        }
      ];
  }
  const config = {
    approval_policy: "never",
    mcp_servers: {
      koed_delivery_eval: {
        command: process.execPath,
        args: [join(currentDirectory, "fixture-mcp.mjs")],
        enabled: true,
        required: true,
        default_tools_approval_mode: "approve",
        env: {
          CODEX_MCP_PROTOCOL_VERSION: "2026-07-28",
          KOED_DELIVERY_FIXTURE_PATH: fixturePath,
          KOED_HOME: koedHome,
          KOED_CODEX_STOP_DELIVERY: "1",
          KOED_CODEX_MEMORY_TOOL: "mcp__koed_delivery_eval__memory_answer",
          MEMORY_LOG_LEVEL: "silent"
        }
      }
    },
    hooks
  };
  const independent = scenario !== "blocking";
  const prompt = [
    "Fix the import settings according to our previous implementation decision. Start by checking prior memory once using memory_answer, choosing delivery from the next planned action.",
    independent
      ? "Your next planned action is the useful independent diagnostic read through inspect_failure. Read it while waiting if delivery permits, then choose the fix using the retained decision."
      : "Diagnostics are already collected: the import timed out after a temporary connection failure. Your next planned action is to choose the settings from the previous decision; no diagnostic read is needed.",
    "Use apply_fix to save the chosen retryDelayMs and cacheAuthorization. If prior memory is unavailable, report the blocker rather than guessing settings. Do not inspect evaluation infrastructure outside this workspace.",
    "Report status waiting_for_memory if yielding before the result, fixed only after applying the correct settings, or blocked if the necessary decision is unavailable."
  ].join("\n");
  const commandArgs = [
    "exec",
    "--ignore-user-config",
    "--enable",
    "mcp_2026_07_28",
    "--disable",
    "plugins",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--thread-source",
    "user",
    "--cd",
    workspace,
    "--model",
    model,
    "--output-schema",
    schemaPath
  ];
  for (const [key, value] of Object.entries(config))
    commandArgs.push("-c", `${key}=${toml(value)}`);
  commandArgs.push("--dangerously-bypass-hook-trust");
  commandArgs.push(prompt);
  let child,
    timer,
    stderr = "",
    interruptionSent = false;
  const nativeItemKinds = new Set();
  try {
    child = spawn(binary, commandArgs, {
      cwd: workspace,
      env: { ...process.env, KOED_DELIVERY_FIXTURE_PATH: fixturePath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line),
            item = event.item;
          if (item?.type) nativeItemKinds.add(item.type);
          if (
            event.type === "item.completed" &&
            item?.type === "agent_message"
          ) {
            try {
              const result = JSON.parse(item.text);
              if (
                ["waiting_for_memory", "fixed", "blocked"].includes(
                  result.status
                )
              )
                recordEvent(fixture, "final_response", {
                  status: result.status
                });
            } catch {
              /* Commentary is not a completion claim. */
            }
          }
        } catch {
          /* Only typed native events are evidence. */
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    // The test's own interruption watcher is infrastructure, never model polling.
    const interruptTimer =
      scenario === "interrupted"
        ? setTimeout(function check() {
            if (readEvents(fixture).some((e) => e.kind === "receipt")) {
              interruptionSent = true;
              recordEvent(fixture, "interruption");
              child.kill("SIGINT");
            } else if (child.exitCode === null) timer = setTimeout(check, 25);
          }, 25)
        : undefined;
    const exitCode = await new Promise((done, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Native delivery scenario timed out"));
      }, 120000);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(deadline);
        clearTimeout(interruptTimer);
        clearTimeout(timer);
        done(code);
      });
    });
    const events = readEvents(fixture);
    const actualSettings = JSON.parse(
      readFileSync(join(workspace, "import-settings.json"), "utf8")
    );
    const score = scoreDeliveryRun({
      scenario,
      events,
      expectedSettings,
      actualSettings,
      exitCode
    });
    return {
      scenario,
      hostVersion: hostVersion.stdout.trim(),
      model,
      setup: {
        protocol: "2026-07-28",
        isolatedMcpConfig: true,
        vettedAutomationHooks: true,
        deferredHookPreparation: scenario !== "fallback",
        filesystemSandbox: "read-only",
        syntheticMemory: true
      },
      events,
      expectedSettings,
      actualSettings,
      exitCode,
      interruptionSent,
      nativeItemKinds: [...nativeItemKinds],
      ...score,
      ...(exitCode !== 0 && scenario !== "interrupted"
        ? {
            failureDiagnostic: stderr.replaceAll(
              fixture.authorization,
              "[redacted]"
            )
          }
        : {})
    };
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await new Promise((done) => server.close(done));
    rmSync(root, { recursive: true, force: true });
  }
}

const runs = [];
for (const scenario of selected) {
  console.error(`Running native Codex delivery: ${scenario}`);
  runs.push(await runScenario(scenario));
}
const report = {
  generatedAt: new Date().toISOString(),
  runs,
  passed: runs.every((r) => r.passed)
};
if (option("--out"))
  writeFileSync(
    resolve(option("--out")),
    `${JSON.stringify(report, null, 2)}\n`
  );
else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
