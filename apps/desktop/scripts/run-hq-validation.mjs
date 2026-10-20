import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import electronPath from "electron";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "../../..");
const scratchDir = resolve(repoRoot, "scratch");
const sourcesReportPath = resolve(scratchDir, "hq-205", "browser-report.json");
const projectViewReportPath = resolve(
  scratchDir,
  "hq-207",
  "browser-report.json"
);
const workItemReportPath = resolve(scratchDir, "hq-403", "browser-report.json");
const chatLifecycleReportPath = resolve(
  scratchDir,
  "hq-106",
  "browser-report.json"
);

await mkdir(scratchDir, { recursive: true });
await rm(sourcesReportPath, { force: true });
await rm(projectViewReportPath, { force: true });
await rm(workItemReportPath, { force: true });
await rm(chatLifecycleReportPath, { force: true });
const userDataPath = await mkdtemp(
  resolve(scratchDir, "hq-008-electron-profile-")
);

try {
  if (process.env.KOED_HQ204_FORCE_FAILURE !== "1") {
    const result = spawnSync(electronPath, ["scripts/validate-hq.mjs"], {
      cwd: desktopDir,
      env: {
        ...process.env,
        KOED_HQ_USER_DATA_DIR: userDataPath,
        KOED_HQ205_DELEGATED_S09: "1",
        KOED_HQ207_DELEGATED_S01_S11: "1"
      },
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
  if (process.exitCode === undefined || process.exitCode === 0) {
    const sourcesProfile = await mkdtemp(
      resolve(scratchDir, "hq205-electron-profile-")
    );
    try {
      const sourcesHq = spawnSync(
        electronPath,
        ["scripts/validate-hq205.mjs"],
        {
          cwd: desktopDir,
          env: { ...process.env, KOED_HQ205_USER_DATA_DIR: sourcesProfile },
          stdio: "inherit"
        }
      );
      if (sourcesHq.error) throw sourcesHq.error;
      process.exitCode = sourcesHq.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(sourcesReportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "S09.1", owner: "HQ-205", status: "pass" }
        );
        assert.equal(
          report.assertion,
          "Skills listed with Project sources; skill addition explained"
        );
        process.stdout.write(
          "PASS S09.1 [HQ-205]: Skills listed with Project sources; skill addition explained.\n"
        );
      }
    } finally {
      await rm(sourcesProfile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const projectViewProfile = await mkdtemp(
      resolve(scratchDir, "hq207-electron-profile-")
    );
    try {
      const projectView = spawnSync(
        electronPath,
        ["scripts/validate-hq207.mjs"],
        {
          cwd: desktopDir,
          env: { ...process.env, KOED_HQ207_USER_DATA_DIR: projectViewProfile },
          stdio: "inherit"
        }
      );
      if (projectView.error) throw projectView.error;
      process.exitCode = projectView.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(
          await readFile(projectViewReportPath, "utf8")
        );
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ207.native", owner: "HQ-207", status: "pass" }
        );
        assert.deepEqual(report.assertions, [
          { id: "S01.1", owner: "HQ-207", status: "pass" },
          { id: "S11.1", owner: "HQ-207", status: "pass" }
        ]);
        process.stdout.write(
          "PASS S01.1 [HQ-207]: outcome activity, sources, and key item without a ticket-progress fraction.\nPASS S11.1 [HQ-207]: context Q&A, Escape/X close, fold, and chat visibility.\n"
        );
      }
    } finally {
      await rm(projectViewProfile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const sourceIngestion = spawnSync(
      process.execPath,
      ["scripts/run-hq209-validation.mjs"],
      { cwd: desktopDir, env: process.env, stdio: "inherit" }
    );
    if (sourceIngestion.error) throw sourceIngestion.error;
    process.exitCode = sourceIngestion.status ?? 1;
    if (process.exitCode === 0)
      process.stdout.write(
        "PASS HQ209.native [HQ-209]: owner-readable Source text and exact Note revision context in the native Project view.\n"
      );
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const workItemProfile = await mkdtemp(
      resolve(scratchDir, "hq403-electron-profile-")
    );
    try {
      const workItemView = spawnSync(
        electronPath,
        ["scripts/validate-hq403.mjs"],
        {
          cwd: desktopDir,
          env: { ...process.env, KOED_HQ403_USER_DATA_DIR: workItemProfile },
          stdio: "inherit",
          timeout: 60_000
        }
      );
      if (workItemView.error) throw workItemView.error;
      process.exitCode = workItemView.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(workItemReportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, status: report.status },
          { id: "HQ403.native", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ403.native [HQ-403]: Work Item sections, due entry, caps, folds, versioned tick-off and activity.\n"
        );
      }
    } finally {
      await rm(workItemProfile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const chatLifecycleProfile = await mkdtemp(
      resolve(scratchDir, "hq106-electron-profile-")
    );
    try {
      const chatLifecycle = spawnSync(
        electronPath,
        ["scripts/validate-hq106.mjs"],
        {
          cwd: desktopDir,
          env: {
            ...process.env,
            KOED_HQ106_USER_DATA_DIR: chatLifecycleProfile
          },
          stdio: "inherit",
          timeout: 60_000
        }
      );
      if (chatLifecycle.error) throw chatLifecycle.error;
      process.exitCode = chatLifecycle.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(
          await readFile(chatLifecycleReportPath, "utf8")
        );
        assert.deepEqual(
          { id: report.id, status: report.status },
          { id: "HQ106.native", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ106.native [HQ-106]: Delete, pending, Deleted restore, Forget, Undo, and light/dark captures.\n"
        );
      }
    } finally {
      await rm(chatLifecycleProfile, { recursive: true, force: true });
    }
  }
} finally {
  await rm(userDataPath, { recursive: true, force: true });
}
