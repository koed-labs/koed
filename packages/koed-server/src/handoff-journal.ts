import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

declare const authorityBrand: unique symbol;
export interface HandoffAuthority {
  readonly [authorityBrand]: true;
}
export type JournalIdentity = Readonly<{
  installationId: string;
  journalId: string;
}>;
export type JournalSnapshot = Readonly<{
  generation: number;
  state: "clean" | "dirty";
  operationId: string | null;
}>;
export type DirtySnapshot = Readonly<{
  generation: number;
  state: "dirty";
  operationId: string;
}>;
export interface HandoffJournal {
  read(authority: HandoffAuthority): Promise<JournalSnapshot>;
  begin(
    authority: HandoffAuthority,
    expected: JournalSnapshot,
    operationId: string
  ): Promise<DirtySnapshot>;
  markCleanAfterVerifiedCleanup(
    authority: HandoffAuthority,
    expected: DirtySnapshot
  ): Promise<JournalSnapshot>;
  close(): Promise<void>;
}
type RecordValue = JournalIdentity &
  JournalSnapshot & { format: "koed-handoff-journal"; version: 1 };
type Code =
  | "MISSING"
  | "INVALID"
  | "IDENTITY_MISMATCH"
  | "UNSUPPORTED_VERSION"
  | "STALE"
  | "INVALID_TRANSITION"
  | "CLOSED"
  | "IO"
  | "INDETERMINATE";
class JournalError extends Error {
  constructor(
    readonly code: Code,
    cause?: unknown
  ) {
    super(code, { cause });
  }
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value
  );
const snapshot = (value: JournalSnapshot): JournalSnapshot =>
  Object.freeze({
    generation: value.generation,
    state: value.state,
    operationId: value.operationId
  });
function validSnapshot(value: unknown): value is JournalSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as JournalSnapshot;
  return (
    Number.isSafeInteger(v.generation) &&
    v.generation >= 0 &&
    ((v.state === "clean" && v.operationId === null) ||
      (v.state === "dirty" && uuid(v.operationId)))
  );
}
function captureSnapshot(value: JournalSnapshot): JournalSnapshot | null {
  try {
    const captured =
      value && typeof value === "object" ? snapshot(value) : null;
    return validSnapshot(captured) ? captured : null;
  } catch {
    return null;
  }
}
function parse(data: Buffer, identity: JournalIdentity): RecordValue {
  if (data.length > 4096) throw new JournalError("INVALID");
  let text: string;
  let value: RecordValue;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      data
    );
    value = JSON.parse(text) as RecordValue;
  } catch (error) {
    throw new JournalError("INVALID", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new JournalError("INVALID");
  if (!Object.hasOwn(value, "version")) throw new JournalError("INVALID");
  if (value.version !== 1) throw new JournalError("UNSUPPORTED_VERSION");
  if (
    value.format !== "koed-handoff-journal" ||
    !uuid(value.installationId) ||
    !uuid(value.journalId) ||
    !validSnapshot(value)
  )
    throw new JournalError("INVALID");
  const canonical = {
    format: value.format,
    version: value.version,
    installationId: value.installationId,
    journalId: value.journalId,
    generation: value.generation,
    state: value.state,
    operationId: value.operationId
  };
  if (`${JSON.stringify(canonical)}\n` !== text)
    throw new JournalError("INVALID");
  if (
    value.installationId !== identity.installationId ||
    value.journalId !== identity.journalId
  )
    throw new JournalError("IDENTITY_MISMATCH");
  return canonical;
}
function ioError(error: unknown): JournalError {
  if (error instanceof JournalError) return error;
  return new JournalError(
    (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "MISSING" : "IO",
    error
  );
}
async function load(
  ops: typeof fs,
  path: string,
  identity: JournalIdentity
): Promise<RecordValue> {
  let file: fs.FileHandle | undefined;
  let failed = false;
  try {
    const stat = await ops.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new JournalError("INVALID");
    file = await ops.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await file.stat()).isFile()) throw new JournalError("INVALID");
    const buffer = Buffer.alloc(4097);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return parse(buffer.subarray(0, offset), identity);
  } catch (error) {
    failed = true;
    throw ioError(error);
  } finally {
    if (file)
      await file.close().catch((error: unknown) => {
        if (!failed) throw ioError(error);
      });
  }
}
async function replace(
  ops: typeof fs,
  directory: string,
  path: string,
  value: RecordValue
): Promise<void> {
  const temp = join(directory, `.handoff-journal-${randomUUID()}.tmp`);
  let file: fs.FileHandle | undefined;
  let dir: fs.FileHandle | undefined;
  let created = false;
  try {
    file = await ops.open(temp, "wx", 0o600);
    created = true;
    const data = Buffer.from(`${JSON.stringify(value)}\n`);
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await file.write(
        data,
        offset,
        data.length - offset,
        offset
      );
      if (bytesWritten <= 0) throw new Error("short write made no progress");
      offset += bytesWritten;
    }
    await file.sync();
    await file.close();
    file = undefined;
    await ops.rename(temp, path);
    dir = await ops.open(directory, "r");
    await dir.sync();
    await dir.close();
    dir = undefined;
  } catch (error) {
    if (file) await file.close().catch(() => {});
    if (dir) await dir.close().catch(() => {});
    if (created) await ops.unlink(temp).catch(() => {});
    throw new JournalError("INDETERMINATE", error);
  }
}
type Options = {
  directory: string;
  identity: JournalIdentity;
  authority: HandoffAuthority;
};
/**
 * Opens an existing journal under trusted caller authority. The caller must hold
 * exclusive ownership across all processes and prevent external modification;
 * authority object identity is only an in-process check, not proof of ownership.
 * This journal does not acquire a lock or authenticate its caller. Calling
 * markCleanAfterVerifiedCleanup asserts that the caller verified cleanup; the
 * journal cannot prove cleanup occurred. Durability assumes a trusted local
 * filesystem with atomic same-directory rename and working file and directory
 * sync semantics; these guarantees are not established by this API. Callers
 * must supply a fresh UUID for every operation; the journal retains no history
 * and cannot enforce UUID uniqueness. Replay detection applies to stale
 * snapshots, not reused operation IDs.
 */
