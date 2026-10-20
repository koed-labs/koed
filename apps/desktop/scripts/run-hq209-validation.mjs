import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import electronPath from "electron";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scratch = resolve(repoRoot, "scratch", "hq-209");
await mkdir(scratch, { recursive: true });
const profile = await mkdtemp(resolve(scratch, "native-profile-"));
try {
  const result = spawnSync(electronPath, ["scripts/validate-hq209.mjs"], {
    cwd: resolve(repoRoot, "apps/desktop"),
    env: { ...process.env, KOED_HQ209_USER_DATA_DIR: profile },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(profile, { recursive: true, force: true });
}
