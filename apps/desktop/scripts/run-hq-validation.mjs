import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import electronPath from "electron";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "../../..");
const scratchDir = resolve(repoRoot, "scratch");

await mkdir(scratchDir, { recursive: true });
const userDataPath = await mkdtemp(
  resolve(scratchDir, "hq-008-electron-profile-")
);

try {
  if (process.env.KOED_HQ204_FORCE_FAILURE !== "1") {
    const result = spawnSync(electronPath, ["scripts/validate-hq.mjs"], {
      cwd: desktopDir,
      env: { ...process.env, KOED_HQ_USER_DATA_DIR: userDataPath },
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const privateProfile = await mkdtemp(
      resolve(scratchDir, "hq204-electron-profile-")
    );
    try {
      const privateHq = spawnSync(
        electronPath,
        ["scripts/validate-hq204.mjs"],
        {
          cwd: desktopDir,
          env: { ...process.env, KOED_HQ204_USER_DATA_DIR: privateProfile },
          stdio: "inherit"
        }
      );
      if (privateHq.error) throw privateHq.error;
      process.exitCode = privateHq.status ?? 1;
    } finally {
      await rm(privateProfile, { recursive: true, force: true });
    }
  }
} finally {
  await rm(userDataPath, { recursive: true, force: true });
}
