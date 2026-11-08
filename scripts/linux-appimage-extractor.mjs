import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { inspectAppImageHeader } from "./linux-appimage-inspection.mjs";

const defaultLimit = 128 * 1024 * 1024;
const imageReference =
  /^(?=.{1,255}$)[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

/** Extract only ASAR bytes using a caller-provisioned, trusted local Docker image. */
export const extractAppImageAsar = ({
  imagePath,
  image,
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
  const candidate = resolve(imagePath);
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
    return result.stdout;
  } finally {
    spawnSync("docker", ["rm", "-f", name], {
      timeout: 10_000,
      stdio: "ignore"
    });
  }
};
