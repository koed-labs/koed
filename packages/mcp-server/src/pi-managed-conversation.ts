import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeCliInvocation, nodeCliProcessEnvironment } from "@koed/shared";
import type { AiClientPermissionMode } from "./ai-client-permission-mode.js";
import { piSessionIdentity } from "./pi-transcript-watcher.js";
import { piRpcEnvironment, resolvePiExecutable } from "./pi-rpc-runner.js";

export interface PiManagedConversationConfig {
  cwd: string;
  model: string;
  reasoningEffort?: string;
  permissionMode: AiClientPermissionMode;
  sessionDirectory: string;
  resumeSessionPath?: string;
  expectedSessionId?: string;
  sessionId?: string;
  forkSourcePath?: string;
  expectedParentSessionId?: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  onTextDelta?: (delta: string, turnId: string) => void;
  onUiRequest: (
    request: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<Record<string, unknown>>;
}

export interface PiManagedConversationIdentity {
  provider: "pi";
  sessionId: string;
  transcriptPath: string | null;
}

export class PiManagedConversationProviderError extends Error {
  constructor() {
    super("Pi reported an unsuccessful provider turn.");
    this.name = "PiManagedConversationProviderError";
  }
}

type PendingRequest = {
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** One process owns one provider session. An uncertain prompt is never replayed. */
export class PiManagedConversationSession {
  private child: ChildProcessWithoutNullStreams | undefined;
  private closed: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  private closing = false;
  private readonly lifetime = new AbortController();
  private buffer = Buffer.alloc(0);
  private readonly requests = new Map<string, PendingRequest>();
  private identity: PiManagedConversationIdentity | undefined;
  private active:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        text: string;
        canceled: boolean;
        providerFailed: boolean;
        turnId: string;
      }
    | undefined;

  constructor(private readonly config: PiManagedConversationConfig) {}

  async start(): Promise<PiManagedConversationIdentity> {
    if (this.child) throw new Error("Pi managed session is already started.");
    if (this.closing) throw new Error("Pi managed session is closed.");
    const executable = resolvePiExecutable(this.config.env);
    const sessionDirectory = path.resolve(this.config.sessionDirectory);
    fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
    // Locate the configured installation, including packaged dist/bundle launchers.
    let packageRoot = path.dirname(executable);
    for (let depth = 0; depth < 8; depth += 1) {
      if (fs.existsSync(path.join(packageRoot, "package.json"))) break;
      const parent = path.dirname(packageRoot);
      if (parent === packageRoot) break;
      packageRoot = parent;
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
    ) as { name?: string; exports?: { "."?: { import?: string } } };
    const publicEntry = manifest.exports?.["."]?.import;
    if (
      manifest.name !== "@earendil-works/pi-coding-agent" ||
      typeof publicEntry !== "string" ||
      !publicEntry.startsWith("./")
    ) {
      throw new Error(
        "Managed Pi requires the configured installation's public SDK."
      );
    }
    const sdkEntry = fs.realpathSync(path.resolve(packageRoot, publicEntry));
    const relativeEntry = path.relative(packageRoot, sdkEntry);
    if (
      relativeEntry === ".." ||
      relativeEntry.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeEntry)
    ) {
      throw new Error(
        "Managed Pi SDK must belong to the configured installation."
      );
    }
    if (this.config.resumeSessionPath) {
      const transcriptPath = fs.realpathSync(this.config.resumeSessionPath);
      if (!fs.statSync(transcriptPath).isFile())
        throw new Error("Pi transcript is not a regular file.");
      if (!this.config.expectedSessionId)
        throw new Error("Pi resume requires an exact session identity.");
    }
    const forkSource = this.config.forkSourcePath;
    if (
      forkSource &&
      (this.config.resumeSessionPath ||
        !this.config.expectedParentSessionId ||
        piSessionIdentity(forkSource).id !==
          this.config.expectedParentSessionId)
    ) {
      throw new Error("Pi fork requires an exact parent identity.");
    }
    const sourceDigest = () =>
      forkSource
        ? createHash("sha256").update(fs.readFileSync(forkSource)).digest("hex")
        : null;
    const parentDigest = sourceDigest();
    const invocation = nodeCliInvocation(
      fileURLToPath(
        new URL("../integrations/pi/managed-rpc-host.mjs", import.meta.url)
      ),
      [
        JSON.stringify({
          sdkEntry,
          cwd: this.config.cwd,
          model: this.config.model,
          sessionDirectory,
          sessionId: this.config.sessionId,
          resumeSessionPath: this.config.resumeSessionPath,
          forkSourcePath: forkSource,
          reasoningEffort: this.config.reasoningEffort
        })
      ]
    );
    const env = {
      ...piRpcEnvironment(this.config.env),
      ...(this.config.env.KOED_HOME
        ? { KOED_HOME: this.config.env.KOED_HOME }
        : {}),
      KOED_MANAGED_PERMISSION_MODE: this.config.permissionMode
    };
    const child = spawn(invocation.command, invocation.args, {
      cwd: fs.realpathSync(this.config.cwd),
      env: nodeCliProcessEnvironment(invocation, env, this.config.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    this.child = child;
    this.closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        this.fail(new Error("Pi managed process closed."));
        resolve();
      });
    });
    child.once("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => this.fail(error));
    // Drain diagnostics without retaining provider output or secret-bearing errors.
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    try {
      this.identity = this.readIdentity(
        await this.request(
          { type: "get_state" },
          this.config.startupTimeoutMs ?? 60_000
        )
      );
      if (forkSource) {
        if (
          !this.identity.transcriptPath ||
          this.identity.sessionId === this.config.expectedParentSessionId ||
          sourceDigest() !== parentDigest
        ) {
          throw new Error("Pi fork did not preserve its parent source.");
        }
        const header = piSessionIdentity(this.identity.transcriptPath);
        if (
          header.parentSession !== fs.realpathSync(forkSource) ||
          header.cwd !== fs.realpathSync(this.config.cwd)
        ) {
          throw new Error(
            "Pi fork lineage or workspace differs from its assignment."
          );
        }
      }
      return this.identity;
    } catch (error) {
      await this.closeAndWait();
      throw error;
    }
  }

