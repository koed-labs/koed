import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export interface CodexTokenUsageBreakdown {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexThreadTokenUsage {
  total?: CodexTokenUsageBreakdown;
  last?: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface CodexAppServerRawEvent {
  method: string;
  params?: unknown;
  result?: unknown;
  observedAt: string;
}

export interface CodexAppServerRunConfig {
  appServerBinary: string;
  model: string;
  reasoningEffort: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  clientName: string;
  baseInstructions: string;
  developerInstructions?: string;
}

export interface CodexAppServerRunResult {
  text: string;
  model: string;
  tokenUsage?: CodexThreadTokenUsage;
  threadId?: string;
  turnId?: string;
  rawEvents?: CodexAppServerRawEvent[];
}

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    message?: string;
    [key: string]: unknown;
  };
}

const resolveEnvValue = (
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined => {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
};

export const resolveCodexAppServerBinary = (
  env: NodeJS.ProcessEnv = process.env,
  compatibilityNames: string[] = []
): string =>
  resolveEnvValue(env, "MEMORY_CODEX_APP_SERVER_BINARY") ??
  compatibilityNames
    .map((name) => resolveEnvValue(env, name))
    .find((value): value is string => Boolean(value)) ??
  (process.platform === "win32" ? "codex.cmd" : "codex");

const sourceCodexHome = (env: NodeJS.ProcessEnv): string =>
  resolveEnvValue(env, "CODEX_HOME") ?? path.join(os.homedir(), ".codex");

const createIsolatedCodexHome = (
  env: NodeJS.ProcessEnv,
  model: string
): string => {
  const sourceHome = sourceCodexHome(env);
  let isolatedHome: string;
  try {
    isolatedHome = fs.mkdtempSync(
      path.join(
        fs.existsSync(sourceHome) ? sourceHome : os.tmpdir(),
        ".koed-app-server-"
      )
    );
  } catch {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), ".koed-app-server-"));
  }
  fs.chmodSync(isolatedHome, 0o700);

  for (const filename of ["auth.json", ".credentials.json"]) {
    const source = path.join(sourceHome, filename);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(isolatedHome, filename));
      fs.chmodSync(path.join(isolatedHome, filename), 0o600);
    }
  }

  fs.writeFileSync(
    path.join(isolatedHome, "config.toml"),
    [
      `model = ${JSON.stringify(model)}`,
      "",
      "# Koed worker app-server home is intentionally minimal.",
      "# The user's capture hooks and MCP servers remain configured in their real CODEX_HOME."
    ].join("\n"),
    { mode: 0o600 }
  );

  return isolatedHome;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const textFromCompletedItem = (params: unknown): string | null => {
  const item = asRecord(asRecord(params).item);
  return item.type === "agentMessage" && typeof item.text === "string"
    ? item.text
    : null;
};

const tokenUsageFromParams = (
  params: unknown,
  turnId: string | null
): CodexThreadTokenUsage | undefined => {
  const record = asRecord(params);
  if (turnId && record.turnId !== turnId) {
    return undefined;
  }
  const tokenUsage = record.tokenUsage;
  return tokenUsage && typeof tokenUsage === "object"
    ? (tokenUsage as CodexThreadTokenUsage)
    : undefined;
};

