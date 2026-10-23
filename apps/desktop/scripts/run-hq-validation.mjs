import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import electronPath from "electron";
import { compileBrowserParity } from "./hq-browser-parity.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "../../..");
const chainStartedAt = Date.now();
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
        KOED_HQ_ACCEPTANCE_CHAIN: "1",
        KOED_HQ_USER_DATA_DIR: userDataPath,
        KOED_HQ205_DELEGATED_S09: "1",
        KOED_HQ207_DELEGATED_S01_S11: "1",
        KOED_HQ304_DELEGATED_S18: "1",
        KOED_HQ306_DELEGATED_S07: "1",
        KOED_HQ307_DELEGATED_S18: "1",
        KOED_HQ308_DELEGATED_S19: "1",
        KOED_HQ603_DELEGATED_S12_SCHEDULED: "1",
        KOED_HQ702_DELEGATED_S15_2: "1",
        KOED_HQ704_DELEGATED_LIFECYCLE: "1"
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
          { id: "S07.1", owner: "HQ-306", status: "pass" },
          {
            id: "S28.1",
            owner: "HQ-306",
            status: "pass",
            checks: [
              "two-persisted-aliases-after-reload",
              "distinct-second-detail"
            ]
          }
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
    const reportPath = resolve(scratchDir, "hq-505", "HQ505.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq505-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq505.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ505_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 90_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ505.native", owner: "HQ-505", status: "pass" }
        );
        assert.equal(report.assertions.length, 7);
        assert.equal(report.cases.length, 2);
        for (const theme of ["light", "dark"]) {
          assert.ok(
            report.screenshots.includes(`catch-up-waiting-${theme}.png`)
          );
          assert.ok(
            report.screenshots.includes(`catch-up-recovered-${theme}.png`)
          );
          assert.ok(
            report.screenshots.includes(`catch-up-citation-${theme}.png`)
          );
          assert.ok(
            report.screenshots.includes(`catch-up-open-team-${theme}.png`)
          );
          assert.ok(
            report.screenshots.includes(`catch-up-reloaded-${theme}.png`)
          );
          assert.ok(
            report.screenshots.includes(
              `linked-team-source-no-make-${theme}.png`
            )
          );
          assert.ok(
            report.screenshots.includes(`catch-up-reconcile-${theme}.png`)
          );
          assert.ok(
            report.screenshots.includes(`personal-source-action-${theme}.png`)
          );
        }
        process.stdout.write(
          "PASS HQ505.native [HQ-505]: linked catch-up and Open Team, reconciliation, separate Personal Source action, desktop light/dark.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-506", "HQ506.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq506-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq506.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ506_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ506.native", owner: "HQ-506", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ506.native [HQ-506]: role choice, Chief Pixelkin maker, AI Client gate, desktop light/dark.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-521", "HQ521.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq521-electron-profile-")
    );
    try {
      const result = spawnSync(
        electronPath,
        ["scripts/validate-hq521-native.mjs"],
        {
          cwd: desktopDir,
          env: { ...process.env, KOED_HQ521_USER_DATA_DIR: profile },
          stdio: "inherit",
          timeout: 60_000
        }
      );
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ521.native", owner: "HQ-521", status: "pass" }
        );
        assert.deepEqual(report.assertions, [
          "U1",
          "U2",
          "U3",
          "N19",
          "N24",
          "N34",
          "N35"
        ]);
        assert.ok(report.screenshots.includes("model-menu-light.png"));
        assert.ok(report.screenshots.includes("settings-usage-light.png"));
        assert.ok(report.screenshots.includes("settings-usage-dark.png"));
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-520", "HQ520.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq520-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq520.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ520_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ520.native", owner: "HQ-520", status: "pass" }
        );
        assert.equal(report.assertion, "S520.1");
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-705", "HQ705.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq705-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq705.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ705_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ705.native", owner: "HQ-705", status: "pass" }
        );
        assert.equal(report.assertions.length, 9);
        assert.ok(report.screenshots.includes("project-team-light.png"));
        assert.ok(report.screenshots.includes("project-team-dark.png"));
        assert.ok(
          report.screenshots.includes("project-team-hidden-unread-light.png")
        );
        assert.ok(
          report.screenshots.includes("project-team-hidden-unread-dark.png")
        );
        process.stdout.write(
          "PASS HQ705.native [HQ-705]: human Project Thread, mention and send, hidden unread/read lifecycle, desktop light/dark.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-707", "HQ707.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq707-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq707.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ707_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ707.native", owner: "HQ-707", status: "pass" }
        );
        assert.equal(report.assertions.length, 5);
        for (const theme of ["light", "dark"]) {
          assert.ok(report.screenshots.includes(`reply-chip-${theme}.png`));
          assert.ok(report.screenshots.includes(`quoted-reply-${theme}.png`));
        }
        process.stdout.write(
          "PASS HQ707.native [HQ-707]: reply chip, dismissals, V2 reply target, quote jump, desktop light/dark.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-603", "HQ603.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq603-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq603.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ603_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ603.native", owner: "HQ-603", status: "pass" }
        );
        assert.deepEqual(report.assertions, [
          "next two Scheduled summary and bounded expansion with paused last",
          "failed and missed Needs you controls with Skip effect",
          "Job sidebar clock, context Pause and Run now, Conversation navigation",
          "exact Scheduled Job approval facts"
        ]);
        assert.equal(report.results.length, 3);
        for (const theme of ["light", "dark"]) {
          const result = report.results.find((entry) => entry.theme === theme);
          assert.ok(result);
          assert.match(result.collapsed, /^Next: .+ · .+ · \+4$/);
          assert.equal(result.trace.pauses, 1);
          assert.equal(result.trace.runNows, 1);
          assert.equal(result.trace.skips, 1);
          for (const view of [
            "collapsed",
            "expanded",
            "needs",
            "sidebar",
            "conversation"
          ])
            assert.ok(
              report.screenshots.includes(`scheduled-${view}-${theme}.png`)
            );
        }
        assert.ok(report.screenshots.includes("scheduled-review-light.png"));
        process.stdout.write(
          "PASS HQ603.native [HQ-603]: S12 Scheduled summary, expansion, Needs you, Job sidebar/actions and exact approval review, desktop light/dark; remaining S12.1 clauses run in the consolidated Now journey.\n"
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
          "PASS HQ407.native [HQ-407]: viewer-local deadlines in Now and Project, exact Team row focus, shared Due CAS and offline state; S21.1 document and audience clauses run in this journey; real counterparts run in HQ-713.\n"
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
          "PASS HQ406.native [HQ-406]: v50 document action, simple User prompt and separate selected Source in new/active private HQ; S06.1 text, offered and document receipt cycles run below.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-503", "native-report.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq503-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq503.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ503_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ503.native", owner: "HQ-503", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ503.native [HQ-503]: exact owned Helper mention, one child dispatch from cold/active private HQ, Working now and captured child navigation, owner-switch hiding.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-504", "report.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq504-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq504.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ504_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ504.native", owner: "HQ-504", status: "pass" }
        );
        assert.deepEqual(
          report.themes.map((entry) => entry.theme),
          ["light", "dark"]
        );
        for (const entry of report.themes) {
          assert.equal(entry.cards, 3);
          assert.equal(entry.declinedWithoutEffect, true);
          assert.equal(entry.nativeReviewVisible, true);
          assert.equal(entry.claimedRecoveryVisible, true);
        }
        assert.equal(report.coverage.compactApprovalCards, true);
        assert.equal(report.coverage.askFirstDeclineHasNoEffect, true);
        assert.equal(report.coverage.claimedReadOnlyRecoveryVisible, true);
        assert.equal(report.coverage.nativeDeleteReviewVisible, true);
        process.stdout.write(
          "PASS HQ504.native [HQ-504]: new HQ light/dark compact Ask First controls, decline without claim/effect, claimed read-only recovery, and exact Native delete review. Real mutation authority is proved by separate PostgreSQL tests; typed S18.3 runs below and N12.U is required by the parity gate.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-701", "HQ701.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq701-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq701.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ701_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ701.native", owner: "HQ-701", status: "pass" }
        );
        process.stdout.write(
          "PASS HQ701.native [HQ-701]: v50 Share sheet, pending recovery/cancel, exact active Project roster and Shared sidebar count; no live account or invitation.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-803", "browser-report.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq803-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq803.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ803_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          { id: report.id, owner: report.owner, status: report.status },
          { id: "HQ803.native", owner: "HQ-803", status: "pass" }
        );
        assert.deepEqual(report.assertions, [
          { id: "S22.1.study", owner: "HQ-803", status: "pass" },
          { id: "S22.1.text", owner: "HQ-802/HQ-803", status: "pass" }
        ]);
        assert.deepEqual(report.coverage, {
          chipOpensDeck: true,
          studyAndAllCards: true,
          flip: true,
          againStaysDue: true,
          goodAdvances: true,
          lightAndDark: true,
          generatedActionReceiptOpensExactDeck: true,
          deckYieldsPanelToSources: true
        });
        assert.ok(report.screenshots.includes("deck-to-sources-dark.png"));
        process.stdout.write(
          "PASS S22.1.study and S22.1.text [HQ-802/HQ-803]: new-HQ study and generated Chapter 7 action receipt to exact Deck in light/dark. Shared two-user S22.1/I26.1 is separately required by the HQ-713 parity gate.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-702", "HQ702.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq702-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq702.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ702_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          {
            id: report.id,
            owner: report.owner,
            status: report.status,
            scope: report.scope
          },
          {
            id: "HQ702.ui.native",
            owner: "HQ-702",
            status: "pass",
            scope: "renderer-fixture"
          }
        );
        assert.equal(report.nativeGrantAuthorityProved, false);
        assert.equal(report.nativeReviewInterceptionProved, true);
        assert.deepEqual(
          report.scenarioAssertions.filter((item) => item.id === "S15.2"),
          [
            {
              id: "S15.2",
              owner: "HQ-702",
              status: "pass",
              scope: "renderer-and-native-ui",
              exactSummaryQuestion: true,
              nativeApproveAndCancel: true,
              separateTranscriptAndCuratedDisclosure: true,
              conversationSourceAccessPublicationProved: false
            }
          ]
        );
        assert.ok(
          report.assertions.includes(
            "exact chat-summary question in isolated Native review, approve and cancel"
          )
        );
        assert.ok(
          report.assertions.includes(
            "full transcripts and Curated Memory require separate approval"
          )
        );
        assert.ok(
          report.assertions.includes(
            "private badge remains scoped to its chat while another chat menu opens"
          )
        );
        assert.ok(
          report.assertions.includes(
            "private-only Share again declined and confirmed through exact Project and chat selectors"
          )
        );
        assert.ok(
          report.assertions.includes(
            "completed moved-in chat offer declined, then manually retried from unshared and left pending"
          )
        );
        assert.deepEqual(report.screenshots, [
          "summary-off-light.png",
          "summary-on-light.png",
          "summary-revoked-light.png",
          "chat-summary-shared-light.png",
          "chat-summary-canceled-light.png",
          "chat-summary-private-light.png",
          "chat-private-other-menu-light.png",
          "chat-share-again-declined-light.png",
          "chat-share-again-confirmed-light.png",
          "chat-moved-in-declined-light.png",
          "chat-moved-in-pending-light.png",
          "summary-off-dark.png",
          "summary-on-dark.png",
          "summary-revoked-dark.png",
          "chat-summary-shared-dark.png",
          "chat-summary-canceled-dark.png",
          "chat-summary-private-dark.png",
          "chat-private-other-menu-dark.png",
          "chat-share-again-declined-dark.png",
          "chat-share-again-confirmed-dark.png",
          "chat-moved-in-declined-dark.png",
          "chat-moved-in-pending-dark.png",
          "native-review-light.png",
          "native-review-dark.png",
          "native-chat-summary-light.png",
          "native-chat-summary-dark.png"
        ]);
        process.stdout.write(
          "PASS S15.2 UI [HQ-702]: exact summary question, separate transcript/Curated disclosure, and Native approve/cancel in new HQ light/dark. Real no-CSA publication is proved separately in PostgreSQL; S15.1/S15.3 joined-state proof runs below and real effects run in HQ-713.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-703", "HQ703.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq703-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq703.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ703_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.deepEqual(
          {
            id: report.id,
            owner: report.owner,
            status: report.status,
            scope: report.scope
          },
          {
            id: "HQ703.ui.native",
            owner: "HQ-703",
            status: "pass",
            scope: "renderer-fixture"
          }
        );
        assert.deepEqual(
          report.scenarioAssertions.filter((item) =>
            ["S13.1", "S14.1"].includes(item.id)
          ),
          [
            { id: "S13.1", detail: "pre-join summary-sharing disclosure" },
            {
              id: "S14.1",
              detail: "addressed invite scope and Native decision controls"
            }
          ]
        );
        assert.deepEqual(
          report.scenarioAssertions.map((item) => item.id),
          [
            "S13.1",
            "S01.3.four-groups-project-chat",
            "S13.1.accepted-join",
            "S13.1.private-welcome",
            "S15.1.named-team-order",
            "S15.3.named-team-fold",
            "S16.1.loose-chat-cap",
            "S16.1.typed-roster-question",
            "S14.1"
          ]
        );
        assert.equal(report.nativeGrantAuthorityProved, false);
        assert.deepEqual(report.screenshots, [
          "invitation-light.png",
          "invitation-dark.png",
          "joined-hq-light.png",
          "joined-hq-dark.png"
        ]);
        process.stdout.write(
          "PASS S13.1/S14.1 UI [HQ-703]: recipient invitation, pre-join summary notice, and decision controls in new HQ light/dark. API authority and compound joined-state acceptance are proved separately.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }

  if (process.exitCode === undefined || process.exitCode === 0) {
    const reportPath = resolve(scratchDir, "hq-704", "HQ704.native.json");
    await rm(reportPath, { force: true });
    const profile = await mkdtemp(
      resolve(scratchDir, "hq704-electron-profile-")
    );
    try {
      const result = spawnSync(electronPath, ["scripts/validate-hq704.mjs"], {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ704_USER_DATA_DIR: profile },
        stdio: "inherit",
        timeout: 60_000
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      if (process.exitCode === 0) {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        assert.equal(report.id, "HQ704.ui.native");
        assert.equal(report.owner, "HQ-704");
        assert.equal(report.status, "pass");
        assert.equal(report.scope, "renderer-fixture");
        assert.equal(report.nativeGrantAuthorityProved, false);
        assert.equal(report.realCopyBackProved, false);
        assert.deepEqual(report.scenarioAssertions, [
          "S19.4.ui",
          "S20.2",
          "S20.3.ui",
          "S20.4",
          "N6.S.ui"
        ]);
        for (const value of Object.values(report.coverage))
          assert.equal(value, true);
        process.stdout.write(
          "PASS HQ704.ui.native [HQ-704]: owner text-leave refusal and separate delete, member Leave menu, group leave/no Undo, metadata-only restore disclosure in new HQ desktop light/dark. Real authority/copy-back are separate PostgreSQL proofs; compound two-user I20.3/N6.I/I25 remains HQ-713.\n"
        );
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
} finally {
  await rm(userDataPath, { recursive: true, force: true });
}

if (process.exitCode === undefined || process.exitCode === 0) {
  const origin = spawnSync(process.execPath, ["scripts/validate-hq721.mjs"], {
    cwd: desktopDir,
    env: process.env,
    stdio: "inherit"
  });
  if (origin.error) throw origin.error;
  process.exitCode = origin.status ?? 1;
}

if (process.exitCode === undefined || process.exitCode === 0) {
  const profile = await mkdtemp(resolve(scratchDir, "hq901-share-profile-"));
  try {
    const reportPath = resolve(scratchDir, "hq-901-early-share", "report.json");
    await rm(reportPath, { force: true });
    const result = spawnSync(
      electronPath,
      ["scripts/validate-hq901-early-share.mjs"],
      {
        cwd: desktopDir,
        env: { ...process.env, KOED_HQ901_EARLY_SHARE_USER_DATA_DIR: profile },
        stdio: "inherit"
      }
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    if (process.exitCode === 0) {
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      assert.equal(report.status, "pass");
      assert.deepEqual(report.proofIds, ["S14.1.share-sheet-contents"]);
      process.stdout.write(
        "PASS S14.1.share-sheet-contents: exact shared metadata, summaries and exclusions.\n"
      );
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

// Remaining HQ-901 journeys use production clients under isolated Native
// profiles. Their reports still have to satisfy every mapped clause below.
for (const [script, variable, prefix] of [
  [
    "validate-hq901-work-origin.mjs",
    "KOED_HQ901_WORK_ORIGIN_USER_DATA_DIR",
    "hq901-origin-profile-"
  ],
  [
    "validate-hq901-work-native.mjs",
    "KOED_HQ901_WORK_NATIVE_USER_DATA_DIR",
    "hq901-work-profile-"
  ],
  [
    "validate-hq901-work-typed-merge.mjs",
    "KOED_HQ901_WORK_TYPED_USER_DATA_DIR",
    "hq901-work-typed-merge-profile-"
  ],
  [
    "validate-hq901-work-typed-native.mjs",
    "KOED_HQ901_WORK_TYPED_NATIVE_USER_DATA_DIR",
    "hq901-work-typed-native-profile-"
  ],
  [
    "validate-hq901-work-ticketless.mjs",
    "KOED_HQ901_WORK_TICKETLESS_USER_DATA_DIR",
    "hq901-work-ticketless-profile-"
  ],
  [
    "validate-hq901-work-ticket-loop.mjs",
    "KOED_HQ901_WORK_TICKET_LOOP_USER_DATA_DIR",
    "hq901-work-ticket-loop-profile-"
  ],
  [
    "validate-hq901-work-closing-citation.mjs",
    "KOED_HQ901_WORK_CLOSING_USER_DATA_DIR",
    "hq901-work-closing-citation-profile-"
  ],
  [
    "validate-hq901-work-catchup.mjs",
    "KOED_HQ901_WORK_CATCHUP_USER_DATA_DIR",
    "hq901-work-catchup-profile-"
  ],
  [
    "validate-hq901-work-document-cycle.mjs",
    "KOED_HQ901_WORK_DOCUMENT_USER_DATA_DIR",
    "hq901-work-document-cycle-profile-"
  ],
  [
    "validate-hq901-work-todo-cycle.mjs",
    "KOED_HQ901_WORK_TODO_USER_DATA_DIR",
    "hq901-work-todo-cycle-profile-"
  ],
  [
    "validate-hq901-now.mjs",
    "KOED_HQ901_NOW_USER_DATA_DIR",
    "hq901-now-profile-"
  ],
  [
    "validate-hq901-invites.mjs",
    "KOED_HQ901_INVITES_USER_DATA_DIR",
    "hq901-invites-profile-"
  ],
  [
    "validate-hq901-forget.mjs",
    "KOED_HQ901_FORGET_USER_DATA_DIR",
    "hq901-forget-profile-"
  ],
  [
    "validate-hq901-prompt-native.mjs",
    "KOED_HQ901_PROMPT_USER_DATA_DIR",
    "hq901-prompts-profile-"
  ],
  [
    "validate-hq901-citation-lifecycle.mjs",
    "KOED_HQ901_CITATION_USER_DATA_DIR",
    "hq901-citation-profile-"
  ]
]) {
  if (process.exitCode !== undefined && process.exitCode !== 0) break;
  const profile = await mkdtemp(resolve(scratchDir, prefix));
  try {
    const result = spawnSync(electronPath, [`scripts/${script}`], {
      cwd: desktopDir,
      env: { ...process.env, [variable]: profile },
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

if (process.exitCode === undefined || process.exitCode === 0) {
  const result = spawnSync(
    process.execPath,
    ["scripts/validate-hq901-work-text-receipts.mjs"],
    {
      cwd: desktopDir,
      env: process.env,
      stdio: "inherit"
    }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.exitCode === undefined || process.exitCode === 0) {
  const result = spawnSync(process.execPath, ["scripts/validate-hq720.mjs"], {
    cwd: desktopDir,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.exitCode === undefined || process.exitCode === 0) {
  const report = compileBrowserParity(repoRoot, chainStartedAt);
  const path = resolve(scratchDir, "hq-901", "simulated-parity.json");
  await mkdir(dirname(path), { recursive: true });
  await (
    await import("node:fs/promises")
  ).writeFile(path, JSON.stringify(report, null, 2) + "\n");
  for (const item of report.results) {
    process.stdout.write(
      `${item.status === "pass" ? "PASS" : "FAIL"} ${item.id}: ${
        item.status === "pass"
          ? "all fresh simulated-IPC clauses passed"
          : item.missing.join("; ")
      }\n`
    );
  }
  process.stdout.write(
    `Simulated HQ parity: ${report.passed}/${report.total}. Real/unit prerequisites require test:hq-parity.\n`
  );
  if (!report.complete) process.exitCode = 1;
}
