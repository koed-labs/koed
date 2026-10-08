import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import type { MemoryAnswerTask } from "@koed/shared";
import {
  MemoryAnswerDelivery,
  type MemoryAnswerExecutionPort
} from "../integrations/pi/memory-answer-delivery.mjs";
import type { LocalRuntimeCallerContext } from "./local-runtime-protocol.js";
import { memoryAnswerInputSchema } from "./memory-tool-schemas.js";

export class CodexDetachedMemoryIneligible extends Error {}

export const CODEX_DELIVERY_NONCE = "_koed_delivery_nonce";
export interface CodexHookInput {
  hook_event_name: string;
  session_id: string;
  turn_id?: string;
  cwd: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean;
  subagent?: unknown;
}
interface Binding {
  nonce: string;
  tool: string;
  session: string;
  turn: string;
  call: string;
  cwd: string;
  inputHash: string;
  expires: number;
  state: "ready" | "accepted" | "bound";
  taskId?: string;
  invocationKey?: string;
}
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
const nonceValid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const canonicalCodexMemoryInput = (
  input: Record<string, unknown>
): Record<string, unknown> => {
  const clean = { ...input };
  delete clean[CODEX_DELIVERY_NONCE];
  return memoryAnswerInputSchema.parse(clean);
};
const inputHash = (input: Record<string, unknown>): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalCodexMemoryInput(input)))
    .digest("hex");
const denied = (): Error =>
  new Error("Koed deferred Memory Answer receipt is unavailable or invalid");

// Windows reports synthetic POSIX mode bits and has no O_NOFOLLOW, so the
// owner-only mode checks apply on POSIX hosts only (as in the Pi runtime client).
const posixPermissions = (): boolean => process.platform !== "win32";
const noFollow = (): number =>
  process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

