import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { MemorySourceRepository } from "@koed/db";
import {
  managedTerminalClientFrameSchema,
  MANAGED_TERMINAL_CONTEXT_TTL_SECONDS,
  MANAGED_TERMINAL_MAX_CONTEXT_BYTES,
  MANAGED_TERMINAL_MAX_DATA_BYTES,
  MANAGED_TERMINAL_PROTOCOL_VERSION,
  type CreateManagedTerminalInput,
  type DeviceIdentityInspection,
  type ManagedTerminalContextReference,
  type ManagedTerminalRecord,
  type ManagedTerminalServerFrame
} from "@koed/shared";
import {
  createGitExecutionWorkspaceDriver,
  type ExecutionWorkspaceIdentity
} from "@koed/shared/execution-workspace";
import * as nodePty from "node-pty";

import { verifyLoopbackListenerOwnership } from "./listener-ownership.js";

const maximumRuntimeTerminals = 32;
const maximumReplayBytes = 1024 * 1024;
const stopGraceMs = 3_000;
const execFileAsync = promisify(execFile);

type TerminalOutput = {
  sequence: number;
  data: Buffer;
};

type RuntimeTerminal = {
  ownerUserId: string;
  executionId: string;
  record: ManagedTerminalRecord;
  pty: nodePty.IPty;
  outputs: TerminalOutput[];
  outputBytes: number;
  nextOutputSequence: number;
  attachments: Set<(frame: ManagedTerminalServerFrame) => void>;
  detachTimer: ReturnType<typeof setTimeout> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  previewText: string;
  emittedPreviewOrigins: Set<string>;
};

export type ManagedTerminalPreviewSignal =
  | {
      type: "candidate";
      ownerUserId: string;
      executionId: string;
      executionGeneration: number;
      terminalId: string;
      url: string;
    }
  | {
      type: "closed";
      ownerUserId: string;
      executionId: string;
      executionGeneration: number;
      terminalId: string;
    };

type ContextEntry = ManagedTerminalContextReference & {
  ownerUserId: string;
  executionId: string;
  content: string;
};

export interface ManagedTerminalAttachment {
  initialFrames: ManagedTerminalServerFrame[];
  handle(frame: unknown): Promise<ManagedTerminalServerFrame[]>;
  subscribe(listener: (frame: ManagedTerminalServerFrame) => void): () => void;
  close(): Promise<void>;
}

export interface ManagedTerminalRuntime {
  initialize(): Promise<void>;
  shellProfiles(): Promise<
    Array<{ id: "system_default"; label: string; available: boolean }>
  >;
  create(
    ownerUserId: string,
    executionId: string,
    input: CreateManagedTerminalInput
  ): Promise<ManagedTerminalRecord>;
  attach(input: {
    ownerUserId: string;
    executionId: string;
    terminalId: string;
    lifecycleGeneration: number;
    afterOutputSequence: number;
  }): Promise<ManagedTerminalAttachment>;
  stop(input: {
    ownerUserId: string;
    executionId: string;
    terminalId: string;
  }): Promise<ManagedTerminalRecord>;
  resolveContext(input: {
    ownerUserId: string;
    executionId: string;
    contextReference: string;
  }): ManagedTerminalContextReference & { content: string };
  verifyPreviewListener(input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
    terminalId: string;
    port: number;
  }): Promise<boolean>;
  subscribePreviewSignals(
    listener: (signal: ManagedTerminalPreviewSignal) => void
  ): () => void;
  hasLiveExecutionTerminal(input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
  }): boolean;
  close(): Promise<void>;
}

const terminalError = (message: string, statusCode: number, code: string) =>
  Object.assign(new Error(message), { statusCode, code });

const workspaceIdentityFor = (
  binding: NonNullable<
    Awaited<
      ReturnType<MemorySourceRepository["getManagedConversationRuntimeBinding"]>
    >
  >
): ExecutionWorkspaceIdentity => ({
  workspaceId: binding.workspaceId!,
  vcsDriver: binding.vcsDriver,
  ownership:
    binding.workspaceKind === "pending"
      ? "non_vcs_directory"
      : binding.workspaceKind,
  canonicalPath: binding.projectPath,
  localRepositoryCommonDirectory: binding.localRepositoryCommonDirectory,
  localGitDirectory: binding.localGitDirectory,
  repositoryIdentityHash: binding.repositoryIdentityHash,
  worktreeIdentityHash: binding.worktreeIdentityHash,
  baseRef: binding.baseRef,
  baseObjectId: binding.baseObjectId,
  branchRef: binding.branchRef,
  headObjectId: binding.headObjectId
});

