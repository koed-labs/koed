import { randomUUID } from "node:crypto";
import type {
  ExecutionCheckoutIdentity,
  ExecutionCheckoutOwnership,
  GitExecutionCheckoutDriver
} from "@koed/shared/execution-checkout";
import {
  closeSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

const schemaVersion = 2 as const;
const legacySchemaVersion = 1 as const;
const directoryName = "retained-workspaces";
const maxRecordBytes = 256 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Local-only locator for source files kept after a successful Project Move. */
export type RetainedWorkspaceRecord = {
  schemaVersion: typeof schemaVersion;
  moveId: string;
  executionId: string;
  executionGeneration: number;
  sourceProjectId: string | null;
  destinationProjectId: string;
  sourcePath: string;
  destinationPath: string;
  providerThreadId: string;
  checkoutKind: ExecutionCheckoutOwnership | "unknown";
  checkoutIdentity: ExecutionCheckoutIdentity | null;
  reason: "changed" | "unknown";
  retainedAt: string;
};

export type RetainedWorkspaceCatalogOptions = { koedHome: string };

const invalid = (message = "Retained workspace record is invalid."): never => {
  throw new TypeError(message);
};

const objectRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
};

const text = (value: unknown, label: string, max = 16_384): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    value.includes("\0")
  )
    return invalid(`${label} is invalid.`);
  return value;
};

const uuid = (value: unknown, label: string): string => {
  const parsed = text(value, label, 128);
  if (!uuidPattern.test(parsed)) return invalid(`${label} is invalid.`);
  return parsed;
};

const absolutePath = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (!isAbsolute(parsed) || resolve(parsed) !== parsed)
    return invalid(`${label} must be a normalized absolute path.`);
  return parsed;
};

const checkoutIdentity = (
  value: unknown,
  checkoutKind: ExecutionCheckoutOwnership | "unknown",
  sourcePath: string
): ExecutionCheckoutIdentity | null => {
  if (value === null) return null;
  const input = objectRecord(value);
  const keys = [
    "checkoutId",
    "vcsDriver",
    "ownership",
    "canonicalPath",
    "localRepositoryCommonDirectory",
    "localGitDirectory",
    "repositoryIdentityHash",
    "worktreeIdentityHash",
    "baseRef",
    "baseObjectId",
    "branchRef",
    "headObjectId"
  ];
  if (
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key))
  )
    return invalid("Retained checkout identity is invalid.");
  const ownership = input.ownership;
  if (
    ownership !== "koed_managed_worktree" &&
    ownership !== "user_managed_checkout" &&
    ownership !== "non_vcs_directory"
  )
    return invalid("Retained checkout ownership is invalid.");
  const nullableText = (candidate: unknown, label: string): string | null =>
    candidate === null ? null : text(candidate, label, 4_096);
  const nullablePath = (candidate: unknown, label: string): string | null =>
    candidate === null ? null : absolutePath(candidate, label);
  const nullableHash = (candidate: unknown, label: string): string | null => {
    if (candidate === null) return null;
    const parsed = text(candidate, label, 128);
    if (!/^[0-9a-f]{64}$/iu.test(parsed))
      return invalid(`${label} is invalid.`);
    return parsed;
  };
  const nullableObjectId = (
    candidate: unknown,
    label: string
  ): string | null => {
    if (candidate === null) return null;
    const parsed = text(candidate, label, 128);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(parsed))
      return invalid(`${label} is invalid.`);
    return parsed;
  };
  const parsed: ExecutionCheckoutIdentity = {
    checkoutId: uuid(input.checkoutId, "Checkout id"),
    vcsDriver:
      input.vcsDriver === "git"
        ? "git"
        : input.vcsDriver === null
          ? null
          : invalid("Retained checkout VCS driver is invalid."),
    ownership,
    canonicalPath: absolutePath(input.canonicalPath, "Checkout path"),
    localRepositoryCommonDirectory: nullablePath(
      input.localRepositoryCommonDirectory,
      "Repository common directory"
    ),
    localGitDirectory: nullablePath(
      input.localGitDirectory,
      "Checkout Git directory"
    ),
    repositoryIdentityHash: nullableHash(
      input.repositoryIdentityHash,
      "Repository identity hash"
    ),
    worktreeIdentityHash: nullableHash(
      input.worktreeIdentityHash,
      "Worktree identity hash"
    ),
    baseRef: nullableText(input.baseRef, "Base ref"),
    baseObjectId: nullableObjectId(input.baseObjectId, "Base object id"),
    branchRef: nullableText(input.branchRef, "Branch ref"),
    headObjectId: nullableObjectId(input.headObjectId, "Head object id")
  };
  if (checkoutKind !== parsed.ownership || parsed.canonicalPath !== sourcePath)
    return invalid("Retained checkout identity does not match its record.");
  return parsed;
};

