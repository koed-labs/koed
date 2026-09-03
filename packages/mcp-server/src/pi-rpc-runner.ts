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
import { nodeCliInvocation, nodeCliProcessEnvironment } from "@koed/shared";

import type {
  AiClientRunConfig,
  AiClientRunResult
} from "./ai-client-runner.js";

export const MINIMUM_SUPPORTED_PI_VERSION = "0.84.2";
const execFileAsync = promisify(execFile);
const PI_RPC_MAX_RECORD_BYTES = 4 * 1024 * 1024;
const PI_RPC_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PI_RPC_DIAGNOSTIC_EVENT_BYTES = 256 * 1024;
const PI_RPC_DIAGNOSTIC_EVENTS = 64;

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

export interface PiExecutableDiscoveryOptions {
  platform?: NodeJS.Platform;
}

const WINDOWS_PI_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

export const resolvePiNodeExecutablePath = (
  candidate: string,
  platform: NodeJS.Platform = process.platform
): string => {
  if (
    platform !== "win32" ||
    !WINDOWS_PI_SHIM_EXTENSIONS.has(path.extname(candidate).toLowerCase())
  )
    return candidate;
  const entry = path.join(
    path.dirname(candidate),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js"
  );
  try {
    if (fs.statSync(entry).isFile()) return fs.realpathSync(entry);
  } catch {
    /* fail with the actionable error below */
  }
  throw new Error(
    `Pi launcher ${candidate} cannot be executed safely. Install Pi through npm with a verifiable package entry or configure a native executable.`
  );
};

export const piExecutableInvocation = (
  executablePath: string,
  args: string[]
): { command: string; args: string[] } =>
  nodeCliInvocation(executablePath, args);

const executableOnPath = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string | undefined => {
  const names = platform === "win32" ? ["pi.exe", "pi.cmd", "pi"] : ["pi"];
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const directory of (env.PATH ?? "").split(delimiter)) {
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
  env: NodeJS.ProcessEnv = process.env,
  options: PiExecutableDiscoveryOptions = {}
): string => {
  const platform = options.platform ?? process.platform;
  const configured = env.KOED_PI_EXECUTABLE?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("KOED_PI_EXECUTABLE must be an absolute path.");
  }
  const candidate = configured ?? executableOnPath(env, platform);
  if (!candidate)
    throw new Error(
      "Pi was not found. Install and authenticate Pi, or set KOED_PI_EXECUTABLE to its absolute path."
    );
  const canonical = fs.realpathSync(
    resolvePiNodeExecutablePath(candidate, platform)
  );
  if (!fs.statSync(canonical).isFile())
    throw new Error(`Pi executable is not a file: ${canonical}`);
  if (platform !== "win32") fs.accessSync(canonical, fs.constants.X_OK);
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
    "PI_CODING_AGENT_DIR",
    "SYSTEMROOT",
    "COMSPEC",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PATHEXT"
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => (env[name] ? [[name, env[name]]] : []))
  );
};

type PiRpcResponse = {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  data?: Record<string, unknown>;
  error?: string;
};