  private readIdentity(
    state: Record<string, unknown>
  ): PiManagedConversationIdentity {
    const sessionId = state.sessionId;
    if (
      typeof sessionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        sessionId
      )
    ) {
      throw new Error("Pi returned an invalid session identity.");
    }
    const expected =
      this.identity?.sessionId ??
      this.config.expectedSessionId ??
      this.config.sessionId;
    if (expected && expected !== sessionId)
      throw new Error("Pi managed session identity changed.");
    const transcriptPath =
      typeof state.sessionFile === "string"
        ? path.resolve(state.sessionFile)
        : null;
    if (transcriptPath) {
      const root = fs.realpathSync(this.config.sessionDirectory);
      const canonical = fs.existsSync(transcriptPath)
        ? fs.realpathSync(transcriptPath)
        : path.join(
            fs.realpathSync(path.dirname(transcriptPath)),
            path.basename(transcriptPath)
          );
      const relative = path.relative(root, canonical);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(
          "Pi transcript is outside its managed session directory."
        );
      }
    }
    if (
      (this.identity?.transcriptPath ?? this.config.resumeSessionPath) &&
      transcriptPath !==
        path.resolve(
          this.identity?.transcriptPath ?? this.config.resumeSessionPath!
        )
    ) {
      throw new Error("Pi resumed a different transcript.");
    }
    return { provider: "pi", sessionId, transcriptPath };
  }

  async prompt(prompt: string): Promise<{
    identity: PiManagedConversationIdentity;
    text: string;
    turnId: string;
  }> {
    if (!this.identity || this.active)
      throw new Error("Pi managed session is not ready for a prompt.");
    let active!: NonNullable<PiManagedConversationSession["active"]>;
    const settled = new Promise<void>((resolve, reject) => {
      active = {
        resolve,
        reject,
        text: "",
        canceled: false,
        providerFailed: false,
        turnId: randomUUID()
      };
      this.active = active;
    });
    // A process failure can precede the prompt-acceptance response.
    void settled.catch(() => undefined);
    try {
      await this.request({ type: "prompt", message: prompt });
      await settled;
      this.identity = this.readIdentity(
        await this.request({ type: "get_state" })
      );
      return {
        identity: this.identity,
        text: active.text,
        turnId: active.turnId
      };
    } catch (error) {
      await this.closeAndWait();
      throw error;
    } finally {
      this.active = undefined;
    }
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    this.active.canceled = true;
    await this.request({ type: "abort" });
  }

  private request(
    command: Record<string, unknown>,
    timeoutMs = this.config.requestTimeoutMs ?? 10_000
  ): Promise<Record<string, unknown>> {
    if (!this.child || this.failure || this.closing)
      return Promise.reject(
        this.failure ?? new Error("Pi managed process is unavailable.")
      );
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error("Pi managed RPC request timed out.")),
        timeoutMs
      );
      this.requests.set(id, { resolve, reject, timer });
      this.write({ ...command, id });
    });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child || this.failure || this.closing) return;
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded, "utf8") > 4 * 1024 * 1024) {
      this.fail(new Error("Pi managed RPC input exceeded its size limit."));
      return;
    }
    this.child.stdin.write(`${encoded}\n`);
  }

  private receive(chunk: Buffer): void {
    if (this.failure || this.closing) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > 4 * 1024 * 1024)
          this.fail(
            new Error("Pi managed RPC record exceeded its size limit.")
          );
        return;
      }
      if (newline > 4 * 1024 * 1024) {
        this.fail(new Error("Pi managed RPC record exceeded its size limit."));
        return;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.length) continue;
      try {
        this.event(object(JSON.parse(line.toString("utf8"))));
      } catch {
        this.fail(new Error("Pi managed RPC emitted an invalid event."));
        return;
      }
    }
  }

  private event(event: Record<string, unknown>): void {
    if (event.type === "response" && typeof event.id === "string") {
      const pending = this.requests.get(event.id);
      if (!pending) return;
      this.requests.delete(event.id);
      clearTimeout(pending.timer);
      if (event.success === true) pending.resolve(object(event.data));
      else pending.reject(new Error("Pi managed RPC command was rejected."));
    } else if (event.type === "message_update" && this.active) {
      const delta = object(event.assistantMessageEvent);
      if (delta.type === "text_delta" && typeof delta.delta === "string") {
        this.active.text += delta.delta;
        if (Buffer.byteLength(this.active.text, "utf8") > 1024 * 1024)
          throw new Error("Pi managed text exceeded its size limit.");
        this.config.onTextDelta?.(delta.delta, this.active.turnId);
      }
    } else if (event.type === "message_end" && this.active) {
      const message = object(event.message);
      if (message.role === "assistant" && message.stopReason === "error") {
        this.active.providerFailed = true;
      }
    } else if (event.type === "agent_settled") {
      if (this.active?.canceled)
        this.active.reject(new Error("Pi managed turn canceled."));
      else if (this.active?.providerFailed)
        this.active.reject(new PiManagedConversationProviderError());
      else this.active?.resolve();
    } else if (
      event.type === "extension_ui_request" &&
      typeof event.id === "string"
    ) {
      const id = event.id;
      void this.config
        .onUiRequest(event, this.lifetime.signal)
        .then((response) => {
          this.write({ ...response, type: "extension_ui_response", id });
        })
        .catch(() =>
          this.write({ type: "extension_ui_response", id, cancelled: true })
        );
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.lifetime.abort();
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.requests.clear();
    this.active?.reject(error);
    this.kill();
  }

  private kill(): void {
    if (!this.child?.pid) return;
    if (process.platform === "win32") this.child.kill();
    else {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
    }
  }

  close(): void {
    this.closing = true;
    this.fail(new Error("Pi managed session closed."));
  }

  async closeAndWait(): Promise<void> {
    this.close();
    await this.closed;
  }
}