export const parseRetainedWorkspaceRecord = (
  value: unknown
): RetainedWorkspaceRecord => {
  const input = objectRecord(value);
  const legacyKeys = [
    "schemaVersion",
    "moveId",
    "executionId",
    "executionGeneration",
    "sourceProjectId",
    "destinationProjectId",
    "sourcePath",
    "destinationPath",
    "providerThreadId",
    "reason",
    "retainedAt"
  ];
  const keys = [
    ...legacyKeys.slice(0, -2),
    "checkoutKind",
    "checkoutIdentity",
    ...legacyKeys.slice(-2)
  ];
  const legacy = input.schemaVersion === legacySchemaVersion;
  if (
    Object.keys(input).length !== (legacy ? legacyKeys.length : keys.length) ||
    (legacy ? legacyKeys : keys).some((key) => !Object.hasOwn(input, key)) ||
    (!legacy && input.schemaVersion !== schemaVersion)
  )
    return invalid();
  if (
    !Number.isSafeInteger(input.executionGeneration) ||
    Number(input.executionGeneration) < 1
  )
    return invalid("Execution generation is invalid.");
  if (input.reason !== "changed" && input.reason !== "unknown")
    return invalid("Retained reason is invalid.");
  const retainedAt = text(input.retainedAt, "Retained timestamp", 128);
  if (
    !Number.isFinite(Date.parse(retainedAt)) ||
    new Date(retainedAt).toISOString() !== retainedAt
  )
    return invalid("Retained timestamp must be canonical.");
  const sourcePath = absolutePath(input.sourcePath, "Source path");
  const parsedCheckoutKind = legacy
    ? "unknown"
    : input.checkoutKind === "koed_managed_worktree" ||
        input.checkoutKind === "user_managed_checkout" ||
        input.checkoutKind === "non_vcs_directory" ||
        input.checkoutKind === "unknown"
      ? input.checkoutKind
      : invalid("Retained checkout kind is invalid.");
  return {
    schemaVersion,
    moveId: uuid(input.moveId, "Move id"),
    executionId: uuid(input.executionId, "Execution id"),
    executionGeneration: Number(input.executionGeneration),
    sourceProjectId:
      input.sourceProjectId === null
        ? null
        : text(input.sourceProjectId, "Source Project id", 2_048),
    destinationProjectId: text(
      input.destinationProjectId,
      "Destination Project id",
      2_048
    ),
    sourcePath,
    destinationPath: absolutePath(input.destinationPath, "Destination path"),
    providerThreadId: text(input.providerThreadId, "Provider thread id", 4_096),
    checkoutKind: parsedCheckoutKind,
    checkoutIdentity: legacy
      ? null
      : checkoutIdentity(
          input.checkoutIdentity,
          parsedCheckoutKind,
          sourcePath
        ),
    reason: input.reason,
    retainedAt
  };
};

const ensureChildDirectory = (parent: string, name: string): string => {
  const directory = resolve(parent, name);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Retained workspace catalog directory is unsafe.");
  chmodSync(directory, 0o700);
  if (realpathSync(directory) !== directory)
    throw new Error("Retained workspace catalog directory is not canonical.");
  return directory;
};

