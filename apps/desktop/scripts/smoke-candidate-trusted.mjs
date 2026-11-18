import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  launchPackagedDesktop,
  waitForPackagedDesktopExit
} from "./packaged-desktop-lifecycle.mjs";

const exec = promisify(execFile);
const runCli = async (executable, cli, env) => {
  const { stdout } = await exec(executable, [cli, "--version"], {
    env,
    timeout: 30_000,
    maxBuffer: 64 * 1024
  });
  return stdout;
};

export const smokeCandidate = async (
  { app, home, version },
  {
    runCli: cliRun = runCli,
    launch = launchPackagedDesktop,
    wait = waitForPackagedDesktopExit
  } = {}
) => {
  if (
    !isAbsolute(app) ||
    !isAbsolute(home) ||
    typeof version !== "string" ||
    !version
  )
    throw new Error("Invalid candidate smoke inputs");
  const executable = join(app, "Contents/MacOS/Koed");
  const cli = join(
    app,
    "Contents/Resources/app.asar/node_modules/@koed-labs/server/dist/cli.js"
  );
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    TMPDIR: home,
    KOED_HOME: join(home, "koed"),
    KOED_PRIVATE_SMOKE: "1"
  };
  if (
    (
      await cliRun(executable, cli, { ...env, ELECTRON_RUN_AS_NODE: "1" })
    ).trim() !== version
  )
    throw new Error("Packaged CLI version mismatch");
  const desktop = launch({
    executable,
    env,
    koedHome: env.KOED_HOME,
    timeoutMs: 180_000
  });
  try {
    await desktop.ready;
    if ((await desktop.invoke("quit"))?.ok !== true)
      throw new Error("Packaged Desktop quit failed");
    await wait(desktop.child, 30_000);
  } finally {
    if (desktop.child.exitCode == null && desktop.child.signalCode == null)
      desktop.child.kill("SIGKILL");
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  smokeCandidate({
    app: process.env.CANDIDATE_APP,
    home: process.env.CANDIDATE_HOME,
    version: process.env.CANDIDATE_VERSION
  }).catch(() => {
    process.stderr.write("Trusted candidate smoke failed\n");
    process.exitCode = 1;
  });
}