export function openHandoffJournal(options: Options): Promise<HandoffJournal> {
  return openHandoffJournalWithOperations(options, fs);
}
/**
 * UNSAFE test-only fault injection. Never use in production: supplied operations
 * can falsely report successful writes or syncs, defeating durability.
 * @internal
 */
export const unsafeOpenHandoffJournalForTesting =
  openHandoffJournalWithOperations;
async function openHandoffJournalWithOperations(
  options: Options,
  ops: typeof fs
): Promise<HandoffJournal> {
  const {
    directory: inputDirectory,
    authority,
    identity: inputIdentity
  } = options;
  const identity = inputIdentity && {
    installationId: inputIdentity.installationId,
    journalId: inputIdentity.journalId
  };
  if (
    typeof inputDirectory !== "string" ||
    !inputDirectory ||
    !identity ||
    !uuid(identity.installationId) ||
    !uuid(identity.journalId) ||
    !authority ||
    typeof authority !== "object"
  )
    throw new JournalError("INVALID");
  const directory = resolve(inputDirectory);
  const path = join(directory, "handoff-journal.json");
  try {
    if (!(await ops.stat(directory)).isDirectory())
      throw new JournalError("INVALID");
  } catch (error) {
    throw ioError(error);
  }
  await load(ops, path, identity);
  let closed = false;
  let poisoned = false;
  let queue: Promise<unknown> = Promise.resolve();
  function run<T>(
    auth: HandoffAuthority,
    action: () => Promise<T>
  ): Promise<T> {
    const result = queue.then(async () => {
      if (closed) throw new JournalError("CLOSED");
      if (poisoned) throw new JournalError("INDETERMINATE");
      if (auth !== authority) throw new JournalError("INVALID");
      return action();
    });
    queue = result.catch(() => {});
    return result;
  }
  async function transition(
    expected: JournalSnapshot,
    next: JournalSnapshot
  ): Promise<JournalSnapshot> {
    const current = await load(ops, path, identity);
    if (
      current.generation !== expected.generation ||
      current.state !== expected.state ||
      current.operationId !== expected.operationId
    )
      throw new JournalError("STALE");
    try {
      await replace(ops, directory, path, {
        format: "koed-handoff-journal",
        version: 1,
        installationId: identity.installationId,
        journalId: identity.journalId,
        generation: next.generation,
        state: next.state,
        operationId: next.operationId
      });
    } catch (error) {
      poisoned = true;
      throw error;
    }
    return snapshot(next);
  }
  return {
    read: (auth) =>
      run(auth, async () => snapshot(await load(ops, path, identity))),
    begin: (auth, input, operationId) => {
      const expected = captureSnapshot(input);
      return run(auth, async () => {
        if (!expected || !uuid(operationId)) throw new JournalError("INVALID");
        if (
          expected.state !== "clean" ||
          expected.generation === Number.MAX_SAFE_INTEGER
        )
          throw new JournalError("INVALID_TRANSITION");
        return (await transition(expected, {
          generation: expected.generation + 1,
          state: "dirty",
          operationId
        })) as DirtySnapshot;
      });
    },
    markCleanAfterVerifiedCleanup: (auth, input) => {
      const expected = captureSnapshot(input);
      return run(auth, async () => {
        if (!expected) throw new JournalError("INVALID");
        if (expected.state !== "dirty")
          throw new JournalError("INVALID_TRANSITION");
        return transition(expected, {
          generation: expected.generation,
          state: "clean",
          operationId: null
        });
      });
    },
    close: async () => {
      const result = queue.then(() => {
        closed = true;
      });
      queue = result;
      await result;
    }
  };
}