const prepareDirectory = (koedHome: string): string => {
  if (!isAbsolute(koedHome) || resolve(koedHome) !== koedHome)
    throw new TypeError("koedHome must be a normalized absolute path.");
  mkdirSync(koedHome, { recursive: true, mode: 0o700 });
  const stat = lstatSync(koedHome);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("koedHome must be a real directory.");
  const home = realpathSync(koedHome);
  return ensureChildDirectory(ensureChildDirectory(home, "run"), directoryName);
};

const recordPath = (directory: string, moveId: string): string => {
  const id = uuid(moveId, "Move id");
  return resolve(directory, `${id}.json`);
};

const readFile = (filename: string): RetainedWorkspaceRecord => {
  const stat = lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > maxRecordBytes
  )
    throw new Error("Retained workspace catalog file is unsafe.");
  const descriptor = openSync(
    filename,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const content = readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(content, "utf8") > maxRecordBytes)
      throw new Error("Retained workspace record is too large.");
    const record = parseRetainedWorkspaceRecord(JSON.parse(content) as unknown);
    if (filename !== recordPath(resolve(filename, ".."), record.moveId))
      throw new Error("Retained workspace id does not match its filename.");
    return record;
  } finally {
    closeSync(descriptor);
  }
};

const fsyncDirectory = (directory: string): void => {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

/** Durable local catalog. It has no record-count limit and never removes source files. */
export class RetainedWorkspaceCatalog {
  constructor(private readonly options: RetainedWorkspaceCatalogOptions) {}

  upsert(value: RetainedWorkspaceRecord): void {
    const record = parseRetainedWorkspaceRecord(value);
    const directory = prepareDirectory(this.options.koedHome);
    const destination = recordPath(directory, record.moveId);
    if (existsSync(destination)) readFile(destination);
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maxRecordBytes)
      throw new Error("Retained workspace record is too large.");
    const temporary = resolve(
      directory,
      `.${record.moveId}.${randomUUID()}.tmp`
    );
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      chmodSync(temporary, 0o600);
      renameSync(temporary, destination);
      fsyncDirectory(directory);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }

  read(moveId: string): RetainedWorkspaceRecord | null {
    const filename = recordPath(
      prepareDirectory(this.options.koedHome),
      moveId
    );
    return existsSync(filename) ? readFile(filename) : null;
  }

  list(): RetainedWorkspaceRecord[] {
    const directory = prepareDirectory(this.options.koedHome);
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        if (
          !uuidPattern.test(name.slice(0, -5)) ||
          name !== `${name.slice(0, -5)}.json`
        )
          throw new Error(
            "Retained workspace catalog contains an invalid filename."
          );
        return readFile(resolve(directory, name));
      });
  }

  /** Explicit catalog removal only; source files are never removed by this method. */
  remove(moveId: string): void {
    const directory = prepareDirectory(this.options.koedHome);
    const filename = recordPath(directory, moveId);
    if (!existsSync(filename)) return;
    readFile(filename);
    rmSync(filename);
    fsyncDirectory(directory);
  }

  async removeManagedWorktree(
    moveId: string,
    driver: GitExecutionCheckoutDriver,
    confirmation: "delete_managed_worktree"
  ): Promise<boolean> {
    if (confirmation !== "delete_managed_worktree") {
      throw new Error("Retained workspace deletion confirmation is required.");
    }
    const record = this.read(moveId);
    if (!record) return false;
    const checkout = record.checkoutIdentity;
    if (
      record.checkoutKind !== "koed_managed_worktree" ||
      !checkout ||
      checkout.ownership !== "koed_managed_worktree" ||
      checkout.canonicalPath !== record.sourcePath ||
      checkout.vcsDriver !== "git"
    ) {
      throw new Error(
        "Retained workspace is not a deletable managed worktree."
      );
    }
    await driver.removeRetainedManagedWorktree(checkout);
    this.remove(moveId);
    return true;
  }
}
