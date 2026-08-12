import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoSymlinkComponents,
  validateArtifactRelativePath,
  writeTextArtifactAtomic
} from "./artifacts.js";
import {
  startHarborLifecycleServer,
  type HarborAttemptKind,
  type HarborLifecycleCallbacks
} from "./harbor-lifecycle.js";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const REQUEST_SCHEMA = "koed-harbor-run-v1";
const RESULT_SCHEMA = "koed-harbor-result-v1";

export type HarborFailureCategory =
  | "invalid-request"
  | "request-artifact"
  | "spawn"
  | "timeout"
  | "cancelled"
  | "output-limit"
  | "process-exit"
  | "lifecycle"
  | "invalid-output";

export class HarborClientError extends Error {
  override readonly name = "HarborClientError";

  constructor(
    readonly category: HarborFailureCategory,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The exact request accepted by harbor/runner.py. */
interface HarborRunRequestBase {
  schema_version: "koed-harbor-run-v1";
  attempt_kind: HarborAttemptKind;
  task_name: string;
  job_config: Record<string, JsonValue>;
  corpus_manifest: string;
  run_root: string;
  result_path?: string;
}

export interface HarborSourceRunRequest extends HarborRunRequestBase {
  attempt_kind: "source";
  freeze_manifest_path: string;
  freeze_trajectory_to: string;
}

export interface HarborReplayRunRequest extends HarborRunRequestBase {
  attempt_kind: "replay";
  freeze_manifest_path?: never;
  freeze_trajectory_to?: never;
}

export type HarborRunRequest = HarborSourceRunRequest | HarborReplayRunRequest;

interface HarborRunResultBase {
  schema_version: "koed-harbor-result-v1";
  runtime: Record<string, unknown>;
  job_lock_sha256: string;
  result: Record<string, unknown>;
}

export interface HarborSourceRunResult extends HarborRunResultBase {
  freeze_manifest_sha256: string;
}

export interface HarborReplayRunResult extends HarborRunResultBase {
  freeze_manifest_sha256?: never;
}

export type HarborRunResult = HarborSourceRunResult | HarborReplayRunResult;

export interface SubprocessInvocation {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface SubprocessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  terminationReason?: "timeout" | "cancelled" | "output-limit";
}

export type SubprocessExecutor = (
  invocation: SubprocessInvocation
) => Promise<SubprocessResult>;

const appendBounded = (
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maximumBytes: number
): number => {
  const nextBytes = currentBytes + chunk.byteLength;
  if (nextBytes > maximumBytes) return nextBytes;
  chunks.push(chunk);
  return nextBytes;
};

/** Executes a single binary directly. No shell is involved. */
export const executeSubprocess: SubprocessExecutor = (invocation) =>
  new Promise((resolve, reject) => {
    if (invocation.signal?.aborted) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        terminationReason: "cancelled"
      });
      return;
    }

    const child = spawn(invocation.file, [...invocation.args], {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let reason: SubprocessResult["terminationReason"];
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = (nextReason: NonNullable<typeof reason>): void => {
      if (reason) return;
      reason = nextReason;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(
        () => child.kill("SIGKILL"),
        TERMINATION_GRACE_MS
      );
      forceKillTimer.unref();
    };
    const timeout = setTimeout(
      () => terminate("timeout"),
      invocation.timeoutMs
    );
    timeout.unref();
    const abort = () => terminate("cancelled");
    invocation.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stdoutBytes = appendBounded(
        stdout,
        chunk,
        stdoutBytes,
        invocation.maxStdoutBytes
      );
      if (stdoutBytes > invocation.maxStdoutBytes) terminate("output-limit");
    });
    child.stderr.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stderrBytes = appendBounded(
        stderr,
        chunk,
        stderrBytes,
        invocation.maxStderrBytes
      );
      if (stderrBytes > invocation.maxStderrBytes) terminate("output-limit");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      invocation.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode, childSignal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      invocation.signal?.removeEventListener("abort", abort);
      resolve({
        exitCode,
        signal: childSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(reason ? { terminationReason: reason } : {})
      });
    });
  });

