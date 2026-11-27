import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { KoedServerPaths } from "../paths.js";
import type { LegacyStopEvidence } from "./state.js";

const legacySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    installationId: z.uuid(),
    bundlePath: z.string().min(1),
    koedHome: z.string().min(1),
    generation: z.number().int().nonnegative().safe(),
    state: z.enum(["stopped", "starting", "ready", "needs_attention"]),
    stopIntent: z.boolean(),
    updatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)))
  })
  .refine(
    (value) =>
      !value.stopIntent ||
      value.state === "stopped" ||
      value.state === "needs_attention"
  );

export function readLegacyStopEvidence(
  paths: KoedServerPaths
): LegacyStopEvidence {
  let fd: number | undefined;
  let directoryChecked = false;
  try {
    const home = realpathSync(paths.koedHome);
    const directory = resolve(home, "run");
    const directoryStats = lstatSync(directory);
    if (
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      (directoryStats.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        directoryStats.uid !== process.getuid()) ||
      realpathSync(directory) !== directory
    )
      return { kind: "invalid" };
    directoryChecked = true;
    fd = openSync(
      resolve(directory, "background-agent-state.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o077) !== 0 ||
      stats.size > 16_384 ||
      (typeof process.getuid === "function" && stats.uid !== process.getuid())
    )
      return { kind: "invalid" };
    const parsed = legacySchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    if (
      !parsed.success ||
      !isAbsolute(parsed.data.koedHome) ||
      realpathSync(parsed.data.koedHome) !== home
    )
      return { kind: "invalid" };
    return { kind: "valid", stopIntent: parsed.data.stopIntent };
  } catch (error) {
    if (
      directoryChecked &&
      fd === undefined &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return { kind: "absent" };
    return { kind: "invalid" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
