import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolChoiceCases } from "./cases.js";
import {
  scoreToolChoiceRun,
  summarizeToolChoiceBenchmark,
  type ToolChoiceCall,
  type ToolChoiceRunInput
} from "./benchmark.js";

const args = process.argv.slice(2);

const optionValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const selectedCaseIds = new Set(
  optionValue("--case")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? []
);

const runsOverride = optionValue("--runs")
  ? Number.parseInt(optionValue("--runs")!, 10)
  : undefined;
const model =
  optionValue("--model") ??
  process.env.MEMORY_TOOL_CHOICE_MODEL ??
  "gpt-5.4-mini";
const codexBinary =
  optionValue("--codex") ??
  process.env.MEMORY_CODEX_APP_SERVER_BINARY ??
  "codex";
const outputPath = optionValue("--out");
const keepTemp = args.includes("--keep-temp");
const sourceCodexHome =
  process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fakeMcpServerPath = path.join(currentDirectory, "fake-memory-mcp.js");

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const runCommand = (
  command: string,
  commandArgs: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode });
    });
  });

const copyCodexAuth = async (targetHome: string): Promise<void> => {
  for (const filename of ["auth.json", ".credentials.json"]) {
    const source = path.join(sourceCodexHome, filename);
    if (fs.existsSync(source)) {
      await copyFile(source, path.join(targetHome, filename));
    }
  }
};

const writeConfig = async (
  codexHome: string,
  logPath: string,
  fakeMemoryAnswer: (typeof toolChoiceCases)[number]["fakeMemoryAnswer"]
): Promise<void> => {
  await writeFile(
    path.join(codexHome, "config.toml"),
    [
      `model = ${JSON.stringify(model)}`,
      `approval_policy = "never"`,
      "",
      "[mcp_servers.koed_tool_choice_eval]",
      `command = "node"`,
      `args = [${JSON.stringify(fakeMcpServerPath)}]`,
      "enabled = true",
      "required = true",
      `default_tools_approval_mode = "approve"`,
      "",
      "[mcp_servers.koed_tool_choice_eval.env]",
      `TOOL_CHOICE_LOG_PATH = ${JSON.stringify(logPath)}`,
      `TOOL_CHOICE_FAKE_MEMORY_ANSWER = ${JSON.stringify(
        JSON.stringify(fakeMemoryAnswer)
      )}`
    ].join("\n")
  );
};

const parseToolCalls = async (logPath: string): Promise<ToolChoiceCall[]> => {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const lines = (await readFile(logPath, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const parsed = JSON.parse(line) as {
      toolName: string;
      arguments: Record<string, unknown>;
    };
    return {
      toolName: parsed.toolName,
      arguments: parsed.arguments
    };
  });
};

const runOne = async (
  benchmarkCase: (typeof toolChoiceCases)[number],
  runIndex: number
): Promise<ToolChoiceRunInput> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koed-tool-choice-"));
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  const logPath = path.join(root, "tool-calls.jsonl");
  const outputLastMessagePath = path.join(root, "last-message.txt");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true });
  await copyCodexAuth(codexHome);
  await writeConfig(codexHome, logPath, benchmarkCase.fakeMemoryAnswer);

  try {
    const prompt = benchmarkCase.prompt;
    const result = await runCommand(
      codexBinary,
      [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--cd",
        workspace,
        "--model",
        model,
        "--output-last-message",
        outputLastMessagePath,
        prompt
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          XDG_CONFIG_HOME: path.join(root, "xdg-config"),
          XDG_CACHE_HOME: path.join(root, "xdg-cache"),
          XDG_DATA_HOME: path.join(root, "xdg-data"),
          CODEX_HOME: codexHome
        },
        timeoutMs: 180_000
      }
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `codex exec exited ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
      );
    }
    return {
      caseId: benchmarkCase.id,
      runIndex,
      calls: await parseToolCalls(logPath),
      finalResponse: fs.existsSync(outputLastMessagePath)
        ? await readFile(outputLastMessagePath, "utf8")
        : ""
    };
  } finally {
    if (keepTemp) {
      console.error(`Kept temp benchmark directory: ${root}`);
    } else {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      });
    }
  }
};

const casesToRun =
  selectedCaseIds.size > 0
    ? toolChoiceCases.filter((benchmarkCase) =>
        selectedCaseIds.has(benchmarkCase.id)
      )
    : toolChoiceCases;

if (casesToRun.length === 0) {
  throw new Error("No benchmark cases selected");
}

const runInputs: ToolChoiceRunInput[] = [];
for (const benchmarkCase of casesToRun) {
  const runCount = runsOverride ?? benchmarkCase.runs;
  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    console.error(`Running ${benchmarkCase.id} ${runIndex + 1}/${runCount}`);
    runInputs.push(await runOne(benchmarkCase, runIndex));
  }
}

const caseById = new Map(
  toolChoiceCases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase])
);
const scored = runInputs.map((run) =>
  scoreToolChoiceRun(caseById.get(run.caseId)!, run)
);
const summary = {
  model,
  generatedAt: new Date().toISOString(),
  cases: casesToRun.map((benchmarkCase) => benchmarkCase.id),
  runInputs,
  ...summarizeToolChoiceBenchmark(scored)
};
const report = JSON.stringify(summary, null, 2);
if (outputPath) {
  await writeFile(outputPath, `${report}\n`);
} else {
  console.log(report);
}