/** Private one-use receipts contain identity only, never task results or credentials. */
export class CodexMemoryReceiptStore {
  readonly directory: string;
  constructor(
    home: string,
    private readonly now: () => number = Date.now
  ) {
    this.directory = path.join(home, "codex-memory-delivery");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (posixPermissions() && (stat.mode & 0o077) !== 0) ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw denied();
  }
  private filename(nonce: string, spent = false): string {
    if (!nonceValid(nonce)) throw denied();
    return path.join(this.directory, `${nonce}${spent ? ".spent" : ".json"}`);
  }
  private read(filename: string): Binding | undefined {
    let fd: number;
    try {
      fd = openSync(filename, constants.O_RDONLY | noFollow());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw denied();
    }
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size > 8192 ||
        (posixPermissions() && (stat.mode & 0o077) !== 0) ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw denied();
      const value = JSON.parse(readFileSync(fd, "utf8")) as Binding;
      if (
        !nonceValid(value.nonce) ||
        value.nonce !== path.basename(filename).split(".")[0] ||
        typeof value.tool !== "string" ||
        value.tool.length > 256 ||
        !validId(value.session) ||
        !validId(value.turn) ||
        !validId(value.call) ||
        !path.isAbsolute(value.cwd) ||
        !/^[a-f0-9]{64}$/.test(value.inputHash) ||
        !Number.isFinite(value.expires) ||
        !["ready", "accepted", "bound"].includes(value.state)
      )
        throw denied();
      return value;
    } finally {
      closeSync(fd);
    }
  }
  private write(value: Binding, create = false): void {
    const target = this.filename(value.nonce);
    const temporary = path.join(
      this.directory,
      `.write-${randomBytes(16).toString("hex")}`
    );
    try {
      writeFileSync(temporary, JSON.stringify(value), {
        mode: 0o600,
        flag: "wx"
      });
      if (create) linkSync(temporary, target);
      else renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  private locked<T>(nonce: string, operation: () => T): T {
    const lock = `${this.filename(nonce)}.lock`;
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch {
      throw denied();
    }
    try {
      return operation();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  // Directory scans skip an unreadable, oversized or foreign entry instead of
  // failing: one bad file must not disable deferred delivery for every call.
  // Skipped state is never claimed, and repair removes it.
  private scan(filename: string): Binding | undefined {
    try {
      return this.read(filename);
    } catch {
      return undefined;
    }
  }
  private collectExpired(): void {
    for (const name of readdirSync(this.directory).slice(0, 512)) {
      if (!/^[a-f0-9]{64}\.(json|spent)$/.test(name)) continue;
      const value = this.scan(path.join(this.directory, name));
      if (!value || value.expires > this.now()) continue;
      try {
        this.locked(value.nonce, () => {
          const current = this.read(path.join(this.directory, name));
          if (current && current.expires <= this.now()) {
            rmSync(this.filename(value.nonce), { force: true });
            rmSync(this.filename(value.nonce, true), { force: true });
          }
        });
      } catch {
        // An unavailable lock fences this receipt only. Never break another
        // process's lock or infer that its uncertain start did not execute.
        // Orphan locks require owned-state repair with hook/MCP processes stopped.
      }
    }
  }
  prepare(hook: CodexHookInput, tool: string): Record<string, unknown> {
    if (
      (hook.subagent !== undefined && hook.subagent !== null) ||
      hook.tool_name !== tool ||
      !validId(hook.session_id) ||
      !validId(hook.turn_id) ||
      !validId(hook.tool_use_id) ||
      !path.isAbsolute(hook.cwd) ||
      !hook.tool_input
    )
      return {};
    const input = canonicalCodexMemoryInput(hook.tool_input);
    if (input.team_workspace_id !== undefined) return {};
    this.collectExpired();
    const turnLock = createHash("sha256")
      .update(JSON.stringify([hook.session_id, hook.turn_id]))
      .digest("hex");
    return this.locked(turnLock, () => {
      const names = readdirSync(this.directory);
      if (names.length >= 256) return {};
      // Include ready and spent: simultaneous calls cannot both get pending receipts.
      for (const name of names.filter((n) =>
        /^[a-f0-9]{64}\.(json|spent)$/.test(n)
      )) {
        const existing = this.scan(path.join(this.directory, name));
        if (
          existing &&
          existing.session === hook.session_id &&
          existing.turn === hook.turn_id
        )
          return {};
      }
      const nonce = randomBytes(32).toString("hex");
      this.write(
        {
          nonce,
          tool,
          session: hook.session_id,
          turn: hook.turn_id!,
          call: hook.tool_use_id!,
          cwd: path.resolve(hook.cwd),
          inputHash: inputHash(input),
          expires: this.now() + 30_000,
          state: "ready"
        },
        true
      );
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          // Codex validates this together with updatedInput; normal MCP approval
          // still runs after the hook rewrite.
          permissionDecision: "allow",
          updatedInput: { ...input, [CODEX_DELIVERY_NONCE]: nonce }
        }
      };
    });
  }
  consume(
    nonce: string,
    input: Record<string, unknown>,
    caller: LocalRuntimeCallerContext,
    metadata?: Record<string, unknown>,
    memoryTool = "mcp__koed__memory_answer"
  ): Binding {
    return this.locked(nonce, () => {
      const value = this.read(this.filename(nonce));
      if (
        !value ||
        value.state !== "ready" ||
        value.tool !== memoryTool ||
        value.expires <= this.now() ||
        value.cwd !== path.resolve(caller.cwd) ||
        value.inputHash !== inputHash(input)
      )
        throw denied();
      const turnMetadata = metadata?.["x-codex-turn-metadata"] as
        | Record<string, unknown>
        | undefined;
      if (
        !metadata ||
        metadata.sessionId !== value.session ||
        metadata.callId !== value.call ||
        !turnMetadata ||
        turnMetadata.turn_id !== value.turn
      )
        throw denied();
      // Consume before any await. Crashes/retries fail closed rather than submit twice.
      value.state = "accepted";
      this.write(value);
      return value;
    });
  }
  accepted(binding: Binding, task: MemoryAnswerTask): void {
    this.locked(binding.nonce, () => {
      const current = this.read(this.filename(binding.nonce));
      if (!current || current.state !== "accepted" || current.taskId)
        throw denied();
      this.write({
        ...current,
        taskId: task.id,
        invocationKey: task.invocationKey ?? undefined,
        expires: Date.parse(task.expiresAt)
      });
    });
  }
  bind(hook: CodexHookInput, tool: string): void {
    if (hook.tool_name !== tool || !hook.tool_input) return;
    const nonce = hook.tool_input[CODEX_DELIVERY_NONCE];
    if (!nonceValid(nonce)) return;
    const response = hook.tool_response as Record<string, unknown> | undefined;
    const payload = response?.structuredContent as
      | Record<string, unknown>
      | undefined;
    const receipt = (payload ?? response)?.koedPendingMemoryAnswer as
      | Record<string, unknown>
      | undefined;
    if (!receipt || receipt.receiptId !== nonce || receipt.version !== 1)
      return;
    this.locked(nonce, () => {
      const value = this.read(this.filename(nonce));
      if (
        !value ||
        value.state !== "accepted" ||
        !value.taskId ||
        value.session !== hook.session_id ||
        value.turn !== hook.turn_id ||
        value.call !== hook.tool_use_id ||
        value.cwd !== path.resolve(hook.cwd) ||
        value.inputHash !== inputHash(hook.tool_input!)
      )
        throw denied();
      this.write({ ...value, state: "bound" });
    });
  }
  claim(hook: CodexHookInput, memoryTool: string): Binding | undefined {
    if (
      !validId(hook.session_id) ||
      !validId(hook.turn_id) ||
      !path.isAbsolute(hook.cwd)
    )
      return undefined;
    const matches = (value: Binding | undefined): value is Binding =>
      !!value &&
      value.state === "bound" &&
      value.tool === memoryTool &&
      value.session === hook.session_id &&
      value.turn === hook.turn_id &&
      value.cwd === path.resolve(hook.cwd);
    for (const name of readdirSync(this.directory)
      .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
      .slice(0, 256)) {
      const nonce = name.slice(0, 64);
      // An unrelated receipt's occupied or orphaned lock must not prevent this
      // owner from claiming its result. This read authorizes no mutation;
      // ownership is checked again after acquiring the selected receipt lock.
      let candidate: Binding | undefined;
      try {
        candidate = this.read(this.filename(nonce));
      } catch {
        // Invalid/unavailable state cannot establish ownership or be claimed.
        continue;
      }
      if (!matches(candidate)) continue;
      const claimed = this.locked(nonce, () => {
        const value = this.read(this.filename(nonce));
        if (!matches(value)) return undefined;
        renameSync(this.filename(nonce), this.filename(nonce, true));
        return value;
      });
      if (claimed) return claimed;
    }
    return undefined;
  }
  owned(binding: Binding): boolean {
    const value = this.read(this.filename(binding.nonce, true));
    return !!value && value.taskId === binding.taskId;
  }
  current(binding: Binding): boolean {
    const value = this.read(this.filename(binding.nonce, true));
    return (
      !!value && value.expires > this.now() && value.taskId === binding.taskId
    );
  }
  retire(hook: CodexHookInput, session = false): void {
    if (!validId(hook.session_id) || (!session && !validId(hook.turn_id)))
      return;
    for (const name of readdirSync(this.directory)
      .filter((n) => /^[a-f0-9]{64}\.(json|spent)$/.test(n))
      .slice(0, 256)) {
      const value = this.scan(path.join(this.directory, name));
      if (
        value?.session === hook.session_id &&
        (session || value.turn === hook.turn_id)
      ) {
        try {
          this.locked(value.nonce, () => {
            rmSync(this.filename(value.nonce), { force: true });
            rmSync(this.filename(value.nonce, true), { force: true });
          });
        } catch {
          // A busy lock fences this receipt only; retire the others.
        }
      }
    }
  }
}

export class CodexMemoryDelivery {
  private readonly delivery: MemoryAnswerDelivery<
    MemoryAnswerTask,
    Record<string, unknown>,
    LocalRuntimeCallerContext
  >;
  constructor(
    private readonly store: CodexMemoryReceiptStore,
    port: MemoryAnswerExecutionPort<
      MemoryAnswerTask,
      Record<string, unknown>,
      LocalRuntimeCallerContext
    >,
    maxObservationMs = 300_000,
    private readonly memoryTool = "mcp__koed__memory_answer"
  ) {
    this.delivery = new MemoryAnswerDelivery(port, {
      maxObservationMs
    });
  }
  async accept(
    input: Record<string, unknown>,
    caller: LocalRuntimeCallerContext,
    signal?: AbortSignal,
    metadata?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const nonce = input[CODEX_DELIVERY_NONCE];
    if (nonce === undefined) return undefined;
    if (!nonceValid(nonce)) throw denied();
    const clean = canonicalCodexMemoryInput(input);
    const binding = this.store.consume(
      nonce,
      clean,
      caller,
      metadata,
      this.memoryTool
    );
    const nativeTurn = metadata?.["x-codex-turn-metadata"] as Record<
      string,
      unknown
    >;
    if (nativeTurn.thread_source !== "user") {
      this.store.retire({
        hook_event_name: "Interrupt",
        session_id: binding.session,
        turn_id: binding.turn,
        cwd: binding.cwd
      });
      return undefined; // Unsupported native mode: no task has been accepted.
    }
    let task: MemoryAnswerTask;
    try {
      task = await this.delivery.accept(
        clean,
        caller,
        `codex-stop:${createHash("sha256")
          .update(JSON.stringify([binding.session, binding.turn, binding.call]))
          .digest("hex")}`,
        signal
      );
    } catch (error) {
      if (!(error instanceof CodexDetachedMemoryIneligible))
        // eslint-disable-next-line preserve-caught-error -- The task-port error may contain private provider payloads; expose only a static delivery failure.
        throw new Error(
          "Koed Memory Answer task acceptance could not be confirmed. Do not resubmit this request."
        );
      // The maintained runtime rejects detached Team work before scheduler.start.
      this.store.retire({
        hook_event_name: "Interrupt",
        session_id: binding.session,
        turn_id: binding.turn,
        cwd: binding.cwd
      });
      return undefined;
    }
    this.store.accepted(binding, task);
    return {
      status: "pending",
      koedPendingMemoryAnswer: { version: 1, receiptId: nonce },
      message:
        "Koed Memory Answer is accepted. Continue independent work. The native Stop hook will await completion outside the model loop; do not poll or retry this request."
    };
  }
  async stop(
    hook: CodexHookInput,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (hook.stop_hook_active !== false) return {};
    const binding = this.store.claim(hook, this.memoryTool);
    if (!binding?.taskId) return {};
    let response: Record<string, unknown> = {};
    try {
      const observed = await this.delivery.observe(binding.taskId, {
        signal,
        isCurrent: (task) =>
          this.store.current(binding) &&
          (!task ||
            (task.id === binding.taskId &&
              task.invocationKey === binding.invocationKey)),
        present: (task) => {
          if (task.status !== "completed" || !task.result) {
            response = {
              decision: "block",
              reason: `Koed Memory Answer ${task.status === "cancelled" ? "was cancelled" : "failed"}. No answer is available. Do not retry or poll this accepted request.`
            };
            return;
          }
          const result = JSON.stringify(task.result);
          if (Buffer.byteLength(result) > 512_000) {
            response = {
              decision: "block",
              reason:
                "Koed Memory Answer exceeds the native presentation limit. No truncated answer or Evidence Bundle was delivered. Do not poll or retry this accepted request."
            };
            return;
          }
          response = {
            decision: "block",
            reason: `Koed Memory Answer completed for the original recall request. Use this authorized result to finish the answer; do not poll or repeat the recall tool.\n${result}`
          };
        }
      });
      if (
        observed.kind === "detached" &&
        this.store.owned(binding) &&
        !signal?.aborted
      )
        response = {
          decision: "block",
          reason:
            "Koed Memory Answer observation ended before a result was available (timeout or expiry). No cached answer is available. Do not poll or retry this accepted request."
        };
      return this.store.owned(binding) ? response : {};
    } catch {
      return this.store.owned(binding) && !signal?.aborted
        ? {
            decision: "block",
            reason:
              "Koed Memory Answer is unavailable or access was denied. No cached answer is available. Do not poll or retry this accepted request."
          }
        : {};
    }
    // Spent identity remains until expiry/SessionEnd/Interrupt. Native Stop
    // continuations set stop_hook_active, so another recall in this turn blocks.
  }
}
