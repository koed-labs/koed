import {
  closeSync,
  chmodSync,
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
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ManagedConversationRuntimeBindingRecord } from "@koed/db";

const schemaVersion = 1 as const;
const maxJournalRecords = 128;
const maxJournalDirectoryEntries = maxJournalRecords * 2;
const maxRecordBytes = 256 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hexObjectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const phases = [
  "requested",
  "source_quiesced",
  "destination_prepared",
  "binding_committed",
  "complete",
  "failed"
] as const;

export type ProjectMoveLocalJournalPhase = (typeof phases)[number];

/** Runner-only recovery data. This record must never be sent to hosted authority. */
export type ProjectMoveLocalJournalRecord = {
  schemaVersion: typeof schemaVersion;
  moveId: string;
  sourceRuntimeBinding: ManagedConversationRuntimeBindingRecord;
  sourceProjectId: string | null;
  destinationProjectId: string;
  destinationLocalPath: string;
  phase: ProjectMoveLocalJournalPhase;
  updatedAt: string;
};

export type ProjectMoveLocalJournalOptions = { koedHome: string };

const journalDirectoryName = "project-moves";

const invalid = (
  message = "Project Move local journal record is invalid."
): never => {
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
    value.length === 0 ||
    value.length > max ||
    value.includes("\0")
  )
    return invalid(`${label} is invalid.`);
  return value;
};

const nullableText = (
  value: unknown,
  label: string,
  max = 16_384
): string | null => (value === null ? null : text(value, label, max));

const uuid = (value: unknown, label: string): string => {
  const parsed = text(value, label, 128);
  if (!uuidPattern.test(parsed)) return invalid(`${label} is invalid.`);
  return parsed;
};

const projectId = (value: unknown, label: string, max = 2_048): string => {
  const parsed = text(value, label, max);
  if (parsed.trim() !== parsed || !parsed.trim())
    return invalid(`${label} is invalid.`);
  return parsed;
};

const absolutePath = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (!isAbsolute(parsed) || resolve(parsed) !== parsed) {
    return invalid(`${label} must be a normalized absolute path.`);
  }
  return parsed;
};

const optionalPath = (value: unknown, label: string): string | null =>
  value === null ? null : absolutePath(value, label);