const candidateShell = (): {
  executable: string;
  args: string[];
  label: string;
} =>
  platform() === "win32"
    ? {
        executable:
          process.env.ComSpec ??
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        args: ["-NoLogo"],
        label: "System shell"
      }
    : {
        executable:
          process.env.SHELL?.startsWith("/") === true
            ? process.env.SHELL
            : "/bin/sh",
        args: ["-l"],
        label: "System shell"
      };

const resolveShell = async () => {
  const candidate = candidateShell();
  const executable = await realpath(candidate.executable).catch(() => null);
  if (!executable) return null;
  const metadata = await stat(executable).catch(() => null);
  if (!metadata?.isFile()) return null;
  if (platform() !== "win32") {
    await access(executable, constants.X_OK).catch(() => {
      throw terminalError(
        "System shell is unavailable",
        503,
        "shell_unavailable"
      );
    });
  }
  return { ...candidate, executable };
};

const terminalEnvironment = (shell: string): Record<string, string> => {
  const names = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR"
  ] as const;
  const env: Record<string, string> = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    SHELL: shell
  };
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

const splitOutput = (value: string): Buffer[] => {
  const data = Buffer.from(value, "utf8");
  const chunks: Buffer[] = [];
  for (
    let offset = 0;
    offset < data.byteLength;
    offset += MANAGED_TERMINAL_MAX_DATA_BYTES
  ) {
    chunks.push(
      data.subarray(offset, offset + MANAGED_TERMINAL_MAX_DATA_BYTES)
    );
  }
  return chunks;
};

const terminalUrlPattern =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?:\/[^\s\u0000-\u001f]*)?/giu; // eslint-disable-line no-control-regex
const ansiEscapePattern =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu; // eslint-disable-line no-control-regex

export const terminalPreviewUrls = (value: string): string[] => {
  const urls = new Set<string>();
  for (const match of value
    .replace(ansiEscapePattern, "")
    .matchAll(terminalUrlPattern)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/u, ""));
      if (
        url.username ||
        url.password ||
        !url.port ||
        !["localhost", "127.0.0.1", "[::1]"].includes(
          url.hostname.toLowerCase()
        )
      ) {
        continue;
      }
      url.hash = "";
      urls.add(url.toString());
    } catch {
      // Terminal text is untrusted and malformed candidates are ignored.
    }
  }
  return [...urls];
};

