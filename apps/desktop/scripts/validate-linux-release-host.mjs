import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateLinuxReleaseHost(
  platform = process.platform,
  arch = process.arch
) {
  if (platform !== "linux" || arch !== "x64") {
    throw new Error(
      `Linux Desktop release requires a native Linux x64 host (detected ${platform} ${arch}).`
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    validateLinuxReleaseHost();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