const queryPiModelCapabilities = async (
  executablePath: string,
  env: NodeJS.ProcessEnv
): Promise<PiModelInfo[]> => {
  const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-probe-"));
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-builtin-tools",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-extensions"
  ];
  const invocation = piExecutableInvocation(executablePath, args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: workerRoot,
    env: nodeCliProcessEnvironment(invocation, piRpcEnvironment(env), env),
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = Buffer.alloc(0);
  let stderr = "";
  let aggregateBytes = 0;
  let fatalError: Error | null = null;
  const pending = new Map<
    string,
    {
      resolve: (response: PiRpcResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const fail = (error: Error): void => {
    if (fatalError) return;
    fatalError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    terminateProcessTree(child);
  };
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-64_000);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    aggregateBytes += chunk.length;
    if (aggregateBytes > 8 * 1024 * 1024) {
      fail(new Error("Pi RPC capability output exceeded 8 MiB"));
      return;
    }
    stdout = Buffer.concat([stdout, chunk]);
    while (true) {
      const newline = stdout.indexOf(0x0a);
      if (newline < 0) {
        if (stdout.length > 4 * 1024 * 1024)
          fail(new Error("Pi RPC capability record exceeded 4 MiB"));
        return;
      }
      if (newline > 4 * 1024 * 1024) {
        fail(new Error("Pi RPC capability record exceeded 4 MiB"));
        return;
      }
      const record = stdout.subarray(0, newline);
      stdout = stdout.subarray(newline + 1);
      if (record.includes(0x0d)) {
        fail(new Error("Pi RPC requires strict-LF JSONL framing"));
        return;
      }
      if (record.length === 0) continue;
      let response: PiRpcResponse;
      try {
        response = JSON.parse(record.toString("utf8")) as PiRpcResponse;
      } catch (error) {
        fail(
          new Error("Pi RPC emitted malformed capability JSONL", {
            cause: error
          })
        );
        return;
      }
      if (response.type !== "response" || typeof response.id !== "string")
        continue;
      const request = pending.get(response.id);
      if (!request) continue;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.success === true) request.resolve(response);
      else
        request.reject(
          new Error(
            `Pi RPC ${response.command ?? "capability query"} failed: ${response.error ?? "unknown error"}`
          )
        );
    }
  });
  child.once("error", (error) => fail(error));
  child.once("exit", (code) => {
    if (!fatalError && pending.size > 0)
      fail(
        new Error(
          `Pi RPC capability probe exited with code ${code}: ${stderr.trim()}`
        )
      );
  });
  const request = (
    command: Record<string, unknown>
  ): Promise<PiRpcResponse> => {
    if (fatalError) return Promise.reject(fatalError);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error("Pi RPC capability query timed out");
        reject(error);
        fail(error);
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  };
  try {
    const available = await request({ type: "get_available_models" });
    const models = Array.isArray(available.data?.models)
      ? available.data.models
      : [];
    const capabilities: PiModelInfo[] = [];
    for (const value of models.slice(0, 1_000)) {
      if (!value || typeof value !== "object") continue;
      const model = value as Record<string, unknown>;
      if (typeof model.provider !== "string" || typeof model.id !== "string")
        continue;
      try {
        await request({
          type: "set_model",
          provider: model.provider,
          modelId: model.id
        });
        const thinking = await request({
          type: "get_available_thinking_levels"
        });
        const levels = Array.isArray(thinking.data?.levels)
          ? thinking.data.levels.filter(
              (level): level is string => typeof level === "string"
            )
          : [];
        if (levels.length === 0) continue;
        capabilities.push({
          id: `${model.provider}/${model.id}`,
          provider: model.provider,
          model: model.id,
          supportedReasoningEfforts: levels
        });
      } catch {
        // Fail this model closed without hiding other independently usable models.
      }
    }
    return capabilities;
  } finally {
    terminateProcessTree(child);
    fs.rmSync(workerRoot, { recursive: true, force: true });
  }
};

export const listPiModels = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<PiModelInfo[]> => {
  const executable = resolvePiExecutable(env);
  return queryPiModelCapabilities(executable, env);
};

export const checkPiAvailability = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<PiAvailability> => {
  try {
    const executablePath = resolvePiExecutable(env);
    const invocation = piExecutableInvocation(executablePath, ["--version"]);
    const { stdout } = await execFileAsync(
      invocation.command,
      invocation.args,
      {
        env: nodeCliProcessEnvironment(invocation, piRpcEnvironment(env), env),
        timeout: 10_000
      }
    );
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
  const invocation = piExecutableInvocation(config.executablePath, args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: workerRoot,
    env: nodeCliProcessEnvironment(
      invocation,
      { ...piRpcEnvironment(config.env), KOED_PI_RESULT_SCHEMA: schemaPath },
      config.env
    ),
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const events: unknown[] = [];
  const eventSizes: number[] = [];
  let eventBytes = 0;
  let aggregateOutputBytes = 0;
  let stdout = Buffer.alloc(0);
  let stderr = "";
  let settled = false;
  let finished = false;
  let resultValue: unknown;
  let actualModel = config.model;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      terminateProcessTree(child);
      finish(new Error(`Pi RPC timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
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
      aggregateOutputBytes += chunk.length;
      if (aggregateOutputBytes > PI_RPC_MAX_OUTPUT_BYTES) {
        terminateProcessTree(child);
        finish(new Error("Pi RPC aggregate output exceeded 8 MiB"));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
      while (true) {
        const newline = stdout.indexOf(0x0a);
        if (newline < 0) {
          if (stdout.length > PI_RPC_MAX_RECORD_BYTES) {
            terminateProcessTree(child);
            finish(new Error("Pi RPC JSONL record exceeded 4 MiB"));
          }
          break;
        }
        if (newline > PI_RPC_MAX_RECORD_BYTES) {
          terminateProcessTree(child);
          finish(new Error("Pi RPC JSONL record exceeded 4 MiB"));
          return;
        }
        const record = stdout.subarray(0, newline);
        stdout = stdout.subarray(newline + 1);
        if (record.includes(0x0d)) {
          terminateProcessTree(child);
          finish(new Error("Pi RPC requires strict-LF JSONL framing"));
          return;
        }
        const line = record.toString("utf8");
        if (!line) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          events.push(event);
          eventSizes.push(record.length);
          eventBytes += record.length;
          while (
            events.length > PI_RPC_DIAGNOSTIC_EVENTS ||
            eventBytes > PI_RPC_DIAGNOSTIC_EVENT_BYTES
          ) {
            events.shift();
            eventBytes -= eventSizes.shift() ?? 0;
          }
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