export const createManagedTerminalRuntime = (options: {
  requireRepository(): MemorySourceRepository;
  inspectIdentity(): DeviceIdentityInspection;
  koedHome: string;
  detachedTtlMs?: number;
  verifyPreviewListenerOwnership?: typeof verifyLoopbackListenerOwnership;
  onError?: (error: unknown, code: string) => void;
}): ManagedTerminalRuntime => {
  const terminals = new Map<string, RuntimeTerminal>();
  const contexts = new Map<string, ContextEntry>();
  const previewSignalListeners = new Set<
    (signal: ManagedTerminalPreviewSignal) => void
  >();
  let initialized = false;
  let initialization: Promise<void> | null = null;
  let closed = false;
  let workspaceDriver: ReturnType<
    typeof createGitExecutionWorkspaceDriver
  > | null = null;
  const requireWorkspaceDriver = () =>
    (workspaceDriver ??= createGitExecutionWorkspaceDriver({
      managedRoot: resolve(options.koedHome, "managed-workspaces", "worktrees")
    }));
  const detachedTtlMs = options.detachedTtlMs ?? 30 * 60 * 1_000;
  const verifyPreviewListenerOwnership =
    options.verifyPreviewListenerOwnership ?? verifyLoopbackListenerOwnership;

  if (!Number.isSafeInteger(detachedTtlMs) || detachedTtlMs < 1) {
    throw new TypeError("Managed terminal detached lifetime is invalid");
  }

  const identity = () => {
    const current = options.inspectIdentity();
    if (
      current.health !== "healthy" ||
      !current.deploymentId ||
      !current.deviceInstanceId
    ) {
      throw terminalError(
        "Verified runner identity is required",
        503,
        "runner_identity_unavailable"
      );
    }
    return {
      deploymentId: current.deploymentId,
      deviceId: current.deviceInstanceId
    };
  };

  const initialize = async () => {
    if (initialized) return;
    initialization ??= (async () => {
      const runner = identity();
      await options.requireRepository().reconcileManagedTerminalsForRunner({
        runnerDeploymentId: runner.deploymentId,
        runnerDeviceId: runner.deviceId,
        failureCode: "terminal_runtime_restarted"
      });
      initialized = true;
    })().finally(() => {
      initialization = null;
    });
    await initialization;
  };

  const transition = async (
    runtime: RuntimeTerminal,
    state: ManagedTerminalRecord["state"],
    details: {
      columns?: number;
      rows?: number;
      exitCode?: number | null;
      exitSignal?: number | null;
      failureCode?: string | null;
    } = {}
  ): Promise<ManagedTerminalRecord> => {
    const updated = await options
      .requireRepository()
      .transitionManagedTerminal({
        ownerUserId: runtime.ownerUserId,
        terminalId: runtime.record.id,
        executionGeneration: runtime.record.executionGeneration,
        lifecycleGeneration: runtime.record.lifecycleGeneration,
        runnerDeploymentId: runtime.record.runnerDeploymentId,
        runnerDeviceId: runtime.record.runnerDeviceId,
        fromStates: [runtime.record.state],
        state,
        ...details
      });
    if (!updated) {
      throw terminalError("Terminal authority changed", 409, "terminal_fenced");
    }
    runtime.record = updated;
    return updated;
  };

  const emit = (
    runtime: RuntimeTerminal,
    frame: ManagedTerminalServerFrame
  ) => {
    for (const listener of runtime.attachments) listener(frame);
  };

  const emitPreviewSignal = (signal: ManagedTerminalPreviewSignal) => {
    for (const listener of previewSignalListeners) listener(signal);
  };

  const signalProcessTree = async (
    runtime: RuntimeTerminal,
    signal: "SIGTERM" | "SIGKILL"
  ) => {
    if (platform() === "win32") {
      runtime.pty.kill();
      return;
    }
    const childrenByParent = new Map<number, number[]>();
    const { stdout } = await execFileAsync("/bin/ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const children = childrenByParent.get(parentPid) ?? [];
      children.push(pid);
      childrenByParent.set(parentPid, children);
    }
    const ordered: number[] = [];
    const visit = (pid: number) => {
      for (const childPid of childrenByParent.get(pid) ?? []) visit(childPid);
      ordered.push(pid);
    };
    visit(runtime.pty.pid);
    const targets = [-runtime.pty.pid, ...ordered];
    let firstFailure: unknown;
    for (const pid of targets) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ESRCH"
        ) {
          continue;
        }
        firstFailure ??= error;
      }
    }
    if (firstFailure) throw firstFailure;
  };

  const exitFrame = (runtime: RuntimeTerminal): ManagedTerminalServerFrame => ({
    protocolVersion: MANAGED_TERMINAL_PROTOCOL_VERSION,
    terminalId: runtime.record.id,
    lifecycleGeneration: runtime.record.lifecycleGeneration,
    type: "terminal.exit",
    exitCode: runtime.record.exitCode,
    exitSignal: runtime.record.exitSignal,
    failureCode: runtime.record.failureCode
  });

  const start = async (
    ownerUserId: string,
    executionId: string,
    record: ManagedTerminalRecord
  ): Promise<ManagedTerminalRecord> => {
    if (closed)
      throw terminalError("Terminal runtime is closed", 503, "runtime_closed");
    const existing = terminals.get(record.id);
    if (existing) return existing.record;
    if (record.state !== "creating") return record;
    if (terminals.size >= maximumRuntimeTerminals) {
      throw terminalError(
        "Terminal runtime limit reached",
        503,
        "runtime_limit"
      );
    }
    const runner = identity();
    if (
      record.runnerDeploymentId !== runner.deploymentId ||
      record.runnerDeviceId !== runner.deviceId
    ) {
      throw terminalError(
        "Terminal is assigned to another runner",
        409,
        "runner_mismatch"
      );
    }
    const repository = options.requireRepository();
    const [execution, binding, shell] = await Promise.all([
      repository.getManagedConversationExecution(
        { userId: ownerUserId },
        executionId
      ),
      repository.getManagedConversationRuntimeBinding(
        { userId: ownerUserId },
        executionId
      ),
      resolveShell()
    ]);
    if (!execution || !binding) {
      throw terminalError(
        "Terminal execution was not found",
        404,
        "execution_missing"
      );
    }
    if (
      execution.executionGeneration !== record.executionGeneration ||
      binding.executionGeneration !== record.executionGeneration ||
      binding.workspaceLifecycle !== "ready" ||
      binding.workspaceId !== record.workspaceId ||
      binding.deploymentId !== runner.deploymentId ||
      binding.deviceId !== runner.deviceId
    ) {
      throw terminalError(
        "Terminal workspace authority is stale",
        409,
        "workspace_stale"
      );
    }
    if (!shell) {
      throw terminalError(
        "System shell is unavailable",
        503,
        "shell_unavailable"
      );
    }
    const verified = await (
      await requireWorkspaceDriver()
    ).verify(workspaceIdentityFor(binding));
    if (
      verified.workspaceId !== record.workspaceId ||
      verified.canonicalPath !== binding.projectPath
    ) {
      throw terminalError(
        "Terminal workspace identity changed",
        409,
        "workspace_changed"
      );
    }
    let pty: nodePty.IPty;
    try {
      pty = nodePty.spawn(shell.executable, shell.args, {
        name: "xterm-256color",
        cols: record.columns,
        rows: record.rows,
        cwd: verified.canonicalPath,
        env: terminalEnvironment(shell.executable),
        encoding: "utf8"
      });
    } catch (error) {
      const failed = {
        ownerUserId,
        executionId,
        record,
        pty: null,
        outputs: [],
        outputBytes: 0,
        nextOutputSequence: 1,
        attachments: new Set(),
        detachTimer: null,
        stopTimer: null,
        previewText: "",
        emittedPreviewOrigins: new Set()
      } as unknown as RuntimeTerminal;
      await transition(failed, "failed", {
        failureCode: "terminal_spawn_failed"
      });
      options.onError?.(error, "terminal_spawn_failed");
      throw terminalError(
        "Terminal could not start",
        503,
        "terminal_spawn_failed"
      );
    }
    const runtime: RuntimeTerminal = {
      ownerUserId,
      executionId,
      record,
      pty,
      outputs: [],
      outputBytes: 0,
      nextOutputSequence: 1,
      attachments: new Set(),
      detachTimer: null,
      stopTimer: null,
      previewText: "",
      emittedPreviewOrigins: new Set()
    };
    terminals.set(record.id, runtime);
    const activation = transition(runtime, "running");
    pty.onData((value) => {
      runtime.previewText = `${runtime.previewText}${value}`.slice(-8_192);
      for (const candidate of terminalPreviewUrls(runtime.previewText)) {
        const origin = new URL(candidate).origin;
        if (runtime.emittedPreviewOrigins.has(origin)) continue;
        runtime.emittedPreviewOrigins.add(origin);
        emitPreviewSignal({
          type: "candidate",
          ownerUserId: runtime.ownerUserId,
          executionId: runtime.executionId,
          executionGeneration: runtime.record.executionGeneration,
          terminalId: runtime.record.id,
          url: candidate
        });
      }
      for (const data of splitOutput(value)) {
        const output = { sequence: runtime.nextOutputSequence++, data };
        runtime.outputs.push(output);
        runtime.outputBytes += data.byteLength;
        while (
          runtime.outputBytes > maximumReplayBytes &&
          runtime.outputs.length > 1
        ) {
          runtime.outputBytes -= runtime.outputs.shift()!.data.byteLength;
        }
        emit(runtime, {
          protocolVersion: MANAGED_TERMINAL_PROTOCOL_VERSION,
          terminalId: runtime.record.id,
          lifecycleGeneration: runtime.record.lifecycleGeneration,
          type: "terminal.output",
          sequence: output.sequence,
          dataBase64: output.data.toString("base64")
        });
      }
    });
    pty.onExit(({ exitCode, signal }) => {
      emitPreviewSignal({
        type: "closed",
        ownerUserId: runtime.ownerUserId,
        executionId: runtime.executionId,
        executionGeneration: runtime.record.executionGeneration,
        terminalId: runtime.record.id
      });
      if (runtime.detachTimer) clearTimeout(runtime.detachTimer);
      runtime.detachTimer = null;
      if (!runtime.stopTimer && platform() !== "win32") {
        try {
          void signalProcessTree(runtime, "SIGTERM").catch((error) =>
            options.onError?.(error, "terminal_descendant_cleanup")
          );
          runtime.stopTimer = setTimeout(() => {
            runtime.stopTimer = null;
            void signalProcessTree(runtime, "SIGKILL").catch((error) =>
              options.onError?.(error, "terminal_descendant_cleanup")
            );
          }, stopGraceMs);
          runtime.stopTimer.unref?.();
        } catch (error) {
          options.onError?.(error, "terminal_descendant_cleanup");
        }
      }
      void activation
        .then(() =>
          transition(runtime, "exited", {
            exitCode,
            exitSignal: signal ?? null
          })
        )
        .then(() => emit(runtime, exitFrame(runtime)))
        .catch((error) => options.onError?.(error, "terminal_exit_transition"))
        .finally(() => terminals.delete(runtime.record.id));
    });
    try {
      return await activation;
    } catch (error) {
      terminals.delete(record.id);
      try {
        pty.kill(platform() === "win32" ? undefined : "SIGKILL");
      } catch (killError) {
        options.onError?.(killError, "terminal_activation_cleanup");
      }
      throw error;
    }
  };

  const stopRuntime = async (runtime: RuntimeTerminal) => {
    if (["exited", "failed"].includes(runtime.record.state))
      return runtime.record;
    if (runtime.record.state !== "stopping")
      await transition(runtime, "stopping");
    if (runtime.detachTimer) clearTimeout(runtime.detachTimer);
    runtime.detachTimer = null;
    await signalProcessTree(runtime, "SIGTERM");
    if (!runtime.stopTimer) {
      runtime.stopTimer = setTimeout(() => {
        runtime.stopTimer = null;
        void signalProcessTree(runtime, "SIGKILL").catch((error) =>
          options.onError?.(error, "terminal_force_stop")
        );
      }, stopGraceMs);
      runtime.stopTimer.unref?.();
    }
    return runtime.record;
  };

  return {
    initialize,

    async shellProfiles() {
      return [
        {
          id: "system_default",
          label: "System shell",
          available: Boolean(await resolveShell())
        }
      ];
    },

    async create(ownerUserId, executionId, input) {
      await initialize();
      const record = await options
        .requireRepository()
        .createManagedTerminal(
          { userId: ownerUserId },
          { executionId, ...input }
        );
      return start(ownerUserId, executionId, record);
    },

    async attach(input) {
      await initialize();
      const record = await options
        .requireRepository()
        .getManagedTerminal(
          { userId: input.ownerUserId },
          { executionId: input.executionId, terminalId: input.terminalId }
        );
      if (!record)
        throw terminalError("Terminal was not found", 404, "terminal_missing");
      if (record.lifecycleGeneration !== input.lifecycleGeneration) {
        throw terminalError(
          "Terminal lifecycle is stale",
          409,
          "terminal_fenced"
        );
      }
      const runtime = terminals.get(record.id);
      if (!runtime) {
        throw terminalError(
          "Terminal process is not available",
          409,
          "terminal_unavailable"
        );
      }
      if (runtime.detachTimer) clearTimeout(runtime.detachTimer);
      runtime.detachTimer = null;
      if (runtime.record.state === "detached")
        await transition(runtime, "running");
      if (runtime.record.state !== "running") {
        throw terminalError(
          "Terminal is not running",
          409,
          "terminal_not_running"
        );
      }
      const earliest =
        runtime.outputs[0]?.sequence ?? runtime.nextOutputSequence;
      const latest = runtime.nextOutputSequence - 1;
      const inputEpoch = randomUUID();
      let lastInputSequence = 0;
      let closedAttachment = false;
      const listeners = new Set<(frame: ManagedTerminalServerFrame) => void>();
      const forward = (frame: ManagedTerminalServerFrame) => {
        for (const listener of listeners) listener(frame);
      };
      runtime.attachments.add(forward);
      const initialFrames: ManagedTerminalServerFrame[] = [
        {
          protocolVersion: MANAGED_TERMINAL_PROTOCOL_VERSION,
          terminalId: record.id,
          lifecycleGeneration: record.lifecycleGeneration,
          type: "terminal.ready",
          requestedAfterOutputSequence: input.afterOutputSequence,
          earliestOutputSequence: earliest,
          latestOutputSequence: latest,
          inputEpoch
        }
      ];
      if (input.afterOutputSequence + 1 < earliest) {
        initialFrames.push({
          protocolVersion: MANAGED_TERMINAL_PROTOCOL_VERSION,
          terminalId: record.id,
          lifecycleGeneration: record.lifecycleGeneration,
          type: "terminal.replay_gap",
          requestedAfterOutputSequence: input.afterOutputSequence,
          earliestOutputSequence: earliest
        });
      }
      for (const output of runtime.outputs) {
        if (output.sequence > input.afterOutputSequence) {
          initialFrames.push({
            protocolVersion: MANAGED_TERMINAL_PROTOCOL_VERSION,
            terminalId: record.id,
            lifecycleGeneration: record.lifecycleGeneration,
            type: "terminal.output",
            sequence: output.sequence,
            dataBase64: output.data.toString("base64")
          });
        }
      }
      return {
        initialFrames,
        async handle(value) {
          if (closedAttachment) {
            throw terminalError(
              "Terminal attachment is closed",
              409,
              "attachment_closed"
            );
          }
          const frame = managedTerminalClientFrameSchema.parse(value);
          if (
            frame.terminalId !== record.id ||
            frame.lifecycleGeneration !== record.lifecycleGeneration
          ) {
            throw terminalError(
              "Terminal frame is fenced",
              409,
              "terminal_fenced"
            );
          }
          if (frame.type === "terminal.input") {
            if (frame.inputEpoch !== inputEpoch) {
              throw terminalError(
                "Terminal input epoch is stale",
                409,
                "input_epoch_stale"
              );
            }
            if (frame.sequence > lastInputSequence + 1) {
              throw terminalError(
                "Terminal input sequence has a gap",
                409,
                "input_sequence_gap"
              );
            }
            if (frame.sequence === lastInputSequence + 1) {
              const data = Buffer.from(frame.dataBase64, "base64");
              if (data.byteLength > MANAGED_TERMINAL_MAX_DATA_BYTES) {
                throw terminalError(
                  "Terminal input is too large",
                  413,
                  "input_too_large"
                );
              }
              runtime.pty.write(data);
              lastInputSequence = frame.sequence;
            }
            return [
              {
                protocolVersion: MANAGED_TERMINAL_PROTOCOL_VERSION,
                terminalId: record.id,
                lifecycleGeneration: record.lifecycleGeneration,
                type: "terminal.input_ack",
                inputEpoch,
                sequence: frame.sequence
              }
            ];
          }
          if (frame.type === "terminal.resize") {
            runtime.pty.resize(frame.columns, frame.rows);
            await transition(runtime, runtime.record.state, {
              columns: frame.columns,
              rows: frame.rows
            });
            return [];
          }
          if (frame.type === "terminal.interrupt") {
            runtime.pty.write("\u0003");
            return [];
          }
          if (frame.type === "terminal.stop") {
            await stopRuntime(runtime);
            return [];
          }
          const selected = runtime.outputs.filter(
            (output) =>
              output.sequence >= frame.fromOutputSequence &&
              output.sequence <= frame.toOutputSequence
          );
          if (
            selected.length === 0 ||
            selected[0]!.sequence > frame.fromOutputSequence ||
            selected.at(-1)!.sequence < frame.toOutputSequence
          ) {
            throw terminalError(
              "Terminal context is no longer available",
              409,
              "context_gap"
            );
          }
          const contentBytes = Buffer.concat(selected.map(({ data }) => data));
          if (contentBytes.byteLength > MANAGED_TERMINAL_MAX_CONTEXT_BYTES) {
            throw terminalError(
              "Terminal context is too large",
              413,
              "context_too_large"
            );
          }
          const contextReference = `mtc1_${randomBytes(32).toString("base64url")}`;
          const content = contentBytes.toString("utf8");
          const context: ContextEntry = {
            contextReference,
            terminalId: record.id,
            lifecycleGeneration: record.lifecycleGeneration,
            fromOutputSequence: frame.fromOutputSequence,
            toOutputSequence: frame.toOutputSequence,
            contentDigest: createHash("sha256")
              .update(contentBytes)
              .digest("hex"),
            expiresAt: new Date(
              Date.now() + MANAGED_TERMINAL_CONTEXT_TTL_SECONDS * 1_000
            ).toISOString(),
            ownerUserId: input.ownerUserId,
            executionId: input.executionId,
            content
          };
          contexts.set(contextReference, context);
          return [
            {
              protocolVersion: MANAGED_TERMINAL_PROTOCOL_VERSION,
              terminalId: record.id,
              lifecycleGeneration: record.lifecycleGeneration,
              type: "terminal.context.captured",
              requestId: frame.requestId,
              contextReference,
              contentDigest: context.contentDigest,
              expiresAt: context.expiresAt
            }
          ];
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          if (closedAttachment) return;
          closedAttachment = true;
          listeners.clear();
          runtime.attachments.delete(forward);
          if (
            runtime.attachments.size === 0 &&
            runtime.record.state === "running"
          ) {
            await transition(runtime, "detached");
            runtime.detachTimer = setTimeout(() => {
              runtime.detachTimer = null;
              void stopRuntime(runtime).catch((error) =>
                options.onError?.(error, "terminal_detached_expiry")
              );
            }, detachedTtlMs);
            runtime.detachTimer.unref?.();
          }
        }
      };
    },

    async stop(input) {
      await initialize();
      const record = await options
        .requireRepository()
        .getManagedTerminal(
          { userId: input.ownerUserId },
          { executionId: input.executionId, terminalId: input.terminalId }
        );
      if (!record)
        throw terminalError("Terminal was not found", 404, "terminal_missing");
      const runtime = terminals.get(record.id);
      if (!runtime) return record;
      return stopRuntime(runtime);
    },

    resolveContext(input) {
      const context = contexts.get(input.contextReference);
      if (
        !context ||
        context.ownerUserId !== input.ownerUserId ||
        context.executionId !== input.executionId ||
        Date.parse(context.expiresAt) <= Date.now()
      ) {
        contexts.delete(input.contextReference);
        throw terminalError(
          "Terminal context is unavailable",
          409,
          "context_unavailable"
        );
      }
      return context;
    },

    async verifyPreviewListener(input) {
      await initialize();
      const runtime = terminals.get(input.terminalId);
      if (
        !runtime ||
        runtime.ownerUserId !== input.ownerUserId ||
        runtime.executionId !== input.executionId ||
        runtime.record.executionGeneration !== input.executionGeneration ||
        !["running", "detached"].includes(runtime.record.state)
      ) {
        return false;
      }
      return await verifyPreviewListenerOwnership({
        rootPid: runtime.pty.pid,
        port: input.port
      });
    },

    subscribePreviewSignals(listener) {
      previewSignalListeners.add(listener);
      return () => previewSignalListeners.delete(listener);
    },

    hasLiveExecutionTerminal(input) {
      return [...terminals.values()].some(
        (runtime) =>
          runtime.ownerUserId === input.ownerUserId &&
          runtime.executionId === input.executionId &&
          runtime.record.executionGeneration === input.executionGeneration &&
          !["exited", "failed"].includes(runtime.record.state)
      );
    },

    async close() {
      if (closed) return;
      closed = true;
      const active = [...terminals.values()];
      await Promise.all(
        active.map(async (runtime) => {
          try {
            await stopRuntime(runtime);
          } catch (error) {
            options.onError?.(error, "terminal_shutdown");
          }
        })
      );
      if (active.length > 0) {
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, stopGraceMs)
        );
        for (const runtime of active) {
          try {
            await signalProcessTree(runtime, "SIGKILL");
          } catch (error) {
            options.onError?.(error, "terminal_shutdown_force_stop");
          }
        }
      }
      contexts.clear();
      previewSignalListeners.clear();
    }
  };
};
