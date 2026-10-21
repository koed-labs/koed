import assert from "node:assert/strict";
import test from "node:test";
import {
  assertForeignStartRejected,
  assertForeignStopRejected,
  runSharedLifecycleScenario
} from "./packaged-shared-lifecycle.mjs";

const fixture = () => {
  const calls = [];
  let pid;
  let desktopOpen = false;
  const alive = new Set();
  const driver = {
    async prepare() {
      calls.push("prepare-installed-launcher");
    },
    async startForeground() {
      assert.equal(desktopOpen, false);
      calls.push("foreground-closed");
      alive.add((pid = 101));
      return pid;
    },
    async stop() {
      calls.push(desktopOpen ? "stop-open" : "stop-closed");
      alive.delete(pid);
    },
    async waitForStopped(expectedPid) {
      assert.equal(alive.has(expectedPid), false);
    },
    async startDaemon() {
      assert.equal(desktopOpen, false);
      calls.push("daemon-closed");
      alive.add((pid = 202));
      return pid;
    },
    async restart() {
      assert.equal(desktopOpen, false);
      calls.push("restart-closed");
      alive.delete(pid);
      alive.add((pid = 303));
      return pid;
    },
    async verifyCli() {
      calls.push("diagnostics-and-integration");
      return { status: "healthy", doctor: "healthy" };
    },
    async openDesktop() {
      desktopOpen = true;
      calls.push("open-desktop");
      return pid;
    },
    async waitForStoppedView() {
      calls.push("observe-stopped-without-refresh");
      return { stopped: true, startEnabled: true };
    },
    async startFromUi() {
      calls.push("click-start-koed");
      alive.add((pid = 404));
      return pid;
    },
    async assertOnlySupervisor(expectedPid) {
      assert.deepEqual([...alive], [expectedPid]);
    },
    async cleanup() {
      calls.push("cleanup");
      alive.clear();
      desktopOpen = false;
    }
  };
  return { driver, calls, alive };
};

test("foreign CLI acceptance requires the expected owner-denial result", () => {
  assert.doesNotThrow(() =>
    assertForeignStartRejected({
      status: 1,
      stdout: "",
      stderr:
        "Packaged runtime owner does not match this standalone control plane."
    })
  );
  assert.throws(
    () =>
      assertForeignStartRejected({
        status: 1,
        stdout: "Cannot find module '@koed-labs/server'.",
        stderr: ""
      }),
    /unrelated reason/u
  );
  assert.throws(
    () => assertForeignStartRejected({ status: 0, stdout: "", stderr: "" }),
    /started/u
  );
});

test("foreign CLI stop acceptance requires the expected owner-denial result", () => {
  assert.doesNotThrow(() =>
    assertForeignStopRejected({
      status: 1,
      stdout: "",
      stderr:
        "Runtime owner and process identity could not be verified; refusing to stop"
    })
  );
  assert.throws(
    () =>
      assertForeignStopRejected({
        status: 1,
        stdout: "Cannot find module '@koed-labs/server'.",
        stderr: ""
      }),
    /unrelated reason/u
  );
  assert.throws(
    () => assertForeignStopRejected({ status: 0, stdout: "", stderr: "" }),
    /stopped/u
  );
});

test("a cleanup failure prevents a packaged acceptance success report", async () => {
  const { driver } = fixture();
  driver.cleanup = async () => ({
    ok: false,
    error: "cleanup stop failed; test home preserved"
  });

  await assert.rejects(
    runSharedLifecycleScenario(driver),
    /cleanup stop failed/u
  );
});

test("installed CLI works closed, Desktop adopts its PID, and external stop recovers through the UI", async () => {
  const { driver, calls, alive } = fixture();
  const report = await runSharedLifecycleScenario(driver);
  assert.deepEqual(report.pids, {
    foreground: 101,
    daemon: 202,
    restart: 303,
    reconnected: 303,
    recovered: 404
  });
  assert.equal(report.ok, true);
  assert.deepEqual(calls, [
    "prepare-installed-launcher",
    "foreground-closed",
    "stop-closed",
    "daemon-closed",
    "restart-closed",
    "diagnostics-and-integration",
    "open-desktop",
    "stop-open",
    "observe-stopped-without-refresh",
    "click-start-koed",
    "cleanup"
  ]);
  assert.equal(alive.size, 0);
});
