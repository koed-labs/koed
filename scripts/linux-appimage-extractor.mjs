import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync
} from "node:fs";
import { join, resolve } from "node:path";
import { inspectAppImageHeader } from "./linux-appimage-inspection.mjs";

const defaultLimit = 128 * 1024 * 1024;
const imageReference =
  /^(?=.{1,255}$)[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

const snapshotCandidate = (source, target, expectedSha256) => {
  if (typeof constants.O_NOFOLLOW !== "number")
    throw new Error("Cannot safely open candidate.");
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(input);
    if (!stat.isFile() || stat.size > 4 * 1024 ** 3)
      throw new Error("Invalid candidate.");
    const output = openSync(target, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(1024 * 1024);
      let total = 0;
      while (total < stat.size) {
        const count = readSync(
          input,
          buffer,
          0,
          Math.min(buffer.length, stat.size - total),
          total
        );
        if (!count) throw new Error("Candidate changed during snapshot.");
        hash.update(buffer.subarray(0, count));
        let written = 0;
        while (written < count)
          written += writeSync(output, buffer, written, count - written);
        total += count;
      }
      if (
        fstatSync(input).size !== stat.size ||
        hash.digest("hex") !== expectedSha256
      )
        throw new Error("Candidate digest mismatch.");
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
  chmodSync(target, 0o444);
};

/** Fail closed until SquashFS directory uniqueness can be independently verified. */
export const extractAppImageAsar = ({
  imagePath,
  image,
  expectedSha256,
  maxAsarBytes = defaultLimit
}) => {
  if (typeof image !== "string" || !imageReference.test(image))
    throw new Error("Invalid trusted extractor image reference.");
  if (
    !Number.isSafeInteger(maxAsarBytes) ||
    maxAsarBytes < 1 ||
    maxAsarBytes > defaultLimit
  )
    throw new Error("Invalid ASAR size limit.");
  if (typeof imagePath !== "string" || /[,\n\r]/.test(imagePath))
    throw new Error("Invalid candidate path.");
  if (
    typeof expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedSha256)
  )
    throw new Error("Invalid expected candidate digest.");
  const scratch = resolve("scratch");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "extract-snapshot-"));
  let failure;
  let output;
  try {
    const candidate = join(dir, "candidate");
    snapshotCandidate(resolve(imagePath), candidate, expectedSha256);
    output = extractSnapshot(candidate, image, maxAsarBytes);
  } catch (error) {
    failure = error;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    throw new AggregateError(
      [failure, error].filter(Boolean),
      "Snapshot cleanup failed.",
      { cause: error }
    );
  }
  if (failure) throw failure;
  return output;
};

const extractSnapshot = (candidate, image, maxAsarBytes) => {
  if (/[,\n\r]/.test(candidate)) throw new Error("Invalid snapshot path.");
  const { offset } = inspectAppImageHeader(candidate);
  const name = `koed-extract-${randomUUID()}`;
  const script = `set -eu
umask 077
unsquashfs -no-progress -no-xattrs -processors 1 -offset "$1" -d /tmp/out /candidate resources/app.asar >/dev/null 2>&1
if [ ! -d /tmp/out/resources ] || [ -L /tmp/out/resources ] || [ ! -f /tmp/out/resources/app.asar ] || [ -L /tmp/out/resources/app.asar ]; then exit 1; fi
size=$(wc -c </tmp/out/resources/app.asar)
[ "$size" -le "$2" ]
cat /tmp/out/resources/app.asar`;
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--log-driver",
    "local",
    "--log-opt",
    `max-size=${maxAsarBytes + 65536}`,
    "--log-opt",
    "max-file=1",
    "--log-opt",
    "compress=false",
    "--pull",
    "never",
    "--platform",
    "linux/amd64",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--memory",
    "512m",
    "--pids-limit",
    "64",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${maxAsarBytes + 8 * 1024 * 1024},mode=1777`,
    "--mount",
    `type=bind,src=${candidate},dst=/candidate,readonly`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    script,
    "extract",
    String(offset),
    String(maxAsarBytes)
  ];
  let failure;
  try {
    const options = {
      timeout: 60_000,
      maxBuffer: maxAsarBytes + 65536,
      encoding: "buffer"
    };
    const started = spawnSync("docker", args, options);
    if (started.error || started.status !== 0)
      throw new Error("Isolated ASAR extraction failed.", {
        cause: started.error
      });
    const waited = spawnSync("docker", ["wait", name], options);
    if (
      waited.error ||
      waited.status !== 0 ||
      waited.stdout.toString().trim() !== "0"
    )
      throw new Error("Isolated ASAR extraction failed.", {
        cause: waited.error
      });
    const result = spawnSync("docker", ["logs", name], options);
    if (
      result.error ||
      result.status !== 0 ||
      result.stderr.length ||
      result.stdout.length > maxAsarBytes
    )
      throw new Error("Isolated ASAR extraction failed.", {
        cause: result.error
      });
    throw new Error(
      "Extractor cannot verify SquashFS directory uniqueness or hardlink safety; refusing output."
    );
  } catch (error) {
    failure = error;
  }
  const cleanup = spawnSync("docker", ["rm", "-f", name], {
    timeout: 10_000,
    stdio: "ignore"
  });
  if (cleanup.error || cleanup.status !== 0)
    throw new AggregateError(
      [failure, cleanup.error].filter(Boolean),
      `Docker cleanup failed for ${name}.`,
      { cause: failure }
    );
  throw failure;
};
