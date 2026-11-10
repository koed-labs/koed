import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const app = resolve(process.argv[2] ?? "apps/desktop/release/mac/Koed.app");
const helperPath = join(app, "Contents/MacOS/Koed");
const { createDesktopCliInstallManager } = await import(
  pathToFileURL(
    join(
      app,
      "Contents/Resources/app.asar/dist-electron/cli-install/manager.js"
    )
  ).href
);
const cliPath = join(
  app,
  "Contents/Resources/app.asar/node_modules/@koed-labs/server/dist/desktop-cli-entrypoint.js"
);
mkdirSync(resolve("scratch"), { recursive: true });
const root = mkdtempSync(resolve("scratch", "packaged-cli-"));
const input = {
  appPath: app,
  helperPath,
  cliPath,
  koedHome: join(root, "bound home"),
  destination: join(root, "bin", "koed"),
  homePath: root,
  platform: "darwin",
  expectedVersion: "0.11.1",
  currentPath: "/nonexistent",
  probeHelper: async () => {
    const version = execFileSync(
      helperPath,
      ["-p", "process.versions.electron"],
      {
        env: { ELECTRON_RUN_AS_NODE: "1", PATH: "/nonexistent" },
        encoding: "utf8"
      }
    );
    return Boolean(version.trim());
  }
};
try {
  const manager = createDesktopCliInstallManager(input);
  let refused = false;
  try {
    await manager.launcher("install", { destination: input.destination });
  } catch {
    refused = true;
  }
  if (!refused || existsSync(input.destination))
    throw new Error("Install without consent was not refused");
  await manager.launcher("install", {
    destination: input.destination,
    consent: true
  });
  process.env.SHELL = "/bin/zsh";
  await manager.updatePath("add", true);
  await manager.updatePath("remove", true);
  if (readFileSync(join(root, ".zshrc"), "utf8").includes("koed managed PATH"))
    throw new Error("PATH cleanup failed");
  const env = {
    HOME: root,
    KOED_HOME: join(root, "wrong home"),
    PATH: "/nonexistent"
  };
  const help = execFileSync(input.destination, ["--help"], {
    env,
    encoding: "utf8"
  });
  if (!help.includes("Usage: koed")) throw new Error("Unexpected help output");
  const statusHelp = execFileSync(input.destination, ["status", "--help"], {
    env,
    encoding: "utf8"
  });
  if (!statusHelp.includes("status"))
    throw new Error("Unexpected status help output");
  try {
    execFileSync(input.destination, ["status", "--json"], {
      env,
      encoding: "utf8",
      stdio: "pipe"
    });
    throw new Error("Unconfigured status unexpectedly succeeded");
  } catch (error) {
    if (
      error.status !== 1 ||
      !String(error.stderr).includes("Core setup is required")
    )
      throw error;
  }
  const runtime = spawnSync(
    input.destination,
    ["runtime", "status", "--json"],
    { env, encoding: "utf8" }
  );
  const runtimeStatus = JSON.parse(runtime.stdout);
  if (runtime.error || runtimeStatus.koedHome !== input.koedHome)
    throw new Error("Launcher did not bind KOED_HOME");
  try {
    execFileSync(input.destination, ["status --help"], {
      env,
      encoding: "utf8",
      stdio: "pipe"
    });
    throw new Error("Unknown argument unexpectedly accepted");
  } catch (error) {
    if (error.status !== 2 || !String(error.stderr).includes("Unknown command"))
      throw error;
  }
  await manager.launcher("remove");

  // Exercise an actual moved packaged app, without touching the original bundle.
  const oldApp = join(root, "Old Koed.app");
  const newApp = join(root, "Moved Koed.app");
  cpSync(app, oldApp, { recursive: true, preserveTimestamps: true });
  const { readCliInstallSettings, writeCliInstallSettings } = await import(
    pathToFileURL(
      join(
        app,
        "Contents/Resources/app.asar/dist-electron/cli-install/settings.js"
      )
    ).href
  );
  const settingsFile = join(root, "launcher-settings.json");
  const relocatedDestination = join(root, "relocated-bin", "koed");
  const managerAt = (appPath, createManager) => {
    const helper = join(appPath, "Contents/MacOS/Koed");
    return createManager({
      ...input,
      appPath,
      helperPath: helper,
      cliPath: join(
        appPath,
        "Contents/Resources/app.asar/node_modules/@koed-labs/server/dist/desktop-cli-entrypoint.js"
      ),
      settings: readCliInstallSettings(settingsFile),
      saveSettings: (settings) =>
        writeCliInstallSettings(settingsFile, settings),
      probeHelper: async () =>
        Boolean(
          execFileSync(helper, ["-p", "process.versions.electron"], {
            env: { ELECTRON_RUN_AS_NODE: "1", PATH: "/nonexistent" },
            encoding: "utf8"
          }).trim()
        )
    });
  };
  await managerAt(oldApp, createDesktopCliInstallManager).launcher("install", {
    destination: relocatedDestination,
    consent: true
  });
  const prior = readFileSync(relocatedDestination, "utf8");
  renameSync(oldApp, newApp);
  const movedModule = await import(
    pathToFileURL(
      join(
        newApp,
        "Contents/Resources/app.asar/dist-electron/cli-install/manager.js"
      )
    ).href
  );
  const movedManager = managerAt(
    newApp,
    movedModule.createDesktopCliInstallManager
  );
  try {
    await movedManager.launcher("install", { consent: false });
    throw new Error(
      "Relocation recovery without consent unexpectedly succeeded"
    );
  } catch (error) {
    if (!String(error.message).includes("consent")) throw error;
  }
  if (readFileSync(relocatedDestination, "utf8") !== prior)
    throw new Error("Launcher changed without consent");
  await movedManager.launcher("install", { consent: true });
  if (
    !execFileSync(relocatedDestination, ["--help"], {
      env,
      encoding: "utf8"
    }).includes("Usage: koed")
  )
    throw new Error("Relocated packaged launcher failed");
  await movedManager.launcher("remove");
  console.log(
    "Moved packaged app: recorded exact launcher recovered with consent and executed without system Node."
  );
  console.log(
    "Packaged manager consent, PATH cleanup, launcher argument boundary, bound KOED_HOME, help, status, and no-system-Node PATH passed."
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