const secretKey =
  /(?:^|[_-])(api[_-]?key|auth|credential|password|private[_-]?key|secret|token)(?:$|[_-])/iu;
const secretValue =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,})/u;

const assertNoSerializedSecrets = (
  value: JsonValue,
  location = "request"
): void => {
  if (typeof value === "string") {
    if (secretValue.test(value)) {
      throw new HarborClientError(
        "invalid-request",
        `Secret-like value is not allowed in ${location}`
      );
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSerializedSecrets(item, `${location}[${index}]`)
    );
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (secretKey.test(key) && item !== `\${${key}}`) {
      throw new HarborClientError(
        "invalid-request",
        `Secret-bearing field is not allowed in ${location}`
      );
    }
    assertNoSerializedSecrets(item, `${location}.${key}`);
  }
};

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HarborClientError(
      "invalid-request",
      `${label} must be a positive safe integer`
    );
  }
  return value;
};

const validateRunRoot = async (runRoot: string): Promise<string> => {
  if (typeof runRoot !== "string" || !path.isAbsolute(runRoot)) {
    throw new HarborClientError("invalid-request", "run_root must be absolute");
  }
  try {
    await assertNoSymlinkComponents(runRoot);
    const canonical = await realpath(runRoot);
    const metadata = await lstat(runRoot);
    if (canonical !== path.resolve(runRoot) || !metadata.isDirectory()) {
      throw new Error("not a canonical directory");
    }
    return canonical;
  } catch (error) {
    throw new HarborClientError(
      "invalid-request",
      "run_root must be an existing non-symlink directory",
      { cause: error }
    );
  }
};

