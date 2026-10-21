/* global console, process, setTimeout */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { launchPackagedDesktop } from "./packaged-desktop-lifecycle.mjs";

const optional = async (driver, name, ...args) =>
  typeof driver[name] === "function" ? driver[name](...args) : undefined;

// The sequence is the contract; the driver supplies the real installed
// launcher and packaged Desktop (or a fake in unit tests).
export async function runSharedLifecycleScenario(driver) {
  const pids = {};
  let scenarioFailed = false;
  let scenarioError;
  try {
    await driver.prepare();
    pids.foreground = await driver.startForeground();
    await driver.stop();
    await driver.waitForStopped(pids.foreground);

    pids.daemon = await driver.startDaemon();
    await optional(driver, "startConcurrently", pids.daemon);
    await driver.assertOnlySupervisor(pids.daemon);
    pids.restart = await driver.restart();
    await driver.assertOnlySupervisor(pids.restart);
    await driver.verifyCli();
    await optional(driver, "verifyForeignRejected");

    pids.reconnected = await driver.openDesktop();
    if (pids.reconnected !== pids.restart)
      throw new Error(
        `Desktop reconnected to PID ${pids.reconnected}, not the CLI-started ${pids.restart}.`
      );
    await driver.assertOnlySupervisor(pids.restart);

    await driver.stop();
    await driver.waitForStopped(pids.restart);
    const view = await driver.waitForStoppedView();
    if (!view?.stopped || !view.startEnabled)
      throw new Error("Desktop did not present explicit Stopped with Start.");
    await optional(driver, "assertStaysStopped");

    pids.recovered = await driver.startFromUi();
    await driver.assertOnlySupervisor(pids.recovered);
  } catch (error) {
    scenarioFailed = true;
    scenarioError = error;
  }

  let cleanup;
  try {
    cleanup = await driver.cleanup();
  } catch (error) {
    if (scenarioFailed) {
      console.error(error);
      throw scenarioError;
    }
    throw error;
  }
  if (scenarioFailed) {
    if (cleanup?.ok === false) console.error(cleanup.error);
    throw scenarioError;
  }
  if (cleanup?.ok === false) throw new Error(cleanup.error);
  return { ok: true, pids };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const poll = async (
  what,
  probe,
  { timeoutMs = 60_000, intervalMs = 500 } = {}
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);
    await sleep(intervalMs);
  }
};
const foreignOwnerDenial =
  /(?:Packaged runtime owner does not match this standalone control plane|Runtime owner and process identity could not be verified|runtime owner mismatch)/iu;

export function assertForeignStartRejected(result) {
  if (result.error || result.status === null)
    throw new Error(
      `Standalone CLI did not complete: ${result.error?.message ?? result.signal ?? "no exit status"}`
    );
  if (result.status === 0)
    throw new Error(
      "A standalone installation started the Desktop-owned runtime."
    );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!foreignOwnerDenial.test(output))
    throw new Error(
      `Standalone start failed for an unrelated reason:\n${output}`
    );
}

