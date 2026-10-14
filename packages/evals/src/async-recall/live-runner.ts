import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asyncRecallCases } from "./cases.js";
import { scoreRecallTrace, type RecallEvent } from "./benchmark.js";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const model = option("--model", "gpt-6.1-sol");
const effort = option("--reasoning-effort", "medium");
const binary = option("--codex", "codex");
const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
if (version.status !== 0)
  throw new Error("Could not determine native harness version");
const harnessVersion = version.stdout.trim();
const runs = Number(option("--runs", "3"));
const delayMs = Number(option("--delay-ms", "5000"));
if (
  !Number.isSafeInteger(runs) ||
  runs < 1 ||
  !Number.isSafeInteger(delayMs) ||
  delayMs < 1
)
  throw new Error("--runs and --delay-ms must be positive integers");
const caseId = option("--case", "");
const selected = asyncRecallCases.filter(
  (entry) => !caseId || entry.id === caseId
);
if (!selected.length) throw new Error("Unknown case");
const server = fileURLToPath(new URL("./fixture-mcp.js", import.meta.url));
const results = [];

async function execute(
  argv: string[],
  cwd: string
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, {
      cwd,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 180_000);
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -1 : code, stderr });
    });
  });
}

for (const fixture of selected) {
  for (let runIndex = 0; runIndex < runs; runIndex++) {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-async-recall-"));
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      const log = path.join(root, "events.jsonl");
      const final = path.join(root, "final.txt");
      const config = [
        'approval_policy="never"',
        `model_reasoning_effort=${JSON.stringify(effort)}`,
        'mcp_servers.async_recall_eval.command="node"',
        `mcp_servers.async_recall_eval.args=[${JSON.stringify(server)}]`,
        "mcp_servers.async_recall_eval.enabled=true",
        "mcp_servers.async_recall_eval.required=true",
        'mcp_servers.async_recall_eval.default_tools_approval_mode="approve"',
        `mcp_servers.async_recall_eval.env={ASYNC_RECALL_CASE=${JSON.stringify(fixture.id)},ASYNC_RECALL_LOG=${JSON.stringify(log)},ASYNC_RECALL_DELAY_MS=${JSON.stringify(String(delayMs))}}`
      ].flatMap((value) => ["-c", value]);
      console.error(`Running ${fixture.id} ${runIndex + 1}/${runs}`);
      const result = await execute(
        [
          "exec",
          "--ignore-user-config",
          ...config,
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--cd",
          workspace,
          "--model",
          model,
          "--output-last-message",
          final,
          fixture.prompt
        ],
        workspace
      );
      const lines = await readFile(log, "utf8").catch(() => "");
      const events = lines
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecallEvent);
      const score = scoreRecallTrace(fixture, events);
      results.push({
        runIndex,
        ...score,
        passed: score.passed && result.code === 0,
        exitCode: result.code,
        error: result.code === 0 ? null : result.stderr,
        events,
        finalResponse: await readFile(final, "utf8").catch(() => "")
      });
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      });
    }
  }
}
const report = JSON.stringify(
  {
    version: "koed-async-recall-eval-v1",
    provenance: "native_codex_production_mcp_factory_synthetic_runtime",
    model,
    harnessVersion,
    reasoningEffort: effort,
    modeObservation:
      "effective_runtime_dispatch_not_raw_delivery_mode_argument",
    delayMs,
    limitations:
      "Actual model tool behavior against synthetic recall, not production delivery or retrieval quality. Post-receipt tool ordering does not establish a separate main-model reasoning sample; actions may be preissued in one native tool batch. Useful work is a fixture diagnostic tool, not arbitrary shell activity. Final natural-language claims are retained but not semantically judged.",
    advisoryPolicy: {
      maxPendingPolls: 2,
      tightPollIntervalMs: 1_000,
      maxTightPolls: 1
    },
    runs: results
  },
  null,
  2
);
if (args.includes("--out"))
  await writeFile(option("--out", ""), `${report}\n`, { flag: "wx" });
else console.log(report);
if (results.some((result) => !result.passed)) process.exitCode = 1;