const validateRequest = async (
  input: HarborRunRequest
): Promise<HarborRunRequest> => {
  if (!input || typeof input !== "object") {
    throw new HarborClientError(
      "invalid-request",
      "Run request must be an object"
    );
  }
  const allowed = new Set([
    "schema_version",
    "attempt_kind",
    "task_name",
    "job_config",
    "corpus_manifest",
    "run_root",
    "freeze_manifest_path",
    "freeze_trajectory_to",
    "result_path"
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new HarborClientError(
      "invalid-request",
      "Run request has unknown fields"
    );
  }
  if (input.schema_version !== REQUEST_SCHEMA) {
    throw new HarborClientError(
      "invalid-request",
      "Unsupported run request schema"
    );
  }
  if (input.attempt_kind !== "source" && input.attempt_kind !== "replay") {
    throw new HarborClientError(
      "invalid-request",
      "attempt_kind must be source or replay"
    );
  }
  if (
    !input.job_config ||
    typeof input.job_config !== "object" ||
    Array.isArray(input.job_config)
  ) {
    throw new HarborClientError(
      "invalid-request",
      "job_config must be an object"
    );
  }
  for (const [value, label] of [
    [input.task_name, "task_name"],
    [input.corpus_manifest, "corpus_manifest"]
  ] as const) {
    if (typeof value !== "string" || !value) {
      throw new HarborClientError(
        "invalid-request",
        `${label} must be a non-empty string`
      );
    }
  }
  const runRoot = await validateRunRoot(input.run_root);
  try {
    if (input.attempt_kind === "source") {
      if (!input.freeze_manifest_path || !input.freeze_trajectory_to) {
        throw new Error("source freeze outputs are required");
      }
      validateArtifactRelativePath(input.freeze_manifest_path);
      validateArtifactRelativePath(input.freeze_trajectory_to);
    } else if (
      Object.hasOwn(input, "freeze_manifest_path") ||
      Object.hasOwn(input, "freeze_trajectory_to")
    ) {
      throw new Error("replay freeze outputs are forbidden");
    }
    if (input.result_path !== undefined)
      validateArtifactRelativePath(input.result_path);
  } catch (error) {
    throw new HarborClientError(
      "invalid-request",
      "Harbor output paths must be safe run-root-relative artifact paths",
      { cause: error }
    );
  }
  assertNoSerializedSecrets(input.job_config);
  const common = {
    schema_version: REQUEST_SCHEMA,
    task_name: input.task_name,
    job_config: input.job_config,
    corpus_manifest: input.corpus_manifest,
    run_root: runRoot,
    ...(input.result_path !== undefined
      ? { result_path: input.result_path }
      : {})
  } as const;
  return input.attempt_kind === "source"
    ? {
        ...common,
        attempt_kind: "source",
        freeze_manifest_path: input.freeze_manifest_path,
        freeze_trajectory_to: input.freeze_trajectory_to
      }
    : { ...common, attempt_kind: "replay" };
};

const parseResult = (
  stdout: string,
  attemptKind: HarborAttemptKind
): HarborRunResult => {
  const withoutFinalNewline = stdout.endsWith("\r\n")
    ? stdout.slice(0, -2)
    : stdout.endsWith("\n")
      ? stdout.slice(0, -1)
      : stdout;
  if (!withoutFinalNewline || /[\r\n]/u.test(withoutFinalNewline)) {
    throw new HarborClientError(
      "invalid-output",
      "Harbor runner stdout must contain exactly one JSON line"
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFinalNewline);
  } catch (error) {
    throw new HarborClientError(
      "invalid-output",
      "Harbor runner emitted invalid JSON",
      {
        cause: error
      }
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { schema_version?: unknown }).schema_version !== RESULT_SCHEMA ||
    Object.keys(parsed).length !== (attemptKind === "source" ? 5 : 4) ||
    !Object.hasOwn(parsed, "runtime") ||
    !Object.hasOwn(parsed, "job_lock_sha256") ||
    (attemptKind === "source") !==
      Object.hasOwn(parsed, "freeze_manifest_sha256") ||
    !Object.hasOwn(parsed, "result") ||
    typeof (parsed as { job_lock_sha256?: unknown }).job_lock_sha256 !==
      "string" ||
    (attemptKind === "source" &&
      typeof (parsed as { freeze_manifest_sha256?: unknown })
        .freeze_manifest_sha256 !== "string") ||
    !(parsed as { runtime?: unknown }).runtime ||
    typeof (parsed as { runtime?: unknown }).runtime !== "object" ||
    Array.isArray((parsed as { runtime?: unknown }).runtime) ||
    !(parsed as { result?: unknown }).result ||
    typeof (parsed as { result?: unknown }).result !== "object" ||
    Array.isArray((parsed as { result?: unknown }).result)
  ) {
    throw new HarborClientError(
      "invalid-output",
      "Harbor runner emitted an invalid result object"
    );
  }
  return parsed as HarborRunResult;
};

export interface HarborClientOptions {
  executor?: SubprocessExecutor;
  harborProject?: string;
  uvExecutable?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  requestId?: () => string;
  lifecycle?: HarborLifecycleCallbacks;
  lifecycleEventTimeoutMs?: number;
}

const inheritedEnvironmentNames = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME"
] as const;

const minimalHostEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    inheritedEnvironmentNames.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    })
  );

const defaultHarborProject = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/experience-replay/harbor"
);

export class HarborClient {
  private readonly executor: SubprocessExecutor;
  private readonly harborProject: string;
  private readonly uvExecutable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly requestId: () => string;
  private readonly lifecycle: HarborLifecycleCallbacks;
  private readonly lifecycleEventTimeoutMs?: number;

