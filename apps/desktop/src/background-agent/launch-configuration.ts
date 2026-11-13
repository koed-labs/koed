import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const configurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installationId: z.uuid(),
  bundlePath: z.string().min(1),
  koedHome: z.string().min(1)
});

export type BackgroundAgentLaunchConfiguration = z.infer<
  typeof configurationSchema
>;
export type BackgroundAgentLaunchConfigurationRead =
  | { kind: "missing" }
  | { kind: "valid"; configuration: BackgroundAgentLaunchConfiguration }
  | { kind: "invalid" };

export interface BackgroundAgentLaunchConfigurationStore {
  readonly filePath: string;
  read(): BackgroundAgentLaunchConfigurationRead;
  write(input: Omit<BackgroundAgentLaunchConfiguration, "schemaVersion">): void;
  clear(): void;
}

export const createBackgroundAgentLaunchConfigurationStore = (input: {
  directoryPath: string;
  bundlePath: string;
}): BackgroundAgentLaunchConfigurationStore => {
  const directoryPath = resolve(input.directoryPath);
  const bundlePath = canonicalPath(input.bundlePath);
  const filePath = join(directoryPath, "launch-configuration.json");

  const read = (): BackgroundAgentLaunchConfigurationRead => {
    let fd: number | undefined;
    try {
      ensurePrivateDirectory(false);
      fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = fstatSync(fd);
      if (!isPrivateFile(stats)) return { kind: "invalid" };
      const parsed = configurationSchema.safeParse(
        JSON.parse(readFileSync(fd, "utf8"))
      );
      if (!parsed.success || !matchesInstallation(parsed.data))
        return { kind: "invalid" };
      return { kind: "valid", configuration: parsed.data };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { kind: "missing" };
      return { kind: "invalid" };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  const write = (
    value: Omit<BackgroundAgentLaunchConfiguration, "schemaVersion">
  ) => {
    const configuration = configurationSchema.parse({
      schemaVersion: 1,
      ...value,
      bundlePath: canonicalPath(value.bundlePath),
      koedHome: canonicalPath(value.koedHome)
    });
    if (!matchesInstallation(configuration))
      throw new Error(
        "Background Agent launch config bundle identity mismatch."
      );
    ensurePrivateDirectory(true);
    assertSafeTarget();
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(configuration)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporaryPath, filePath);
      chmodSync(filePath, 0o600);
      syncDirectory();
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== "ENOENT")
          throw new AggregateError(
            [error, cleanupError],
            "Background Agent launch config write and cleanup failed.",
            { cause: cleanupError }
          );
      }
      throw error;
    }
  };

  const clear = () => {
    try {
      ensurePrivateDirectory(false);
      assertSafeTarget();
      unlinkSync(filePath);
      syncDirectory();
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  };

  return { filePath, read, write, clear };

  function ensurePrivateDirectory(create: boolean) {
    if (create) mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    const stats = lstatSync(directoryPath);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      (stats.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        stats.uid !== process.getuid()) ||
      realpathSync(directoryPath) !== directoryPath
    ) {
      throw new Error(
        "Background Agent launch config directory is not private."
      );
    }
  }

  function assertSafeTarget() {
    try {
      if (!isPrivateFile(lstatSync(filePath)))
        throw new Error("Background Agent launch config file is not private.");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  function matchesInstallation(
    configuration: BackgroundAgentLaunchConfiguration
  ) {
    return (
      configuration.bundlePath === bundlePath &&
      canonicalPath(configuration.koedHome) === configuration.koedHome
    );
  }

  function syncDirectory() {
    const directoryFd = openSync(directoryPath, "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
};

const canonicalPath = (path: string) => {
  if (!isAbsolute(path))
    throw new Error("Background Agent path must be absolute.");
  const resolved = resolve(path);
  const canonical = realpathSync(resolved);
  if (resolved !== canonical)
    throw new Error("Background Agent path must be canonical.");
  return canonical;
};

const isPrivateFile = (stats: Stats) =>
  stats.isFile() &&
  (stats.mode & 0o077) === 0 &&
  stats.size <= 8 * 1024 &&
  (typeof process.getuid !== "function" || stats.uid === process.getuid());

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
