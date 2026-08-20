import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  statfs,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import {
  assertBoundedPath,
  assertNoDotPathComponents,
  assertNoSymlinkComponents,
  assertRegularFile,
  isPathInside,
  validateArtifactRelativePath
} from "./artifacts.js";

const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
const MAX_JOURNAL_RECORD_BYTES = 1024 * 1024;

const existingAncestor = async (candidate: string): Promise<string> => {
  let current = candidate;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
};

const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const finiteNonNegative = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite and non-negative`);
  }
};

export interface RunCapacityEstimate {
  requiredBytes: number;
  reserveBytes: number;
  availableBytes: number;
  estimatedDurationSeconds: { minimum: number; maximum: number };
}

export interface RunCapacityInput {
  sourceAttempts: number;
  replayAttempts: number;
  maximumTrajectoryBytes: number;
  estimatedAttemptArtifactBytes: number;
  estimatedImageBytes: number;
  scratchMultiplier: number;
  reserveBytes: number;
  attemptDurationSeconds: { minimum: number; maximum: number };
  concurrency: number;
}

export const estimateRunCapacity = (
  input: RunCapacityInput
): Omit<RunCapacityEstimate, "availableBytes"> => {
  if (!Number.isSafeInteger(input.sourceAttempts) || input.sourceAttempts < 0) {
    throw new Error("sourceAttempts must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.replayAttempts) || input.replayAttempts < 0) {
    throw new Error("replayAttempts must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) {
    throw new Error("concurrency must be a positive safe integer");
  }
  finiteNonNegative(input.maximumTrajectoryBytes, "maximumTrajectoryBytes");
  finiteNonNegative(
    input.estimatedAttemptArtifactBytes,
    "estimatedAttemptArtifactBytes"
  );
  finiteNonNegative(input.estimatedImageBytes, "estimatedImageBytes");
  finiteNonNegative(input.scratchMultiplier, "scratchMultiplier");
  finiteNonNegative(input.reserveBytes, "reserveBytes");
  finiteNonNegative(
    input.attemptDurationSeconds.minimum,
    "attemptDurationSeconds.minimum"
  );
  finiteNonNegative(
    input.attemptDurationSeconds.maximum,
    "attemptDurationSeconds.maximum"
  );
  if (
    input.attemptDurationSeconds.maximum < input.attemptDurationSeconds.minimum
  ) {
    throw new Error(
      "attemptDurationSeconds.maximum must not be less than minimum"
    );
  }
  const attempts = input.sourceAttempts + input.replayAttempts;
  if (!Number.isSafeInteger(attempts))
    throw new Error("total attempts exceed the safe integer range");
  const retained =
    input.sourceAttempts * input.maximumTrajectoryBytes +
    attempts * input.estimatedAttemptArtifactBytes +
    input.estimatedImageBytes;
  const requiredBytes = Math.ceil(retained * input.scratchMultiplier);
  const waves = Math.ceil(attempts / input.concurrency);
  const minimum = waves * input.attemptDurationSeconds.minimum;
  const maximum = waves * input.attemptDurationSeconds.maximum;
  for (const [value, label] of [
    [requiredBytes, "requiredBytes"],
    [minimum, "estimated minimum duration"],
    [maximum, "estimated maximum duration"]
  ] as const)
    finiteNonNegative(value, label);
  if (!Number.isSafeInteger(requiredBytes)) {
    throw new Error("requiredBytes exceeds the safe integer range");
  }
  return {
    requiredBytes,
    reserveBytes: input.reserveBytes,
    estimatedDurationSeconds: { minimum, maximum }
  };
};

interface OpenParent {
  destination: string;
  parentPath: string;
  rootHandle: FileHandle;
  parentHandle: FileHandle;
  parentStats: Stats;
}

export class SafeRunDirectory {
  private appendTail: Promise<void> = Promise.resolve();

  private constructor(
    readonly root: string,
    private readonly repositoryRoot: string,
    private readonly rootStats: Stats
  ) {}

  static async create({
    outputPath,
    repositoryRoot,
    requiredBytes,
    reserveBytes
  }: {
    outputPath: string;
    repositoryRoot: string;
    requiredBytes: number;
    reserveBytes: number;
  }): Promise<{ directory: SafeRunDirectory; availableBytes: number }> {
    finiteNonNegative(requiredBytes, "requiredBytes");
    finiteNonNegative(reserveBytes, "reserveBytes");
    assertBoundedPath(outputPath, "Benchmark output path");
    assertNoDotPathComponents(outputPath, "Benchmark output path");
    const absoluteOutput = path.resolve(outputPath);
    const absoluteRepository = await realpath(repositoryRoot);
    if (isPathInside(absoluteOutput, absoluteRepository)) {
      throw new Error("Benchmark output must be outside the repository");
    }
    const ancestor = await existingAncestor(absoluteOutput);
    await assertNoSymlinkComponents(ancestor);
    await mkdir(absoluteOutput, { recursive: true, mode: 0o700 });
    await assertNoSymlinkComponents(absoluteOutput);
    const canonical = await realpath(absoluteOutput);
    if (canonical !== absoluteOutput) {
      throw new Error("Benchmark output path used a symlink alias");
    }
    if (isPathInside(canonical, absoluteRepository)) {
      throw new Error("Benchmark output resolves inside the repository");
    }
    const rootHandle = await open(
      canonical,
      constants.O_RDONLY | noFollow | (constants.O_DIRECTORY ?? 0)
    );
    try {
      const rootStats = await rootHandle.stat();
      if (!rootStats.isDirectory())
        throw new Error("Benchmark output is not a directory");
      const current = await lstat(canonical);
      if (!sameIdentity(rootStats, current)) {
        throw new Error("Benchmark output changed during admission");
      }
      await rootHandle.chmod(0o700);
      const disk = await statfs(canonical);
      const availableBytes = Number(disk.bavail) * Number(disk.bsize);
      finiteNonNegative(availableBytes, "availableBytes");
      if (availableBytes - reserveBytes < requiredBytes) {
        throw new Error(
          `Insufficient disk space: requires ${requiredBytes} bytes plus ${reserveBytes} bytes reserve, ${availableBytes} available`
        );
      }
      await rootHandle.close();
      return {
        directory: new SafeRunDirectory(
          canonical,
          absoluteRepository,
          rootStats
        ),
        availableBytes
      };
    } catch (error) {
      await rootHandle.close();
      throw error;
    }
  }

  private async openRoot(): Promise<FileHandle> {
    const rootHandle = await open(
      this.root,
      constants.O_RDONLY | noFollow | (constants.O_DIRECTORY ?? 0)
    );
    const opened = await rootHandle.stat();
    const current = await lstat(this.root);
    if (
      !sameIdentity(opened, this.rootStats) ||
      !sameIdentity(current, this.rootStats)
    ) {
      await rootHandle.close();
      throw new Error("Benchmark output path changed after admission");
    }
    try {
      await assertNoSymlinkComponents(this.root);
      if ((await realpath(this.root)) !== this.root) {
        throw new Error("Benchmark output path became a symlink alias");
      }
      return rootHandle;
    } catch (error) {
      await rootHandle.close();
      throw error;
    }
  }

  private async openParent(relativePath: string): Promise<OpenParent> {
    const relative = validateArtifactRelativePath(relativePath);
    const destination = path.join(this.root, relative);
    if (!isPathInside(destination, this.root)) {
      throw new Error("Artifact path must remain inside the run directory");
    }
    const rootHandle = await this.openRoot();
    const parentPath = path.dirname(destination);
    try {
      await mkdir(parentPath, { recursive: true, mode: 0o700 });
      await assertNoSymlinkComponents(parentPath, this.root);
      const canonicalParent = await realpath(parentPath);
      if (
        canonicalParent !== parentPath ||
        !isPathInside(canonicalParent, this.root)
      ) {
        throw new Error(
          "Benchmark artifact parent used a symlink or escaped the run directory"
        );
      }
      if (isPathInside(canonicalParent, this.repositoryRoot)) {
        throw new Error("Benchmark output resolved into the repository");
      }
      const parentHandle = await open(
        parentPath,
        constants.O_RDONLY | noFollow | (constants.O_DIRECTORY ?? 0)
      );
      const parentStats = await parentHandle.stat();
      if (
        !parentStats.isDirectory() ||
        !sameIdentity(parentStats, await lstat(parentPath))
      ) {
        await parentHandle.close();
        throw new Error("Benchmark artifact parent changed during validation");
      }
      await parentHandle.chmod(0o700);
      return {
        destination,
        parentPath,
        rootHandle,
        parentHandle,
        parentStats
      };
    } catch (error) {
      await rootHandle.close();
      throw error;
    }
  }

  private async finishParent(parent: OpenParent): Promise<void> {
    try {
      if (!sameIdentity(parent.parentStats, await lstat(parent.parentPath))) {
        throw new Error("Benchmark artifact parent changed during operation");
      }
      const openedRoot = await parent.rootHandle.stat();
      const currentRoot = await lstat(this.root);
      if (
        !sameIdentity(openedRoot, this.rootStats) ||
        !sameIdentity(currentRoot, this.rootStats)
      ) {
        throw new Error("Benchmark output path changed during operation");
      }
    } finally {
      await parent.parentHandle.close();
      await parent.rootHandle.close();
    }
  }

  async writeJson(relativePath: string, value: unknown): Promise<void> {
    const parent = await this.openParent(relativePath);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        parent.destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600
      );
      await assertRegularFile(handle, "Artifact");
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
      const opened = await handle.stat();
      const current = await lstat(parent.destination);
      if (!sameIdentity(opened, current)) {
        throw new Error("Artifact pathname changed while being written");
      }
    } finally {
      await handle?.close();
      await this.finishParent(parent);
    }
  }

  async appendJsonLine(relativePath: string, value: unknown): Promise<void> {
    const record = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (record.byteLength > MAX_JOURNAL_RECORD_BYTES) {
      throw new Error("Journal record exceeds the append limit");
    }
    // Serialize appends in this process. Portable Node exposes neither openat2
    // path resolution nor advisory file locking, so concurrent writer processes
    // are intentionally unsupported; resume parsing fails closed on corruption.
    const operation = this.appendTail.then(async () => {
      const parent = await this.openParent(relativePath);
      let handle: FileHandle | undefined;
      try {
        handle = await open(
          parent.destination,
          constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            noFollow,
          0o600
        );
        await assertRegularFile(handle, "Journal");
        const openedBeforeWrite = await handle.stat();
        const pathBeforeWrite = await lstat(parent.destination);
        if (!sameIdentity(openedBeforeWrite, pathBeforeWrite)) {
          throw new Error("Journal pathname changed before append");
        }
        const result = await handle.write(record, 0, record.byteLength, null);
        if (result.bytesWritten !== record.byteLength) {
          throw new Error("Incomplete journal append");
        }
        await handle.sync();
        const opened = await handle.stat();
        const current = await lstat(parent.destination);
        if (!sameIdentity(opened, current)) {
          throw new Error("Journal pathname changed during append");
        }
      } finally {
        await handle?.close();
        await this.finishParent(parent);
      }
    });
    // Keep a failed/possibly partial append as a permanent poison. Continuing
    // could make a torn journal look like a later valid sequence.
    this.appendTail = operation;
    await operation;
  }
}