  constructor(options: HarborClientOptions = {}) {
    this.executor = options.executor ?? executeSubprocess;
    this.harborProject = path.resolve(
      options.harborProject ?? defaultHarborProject
    );
    this.uvExecutable = options.uvExecutable ?? "uv";
    // Credentials needed by Codex/Harbor must be supplied explicitly for the
    // trial. Never inherit the operator's unrelated environment wholesale.
    this.environment = {
      ...minimalHostEnvironment(),
      ...options.environment
    };
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs"
    );
    this.maxStdoutBytes = positiveInteger(
      options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
      "maxStdoutBytes"
    );
    this.maxStderrBytes = positiveInteger(
      options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
      "maxStderrBytes"
    );
    this.requestId = options.requestId ?? randomUUID;
    this.lifecycle = options.lifecycle ?? {};
    this.lifecycleEventTimeoutMs = options.lifecycleEventTimeoutMs;
  }

  async run(
    input: HarborRunRequest,
    signal?: AbortSignal
  ): Promise<HarborRunResult> {
    const request = await validateRequest(input);
    if (signal?.aborted) {
      throw new HarborClientError("cancelled", "Harbor run was cancelled");
    }
    const id = this.requestId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
      throw new HarborClientError(
        "invalid-request",
        "requestId returned an unsafe value"
      );
    }
    const requestRelativePath = validateArtifactRelativePath(
      `.harbor-requests/${id}.json`
    );
    const requestPath = path.join(request.run_root, requestRelativePath);
    const lifecycle = await startHarborLifecycleServer({
      attemptKind: request.attempt_kind,
      callbacks: this.lifecycle,
      ...(this.lifecycleEventTimeoutMs !== undefined
        ? { eventTimeoutMs: this.lifecycleEventTimeoutMs }
        : {})
    });
    try {
      try {
        await writeTextArtifactAtomic(
          request.run_root,
          requestRelativePath,
          `${JSON.stringify(request)}\n`
        );
      } catch (error) {
        throw new HarborClientError(
          "request-artifact",
          "Unable to create Harbor request artifact",
          { cause: error }
        );
      }
      let execution: SubprocessResult;
      try {
        execution = await this.executor({
          file: this.uvExecutable,
          args: [
            "run",
            "--locked",
            "--project",
            this.harborProject,
            "python",
            "runner.py",
            "run",
            "--request",
            requestPath
          ],
          cwd: this.harborProject,
          env: { ...this.environment, ...lifecycle.processEnvironment },
          timeoutMs: this.timeoutMs,
          ...(signal ? { signal } : {}),
          maxStdoutBytes: this.maxStdoutBytes,
          maxStderrBytes: this.maxStderrBytes
        });
      } catch (error) {
        throw new HarborClientError(
          "spawn",
          "Unable to start the Harbor runner",
          {
            cause: error
          }
        );
      }
      if (
        Buffer.byteLength(execution.stdout) > this.maxStdoutBytes ||
        Buffer.byteLength(execution.stderr) > this.maxStderrBytes
      ) {
        throw new HarborClientError(
          "output-limit",
          "Harbor runner exceeded an output limit"
        );
      }
      if (execution.terminationReason) {
        const messages = {
          timeout: "Harbor runner exceeded its timeout",
          cancelled: "Harbor run was cancelled",
          "output-limit": "Harbor runner exceeded an output limit"
        } as const;
        throw new HarborClientError(
          execution.terminationReason,
          messages[execution.terminationReason]
        );
      }
      if (execution.exitCode !== 0) {
        throw new HarborClientError(
          "process-exit",
          `Harbor runner exited unsuccessfully (code ${execution.exitCode ?? "null"}, signal ${execution.signal ?? "none"})`
        );
      }
      try {
        lifecycle.assertComplete();
      } catch (error) {
        throw new HarborClientError(
          "lifecycle",
          "Harbor runner did not complete its acknowledged lifecycle",
          { cause: error }
        );
      }
      return parseResult(execution.stdout, request.attempt_kind);
    } finally {
      await lifecycle.close();
      try {
        await unlink(requestPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // A failed cleanup must not replace the categorized execution failure.
        }
      }
    }
  }
}

export const runHarborRequest = async (
  request: HarborRunRequest,
  options: HarborClientOptions & { signal?: AbortSignal } = {}
): Promise<HarborRunResult> => {
  const { signal, ...clientOptions } = options;
  return new HarborClient(clientOptions).run(request, signal);
};
