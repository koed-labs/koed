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
const chatMoveReportPath = resolve(scratchDir, "hq-107", "browser-report.json");
const dispatchReportPath = resolve(scratchDir, "hq-404", "browser-report.json");
const memoryScopeReportPath = resolve(
  scratchDir,
  "hq-304",
  "browser-report.json"
);
const memoryCitationReportPath = resolve(
  scratchDir,
  "hq-306",
  "browser-report.json"
);
const memoryActionReportPath = resolve(
  scratchDir,
  "hq-307",
  "browser-report.json"
);

await mkdir(scratchDir, { recursive: true });
await rm(sourcesReportPath, { force: true });
await rm(projectViewReportPath, { force: true });
await rm(workItemReportPath, { force: true });
await rm(chatLifecycleReportPath, { force: true });
await rm(chatMoveReportPath, { force: true });
await rm(dispatchReportPath, { force: true });
await rm(memoryScopeReportPath, { force: true });
await rm(memoryCitationReportPath, { force: true });
await rm(memoryActionReportPath, { force: true });
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
        KOED_HQ207_DELEGATED_S01_S11: "1",
        KOED_HQ304_DELEGATED_S18: "1",
        KOED_HQ306_DELEGATED_S07: "1",
        KOED_HQ307_DELEGATED_S18: "1",
        KOED_HQ308_DELEGATED_S19: "1"
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
  if (process.exitCode === undefined || process.exitCode === 0) {
    const chatMove = spawnSync(electronPath, ["scripts/validate-hq107.mjs"], {
      cwd: desktopDir,
      env: process.env,
      stdio: "inherit",
      timeout: 60_000
    });
    if (chatMove.error) throw chatMove.error;
    process.exitCode = chatMove.status ?? 1;
    if (process.exitCode === 0) {
      const report = JSON.parse(await readFile(chatMoveReportPath, "utf8"));
      assert.deepEqual(
        { id: report.id, status: report.status },
        { id: "HQ107.private-native", status: "pass" }
      );
      assert.deepEqual(report.compoundS15_1, {
        status: "skip",
        reason:
          "Shared destination confirmation and policy issuance belong to HQ-702"
      });
      process.stdout.write(
        "PASS HQ107.private-native [HQ-107]: private Project/Chats drag, highlights, Undo, and light/dark captures; S15.1 shared destination remains HQ-702.\n"
      );
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const memoryProfile = await mkdtemp(
      resolve(scratchDir, "hq304-electron-profile-")
    );
    try {
      const memoryHq = spawnSync(electronPath, ["scripts/validate-hq304.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ304_USER_DATA_DIR: memoryProfile },
        stdio: "inherit"
      });
      if (memoryHq.error) throw memoryHq.error;
      process.exitCode = memoryHq.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(
          await readFile(memoryScopeReportPath, "utf8")
        );
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ304.native", owner: "HQ-304", status: "pass" }
        );
        assert.ok(
          report.assertions.some(
            (entry) =>
              entry.id === "S18.2" &&
              entry.owner === "HQ-304" &&
              entry.status === "pass"
          )
        );
        process.stdout.write(
          "PASS S18.2 [HQ-304]: native Project/Me/Other memory scope separation.\n"
        );
      }
    } finally {
      await rm(memoryProfile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const citationProfile = await mkdtemp(
      resolve(scratchDir, "hq306-electron-profile-")
    );
    try {
      const citationHq = spawnSync(
        electronPath,
        ["scripts/validate-hq306.mjs"],
        {
          cwd: desktopDir,
          env: { ...process.env, KOED_HQ306_USER_DATA_DIR: citationProfile },
          stdio: "inherit",
          timeout: 60_000
        }
      );
      if (citationHq.error) throw citationHq.error;
      process.exitCode = citationHq.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(
          await readFile(memoryCitationReportPath, "utf8")
        );
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ306.native", owner: "HQ-306", status: "pass" }
        );
        assert.deepEqual(report.assertions, [
          { id: "S07.1", owner: "HQ-306", status: "pass" }
        ]);
        assert.equal(
          report.assertion,
          "Memory number in reply opens next to chat; citation still resolves after reload"
        );
        process.stdout.write(
          "PASS S07.1 [HQ-306]: citation opens beside chat and resolves after reload.\n"
        );
      }
    } finally {
      await rm(citationProfile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const dispatchProfile = await mkdtemp(
      resolve(scratchDir, "hq404-electron-profile-")
    );
    try {
      const dispatchHq = spawnSync(
        electronPath,
        ["scripts/validate-hq404.mjs"],
        {
          cwd: desktopDir,
          env: { ...process.env, KOED_HQ404_USER_DATA_DIR: dispatchProfile },
          stdio: "inherit"
        }
      );
      if (dispatchHq.error) throw dispatchHq.error;
      process.exitCode = dispatchHq.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(dispatchReportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ404.native", owner: "HQ-404", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ404.native [HQ-404]: Send, Working now, linked Conversation reuse and Work brief; compound S04.1 awaits HQ-405.\n"
        );
      }
    } finally {
      await rm(dispatchProfile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const learnedReport = resolve(scratchDir, "hq-305", "HQ305.native.json");
    await rm(learnedReport, { force: true });
    const learnedProfile = await mkdtemp(
      resolve(scratchDir, "hq305-electron-profile-")
    );
    try {
      const learned = spawnSync(electronPath, ["scripts/validate-hq305.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ305_USER_DATA_DIR: learnedProfile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (learned.error) throw learned.error;
      process.exitCode = learned.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(learnedReport, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ305.native", owner: "HQ-305", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ305.native [HQ-305]: today's Project memory, detail, exact Forget/Undo, and external refresh.\n"
        );
      }
    } finally {
      await rm(learnedProfile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const actionProfile = await mkdtemp(
      resolve(scratchDir, "hq307-electron-profile-")
    );
    try {
      const actions = spawnSync(electronPath, ["scripts/validate-hq307.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ307_USER_DATA_DIR: actionProfile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (actions.error) throw actions.error;
      process.exitCode = actions.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(
          await readFile(memoryActionReportPath, "utf8")
        );
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ307.native", owner: "HQ-307", status: "pass" }
        );
        assert.ok(
          report.assertions.some(
            (entry) =>
              entry.id === "S18.1" &&
              entry.owner === "HQ-307" &&
              entry.status === "pass"
          )
        );
        process.stdout.write(
          "PASS S18.1 [HQ-307]: grouped memory, replacement detail and Forget control; exact action Undo and chat confirmation pass. Compound S18.3 and N12.U still require HQ-504.\n"
        );
      }
    } finally {
      await rm(actionProfile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-308", "HQ308.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq308-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq308.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ308_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ308.native", owner: "HQ-308", status: "pass" }
        );
        assert.ok(
          report.checks.includes(
            "chips start the secondary line below row titles"
          )
        );
        process.stdout.write(
          "PASS S19.1 [HQ-308]: Now and Project Needs you Why chips, Working now count, reauthorized right-column source details, v50 placement and desktop light/dark.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-405", "browser-report.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq405-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq405.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ405_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ405.native", owner: "HQ-405", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ405.native [HQ-405]: compact PR/check/review rows, ticketless PR, exact Native client, provider-read reconciliation to Done and proposal decline; text routing remains HQ-504.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-502", "HQ502.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq502-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq502.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ502_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ502.native", owner: "HQ-502", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ502.native [HQ-502]: owner-bound Agent Pixelkin paint, v50 navigation icons and desktop light/dark.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-712", "HQ712.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq712-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq712.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ712_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ712.native", owner: "HQ-712", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ712.native [HQ-712]: shared Project records, event refresh, offline read-only state, uploader Source panel and owner-only Native PR controls; real two-user compound proofs remain HQ-713.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-407", "HQ407.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq407-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq407.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ407_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ407.native", owner: "HQ-407", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ407.native [HQ-407]: viewer-local deadlines in Now and Project, exact Team row focus, shared Due CAS and offline state; S21.1 remains compound pending HQ-406/HQ-713.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-406", "native-report.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq406-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq406.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ406_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ406.native", owner: "HQ-406", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ406.native [HQ-406]: v50 document action, simple User prompt and separate selected Source in new/active private HQ; compound S06.1 text/offer routing awaits HQ-504.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
} finally {
  await rm(userDataPath, { recursive: true, force: true });
}