const validateRuntimeBinding = (
  value: unknown
): ManagedConversationRuntimeBindingRecord => {
  const input = objectRecord(value);
  const requiredKeys = [
    "executionId",
    "ownerUserId",
    "deploymentId",
    "deviceId",
    "executionGeneration",
    "sourceProjectPath",
    "projectPath",
    "checkoutId",
    "checkoutKind",
    "checkoutLifecycle",
    "cleanupState",
    "vcsDriver",
    "localRepositoryCommonDirectory",
    "localGitDirectory",
    "repositoryIdentityHash",
    "worktreeIdentityHash",
    "baseRef",
    "baseObjectId",
    "branchRef",
    "headObjectId",
    "creationOperationId",
    "localSessionId",
    "providerThreadId",
    "transcriptPath",
    "managedHome",
    "providerCliVersion",
    "sourceGenerationId",
    "createdAt",
    "updatedAt"
  ];
  if (
    Object.keys(input).length !== requiredKeys.length ||
    requiredKeys.some((key) => !Object.hasOwn(input, key))
  )
    return invalid("Project Move source runtime binding snapshot is invalid.");

  const enumValue = <T extends string>(
    value: unknown,
    options: readonly T[],
    label: string
  ): T => {
    if (typeof value !== "string" || !options.includes(value as T)) {
      return invalid(`${label} is invalid.`);
    }
    return value as T;
  };
  const nullableUuid = (candidate: unknown, label: string): string | null =>
    candidate === null ? null : uuid(candidate, label);
  const nullableObjectId = (
    candidate: unknown,
    label: string
  ): string | null => {
    if (candidate === null) return null;
    const parsed = text(candidate, label, 128);
    if (!hexObjectIdPattern.test(parsed))
      return invalid(`${label} is invalid.`);
    return parsed;
  };
  const timestamp = (candidate: unknown, label: string): string => {
    const parsed = text(candidate, label, 128);
    if (
      !Number.isFinite(Date.parse(parsed)) ||
      new Date(parsed).toISOString() !== parsed
    )
      return invalid(`${label} is invalid.`);
    return parsed;
  };

  if (
    !Number.isSafeInteger(input.executionGeneration) ||
    Number(input.executionGeneration) < 1
  ) {
    return invalid(
      "Project Move source runtime binding generation is invalid."
    );
  }
  if (input.vcsDriver !== null && input.vcsDriver !== "git") {
    return invalid(
      "Project Move source runtime binding VCS driver is invalid."
    );
  }
  return {
    executionId: uuid(input.executionId, "Execution id"),
    ownerUserId: uuid(input.ownerUserId, "Owner id"),
    deploymentId: uuid(input.deploymentId, "Deployment id"),
    deviceId: uuid(input.deviceId, "Device id"),
    executionGeneration: Number(input.executionGeneration),
    sourceProjectPath: absolutePath(
      input.sourceProjectPath,
      "Source Project path"
    ),
    projectPath: absolutePath(input.projectPath, "Bound Project path"),
    checkoutId: nullableUuid(input.checkoutId, "Checkout id"),
    checkoutKind: enumValue(
      input.checkoutKind,
      [
        "pending",
        "koed_managed_worktree",
        "user_managed_checkout",
        "non_vcs_directory"
      ],
      "Checkout kind"
    ),
    checkoutLifecycle: enumValue(
      input.checkoutLifecycle,
      [
        "pending",
        "ready",
        "cleanup_requested",
        "removed",
        "cleanup_failed",
        "orphaned"
      ],
      "Checkout lifecycle"
    ),
    cleanupState: enumValue(
      input.cleanupState,
      ["not_requested", "requested", "completed", "failed"],
      "Cleanup state"
    ),
    vcsDriver: input.vcsDriver,
    localRepositoryCommonDirectory: optionalPath(
      input.localRepositoryCommonDirectory,
      "Repository common directory"
    ),
    localGitDirectory: optionalPath(input.localGitDirectory, "Git directory"),
    repositoryIdentityHash: nullableText(
      input.repositoryIdentityHash,
      "Repository identity hash",
      256
    ),
    worktreeIdentityHash: nullableText(
      input.worktreeIdentityHash,
      "Worktree identity hash",
      256
    ),
    baseRef: nullableText(input.baseRef, "Base ref", 1024),
    baseObjectId: nullableObjectId(input.baseObjectId, "Base object id"),
    branchRef: nullableText(input.branchRef, "Branch ref", 1024),
    headObjectId: nullableObjectId(input.headObjectId, "Head object id"),
    creationOperationId: nullableUuid(
      input.creationOperationId,
      "Creation operation id"
    ),
    localSessionId: nullableText(input.localSessionId, "Local session id"),
    providerThreadId: nullableText(
      input.providerThreadId,
      "Provider thread id"
    ),
    transcriptPath: optionalPath(input.transcriptPath, "Transcript path"),
    managedHome: optionalPath(input.managedHome, "Managed home"),
    providerCliVersion: nullableText(
      input.providerCliVersion,
      "Provider CLI version",
      256
    ),
    sourceGenerationId: nullableUuid(
      input.sourceGenerationId,
      "Source generation id"
    ),
    createdAt: timestamp(input.createdAt, "Created at"),
    updatedAt: timestamp(input.updatedAt, "Updated at")
  };
};

export const parseProjectMoveLocalJournalRecord = (
  value: unknown
): ProjectMoveLocalJournalRecord => {
  const input = objectRecord(value);
  if (
    Object.keys(input).length !== 8 ||
    input.schemaVersion !== schemaVersion ||
    !phases.includes(input.phase as ProjectMoveLocalJournalPhase)
  )
    return invalid();
  const updatedAt = text(input.updatedAt, "Updated at", 128);
  if (new Date(updatedAt).toISOString() !== updatedAt)
    return invalid("Updated at must be a canonical timestamp.");
  const sourceProjectId =
    input.sourceProjectId === null
      ? null
      : projectId(input.sourceProjectId, "Source Project id");
  const destinationProjectId = projectId(
    input.destinationProjectId,
    "Destination Project id",
    512
  );
  if (sourceProjectId === destinationProjectId)
    return invalid("Source and destination Projects must differ.");
  return {
    schemaVersion,
    moveId: uuid(input.moveId, "Move id"),
    sourceRuntimeBinding: validateRuntimeBinding(input.sourceRuntimeBinding),
    sourceProjectId,
    destinationProjectId,
    destinationLocalPath: absolutePath(
      input.destinationLocalPath,
      "Destination local path"
    ),
    phase: input.phase as ProjectMoveLocalJournalPhase,
    updatedAt
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
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Project Move local journal directory is unsafe.");
  }
  chmodSync(directory, 0o700);
  if (realpathSync(directory) !== directory) {
    throw new Error("Project Move local journal directory is not canonical.");
  }
  return directory;
};