class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: JsonRpcMessage) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: readline.Interface;
  private readonly stderrChunks: string[] = [];
  private readonly rawEvents: CodexAppServerRawEvent[] = [];
  private closed = false;
  private readonly turnStates = new Map<
    string,
    {
      text: string;
      tokenUsage?: CodexThreadTokenUsage;
      completed: boolean;
      error?: Error;
    }
  >();
  private turnWaiter: {
    threadId: string;
    turnId: string;
    resolve: (value: CodexAppServerRunResult) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv
  ) {
    this.child = spawn(binary, ["app-server", "--listen", "stdio://"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderrChunks.push(String(chunk));
      if (this.stderrChunks.length > 20) {
        this.stderrChunks.shift();
      }
    });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("close", (code, signal) => {
      this.closed = true;
      if (this.pending.size > 0 || this.turnWaiter) {
        this.failAll(
          new Error(
            `Codex app-server exited before completion (${code ?? signal ?? "unknown"})${this.stderrSummary()}`
          )
        );
      }
    });
  }

  async initialize(clientName: string): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: clientName,
        version: "0.1.0"
      },
      capabilities: {
        experimental_api: true
      }
    });
    this.notify("initialized");
  }

  async startThread(config: CodexAppServerRunConfig): Promise<string> {
    const response = await this.request("thread/start", {
      model: config.model,
      cwd: config.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      baseInstructions: config.baseInstructions,
      developerInstructions: config.developerInstructions ?? "",
      threadSource: "memory_consolidation"
    });
    const thread = asRecord(asRecord(response.result).thread);
    if (typeof thread.id !== "string") {
      throw new Error("Codex app-server thread/start returned no thread id");
    }
    this.recordRawEvent("thread/start", undefined, response.result);
    return thread.id;
  }

  async startTurn(
    threadId: string,
    prompt: string,
    config: CodexAppServerRunConfig
  ): Promise<string> {
    const response = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: config.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: config.model,
      effort: config.reasoningEffort
    });
    const turn = asRecord(asRecord(response.result).turn);
    if (typeof turn.id !== "string") {
      throw new Error("Codex app-server turn/start returned no turn id");
    }
    this.recordRawEvent("turn/start", undefined, response.result);
    return turn.id;
  }

  waitForTurn(
    threadId: string,
    turnId: string
  ): Promise<CodexAppServerRunResult> {
    return new Promise((resolve, reject) => {
      this.turnWaiter = {
        threadId,
        turnId,
        resolve,
        reject
      };
      this.settleTurnIfReady(threadId, turnId);
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    try {
      await this.request("turn/interrupt", { threadId, turnId });
    } catch {
      // The process is killed after timeout; interrupt is best-effort cleanup.
    }
  }

  close(): void {
    this.lines.close();
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  getRawEvents(): CodexAppServerRawEvent[] {
    return [...this.rawEvents];
  }

  private request(method: string, params: unknown): Promise<JsonRpcMessage> {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server is closed"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${payload}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.closed) {
      this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.failAll(
        new Error(
          `Codex app-server emitted malformed JSON on stdout: ${line.slice(0, 200)}`,
          { cause: error }
        )
      );
      this.close();
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "Codex app-server error")
        );
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (typeof message.method !== "string") {
      return;
    }

    this.recordRawEvent(message.method, message.params);

    if (message.method === "item/agentMessage/delta") {
      const params = asRecord(message.params);
      if (
        typeof params.threadId === "string" &&
        typeof params.turnId === "string" &&
        typeof params.delta === "string"
      ) {
        this.stateFor(params.threadId, params.turnId).text += params.delta;
      }
      return;
    }

    if (message.method === "item/completed") {
      const params = asRecord(message.params);
      if (
        typeof params.threadId === "string" &&
        typeof params.turnId === "string"
      ) {
        const text = textFromCompletedItem(message.params);
        if (text !== null) {
          this.stateFor(params.threadId, params.turnId).text = text;
        }
      }
      return;
    }

    if (message.method === "thread/tokenUsage/updated") {
      const params = asRecord(message.params);
      if (
        typeof params.threadId === "string" &&
        typeof params.turnId === "string"
      ) {
        const usage = tokenUsageFromParams(message.params, params.turnId);
        if (usage) {
          this.stateFor(params.threadId, params.turnId).tokenUsage = usage;
        }
      }
      return;
    }

    if (message.method === "error") {
      const params = asRecord(message.params);
      if (
        typeof params.threadId === "string" &&
        typeof params.turnId === "string"
      ) {
        const error = asRecord(params.error);
        const state = this.stateFor(params.threadId, params.turnId);
        state.error = new Error(
          typeof error.message === "string"
            ? error.message
            : "Codex app-server turn failed"
        );
        state.completed = true;
        this.settleTurnIfReady(params.threadId, params.turnId);
      }
      return;
    }

    if (message.method === "turn/completed") {
      const params = asRecord(message.params);
      const turn = asRecord(params.turn);
      if (typeof params.threadId !== "string" || typeof turn.id !== "string") {
        return;
      }
      const state = this.stateFor(params.threadId, turn.id);
      if (turn.status === "completed") {
        state.completed = true;
      } else {
        const error = asRecord(turn.error);
        state.error = new Error(
          typeof error.message === "string"
            ? error.message
            : `Codex app-server turn ended with status ${
                typeof turn.status === "string" ? turn.status : "unknown"
              }`
        );
        state.completed = true;
      }
      this.settleTurnIfReady(params.threadId, turn.id);
    }
  }

  private stateFor(
    threadId: string,
    turnId: string
  ): {
    text: string;
    tokenUsage?: CodexThreadTokenUsage;
    completed: boolean;
    error?: Error;
  } {
    const key = `${threadId}:${turnId}`;
    const existing = this.turnStates.get(key);
    if (existing) {
      return existing;
    }
    const state = { text: "", completed: false };
    this.turnStates.set(key, state);
    return state;
  }

  private settleTurnIfReady(threadId: string, turnId: string): void {
    if (
      !this.turnWaiter ||
      this.turnWaiter.threadId !== threadId ||
      this.turnWaiter.turnId !== turnId
    ) {
      return;
    }
    const state = this.stateFor(threadId, turnId);
    if (!state.completed) {
      return;
    }
    if (state.error) {
      this.turnWaiter.reject(state.error);
    } else if (state.text.trim().length === 0) {
      this.turnWaiter.reject(
        new Error("Codex app-server produced empty output")
      );
    } else {
      this.turnWaiter.resolve({
        text: state.text.trim(),
        model: "codex-app-server",
        tokenUsage: state.tokenUsage,
        threadId,
        turnId
      });
    }
    this.turnWaiter = null;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    if (this.turnWaiter) {
      this.turnWaiter.reject(error);
      this.turnWaiter = null;
    }
  }

  private stderrSummary(): string {
    const stderr = this.stderrChunks.join("").trim();
    return stderr ? `: ${stderr}` : "";
  }

  private recordRawEvent(
    method: string,
    params?: unknown,
    result?: unknown
  ): void {
    this.rawEvents.push({
      method,
      ...(params !== undefined ? { params } : {}),
      ...(result !== undefined ? { result } : {}),
      observedAt: new Date().toISOString()
    });
  }
}

export const runCodexAppServerTurn = async (
  prompt: string,
  config: CodexAppServerRunConfig,
  timeoutMs: number
): Promise<CodexAppServerRunResult> => {
  const isolatedHome = createIsolatedCodexHome(config.env, config.model);
  const env = {
    ...config.env,
    CODEX_HOME: isolatedHome
  };
  const client = new CodexAppServerClient(
    config.appServerBinary,
    config.cwd,
    env
  );
  let threadId: string | null = null;
  let turnId: string | null = null;
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    if (threadId && turnId) {
      void client.interruptTurn(threadId, turnId);
    }
    client.close();
  }, timeoutMs);

  try {
    await client.initialize(config.clientName);
    threadId = await client.startThread(config);
    turnId = await client.startTurn(threadId, prompt, config);
    const result = await client.waitForTurn(threadId, turnId);
    return {
      ...result,
      model: `codex-app-server:${config.model}:${config.reasoningEffort}`,
      rawEvents: client.getRawEvents()
    };
  } catch (error) {
    if (timedOut) {
      throw new Error(`Codex app-server timed out after ${timeoutMs}ms`, {
        cause: error
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    client.close();
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
};
