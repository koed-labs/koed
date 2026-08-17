import { createHash, randomUUID } from "node:crypto";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AiClientRunConfig,
  AiClientRunResult
} from "./ai-client-runner.js";

export const MINIMUM_SUPPORTED_PI_VERSION = "0.84.2";
const execFileAsync = promisify(execFile);

const numericVersion = (value: string): number[] | null => {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  return match ? match.slice(1).map(Number) : null;
};

export const assertPiVersionCompatibility = (value: string): void => {
  const actual = numericVersion(value);
  const minimum = numericVersion(MINIMUM_SUPPORTED_PI_VERSION)!;
  if (
    !actual ||
    (actual.some((part, index) => part !== minimum[index]) &&
      (actual[0]! < minimum[0]! ||
        (actual[0] === minimum[0] && actual[1]! < minimum[1]!) ||
        (actual[0] === minimum[0] &&
          actual[1] === minimum[1] &&
          actual[2]! < minimum[2]!)))
  ) {
    throw new Error(
      `Pi ${value.trim() || "version output"} is incompatible. Koed requires Pi ${MINIMUM_SUPPORTED_PI_VERSION} or newer.`
    );
  }
};

const executableOnPath = (env: NodeJS.ProcessEnv): string | undefined => {
  const names =
    process.platform === "win32" ? ["pi.exe", "pi.cmd", "pi"] : ["pi"];
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
      } catch {
        /* continue */
      }
    }
  }
  return undefined;
};

export const resolvePiExecutable = (
  env: NodeJS.ProcessEnv = process.env
): string => {
  const configured = env.KOED_PI_EXECUTABLE?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("KOED_PI_EXECUTABLE must be an absolute path.");
  }
  const candidate = configured ?? executableOnPath(env);
  if (!candidate)
    throw new Error(
      "Pi was not found. Install and authenticate Pi, or set KOED_PI_EXECUTABLE to its absolute path."
    );
  const canonical = fs.realpathSync(candidate);
  if (!fs.statSync(canonical).isFile())
    throw new Error(`Pi executable is not a file: ${canonical}`);
  if (process.platform !== "win32") fs.accessSync(canonical, fs.constants.X_OK);
  return canonical;
};

export const piInstallationIdentity = (executablePath: string): string => {
  const canonical = fs.realpathSync(executablePath);
  const stat = fs.statSync(canonical);
  return createHash("sha256")
    .update(
      JSON.stringify({
        canonical,
        device: stat.dev,
        inode: stat.ino,
        size: stat.size,
        modifiedMs: stat.mtimeMs
      })
    )
    .digest("hex");
};

export interface PiModelInfo {
  id: string;
  provider: string;
  model: string;
  supportedReasoningEfforts: string[];
}
export interface PiAvailability {
  available: boolean;
  executablePath: string | null;
  version: string | null;
  authenticated: boolean;
  models: PiModelInfo[];
  error: string | null;
}

export const piRpcEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const allowed = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "PI_CODING_AGENT_DIR"
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => (env[name] ? [[name, env[name]]] : []))
  );
};