const prepareJournalDirectory = (koedHomeInput: string): string => {
  if (!isAbsolute(koedHomeInput) || resolve(koedHomeInput) !== koedHomeInput) {
    throw new TypeError("koedHome must be a normalized absolute path.");
  }
  mkdirSync(koedHomeInput, { recursive: true, mode: 0o700 });
  const homeStat = lstatSync(koedHomeInput);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new Error("koedHome must be a real directory.");
  }
  const home = realpathSync(koedHomeInput);
  const run = ensureChildDirectory(home, "run");
  const directory = ensureChildDirectory(run, journalDirectoryName);
  if (readdirSync(directory).length > maxJournalDirectoryEntries) {
    throw new Error("Project Move local journal directory is full.");
  }
  return directory;
};

const movePath = (directory: string, moveId: string): string => {
  const safeId = uuid(moveId, "Move id");
  const path = resolve(directory, `${safeId}.json`);
  if (
    path !== `${directory}/${safeId}.json` &&
    path !== `${directory}\\${safeId}.json`
  ) {
    throw new TypeError("Move id is outside the Project Move journal.");
  }
  return path;
};

const readRecordFile = (path: string): ProjectMoveLocalJournalRecord => {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > maxRecordBytes
  ) {
    throw new Error("Project Move local journal file is unsafe.");
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(path, flags);
  try {
    const content = readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(content, "utf8") > maxRecordBytes) {
      throw new Error("Project Move local journal record is too large.");
    }
    const record = parseProjectMoveLocalJournalRecord(
      JSON.parse(content) as unknown
    );
    if (path !== movePath(resolve(path, ".."), record.moveId)) {
      throw new Error("Project Move journal id does not match its filename.");
    }
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

export class ProjectMoveLocalJournal {
  private readonly koedHome: string;

  constructor(options: ProjectMoveLocalJournalOptions) {
    this.koedHome = options.koedHome;
  }

  write(value: ProjectMoveLocalJournalRecord): void {
    const record = parseProjectMoveLocalJournalRecord(value);
    const directory = prepareJournalDirectory(this.koedHome);
    const destination = movePath(directory, record.moveId);
    if (existsSync(destination)) {
      const stat = lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Project Move local journal target is unsafe.");
      }
      readRecordFile(destination);
    } else if (this.list().length >= maxJournalRecords) {
      throw new Error("Project Move local journal is full.");
    }
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maxRecordBytes) {
      throw new Error("Project Move local journal record is too large.");
    }
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
      const finalStat = lstatSync(destination);
      if (
        !finalStat.isFile() ||
        finalStat.isSymbolicLink() ||
        (finalStat.mode & 0o777) !== 0o600
      ) {
        throw new Error("Project Move local journal permissions are unsafe.");
      }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }

  read(moveId: string): ProjectMoveLocalJournalRecord | null {
    const directory = prepareJournalDirectory(this.koedHome);
    const path = movePath(directory, moveId);
    return existsSync(path) ? readRecordFile(path) : null;
  }

  list(): ProjectMoveLocalJournalRecord[] {
    const directory = prepareJournalDirectory(this.koedHome);
    const entries = readdirSync(directory).filter((name) =>
      name.endsWith(".json")
    );
    if (entries.length > maxJournalRecords) {
      throw new Error("Project Move local journal contains too many records.");
    }
    return entries.map((name) => {
      if (
        !uuidPattern.test(name.slice(0, -5)) ||
        name !== `${name.slice(0, -5)}.json`
      ) {
        throw new Error(
          "Project Move local journal contains an invalid filename."
        );
      }
      return readRecordFile(resolve(directory, name));
    });
  }

  remove(moveId: string): void {
    const directory = prepareJournalDirectory(this.koedHome);
    const path = movePath(directory, moveId);
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o600
    ) {
      throw new Error("Project Move local journal target is unsafe.");
    }
    readRecordFile(path);
    rmSync(path);
    fsyncDirectory(directory);
  }
}
