import { accessSync, constants, statSync } from "node:fs";

// Keep discovery independent of the desktop launcher or shell's PATH. Native
// installations, NVIDIA containers and WSL expose the tool in different places.
const candidates = [
  "/usr/bin/nvidia-smi",
  "/bin/nvidia-smi",
  "/usr/local/bin/nvidia-smi",
  "/usr/local/nvidia/bin/nvidia-smi",
  "/usr/lib/wsl/lib/nvidia-smi"
];

export function resolveNvidiaSmi(): string | null {
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Missing, broken symlink or not executable: try the next system location.
    }
  }
  return null;
}
