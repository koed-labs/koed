/* global setTimeout, clearTimeout */
import console from "node:console";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
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
import {
  claudeDeliveryScenarios,
  scoreClaudeDeliveryRun
} from "./benchmark.mjs";
import { recordEvent } from "./fixture-data.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const cases = option("--case")?.split(",") ?? ["background_enabled"];
if (cases.some((c) => !claudeDeliveryScenarios.includes(c)))
  throw new Error("Unknown Claude delivery case");
const binary = option("--claude") ?? "claude";
const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
if (version.status !== 0) throw new Error("Claude version check failed");
const directory = dirname(fileURLToPath(import.meta.url));

async function runCase(scenario) {
  const root = mkdtempSync(join(tmpdir(), "koed-native-claude-"));
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
    workspace,
    koedHome,
    eventsPath: join(root, "events.jsonl"),
    authorization: `Bearer ${randomBytes(32).toString("base64url")}`
  };
  writeFileSync(
    join(workspace, "failure.txt"),
    "Import timed out after a temporary connection failure. Current retryDelayMs=300 and cacheAuthorization=true.\n"
  );
  writeFileSync(
    join(workspace, "import-settings.json"),
    JSON.stringify({ retryDelayMs: 300, cacheAuthorization: true })
  );
  let accepted = 0,
    child,
    interrupted = false,
    waiterDetached = false;
  const delays = [];
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("content-type", "application/json");
      const send = (status, value) => {
        response.writeHead(status);
        response.end(JSON.stringify(value));
      };
      if (request.headers.authorization !== fixture.authorization) {
        send(401, {});
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      if (request.url === "/v1/capabilities") {
        send(200, {
          protocolVersion: 1,
          supportedTools: ["memory_answer"],
          curatedMemoryIntakeAvailable: false
        });
        return;
      }
      if (request.url !== "/v1/tools/memory_answer") {
        send(404, {});
        return;
      }
      if (Object.hasOwn(parsed.input, "delivery_mode"))
        throw new Error("Presentation input reached execution");
      accepted++;
      recordEvent(fixture, "execution_accepted");
      response.on("close", () => {
        if (!response.writableEnded) {
          waiterDetached = true;
          recordEvent(fixture, "waiter_detached");
        }
      });
      if (scenario === "interrupted") {
        interrupted = true;
        recordEvent(fixture, "interruption");
        setTimeout(() => child?.kill("SIGINT"), 300);
      }
      await new Promise((done) => {
        delays.push({
          done,
          timer: setTimeout(done, scenario === "fast" ? 10 : 8000)
        });
      });
      recordEvent(fixture, "task_terminal");
      writeFileSync(join(root, "terminal"), "complete");
      if (!response.destroyed) {
        recordEvent(fixture, "completion", {
          outcome:
            scenario === "failed"
              ? "failed"
              : scenario === "not_found"
                ? "not_found"
                : "found",
          route: "mcp_result"
        });
        if (scenario === "failed")
          send(503, {
            error:
              "Fixture Memory Answer unavailable. Do not resubmit this request."
          });
        else send(200, { markdown: memoryMarkdown });
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end('{"error":"Fixture failed"}');
    });
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(koedHome, "run", "local-ai-runtime.json"),
    JSON.stringify({
      protocolVersion: 1,
      url,
      authorization: fixture.authorization,
      pid: process.pid,
      startedAt: new Date().toISOString()
    }),
    { mode: 0o600 }
  );
  const fixturePath = join(root, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
  const configPath = join(root, "mcp.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        koed_delivery_eval: {
          type: "stdio",
          command: process.execPath,
          args: [join(directory, "fixture-mcp.mjs")],
          alwaysLoad: true,
          env: {
            KOED_DELIVERY_FIXTURE_PATH: fixturePath,
            KOED_HOME: koedHome,
            KOED_CODEX_STOP_DELIVERY: "0",
            MEMORY_LOG_LEVEL: "silent"
          }
        }
      }
    })
  );
  const enabled = scenario !== "background_disabled";
  const dependentFirst = ["blocking_background", "ambiguous"].includes(
    scenario
  );
  const prompt = [
    "Fix the import settings according to our previous implementation decision. Start by checking prior memory exactly once with memory_answer and select delivery from your next planned action.",
    scenario === "ambiguous"
      ? "It is unclear whether any remaining diagnostic work is independent of the retained decision. Choose the settings next; do not use inspect_failure or assume independence."
      : dependentFirst
        ? "Diagnostics have already been collected. Your next action is to choose the settings from the prior decision; do not use inspect_failure."
        : "Your next planned action is the independent diagnostic read through inspect_failure. Continue independent work while waiting if the host permits, then use the recalled decision before applying the fix.",
    "Use apply_fix to save the retained retryDelayMs and cacheAuthorization. Do not guess, poll, retry the recall, or claim the task is complete while the answer is pending. If the decision is unavailable, report the blocker.",
    "Return a JSON status waiting_for_memory while yielding, fixed only after saving the correct settings, or blocked if the prerequisite is unavailable."
  ].join("\n");
  const command = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--no-session-persistence",
    "--json-schema",
    JSON.stringify({
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["waiting_for_memory", "fixed", "blocked"]
        }
      },
      required: ["status"],
      additionalProperties: false
    }),
    "--strict-mcp-config",
    "--mcp-config",
    configPath,
    "--tools",
    "",
    "--allowedTools",
    "mcp__koed_delivery_eval__memory_answer,mcp__koed_delivery_eval__inspect_failure,mcp__koed_delivery_eval__apply_fix",
    "--disable-slash-commands",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    prompt
  ];
  let stderr = "",
    nativeEvents = [],
    model;
  try {
    child = spawn(binary, command, {
      cwd: workspace,
      env: {
        ...process.env,
        MCP_SDK_GENERATION: "v2",
        MCP_PROTOCOL_NEGOTIATION: "auto",
        CLAUDE_AUTO_BACKGROUND_TASKS: "1",
        CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: enabled ? "500" : "0",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: enabled ? "0" : "1",
        CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: "1"
      },
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
          const event = JSON.parse(line);
          nativeEvents.push(
            event.type === "system" ? event.subtype : event.type
          );
          if (event.type === "system" && event.subtype === "init")
            model = event.model;
          if (event.type === "result" && event.structured_output?.status)
            recordEvent(fixture, "final_response", {
              status: event.structured_output.status
            });
          if (
            event.type === "system" &&
            ["task_started", "task_notification"].includes(event.subtype)
          )
            recordEvent(
              fixture,
              event.subtype === "task_started"
                ? "host_background_receipt"
                : "host_notification"
            );
          if (event.type === "assistant")
            for (const content of event.message?.content ?? []) {
              if (
                content.type === "tool_use" &&
                content.name.endsWith("__memory_answer")
              )
                recordEvent(fixture, "recall_requested", {
                  mode: content.input?.delivery_mode ?? "auto"
                });
              if (content.type === "text")
                try {
                  const status = JSON.parse(
                    content.text
                      .replace(/^\s*```(?:json)?\s*/, " ")
                      .replace(/\s*```\s*$/, "")
                  ).status;
                  if (
                    ["waiting_for_memory", "fixed", "blocked"].includes(status)
                  )
                    recordEvent(fixture, "final_response", { status });
                } catch {
                  /* Only typed fixture events are validation evidence. */
                }
            }
        } catch {
          /* Only typed fixture events are validation evidence. */
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const exitCode = await new Promise((done, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Claude native check timed out"));
      }, 120000);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(deadline);
        done(code);
      });
    });
    // Execution belongs to the fixture runtime even after its host waiter exits.
    if (scenario === "interrupted")
      while (delays.length && !existsSync(join(root, "terminal")))
        await new Promise((done) => setTimeout(done, 50));
    const events = existsSync(fixture.eventsPath)
      ? readFileSync(fixture.eventsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((s) => JSON.parse(s))
      : [];
    const actualSettings = JSON.parse(
      readFileSync(join(workspace, "import-settings.json"), "utf8")
    );
    const { checks, passed } = scoreClaudeDeliveryRun({
      scenario,
      events,
      expectedSettings,
      actualSettings,
      exitCode,
      executions: accepted,
      interrupted,
      waiterDetached
    });
    return {
      scenario,
      hostVersion: version.stdout.trim(),
      model,
      setup: {
        nativePrintHost: true,
        explicitNoninteractiveBackgroundOptIn: true,
        backgroundThresholdMs: enabled ? 500 : 0,
        protocol: "2026-07-28",
        ordinaryMcpRoute: true,
        syntheticMemory: true
      },
      events,
      expectedSettings,
      actualSettings,
      exitCode,
      checks,
      passed,
      nativeEventKinds: [...new Set(nativeEvents)],
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
    for (const item of delays) {
      clearTimeout(item.timer);
      item.done();
    }
    if (child?.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    rmSync(root, { recursive: true, force: true });
  }
}
const runs = [];
for (const scenario of cases) {
  console.error(`Running native Claude delivery: ${scenario}`);
  runs.push(await runCase(scenario));
  if (option("--out"))
    writeFileSync(
      resolve(option("--out")),
      JSON.stringify({ runs, passed: runs.every((r) => r.passed) }, null, 2) +
        "\n"
    );
}
if (!option("--out"))
  process.stdout.write(
    JSON.stringify({ runs, passed: runs.every((r) => r.passed) }, null, 2) +
      "\n"
  );
if (runs.some((r) => !r.passed)) process.exitCode = 1;