export const listPiModels = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<PiModelInfo[]> => {
  const executable = resolvePiExecutable(env);
  const { stdout } = await execFileAsync(executable, ["--list-models"], {
    env: piRpcEnvironment(env),
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const match = line.trim().match(/^(\S+)\s+(\S+)/);
      return match
        ? [
            {
              id: `${match[1]}/${match[2]}`,
              provider: match[1]!,
              model: match[2]!,
              supportedReasoningEfforts: [
                "off",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            }
          ]
        : [];
    });
};

export const checkPiAvailability = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<PiAvailability> => {
  try {
    const executablePath = resolvePiExecutable(env);
    const { stdout } = await execFileAsync(executablePath, ["--version"], {
      env: piRpcEnvironment(env),
      timeout: 10_000
    });
    assertPiVersionCompatibility(stdout);
    const models = await listPiModels({
      ...env,
      KOED_PI_EXECUTABLE: executablePath
    });
    return {
      available: models.length > 0,
      executablePath,
      version: stdout.trim(),
      authenticated: models.length > 0,
      models,
      error: models.length > 0 ? null : "Pi has no authenticated models."
    };
  } catch (error) {
    return {
      available: false,
      executablePath: null,
      version: null,
      authenticated: false,
      models: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

const terminateProcessTree = (child: ChildProcessWithoutNullStreams): void => {
  if (!child.pid) return;
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore"
      });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

export const runPiRpcTask = async (
  prompt: string,
  config: AiClientRunConfig,
  timeoutMs: number
): Promise<AiClientRunResult> => {
  if (config.signal?.aborted) throw new Error("Pi RPC task was cancelled");
  if (!config.outputSchema)
    throw new Error("Pi RPC tasks require an output schema");
  const koedHome = path.resolve(
    config.env.KOED_HOME ?? path.join(os.homedir(), ".koed")
  );
  const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-worker-"));
  const schemaPath = path.join(workerRoot, "schema.json");
  const bridgePath = path.join(
    koedHome,
    "integrations",
    "pi",
    "extensions",
    "structured-result.mjs"
  );
  fs.mkdirSync(workerRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(schemaPath, JSON.stringify(config.outputSchema), {
    mode: 0o600
  });
  if (!fs.existsSync(bridgePath))
    throw new Error(
      `Koed Pi structured-result bridge is missing: ${bridgePath}`
    );
  const model =
    config.reasoningEffort === "none" || config.reasoningEffort === "off"
      ? config.model
      : `${config.model}:${config.reasoningEffort}`;
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-builtin-tools",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-extensions",
    "--extension",
    bridgePath,
    "--tools",
    "koed_structured_result",
    "--model",
    model,
    "--system-prompt",
    [config.systemPrompt, config.developerInstructions]
      .filter(Boolean)
      .join("\n\n")
  ];
  const child = spawn(config.executablePath, args, {
    cwd: workerRoot,
    env: { ...piRpcEnvironment(config.env), KOED_PI_RESULT_SCHEMA: schemaPath },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const events: unknown[] = [];
  let stdout = Buffer.alloc(0);
  let stderr = "";
  let settled = false;
  let resultValue: unknown;
  let actualModel = config.model;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      terminateProcessTree(child);
      reject(new Error(`Pi RPC timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      config.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      terminateProcessTree(child);
      finish(new Error("Pi RPC task was cancelled"));
    };
    if (config.signal?.aborted) abort();
    else config.signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-64_000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      while (true) {
        const newline = stdout.indexOf(0x0a);
        if (newline < 0) {
          if (stdout.length > 4 * 1024 * 1024) {
            terminateProcessTree(child);
            finish(new Error("Pi RPC JSONL record exceeded 4 MiB"));
          }
          break;
        }
        if (newline > 4 * 1024 * 1024) {
          terminateProcessTree(child);
          finish(new Error("Pi RPC JSONL record exceeded 4 MiB"));
          return;
        }
        const line = stdout
          .subarray(0, newline)
          .toString("utf8")
          .replace(/\r$/, "");
        stdout = stdout.subarray(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (events.length >= 100_000) {
            terminateProcessTree(child);
            finish(new Error("Pi RPC emitted too many events"));
            return;
          }
          events.push(event);
          const message = event.message as Record<string, unknown> | undefined;
          if (
            message?.role === "assistant" &&
            typeof message.provider === "string" &&
            typeof message.model === "string"
          )
            actualModel = `${message.provider}/${message.model}`;
          if (
            event.type === "tool_execution_end" &&
            event.toolName === "koed_structured_result"
          ) {
            const result = event.result as Record<string, unknown> | undefined;
            const details = result?.details as
              | Record<string, unknown>
              | undefined;
            resultValue = details?.value;
          }
          if (event.type === "agent_settled") {
            settled = true;
            child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
            terminateProcessTree(child);
          }
        } catch (error) {
          finish(new Error("Pi RPC emitted malformed JSONL", { cause: error }));
        }
      }
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled && code !== 0)
        finish(new Error(`Pi RPC exited with code ${code}: ${stderr.trim()}`));
      else if (resultValue === undefined)
        finish(new Error("Pi RPC completed without structured result"));
      else finish();
    });
    child.stdin.write(
      `${JSON.stringify({ id: randomUUID(), type: "prompt", message: prompt })}\n`
    );
  });
  try {
    await done;
    return {
      text: JSON.stringify(resultValue),
      model: actualModel,
      providerEvents: events
    };
  } finally {
    terminateProcessTree(child);
    fs.rmSync(workerRoot, { recursive: true, force: true });
  }
};
