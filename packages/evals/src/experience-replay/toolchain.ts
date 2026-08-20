import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  listCodexAppServerModels,
  type CodexAppServerModelOption
} from "@koed/mcp-server/runtime-contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const CODEX_MODEL_LIST_TIMEOUT_MS = 30_000;

export interface BoundedCommand {
  file: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface BoundedCommandResult {
  stdout: string;
  stderr: string;
}

export type BoundedCommandExecutor = (
  command: BoundedCommand
) => Promise<BoundedCommandResult>;

/** Run one executable directly with bounded time and output. A shell is never used. */
export const executeBoundedCommand: BoundedCommandExecutor = (command) =>
  new Promise((resolve, reject) => {
    const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      reject(new Error("Subprocess timeout must be a positive integer"));
      return;
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      reject(new Error("Subprocess output bound must be a positive integer"));
      return;
    }
    const child = spawn(command.file, [...command.args], {
      ...(command.cwd ? { cwd: command.cwd } : {}),
      ...(command.env ? { env: command.env } : {}),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let complete = false;
    const finish = (error?: Error): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      if (error) reject(error);
      else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
    };
    const append = (target: Buffer[], value: Buffer | string): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error("Subprocess output limit exceeded"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (value: Buffer | string) => append(stdout, value));
    child.stderr.on("data", (value: Buffer | string) => append(stderr, value));
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code !== 0) {
        finish(
          new Error(
            `Subprocess failed (exit=${code === null ? "null" : code}, signal=${signal ?? "none"})`
          )
        );
      } else finish();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Subprocess timed out"));
    }, timeoutMs);
    timer.unref();
  });

export interface ExecutableAttestation {
  path: string;
  sha256: string;
  sizeBytes: number;
  version: string;
  versionOutput: string;
}

export interface CodexToolchainAttestation {
  executable: ExecutableAttestation;
  models: readonly CodexAppServerModelOption[];
}

export const sha256File = async (filename: string): Promise<string> => {
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(filename)
      .once("error", reject)
      .once("end", resolve)
      .on("data", (chunk) => digest.update(chunk));
  });
  return digest.digest("hex");
};

const regexEscape = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const assertExactVersionOutput = (
  versionOutput: string,
  expectedVersion: string
): void => {
  const expected = regexEscape(expectedVersion);
  if (
    versionOutput !== expectedVersion &&
    !new RegExp(`^codex(?:-cli)?[ \\t]+${expected}$`, "u").test(versionOutput)
  ) {
    throw new Error(
      `Executable version mismatch: expected exact version ${expectedVersion}`
    );
  }
};

export const attestExecutable = async ({
  binary,
  versionArguments,
  expectedSha256,
  expectedVersion,
  executor = executeBoundedCommand
}: {
  binary: string;
  versionArguments: readonly string[];
  expectedSha256: string;
  expectedVersion: string;
  executor?: BoundedCommandExecutor;
}): Promise<ExecutableAttestation> => {
  if (!SHA256.test(expectedSha256))
    throw new Error("Invalid expected executable SHA-256");
  if (
    !expectedVersion ||
    expectedVersion.trim() !== expectedVersion ||
    /[\r\n]/u.test(expectedVersion)
  ) {
    throw new Error(
      "Expected executable version must be one exact output line"
    );
  }
  const canonicalBinary = await realpath(binary);
  const before = await stat(canonicalBinary);
  if (!before.isFile())
    throw new Error(`Executable is not a regular file: ${binary}`);
  const sha256 = await sha256File(canonicalBinary);
  if (sha256 !== expectedSha256)
    throw new Error(`Executable digest mismatch: ${binary}`);
  const { stdout, stderr } = await executor({
    file: canonicalBinary,
    args: [...versionArguments],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_OUTPUT_BYTES
  });
  const versionOutput = `${stdout}${stderr}`.trim();
  assertExactVersionOutput(versionOutput, expectedVersion);
  const after = await stat(canonicalBinary);
  const afterHash = await sha256File(canonicalBinary);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    afterHash !== sha256
  ) {
    throw new Error(`Executable changed during attestation: ${binary}`);
  }
  return Object.freeze({
    path: canonicalBinary,
    sha256,
    sizeBytes: before.size,
    version: expectedVersion,
    versionOutput
  });
};

const assertModel = (model: CodexAppServerModelOption): void => {
  if (
    !model ||
    typeof model !== "object" ||
    typeof model.id !== "string" ||
    !model.id ||
    model.id.trim() !== model.id
  ) {
    throw new Error("Codex model/list returned a malformed model identity");
  }
};

export const attestExactModels = async ({
  binary,
  requiredModelIds,
  environment,
  cwd,
  listModels = listCodexAppServerModels
}: {
  binary: string;
  requiredModelIds: readonly string[];
  environment: NodeJS.ProcessEnv;
  cwd: string;
  listModels?: typeof listCodexAppServerModels;
}): Promise<readonly CodexAppServerModelOption[]> => {
  const required = [...new Set(requiredModelIds)];
  const bootstrapModel = required[0];
  if (!bootstrapModel) throw new Error("At least one exact model is required");
  if (required.some((id) => !id || id.trim() !== id))
    throw new Error("Required model IDs must be exact non-empty identities");
  const models = await listModels(
    {
      appServerBinary: binary,
      model: bootstrapModel,
      cwd,
      env: environment,
      includeHidden: true
    },
    CODEX_MODEL_LIST_TIMEOUT_MS
  );
  if (!Array.isArray(models))
    throw new Error("Codex model/list returned a malformed response");
  const byId = new Map<string, CodexAppServerModelOption>();
  for (const model of models) {
    assertModel(model);
    if (byId.has(model.id))
      throw new Error(
        `Codex model/list returned duplicate model ID ${model.id}`
      );
    byId.set(model.id, model);
  }
  for (const id of required) {
    if (!byId.has(id))
      throw new Error(
        `Codex model/list did not expose exact model ${id}; fallback is forbidden`
      );
  }
  return Object.freeze(models.map((model) => Object.freeze({ ...model })));
};

/** Attest one Codex binary and model/list under the same real auth context. */
export const attestCodexToolchain = async ({
  binary,
  expectedSha256,
  expectedVersion,
  requiredModelIds,
  environment,
  cwd,
  listModels,
  executor
}: {
  binary: string;
  expectedSha256: string;
  expectedVersion: string;
  requiredModelIds: readonly string[];
  environment: NodeJS.ProcessEnv;
  cwd: string;
  listModels?: typeof listCodexAppServerModels;
  executor?: BoundedCommandExecutor;
}): Promise<CodexToolchainAttestation> => {
  const executable = await attestExecutable({
    binary,
    versionArguments: ["--version"],
    expectedSha256,
    expectedVersion,
    ...(executor ? { executor } : {})
  });
  const models = await attestExactModels({
    binary: executable.path,
    requiredModelIds,
    environment,
    cwd,
    ...(listModels ? { listModels } : {})
  });
  return Object.freeze({ executable, models });
};