export function assertForeignStopRejected(result) {
  if (result.error || result.status === null)
    throw new Error(
      `Standalone CLI did not complete: ${result.error?.message ?? result.signal ?? "no exit status"}`
    );
  if (result.status === 0)
    throw new Error(
      "A standalone installation stopped the Desktop-owned runtime."
    );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!foreignOwnerDenial.test(output))
    throw new Error(
      `Standalone stop failed for an unrelated reason:\n${output}`
    );
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Drives the real GUI-installed launcher from an unrelated working directory.
// The launcher alone binds KOED_HOME: no KOED_* variable is passed through.
export function createInstalledLauncherDriver({
  launcher,
  appExecutable,
  koedHome,
  standaloneKoed
}) {
  const workdir = mkdtempSync(join(tmpdir(), "koed shared lifecycle "));
  const cleanEnv = { PATH: "/usr/bin:/bin", HOME: process.env.HOME };
  let desktop = null;
  const run = (args, { command = launcher, env = cleanEnv } = {}) =>
    spawnSync(command, args, {
      cwd: workdir,
      env,
      encoding: "utf8",
      timeout: 180_000
    });
  const json = (args, options) => {
    const result = run(args, options);
    let value = null;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      /* non-JSON output is reported through the exit status */
    }
    return { ...result, value };
  };
  const lifecycle = () => json(["status", "--json"]).value?.lifecycle;
  // "running" only means the supervisor recorded its runtime; also require
  // the API and database to be ready before treating the start as complete.
  const runningPid = async (previous) =>
    poll(
      "a running supervisor",
      () => {
        const state = lifecycle();
        if (state?.state !== "running" || !state.pid || state.pid === previous)
          return null;
        return json(["status", "--startup", "--json"]).value?.ok === true
          ? state.pid
          : null;
      },
      { timeoutMs: 240_000, intervalMs: 1_000 }
    );
  const supervisors = () =>
    spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter(
        (line) =>
          line.includes(
            appExecutable.replace(/\/Contents\/MacOS\/Koed$/u, "")
          ) &&
          (line.includes("desktop-supervisor-entrypoint.js") ||
            /desktop-cli-entrypoint\.js start( --daemon)?$/u.test(line.trim()))
      )
      .map((line) => Number(line.trim().split(/\s+/u)[0]));
  const foreignCommand = (args) =>
    spawnSync(standaloneKoed, args, {
      cwd: workdir,
      env: {
        ...cleanEnv,
        PATH: `${dirname(process.execPath)}:${cleanEnv.PATH}`,
        KOED_HOME: koedHome,
        KOED_DEPENDENCY_MODE: "bundled-local"
      },
      encoding: "utf8",
      timeout: 60_000
    });
  const foreignStart = () => foreignCommand(["start"]);
  const foreignStop = () => foreignCommand(["stop", "--json"]);
  const stopCli = () => {
    const result = run(["stop", "--json"]);
    if (result.status !== 0)
      throw new Error(
        `koed stop failed (${result.status}): ${result.error?.message ?? `${result.stdout}${result.stderr}`}`
      );
  };
  return {
    async prepare() {
      const help = run(["--help"]);
      if (help.status !== 0)
        throw new Error("Installed launcher is not usable.");
    },
    async startForeground() {
      // Backgrounded by a shell so this process never owns (and, while blocked
      // in a synchronous stop, never leaves unreaped) the supervisor.
      spawnSync(
        "/bin/sh",
        ["-c", '"$0" start </dev/null >/dev/null 2>&1 &', launcher],
        { cwd: workdir, env: cleanEnv }
      );
      return runningPid();
    },
    stop: async () => stopCli(),
    async waitForStopped(pid) {
      await poll(
        `PID ${pid} to exit`,
        () => !alive(pid) && lifecycle()?.state === "stopped",
        {
          timeoutMs: 60_000
        }
      );
    },
    async startDaemon() {
      const started = json(["start", "--daemon", "--json"]);
      if (started.status !== 0 || !started.value?.ok)
        throw new Error(
          `start --daemon failed:\n${started.stdout}${started.stderr}`
        );
      const pid = await runningPid();
      await sleep(2_000);
      if (!alive(pid))
        throw new Error("Daemon did not survive its launcher exiting.");
      return pid;
    },
    async startConcurrently(expectedPid) {
      await Promise.all(
        [0, 1, 2].map(
          () =>
            new Promise((done) =>
              spawn(launcher, ["start", "--daemon", "--json"], {
                cwd: workdir,
                env: cleanEnv,
                stdio: "ignore"
              }).once("exit", done)
            )
        )
      );
      await sleep(3_000);
      if (lifecycle()?.pid !== expectedPid)
        throw new Error(
          "Concurrent starts replaced or duplicated the supervisor."
        );
    },
    async restart() {
      const previous = lifecycle()?.pid;
      const result = json(["restart", "--json"]);
      if (result.status !== 0)
        throw new Error(`restart failed:\n${result.stdout}${result.stderr}`);
      return runningPid(previous);
    },
    async verifyCli() {
      const status = json(["status", "--json"]);
      if (status.status !== 0 || status.value?.lifecycle?.state !== "running")
        throw new Error(
          `status did not see the running instance:\n${status.stdout}${status.stderr}`
        );
      const doctor = json(["doctor", "--json"]);
      const text = `${doctor.stdout}${doctor.stderr}`;
      if (
        !doctor.value ||
        /generation\.json|runtime owner mismatch|Desktop-managed/iu.test(text)
      )
        throw new Error(`doctor used the wrong runtime authority:\n${text}`);
    },
    // An independent npm installation must not manage this instance.
    async verifyForeignRejected() {
      if (!standaloneKoed) return;
      const before = lifecycle()?.pid;
      assertForeignStartRejected(foreignStart());
      assertForeignStopRejected(foreignStop());
      if (lifecycle()?.pid !== before)
        throw new Error(
          "A standalone installation replaced the Desktop instance."
        );
    },
    async openDesktop() {
      desktop = launchPackagedDesktop({
        executable: appExecutable,
        env: { PATH: cleanEnv.PATH, HOME: cleanEnv.HOME, KOED_HOME: koedHome },
        koedHome
      });
      await desktop.ready;
      const adopted = await desktop.invoke("start_daemon");
      if (!adopted?.adoptedPid)
        throw new Error("Desktop did not adopt the running supervisor.");
      return (await desktop.invoke("lifecycle")).pid;
    },
    async waitForStoppedView() {
      // Bounded and passive: observe the observer that drives UI and tray.
      const view = await poll(
        "Desktop to observe the external stop",
        async () => {
          const state = await desktop.invoke("lifecycle");
          return state.state === "stopped" ? state : null;
        },
        { timeoutMs: 15_000, intervalMs: 500 }
      );
      const status = await desktop.invoke("status");
      return {
        stopped:
          view.state === "stopped" && status.lifecycle?.state === "stopped",
        startEnabled: status.api?.state !== "healthy"
      };
    },
    async assertStaysStopped() {
      if (standaloneKoed) assertForeignStartRejected(foreignStart());
      for (let index = 0; index < 20; index += 1) {
        await sleep(500);
        // Short-lived management sessions are legitimate; a supervisor lock is not.
        const state = lifecycle();
        if (state?.state !== "stopped")
          throw new Error(
            `Koed restarted after an explicit external stop: ${JSON.stringify(state)}`
          );
      }
    },
    async startFromUi() {
      const result = await desktop.invoke("start");
      if (result?.ok === false)
        throw new Error(`Desktop Start failed: ${JSON.stringify(result)}`);
      return (await desktop.invoke("lifecycle")).pid;
    },
    async assertOnlySupervisor(expectedPid) {
      await poll(
        "exactly one supervisor",
        () => {
          const found = [...new Set(supervisors())];
          return found.length === 1 && found[0] === expectedPid;
        },
        { timeoutMs: 15_000, intervalMs: 500 }
      );
    },
    async cleanup() {
      // Best effort: never mask the scenario failure that led here.
      try {
        if (desktop) await desktop.invoke("quit").catch(() => undefined);
      } catch {
        /* Desktop already exited */
      }
      try {
        stopCli();
      } catch (error) {
        return {
          ok: false,
          error: `cleanup failed; preserved ${workdir}: ${error.message}`
        };
      }
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch (error) {
        return {
          ok: false,
          error: `cleanup failed for ${workdir}: ${error.message}`
        };
      }
      return { ok: true };
    }
  };
}

const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const launcher = flag("--launcher");
  const app = flag("--app");
  const koedHome = flag("--home");
  if (!launcher || !app || !koedHome) {
    console.error(
      "Usage: node packaged-shared-lifecycle.mjs --launcher <installed koed> --app <Koed.app> --home <Desktop KOED_HOME> [--standalone-koed <path>]"
    );
    process.exit(2);
  }
  const report = await runSharedLifecycleScenario(
    createInstalledLauncherDriver({
      launcher: resolve(launcher),
      appExecutable: resolve(app, "Contents/MacOS/Koed"),
      koedHome: resolve(koedHome),
      standaloneKoed: flag("--standalone-koed")
    })
  );
  console.log(JSON.stringify(report, null, 2));
}
